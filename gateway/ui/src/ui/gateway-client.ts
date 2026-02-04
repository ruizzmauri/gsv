/**
 * Gateway WebSocket Client
 * 
 * Handles connection to GSV Gateway via WebSocket.
 * Matches the protocol used by the Rust CLI.
 */

import type { Frame, RequestFrame, ResponseFrame, EventFrame, ToolDefinition } from "./types";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  onStateChange?: (state: ConnectionState) => void;
  onEvent?: (event: EventFrame) => void;
  onError?: (error: string) => void;
};

type PendingRequest = {
  resolve: (response: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  private _state: ConnectionState = "disconnected";
  private options: GatewayClientOptions;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState) {
    this._state = state;
    this.options.onStateChange?.(state);
  }

  /**
   * Start connection to Gateway
   */
  start(): void {
    if (this.ws) return;
    this.connect();
  }

  /**
   * Stop connection
   */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  private connect(): void {
    this.setState("connecting");
    
    try {
      this.ws = new WebSocket(this.options.url);
      
      this.ws.onopen = () => {
        console.log("[GatewayClient] Connected");
        this.reconnectAttempts = 0;
        this.handshake();
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.ws.onclose = () => {
        console.log("[GatewayClient] Disconnected");
        this.ws = null;
        this.setState("disconnected");
        this.scheduleReconnect();
      };
      
      this.ws.onerror = (error) => {
        console.error("[GatewayClient] Error:", error);
        this.options.onError?.("Connection failed");
      };
    } catch (e) {
      console.error("[GatewayClient] Failed to connect:", e);
      this.options.onError?.(`Failed to connect: ${e}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    console.log(`[GatewayClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handshake(): Promise<void> {
    try {
      const response = await this.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: `web-${crypto.randomUUID().slice(0, 8)}`,
          version: "0.1.0",
          platform: "web",
          mode: "client",
        },
        auth: this.options.token ? { token: this.options.token } : undefined,
      });
      
      if (!response.ok) {
        const errorMsg = response.error?.message || "Handshake failed";
        this.options.onError?.(errorMsg);
        throw new Error(errorMsg);
      }
      
      console.log("[GatewayClient] Handshake complete");
      this.setState("connected");
    } catch (e) {
      console.error("[GatewayClient] Handshake failed:", e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.options.onError?.(errorMsg);
      this.ws?.close();
    }
  }

  private handleMessage(data: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(data);
    } catch {
      console.error("[GatewayClient] Invalid JSON:", data);
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(frame.id);
        pending.resolve(frame);
      }
    } else if (frame.type === "evt") {
      this.options.onEvent?.(frame);
    }
  }

  /**
   * Send a request and wait for response
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<ResponseFrame & { payload?: T }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = crypto.randomUUID();
    const frame: RequestFrame = {
      type: "req",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (r: ResponseFrame) => void, reject, timeout });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  // ---- Convenience methods ----

  async chatSend(sessionKey: string, message: string, runId?: string): Promise<ResponseFrame> {
    return this.request("chat.send", {
      sessionKey,
      message,
      runId: runId || crypto.randomUUID(),
    });
  }

  async sessionsList(limit = 100, offset = 0): Promise<ResponseFrame> {
    return this.request("sessions.list", { limit, offset });
  }

  async sessionGet(sessionKey: string): Promise<ResponseFrame> {
    return this.request("session.get", { sessionKey });
  }

  async sessionStats(sessionKey: string): Promise<ResponseFrame> {
    return this.request("session.stats", { sessionKey });
  }

  async sessionReset(sessionKey: string): Promise<ResponseFrame> {
    return this.request("session.reset", { sessionKey });
  }

  async sessionCompact(sessionKey: string, keepMessages = 20): Promise<ResponseFrame> {
    return this.request("session.compact", { sessionKey, keepMessages });
  }

  async sessionPreview(sessionKey: string, limit = 50): Promise<ResponseFrame> {
    return this.request("session.preview", { sessionKey, limit });
  }

  async toolsList(): Promise<ResponseFrame> {
    return this.request("tools.list");
  }

  async toolInvoke(tool: string, args: Record<string, unknown>): Promise<ResponseFrame> {
    return this.request("tool.invoke", { tool, args }, 60000);
  }

  async configGet(path?: string): Promise<ResponseFrame> {
    return this.request("config.get", path ? { path } : undefined);
  }

  async configSet(path: string, value: unknown): Promise<ResponseFrame> {
    return this.request("config.set", { path, value });
  }

  async channelsList(): Promise<ResponseFrame> {
    return this.request("channels.list");
  }

  async channelStart(channel: string, accountId = "default", config?: Record<string, unknown>): Promise<ResponseFrame> {
    return this.request("channel.start", { channel, accountId, config });
  }

  async channelStop(channel: string, accountId = "default"): Promise<ResponseFrame> {
    return this.request("channel.stop", { channel, accountId });
  }

  async channelStatus(channel: string, accountId = "default"): Promise<ResponseFrame> {
    return this.request("channel.status", { channel, accountId });
  }
}
