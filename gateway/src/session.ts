import { DurableObject } from "cloudflare:workers";
import { PersistedObject } from "./stored";
import type { ToolDefinition, MediaAttachment } from "./types";
import type { GsvConfig } from "./config";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Tool,
  Context,
  TextContent,
  ImageContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import {
  completeSimple,
  getModel,
  type Model,
  type Api,
} from "@mariozechner/pi-ai";
import {
  archivePartialMessages,
  archiveSession,
  fetchMediaFromR2,
  deleteSessionMedia,
} from "./storage";

type PendingToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

type ChatSendResult = {
  ok: boolean;
  runId: string;
};

type ToolResultInput = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type SessionSettings = {
  model?: { provider: string; id: string };
  thinkingLevel?: "none" | "low" | "medium" | "high";
  systemPrompt?: string;
  maxTokens?: number;
};

export type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number; // For daily mode (0-23)
  idleMinutes?: number; // For idle mode
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

// State stored in PersistedObject (small, no messages)
export type SessionMeta = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;

  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  settings: SessionSettings;

  resetPolicy?: ResetPolicy;
  lastResetAt?: number;

  previousSessionIds: string[];

  label?: string;
  origin?: {
    channel?: string;
    clientId?: string;
  };
};

// Stored message row (SQLite)
type StoredMessage = {
  idx: number;
  role: string;
  data: string; // JSON stringified full message
  timestamp: number;
};

export type SessionInfo = {
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens: TokenUsage;
  settings: SessionSettings;
  resetPolicy?: ResetPolicy;
  lastResetAt?: number;
  previousSessionIds: string[];
  label?: string;
};

export type SessionStats = {
  sessionKey: string;
  sessionId: string;
  messageCount: number;
  tokens: TokenUsage;
  createdAt: number;
  updatedAt: number;
  uptime: number;
};

export type ResetResult = {
  ok: boolean;
  sessionKey: string;
  oldSessionId: string;
  newSessionId: string;
  archivedMessages: number;
  archivedTo?: string;
  tokensCleared: TokenUsage;
  mediaDeleted?: number;
};

export type SessionPatchParams = {
  settings?: Partial<SessionSettings>;
  label?: string;
  resetPolicy?: ResetPolicy;
};

// LRU cache for fetched media (in-memory, survives within request but not hibernation)
const MEDIA_CACHE_MAX_SIZE = 50 * 1024 * 1024; // 50MB budget

class MediaCache {
  private cache = new Map<
    string,
    { data: string; mimeType: string; size: number }
  >();
  private totalSize = 0;

  get(r2Key: string): { data: string; mimeType: string } | undefined {
    return this.cache.get(r2Key);
  }

  set(r2Key: string, data: string, mimeType: string): void {
    const size = data.length;

    // Evict if needed
    while (
      this.totalSize + size > MEDIA_CACHE_MAX_SIZE &&
      this.cache.size > 0
    ) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const entry = this.cache.get(firstKey);
        if (entry) this.totalSize -= entry.size;
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(r2Key, { data, mimeType, size });
    this.totalSize += size;
  }

  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
  }
}

export class Session extends DurableObject<Env> {
  private static generateSessionId(): string {
    return crypto.randomUUID();
  }

  // Metadata (small, uses PersistedObject)
  meta = PersistedObject<SessionMeta>(this.ctx.storage.kv, {
    prefix: "meta:",
    defaults: {
      sessionId: Session.generateSessionId(),
      sessionKey: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      settings: {},
      previousSessionIds: [],
    },
  });

  pendingToolCalls = PersistedObject<Record<string, PendingToolCall>>(
    this.ctx.storage.kv,
    { prefix: "pendingToolCalls:" },
  );

  currentRunId: string | null = null;
  currentTools: ToolDefinition[] = [];
  currentMessageOverrides: {
    thinkLevel?: string;
    model?: { provider: string; id: string };
  } = {};

  // In-memory cache for fetched media
  private mediaCache = new MediaCache();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSqlite();
  }

  private initSqlite(): void {
    // Check if we need to migrate from old schema (content) to new schema (data)
    const hasDataColumn = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(messages)`)
      .toArray()
      .some((col) => col.name === "data");

    if (!hasDataColumn) {
      // Create new table or migrate
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages_new (
          idx INTEGER PRIMARY KEY,
          role TEXT NOT NULL,
          data TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);

      // Check if old table exists and has data
      const oldTableExists =
        this.ctx.storage.sql
          .exec<{
            name: string;
          }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`)
          .toArray().length > 0;

      if (oldTableExists) {
        // Migrate old messages - wrap content in a basic message structure
        const oldMessages = this.ctx.storage.sql
          .exec<{
            idx: number;
            role: string;
            content: string;
            timestamp: number;
          }>(`SELECT idx, role, content, timestamp FROM messages ORDER BY idx`)
          .toArray();

        for (const row of oldMessages) {
          const message = {
            role: row.role,
            content: JSON.parse(row.content),
            timestamp: row.timestamp,
          };
          this.ctx.storage.sql.exec(
            `INSERT INTO messages_new (idx, role, data, timestamp) VALUES (?, ?, ?, ?)`,
            row.idx,
            row.role,
            JSON.stringify(message),
            row.timestamp,
          );
        }

        this.ctx.storage.sql.exec(`DROP TABLE messages`);
      }

      this.ctx.storage.sql.exec(`ALTER TABLE messages_new RENAME TO messages`);
    }
  }

  // ---- Message Storage (SQLite) ----

  private getMessageCount(): number {
    const result = this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM messages`)
      .one();
    return result?.count ?? 0;
  }

  private addMessage(message: Message): void {
    const timestamp = (message as any).timestamp || Date.now();
    const messageWithTimestamp = { ...message, timestamp };
    const data = JSON.stringify(messageWithTimestamp);

    // Use NULL for idx to auto-increment via ROWID
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (idx, role, data, timestamp) VALUES ((SELECT COALESCE(MAX(idx), -1) + 1 FROM messages), ?, ?, ?)`,
      message.role,
      data,
      timestamp,
    );
  }

  private getMessages(): Message[] {
    const rows = this.ctx.storage.sql
      .exec<StoredMessage>(
        `SELECT idx, role, data, timestamp FROM messages ORDER BY idx`,
      )
      .toArray();

    return rows.map((row) => JSON.parse(row.data) as Message);
  }

  private clearMessages(): void {
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
  }

  // ---- Media Fetching ----

  /**
   * Fetch media from R2 and return base64 (with caching)
   */
  private async fetchMedia(
    r2Key: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    // Check cache first
    const cached = this.mediaCache.get(r2Key);
    if (cached) {
      console.log(`[Session] Media cache hit: ${r2Key}`);
      return cached;
    }

    // Fetch from R2
    const result = await fetchMediaFromR2(r2Key, this.env.STORAGE);
    if (result) {
      this.mediaCache.set(r2Key, result.data, result.mimeType);
    }
    return result;
  }

  /**
   * Hydrate messages with media from R2 for LLM call
   * Replaces r2Key references with actual base64 data
   */
  private async hydrateMessagesWithMedia(
    messages: Message[],
  ): Promise<Message[]> {
    const hydrated: Message[] = [];

    for (const msg of messages) {
      if (msg.role !== "user" || typeof msg.content === "string") {
        hydrated.push(msg);
        continue;
      }

      // Check if content has media references
      const content = msg.content as Array<
        | TextContent
        | ImageContent
        | { type: string; r2Key?: string; mimeType?: string }
      >;
      const hasMediaRefs = content.some(
        (block) => block.type === "image" && "r2Key" in block && block.r2Key,
      );

      if (!hasMediaRefs) {
        hydrated.push(msg);
        continue;
      }

      // Hydrate media references
      const hydratedContent: Array<TextContent | ImageContent> = [];
      for (const block of content) {
        if (block.type === "image" && "r2Key" in block && block.r2Key) {
          const media = await this.fetchMedia(block.r2Key);
          if (media) {
            hydratedContent.push({
              type: "image",
              data: media.data,
              mimeType: media.mimeType,
            });
          } else {
            // Media not found, add placeholder text
            hydratedContent.push({
              type: "text",
              text: "[Image no longer available]",
            });
          }
        } else if (block.type === "text" || block.type === "image") {
          hydratedContent.push(block as TextContent | ImageContent);
        }
      }

      hydrated.push({
        ...msg,
        content: hydratedContent,
      } as UserMessage);
    }

    return hydrated;
  }

  // ---- Main API ----

  async chatSend(
    message: string,
    runId: string,
    tools: ToolDefinition[],
    sessionKey: string,
    messageOverrides?: {
      thinkLevel?: string;
      model?: { provider: string; id: string };
    },
    media?: MediaAttachment[],
  ): Promise<ChatSendResult> {
    this.currentRunId = runId;
    this.currentTools = tools;
    this.currentMessageOverrides = messageOverrides ?? {};

    if (!this.meta.sessionKey) {
      this.meta.sessionKey = sessionKey;
    }

    if (this.shouldAutoReset()) {
      console.log(`[Session] Auto-reset triggered for ${sessionKey}`);
      await this.doReset();
    }

    // Build and store user message
    const userMessage = this.buildUserMessage(message, media);
    this.addMessage(userMessage);
    this.meta.updatedAt = Date.now();

    await this.continueAgentLoop();

    return { ok: true, runId };
  }

  /**
   * Build a UserMessage with text and optional media attachments
   * Media with r2Key are stored as references (not base64)
   */
  // TODO: add document support
  private buildUserMessage(
    text: string,
    media?: MediaAttachment[],
  ): UserMessage {
    // Separate media by type
    const images = media?.filter((m) => m.type === "image") ?? [];
    const audioWithTranscript =
      media?.filter((m) => m.type === "audio" && m.transcription) ?? [];
    const audioWithoutTranscript =
      media?.filter((m) => m.type === "audio" && !m.transcription) ?? [];

    // If no processable media, use simple string content
    if (
      images.length === 0 &&
      audioWithTranscript.length === 0 &&
      audioWithoutTranscript.length === 0
    ) {
      return {
        role: "user",
        content: text || "[Empty message]",
        timestamp: Date.now(),
      };
    }

    // Build content array
    const content: Array<
      | TextContent
      | ImageContent
      | { type: "image"; r2Key: string; mimeType: string }
    > = [];

    // Add text first (if any)
    if (text && text !== "[Media]") {
      content.push({ type: "text", text });
    }

    // Add images (as r2Key references or base64)
    for (const img of images) {
      if (img.r2Key) {
        content.push({
          type: "image",
          r2Key: img.r2Key,
          mimeType: img.mimeType,
        });
      } else if (img.data && img.mimeType) {
        content.push({
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        });
      }
    }

    // Add audio transcriptions as text
    for (const audio of audioWithTranscript) {
      const transcription = audio.transcription!;
      content.push({
        type: "text",
        text: `[Voice message transcription: ${transcription}]`,
      });
    }

    // Add placeholder for audio that failed transcription
    for (const audio of audioWithoutTranscript) {
      content.push({
        type: "text",
        text: `[Voice message received - transcription unavailable]`,
      });
    }

    // If content is still empty (shouldn't happen, but safety), add placeholder
    if (content.length === 0) {
      content.push({ type: "text", text: "[Media message]" });
    }

    return {
      role: "user",
      content: content as UserMessage["content"],
      timestamp: Date.now(),
    };
  }

  private shouldAutoReset(): boolean {
    const policy = this.meta.resetPolicy;
    if (!policy || policy.mode === "manual") return false;

    const now = Date.now();

    if (policy.mode === "daily") {
      const atHour = policy.atHour ?? 4;
      const resetTime = this.getDailyResetTime(now, atHour);
      return this.meta.updatedAt < resetTime;
    }

    if (policy.mode === "idle") {
      const idleMs = (policy.idleMinutes ?? 60) * 60_000;
      return now - this.meta.updatedAt > idleMs;
    }

    return false;
  }

  private getDailyResetTime(now: number, atHour: number): number {
    const date = new Date(now);
    date.setHours(atHour, 0, 0, 0);
    if (date.getTime() > now) {
      date.setDate(date.getDate() - 1);
    }
    return date.getTime();
  }

  async toolResult(input: ToolResultInput): Promise<{ ok: boolean }> {
    const toolCall = this.pendingToolCalls[input.callId];
    if (!toolCall) {
      console.warn(`Unknown tool call: ${input.callId}`);
      return { ok: false };
    }

    if (input.error) {
      toolCall.error = input.error;
    } else {
      toolCall.result = input.result;
    }
    this.pendingToolCalls[input.callId] = toolCall;

    if (this.allToolsResolved()) {
      this.ctx.storage.deleteAlarm();
      await this.continueAgentLoop();
    }

    return { ok: true };
  }

  private allToolsResolved(): boolean {
    for (const callId of Object.keys(this.pendingToolCalls)) {
      const call = this.pendingToolCalls[callId];
      if (call.result === undefined && !call.error) return false;
    }
    return true;
  }

  private async continueAgentLoop(): Promise<void> {
    // Process pending tool results
    const pendingCallIds = Object.keys(this.pendingToolCalls);
    if (pendingCallIds.length > 0) {
      for (const callId of pendingCallIds) {
        const call = this.pendingToolCalls[callId];
        const content = call.error
          ? `Error: ${call.error}`
          : typeof call.result === "string"
            ? call.result
            : JSON.stringify(call.result);

        const toolResultMessage: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: content }],
          isError: !!call.error,
          timestamp: Date.now(),
        };
        this.addMessage(toolResultMessage);
        delete this.pendingToolCalls[callId];
      }
    }

    let response: AssistantMessage;
    try {
      response = await this.callLlm();
    } catch (e) {
      console.error(`[Session] LLM call failed:`, e);
      await this.broadcastToClients({
        runId: this.currentRunId,
        sessionKey: this.meta.sessionKey,
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (!response.content || response.content.length === 0) {
      console.error("[Session] LLM returned empty content");
      await this.broadcastToClients({
        runId: this.currentRunId,
        sessionKey: this.meta.sessionKey,
        state: "error",
        error: "LLM returned empty response",
      });
      return;
    }

    this.addMessage(response);
    this.meta.updatedAt = Date.now();

    const toolCalls = response.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        await this.requestToolExecution({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments,
        });
      }
      this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }

    await this.broadcastToClients({
      runId: this.currentRunId,
      sessionKey: this.meta.sessionKey,
      state: "final",
      message: response,
    });
  }

  private async callLlm(): Promise<AssistantMessage> {
    const gateway = this.env.GATEWAY.get(
      this.env.GATEWAY.idFromName("singleton"),
    );
    const config: GsvConfig = await gateway.getConfig();

    const sessionSettings = this.meta.settings;

    const effectiveModel =
      this.currentMessageOverrides.model ||
      sessionSettings.model ||
      config.model;
    const effectiveSystemPrompt =
      sessionSettings.systemPrompt ||
      config.systemPrompt ||
      "You are a helpful assistant with access to tools.";

    if (this.currentMessageOverrides.model) {
      console.log(
        `[Session] Using directive model override: ${this.currentMessageOverrides.model.provider}/${this.currentMessageOverrides.model.id}`,
      );
    }
    if (this.currentMessageOverrides.thinkLevel) {
      console.log(
        `[Session] Using directive thinking level: ${this.currentMessageOverrides.thinkLevel}`,
      );
    }

    const tools: Tool[] = this.currentTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    // Get messages and hydrate media references
    const storedMessages = this.getMessages();
    const hydratedMessages =
      await this.hydrateMessagesWithMedia(storedMessages);

    const context: Context = {
      systemPrompt: effectiveSystemPrompt,
      messages: hydratedMessages,
      tools: tools.length > 0 ? tools : undefined,
    };

    console.log(
      "[Session] Messages being sent to LLM:",
      hydratedMessages.length,
    );

    let model: Model<Api> | undefined;
    const provider = effectiveModel.provider;
    const modelId = effectiveModel.id;

    if (provider === "anthropic") {
      model = getModel(
        "anthropic",
        modelId as Parameters<typeof getModel<"anthropic", any>>[1],
      );
    } else if (provider === "openai") {
      model = getModel(
        "openai",
        modelId as Parameters<typeof getModel<"openai", any>>[1],
      );
    } else if (provider === "google") {
      model = getModel(
        "google",
        modelId as Parameters<typeof getModel<"google", any>>[1],
      );
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    let apiKey: string | undefined;
    if (provider === "anthropic") {
      apiKey = config.apiKeys.anthropic;
    } else if (provider === "openai") {
      apiKey = config.apiKeys.openai;
    } else if (provider === "google") {
      apiKey = config.apiKeys.google;
    }

    if (!apiKey) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }

    const effectiveThinkLevel =
      this.currentMessageOverrides.thinkLevel || sessionSettings.thinkingLevel;

    const reasoningLevel =
      effectiveThinkLevel && effectiveThinkLevel !== "none"
        ? (effectiveThinkLevel as "low" | "medium" | "high")
        : undefined;

    console.log(
      `[Session] Calling LLM: ${provider}/${modelId}${reasoningLevel ? ` (reasoning: ${reasoningLevel})` : ""}`,
    );
    const response = await completeSimple(model, context, {
      apiKey,
      reasoning: reasoningLevel,
    });
    console.log(
      `[Session] LLM response received, content blocks: ${response.content?.length ?? 0}, stopReason: ${response.stopReason}, error: ${response.errorMessage || "none"}`,
    );
    if (response.content?.length === 0) {
      console.log(
        `[Session] Empty response details: ${JSON.stringify({ stopReason: response.stopReason, errorMessage: response.errorMessage, usage: response.usage })}`,
      );
    }

    if (response.usage) {
      const usage = response.usage;
      this.meta.inputTokens += usage.input || 0;
      this.meta.outputTokens += usage.output || 0;
      this.meta.totalTokens += usage.totalTokens || 0;
      console.log(
        `[Session] Token usage: +${usage.input}/${usage.output} (total: ${this.meta.inputTokens}/${this.meta.outputTokens})`,
      );
    }

    return response;
  }

  private async broadcastToClients(payload: {
    runId: string | null;
    sessionKey: string;
    state: "partial" | "final" | "error";
    message?: unknown;
    error?: string;
  }): Promise<void> {
    if (!this.meta.sessionKey) return;
    const gateway = this.env.GATEWAY.get(
      this.env.GATEWAY.idFromName("singleton"),
    );
    gateway.broadcastToSession(this.meta.sessionKey, payload);
  }

  private async requestToolExecution(toolCall: PendingToolCall): Promise<void> {
    if (!this.meta.sessionKey) {
      console.error("Cannot request tool: sessionKey not set");
      return;
    }

    this.pendingToolCalls[toolCall.id] = toolCall;

    const gateway = this.env.GATEWAY.get(
      this.env.GATEWAY.idFromName("singleton"),
    );
    const result = await gateway.toolRequest({
      callId: toolCall.id,
      tool: toolCall.name,
      args: toolCall.args,
      sessionKey: this.meta.sessionKey,
    });

    if (!result.ok) {
      toolCall.error = result.error || "Tool request failed";
      this.pendingToolCalls[toolCall.id] = toolCall;
    }
  }

  async alarm(): Promise<void> {
    for (const callId of Object.keys(this.pendingToolCalls)) {
      const call = this.pendingToolCalls[callId];
      if (call.result === undefined && !call.error) {
        call.error = "Tool execution timed out";
        this.pendingToolCalls[callId] = call;
      }
    }
    await this.continueAgentLoop();
  }

  private async doReset(): Promise<ResetResult> {
    const oldSessionId = this.meta.sessionId;
    const sessionKey = this.meta.sessionKey;
    const messageCount = this.getMessageCount();
    const tokensCleared: TokenUsage = {
      input: this.meta.inputTokens,
      output: this.meta.outputTokens,
      total: this.meta.totalTokens,
    };

    let archivedTo: string | undefined;
    let mediaDeleted = 0;

    // Archive messages if any
    if (messageCount > 0 && sessionKey) {
      try {
        const messages = this.getMessages();
        archivedTo = await archiveSession(
          this.env.STORAGE,
          sessionKey,
          oldSessionId,
          messages,
          tokensCleared,
        );
        console.log(
          `[Session] Archived ${messageCount} messages to ${archivedTo}`,
        );
      } catch (e) {
        console.error(`[Session] Failed to archive session: ${e}`);
      }
    }

    // Delete media from R2
    if (sessionKey) {
      try {
        mediaDeleted = await deleteSessionMedia(this.env.STORAGE, sessionKey);
      } catch (e) {
        console.error(`[Session] Failed to delete media: ${e}`);
      }
    }

    // Clear messages from SQLite
    this.clearMessages();

    // Clear media cache
    this.mediaCache.clear();

    // Update metadata
    const newSessionId = Session.generateSessionId();

    if (oldSessionId) {
      this.meta.previousSessionIds = [
        ...this.meta.previousSessionIds,
        oldSessionId,
      ];
    }

    this.meta.sessionId = newSessionId;
    this.meta.inputTokens = 0;
    this.meta.outputTokens = 0;
    this.meta.totalTokens = 0;
    this.meta.lastResetAt = Date.now();
    this.meta.updatedAt = Date.now();

    for (const callId of Object.keys(this.pendingToolCalls)) {
      delete this.pendingToolCalls[callId];
    }

    return {
      ok: true,
      sessionKey: sessionKey || "",
      oldSessionId,
      newSessionId,
      archivedMessages: messageCount,
      archivedTo,
      tokensCleared,
      mediaDeleted,
    };
  }

  async reset(): Promise<ResetResult> {
    return this.doReset();
  }

  async get(): Promise<SessionInfo> {
    return {
      sessionId: this.meta.sessionId,
      sessionKey: this.meta.sessionKey,
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      messageCount: this.getMessageCount(),
      tokens: {
        input: this.meta.inputTokens,
        output: this.meta.outputTokens,
        total: this.meta.totalTokens,
      },
      settings: { ...this.meta.settings },
      resetPolicy: this.meta.resetPolicy
        ? { ...this.meta.resetPolicy }
        : undefined,
      lastResetAt: this.meta.lastResetAt,
      previousSessionIds: [...this.meta.previousSessionIds],
      label: this.meta.label,
    };
  }

  async stats(): Promise<SessionStats> {
    const now = Date.now();
    return {
      sessionKey: this.meta.sessionKey,
      sessionId: this.meta.sessionId,
      messageCount: this.getMessageCount(),
      tokens: {
        input: this.meta.inputTokens,
        output: this.meta.outputTokens,
        total: this.meta.totalTokens,
      },
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      uptime: now - this.meta.createdAt,
    };
  }

  async patch(params: SessionPatchParams): Promise<{ ok: boolean }> {
    if (params.settings) {
      this.meta.settings = { ...this.meta.settings, ...params.settings };
    }
    if (params.label !== undefined) {
      this.meta.label = params.label;
    }
    if (params.resetPolicy !== undefined) {
      this.meta.resetPolicy = params.resetPolicy;
    }
    this.meta.updatedAt = Date.now();
    return { ok: true };
  }

  async compact(keepMessages: number = 20): Promise<{
    ok: boolean;
    trimmedMessages: number;
    keptMessages: number;
    archivedTo?: string;
  }> {
    const totalMessages = this.getMessageCount();
    if (totalMessages <= keepMessages) {
      return {
        ok: true,
        trimmedMessages: 0,
        keptMessages: totalMessages,
      };
    }

    const trimCount = totalMessages - keepMessages;
    const messages = this.getMessages();
    const messagesToArchive = messages.slice(0, trimCount);
    const messagesToKeep = messages.slice(trimCount);

    let archivedTo: string | undefined;
    if (messagesToArchive.length > 0 && this.meta.sessionKey) {
      try {
        const partNumber = Date.now();
        archivedTo = await archivePartialMessages(
          this.env.STORAGE,
          this.meta.sessionKey,
          this.meta.sessionId,
          messagesToArchive,
          partNumber,
        );
        console.log(
          `[Session] Compacted: archived ${trimCount} messages to ${archivedTo}`,
        );
      } catch (e) {
        console.error(`[Session] Failed to archive compacted messages: ${e}`);
      }
    }

    // Rewrite messages table with only kept messages
    this.clearMessages();
    for (const msg of messagesToKeep) {
      this.addMessage(msg);
    }
    this.meta.updatedAt = Date.now();

    return {
      ok: true,
      trimmedMessages: trimCount,
      keptMessages: this.getMessageCount(),
      archivedTo,
    };
  }

  async history(): Promise<{
    sessionKey: string;
    currentSessionId: string;
    previousSessionIds: string[];
  }> {
    return {
      sessionKey: this.meta.sessionKey,
      currentSessionId: this.meta.sessionId,
      previousSessionIds: [...this.meta.previousSessionIds],
    };
  }

  async preview(limit?: number): Promise<{
    sessionKey: string;
    sessionId: string;
    messageCount: number;
    messages: Message[];
  }> {
    const messages = this.getMessages();
    const limitedMessages = limit ? messages.slice(-limit) : messages;

    return {
      sessionKey: this.meta.sessionKey,
      sessionId: this.meta.sessionId,
      messageCount: this.getMessageCount(),
      messages: JSON.parse(JSON.stringify(limitedMessages)),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/state") {
      return Response.json({
        sessionKey: this.meta.sessionKey,
        sessionId: this.meta.sessionId,
        messageCount: this.getMessageCount(),
        pendingToolCalls: Object.keys(this.pendingToolCalls).length,
        tokens: {
          input: this.meta.inputTokens,
          output: this.meta.outputTokens,
          total: this.meta.totalTokens,
        },
      });
    }

    return new Response("Use RPC methods", { status: 400 });
  }
}
