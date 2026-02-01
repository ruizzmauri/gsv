/**
 * Audio transcription using OpenAI Whisper API or Cloudflare Workers AI
 * 
 * Called by Gateway to transcribe audio attachments before sending to Session.
 * Supports multiple providers:
 * - OpenAI: Uses configured API key
 * - Workers AI: Free, uses Cloudflare AI binding
 */

import type { MediaAttachment } from "./types";

const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_DEFAULT_MODEL = "whisper-1";

// Max audio size for transcription (25MB is OpenAI's limit)
export const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

export type TranscriptionProvider = "openai" | "workers-ai";

export type TranscriptionConfig = {
  provider: TranscriptionProvider;
  openaiApiKey?: string;
  workersAi?: Ai; // Cloudflare Workers AI binding
};

export type TranscriptionResult = {
  text: string;
  provider: TranscriptionProvider;
  model?: string;
  duration?: number;
};

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeWithOpenAI(
  attachment: MediaAttachment,
  apiKey: string,
  model: string = OPENAI_DEFAULT_MODEL,
): Promise<TranscriptionResult> {
  if (!attachment.data) {
    throw new Error("Audio attachment missing base64 data");
  }

  // Convert base64 to blob
  const binaryData = Uint8Array.from(atob(attachment.data), c => c.charCodeAt(0));
  const blob = new Blob([binaryData], { type: attachment.mimeType });

  // Determine file extension from mime type
  const ext = getExtensionFromMime(attachment.mimeType);
  const filename = attachment.filename || `audio.${ext}`;

  // Build form data
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", model);
  formData.append("response_format", "json");

  // Call OpenAI API
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (HTTP ${response.status}): ${errorText}`);
  }

  const result = await response.json() as { text?: string };
  if (!result.text) {
    throw new Error("OpenAI transcription response missing text");
  }

  return {
    text: result.text.trim(),
    provider: "openai",
    model,
    duration: attachment.duration,
  };
}

/**
 * Transcribe audio using Cloudflare Workers AI (free)
 */
async function transcribeWithWorkersAI(
  attachment: MediaAttachment,
  ai: Ai,
): Promise<TranscriptionResult> {
  if (!attachment.data) {
    throw new Error("Audio attachment missing base64 data");
  }

  // Workers AI Whisper expects base64 string directly
  const result = await (ai as any).run("@cf/openai/whisper-large-v3-turbo", {
    audio: attachment.data,
  }) as { text?: string; vtt?: string };

  if (!result.text) {
    throw new Error("Workers AI transcription response missing text");
  }

  return {
    text: result.text.trim(),
    provider: "workers-ai",
    model: "@cf/openai/whisper-large-v3-turbo",
    duration: attachment.duration,
  };
}

/**
 * Transcribe audio using available provider
 * Priority: Workers AI (free) > OpenAI (if configured)
 */
export async function transcribeAudio(
  attachment: MediaAttachment,
  config: TranscriptionConfig,
): Promise<TranscriptionResult> {
  // Check size limit
  if (attachment.size && attachment.size > MAX_AUDIO_SIZE_BYTES) {
    throw new Error(`Audio file too large (${(attachment.size / 1024 / 1024).toFixed(1)}MB > 25MB limit)`);
  }

  // Try Workers AI first (free)
  if (config.provider === "workers-ai" && config.workersAi) {
    return transcribeWithWorkersAI(attachment, config.workersAi);
  }

  // Fall back to OpenAI
  if (config.provider === "openai" && config.openaiApiKey) {
    return transcribeWithOpenAI(attachment, config.openaiApiKey);
  }

  throw new Error(`No transcription provider available (provider=${config.provider})`);
}

/**
 * Process media attachments and transcribe any audio
 * Returns the attachments with transcription populated
 */
export async function processMediaWithTranscription(
  media: MediaAttachment[] | undefined,
  config: {
    openaiApiKey?: string;
    workersAi?: Ai;
    preferredProvider?: TranscriptionProvider;
  },
): Promise<MediaAttachment[]> {
  if (!media || media.length === 0) {
    return [];
  }

  // Determine which provider to use
  // Priority: Workers AI (free) > OpenAI
  let transcriptionConfig: TranscriptionConfig | null = null;

  if (config.workersAi) {
    transcriptionConfig = {
      provider: "workers-ai",
      workersAi: config.workersAi,
    };
  } else if (config.openaiApiKey) {
    transcriptionConfig = {
      provider: "openai",
      openaiApiKey: config.openaiApiKey,
    };
  }

  // Allow override via preferredProvider
  if (config.preferredProvider === "openai" && config.openaiApiKey) {
    transcriptionConfig = {
      provider: "openai",
      openaiApiKey: config.openaiApiKey,
    };
  }

  const processed: MediaAttachment[] = [];

  for (const attachment of media) {
    // Only transcribe audio that has data but no transcription yet
    if (attachment.type === "audio" && attachment.data && !attachment.transcription) {
      if (!transcriptionConfig) {
        console.log("[Gateway] Skipping audio transcription: no provider configured");
        processed.push(attachment);
        continue;
      }

      try {
        const sizeInfo = attachment.size 
          ? `${(attachment.size / 1024).toFixed(1)}KB` 
          : `${attachment.data.length} chars b64`;
        console.log(`[Gateway] Transcribing audio (${transcriptionConfig.provider}): ${attachment.mimeType}, ${sizeInfo}`);
        
        const result = await transcribeAudio(attachment, transcriptionConfig);
        console.log(`[Gateway] Transcription (${result.provider}): "${result.text.substring(0, 50)}..."`);
        
        processed.push({
          ...attachment,
          transcription: result.text,
        });
      } catch (e) {
        console.error("[Gateway] Transcription failed:", e);
        // Keep the attachment without transcription
        processed.push(attachment);
      }
    } else {
      // Pass through non-audio or already transcribed
      processed.push(attachment);
    }
  }

  return processed;
}

function getExtensionFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };

  // Handle mime types with codecs (e.g., "audio/ogg; codecs=opus")
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  return mimeMap[baseMime] || "ogg";
}
