/**
 * Slash command parsing and handling for GSV
 * 
 * Supported commands:
 * - /new, /reset - Reset the session
 * - /compact [N] - Compact session to last N messages (default 20)
 * - /stop - Stop the current run
 * - /status - Show session status
 * - /model [name] - Show or set model
 * - /think [level] - Set thinking level
 * - /help - Show available commands
 */

export type ParsedCommand = {
  name: string;
  args: string;
  raw: string;
};

export type CommandResult = {
  handled: boolean;
  response?: string;
  error?: string;
};

// Command aliases map to canonical names
const COMMAND_ALIASES: Record<string, string> = {
  "new": "reset",
  "reset": "reset",
  "compact": "compact",
  "stop": "stop",
  "status": "status",
  "model": "model",
  "think": "think",
  "thinking": "think",
  "t": "think",
  "help": "help",
  "?": "help",
};

// Commands that can take arguments
const COMMANDS_WITH_ARGS = new Set(["compact", "model", "think"]);

/**
 * Parse a slash command from message text
 * Returns null if not a command
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  
  // Must start with /
  if (!trimmed.startsWith("/")) {
    return null;
  }
  
  // Extract command and args
  const match = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }
  
  const rawName = match[1].toLowerCase();
  const args = match[2]?.trim() ?? "";
  
  // Check if it's a known command
  const canonicalName = COMMAND_ALIASES[rawName];
  if (!canonicalName) {
    return null; // Unknown command, treat as regular message
  }
  
  return {
    name: canonicalName,
    args,
    raw: trimmed,
  };
}

/**
 * Check if a message is ONLY a command (no other content)
 */
export function isCommandOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  
  const command = parseCommand(trimmed);
  if (!command) return false;
  
  // If command doesn't take args, any args mean it's not command-only
  if (!COMMANDS_WITH_ARGS.has(command.name) && command.args) {
    return false;
  }
  
  return true;
}

// Help text for /help command
export const HELP_TEXT = `**Available Commands**

**Session:**
• \`/new\` or \`/reset\` - Start a new session
• \`/compact [N]\` - Keep last N messages (default 20)
• \`/stop\` - Stop the current run
• \`/status\` - Show session info

**Settings:**
• \`/model [name]\` - Show or set model
• \`/think [level]\` - Set reasoning level (off, minimal, low, medium, high, xhigh)

**Inline Directives:**
• \`/t:high message\` - Use high reasoning for this message only
• \`/m:opus message\` - Use specific model for this message only

**Info:**
• \`/help\` - Show this message`;

// Thinking level normalization
// Maps to pi-ai reasoning levels: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ThinkLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function normalizeThinkLevel(raw?: string): ThinkLevel | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().trim();
  
  switch (lower) {
    case "off":
    case "none":
    case "0":
      return "none";
    case "minimal":
    case "min":
    case "1":
      return "minimal";
    case "low":
    case "2":
      return "low";
    case "medium":
    case "med":
    case "3":
      return "medium";
    case "high":
    case "4":
      return "high";
    case "xhigh":
    case "max":
    case "5":
      return "xhigh";
    default:
      return undefined;
  }
}

// Model aliases
const MODEL_ALIASES: Record<string, { provider: string; id: string }> = {
  "sonnet": { provider: "anthropic", id: "claude-sonnet-4-20250514" },
  "opus": { provider: "anthropic", id: "claude-opus-4-20250514" },
  "haiku": { provider: "anthropic", id: "claude-3-5-haiku-20241022" },
  "gpt-4o": { provider: "openai", id: "gpt-4o" },
  "gpt-4": { provider: "openai", id: "gpt-4-turbo" },
  "o1": { provider: "openai", id: "o1" },
  "o3": { provider: "openai", id: "o3" },
  "gemini": { provider: "google", id: "gemini-2.0-flash" },
  "gemini-pro": { provider: "google", id: "gemini-1.5-pro" },
};

export function resolveModelAlias(alias: string): { provider: string; id: string } | undefined {
  const lower = alias.toLowerCase().trim();
  return MODEL_ALIASES[lower];
}

export function listModelAliases(): string[] {
  return Object.keys(MODEL_ALIASES);
}
