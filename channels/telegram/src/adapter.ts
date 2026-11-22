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

import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup, InputMediaPhoto } from "grammy/types";
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
  ChannelContext,
  InlineButton,
  InteractionListener,
  SendInteractiveParams,
  UpdateInteractiveParams,
  AckInteractionParams,
  RegisterCommandsOptions,
} from "@kirie/core";
import { createBot, type TelegramBotConfig } from "./bot.js";
import { validateBotToken } from "./auth.js";
import {
  TELEGRAM_ALLOWED_UPDATES,
  setWebhook,
  deleteWebhook,
  generateSecretToken,
  createWebhookHandler,
  type WebhookConfig,
} from "./webhook.js";

const MAX_TEXT_LENGTH = 4000;
/** Telegram's limit on callback_data. */
const MAX_CALLBACK_DATA_BYTES = 64;

/** Telegram's hosted Bot API. */
export const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

/** Configuration for the Telegram adapter */
export interface TelegramAdapterConfig {
  /** Bot API token */
  token: string;
  /** Use webhook mode instead of polling */
  webhook?: WebhookConfig;
  /**
   * Custom Bot API root, e.g. "http://127.0.0.1:8081" for a self-hosted
   * telegram-bot-api server. Raises the download limit from 20 MB to 2 GB.
   * When the server runs with --local, getFile returns an absolute path on
   * this machine and files are read from disk. Unset = api.telegram.org.
   */
  apiRoot?: string;
}

/**
 * Resolve where to fetch a file returned by getFile.
 *
 * - Local-mode server: `file_path` is an absolute path on disk.
 * - Cloud (or non-local self-hosted) server: `file_path` is relative and is
 *   served under `<apiRoot>/file/bot<token>/<file_path>`.
 */
export function resolveTelegramFileSource(
  filePath: string,
  token: string,
  apiRoot?: string,
): { kind: "disk"; path: string } | { kind: "url"; url: string } {
  if (isAbsolute(filePath)) return { kind: "disk", path: filePath };
  const root = (apiRoot ?? DEFAULT_TELEGRAM_API_ROOT).replace(/\/+$/, "");
  return { kind: "url", url: `${root}/file/bot${token}/${filePath}` };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: true,
    editMessage: true,
    deleteMessage: true,
    sendTyping: true,
    threads: true,
    multipleImages: true,
    reactions: true,
    replyContext: true,
    voiceMessages: true,
    maxTextLength: MAX_TEXT_LENGTH,
    interactiveButtons: true,
  };

  private bot: Bot | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly interactionListeners: InteractionListener[] = [];
  private readonly config: TelegramAdapterConfig;
  private botId: number | undefined;
  private botUsername: string | undefined;
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
      const botInfo = await validateBotToken(this.config.token, this.config.apiRoot);
      this.botId = botInfo.id;
      this.botUsername = botInfo.username || undefined;

      const botConfig: TelegramBotConfig = {
        token: this.config.token,
        botId: this.botId,
        apiRoot: this.config.apiRoot,
      };

      this.bot = createBot(botConfig, this.listeners, this.interactionListeners);

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
          allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
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

  onInteraction(listener: InteractionListener): void {
    this.interactionListeners.push(listener);
  }

  getSelf(): { id: string; username?: string } | null {
    if (this.botId === undefined) return null;
    return this.botUsername
      ? { id: String(this.botId), username: this.botUsername }
      : { id: String(this.botId) };
  }

  async sendText(params: SendTextParams): Promise<SentMessage[]> {
    this.ensureConnected();
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const results: SentMessage[] = [];

    if (params.plain) {
      for (const chunk of chunks) {
        results.push(await this.sendPlainChunk(params.ctx, chunk));
      }
      return results;
    }

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

  /**
   * Send one chunk with no parse mode. When replying fails, retry without
   * reply_parameters so the message is not lost.
   */
  private async sendPlainChunk(
    ctx: ChannelContext,
    text: string,
    extra: { reply_markup?: InlineKeyboardMarkup } = {},
  ): Promise<SentMessage> {
    const threadOpts = ctx.threadId ? { message_thread_id: Number(ctx.threadId) } : {};
    const replyOpts = ctx.replyToId ? { reply_parameters: { message_id: Number(ctx.replyToId) } } : {};
    let sent;
    try {
      sent = await this.bot!.api.sendMessage(ctx.chatId, text, { ...replyOpts, ...threadOpts, ...extra });
    } catch (err) {
      if (!ctx.replyToId) throw err;
      sent = await this.bot!.api.sendMessage(ctx.chatId, text, { ...threadOpts, ...extra });
    }
    return { id: String(sent.message_id), timestamp: sent.date * 1000 };
  }

  async sendInteractive(params: SendInteractiveParams): Promise<SentMessage> {
    this.ensureConnected();
    const reply_markup = toInlineKeyboard(params.buttons);
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const last = chunks.pop() ?? "";
    // Long text: earlier chunks go first, the buttons ride on the last one.
    if (chunks.length > 0) {
      await this.sendText({ ctx: params.ctx, text: chunks.join("\n"), plain: params.plain });
    }
    if (params.plain) {
      return this.sendPlainChunk(params.ctx, last, { reply_markup });
    }
    const threadOpts = params.ctx.threadId ? { message_thread_id: Number(params.ctx.threadId) } : {};
    const replyOpts = params.ctx.replyToId
      ? { reply_parameters: { message_id: Number(params.ctx.replyToId) } }
      : {};
    try {
      const sent = await this.bot!.api.sendMessage(params.ctx.chatId, last, {
        ...replyOpts,
        ...threadOpts,
        reply_markup,
        parse_mode: "Markdown",
      });
      return { id: String(sent.message_id), timestamp: sent.date * 1000 };
    } catch (err) {
      if (!isParseError(err)) throw err;
      return this.sendPlainChunk(params.ctx, last, { reply_markup });
    }
  }

  async updateInteractive(params: UpdateInteractiveParams): Promise<void> {
    this.ensureConnected();
    const chatId = params.ctx.chatId;
    const messageId = Number(params.messageId);
    const reply_markup =
      params.buttons === null
        ? { inline_keyboard: [] }
        : params.buttons
          ? toInlineKeyboard(params.buttons)
          : undefined;
    try {
      if (params.text !== undefined) {
        const text = params.text.length > MAX_TEXT_LENGTH
          ? params.text.slice(0, MAX_TEXT_LENGTH - 1) + "…"
          : params.text;
        const opts = reply_markup ? { reply_markup } : {};
        if (params.plain) {
          await this.bot!.api.editMessageText(chatId, messageId, text, opts);
        } else {
          try {
            await this.bot!.api.editMessageText(chatId, messageId, text, { ...opts, parse_mode: "Markdown" });
          } catch (err) {
            if (!isParseError(err)) throw err;
            await this.bot!.api.editMessageText(chatId, messageId, text, opts);
          }
        }
      } else if (reply_markup) {
        await this.bot!.api.editMessageReplyMarkup(chatId, messageId, { reply_markup });
      }
    } catch (err) {
      // Editing to identical content is not a failure.
      if (err instanceof Error && err.message.includes("message is not modified")) return;
      throw err;
    }
  }

  async ackInteraction(params: AckInteractionParams): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.answerCallbackQuery(params.interactionId, {
        ...(params.text ? { text: params.text.slice(0, 200) } : {}),
        ...(params.alert ? { show_alert: true } : {}),
      });
    } catch {
      // "query is too old" and similar: the press can no longer be acknowledged.
    }
  }

  async deleteMessage(params: { ctx: ChannelContext; messageId: string }): Promise<void> {
    this.ensureConnected();
    await this.bot!.api.deleteMessage(params.ctx.chatId, Number(params.messageId));
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
    let file: Awaited<ReturnType<Bot["api"]["getFile"]>>;
    try {
      file = await this.bot!.api.getFile(media.url);
    } catch (err) {
      // Name the actual limit so the agent can tell the sender what happened.
      const msg = err instanceof Error ? err.message : String(err);
      if (/file is too big/i.test(msg)) {
        const limit = this.config.apiRoot ? "2 GB, local Bot API server" : "20 MB";
        throw new Error(`file is too big (Telegram bot limit ${limit})`, { cause: err });
      }
      throw err;
    }
    const filePath = file.file_path;
    if (!filePath) throw new Error("Telegram getFile returned no file_path");

    const source = resolveTelegramFileSource(filePath, this.config.token, this.config.apiRoot);
    let buffer: Buffer;
    if (source.kind === "disk") {
      buffer = await readFile(source.path);
    } else {
      const resp = await fetch(source.url);
      if (!resp.ok) throw new Error(`Failed to download Telegram file: ${resp.statusText}`);
      buffer = Buffer.from(await resp.arrayBuffer());
    }

    const ext = basename(filePath).split(".").pop() ?? "bin";
    const filename = media.filename ?? `telegram-${Date.now()}.${ext}`;
    const mimeType = media.mimeType ?? guessMimeType(ext);

    return { buffer, mimeType, filename };
  }

  async registerCommands(
    commands: Array<{ command: string; description: string }>,
    opts?: RegisterCommandsOptions,
  ): Promise<void> {
    this.ensureConnected();
    const list = commands.map((c) => ({
      command: c.command,
      description: c.description,
    }));
    if (opts?.chatId) {
      const chatId = /^-?\d+$/.test(opts.chatId) ? Number(opts.chatId) : opts.chatId;
      await this.bot!.api.setMyCommands(list, { scope: { type: "chat", chat_id: chatId } });
      return;
    }
    await this.bot!.api.setMyCommands(list);
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

function isParseError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("can't parse entities");
}

/**
 * Convert rows of InlineButton into Telegram's inline keyboard.
 * Throws on a button with neither or both of data/url, or data over 64 bytes.
 */
export function toInlineKeyboard(rows: readonly (readonly InlineButton[])[]): InlineKeyboardMarkup {
  const inline_keyboard: InlineKeyboardButton[][] = [];
  for (const row of rows) {
    const out: InlineKeyboardButton[] = [];
    for (const b of row) {
      const hasData = typeof b.data === "string";
      const hasUrl = typeof b.url === "string";
      if (hasData === hasUrl) throw new Error(`Button "${b.label}" needs exactly one of data or url`);
      if (hasData) {
        if (Buffer.byteLength(b.data!, "utf8") > MAX_CALLBACK_DATA_BYTES) {
          throw new Error(`Button "${b.label}" callback data exceeds ${MAX_CALLBACK_DATA_BYTES} bytes`);
        }
        out.push({ text: b.label, callback_data: b.data! });
      } else {
        out.push({ text: b.label, url: b.url! });
      }
    }
    if (out.length > 0) inline_keyboard.push(out);
  }
  return { inline_keyboard };
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
