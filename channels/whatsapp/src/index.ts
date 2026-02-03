/**
 * GSV WhatsApp Channel Worker
 * 
 * Implements ChannelWorkerInterface for Service Binding RPC with Gateway.
 * Each WhatsApp account is managed by a separate Durable Object instance.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

// Polyfill for Node.js timer methods not available in Workers
// Baileys uses setInterval(...).unref() which doesn't exist in workerd
class TimerRef {
  constructor(public id: number) {}
  unref() { return this; }
  ref() { return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

const _setInterval = globalThis.setInterval;
const _setTimeout = globalThis.setTimeout;
const _clearInterval = globalThis.clearInterval;
const _clearTimeout = globalThis.clearTimeout;

(globalThis as any).setInterval = function(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const id = _setInterval(callback as any, ms, ...args);
  return new TimerRef(id as unknown as number);
};

(globalThis as any).setTimeout = function(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const id = _setTimeout(callback as any, ms, ...args);
  return new TimerRef(id as unknown as number);
};

(globalThis as any).clearInterval = function(id: unknown) {
  const actualId = id instanceof TimerRef ? id.id : id;
  return _clearInterval(actualId as any);
};

(globalThis as any).clearTimeout = function(id: unknown) {
  const actualId = id instanceof TimerRef ? id.id : id;
  return _clearTimeout(actualId as any);
};

export { WhatsAppAccount } from "./whatsapp-account";

import type {
  ChannelWorkerInterface,
  ChannelCapabilities,
  ChannelAccountStatus,
  ChannelOutboundMessage,
  ChannelPeer,
  StartResult,
  StopResult,
  SendResult,
  LoginResult,
  LogoutResult,
} from "./channel-types";

// Re-export types
export type * from "./channel-types";

// Gateway RPC interface (via Service Binding to GatewayEntrypoint)
interface GatewayRpc {
  channelInbound(
    channelId: string,
    accountId: string,
    message: import("./channel-types").ChannelInboundMessage,
  ): Promise<{ ok: boolean; sessionKey?: string; error?: string }>;
  
  channelStatusChanged(
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ): Promise<void>;
}

interface Env {
  WHATSAPP_ACCOUNT: DurableObjectNamespace;
  // Gateway service binding for RPC (typed as Fetcher with RPC methods)
  GATEWAY: Fetcher & GatewayRpc;
  AUTH_TOKEN?: string;
}

/**
 * WhatsApp Channel WorkerEntrypoint
 * 
 * Gateway calls these methods via Service Binding RPC.
 */
export class WhatsAppChannel extends WorkerEntrypoint<Env> implements ChannelWorkerInterface {
  readonly channelId = "whatsapp";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
    qrLogin: true,
  };

  /**
   * Start WhatsApp connection for an account.
   * This wakes the DO and initiates connection if auth exists.
   */
  async start(accountId: string, _config: Record<string, unknown>): Promise<StartResult> {
    try {
      const stub = this.getAccountStub(accountId);
      const response = await stub.fetch(new Request("http://internal/wake", { method: "POST" }));
      const result = await response.json() as { success: boolean; message?: string };
      
      if (result.success) {
        return { ok: true };
      }
      return { ok: false, error: result.message || "Failed to start" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Stop WhatsApp connection for an account.
   */
  async stop(accountId: string): Promise<StopResult> {
    try {
      const stub = this.getAccountStub(accountId);
      const response = await stub.fetch(new Request("http://internal/stop", { method: "POST" }));
      const result = await response.json() as { success: boolean; message?: string };
      
      if (result.success) {
        return { ok: true };
      }
      return { ok: false, error: result.message || "Failed to stop" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Get status for one or all accounts.
   */
  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (accountId) {
      try {
        const stub = this.getAccountStub(accountId);
        const response = await stub.fetch(new Request("http://internal/status"));
        const status = await response.json() as {
          accountId: string;
          connected: boolean;
          selfJid?: string;
          gatewayConnected?: boolean;
        };
        
        return [{
          accountId: status.accountId,
          connected: status.connected,
          authenticated: !!status.selfJid,
          mode: "websocket",
          extra: { selfJid: status.selfJid },
        }];
      } catch (e) {
        return [{
          accountId,
          connected: false,
          authenticated: false,
          error: e instanceof Error ? e.message : String(e),
        }];
      }
    }
    
    // Can't list all accounts without tracking - return empty
    return [];
  }

  /**
   * Send a message via WhatsApp.
   */
  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
    try {
      const stub = this.getAccountStub(accountId);
      const response = await stub.fetch(new Request("http://internal/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      }));
      
      if (!response.ok) {
        const error = await response.text();
        return { ok: false, error };
      }
      
      const result = await response.json() as { messageId?: string };
      return { ok: true, messageId: result.messageId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Send typing indicator.
   */
  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    try {
      const stub = this.getAccountStub(accountId);
      await stub.fetch(new Request("http://internal/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer, typing }),
      }));
    } catch {
      // Typing indicators are best-effort
    }
  }

  /**
   * Start login flow - returns QR code if needed.
   */
  async login(accountId: string, options?: { force?: boolean }): Promise<LoginResult> {
    try {
      const stub = this.getAccountStub(accountId);
      const url = new URL("http://internal/login");
      if (options?.force) url.searchParams.set("force", "true");
      
      const response = await stub.fetch(new Request(url.toString(), { method: "POST" }));
      const result = await response.json() as {
        connected?: boolean;
        qr?: string;
        message?: string;
      };
      
      if (result.connected) {
        return { ok: true, message: "Already connected" };
      }
      
      if (result.qr) {
        // Convert QR string to data URL
        const QRCode = await import("qrcode");
        const qrDataUrl = await QRCode.toDataURL(result.qr, { width: 300 });
        return { ok: true, qrDataUrl, message: "Scan QR code with WhatsApp" };
      }
      
      return { ok: false, error: result.message || "Failed to get QR code" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Logout and clear credentials.
   */
  async logout(accountId: string): Promise<LogoutResult> {
    try {
      const stub = this.getAccountStub(accountId);
      const response = await stub.fetch(new Request("http://internal/logout", { method: "POST" }));
      const result = await response.json() as { success: boolean; message?: string };
      
      if (result.success) {
        return { ok: true };
      }
      return { ok: false, error: result.message || "Failed to logout" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Get DO stub for an account.
   */
  private getAccountStub(accountId: string) {
    const id = this.env.WHATSAPP_ACCOUNT.idFromName(accountId);
    return this.env.WHATSAPP_ACCOUNT.get(id);
  }
}

// ============================================================================
// HTTP Handler (for management API / backwards compatibility)
// ============================================================================

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function checkAuth(request: Request, env: Env): Response | null {
  if (!env.AUTH_TOKEN) return null;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return Response.json(
      { error: "Missing Authorization header" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return Response.json(
      { error: "Invalid Authorization header format" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  if (!timingSafeEqual(match[1], env.AUTH_TOKEN)) {
    return Response.json({ error: "Invalid token" }, { status: 403 });
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json({
        service: "gsv-channel-whatsapp",
        status: "ok",
        version: "2.0.0",
        interface: "ChannelWorkerInterface",
      });
    }

    // Auth required for all other routes
    const authError = checkAuth(request, env);
    if (authError) return authError;

    // Route: /account/:accountId/...
    const accountMatch = path.match(/^\/account\/([^\/]+)(\/.*)?$/);
    if (accountMatch) {
      const accountId = accountMatch[1];
      const subPath = accountMatch[2] || "/status";
      
      const id = env.WHATSAPP_ACCOUNT.idFromName(accountId);
      const stub = env.WHATSAPP_ACCOUNT.get(id);
      
      const doUrl = new URL(request.url);
      doUrl.pathname = subPath;
      
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("Not Found", { status: 404 });
  },
};
