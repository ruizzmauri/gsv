import type { Message } from "@mariozechner/pi-ai";

/**
 * Rough token estimation using character-based heuristic.
 *
 * Uses JSON.stringify length / 4 with a 1.2x safety margin.
 * No tokenizer required — accurate enough for context window budgeting.
 */

const CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 1.2;

export function estimateMessageTokens(message: Message): number {
  const json = JSON.stringify(message);
  return Math.ceil((json.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

export function estimateContextTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Estimate tokens for a system prompt string.
 * Same heuristic as message estimation: chars / 4 * safety margin.
 */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_MARGIN);
}

/**
 * Count image content blocks across messages.
 * Used to annotate compaction summaries with image counts.
 */
export function countImageBlocks(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    const content = msg.content as Array<{ type: string }>;
    for (const block of content) {
      if (block.type === "image") count++;
    }
  }
  return count;
}

/**
 * Serialize messages into a human-readable format for the summarization prompt.
 */
export function serializeMessagesForSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("\n");
      if (text) lines.push(`[user]: ${text}`);
    } else if (msg.role === "assistant") {
      const textBlocks = (
        msg.content as Array<{ type: string; text?: string }>
      )
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text);
      const toolCalls = (
        msg.content as Array<{ type: string; name?: string }>
      ).filter((b) => b.type === "toolCall");
      if (textBlocks.length > 0) {
        lines.push(`[assistant]: ${textBlocks.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        const names = toolCalls.map((tc) => tc.name || "unknown").join(", ");
        lines.push(`[assistant tool calls]: ${names}`);
      }
    } else if (msg.role === "toolResult") {
      const text = (
        msg.content as Array<{ type: string; text?: string }>
      )
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
      const toolName = (msg as any).toolName || "unknown";
      // Truncate very long tool results to keep summarization prompt manageable
      const maxLen = 2000;
      const truncated =
        text.length > maxLen ? text.slice(0, maxLen) + "\n[...truncated]" : text;
      lines.push(`[tool result: ${toolName}]: ${truncated}`);
    }
  }
  return lines.join("\n");
}
