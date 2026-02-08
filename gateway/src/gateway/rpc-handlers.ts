import { env } from "cloudflare:workers";
import { parseCommand } from "../commands";
import { normalizeE164 } from "../config";
import {
  formatDirectiveAck,
  isDirectiveOnly,
  parseDirectives,
} from "../directives";
import type { Gateway } from "../gateway";
import type { ChannelId } from "../protocol/channel";
import { RpcMethod, Handler } from "../protocol/methods";
import { RpcError } from "../shared/utils";
import { EventFrame } from "../protocol/frames";
import { ToolInvokePayload } from "../types";

const handleToolsList: Handler<"tools.list"> = (gw) => ({
  tools: gw.getAllTools(),
});

const handleSessionPatch: Handler<"session.patch"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.patch({
    settings: params.settings,
    label: params.label,
    resetPolicy: params.resetPolicy as any,
  });
};

const handleSessionGet: Handler<"session.get"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.get();
};

const handleSessionCompact: Handler<"session.compact"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.compact(params.keepMessages);
};

const handleSessionStats: Handler<"session.stats"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.stats();
};

const handleSessionReset: Handler<"session.reset"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.reset();
};

const handleSessionHistory: Handler<"session.history"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.history();
};

const handleSessionPreview: Handler<"session.preview"> = async (_, params) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.preview(params.limit);
};

const handleSessionsList: Handler<"sessions.list"> = (gw, params) => {
  const limit = params?.limit ?? 100;
  const offset = params?.offset ?? 0;

  const allSessions = Object.values(gw.sessionRegistry).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );

  const sessions = allSessions.slice(offset, offset + limit);

  return {
    sessions,
    count: allSessions.length,
  };
};

const handleChannelsList: Handler<"channels.list"> = (gw) => {
  const channels = Object.values(gw.channelRegistry);

  return {
    channels,
    count: channels.length,
  };
};

const handleChannelInbound: Handler<"channel.inbound"> = async (gw, params) => {
  const result = await gw.handleChannelInboundRpc(params);
  if (!result.ok) {
    const code = result.error?.includes("required") ? 400 : 500;
    throw new RpcError(code, result.error ?? "Failed to handle channel inbound");
  }

  const { ok: _ok, error: _error, ...payload } = result;
  return {
    ...payload,
    status: payload.status ?? "started",
  };
};

const handleChannelStart: Handler<"channel.start"> = async (gw, params) => {
  if (!params?.channel) {
    throw new RpcError(400, "channel required");
  }

  const channel = params.channel as ChannelId;
  const accountId = params.accountId ?? "default";
  const config = params.config ?? {};

  const binding = gw.getChannelBinding(channel);
  if (!binding) {
    throw new RpcError(404, `Unknown channel: ${channel}`);
  }

  let result;
  try {
    result = await binding.start(accountId, config);
  } catch (error) {
    throw new RpcError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!result.ok) {
    throw new RpcError(500, result.error);
  }

  const channelKey = `${channel}:${accountId}`;
  gw.channelRegistry[channelKey] = {
    channel,
    accountId,
    connectedAt: Date.now(),
  };

  return { ok: true, channel, accountId };
};

const handleChannelStop: Handler<"channel.stop"> = async (gw, params) => {
  if (!params?.channel) {
    throw new RpcError(400, "channel required");
  }

  const channel = params.channel as ChannelId;
  const accountId = params.accountId ?? "default";

  const binding = gw.getChannelBinding(channel);
  if (!binding) {
    throw new RpcError(404, `Unknown channel: ${channel}`);
  }

  let result;
  try {
    result = await binding.stop(accountId);
  } catch (error) {
    throw new RpcError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!result.ok) {
    throw new RpcError(500, result.error);
  }

  const channelKey = `${channel}:${accountId}`;
  delete gw.channelRegistry[channelKey];

  return { ok: true, channel, accountId };
};

const handleChannelStatus: Handler<"channel.status"> = async (gw, params) => {
  if (!params?.channel) {
    throw new RpcError(400, "channel required");
  }

  const channel = params.channel as ChannelId;
  const accountId = params.accountId;

  const binding = gw.getChannelBinding(channel);
  if (!binding) {
    throw new RpcError(404, `Unknown channel: ${channel}`);
  }

  try {
    const accounts = await binding.status(accountId);
    return { channel, accounts };
  } catch (error) {
    throw new RpcError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const handleChannelLogin: Handler<"channel.login"> = async (gw, params) => {
  if (!params?.channel) {
    throw new RpcError(400, "channel required");
  }

  const channel = params.channel as ChannelId;
  const accountId = params.accountId ?? "default";

  const binding = gw.getChannelBinding(channel);
  if (!binding) {
    throw new RpcError(404, `Unknown channel: ${channel}`);
  }

  if (!binding.login) {
    throw new RpcError(400, `Channel ${channel} does not support login flow`);
  }

  let result;
  try {
    result = await binding.login(accountId, { force: params.force });
  } catch (error) {
    throw new RpcError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!result.ok) {
    throw new RpcError(500, result.error);
  }

  return {
    ok: true,
    channel,
    accountId,
    qrDataUrl: result.qrDataUrl,
    message: result.message,
  };
};

const handleChannelLogout: Handler<"channel.logout"> = async (gw, params) => {
  if (!params?.channel) {
    throw new RpcError(400, "channel required");
  }

  const channel = params.channel as ChannelId;
  const accountId = params.accountId ?? "default";

  const binding = gw.getChannelBinding(channel);
  if (!binding) {
    throw new RpcError(404, `Unknown channel: ${channel}`);
  }

  if (!binding.logout) {
    throw new RpcError(400, `Channel ${channel} does not support logout`);
  }

  let result;
  try {
    result = await binding.logout(accountId);
  } catch (error) {
    throw new RpcError(
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!result.ok) {
    throw new RpcError(500, result.error);
  }

  const channelKey = `${channel}:${accountId}`;
  delete gw.channelRegistry[channelKey];

  return { ok: true, channel, accountId };
};

const handleToolRequest: Handler<"tool.request"> = (gw, params) => {
  if (!params?.callId || !params?.tool || !params?.sessionKey) {
    throw new RpcError(400, "callId, tool, and sessionKey required");
  }

  const resolved = gw.findNodeForTool(params.tool);
  if (!resolved) {
    throw new RpcError(404, `No node provides tool: ${params.tool}`);
  }

  const nodeWs = gw.nodes.get(resolved.nodeId);
  if (!nodeWs) {
    throw new RpcError(503, "Node not connected");
  }

  gw.pendingToolCalls[params.callId] = params.sessionKey;

  // Send the original (un-namespaced) tool name to the node
  const evt: EventFrame<ToolInvokePayload> = {
    type: "evt",
    event: "tool.invoke",
    payload: {
      callId: params.callId,
      tool: resolved.toolName,
      args: params.args ?? {},
    },
  };
  nodeWs.send(JSON.stringify(evt));

  return { status: "sent" };
};

const handleConfigGet: Handler<"config.get"> = (gw, params) => {
  if (params?.path) {
    // Get specific path
    const value = gw.getConfigPath(params.path);
    return { path: params.path, value };
  } else {
    // Get full config masking API keys and tokens
    const safeConfig = gw.getSafeConfig();
    return { config: safeConfig };
  }
};

const handleConfigSet: Handler<"config.set"> = (gw, params) => {
  if (!params?.path) {
    throw new RpcError(400, "path required");
  }

  gw.setConfigPath(params.path, params.value);
  return { ok: true, path: params.path };
};

const handleHeartbeatTrigger: Handler<"heartbeat.trigger"> = async (
  gw,
  params,
) => {
  const agentId = params?.agentId ?? "main";
  return await gw.triggerHeartbeat(agentId);
};

const handleHeartbeatStatus: Handler<"heartbeat.status"> = async (gw) => {
  const status = await gw.getHeartbeatStatus();
  return { agents: status };
};

const handleHeartbeatStart: Handler<"heartbeat.start"> = async (gw) => {
  await gw.scheduleHeartbeat();
  const status = await gw.getHeartbeatStatus();
  return {
    message: "Heartbeat scheduler started",
    agents: status,
  };
};

const handlePairList: Handler<"pair.list"> = (gw) => ({
  pairs: { ...gw.pendingPairs },
});

const handlePairApprove: Handler<"pair.approve"> = (gw, params) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedId = normalizeE164(params.senderId);
  const pairKey = `${params.channel}:${normalizedId}`;

  const pending = gw.pendingPairs[pairKey];
  if (!pending) {
    throw new RpcError(404, `No pending pairing for ${pairKey}`);
  }

  // Add to allowFrom
  const config = gw.getFullConfig();
  const channelConfig = config.channels[params.channel];
  const currentAllowFrom = channelConfig?.allowFrom ?? [];

  if (!currentAllowFrom.includes(normalizedId)) {
    const newAllowFrom = [...currentAllowFrom, normalizedId];
    gw.setConfigPath(`channels.${params.channel}.allowFrom`, newAllowFrom);
  }

  // Remove from pending
  delete gw.pendingPairs[pairKey];

  console.log(`[Gateway] Approved pairing for ${normalizedId}`);

  // Send confirmation message back to the channel
  // Find a connected channel to send through
  const channelKey = gw.findChannelForMessage(params.channel);
  if (channelKey) {
    const [channel, accountId] = channelKey.split(":");
    gw.sendChannelResponse(
      params.channel,
      accountId,
      { kind: "dm", id: normalizedId }, // peer
      "", // no replyToId
      `You're now connected! Feel free to send me a message.`,
    );
  }

  return {
    approved: true,
    senderId: normalizedId,
    senderName: pending.senderName,
  };
};

const handlePairReject: Handler<"pair.reject"> = (gw, params) => {
  if (!params?.channel || !params?.senderId) {
    throw new RpcError(400, "channel and senderId required");
  }

  const normalizedId = normalizeE164(params.senderId);
  const pairKey = `${params.channel}:${normalizedId}`;

  if (!gw.pendingPairs[pairKey]) {
    throw new RpcError(404, `No pending pairing for ${pairKey}`);
  }

  delete gw.pendingPairs[pairKey];

  console.log(`[Gateway] Rejected pairing for ${normalizedId}`);

  return {
    rejected: true,
    senderId: normalizedId,
  };
};

const handleChatSend: Handler<"chat.send"> = async (gw, params) => {
  if (!params?.sessionKey || !params?.message) {
    throw new RpcError(400, "sessionKey and message required");
  }

  const messageText = params.message;

  // Check for slash commands first
  const command = parseCommand(messageText);
  if (command) {
    const commandResult = await gw.handleSlashCommandForChat(
      command,
      params.sessionKey,
    );

    if (commandResult.handled) {
      return {
        status: "command",
        command: command.name,
        response: commandResult.response,
        error: commandResult.error,
      };
    }
  }

  // Parse inline directives
  const directives = parseDirectives(messageText);

  // If message is only directives, acknowledge and return
  if (isDirectiveOnly(messageText)) {
    const ack = formatDirectiveAck(directives);
    return {
      status: "directive-only",
      response: ack,
      directives: {
        thinkLevel: directives.thinkLevel,
        model: directives.model,
      },
    };
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  const now = Date.now();
  const existing = gw.sessionRegistry[params.sessionKey];
  gw.sessionRegistry[params.sessionKey] = {
    sessionKey: params.sessionKey,
    createdAt: existing?.createdAt ?? now,
    lastActiveAt: now,
    label: existing?.label,
  };

  // Apply directive overrides for this message
  const messageOverrides: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  } = {};

  if (directives.thinkLevel) {
    messageOverrides.thinkLevel = directives.thinkLevel;
  }
  if (directives.model) {
    messageOverrides.model = directives.model;
  }

  const result = await sessionStub.chatSend(
    directives.cleaned, // Send cleaned message without directives
    params.runId ?? crypto.randomUUID(),
    JSON.parse(JSON.stringify(gw.getAllTools())),
    params.sessionKey,
    messageOverrides,
  );

  return {
    status: "started",
    runId: result.runId,
    directives:
      directives.hasThinkDirective || directives.hasModelDirective
        ? {
            thinkLevel: directives.thinkLevel,
            model: directives.model,
          }
        : undefined,
  };
};

export function buildRpcHandlers(
  gw: Gateway,
): Partial<{ [M in RpcMethod]: Handler<M> }> {
  return {
    "tools.list": handleToolsList,
    "session.get": handleSessionGet,
    "session.reset": handleSessionReset,
    "session.stats": handleSessionStats,
    "session.history": handleSessionHistory,
    "session.preview": handleSessionPreview,
    "session.patch": handleSessionPatch,
    "session.compact": handleSessionCompact,
    "sessions.list": handleSessionsList,
    "channels.list": handleChannelsList,
    "channel.inbound": handleChannelInbound,
    "channel.start": handleChannelStart,
    "channel.stop": handleChannelStop,
    "channel.status": handleChannelStatus,
    "channel.login": handleChannelLogin,
    "channel.logout": handleChannelLogout,
    "config.get": handleConfigGet,
    "config.set": handleConfigSet,
    "heartbeat.trigger": handleHeartbeatTrigger,
    "heartbeat.status": handleHeartbeatStatus,
    "heartbeat.start": handleHeartbeatStart,
    "pair.list": handlePairList,
    "pair.approve": handlePairApprove,
    "pair.reject": handlePairReject,
    "tool.request": handleToolRequest,
    "chat.send": handleChatSend,
  };
}
