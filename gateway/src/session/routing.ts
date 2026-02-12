export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_ACCOUNT_ID = "default";

export type DmScope =
  | "main"
  | "per-peer"
  | "per-channel-peer"
  | "per-account-channel-peer";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_ID_CHARS_RE = /[^a-z0-9_-]+/gi;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const INVALID_TOKEN_CHARS_RE = /[^a-z0-9+\-_@.]+/gi;

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_ACCOUNT_ID
  );
}

function normalizeToken(
  value: string | undefined | null,
  fallback: string = "unknown",
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.toLowerCase().replace(INVALID_TOKEN_CHARS_RE, "_");
}

export function resolveAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | null;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

export function resolveAgentIdFromSessionKey(
  sessionKey: string | undefined | null,
  fallback: string = DEFAULT_AGENT_ID,
): string {
  const raw = (sessionKey ?? "").trim();
  if (!raw.startsWith("agent:")) {
    return normalizeAgentId(fallback);
  }

  const parts = raw.split(":");
  if (parts.length < 2 || !parts[1]) {
    return normalizeAgentId(fallback);
  }

  return normalizeAgentId(parts[1]);
}

export function canonicalizeMainSessionAlias(params: {
  agentId: string;
  sessionKey: string;
  mainKey?: string | null;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return raw;
  }

  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  const canonical = resolveAgentMainSessionKey({ agentId, mainKey });
  const canonicalAlias = resolveAgentMainSessionKey({
    agentId,
    mainKey: DEFAULT_MAIN_KEY,
  });

  if (raw === DEFAULT_MAIN_KEY || raw === mainKey) {
    return canonical;
  }

  if (raw === canonical || raw === canonicalAlias) {
    return canonical;
  }

  if (raw.startsWith("agent:")) {
    const parts = raw.split(":");
    if (parts.length >= 3) {
      const rawAgent = normalizeAgentId(parts[1]);
      const rest = parts.slice(2).join(":").trim().toLowerCase();
      if (rawAgent === agentId && (rest === DEFAULT_MAIN_KEY || rest === mainKey)) {
        return canonical;
      }
    }
  }

  return raw;
}

export function isMainSessionKey(params: {
  sessionKey: string;
  mainKey?: string | null;
  dmScope?: DmScope;
}): boolean {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return false;
  }

  const mainKey = normalizeMainKey(params.mainKey);
  if (raw === DEFAULT_MAIN_KEY || raw === mainKey) {
    return true;
  }

  if (!raw.startsWith("agent:")) {
    return false;
  }

  const parts = raw.split(":");
  if (parts.length < 3) {
    return false;
  }

  const agentId = normalizeAgentId(parts[1]);
  const rest = parts.slice(2);

  if (rest.length === 1) {
    const key = rest[0].toLowerCase();
    return key === mainKey || key === DEFAULT_MAIN_KEY;
  }

  const peerKind = rest.length >= 2 ? rest[1] : "";

  if (params.dmScope === "main" && peerKind === "dm") {
    return true;
  }

  const canonical = resolveAgentMainSessionKey({ agentId, mainKey });
  const alias = resolveAgentMainSessionKey({ agentId, mainKey: DEFAULT_MAIN_KEY });
  return raw === canonical || raw === alias;
}

export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: {
    kind: string;
    id: string;
  };
  dmScope?: DmScope;
  mainKey?: string | null;
  linkedIdentity?: string | null;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const channel = normalizeToken(params.channel);
  const peerKind = normalizeToken(params.peer.kind, "dm");
  const dmScope = params.dmScope ?? "main";
  const peerId = normalizeToken(params.linkedIdentity ?? params.peer.id);

  if (peerKind === "dm") {
    if (dmScope === "main") {
      return resolveAgentMainSessionKey({ agentId, mainKey: params.mainKey });
    }

    if (dmScope === "per-peer") {
      return `agent:${agentId}:dm:${peerId}`;
    }

    if (dmScope === "per-channel-peer") {
      return `agent:${agentId}:${channel}:dm:${peerId}`;
    }

    const accountId = normalizeAccountId(params.accountId);
    return `agent:${agentId}:${channel}:${accountId}:dm:${peerId}`;
  }

  return `agent:${agentId}:${channel}:${peerKind}:${peerId}`;
}
