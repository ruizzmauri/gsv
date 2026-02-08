import { RpcMethod, Handler } from "../../protocol/methods";
import {
  handleSessionGet,
  handleSessionReset,
  handleSessionStats,
  handleSessionHistory,
  handleSessionPreview,
  handleSessionPatch,
  handleSessionCompact,
  handleSessionsList,
} from "./session";
import {
  handleChannelsList,
  handleChannelInbound,
  handleChannelStart,
  handleChannelStop,
  handleChannelStatus,
  handleChannelLogin,
  handleChannelLogout,
} from "./channel";
import { handleToolsList, handleToolRequest } from "./tools";
import { handlePairList, handlePairApprove, handlePairReject } from "./pairing";
import { handleChatSend } from "./chat";
import {
  handleHeartbeatStart,
  handleHeartbeatStatus,
  handleHeartbeatTrigger,
} from "./heartbeat";
import { handleConfigGet, handleConfigSet } from "./config";

export function buildRpcHandlers(): Partial<{ [M in RpcMethod]: Handler<M> }> {
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
