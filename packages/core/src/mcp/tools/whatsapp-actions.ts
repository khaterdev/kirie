import type { ChannelRegistry } from "../../channels/registry.js";

/**
 * WhatsApp-specific action tool using the Baileys WASocket.
 * Actions are dispatched by the `action` parameter.
 */
export function createWhatsAppActionToolHandlers(channelRegistry: ChannelRegistry) {
  return {
    whatsapp_action: {
      description:
        "Perform WhatsApp-specific actions beyond basic messaging. Supports: react, sendMessage (text with optional media).",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: "Action to perform: react, sendMessage",
          },
          chatId: {
            type: "string" as const,
            description: "WhatsApp chat ID (JID or phone number)",
          },
          messageId: {
            type: "string" as const,
            description: "Message ID (for react)",
          },
          emoji: {
            type: "string" as const,
            description: "Emoji (for react)",
          },
          text: {
            type: "string" as const,
            description: "Message text (for sendMessage)",
          },
          mediaUrl: {
            type: "string" as const,
            description: "Media URL to attach (for sendMessage)",
          },
          mediaType: {
            type: "string" as const,
            description: "Type of media: image, video, audio, document (for sendMessage with mediaUrl)",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const adapter = channelRegistry.getById("whatsapp");
        if (!adapter) {
          return { error: "WhatsApp adapter is not registered" };
        }
        if (!channelRegistry.isRunning("whatsapp")) {
          return { error: "WhatsApp adapter is not running" };
        }

        // Access the Baileys WASocket
        const socket = (adapter as unknown as { socket: unknown }).socket as {
          sendMessage(
            jid: string,
            content: Record<string, unknown>,
            opts?: Record<string, unknown>,
          ): Promise<{ key: { id?: string } } | undefined>;
        } | null;

        if (!socket) {
          return { error: "WhatsApp socket is not available" };
        }

        const action = params.action as string;

        // Resolve JID from chatId
        function resolveJid(chatId: string): string {
          if (chatId.includes("@")) return chatId;
          if (chatId.includes("-")) return `${chatId}@g.us`;
          // Assume phone number -> individual chat
          const cleaned = chatId.replace(/[^0-9]/g, "");
          return `${cleaned}@s.whatsapp.net`;
        }

        try {
          switch (action) {
            case "react": {
              if (!params.chatId || !params.messageId || !params.emoji) {
                return { error: "chatId, messageId, and emoji are required" };
              }
              const jid = resolveJid(params.chatId as string);
              await socket.sendMessage(jid, {
                react: {
                  text: params.emoji as string,
                  key: {
                    remoteJid: jid,
                    id: params.messageId as string,
                  },
                },
              });
              return { success: true };
            }

            case "sendMessage": {
              if (!params.chatId) return { error: "chatId is required" };
              const jid = resolveJid(params.chatId as string);

              if (params.mediaUrl) {
                // Send media message
                const mediaType = (params.mediaType as string) ?? "document";
                let content: Record<string, unknown>;

                switch (mediaType) {
                  case "image":
                    content = {
                      image: { url: params.mediaUrl as string },
                      caption: params.text as string | undefined,
                    };
                    break;
                  case "video":
                    content = {
                      video: { url: params.mediaUrl as string },
                      caption: params.text as string | undefined,
                    };
                    break;
                  case "audio":
                    content = {
                      audio: { url: params.mediaUrl as string },
                      mimetype: "audio/ogg; codecs=opus",
                    };
                    break;
                  default:
                    content = {
                      document: { url: params.mediaUrl as string },
                      caption: params.text as string | undefined,
                      mimetype: "application/octet-stream",
                    };
                    break;
                }

                const sent = await socket.sendMessage(jid, content);
                return {
                  messageId: sent?.key.id ?? `${Date.now()}`,
                  success: true,
                };
              }

              // Send text message
              if (!params.text) return { error: "text or mediaUrl is required" };
              const sent = await socket.sendMessage(jid, {
                text: params.text as string,
              });
              return {
                messageId: sent?.key.id ?? `${Date.now()}`,
                success: true,
              };
            }

            default:
              return { error: `Unknown WhatsApp action: ${action}` };
          }
        } catch (err) {
          return { error: `WhatsApp action failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  };
}
