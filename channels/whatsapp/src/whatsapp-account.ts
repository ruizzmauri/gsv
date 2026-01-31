/**
 * WhatsApp Account Durable Object
 * 
 * Manages a single WhatsApp account connection:
 * - Stores auth credentials in DO storage
 * - Maintains WebSocket connection to WhatsApp via Baileys
 * - Connects to GSV Gateway as a channel
 * - Routes messages between WhatsApp and Gateway
 */

import { DurableObject } from "cloudflare:workers";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import { GatewayClient } from "./gateway-client";
import type {
  WhatsAppAccountState,
  ChannelInboundParams,
  ChannelOutboundPayload,
  PeerInfo,
  MediaAttachment,
} from "./types";

interface Env {
  GSV_GATEWAY_URL: string;
  GSV_GATEWAY_TOKEN?: string;
}

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private gatewayClient: GatewayClient | null = null;
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
   * HTTP fetch handler - used for management API
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url);
        case "/logout":
          return await this.handleLogout();
        case "/stop":
          return await this.handleStop();
        case "/wake":
          return await this.handleWake();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      return new Response(String(e), { status: 500 });
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
      hasAuth: this.sock !== null,
      gatewayConnected: this.gatewayClient?.isConnected() ?? false,
    });
  }

  private async handleLogin(url: URL): Promise<Response> {
    const format = url.searchParams.get("format") || "json";
    
    // If already connected, return success
    if (this.state.connected && this.sock) {
      if (format === "html") {
        return new Response(this.renderHtml("Connected", "<p>Already connected to WhatsApp.</p>"), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Start the socket if not running
    if (!this.sock) {
      await this.startSocket();
    }

    // Wait for QR code or connection
    const result = await this.waitForQrOrConnection(60000);
    
    if (result.connected) {
      if (format === "html") {
        return new Response(this.renderHtml("Connected", "<p>Successfully connected to WhatsApp!</p>"), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      if (format === "html") {
        // Generate QR code as SVG
        const qrSvg = await QRCode.toString(result.qr, { type: "svg", width: 300 });
        const html = this.renderHtml("Scan QR Code", `
          <p>Scan this QR code with WhatsApp to connect:</p>
          <div style="background: white; padding: 20px; display: inline-block; border-radius: 8px;">
            ${qrSvg}
          </div>
          <p style="margin-top: 20px; color: #888;">QR code expires in ~20 seconds. Refresh if needed.</p>
          <script>setTimeout(() => location.reload(), 25000);</script>
        `);
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ 
        connected: false, 
        qr: result.qr,
        message: "Scan QR code with WhatsApp" 
      });
    }

    if (format === "html") {
      return new Response(this.renderHtml("Error", "<p>Failed to get QR code. Please try again.</p>"), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }
    return Response.json({ 
      connected: false, 
      message: "Failed to get QR code" 
    }, { status: 500 });
  }

  private renderHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - GSV WhatsApp</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
    }
    .container {
      padding: 40px;
    }
    h1 { color: #25D366; margin-bottom: 20px; }
    p { margin: 10px 0; }
    a { color: #25D366; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;
  }

  private async handleLogout(): Promise<Response> {
    // Close socket
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    // Clear auth state
    await clearAuthState(this.ctx.storage);
    
    // Reset state
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    return Response.json({ success: true, message: "Logged out" });
  }

  private async handleStop(): Promise<Response> {
    this.gatewayClient?.close();
    this.gatewayClient = null;

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();

    return Response.json({ success: true, message: "Stopped" });
  }

  /**
   * Wake up the DO and reconnect if needed
   * This is useful when the DO has hibernated and lost connections
   */
  private async handleWake(): Promise<Response> {
    const actions: string[] = [];
    
    // Check if we have auth
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (!hasAuth) {
      return Response.json({ 
        success: false, 
        message: "No auth credentials. Call /login first.",
        actions,
      }, { status: 400 });
    }

    // Check WhatsApp connection
    const waConnected = this.sock !== null && this.state.connected;
    if (!waConnected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: WhatsApp not connected, reconnecting...`);
      actions.push("reconnecting_whatsapp");
      await this.startSocket();
      
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      actions.push("whatsapp_already_connected");
    }

    // Check Gateway connection
    const gwConnected = this.gatewayClient?.isConnected() ?? false;
    if (!gwConnected && this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: Gateway not connected, reconnecting...`);
      actions.push("reconnecting_gateway");
      await this.connectToGateway();
    } else if (gwConnected) {
      actions.push("gateway_already_connected");
    }

    return Response.json({
      success: true,
      message: "Wake complete",
      actions,
      status: {
        whatsappConnected: this.state.connected,
        gatewayConnected: this.gatewayClient?.isConnected() ?? false,
        selfJid: this.state.selfJid,
      },
    });
  }

  private async startSocket(): Promise<void> {
    console.log(`[WhatsAppAccount:${this.state.accountId}] Starting socket`);

    // Get auth state from DO storage
    const { state: authState, saveCreds } = await useDOAuthState(this.ctx.storage);

    // Get latest Baileys version
    console.log(`[WhatsAppAccount:${this.state.accountId}] Fetching Baileys version...`);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WhatsAppAccount:${this.state.accountId}] Baileys version: ${version.join(".")}, isLatest=${isLatest}`);

    // Create socket
    this.sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, console as any),
      },
      version,
      printQRInTerminal: false,
      browser: ["GSV WhatsApp", "Channel", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Set up event handlers
    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on("messages.upsert", (m) => this.handleMessagesUpsert(m));
    
    // Handle WebSocket errors
    if (this.sock.ws) {
      const ws = this.sock.ws as any;
      if (typeof ws.on === "function") {
        ws.on("error", (err: Error) => {
          console.error(`[WhatsAppAccount:${this.state.accountId}] WebSocket error:`, err);
        });
        ws.on("close", (code: number, reason: string) => {
          console.log(`[WhatsAppAccount:${this.state.accountId}] WebSocket closed: code=${code}, reason=${reason}`);
        });
        ws.on("open", () => {
          console.log(`[WhatsAppAccount:${this.state.accountId}] WebSocket opened`);
        });
      }
    }
    
    console.log(`[WhatsAppAccount:${this.state.accountId}] Socket created, ws=${!!this.sock.ws}, waiting for events...`);
  }

  private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]>): void {
    console.log(`[WhatsAppAccount:${this.state.accountId}] connection.update:`, JSON.stringify(update, null, 2));
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] QR code received (length: ${qr.length})`);
      this.qrCode = qr;
      // Resolve any waiting QR promises
      console.log(`[WhatsAppAccount:${this.state.accountId}] Resolving ${this.qrResolvers.length} QR waiters`);
      for (const resolve of this.qrResolvers) {
        resolve(qr);
      }
      this.qrResolvers = [];
    }

    if (connection === "open") {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Connected to WhatsApp`);
      this.state.connected = true;
      this.state.lastConnectedAt = Date.now();
      this.state.selfJid = this.sock?.user?.id;
      
      // Extract E164 from JID (format: 14155551234@s.whatsapp.net)
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      // Connect to GSV Gateway now that WhatsApp is connected
      this.connectToGateway().catch((e) => {
        console.error(`[WhatsAppAccount:${this.state.accountId}] Failed to connect to gateway:`, e);
      });
      
      // Set up keep-alive alarm to prevent DO hibernation
      // This ensures the WhatsApp WebSocket stays connected
      this.scheduleKeepAlive();
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[WhatsAppAccount:${this.state.accountId}] Disconnected: ${statusCode}, loggedOut=${isLoggedOut}`);
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();

      if (isLoggedOut) {
        // Clear auth and don't reconnect
        clearAuthState(this.ctx.storage);
      } else {
        // Attempt reconnect after delay
        // In DO, we'd set an alarm for this
        this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap["messages.upsert"]): Promise<void> {
    console.log(`[WhatsAppAccount:${this.state.accountId}] messages.upsert: type=${m.type}, count=${m.messages.length}`);
    
    if (m.type !== "notify") {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Skipping non-notify message type`);
      return;
    }

    for (const msg of m.messages) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Processing message: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}`);
      
      // Skip our own messages
      if (msg.key.fromMe) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Skipping own message`);
        continue;
      }

      // Check for media messages
      const hasImage = !!msg.message?.imageMessage;
      const hasVideo = !!msg.message?.videoMessage;
      const hasAudio = !!msg.message?.audioMessage;
      const hasDocument = !!msg.message?.documentMessage;
      const hasMedia = hasImage || hasVideo || hasAudio || hasDocument;

      // Get text content (could be caption for media or regular text)
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   (hasMedia ? "" : undefined); // Allow empty text if media present
      
      if (text === undefined) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Skipping message without content`);
        continue;
      }

      console.log(`[WhatsAppAccount:${this.state.accountId}] Received message from ${msg.key.remoteJid}: text="${text.substring(0, 50)}...", hasMedia=${hasMedia}`);

      // Build peer info
      const remoteJid = msg.key.remoteJid!;
      const isGroup = remoteJid.endsWith("@g.us");
      
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
            console.log(`[WhatsAppAccount:${this.state.accountId}] Downloaded media: ${attachment.type}, ${attachment.mimeType}, ${attachment.data?.length ?? 0} chars base64`);
          }
        } catch (e) {
          console.error(`[WhatsAppAccount:${this.state.accountId}] Failed to download media:`, e);
        }
      }

      // Build inbound params
      const inbound: ChannelInboundParams = {
        channel: "whatsapp",
        accountId: this.state.selfE164 || this.state.accountId,
        peer,
        sender: isGroup ? {
          id: msg.key.participant!,
          name: msg.pushName ?? undefined,
        } : undefined,
        message: {
          id: msg.key.id!,
          text: text || (media.length > 0 ? "[Media]" : ""),
          timestamp: msg.messageTimestamp as number,
          replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
          media: media.length > 0 ? media : undefined,
        },
      };

      // Send to gateway
      if (this.gatewayClient?.isConnected()) {
        try {
          await this.gatewayClient.sendInbound(inbound);
          this.state.lastMessageAt = Date.now();
        } catch (e) {
          console.error(`[WhatsAppAccount:${this.state.accountId}] Failed to send to gateway:`, e);
        }
      }
    }
  }

  /**
   * Download media from a WhatsApp message and return as MediaAttachment
   */
  private async downloadMedia(msg: WAMessage): Promise<MediaAttachment | null> {
    if (!this.sock) return null;

    try {
      // Determine media type and get metadata
      let mediaType: MediaAttachment["type"];
      let mimeType: string;
      let filename: string | undefined;

      if (msg.message?.imageMessage) {
        mediaType = "image";
        mimeType = msg.message.imageMessage.mimetype || "image/jpeg";
        filename = msg.message.imageMessage.caption ?? undefined;
      } else if (msg.message?.videoMessage) {
        mediaType = "video";
        mimeType = msg.message.videoMessage.mimetype || "video/mp4";
        filename = msg.message.videoMessage.caption ?? undefined;
      } else if (msg.message?.audioMessage) {
        mediaType = "audio";
        mimeType = msg.message.audioMessage.mimetype || "audio/ogg";
      } else if (msg.message?.documentMessage) {
        mediaType = "document";
        mimeType = msg.message.documentMessage.mimetype || "application/octet-stream";
        filename = msg.message.documentMessage.fileName ?? undefined;
      } else {
        return null;
      }

      // Download the media
      console.log(`[WhatsAppAccount:${this.state.accountId}] Downloading ${mediaType} (${mimeType})...`);
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: console as any,
          reuploadRequest: this.sock.updateMediaMessage,
        }
      );

      if (!buffer) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] No buffer returned from media download`);
        return null;
      }

      // Convert to base64
      const base64 = Buffer.from(buffer).toString("base64");
      console.log(`[WhatsAppAccount:${this.state.accountId}] Media downloaded: ${base64.length} chars base64`);

      return {
        type: mediaType,
        mimeType,
        data: base64,
        filename,
        size: buffer.byteLength,
      };
    } catch (e) {
      console.error(`[WhatsAppAccount:${this.state.accountId}] Media download error:`, e);
      return null;
    }
  }

  private async connectToGateway(): Promise<void> {
    if (this.gatewayClient?.isConnected()) return;

    this.gatewayClient = new GatewayClient({
      url: this.env.GSV_GATEWAY_URL,
      token: this.env.GSV_GATEWAY_TOKEN,
      accountId: this.state.selfE164 || this.state.accountId,
      onOutbound: (payload) => this.handleOutbound(payload),
      onDisconnect: () => {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Gateway disconnected`);
        // Set alarm to reconnect
        this.ctx.storage.setAlarm(Date.now() + 3000);
      },
    });

    await this.gatewayClient.connect();
    console.log(`[WhatsAppAccount:${this.state.accountId}] Connected to gateway`);
  }

  private async handleOutbound(payload: ChannelOutboundPayload): Promise<void> {
    console.log(`[WhatsAppAccount:${this.state.accountId}] handleOutbound called, sock=${!!this.sock}, connected=${this.state.connected}`);
    console.log(`[WhatsAppAccount:${this.state.accountId}] Outbound payload:`, JSON.stringify(payload));
    
    if (!this.sock || !this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Cannot send: not connected (sock=${!!this.sock}, connected=${this.state.connected})`);
      return;
    }

    const jid = payload.peer.id;
    const text = payload.message.text;
    
    console.log(`[WhatsAppAccount:${this.state.accountId}] Sending to ${jid}: "${text.substring(0, 100)}..."`);

    try {
      // Simple send without quoting for now to debug
      const result = await this.sock.sendMessage(jid, { text });
      console.log(`[WhatsAppAccount:${this.state.accountId}] Send result:`, result?.key?.id);
    } catch (e) {
      console.error(`[WhatsAppAccount:${this.state.accountId}] Failed to send:`, e);
      // Log more details about the error
      if (e instanceof Error) {
        console.error(`[WhatsAppAccount:${this.state.accountId}] Error stack:`, e.stack);
      }
    }
  }

  private waitForQrOrConnection(timeoutMs: number): Promise<{ connected?: boolean; qr?: string }> {
    return new Promise((resolve) => {
      console.log(`[WhatsAppAccount:${this.state.accountId}] waitForQrOrConnection called, timeout=${timeoutMs}ms`);
      
      // If already connected
      if (this.state.connected) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Already connected`);
        resolve({ connected: true });
        return;
      }

      // If we already have a QR code
      if (this.qrCode) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Already have QR code`);
        resolve({ qr: this.qrCode });
        return;
      }

      // Wait for QR
      console.log(`[WhatsAppAccount:${this.state.accountId}] Waiting for QR code...`);
      const timeout = setTimeout(() => {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Timeout waiting for QR`);
        resolve({});
      }, timeoutMs);

      this.qrResolvers.push((qr) => {
        console.log(`[WhatsAppAccount:${this.state.accountId}] QR resolver called`);
        clearTimeout(timeout);
        resolve({ qr });
      });
    });
  }

  // Keep-alive interval in ms (25 seconds - well under DO's hibernation timeout)
  private static readonly KEEP_ALIVE_INTERVAL_MS = 25_000;

  /**
   * Schedule a keep-alive alarm to prevent DO hibernation.
   * This ensures the WhatsApp WebSocket connection stays active.
   */
  private scheduleKeepAlive(): void {
    const nextAlarm = Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS;
    this.ctx.storage.setAlarm(nextAlarm);
    console.log(`[WhatsAppAccount:${this.state.accountId}] Keep-alive alarm scheduled for ${new Date(nextAlarm).toISOString()}`);
  }

  /**
   * Alarm handler - used for reconnection attempts and keep-alive
   */
  async alarm(): Promise<void> {
    console.log(`[WhatsAppAccount:${this.state.accountId}] Alarm triggered, connected=${this.state.connected}, sock=${!!this.sock}`);

    // If we're connected, this is a keep-alive alarm
    if (this.sock && this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Keep-alive: connection active`);
      
      // Reconnect to gateway if needed (it may have disconnected)
      if (!this.gatewayClient?.isConnected()) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Keep-alive: gateway disconnected, reconnecting...`);
        try {
          await this.connectToGateway();
        } catch (e) {
          console.error(`[WhatsAppAccount:${this.state.accountId}] Keep-alive: failed to reconnect gateway:`, e);
        }
      }
      
      // Schedule next keep-alive
      this.scheduleKeepAlive();
      return;
    }

    // Not connected - attempt reconnection
    if (!this.sock || !this.state.connected) {
      const hasAuth = await hasAuthState(this.ctx.storage);
      if (hasAuth) {
        console.log(`[WhatsAppAccount:${this.state.accountId}] Alarm: reconnecting WhatsApp...`);
        await this.startSocket();
      }
    }

    // Reconnect to gateway if WhatsApp is connected
    if (this.state.connected && !this.gatewayClient?.isConnected()) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Alarm: reconnecting gateway...`);
      await this.connectToGateway();
    }
  }
}
