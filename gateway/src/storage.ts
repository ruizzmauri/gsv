/**
 * R2 Storage helpers for GSV
 *
 * Storage structure (matching clawdbot pattern):
 * gsv-storage/
 * └── agents/{agentId}/
 *     └── sessions/
 *         └── {sessionId}.jsonl.gz    # Archived transcript for a reset session
 *
 * Skills (future - markdown files like clawdbot):
 * gsv-storage/
 * └── skills/{skillName}/
 *     └── SKILL.md                    # Skill definition with YAML frontmatter
 *
 * Note: Session metadata (settings, token counts, etc.) is stored in DO storage.
 * R2 is only used for archiving transcripts on reset and skills.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { MediaAttachment } from "./protocol/channel";

// Default agent ID (GSV currently doesn't support multi-agent)
const DEFAULT_AGENT_ID = "default";

// Types for archived session info (stored in DO state, not R2)
export type ArchivedSessionInfo = {
  sessionId: string;
  archivedAt: number;
  messageCount: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
};

// Skill metadata from YAML frontmatter (clawdbot-compatible)
export type SkillMetadata = {
  name: string;
  description: string;
  homepage?: string;
  gsv?: CustomMetadata;
  clawdbot?: CustomMetadata;
};

export type CustomMetadata = {
    emoji?: string;
    requires?: {
      bins?: string[];
      anyBins?: string[];
      env?: string[];
      config?: string[];
    };
    install?: Array<{
      id?: string;
      kind: "brew" | "node" | "go" | "uv" | "download";
      label?: string;
      bins?: string[];
      formula?: string;
      package?: string;
    }>;
}

// Parsed skill entry (content + metadata)
export type SkillEntry = {
  name: string;
  content: string; // Full markdown content
  metadata: SkillMetadata;
};

/**
 * Compress data using gzip
 */
async function gzipCompress(data: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const input = encoder.encode(data);

  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(input);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

async function gzipDecompress(data: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  const decoder = new TextDecoder();
  return decoder.decode(result);
}

function messagesToJsonl(messages: Message[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n");
}

function jsonlToMessages(jsonl: string): Message[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function resolveSessionTranscriptKey(
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): string {
  return `agents/${agentId}/sessions/${sessionId}.jsonl.gz`;
}

/**
 * Archive a session's messages to R2
 *
 * @param storage - R2 bucket
 * @param sessionId - The unique session ID being archived
 * @param messages - Messages to archive
 * @param tokens - Token usage for this session
 * @param agentId - Agent ID (defaults to "default")
 * @returns The R2 key where archived
 */
export async function archiveSession(
  storage: R2Bucket,
  sessionKey: string, // Kept for compatibility, but not used in path
  sessionId: string,
  messages: Message[],
  tokens: { input: number; output: number; total: number },
  agentId: string = DEFAULT_AGENT_ID
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  const key = resolveSessionTranscriptKey(sessionId, agentId);
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      messageCount: messages.length.toString(),
      archivedAt: Date.now().toString(),
      inputTokens: tokens.input.toString(),
      outputTokens: tokens.output.toString(),
      totalTokens: tokens.total.toString(),
    },
  });

  return key;
}

export async function getArchivedTranscript(
  storage: R2Bucket,
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): Promise<Message[] | null> {
  const key = resolveSessionTranscriptKey(sessionId, agentId);
  const obj = await storage.get(key);

  if (!obj) {
    return null;
  }

  const compressed = await obj.arrayBuffer();
  const jsonl = await gzipDecompress(compressed);
  return jsonlToMessages(jsonl);
}

export async function deleteArchivedSession(
  storage: R2Bucket,
  sessionId: string,
  agentId: string = DEFAULT_AGENT_ID
): Promise<boolean> {
  const key = resolveSessionTranscriptKey(sessionId, agentId);
  await storage.delete(key);
  return true;
}

export async function listArchivedSessions(
  storage: R2Bucket,
  agentId: string = DEFAULT_AGENT_ID
): Promise<ArchivedSessionInfo[]> {
  const prefix = `agents/${agentId}/sessions/`;
  const list = await storage.list({ prefix });

  const sessions: ArchivedSessionInfo[] = [];
  for (const obj of list.objects) {
    // Extract sessionId from key: agents/{agentId}/sessions/{sessionId}.jsonl.gz
    const match = obj.key.match(/\/sessions\/(.+)\.jsonl\.gz$/);
    if (!match) continue;

    const sessionId = match[1];
    const meta = obj.customMetadata || {};

    sessions.push({
      sessionId,
      archivedAt: parseInt(meta.archivedAt || "0", 10) || obj.uploaded.getTime(),
      messageCount: parseInt(meta.messageCount || "0", 10),
      tokens: {
        input: parseInt(meta.inputTokens || "0", 10),
        output: parseInt(meta.outputTokens || "0", 10),
        total: parseInt(meta.totalTokens || "0", 10),
      },
    });
  }

  return sessions;
}

/**
 * Archive partial messages (for compact operation)
 * Creates a partial archive with the same sessionId but different path
 */
export async function archivePartialMessages(
  storage: R2Bucket,
  sessionKey: string,
  sessionId: string,
  messages: Message[],
  partNumber: number,
  agentId: string = DEFAULT_AGENT_ID
): Promise<string> {
  if (messages.length === 0) {
    return "";
  }

  const jsonl = messagesToJsonl(messages);
  const compressed = await gzipCompress(jsonl);

  // Partial archives get a -part{N} suffix
  const key = `agents/${agentId}/sessions/${sessionId}-part${partNumber}.jsonl.gz`;
  await storage.put(key, compressed, {
    customMetadata: {
      sessionKey,
      sessionId,
      agentId,
      partNumber: partNumber.toString(),
      messageCount: messages.length.toString(),
      archivedAt: Date.now().toString(),
    },
  });

  return key;
}

function parseSkillFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  let body = content;

  // Check for YAML frontmatter (--- delimited)
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    const yaml = match[1];
    body = match[2];

    // Simple YAML parsing (key: value pairs)
    for (const line of yaml.split("\n")) {
      const keyValue = line.match(/^(\w+):\s*(.*)$/);
      if (keyValue) {
        frontmatter[keyValue[1]] = keyValue[2].trim();
      }
    }
  }

  return { frontmatter, body };
}

function resolveSkillKey(skillName: string): string {
  return `skills/${skillName}/SKILL.md`;
}

export async function saveSkill(
  storage: R2Bucket,
  skillName: string,
  content: string
): Promise<void> {
  const key = resolveSkillKey(skillName);
  await storage.put(key, content, {
    customMetadata: {
      name: skillName,
      updatedAt: Date.now().toString(),
    },
  });
}

export async function loadSkill(
  storage: R2Bucket,
  skillName: string
): Promise<SkillEntry | null> {
  const key = resolveSkillKey(skillName);
  const obj = await storage.get(key);

  if (!obj) {
    return null;
  }

  const content = await obj.text();
  const { frontmatter, body } = parseSkillFrontmatter(content);

  let clawdbotMeta: SkillMetadata["clawdbot"];
  try {
    if (frontmatter.metadata) {
      clawdbotMeta = JSON.parse(frontmatter.metadata)?.clawdbot;
    }
  } catch {
    // Ignore malformed metadata
  }

  return {
    name: frontmatter.name || skillName,
    content,
    metadata: {
      name: frontmatter.name || skillName,
      description: frontmatter.description || "",
      homepage: frontmatter.homepage,
      clawdbot: clawdbotMeta,
    },
  };
}

export async function listSkills(storage: R2Bucket): Promise<string[]> {
  const list = await storage.list({ prefix: "skills/" });

  const skillNames = new Set<string>();
  for (const obj of list.objects) {
    const match = obj.key.match(/^skills\/([^/]+)\//);
    if (match) {
      skillNames.add(match[1]);
    }
  }

  return Array.from(skillNames);
}

export async function deleteSkill(
  storage: R2Bucket,
  skillName: string
): Promise<boolean> {
  const key = resolveSkillKey(skillName);
  await storage.delete(key);

  // TODO: delete any reference files in the skill directory
  return true;
}

export const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024; // 25MB limit

export async function storeMediaInR2(
  attachment: MediaAttachment,
  bucket: R2Bucket,
  sessionKey: string,
): Promise<string> {
  if (!attachment.data) {
    throw new Error("Media attachment missing base64 data");
  }

  const binaryData = Uint8Array.from(atob(attachment.data), c => c.charCodeAt(0));
  
  if (binaryData.byteLength > MAX_MEDIA_SIZE_BYTES) {
    throw new Error(`Media file too large (${(binaryData.byteLength / 1024 / 1024).toFixed(1)}MB > 25MB limit)`);
  }

  const ext = getExtensionFromMime(attachment.mimeType);
  const uuid = crypto.randomUUID();
  const r2Key = `media/${sessionKey}/${uuid}.${ext}`;

  await bucket.put(r2Key, binaryData, {
    httpMetadata: {
      contentType: attachment.mimeType,
    },
    customMetadata: {
      originalFilename: attachment.filename || "",
      uploadedAt: Date.now().toString(),
      sessionKey,
    },
  });

  console.log(`[MediaStore] Stored ${attachment.type} in R2: ${r2Key} (${binaryData.byteLength} bytes)`);
  return r2Key;
}

export async function fetchMediaFromR2(
  r2Key: string,
  bucket: R2Bucket,
): Promise<{ data: string; mimeType: string } | null> {
  const object = await bucket.get(r2Key);
  if (!object) {
    console.log(`[MediaStore] Not found in R2: ${r2Key}`);
    return null;
  }

  const arrayBuffer = await object.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  const mimeType = object.httpMetadata?.contentType || "application/octet-stream";

  console.log(`[MediaStore] Fetched from R2: ${r2Key} (${arrayBuffer.byteLength} bytes)`);
  return { data: base64, mimeType };
}

export async function deleteSessionMedia(
  bucket: R2Bucket,
  sessionKey: string,
): Promise<number> {
  const prefix = `media/${sessionKey}/`;
  let deleted = 0;
  let cursor: string | undefined;

  // List and delete all objects with this prefix
  do {
    const listed = await bucket.list({ prefix, cursor });
    
    if (listed.objects.length > 0) {
      const keys = listed.objects.map(obj => obj.key);
      await bucket.delete(keys);
      deleted += keys.length;
    }
    
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (deleted > 0) {
    console.log(`[MediaStore] Deleted ${deleted} media files for session ${sessionKey}`);
  }
  return deleted;
}

export async function processInboundMedia(
  media: MediaAttachment[] | undefined,
  bucket: R2Bucket,
  sessionKey: string,
): Promise<MediaAttachment[]> {
  if (!media || media.length === 0) {
    return [];
  }

  const processed: MediaAttachment[] = [];

  for (const attachment of media) {
    // Skip if already has r2Key (shouldn't happen for inbound)
    if (attachment.r2Key) {
      processed.push(attachment);
      continue;
    }

    // Skip if no data
    if (!attachment.data) {
      processed.push(attachment);
      continue;
    }

    try {
      const r2Key = await storeMediaInR2(attachment, bucket, sessionKey);
      
      // Return attachment with r2Key, strip base64 data
      processed.push({
        type: attachment.type,
        mimeType: attachment.mimeType,
        r2Key,
        filename: attachment.filename,
        size: attachment.size,
        duration: attachment.duration,
        transcription: attachment.transcription,
        // data is intentionally omitted
      });
    } catch (e) {
      console.error(`[MediaStore] Failed to store media:`, e);
      // On failure, keep the attachment as-is (with data) so it can still be used
      processed.push(attachment);
    }
  }

  return processed;
}

function getExtensionFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    // Images
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    // Audio
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
    // Video
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    // Documents
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };

  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  return mimeMap[baseMime] || "bin";
}
