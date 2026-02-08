import type { ChannelRegistry } from "../../channels/registry.js";

/**
 * Telegram-specific action tool that provides deep access to Grammy bot functionality.
 * Actions are dispatched by the `action` parameter.
 */
export function createTelegramActionToolHandlers(channelRegistry: ChannelRegistry) {
  return {
    telegram_action: {
      description:
        "Perform Telegram-specific actions beyond basic messaging. Supports: sendMessage (with inline keyboard buttons, " +
        "forum topic threads, quote text, voice, silent mode), react, editMessage, deleteMessage, sendSticker, searchSticker.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description:
              "Action to perform: sendMessage, react, editMessage, deleteMessage, sendSticker, searchSticker",
          },
          chatId: {
            type: "string" as const,
            description: "Telegram chat ID",
          },
          messageId: {
            type: "string" as const,
            description: "Message ID (for react, edit, delete)",
          },
          content: {
            type: "string" as const,
            description: "Text content (for sendMessage, editMessage)",
          },
          emoji: {
            type: "string" as const,
            description: "Emoji (for react)",
          },
          buttons: {
            type: "string" as const,
            description:
              'JSON array of button rows for inline keyboard. Each row is an array of {text, callback_data} or {text, url} objects. Example: [[{"text":"Yes","callback_data":"yes"},{"text":"No","callback_data":"no"}]]',
          },
          messageThreadId: {
            type: "string" as const,
            description: "Forum topic thread ID (for messages in topic-based groups)",
          },
          quoteText: {
            type: "string" as const,
            description: "Text to quote from the replied message",
          },
          replyTo: {
            type: "string" as const,
            description: "Message ID to reply to",
          },
          asVoice: {
            type: "boolean" as const,
            description: "Send audio as voice note (for sendMessage with audio URL)",
          },
          silent: {
            type: "boolean" as const,
            description: "Send message silently (no notification)",
          },
          fileId: {
            type: "string" as const,
            description: "Sticker file_id (for sendSticker)",
          },
          query: {
            type: "string" as const,
            description: "Search query (for searchSticker)",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const adapter = channelRegistry.getById("telegram");
        if (!adapter) {
          return { error: "Telegram adapter is not registered" };
        }
        if (!channelRegistry.isRunning("telegram")) {
          return { error: "Telegram adapter is not running" };
        }

        // Access the Grammy Bot instance
        const bot = (adapter as unknown as { bot: unknown }).bot as {
          api: {
            sendMessage(chatId: string | number, text: string, opts?: Record<string, unknown>): Promise<{ message_id: number; date: number }>;
            editMessageText(chatId: string | number, messageId: number, text: string, opts?: Record<string, unknown>): Promise<void>;
            deleteMessage(chatId: string | number, messageId: number): Promise<void>;
            setMessageReaction(chatId: string | number, messageId: number, reaction: unknown[]): Promise<void>;
            sendSticker(chatId: string | number, sticker: string, opts?: Record<string, unknown>): Promise<{ message_id: number; date: number }>;
            getStickerSet(name: string): Promise<{ stickers: Array<{ file_id: string; emoji?: string }> }>;
            sendVoice(chatId: string | number, voice: string, opts?: Record<string, unknown>): Promise<{ message_id: number; date: number }>;
          };
        } | null;

        if (!bot) {
          return { error: "Telegram bot is not available" };
        }

        const action = params.action as string;

        try {
          switch (action) {
            case "sendMessage": {
              if (!params.chatId || !params.content) {
                return { error: "chatId and content are required" };
              }
              const opts: Record<string, unknown> = {};

              if (params.replyTo) {
                opts.reply_parameters = { message_id: Number(params.replyTo) };
              }
              if (params.messageThreadId) {
                opts.message_thread_id = Number(params.messageThreadId);
              }
              if (params.silent) {
                opts.disable_notification = true;
              }
              if (params.quoteText) {
                if (!opts.reply_parameters) {
                  return { error: "replyTo is required when using quoteText" };
                }
                (opts.reply_parameters as Record<string, unknown>).quote = params.quoteText;
              }

              // Parse inline keyboard buttons
              if (params.buttons) {
                try {
                  const buttonRows = JSON.parse(params.buttons as string);
                  opts.reply_markup = { inline_keyboard: buttonRows };
                } catch {
                  return { error: "Invalid buttons JSON" };
                }
              }

              opts.parse_mode = "Markdown";

              const sent = await bot.api.sendMessage(
                params.chatId as string,
                params.content as string,
                opts,
              );
              return { messageId: String(sent.message_id), timestamp: sent.date * 1000 };
            }

            case "editMessage": {
              if (!params.chatId || !params.messageId || !params.content) {
                return { error: "chatId, messageId, and content are required" };
              }
              const opts: Record<string, unknown> = { parse_mode: "Markdown" };

              if (params.buttons) {
                try {
                  const buttonRows = JSON.parse(params.buttons as string);
                  opts.reply_markup = { inline_keyboard: buttonRows };
                } catch {
                  return { error: "Invalid buttons JSON" };
                }
              }

              await bot.api.editMessageText(
                params.chatId as string,
                Number(params.messageId),
                params.content as string,
                opts,
              );
              return { success: true };
            }

            case "deleteMessage": {
              if (!params.chatId || !params.messageId) {
                return { error: "chatId and messageId are required" };
              }
              await bot.api.deleteMessage(
                params.chatId as string,
                Number(params.messageId),
              );
              return { success: true };
            }

            case "react": {
              if (!params.chatId || !params.messageId || !params.emoji) {
                return { error: "chatId, messageId, and emoji are required" };
              }
              await bot.api.setMessageReaction(
                params.chatId as string,
                Number(params.messageId),
                [{ type: "emoji", emoji: params.emoji as string }],
              );
              return { success: true };
            }

            case "sendSticker": {
              if (!params.chatId || !params.fileId) {
                return { error: "chatId and fileId are required" };
              }
              const opts: Record<string, unknown> = {};
              if (params.replyTo) {
                opts.reply_parameters = { message_id: Number(params.replyTo) };
              }
              if (params.messageThreadId) {
                opts.message_thread_id = Number(params.messageThreadId);
              }
              const sent = await bot.api.sendSticker(
                params.chatId as string,
                params.fileId as string,
                opts,
              );
              return { messageId: String(sent.message_id), timestamp: sent.date * 1000 };
            }

            case "searchSticker": {
              if (!params.query) return { error: "query is required" };
              // Telegram doesn't have a direct search API; try to get a known sticker set by name
              try {
                const set = await bot.api.getStickerSet(params.query as string);
                const stickers = set.stickers.slice(0, 20).map((s) => ({
                  fileId: s.file_id,
                  emoji: s.emoji,
                }));
                return { stickers };
              } catch {
                return { error: `Sticker set "${params.query}" not found. Use the exact sticker set name.` };
              }
            }

            default:
              return { error: `Unknown Telegram action: ${action}` };
          }
        } catch (err) {
          return { error: `Telegram action failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  };
}
