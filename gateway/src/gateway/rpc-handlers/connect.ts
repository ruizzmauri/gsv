import { RpcError, timingSafeEqualStr } from "../../shared/utils";
import type { ConnectResult, Handler } from "../../protocol/methods";

export const handleConnect: Handler<"connect"> = (ctx) => {
  const { ws, gw, params } = ctx;
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
      channel,
      accountId,
      connectedAt: Date.now(),
    };
    console.log(`[Gateway] Channel connected: ${channelKey}`);
  }

  ws.serializeAttachment(attachments);
  const payload: ConnectResult = {
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
