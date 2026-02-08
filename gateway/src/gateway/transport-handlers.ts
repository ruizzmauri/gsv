import { env } from "cloudflare:workers";
import type { EventFrame, RequestFrame } from "../protocol/frames";
import type { Gateway } from "../gateway";
import type { ChannelId } from "../protocol/channel";
import type {
  ConnectParams,
  ToolInvokePayload,
  ToolResultParams,
} from "../types";
import { timingSafeEqualStr } from "../shared/utils";

const handleConnect = (ctx: TransportHandlerContext, gw: Gateway): void => {
  const { ws, frame } = ctx;
  const params = frame.params as ConnectParams;
  if (params?.minProtocol !== 1) {
    gw.sendError(ws, frame.id, 102, "Unsupported protocol version");
    return;
  }

  // Check auth token if configured
  const authToken = gw.getConfigPath("auth.token") as string | undefined;

  if (authToken) {
    const providedToken = params?.auth?.token;
    if (!providedToken || !timingSafeEqualStr(providedToken, authToken)) {
      gw.sendError(
        ws,
        frame.id,
        401,
        "Unauthorized: invalid or missing token",
      );
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  const mode = params?.client?.mode;
  if (!mode || !["client", "node", "channel"].includes(mode)) {
    gw.sendError(ws, frame.id, 103, "Invalid client mode");
    return;
  }

  let attachments = ws.deserializeAttachment();
  attachments = { ...attachments, connected: true, mode };

  if (mode === "client") {
    attachments.clientId = params.client.id;
    gw.clients.set(params.client.id, ws);
    console.log(`[Gateway] Client connected: ${params.client.id}`);
  } else if (mode === "node") {
    const nodeId = params.client.id;
    attachments.nodeId = nodeId;
    gw.nodes.set(nodeId, ws);
    // Store tools with their original names (namespacing happens in getAllTools)
    gw.toolRegistry[nodeId] = params.tools ?? [];
    console.log(
      `[Gateway] Node connected: ${nodeId}, tools: [${(params.tools ?? []).map((t) => `${nodeId}__${t.name}`).join(", ")}]`,
    );
  } else if (mode === "channel") {
    const channel = params.client.channel;
    const accountId = params.client.accountId ?? params.client.id;
    if (!channel) {
      gw.sendError(ws, frame.id, 103, "Channel mode requires channel field");
      return;
    }
    const channelKey = `${channel}:${accountId}`;
    attachments.channelKey = channelKey;
    attachments.channel = channel;
    attachments.accountId = accountId;
    gw.channels.set(channelKey, ws);
    // Update channel registry
    gw.channelRegistry[channelKey] = {
      channel: channel as ChannelId,
      accountId,
      connectedAt: Date.now(),
    };
    console.log(`[Gateway] Channel connected: ${channelKey}`);
  }

  ws.serializeAttachment(attachments);
  gw.sendOk(ws, frame.id, {
    type: "hello-ok",
    protocol: 1,
    server: { version: "0.0.1", connectionId: attachments.id },
    features: {
      methods: [
        "tools.list",
        "chat.send",
        "tool.request",
        "tool.result",
        "channel.inbound",
        "channel.start",
        "channel.stop",
        "channel.status",
        "channel.login",
        "channel.logout",
        "channels.list",
      ],
      events: ["chat", "tool.invoke", "tool.result", "channel.outbound"],
    },
  });

  // Auto-start heartbeat scheduler on first connection (if not already initialized)
  if (!gw.heartbeatScheduler.initialized) {
    gw.scheduleHeartbeat()
      .then(() => {
        gw.heartbeatScheduler.initialized = true;
        console.log(
          `[Gateway] Heartbeat scheduler auto-initialized on first connection`,
        );
      })
      .catch((e) => {
        console.error(`[Gateway] Failed to auto-initialize heartbeat scheduler:`, e);
      });
  }
};

const handleToolInvoke = (ctx: TransportHandlerContext, gw: Gateway): void => {
  const { ws, frame } = ctx;
  const params = frame.params as {
    tool: string;
    args?: Record<string, unknown>;
  };
  if (!params?.tool) {
    gw.sendError(ws, frame.id, 400, "tool required");
    return;
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    gw.sendError(ws, frame.id, 404, `No node provides tool: ${params.tool}`);
    return;
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    gw.sendError(ws, frame.id, 503, "Node not connected");
    return;
  }

  const callId = crypto.randomUUID();
  gw.pendingClientCalls.set(callId, { ws, frameId: frame.id });

  // Send the original (un-namespaced) tool name to the node
  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: { callId, tool: resolved.toolName, args: params.args ?? {} },
  };
  nodeWs.send(JSON.stringify(evt));
};

const handleToolResult = async (
  ctx: TransportHandlerContext,
  gw: Gateway,
): Promise<void> => {
  const { ws, frame } = ctx;
  const params = frame.params as ToolResultParams;
  if (!params?.callId) {
    gw.sendError(ws, frame.id, 400, "callId required");
    return;
  }

  const clientCall = gw.pendingClientCalls.get(params.callId);
  if (clientCall) {
    gw.pendingClientCalls.delete(params.callId);
    if (params.error) {
      gw.sendError(clientCall.ws, clientCall.frameId, 500, params.error);
    } else {
      gw.sendOk(clientCall.ws, clientCall.frameId, {
        result: params.result,
      });
    }
    gw.sendOk(ws, frame.id, { ok: true });
    return;
  }

  const sessionKey = gw.pendingToolCalls[params.callId];
  if (!sessionKey) {
    gw.sendError(ws, frame.id, 404, "Unknown callId");
    return;
  }

  delete gw.pendingToolCalls[params.callId];

  const sessionStub = env.SESSION.getByName(sessionKey);
  await sessionStub.toolResult({
    callId: params.callId,
    result: params.result,
    error: params.error,
  });

  gw.sendOk(ws, frame.id, { ok: true });
};

export type TransportMethod = "connect" | "tool.invoke" | "tool.result";
export type TransportHandlerContext = { ws: WebSocket; frame: RequestFrame };
export type TransportHandler = (
  ctx: TransportHandlerContext,
) => Promise<void> | void;

export function buildTransportHandlers(
  gw: Gateway,
): Record<TransportMethod, TransportHandler> {
  return {
    connect: (ctx) => handleConnect(ctx, gw),
    "tool.invoke": (ctx) => handleToolInvoke(ctx, gw),
    "tool.result": (ctx) => handleToolResult(ctx, gw),
  };
}
