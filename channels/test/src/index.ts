/**
 * Test Channel Worker
 * 
 * A minimal channel implementation for e2e testing the Service Binding RPC flow.
 * This channel doesn't connect to any external service - it's purely for testing
 * the Gateway ↔ Channel communication pattern.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

// ============================================================================
// Types (minimal subset for testing)
// ============================================================================

type ChannelPeer = {
  kind: "dm" | "group" | "channel" | "thread";
  id: string;
  name?: string;
};

type ChannelSender = {
  id: string;
  name?: string;
};

type ChannelMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string;
  url?: string;
};

type ChannelInboundMessage = {
  messageId: string;
  peer: ChannelPeer;
  sender?: ChannelSender;
  text: string;
  media?: ChannelMedia[];
  timestamp?: number;
};

type ChannelOutboundMessage = {
  peer: ChannelPeer;
  text: string;
  replyToId?: string;
};

type ChannelAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  error?: string;
};

type ChannelCapabilities = {
  chatTypes: Array<"dm" | "group" | "channel" | "thread">;
  media: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  editing: boolean;
  deletion: boolean;
};

type StartResult = { ok: true } | { ok: false; error: string };
type StopResult = { ok: true } | { ok: false; error: string };
type SendResult = { ok: true; messageId?: string } | { ok: false; error: string };

// Gateway RPC interface
interface GatewayRpc {
  channelInbound(
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ): Promise<{ ok: boolean; sessionKey?: string; error?: string }>;
  
  channelStatusChanged(
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ): Promise<void>;
}

interface Env {
  GATEWAY: Fetcher & GatewayRpc;
}

// ============================================================================
// Test Channel State (in-memory for simplicity)
// ============================================================================

// Track "accounts" and their state
const accounts = new Map<string, {
  connected: boolean;
  messages: Array<{ direction: "in" | "out"; message: ChannelOutboundMessage | ChannelInboundMessage }>;
}>();

// ============================================================================
// Test Channel WorkerEntrypoint
// ============================================================================

export class TestChannel extends WorkerEntrypoint<Env> {
  readonly channelId = "test";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
  };

  /**
   * Start the test channel for an account.
   */
  async start(accountId: string, _config: Record<string, unknown>): Promise<StartResult> {
    accounts.set(accountId, { connected: true, messages: [] });
    
    // Notify Gateway
    await this.env.GATEWAY.channelStatusChanged("test", accountId, {
      accountId,
      connected: true,
      authenticated: true,
      mode: "test",
    });
    
    return { ok: true };
  }

  /**
   * Stop the test channel for an account.
   */
  async stop(accountId: string): Promise<StopResult> {
    const account = accounts.get(accountId);
    if (account) {
      account.connected = false;
    }
    
    await this.env.GATEWAY.channelStatusChanged("test", accountId, {
      accountId,
      connected: false,
      authenticated: false,
    });
    
    return { ok: true };
  }

  /**
   * Get status for accounts.
   */
  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (accountId) {
      const account = accounts.get(accountId);
      return [{
        accountId,
        connected: account?.connected ?? false,
        authenticated: account?.connected ?? false,
        mode: "test",
      }];
    }
    
    return Array.from(accounts.entries()).map(([id, acc]) => ({
      accountId: id,
      connected: acc.connected,
      authenticated: acc.connected,
      mode: "test",
    }));
  }

  /**
   * Send a message (Gateway → Channel).
   * For testing, we just record it.
   */
  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
    const account = accounts.get(accountId);
    if (!account?.connected) {
      return { ok: false, error: "Account not connected" };
    }
    
    account.messages.push({ direction: "out", message });
    
    const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[TestChannel] Sent to ${message.peer.id}: ${message.text}`);
    
    return { ok: true, messageId };
  }

  /**
   * Typing indicator (no-op for test).
   */
  async setTyping(_accountId: string, _peer: ChannelPeer, _typing: boolean): Promise<void> {
    // No-op
  }

  // =========================================================================
  // Test-only methods (for e2e tests to simulate inbound messages)
  // =========================================================================

  /**
   * Simulate an inbound message from a "user" to test the full flow.
   * This is called by tests to trigger Gateway processing.
   */
  async simulateInbound(
    accountId: string,
    peer: ChannelPeer,
    text: string,
    options?: { sender?: ChannelSender; media?: ChannelMedia[] }
  ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> {
    const account = accounts.get(accountId);
    if (!account?.connected) {
      return { ok: false, error: "Account not connected" };
    }

    const message: ChannelInboundMessage = {
      messageId: `test-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      peer,
      sender: options?.sender,
      text,
      media: options?.media,
      timestamp: Date.now(),
    };

    account.messages.push({ direction: "in", message });

    // Send to Gateway via Service Binding RPC
    console.log(`[TestChannel] Simulating inbound from ${peer.id}: ${text}`);
    return await this.env.GATEWAY.channelInbound("test", accountId, message);
  }

  /**
   * Get recorded messages for an account (for test assertions).
   */
  async getMessages(accountId: string): Promise<Array<{ direction: "in" | "out"; message: unknown }>> {
    return accounts.get(accountId)?.messages ?? [];
  }

  /**
   * Clear all state (for test cleanup).
   */
  async reset(): Promise<void> {
    accounts.clear();
  }
}

// ============================================================================
// HTTP Handler (for health checks)
// ============================================================================

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-test",
        status: "ok",
        accounts: Array.from(accounts.keys()),
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },
};
