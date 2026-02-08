import type { ChannelRegistry } from "../../channels/registry.js";
import type { ChannelName } from "../../channels/normalizer.js";
import type { SentMessage } from "../../channels/adapter.js";

export interface SendMessageResult {
  channel: string;
  chatId: string;
  sent: SentMessage[];
}

export interface ChannelInfo {
  id: string;
  running: boolean;
  state: string;
  capabilities: {
    sendMedia: boolean;
    sendReaction: boolean;
    editMessage: boolean;
    threads: boolean;
    maxTextLength: number;
  };
}

export function createMessagingToolHandlers(registry: ChannelRegistry) {
  return {
    send_message: {
      description:
        "Send a text message to a connected channel. The channel must be registered and running.",
      parameters: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string" as const,
            description: "Channel to send through (telegram, discord, slack, whatsapp, signal)",
          },
          chatId: {
            type: "string" as const,
            description: "Chat/conversation ID to send to",
          },
          text: {
            type: "string" as const,
            description: "Message text to send",
          },
          replyToId: {
            type: "string" as const,
            description: "Optional message ID to reply to",
          },
        },
        required: ["channel", "chatId", "text"] as const,
      },
      async handler(params: {
        channel: string;
        chatId: string;
        text: string;
        replyToId?: string;
      }): Promise<SendMessageResult> {
        const channelId = params.channel as ChannelName;
        const adapter = registry.getById(channelId);

        if (!adapter) {
          throw new Error(
            `Channel "${params.channel}" is not registered. Use list_channels to see available channels.`,
          );
        }

        if (!registry.isRunning(channelId)) {
          throw new Error(
            `Channel "${params.channel}" is registered but not currently running.`,
          );
        }

        const sent = await adapter.sendText({
          ctx: {
            chatId: params.chatId,
            replyToId: params.replyToId,
          },
          text: params.text,
        });

        return {
          channel: params.channel,
          chatId: params.chatId,
          sent,
        };
      },
    },

    list_channels: {
      description: "List all registered channels and their current status.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler(): ChannelInfo[] {
        const channels: ChannelInfo[] = [];
        const all = registry.getAll();

        for (const [id, adapter] of all) {
          const status = adapter.getStatus();
          channels.push({
            id,
            running: registry.isRunning(id),
            state: status.state,
            capabilities: {
              sendMedia: adapter.capabilities.sendMedia,
              sendReaction: adapter.capabilities.sendReaction,
              editMessage: adapter.capabilities.editMessage,
              threads: adapter.capabilities.threads,
              maxTextLength: adapter.capabilities.maxTextLength,
            },
          });
        }

        return channels;
      },
    },
  };
}
