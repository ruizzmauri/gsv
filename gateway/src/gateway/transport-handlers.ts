import { env } from "cloudflare:workers";
import type { EventFrame, RequestFrame } from "../protocol/frames";
import type { Gateway } from "./do";
import type { ChannelId } from "../protocol/channel";
import type {
  ConnectParams,
  ToolInvokePayload,
  ToolResultParams,
} from "../types";
import { RpcError, timingSafeEqualStr } from "../shared/utils";

export const DEFER_RESPONSE = Symbol("defer-response");
export type DeferredResponse = typeof DEFER_RESPONSE;

const handleConnect = (ctx: TransportHandlerContext): unknown => {
  const { ws, frame, gateway: gw } = ctx;
  const params = frame.params as ConnectParams;
  if (params?.minProtocol !== 1) {
    throw new RpcError(102, "Unsupported protocol version");
  }

  // Check auth token if configured
  const authToken = gw.getConfigPath("auth.token") as string | undefined;

  if (authToken) {
    const providedToken = params?.auth?.token;
    if (!providedToken || !timingSafeEqualStr(providedToken, authToken)) {
      ws.close(4001, "Unauthorized");
      throw new RpcError(401, "Unauthorized: invalid or missing token");
    }
  }

  const mode = params?.client?.mode;
  if (!mode || !["client", "node", "channel"].includes(mode)) {
    throw new RpcError(103, "Invalid client mode");
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
      throw new RpcError(103, "Channel mode requires channel field");
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
  const payload = {
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
  };

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
        console.error(
          `[Gateway] Failed to auto-initialize heartbeat scheduler:`,
          e,
        );
      });
  }

  return payload;
};

const handleToolInvoke = (ctx: TransportHandlerContext): DeferredResponse => {
  const { ws, frame, gateway: gw } = ctx;
  const params = frame.params as {
    tool: string;
    args?: Record<string, unknown>;
  };
  if (!params?.tool) {
    throw new RpcError(400, "tool required");
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    throw new RpcError(404, `No node provides tool: ${params.tool}`);
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    throw new RpcError(503, "Node not connected");
  }

  const attachment = ws.deserializeAttachment();
  const clientId = attachment.clientId as string | undefined;
  if (!clientId) {
    throw new RpcError(101, "Not connected");
  }

  const callId = crypto.randomUUID();
  gw.pendingToolCalls[callId] = {
    kind: "client",
    clientId,
    frameId: frame.id,
    createdAt: Date.now(),
  };

  // Send the original (un-namespaced) tool name to the node
  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: { callId, tool: resolved.toolName, args: params.args ?? {} },
  };
  nodeWs.send(JSON.stringify(evt));

  // Response is deferred until corresponding tool.result arrives.
  return DEFER_RESPONSE;
};

const handleToolResult = async (
  ctx: TransportHandlerContext,
): Promise<unknown> => {
  const { frame, gateway: gw } = ctx;
  const params = frame.params as ToolResultParams;
  if (!params?.callId) {
    throw new RpcError(400, "callId required");
  }

  const route = gw.pendingToolCalls[params.callId];
  if (!route) {
    throw new RpcError(404, "Unknown callId");
  }

  delete gw.pendingToolCalls[params.callId];

  if (route.kind === "client") {
    const clientWs = gw.clients.get(route.clientId);
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
      console.log(
        `[Gateway] Dropping tool.result for disconnected client ${route.clientId} (callId=${params.callId})`,
      );
      return { ok: true, dropped: true };
    }

    if (params.error) {
      gw.sendError(clientWs, route.frameId, 500, params.error);
    } else {
      gw.sendOk(clientWs, route.frameId, {
        result: params.result,
      });
    }
    return { ok: true };
  }

  const sessionKey = route.sessionKey;
  const sessionStub = env.SESSION.getByName(sessionKey);
  await sessionStub.toolResult({
    callId: params.callId,
    result: params.result,
    error: params.error,
  });

  return { ok: true };
};

export type TransportMethod = "connect" | "tool.invoke" | "tool.result";
export type TransportHandlerContext = {
  ws: WebSocket;
  frame: RequestFrame;
  gateway: Gateway;
};
export type TransportHandler = (
  ctx: TransportHandlerContext,
) => Promise<unknown | DeferredResponse> | unknown | DeferredResponse;

export function buildTransportHandlers(): Record<
  TransportMethod,
  TransportHandler
> {
  return {
    connect: (ctx) => handleConnect(ctx),
    "tool.invoke": (ctx) => handleToolInvoke(ctx),
    "tool.result": (ctx) => handleToolResult(ctx),
  };
}
