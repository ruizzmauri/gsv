/**
 * GSV UI Types
 * Matches the Gateway protocol types from gateway/src/types.ts
 */

// WebSocket Frame types
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "evt";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

// Tool types
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SessionSettings = {
  model?: { provider: string; id: string };
  thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;
  maxTokens?: number;
};

export type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number;
  idleMinutes?: number;
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};

// Channel types
export type ChannelRegistryEntry = {
  channel: string;
  accountId: string;
  connectedAt: number;
  lastMessageAt?: number;
};

// Chat types
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type UserMessage = {
  role: "user";
  content: string | ContentBlock[];
  timestamp?: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
  timestamp?: number;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError?: boolean;
  timestamp?: number;
};

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | ThinkingBlock;

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ImageBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  r2Key?: string;
};

export type ThinkingBlock = {
  type: "thinking";
  text: string;
};

// Chat event payload
export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  state: "partial" | "final" | "error";
  message?: AssistantMessage;
  error?: string;
};

// Config types
export type GsvConfig = {
  model: { provider: string; id: string };
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  systemPrompt?: string;
  timeouts?: {
    llmMs?: number;
    toolMs?: number;
  };
};

// Navigation
export type Tab =
  | "chat"
  | "overview"
  | "sessions"
  | "channels"
  | "nodes"
  | "workspace"
  | "config"
  | "debug";

export const TAB_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: "Chat", tabs: ["chat"] },
  { label: "Control", tabs: ["overview", "sessions", "channels", "nodes"] },
  { label: "Agent", tabs: ["workspace"] },
  { label: "Settings", tabs: ["config", "debug"] },
];

export const TAB_ICONS: Record<Tab, string> = {
  chat: "💬",
  overview: "📊",
  sessions: "📋",
  channels: "📱",
  nodes: "🖥️",
  workspace: "📁",
  config: "⚙️",
  debug: "🔧",
};

export const TAB_LABELS: Record<Tab, string> = {
  chat: "Chat",
  overview: "Overview",
  sessions: "Sessions",
  channels: "Channels",
  nodes: "Nodes",
  workspace: "Workspace",
  config: "Config",
  debug: "Debug",
};
