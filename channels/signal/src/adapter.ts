/**
 * SignalAdapter - implements ChannelAdapter for Signal via signal-cli REST API.
 *
 * Supports:
 *   - SSE event stream for incoming messages
 *   - Text sending via REST API
 *   - Media sending (base64 attachments)
 *   - Group messaging
 *   - No typing indicators (Signal API limitation)
 *   - No threads (Signal doesn't support threads)
 */

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
import { SignalClient, type SignalClientConfig } from "./client.js";
import { verifyPhoneNumber, normalizePhone } from "./auth.js";

const MAX_TEXT_LENGTH = 4096;

/** Configuration for the Signal adapter */
export interface SignalAdapterConfig {
  /** Base URL of the signal-cli REST API (e.g. "http://localhost:8080") */
  apiUrl: string;
  /** Phone number registered with signal-cli */
  phoneNumber: string;
}

export class SignalAdapter implements ChannelAdapter {
  readonly id = "signal" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: false,
    editMessage: false,
    deleteMessage: false,
    sendTyping: false,
    threads: false,
    multipleImages: true,
    reactions: false,
    replyContext: true,
    voiceMessages: true,
    maxTextLength: MAX_TEXT_LENGTH,
  };

  private client: SignalClient | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly config: SignalAdapterConfig;

  constructor(config: SignalAdapterConfig) {
    this.config = {
      apiUrl: config.apiUrl,
      phoneNumber: normalizePhone(config.phoneNumber),
    };
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";

    try {
      // Verify the API is reachable and the phone number is registered
      await verifyPhoneNumber(this.config.apiUrl, this.config.phoneNumber);

      const clientConfig: SignalClientConfig = {
        apiUrl: this.config.apiUrl,
        phoneNumber: this.config.phoneNumber,
      };

      this.client = new SignalClient(clientConfig);

      // Forward registered listeners to the client
      for (const listener of this.listeners) {
        this.client.onMessage(listener);
      }

      // Start SSE event stream
      await this.client.startListening(signal);

      // Listen for abort signal
      signal.addEventListener(
        "abort",
        () => {
          void this.stop();
        },
        { once: true },
      );

      this.state = "connected";
      this.connectedAt = Date.now();
      this.failureCount = 0;
      this.lastError = undefined;
      this.lastErrorAt = undefined;
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
      if (this.client) {
        this.client.stop();
      }
    } finally {
      this.client = null;
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
    // If client is already created, forward the listener
    if (this.client) {
      this.client.onMessage(listener);
    }
  }

  async sendText(params: SendTextParams): Promise<SentMessage[]> {
    this.ensureConnected();
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const results: SentMessage[] = [];

    for (const chunk of chunks) {
      let result;
      if (params.ctx.replyToId) {
        try {
          result = await this.client!.sendMessage(
            params.ctx.chatId,
            chunk,
            {
              quoteTimestamp: Number(params.ctx.replyToId),
              quoteAuthor: params.ctx.chatId,
            },
          );
        } catch {
          // Reply failed (e.g. original message deleted) — retry without quote
          result = await this.client!.sendMessage(params.ctx.chatId, chunk);
        }
      } else {
        result = await this.client!.sendMessage(params.ctx.chatId, chunk);
      }

      results.push({
        id: result.timestamp,
        timestamp: Number(result.timestamp),
      });
    }

    return results;
  }

  async sendTyping(_params: SendTypingParams): Promise<void> {
    // Signal typing indicators are not well-supported via signal-cli REST API
  }

  async sendMedia(params: SendMediaParams): Promise<SentMessage> {
    this.ensureConnected();

    // For Signal, we need to read the file and send as base64.
    // The media URL might be a local path or a remote URL.
    // The signal-cli REST API accepts base64-encoded attachments.
    const { readFile } = await import("node:fs/promises");
    let base64Data: string;

    try {
      // Try reading as a local file first
      const fileBuffer = await readFile(params.media.url);
      base64Data = fileBuffer.toString("base64");
    } catch {
      // If it's a URL, fetch it
      try {
        const res = await fetch(params.media.url);
        const arrayBuf = await res.arrayBuffer();
        base64Data = Buffer.from(arrayBuf).toString("base64");
      } catch (err) {
        throw new Error(
          `Failed to read media for Signal attachment: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const result = await this.client!.sendAttachment(
      params.ctx.chatId,
      {
        filename: params.media.filename ?? "attachment",
        base64: base64Data,
        contentType: params.media.mimeType,
      },
      params.media.caption,
    );

    return {
      id: result.timestamp,
      timestamp: Number(result.timestamp),
    };
  }

  async downloadMedia(media: UnifiedMedia): Promise<DownloadedMedia> {
    // Signal API attachment URLs are direct HTTP links
    const resp = await fetch(media.url);
    if (!resp.ok) throw new Error(`Failed to download Signal media: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = media.filename ?? `signal-${Date.now()}`;
    const mimeType = media.mimeType ?? resp.headers.get("content-type") ?? "application/octet-stream";

    return { buffer, mimeType, filename };
  }

  private ensureConnected(): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("Signal adapter is not connected");
    }
  }
}

/**
 * Split text into chunks that fit within the Signal message limit.
 * Tries to split on newlines or spaces to avoid breaking words.
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
