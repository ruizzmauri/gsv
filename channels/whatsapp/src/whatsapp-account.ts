/**
 * WhatsApp Account Durable Object
 * 
 * Manages a single WhatsApp account connection:
 * - Stores auth credentials in DO storage
 * - Maintains WebSocket connection to WhatsApp via Baileys
 * - Sends messages to Gateway via Service Binding RPC
 * - Receives outbound messages via HTTP endpoint
 */

import { DurableObject } from "cloudflare:workers";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";
import {
  getMediaKeys,
  getUrlFromDirectPath,
} from "@whiskeysockets/baileys/lib/Utils/messages-media";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import type {
  WhatsAppAccountState,
  PeerInfo,
  MediaAttachment,
} from "./types";
import type {
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelAccountStatus,
} from "./channel-types";

// Gateway RPC interface (via Service Binding to GatewayEntrypoint)
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
  // Gateway service binding for RPC
  GATEWAY: Fetcher & GatewayRpc;
}

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private state: WhatsAppAccountState = {
    accountId: "",
    connected: false,
  };
  private qrCode: string | null = null;
  private qrResolvers: Array<(qr: string) => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state.accountId = ctx.id.toString();
  }

  /**
   * HTTP fetch handler - internal API for WhatsAppChannel entrypoint
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url, request.method === "POST");
        case "/logout":
          return await this.handleLogout();
        case "/stop":
          return await this.handleStop();
        case "/wake":
          return await this.handleWake();
        case "/send":
          return await this.handleSend(request);
        case "/typing":
          return await this.handleTyping(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      console.error(`[WhatsAppAccount] Error handling ${path}:`, e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private handleStatus(): Response {
    return Response.json({
      accountId: this.state.accountId,
      connected: this.state.connected,
      selfJid: this.state.selfJid,
      selfE164: this.state.selfE164,
      lastConnectedAt: this.state.lastConnectedAt,
      lastMessageAt: this.state.lastMessageAt,
      hasSocket: this.sock !== null,
    });
  }

  private async handleLogin(url: URL, isPost: boolean): Promise<Response> {
    // If already connected, return success
    if (this.state.connected && this.sock) {
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Start the socket if not running
    if (!this.sock) {
      await this.startSocket();
    }

    // Wait for QR code or connection
    const result = await this.waitForQrOrConnection(60000);
    
    if (result.connected) {
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      return Response.json({ 
        connected: false, 
        qr: result.qr,
        message: "Scan QR code with WhatsApp" 
      });
    }

    return Response.json({ 
      connected: false, 
      message: "Failed to get QR code" 
    }, { status: 500 });
  }

  private async handleLogout(): Promise<Response> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    await clearAuthState(this.ctx.storage);
    
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    return Response.json({ success: true, message: "Logged out" });
  }

  private async handleStop(): Promise<Response> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();

    // Notify Gateway of status change
    await this.notifyGatewayStatus();

    return Response.json({ success: true, message: "Stopped" });
  }

  private async handleWake(): Promise<Response> {
    const actions: string[] = [];
    
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (!hasAuth) {
      return Response.json({ 
        success: false, 
        message: "No auth credentials. Call /login first.",
        actions,
      }, { status: 400 });
    }

    // Check WhatsApp connection
    if (!this.sock || !this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: Reconnecting...`);
      actions.push("reconnecting_whatsapp");
      await this.startSocket();
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      actions.push("whatsapp_already_connected");
    }

    return Response.json({
      success: true,
      message: "Wake complete",
      actions,
      status: {
        whatsappConnected: this.state.connected,
        selfJid: this.state.selfJid,
      },
    });
  }

  /**
   * Handle outbound message from Gateway (via WorkerEntrypoint)
   */
  private async handleSend(request: Request): Promise<Response> {
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const message = await request.json() as ChannelOutboundMessage;
    
    // Convert peer ID to WhatsApp JID format
    let jid = message.peer.id;
    if (jid.startsWith("+") && !jid.includes("@")) {
      jid = `${jid.slice(1)}@s.whatsapp.net`;
    }

    try {
      const sent = await this.sock.sendMessage(jid, { text: message.text });
      console.log(`[WA] Sent to ${jid}: "${message.text.substring(0, 50)}..."`);
      return Response.json({ messageId: sent?.key?.id });
    } catch (e) {
      console.error(`[WA] Send failed:`, e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  /**
   * Handle typing indicator from Gateway
   */
  private async handleTyping(request: Request): Promise<Response> {
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const { peer, typing } = await request.json() as { peer: ChannelPeer; typing: boolean };
    
    let jid = peer.id;
    if (jid.startsWith("+") && !jid.includes("@")) {
      jid = `${jid.slice(1)}@s.whatsapp.net`;
    }

    try {
      const presence = typing ? "composing" : "paused";
      await this.sock.sendPresenceUpdate(presence, jid);
      return Response.json({ ok: true });
    } catch (e) {
      // Typing is best-effort
      return Response.json({ ok: true });
    }
  }

  private async startSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useDOAuthState(this.ctx.storage);
    const { version } = await fetchLatestBaileysVersion();

    const noopLogger = { 
      info: () => {}, warn: () => {}, error: () => {}, 
      debug: () => {}, trace: () => {}, child: () => noopLogger 
    } as any;
    
    this.sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      version,
      printQRInTerminal: false,
      browser: ["GSV WhatsApp", "Channel", "2.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: noopLogger,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on("messages.upsert", (m) => {
      this.handleMessagesUpsert(m).catch((e) => {
        console.error(`[WA] handleMessagesUpsert error:`, e);
      });
    });
  }

  private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      for (const resolve of this.qrResolvers) {
        resolve(qr);
      }
      this.qrResolvers = [];
    }

    if (connection === "open") {
      this.state.connected = true;
      this.state.lastConnectedAt = Date.now();
      this.state.selfJid = this.sock?.user?.id;
      
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      // Notify Gateway of status change
      this.notifyGatewayStatus().catch(console.error);
      this.scheduleKeepAlive();
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      
      console.log(`[WA] Connection closed. statusCode=${statusCode}, isLoggedOut=${isLoggedOut}`);
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();

      // Notify Gateway
      this.notifyGatewayStatus().catch(console.error);

      if (isLoggedOut) {
        clearAuthState(this.ctx.storage);
      } else {
        this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;

      const hasImage = !!msg.message?.imageMessage;
      const hasVideo = !!msg.message?.videoMessage;
      const hasAudio = !!msg.message?.audioMessage;
      const hasDocument = !!msg.message?.documentMessage;
      const hasMedia = hasImage || hasVideo || hasAudio || hasDocument;

      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   (hasMedia ? "" : undefined);
      
      if (text === undefined) continue;

      const remoteJid = msg.key.remoteJid!;
      const isGroup = remoteJid.endsWith("@g.us");
      const isLid = remoteJid.endsWith("@lid");
      
      let senderId: string | undefined;
      if (isLid && msg.key.senderPn) {
        const senderPn = msg.key.senderPn as string;
        const match = senderPn.match(/^(\d+)@/);
        if (match) {
          senderId = `+${match[1]}`;
        }
      }
      
      const peer: PeerInfo = {
        kind: isGroup ? "group" : "dm",
        id: remoteJid,
        name: msg.pushName ?? undefined,
      };

      // Download media if present
      const media: MediaAttachment[] = [];
      if (hasMedia) {
        try {
          const attachment = await this.downloadMedia(msg);
          if (attachment) {
            media.push(attachment);
            console.log(`[WA] Media: ${attachment.type} ${attachment.mimeType} ${Math.round((attachment.data?.length ?? 0) / 1024)}KB`);
          }
        } catch (e) {
          console.error(`[WA] Media download failed:`, e);
        }
      }

      console.log(`[WA] ${remoteJid}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${media.length > 0 ? ` +${media.length} media` : ''}`);

      // Build inbound message for Gateway
      const inbound: ChannelInboundMessage = {
        messageId: msg.key.id!,
        peer: {
          kind: peer.kind,
          id: peer.id,
          name: peer.name,
        },
        sender: isGroup ? {
          id: msg.key.participant!,
          name: msg.pushName ?? undefined,
        } : (senderId ? {
          id: senderId,
          name: msg.pushName ?? undefined,
        } : undefined),
        text: text || (media.length > 0 ? "[Media]" : ""),
        media: media.length > 0 ? media : undefined,
        replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
        timestamp: msg.messageTimestamp as number,
      };

      // Send to Gateway via Service Binding RPC
      try {
        const accountId = this.state.selfE164 || this.state.accountId;
        const result = await this.env.GATEWAY.channelInbound("whatsapp", accountId, inbound);
        
        if (result.ok) {
          this.state.lastMessageAt = Date.now();
        } else {
          console.error(`[WA] Gateway rejected message: ${result.error}`);
        }
      } catch (e) {
        console.error(`[WA] Gateway RPC failed:`, e);
      }
    }
  }

  /**
   * Download media from a WhatsApp message
   */
  private async downloadMedia(msg: WAMessage): Promise<MediaAttachment | null> {
    if (!this.sock) return null;

    const mContent = extractMessageContent(msg.message);
    if (!mContent) return null;

    const contentType = getContentType(mContent);
    if (!contentType) return null;

    let mediaType: MediaAttachment["type"];
    let mimeType: string;
    let filename: string | undefined;
    let baileysMediaType: string;

    if (msg.message?.imageMessage) {
      mediaType = "image";
      mimeType = msg.message.imageMessage.mimetype || "image/jpeg";
      filename = msg.message.imageMessage.caption ?? undefined;
      baileysMediaType = "image";
    } else if (msg.message?.videoMessage) {
      mediaType = "video";
      mimeType = msg.message.videoMessage.mimetype || "video/mp4";
      filename = msg.message.videoMessage.caption ?? undefined;
      baileysMediaType = "video";
    } else if (msg.message?.audioMessage) {
      mediaType = "audio";
      mimeType = msg.message.audioMessage.mimetype || "audio/ogg";
      baileysMediaType = "audio";
    } else if (msg.message?.documentMessage) {
      mediaType = "document";
      mimeType = msg.message.documentMessage.mimetype || "application/octet-stream";
      filename = msg.message.documentMessage.fileName ?? undefined;
      baileysMediaType = "document";
    } else {
      return null;
    }

    const media = mContent[contentType] as {
      url?: string;
      directPath?: string;
      mediaKey?: Uint8Array | Buffer;
      fileLength?: number;
    };

    if (!media || typeof media !== "object") return null;
    if (!media.url && !media.directPath) return null;
    if (!media.mediaKey) return null;

    const isValidMediaUrl = media.url?.startsWith("https://mmg.whatsapp.net/");
    const downloadUrl = isValidMediaUrl ? media.url : getUrlFromDirectPath(media.directPath!);
    if (!downloadUrl) return null;

    const keys = await getMediaKeys(media.mediaKey, baileysMediaType as any);

    const response = await fetch(downloadUrl, {
      headers: { Origin: "https://web.whatsapp.com" },
    });

    if (!response.ok) {
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }

    const encryptedData = new Uint8Array(await response.arrayBuffer());
    const ciphertext = encryptedData.slice(0, -10);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keys.cipherKey,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: keys.iv },
      cryptoKey,
      ciphertext
    );

    const decryptedArray = new Uint8Array(decrypted);
    const base64 = btoa(String.fromCharCode(...decryptedArray));

    return {
      type: mediaType,
      mimeType,
      data: base64,
      filename,
      size: decryptedArray.byteLength,
    };
  }

  /**
   * Notify Gateway of status change via Service Binding
   */
  private async notifyGatewayStatus(): Promise<void> {
    try {
      const accountId = this.state.selfE164 || this.state.accountId;
      const status: ChannelAccountStatus = {
        accountId,
        connected: this.state.connected,
        authenticated: !!this.state.selfJid,
        mode: "websocket",
        lastActivity: this.state.lastMessageAt,
        extra: { selfJid: this.state.selfJid },
      };
      
      await this.env.GATEWAY.channelStatusChanged("whatsapp", accountId, status);
    } catch (e) {
      console.error(`[WA] Failed to notify Gateway of status:`, e);
    }
  }

  private waitForQrOrConnection(timeoutMs: number): Promise<{ connected?: boolean; qr?: string }> {
    return new Promise((resolve) => {
      if (this.state.connected) {
        resolve({ connected: true });
        return;
      }

      if (this.qrCode) {
        resolve({ qr: this.qrCode });
        return;
      }

      const timeout = setTimeout(() => resolve({}), timeoutMs);

      this.qrResolvers.push((qr) => {
        clearTimeout(timeout);
        resolve({ qr });
      });
    });
  }

  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000;

  private scheduleKeepAlive(): void {
    this.ctx.storage.setAlarm(Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS);
  }

  async alarm(): Promise<void> {
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (!hasAuth) return;

    this.scheduleKeepAlive();

    if (!this.sock) {
      console.log(`[WA] Alarm: Reconnecting WhatsApp...`);
      try {
        await this.startSocket();
      } catch (e) {
        console.error(`[WA] Alarm: Reconnect failed:`, e);
      }
      return;
    }

    if (!this.state.connected) {
      console.log(`[WA] Alarm: Socket exists but not connected, waiting...`);
      return;
    }
  }
}
