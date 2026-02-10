/**
 * WhatsAppAdapter - implements ChannelAdapter for WhatsApp using Baileys.
 *
 * Supports:
 *   - QR code pairing for initial setup
 *   - Persistent auth state (reconnects without QR after first pair)
 *   - Text messages (no character limit imposed by WhatsApp, but we chunk at 4096)
 *   - Media sending (images, documents)
 *   - Typing indicators (composing presence)
 *   - Group and DM chats
 */

import type { WASocket } from "@whiskeysockets/baileys";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ChannelState,
  SendTextParams,
  SendTypingParams,
  SendMediaParams,
  SentMessage,
  MessageListener,
  DownloadedMedia,
  UnifiedMedia,
} from "@kirie/core";
import {
  createBaileysClient,
  shouldReconnect,
  type BaileysClientConfig,
} from "./baileys-client.js";
import { phoneToJid } from "./auth.js";

const MAX_TEXT_LENGTH = 4096;

/** Configuration for the WhatsApp adapter */
export interface WhatsAppAdapterConfig {
  /** Directory to store auth state. Defaults to ~/.kirie/whatsapp-auth/ */
  authDir?: string;
  /** QR code callback. Called with the QR string when pairing is needed. */
  onQr?: (qr: string) => void;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = "whatsapp" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: false,
    editMessage: false,
    deleteMessage: false,
    sendTyping: true,
    threads: false,
    multipleImages: false,
    reactions: true,
    replyContext: true,
    voiceMessages: true,
    maxTextLength: MAX_TEXT_LENGTH,
  };

  private socket: WASocket | null = null;
  private cleanup: (() => void) | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly config: WhatsAppAdapterConfig;

  constructor(config: WhatsAppAdapterConfig = {}) {
    this.config = config;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";

    try {
      const clientConfig: BaileysClientConfig = {
        authDir: this.config.authDir,
        onQr: this.config.onQr,
        onConnectionUpdate: (update) => {
          if (update.connection === "open") {
            this.state = "connected";
            this.connectedAt = Date.now();
            this.failureCount = 0;
            this.lastError = undefined;
            this.lastErrorAt = undefined;
          } else if (update.connection === "close") {
            const statusCode =
              (update.lastDisconnect?.error as { output?: { statusCode?: number } })
                ?.output?.statusCode;

            if (shouldReconnect(statusCode)) {
              this.state = "reconnecting";
              this.failureCount++;
            } else {
              this.state = "error";
              this.failureCount++;
              this.lastError = "Logged out from WhatsApp";
              this.lastErrorAt = Date.now();
            }
          }
        },
      };

      const result = await createBaileysClient(clientConfig, this.listeners);
      this.socket = result.socket;
      this.cleanup = result.cleanup;

      // Listen for abort signal to stop
      signal.addEventListener(
        "abort",
        () => {
          void this.stop();
        },
        { once: true },
      );

      // Mark as connected (connection.update callback will also set this)
      if (this.state === "connecting") {
        this.state = "connected";
        this.connectedAt = Date.now();
      }
    } catch (err) {
      this.state = "error";
      this.failureCount++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = Date.now();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "disconnected") return;

    try {
      if (this.cleanup) {
        this.cleanup();
        this.cleanup = null;
      }
      if (this.socket) {
        this.socket.end(undefined);
      }
    } finally {
      this.socket = null;
      this.state = "disconnected";
      this.connectedAt = undefined;
    }
  }

  getStatus(): ChannelStatus {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      failureCount: this.failureCount,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  async sendText(params: SendTextParams): Promise<SentMessage[]> {
    this.ensureConnected();

    const jid = this.resolveJid(params.ctx.chatId);
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const results: SentMessage[] = [];

    for (const chunk of chunks) {
      let sent;
      if (params.ctx.replyToId) {
        try {
          sent = await this.socket!.sendMessage(jid, {
            text: chunk,
          }, {
            quoted: {
              key: {
                remoteJid: jid,
                id: params.ctx.replyToId,
              },
              message: {},
            } as Parameters<WASocket["sendMessage"]>[2] extends { quoted?: infer Q } ? Q : never,
          });
        } catch {
          // Reply failed (e.g. original message deleted) — retry without quote
          sent = await this.socket!.sendMessage(jid, { text: chunk });
        }
      } else {
        sent = await this.socket!.sendMessage(jid, { text: chunk });
      }

      results.push({
        id: sent?.key.id ?? `${Date.now()}`,
        timestamp: Date.now(),
      });
    }

    return results;
  }

  async sendTyping(params: SendTypingParams): Promise<void> {
    this.ensureConnected();
    const jid = this.resolveJid(params.ctx.chatId);
    await this.socket!.sendPresenceUpdate("composing", jid);

    // Auto-stop composing after duration or 5 seconds
    const duration = params.durationMs ?? 5000;
    setTimeout(() => {
      void this.socket?.sendPresenceUpdate("paused", jid);
    }, duration);
  }

  async sendMedia(params: SendMediaParams): Promise<SentMessage> {
    this.ensureConnected();
    const jid = this.resolveJid(params.ctx.chatId);
    const { media } = params;

    let messageContent: Parameters<WASocket["sendMessage"]>[1];

    switch (media.type) {
      case "photo":
        messageContent = {
          image: { url: media.url },
          caption: media.caption,
          mimetype: media.mimeType,
        };
        break;
      case "video":
        messageContent = {
          video: { url: media.url },
          caption: media.caption,
          mimetype: media.mimeType,
        };
        break;
      case "audio":
      case "voice":
        messageContent = {
          audio: { url: media.url },
          mimetype: media.mimeType ?? "audio/ogg; codecs=opus",
          ptt: media.type === "voice",
        };
        break;
      case "sticker":
        messageContent = {
          sticker: { url: media.url },
          mimetype: media.mimeType,
        };
        break;
      case "document":
      case "animation":
      default:
        messageContent = {
          document: { url: media.url },
          fileName: media.filename ?? "file",
          caption: media.caption,
          mimetype: media.mimeType ?? "application/octet-stream",
        };
        break;
    }

    const sent = await this.socket!.sendMessage(jid, messageContent);

    return {
      id: sent?.key.id ?? `${Date.now()}`,
      timestamp: Date.now(),
    };
  }

  /**
   * Resolve a chat ID to a WhatsApp JID.
   * If it already looks like a JID (contains @), use it as-is.
   * Otherwise, treat it as a phone number.
   */
  private resolveJid(chatId: string): string {
    if (chatId.includes("@")) return chatId;

    // Check if it looks like a group ID (numbers with a dash)
    if (chatId.includes("-")) {
      return `${chatId}@g.us`;
    }

    return phoneToJid(chatId);
  }

  async downloadMedia(media: UnifiedMedia): Promise<DownloadedMedia> {
    // WhatsApp media URLs are direct CDN links (time-limited)
    const resp = await fetch(media.url);
    if (!resp.ok) throw new Error(`Failed to download WhatsApp media: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = media.filename ?? `whatsapp-${Date.now()}`;
    const mimeType = media.mimeType ?? resp.headers.get("content-type") ?? "application/octet-stream";

    return { buffer, mimeType, filename };
  }

  /**
   * Get the underlying Baileys WASocket instance.
   * Returns null if the adapter is not connected.
   */
  getSocket(): WASocket | null {
    return this.socket;
  }

  private ensureConnected(): void {
    if (!this.socket || this.state !== "connected") {
      throw new Error("WhatsApp adapter is not connected");
    }
  }
}

/**
 * Split text into chunks within the max length.
 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
