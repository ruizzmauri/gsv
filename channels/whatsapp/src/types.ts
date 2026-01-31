// Types shared between WhatsApp channel and GSV gateway
// These should match gateway/src/types.ts channel types

export type ChannelId = "whatsapp";

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

// Protocol frame types (matching gateway)
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
  error?: { code: number; message: string };
};

export type EventFrame = {
  type: "evt";
  event: string;
  payload?: unknown;
};

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// WhatsApp account state
export type WhatsAppAccountState = {
  accountId: string;
  selfJid?: string;
  selfE164?: string;
  connected: boolean;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastMessageAt?: number;
};
