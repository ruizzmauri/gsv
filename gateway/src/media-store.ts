// /**
//  * Media storage using R2
//  * 
//  * Media is stored permanently (no TTL) and organized by session:
//  *   media/{sessionKey}/{uuid}.{ext}
//  * 
//  * Cleanup happens on session reset - all media for that session is deleted.
//  * 
//  * Flow:
//  * 1. Gateway receives inbound media (base64)
//  * 2. Gateway stores in R2, gets r2Key
//  * 3. Session stores message with r2Key reference (no base64)
//  * 4. On LLM call, Session fetches from R2 → base64 (with cache)
//  * 5. On session reset, delete all media for that session
//  */

// import type { MediaAttachment } from "./types";

// // Max file size (25MB - matches transcription limit)
// export const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024;

// /**
//  * Store media in R2 and return the r2Key
//  * 
//  * @param attachment - Media attachment with base64 data
//  * @param bucket - R2 bucket
//  * @param sessionKey - Session key for organizing media
//  * @returns r2Key for the stored media
//  */
// export async function storeMediaInR2(
//   attachment: MediaAttachment,
//   bucket: R2Bucket,
//   sessionKey: string,
// ): Promise<string> {
//   if (!attachment.data) {
//     throw new Error("Media attachment missing base64 data");
//   }

//   // Decode base64
//   const binaryData = Uint8Array.from(atob(attachment.data), c => c.charCodeAt(0));
  
//   // Check size
//   if (binaryData.byteLength > MAX_MEDIA_SIZE_BYTES) {
//     throw new Error(`Media file too large (${(binaryData.byteLength / 1024 / 1024).toFixed(1)}MB > 25MB limit)`);
//   }

//   // Generate key: media/{sessionKey}/{uuid}.{ext}
//   const ext = getExtensionFromMime(attachment.mimeType);
//   const uuid = crypto.randomUUID();
//   const r2Key = `media/${sessionKey}/${uuid}.${ext}`;

//   // Store in R2 with metadata
//   await bucket.put(r2Key, binaryData, {
//     httpMetadata: {
//       contentType: attachment.mimeType,
//     },
//     customMetadata: {
//       originalFilename: attachment.filename || "",
//       uploadedAt: Date.now().toString(),
//       sessionKey,
//     },
//   });

//   console.log(`[MediaStore] Stored ${attachment.type} in R2: ${r2Key} (${binaryData.byteLength} bytes)`);
//   return r2Key;
// }

// /**
//  * Fetch media from R2 and return as base64
//  */
// export async function fetchMediaFromR2(
//   r2Key: string,
//   bucket: R2Bucket,
// ): Promise<{ data: string; mimeType: string } | null> {
//   const object = await bucket.get(r2Key);
//   if (!object) {
//     console.log(`[MediaStore] Not found in R2: ${r2Key}`);
//     return null;
//   }

//   const arrayBuffer = await object.arrayBuffer();
//   const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
//   const mimeType = object.httpMetadata?.contentType || "application/octet-stream";

//   console.log(`[MediaStore] Fetched from R2: ${r2Key} (${arrayBuffer.byteLength} bytes)`);
//   return { data: base64, mimeType };
// }

// /**
//  * Delete all media for a session
//  * Called on session reset
//  */
// export async function deleteSessionMedia(
//   bucket: R2Bucket,
//   sessionKey: string,
// ): Promise<number> {
//   const prefix = `media/${sessionKey}/`;
//   let deleted = 0;
//   let cursor: string | undefined;

//   // List and delete all objects with this prefix
//   do {
//     const listed = await bucket.list({ prefix, cursor });
    
//     if (listed.objects.length > 0) {
//       const keys = listed.objects.map(obj => obj.key);
//       await bucket.delete(keys);
//       deleted += keys.length;
//     }
    
//     cursor = listed.truncated ? listed.cursor : undefined;
//   } while (cursor);

//   if (deleted > 0) {
//     console.log(`[MediaStore] Deleted ${deleted} media files for session ${sessionKey}`);
//   }
//   return deleted;
// }

// /**
//  * Process inbound media: store all media in R2, return attachments with r2Key
//  * The base64 data is stripped - only r2Key remains for storage
//  */
// export async function processInboundMedia(
//   media: MediaAttachment[] | undefined,
//   bucket: R2Bucket,
//   sessionKey: string,
// ): Promise<MediaAttachment[]> {
//   if (!media || media.length === 0) {
//     return [];
//   }

//   const processed: MediaAttachment[] = [];

//   for (const attachment of media) {
//     // Skip if already has r2Key (shouldn't happen for inbound)
//     if (attachment.r2Key) {
//       processed.push(attachment);
//       continue;
//     }

//     // Skip if no data
//     if (!attachment.data) {
//       processed.push(attachment);
//       continue;
//     }

//     try {
//       const r2Key = await storeMediaInR2(attachment, bucket, sessionKey);
      
//       // Return attachment with r2Key, strip base64 data
//       processed.push({
//         type: attachment.type,
//         mimeType: attachment.mimeType,
//         r2Key,
//         filename: attachment.filename,
//         size: attachment.size,
//         duration: attachment.duration,
//         transcription: attachment.transcription,
//         // data is intentionally omitted
//       });
//     } catch (e) {
//       console.error(`[MediaStore] Failed to store media:`, e);
//       // On failure, keep the attachment as-is (with data) so it can still be used
//       processed.push(attachment);
//     }
//   }

//   return processed;
// }

// function getExtensionFromMime(mimeType: string): string {
//   const mimeMap: Record<string, string> = {
//     // Images
//     "image/jpeg": "jpg",
//     "image/png": "png",
//     "image/gif": "gif",
//     "image/webp": "webp",
//     "image/svg+xml": "svg",
//     // Audio
//     "audio/ogg": "ogg",
//     "audio/opus": "opus",
//     "audio/mpeg": "mp3",
//     "audio/mp3": "mp3",
//     "audio/mp4": "m4a",
//     "audio/m4a": "m4a",
//     "audio/wav": "wav",
//     "audio/webm": "webm",
//     "audio/flac": "flac",
//     // Video
//     "video/mp4": "mp4",
//     "video/webm": "webm",
//     "video/quicktime": "mov",
//     // Documents
//     "application/pdf": "pdf",
//     "application/msword": "doc",
//     "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
//   };

//   const baseMime = mimeType.split(";")[0].trim().toLowerCase();
//   return mimeMap[baseMime] || "bin";
// }
