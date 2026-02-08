import type { ChannelId } from "../../protocol/channel";
import { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleChannelsList: Handler<"channels.list"> = (gw) => {
  const channels = Object.values(gw.channelRegistry);

  return {
    channels,
    count: channels.length,
  };
};

export const handleChannelInbound: Handler<"channel.inbound"> = async (gw, params) => {
  const result = await gw.handleChannelInboundRpc(params);
  if (!result.ok) {
    const code = result.error?.includes("required") ? 400 : 500;
    throw new RpcError(
      code,
      result.error ?? "Failed to handle channel inbound",
    );
  }

  const { ok: _ok, error: _error, ...payload } = result;
  return {
    ...payload,
    status: payload.status ?? "started",
  };
};

export const handleChannelStart: Handler<"channel.start"> = async (gw, params) => {
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

export const handleChannelStop: Handler<"channel.stop"> = async (gw, params) => {
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

export const handleChannelStatus: Handler<"channel.status"> = async (gw, params) => {
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

export const handleChannelLogin: Handler<"channel.login"> = async (gw, params) => {
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

export const handleChannelLogout: Handler<"channel.logout"> = async (gw, params) => {
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
