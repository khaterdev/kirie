/**
 * Grammy bot setup with middleware pipeline.
 * Creates and configures a Grammy Bot instance for Kirie.
 */

import { Bot, type Context } from "grammy";
import type { UnifiedMessage, MessageListener, ChatType } from "@kirie/core";
import { makeDisplayName, makeSenderId } from "./auth.js";

/** Configuration for the Telegram bot */
export interface TelegramBotConfig {
  /** Bot API token */
  token: string;
  /** Bot's own user ID, set after getMe() */
  botId?: number;
}

/**
 * Normalize a Grammy context into a UnifiedMessage.
 */
function normalizeMessage(ctx: Context): UnifiedMessage | null {
  const isEdited = !ctx.message && !!ctx.editedMessage;
  const msg = ctx.message ?? ctx.editedMessage;
  if (!msg) return null;
  if (!msg.from) return null;

  const chatType = resolveChatType(msg.chat.type);
  const text = msg.text ?? msg.caption ?? "";

  const media = extractMedia(msg);

  // Build rich reply context if replying to another message
  const replyTo = msg.reply_to_message
    ? {
        messageId: String(msg.reply_to_message.message_id),
        text: msg.reply_to_message.text || msg.reply_to_message.caption || undefined,
        senderId: msg.reply_to_message.from?.id
          ? String(msg.reply_to_message.from.id)
          : undefined,
        senderName:
          [msg.reply_to_message.from?.first_name, msg.reply_to_message.from?.last_name]
            .filter(Boolean)
            .join(" ") || undefined,
      }
    : undefined;

  return {
    id: String(msg.message_id),
    channel: "telegram",
    senderId: makeSenderId(msg.from.id),
    senderName: makeDisplayName(msg.from.first_name, msg.from.last_name, msg.from.username),
    text,
    chatType,
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    replyTo,
    media: media.length > 0 ? media : undefined,
    timestamp: msg.date * 1000,
    isEdited,
    raw: msg,
  };
}

function resolveChatType(tgType: string): ChatType {
  switch (tgType) {
    case "private":
      return "dm";
    case "group":
    case "supergroup":
      return "group";
    default:
      return "group";
  }
}

interface TelegramMediaInfo {
  type: "photo" | "video" | "audio" | "voice" | "document" | "sticker" | "animation";
  url: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

function extractMedia(msg: NonNullable<Context["message"]>): TelegramMediaInfo[] {
  const results: TelegramMediaInfo[] = [];
  const caption = msg.caption;

  if (msg.photo && msg.photo.length > 0) {
    // Use the largest photo size (last in array)
    const largest = msg.photo[msg.photo.length - 1]!;
    results.push({
      type: "photo",
      url: largest.file_id,
      sizeBytes: largest.file_size,
      caption,
    });
  }

  if (msg.video) {
    results.push({
      type: "video",
      url: msg.video.file_id,
      filename: msg.video.file_name,
      mimeType: msg.video.mime_type,
      sizeBytes: msg.video.file_size,
      caption,
    });
  }

  if (msg.audio) {
    results.push({
      type: "audio",
      url: msg.audio.file_id,
      filename: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      sizeBytes: msg.audio.file_size,
      caption,
    });
  }

  if (msg.voice) {
    results.push({
      type: "voice",
      url: msg.voice.file_id,
      mimeType: msg.voice.mime_type,
      sizeBytes: msg.voice.file_size,
      caption,
    });
  }

  if (msg.document) {
    results.push({
      type: "document",
      url: msg.document.file_id,
      filename: msg.document.file_name,
      mimeType: msg.document.mime_type,
      sizeBytes: msg.document.file_size,
      caption,
    });
  }

  if (msg.sticker) {
    results.push({
      type: "sticker",
      url: msg.sticker.file_id,
      sizeBytes: msg.sticker.file_size,
    });
  }

  if (msg.animation) {
    results.push({
      type: "animation",
      url: msg.animation.file_id,
      filename: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      sizeBytes: msg.animation.file_size,
      caption,
    });
  }

  return results;
}

/**
 * Create and configure a Grammy Bot with the Kirie middleware pipeline.
 *
 * @param config - Bot configuration
 * @param listeners - Message listeners to invoke on incoming messages
 * @returns The configured Bot instance
 */
export function createBot(config: TelegramBotConfig, listeners: MessageListener[]): Bot {
  const bot = new Bot(config.token);

  // Handle text messages, photos, videos, etc.
  bot.on(["message", "edited_message"], (ctx) => {
    // Skip messages from the bot itself
    const from = ctx.message?.from ?? ctx.editedMessage?.from;
    if (from && config.botId && from.id === config.botId) return;

    const unified = normalizeMessage(ctx);
    if (!unified) return;

    // Fire-and-forget: don't block Grammy's update loop.
    // Per-session serialization is handled by the pipeline's LaneQueue.
    // This allows /stop, /stopall, and new messages to be processed
    // concurrently while a previous agent execution is still running.
    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  // Handle incoming reactions
  bot.on("message_reaction", (ctx) => {
    const update = ctx.messageReaction;
    if (!update) return;
    if (!update.user) return;
    // Skip reactions from the bot itself
    if (config.botId && update.user.id === config.botId) return;

    // Determine which emoji was added or removed
    const newEmojis = (update.new_reaction ?? [])
      .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
      .map((r) => r.emoji);
    const oldEmojis = (update.old_reaction ?? [])
      .filter((r): r is { type: "emoji"; emoji: string } => r.type === "emoji")
      .map((r) => r.emoji);

    // Find added reactions
    for (const emoji of newEmojis) {
      if (!oldEmojis.includes(emoji)) {
        const unified: UnifiedMessage = {
          id: `reaction-${update.message_id}-${Date.now()}`,
          channel: "telegram",
          senderId: makeSenderId(update.user.id),
          senderName: makeDisplayName(update.user.first_name, update.user.last_name, update.user.username),
          text: "",
          chatType: resolveChatType(update.chat.type),
          chatId: String(update.chat.id),
          reaction: { emoji, messageId: String(update.message_id), action: "add" },
          timestamp: Date.now(),
          raw: update,
        };
        for (const l of listeners) {
          void Promise.resolve(l(unified)).catch(() => {});
        }
      }
    }

    // Find removed reactions
    for (const emoji of oldEmojis) {
      if (!newEmojis.includes(emoji)) {
        const unified: UnifiedMessage = {
          id: `reaction-${update.message_id}-${Date.now()}`,
          channel: "telegram",
          senderId: makeSenderId(update.user.id),
          senderName: makeDisplayName(update.user.first_name, update.user.last_name, update.user.username),
          text: "",
          chatType: resolveChatType(update.chat.type),
          chatId: String(update.chat.id),
          reaction: { emoji, messageId: String(update.message_id), action: "remove" },
          timestamp: Date.now(),
          raw: update,
        };
        for (const l of listeners) {
          void Promise.resolve(l(unified)).catch(() => {});
        }
      }
    }
  });

  return bot;
}
