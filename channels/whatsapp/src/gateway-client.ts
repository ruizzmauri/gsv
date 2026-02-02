/**
 * WebSocket client for connecting to GSV Gateway as a channel
 */

import type {
  Frame,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  ChannelInboundParams,
  ChannelOutboundPayload,
  ChannelTypingPayload,
} from "./types";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  accountId: string;
  onOutbound: (payload: ChannelOutboundPayload) => Promise<void>;
  onTyping?: (payload: ChannelTypingPayload) => Promise<void>;
  onDisconnect?: () => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, {
    resolve: (res: ResponseFrame) => void;
    reject: (err: Error) => void;
  }>();
  private options: GatewayClientOptions;
  private connected = false;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.ws = ws;

      ws.addEventListener("open", async () => {
        try {
          await this.handshake();
          this.connected = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener("close", () => {
        this.connected = false;
        this.options.onDisconnect?.();
      });

      ws.addEventListener("error", () => {
        reject(new Error("WebSocket connection failed"));
      });
    });
  }

  private async handshake(): Promise<void> {
    const res = await this.request("connect", {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: this.options.accountId,
        version: "0.1.0",
        platform: "cloudflare-workers",
        mode: "channel",
        channel: "whatsapp",
        accountId: this.options.accountId,
      },
      auth: this.options.token ? { token: this.options.token } : undefined,
    });

    if (!res.ok) {
      throw new Error(`Handshake failed: ${res.error?.message}`);
    }
  }

  private handleMessage(data: string): void {
    try {
      const frame = JSON.parse(data) as Frame;

      if (frame.type === "res") {
        const pending = this.pendingRequests.get(frame.id);
        if (pending) {
          this.pendingRequests.delete(frame.id);
          pending.resolve(frame);
        }
      } else if (frame.type === "evt") {
        this.handleEvent(frame);
      }
    } catch {}
  }

  private handleEvent(frame: EventFrame): void {
    if (frame.event === "channel.outbound") {
      const payload = frame.payload as ChannelOutboundPayload;
      this.options.onOutbound(payload).catch(() => {});
    } else if (frame.event === "channel.typing") {
      const payload = frame.payload as ChannelTypingPayload;
      this.options.onTyping?.(payload).catch(() => {});
    }
  }

  async request(method: string, params?: unknown): Promise<ResponseFrame> {
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
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(frame));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  async sendInbound(params: ChannelInboundParams): Promise<void> {
    const res = await this.request("channel.inbound", params);
    if (!res.ok) {
      throw new Error(`Failed to send inbound: ${res.error?.message}`);
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
