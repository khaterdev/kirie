import type { ChannelRegistry } from "../../channels/registry.js";
import type { ChannelName } from "../../channels/normalizer.js";

export function createChannelActionToolHandlers(channelRegistry: ChannelRegistry) {
  return {
    channel_action: {
      description:
        "Perform channel-specific actions like sending reactions, editing messages, sending media, etc. Available actions depend on the channel and its capabilities.",
      parameters: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string" as const,
            description:
              "Channel name (telegram, discord, slack, whatsapp, signal)",
          },
          action: {
            type: "string" as const,
            description:
              "Action: send_text, send_reaction, edit_message, send_typing",
          },
          chatId: {
            type: "string" as const,
            description: "Chat/conversation ID",
          },
          messageId: {
            type: "string" as const,
            description: "Message ID (for reactions, edits)",
          },
          text: {
            type: "string" as const,
            description: "Text content (for send_text, edit_message)",
          },
          emoji: {
            type: "string" as const,
            description: "Emoji (for send_reaction)",
          },
          threadId: {
            type: "string" as const,
            description: "Thread ID (optional)",
          },
          replyToId: {
            type: "string" as const,
            description: "Reply to message ID (optional)",
          },
        },
        required: ["channel", "action", "chatId"] as const,
      },
      async handler(params: {
        channel: string;
        action: string;
        chatId: string;
        messageId?: string;
        text?: string;
        emoji?: string;
        threadId?: string;
        replyToId?: string;
      }) {
        const channelId = params.channel as ChannelName;
        const adapter = channelRegistry.getById(channelId);
        if (!adapter) {
          return { error: `Channel "${params.channel}" not found or not registered` };
        }

        if (!channelRegistry.isRunning(channelId)) {
          return { error: `Channel "${params.channel}" is registered but not currently running` };
        }

        const ctx = {
          chatId: params.chatId,
          threadId: params.threadId,
          replyToId: params.replyToId,
        };

        switch (params.action) {
          case "send_text": {
            if (!params.text) return { error: "text is required for send_text" };
            const sent = await adapter.sendText({ ctx, text: params.text });
            return { sent };
          }

          case "send_reaction": {
            if (!params.emoji || !params.messageId) {
              return { error: "emoji and messageId are required for send_reaction" };
            }
            if (!adapter.sendReaction) {
              return { error: `${params.channel} does not support reactions` };
            }
            await adapter.sendReaction({ ctx, messageId: params.messageId, emoji: params.emoji });
            return { success: true };
          }

          case "edit_message": {
            if (!params.text || !params.messageId) {
              return { error: "text and messageId are required for edit_message" };
            }
            if (!adapter.editMessage) {
              return { error: `${params.channel} does not support editing` };
            }
            await adapter.editMessage({ ctx, messageId: params.messageId, text: params.text });
            return { success: true };
          }

          case "send_typing": {
            await adapter.sendTyping({ ctx });
            return { success: true };
          }

          default:
            return { error: `Unknown action: ${params.action}` };
        }
      },
    },
  };
}
