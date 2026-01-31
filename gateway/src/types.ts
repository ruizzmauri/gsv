
export type RequestFrame<Params = unknown> = {
  type: "req";
  id: string;
  method: string;
  params?: Params;
};

export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

export type ResponseFrame<Payload = unknown> =
  | { type: "res"; id: string; ok: true; payload?: Payload }
  | { type: "res"; id: string; ok: false; error: ErrorShape };

export type EventFrame<Payload = unknown> = {
  type: "evt";
  event: string;
  payload?: Payload;
  seq?: number;
};

export type Frame = RequestFrame | ResponseFrame | EventFrame;

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

export type ChannelId =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage"
  | "googlechat"
  | (string & {});

export type ChatType = "dm" | "group";

export type PeerInfo = {
  kind: ChatType;
  id: string;
  name?: string;
  handle?: string;
};

export type SenderInfo = {
  id: string;
  name?: string;
  handle?: string;
};

/**
 * Media attachment for channel messages
 * Can be provided as base64 data or URL
 */
export type MediaAttachment = {
  /** Media type: image, audio, video, document */
  type: "image" | "audio" | "video" | "document";
  /** MIME type (e.g., image/jpeg, audio/ogg) */
  mimeType: string;
  /** Base64-encoded data (preferred for LLM) */
  data?: string;
  /** URL to media (fallback, requires fetch) */
  url?: string;
  /** Original filename */
  filename?: string;
  /** File size in bytes */
  size?: number;
  /** Duration in seconds (for audio/video) */
  duration?: number;
  /** Transcription (for audio, populated by channel or gateway) */
  transcription?: string;
};

export type ChannelInboundParams = {
  channel: ChannelId;
  accountId: string;
  peer: PeerInfo;
  sender?: SenderInfo;
  message: {
    id: string;
    text: string;
    timestamp?: number;
    replyToId?: string;
    replyToText?: string;
    /** Media attachments (images, audio, video, documents) */
    media?: MediaAttachment[];
    /** Legacy single media URL (deprecated, use media array) */
    mediaUrl?: string;
    /** Legacy single media type (deprecated, use media array) */
    mediaType?: string;
    location?: { lat: number; lon: number; name?: string };
  };
  wasMentioned?: boolean;
  mentionedIds?: string[];
};

export type ChannelOutboundPayload = {
  channel: ChannelId;
  accountId: string;
  peer: PeerInfo;
  sessionKey: string;
  message: {
    text: string;
    replyToId?: string;
    mediaUrl?: string;
  };
};

export type ChannelRegistryEntry = {
  channel: ChannelId;
  accountId: string;
  connectedAt: number;
  lastMessageAt?: number;
};

export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount?: number;
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
