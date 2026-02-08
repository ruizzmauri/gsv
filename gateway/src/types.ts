//TODO: move each type to corresponding file
import type { ChannelId } from "./protocol/channel";

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: "client" | "node" | "channel";
    channel?: ChannelId;
    accountId?: string;
  };
  tools?: ToolDefinition[];
  auth?: {
    token?: string;
  };
};

export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ChatSendParams = {
  sessionKey: string;
  message: string;
  runId: string;
};

export type ToolRequestParams = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  sessionKey: string;
};

export type ToolResultParams = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type ToolInvokePayload = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  state: "partial" | "final" | "error";
  message?: unknown;
  error?: string;
};
