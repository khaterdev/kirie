/**
 * TelegramAdapter - implements ChannelAdapter for Telegram using Grammy.
 *
 * Supports:
 *   - Long polling and webhook modes
 *   - Text chunking at 4000 characters
 *   - Media sending (photos, documents)
 *   - Message reactions
 *   - Message editing
 *   - Typing indicators
 */

import { InputFile } from "grammy";
import type { Bot } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ChannelState,
  SendTextParams,
  SendTypingParams,
  SendMediaParams,
  SendReactionParams,
  EditMessageParams,
  SentMessage,
  MessageListener,
  DownloadedMedia,
  UnifiedMedia,
} from "@kirie/core";
import { createBot, type TelegramBotConfig } from "./bot.js";
import { validateBotToken } from "./auth.js";
import {
  setWebhook,
  deleteWebhook,
  generateSecretToken,
  createWebhookHandler,
  type WebhookConfig,
} from "./webhook.js";

const MAX_TEXT_LENGTH = 4000;

/** Configuration for the Telegram adapter */
export interface TelegramAdapterConfig {
  /** Bot API token */
  token: string;
  /** Use webhook mode instead of polling */
  webhook?: WebhookConfig;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: true,
    editMessage: true,
    deleteMessage: false,
    sendTyping: true,
    threads: true,
    multipleImages: true,
    reactions: true,
    replyContext: true,
    voiceMessages: true,
    maxTextLength: MAX_TEXT_LENGTH,
  };

  private bot: Bot | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly config: TelegramAdapterConfig;
  private botId: number | undefined;
  private webhookHandler:
    | ((body: unknown, secretHeader: string | null | undefined) => Promise<boolean>)
    | null = null;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";

    try {
      // Validate token and get bot info
      const botInfo = await validateBotToken(this.config.token);
      this.botId = botInfo.id;

      const botConfig: TelegramBotConfig = {
        token: this.config.token,
        botId: this.botId,
      };

      this.bot = createBot(botConfig, this.listeners);

      if (this.config.webhook) {
        // Webhook mode
        const secretToken = this.config.webhook.secretToken || generateSecretToken();
        const webhookConfig: WebhookConfig = {
          ...this.config.webhook,
          secretToken,
        };
        await setWebhook(this.bot, webhookConfig);
        this.webhookHandler = createWebhookHandler(this.bot, secretToken);
      } else {
        // Polling mode
        // Grammy's bot.start() returns a promise that resolves when the bot stops.
        // We don't await it here; instead we let it run in the background.
        this.bot.start({
          onStart: () => {
            // This callback fires when polling starts successfully
          },
          allowed_updates: ["message", "edited_message", "message_reaction"],
        });
      }

      // Listen for abort signal to stop the bot
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
      if (this.bot) {
        if (this.config.webhook) {
          await deleteWebhook(this.bot);
          this.webhookHandler = null;
        } else {
          await this.bot.stop();
        }
      }
    } finally {
      this.bot = null;
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
      const threadOpts = params.ctx.threadId
        ? { message_thread_id: Number(params.ctx.threadId) }
        : {};

      const replyOpts = params.ctx.replyToId
        ? { reply_parameters: { message_id: Number(params.ctx.replyToId) } }
        : {};

      const baseOpts = { ...replyOpts, ...threadOpts };

      let sent;
      try {
        // Try with Markdown first
        sent = await this.bot!.api.sendMessage(
          params.ctx.chatId,
          chunk,
          { ...baseOpts, parse_mode: "Markdown" },
        );
      } catch (err: unknown) {
        // If Markdown parsing fails, retry without parse_mode
        const isParseError =
          err instanceof Error &&
          err.message.includes("can't parse entities");
        if (isParseError) {
          try {
            sent = await this.bot!.api.sendMessage(
              params.ctx.chatId,
              chunk,
              baseOpts,
            );
          } catch (plainErr: unknown) {
            // If the plain-text send also fails AND we were trying to reply,
            // fall back to sending without reply_parameters
            if (params.ctx.replyToId) {
              const fallbackOpts = { ...threadOpts };
              sent = await this.bot!.api.sendMessage(
                params.ctx.chatId,
                chunk,
                fallbackOpts,
              );
            } else {
              throw plainErr;
            }
          }
        } else if (params.ctx.replyToId) {
          // Non-parse error while replying — fall back to sending without
          // reply_parameters so the message isn't silently lost
          try {
            const fallbackOpts = { ...threadOpts };
            sent = await this.bot!.api.sendMessage(
              params.ctx.chatId,
              chunk,
              { ...fallbackOpts, parse_mode: "Markdown" },
            );
          } catch (fallbackErr: unknown) {
            // Markdown fallback also failed — try plain text without reply
            const isFallbackParseError =
              fallbackErr instanceof Error &&
              fallbackErr.message.includes("can't parse entities");
            if (isFallbackParseError) {
              const fallbackOpts = { ...threadOpts };
              sent = await this.bot!.api.sendMessage(
                params.ctx.chatId,
                chunk,
                fallbackOpts,
              );
            } else {
              throw fallbackErr;
            }
          }
        } else {
          throw err;
        }
      }

      results.push({
        id: String(sent.message_id),
        timestamp: sent.date * 1000,
      });
    }

    return results;
  }

  async sendTyping(params: SendTypingParams): Promise<void> {
    this.ensureConnected();
    await this.bot!.api.sendChatAction(
      params.ctx.chatId,
      "typing",
      params.ctx.threadId
        ? { message_thread_id: Number(params.ctx.threadId) }
        : undefined,
    );
  }

  async sendMedia(params: SendMediaParams): Promise<SentMessage> {
    this.ensureConnected();
    const { ctx, media } = params;
    const commonOpts = {
      caption: media.caption,
      ...(ctx.replyToId
        ? { reply_parameters: { message_id: Number(ctx.replyToId) } }
        : {}),
      ...(ctx.threadId
        ? { message_thread_id: Number(ctx.threadId) }
        : {}),
    };

    // Wrap local file paths in InputFile so Grammy uploads them.
    // HTTP URLs and Telegram file_ids are passed as-is.
    const source = resolveMediaSource(media.url);

    let sent;
    switch (media.type) {
      case "photo":
        sent = await this.bot!.api.sendPhoto(ctx.chatId, source, commonOpts);
        break;
      case "video":
        sent = await this.bot!.api.sendVideo(ctx.chatId, source, commonOpts);
        break;
      case "audio":
        sent = await this.bot!.api.sendAudio(ctx.chatId, source, commonOpts);
        break;
      case "voice":
        sent = await this.bot!.api.sendVoice(ctx.chatId, source, commonOpts);
        break;
      case "animation":
        sent = await this.bot!.api.sendAnimation(ctx.chatId, source, commonOpts);
        break;
      case "sticker":
        sent = await this.bot!.api.sendSticker(ctx.chatId, source, {
          ...(ctx.replyToId
            ? { reply_parameters: { message_id: Number(ctx.replyToId) } }
            : {}),
          ...(ctx.threadId
            ? { message_thread_id: Number(ctx.threadId) }
            : {}),
        });
        break;
      case "document":
      default:
        sent = await this.bot!.api.sendDocument(ctx.chatId, source, commonOpts);
        break;
    }

    return {
      id: String(sent.message_id),
      timestamp: sent.date * 1000,
    };
  }

  async sendReaction(params: SendReactionParams): Promise<void> {
    this.ensureConnected();
    await this.bot!.api.setMessageReaction(
      params.ctx.chatId,
      Number(params.messageId),
      [{ type: "emoji", emoji: params.emoji as Parameters<Bot["api"]["setMessageReaction"]>[2][0] extends { emoji: infer E } ? E : never }],
    );
  }

  async editMessage(params: EditMessageParams): Promise<void> {
    this.ensureConnected();
    await this.bot!.api.editMessageText(
      params.ctx.chatId,
      Number(params.messageId),
      params.text,
      { parse_mode: "Markdown" },
    );
  }

  async sendMediaBatch(params: { ctx: import("@kirie/core").ChannelContext; media: import("@kirie/core").UnifiedMedia[] }): Promise<SentMessage[]> {
    this.ensureConnected();
    const { ctx, media } = params;

    // If only one image, use regular sendMedia
    if (media.length <= 1) {
      const result = await this.sendMedia({ ctx, media: media[0]! });
      return [result];
    }

    // Filter photos for media group (sendMediaGroup only supports photos/videos)
    const photoItems = media.filter((m) => m.type === "photo" || m.type === "video");
    const otherItems = media.filter((m) => m.type !== "photo" && m.type !== "video");

    const results: SentMessage[] = [];

    // Send photos/videos as a media group
    if (photoItems.length > 0) {
      const inputMedia = photoItems.map((m, i) => ({
        type: m.type === "video" ? "video" as const : "photo" as const,
        media: resolveMediaSource(m.url),
        caption: i === 0 ? m.caption : undefined,
      }));

      const sent = await this.bot!.api.sendMediaGroup(
        ctx.chatId,
        inputMedia as InputMediaPhoto[],
        {
          ...(ctx.replyToId ? { reply_parameters: { message_id: Number(ctx.replyToId) } } : {}),
          ...(ctx.threadId ? { message_thread_id: Number(ctx.threadId) } : {}),
        },
      );

      for (const msg of sent) {
        results.push({ id: String(msg.message_id), timestamp: msg.date * 1000 });
      }
    }

    // Send other items one by one
    for (const item of otherItems) {
      const result = await this.sendMedia({ ctx, media: item });
      results.push(result);
    }

    return results;
  }

  async downloadMedia(media: UnifiedMedia): Promise<DownloadedMedia> {
    this.ensureConnected();
    // Telegram media URLs are file_ids, not HTTP URLs.
    // We need to resolve them via the Bot API.
    const file = await this.bot!.api.getFile(media.url);
    const filePath = file.file_path;
    if (!filePath) throw new Error("Telegram getFile returned no file_path");

    const downloadUrl = `https://api.telegram.org/file/bot${this.config.token}/${filePath}`;
    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Failed to download Telegram file: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = filePath.split(".").pop() ?? "bin";
    const filename = media.filename ?? `telegram-${Date.now()}.${ext}`;
    const mimeType = media.mimeType ?? guessMimeType(ext);

    return { buffer, mimeType, filename };
  }

  async registerCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    this.ensureConnected();
    await this.bot!.api.setMyCommands(
      commands.map((c) => ({
        command: c.command,
        description: c.description,
      })),
    );
  }

  /**
   * Get the webhook handler for use with an external HTTP server.
   * Only available in webhook mode after start().
   */
  getWebhookHandler(): ((body: unknown, secretHeader: string | null | undefined) => Promise<boolean>) | null {
    return this.webhookHandler;
  }

  /**
   * Get the underlying Grammy Bot instance.
   * Returns null if the adapter is not connected.
   */
  getBot(): Bot | null {
    return this.bot;
  }

  private ensureConnected(): void {
    if (!this.bot || this.state !== "connected") {
      throw new Error("Telegram adapter is not connected");
    }
  }
}

function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    pdf: "application/pdf",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Split text into chunks that fit within the Telegram message limit.
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

    // Try to find a good split point
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

/**
 * Convert a media URL/path to a Grammy-compatible source.
 * Local file paths are wrapped in InputFile for upload;
 * HTTP URLs and Telegram file_ids are passed as-is.
 */
function resolveMediaSource(url: string): string | InputFile {
  if (url.startsWith("/") || url.startsWith("~")) {
    return new InputFile(url);
  }
  return url;
}
