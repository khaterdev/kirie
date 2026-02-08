/**
 * SlackAdapter - implements ChannelAdapter for Slack using Bolt SDK.
 *
 * Supports:
 *   - Socket Mode (no public URL needed)
 *   - Text chunking at 3000 characters
 *   - Block Kit formatting
 *   - Message editing
 *   - Threads
 */

import type { App } from "@slack/bolt";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ChannelState,
  SendTextParams,
  SendTypingParams,
  SendMediaParams,
  EditMessageParams,
  SentMessage,
  MessageListener,
  DownloadedMedia,
  UnifiedMedia,
} from "@kirie/core";
import { createBoltApp, type SlackBoltConfig } from "./bolt-app.js";
import { validateSlackTokens } from "./auth.js";

const MAX_TEXT_LENGTH = 3000;

/** Configuration for the Slack adapter */
export interface SlackAdapterConfig {
  /** Bot OAuth token (xoxb-...) */
  botToken: string;
  /** App-level token for Socket Mode (xapp-...) */
  appToken: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly id = "slack" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: true,
    editMessage: true,
    deleteMessage: false,
    sendTyping: false,
    threads: true,
    multipleImages: true,
    reactions: true,
    replyContext: true,
    voiceMessages: false,
    maxTextLength: MAX_TEXT_LENGTH,
  };

  private app: App | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly config: SlackAdapterConfig;
  private botUserId: string | undefined;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";

    try {
      const boltConfig: SlackBoltConfig = {
        botToken: this.config.botToken,
        appToken: this.config.appToken,
      };

      this.app = createBoltApp(boltConfig, this.listeners);

      // Validate tokens and get bot info
      const authInfo = await validateSlackTokens(this.app.client);
      this.botUserId = authInfo.botUserId;

      // Update bolt config with bot user ID for self-filtering
      boltConfig.botUserId = this.botUserId;

      // Start the app in Socket Mode
      await this.app.start();

      signal.addEventListener("abort", () => {
        void this.stop();
      }, { once: true });

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
      if (this.app) {
        await this.app.stop();
      }
    } finally {
      this.app = null;
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
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const results: SentMessage[] = [];

    for (const chunk of chunks) {
      const result = await this.app!.client.chat.postMessage({
        channel: params.ctx.chatId,
        text: chunk,
        // Use Block Kit for rich formatting
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: chunk,
            },
          },
        ],
        ...(params.ctx.threadId ? { thread_ts: params.ctx.threadId } : {}),
      });

      if (result.ts) {
        results.push({
          id: result.ts,
          timestamp: parseSlackTs(result.ts),
        });
      }
    }

    return results;
  }

  async sendTyping(_params: SendTypingParams): Promise<void> {
    // Slack does not support typing indicators via API
  }

  async sendMedia(params: SendMediaParams): Promise<SentMessage> {
    this.ensureConnected();
    const { ctx, media } = params;

    // Share the media URL as a message with the URL unfurled
    // For actual file uploads, the caller should provide a Buffer via content
    const text = media.caption
      ? `${media.caption}\n${media.url}`
      : media.url;

    const result = await this.app!.client.chat.postMessage({
      channel: ctx.chatId,
      text,
      unfurl_links: true,
      unfurl_media: true,
      ...(ctx.threadId ? { thread_ts: ctx.threadId } : {}),
    });

    const ts = result.ts ?? String(Date.now() / 1000);
    return {
      id: ts,
      timestamp: parseSlackTs(ts),
    };
  }

  async sendReaction(params: import("@kirie/core").SendReactionParams): Promise<void> {
    this.ensureConnected();
    // Slack reactions use short names without colons (e.g. "thumbsup" not ":thumbsup:")
    const emoji = params.emoji.replace(/^:|:$/g, "");
    await this.app!.client.reactions.add({
      channel: params.ctx.chatId,
      name: emoji,
      timestamp: params.messageId,
    });
  }

  async editMessage(params: EditMessageParams): Promise<void> {
    this.ensureConnected();
    await this.app!.client.chat.update({
      channel: params.ctx.chatId,
      ts: params.messageId,
      text: params.text,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: params.text,
          },
        },
      ],
    });
  }

  async downloadMedia(media: UnifiedMedia): Promise<DownloadedMedia> {
    this.ensureConnected();
    // Slack files use url_private which requires a Bearer token
    const resp = await fetch(media.url, {
      headers: { Authorization: `Bearer ${this.config.botToken}` },
    });
    if (!resp.ok) throw new Error(`Failed to download Slack media: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = media.filename ?? `slack-${Date.now()}`;
    const mimeType = media.mimeType ?? resp.headers.get("content-type") ?? "application/octet-stream";

    return { buffer, mimeType, filename };
  }

  /**
   * Get the underlying Slack Bolt App instance.
   * Returns null if the adapter is not connected.
   */
  getApp(): App | null {
    return this.app;
  }

  private ensureConnected(): void {
    if (!this.app || this.state !== "connected") {
      throw new Error("Slack adapter is not connected");
    }
  }
}

/**
 * Split text into chunks that fit within the Slack message limit.
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

function parseSlackTs(ts: string): number {
  return Math.floor(parseFloat(ts) * 1000);
}
