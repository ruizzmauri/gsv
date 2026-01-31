/**
 * Audio transcription using OpenAI Whisper API
 * 
 * Called by Gateway to transcribe audio attachments before sending to Session.
 * Uses the configured OpenAI API key from Gateway config.
 */

import type { MediaAttachment } from "./types";

const DEFAULT_MODEL = "whisper-1";
const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";

export type TranscriptionResult = {
  text: string;
  model: string;
  duration?: number;
};

/**
 * Transcribe audio using OpenAI Whisper API
 */
export async function transcribeAudio(
  attachment: MediaAttachment,
  apiKey: string,
  model: string = DEFAULT_MODEL,
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
    throw new Error(`Transcription failed (HTTP ${response.status}): ${errorText}`);
  }

  const result = await response.json() as { text?: string };
  if (!result.text) {
    throw new Error("Transcription response missing text");
  }

  return {
    text: result.text.trim(),
    model,
    duration: attachment.duration,
  };
}

/**
 * Process media attachments and transcribe any audio
 * Returns the attachments with transcription populated
 */
export async function processMediaWithTranscription(
  media: MediaAttachment[] | undefined,
  openaiApiKey: string | undefined,
): Promise<MediaAttachment[]> {
  if (!media || media.length === 0) {
    return [];
  }

  const processed: MediaAttachment[] = [];

  for (const attachment of media) {
    // Only transcribe audio that has data but no transcription yet
    if (attachment.type === "audio" && attachment.data && !attachment.transcription) {
      if (!openaiApiKey) {
        console.log("[Gateway] Skipping audio transcription: no OpenAI API key configured");
        processed.push(attachment);
        continue;
      }

      try {
        console.log(`[Gateway] Transcribing audio: ${attachment.mimeType}, ${attachment.data.length} chars`);
        const result = await transcribeAudio(attachment, openaiApiKey);
        console.log(`[Gateway] Transcription result: "${result.text.substring(0, 50)}..."`);
        
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
