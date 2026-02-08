import { GsvConfig, PendingPair } from "../config";
import type { ChannelAccountStatus } from "../channel-interface";
import type { Gateway } from "../gateway";
import {
  ResetPolicy,
  ResetResult,
  SessionPatchParams,
  SessionSettings,
  SessionStats,
  TokenUsage,
} from "../session";
import { SessionRegistryEntry } from "../types";
import {
  ChannelInboundParams,
  ChannelRegistryEntry,
  ChannelId,
} from "./channel";

export type RpcMethods = {
  "tools.list": {
    params: undefined;
    result: {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    };
  };

  "chat.send": {
    params: { sessionKey: string; message: string; runId?: string };
    result:
      | {
          status: "started";
          runId: string;
          queued?: false;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
        }
      | {
          status: "command";
          command: string;
          response?: string;
          error?: string;
        }
      | {
          status: "directive-only";
          response?: string;
          directives?: {
            thinkLevel?: string;
            model?: { provider: string; id: string };
          };
        };
  };

  "config.get": {
    params: { path?: string } | undefined;
    result: {
      path?: string;
      value?: unknown;
      config?: GsvConfig;
    };
  };

  "config.set": {
    params: { path: string; value: unknown };
    result: { ok: true; path: string };
  };

  "session.stats": {
    params: { sessionKey: string };
    result: SessionStats;
  };

  "session.get": {
    params: { sessionKey: string };
    result: {
      sessionId: string;
      sessionKey: string;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
      tokens: TokenUsage;
      settings: SessionSettings;
      resetPolicy?: ResetPolicy;
      lastResetAt?: number;
      previousSessionIds: string[];
      label?: string;
    };
  };

  "session.patch": {
    params: SessionPatchParams & { sessionKey: string };
    result: { ok: boolean };
  };

  "sessions.list": {
    params: { offset?: number; limit?: number } | undefined;
    result: { sessions: SessionRegistryEntry[]; count: number };
  };

  "session.reset": {
    params: { sessionKey: string };
    result: ResetResult;
  };

  "session.compact": {
    params: { sessionKey: string; keepMessages?: number };
    result: {
      ok: boolean;
      trimmedMessages: number;
      keptMessages: number;
      archivedTo?: string;
    };
  };

  "session.history": {
    params: { sessionKey: string };
    result: {
      sessionKey: string;
      currentSessionId: string;
      previousSessionIds: string[];
    };
  };

  "session.preview": {
    params: { sessionKey: string; limit?: number };
    result: {
      sessionKey: string;
      sessionId: string;
      messageCount: number;
      messages: unknown[]; // TS2589
    };
  };

  "channels.list": {
    params: undefined;
    result: { channels: ChannelRegistryEntry[]; count: number };
  };

  "channel.inbound": {
    params: ChannelInboundParams;
    result: {
      status: string;
      sessionKey?: string;
      [key: string]: unknown;
    };
  };

  "channel.start": {
    params: {
      channel: string;
      accountId?: string;
      config?: Record<string, unknown>;
    };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "channel.stop": {
    params: { channel: string; accountId?: string };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "channel.status": {
    params: { channel: string; accountId?: string };
    result: { channel: ChannelId; accounts: ChannelAccountStatus[] };
  };

  "channel.login": {
    params: { channel: string; accountId?: string; force?: boolean };
    result: {
      ok: true;
      channel: ChannelId;
      accountId: string;
      qrDataUrl?: string;
      message: string;
    };
  };

  "channel.logout": {
    params: { channel: string; accountId?: string };
    result: { ok: true; channel: ChannelId; accountId: string };
  };

  "heartbeat.status": {
    params: undefined;
    result: { agents: Record<string, unknown> };
  };

  "heartbeat.start": {
    params: undefined;
    result: { message: string; agents: Record<string, unknown> };
  };

  "heartbeat.trigger": {
    params: { agentId?: string } | undefined;
    result: {
      ok: boolean;
      message: string;
      skipped?: boolean;
      skipReason?: string;
    };
  };

  "pair.list": {
    params: undefined;
    result: { pairs: Record<string, PendingPair> };
  };

  "pair.approve": {
    params: { channel: string; senderId: string };
    result: { approved: true; senderId: string; senderName?: string };
  };

  "pair.reject": {
    params: { channel: string; senderId: string };
    result: { rejected: true; senderId: string };
  };

  "tool.request": {
    params: {
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      sessionKey: string;
    };
    result: {
      status: "sent";
    };
  };
};

export type RpcMethod = keyof RpcMethods;
export type ParamsOf<M extends RpcMethod> = RpcMethods[M]["params"];
export type ResultOf<M extends RpcMethod> = RpcMethods[M]["result"];

export type Handler<M extends RpcMethod> = (
  gw: Gateway,
  params: ParamsOf<M>,
) => Promise<ResultOf<M>> | ResultOf<M>;
