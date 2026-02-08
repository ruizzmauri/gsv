import type { ChannelId } from "./protocol/channel";

export type AuthParams = {
  token?: string;
};

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
  auth?: AuthParams;
};

export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};

export type SessionsListResult = {
  sessions: SessionRegistryEntry[];
  count: number;
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

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string | unknown[];
  toolCallId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};
