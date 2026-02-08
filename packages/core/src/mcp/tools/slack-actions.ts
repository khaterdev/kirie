import type { ChannelRegistry } from "../../channels/registry.js";

/**
 * Slack-specific action tool that provides deep access to Slack Web API functionality.
 * Actions are dispatched by the `action` parameter.
 */
export function createSlackActionToolHandlers(channelRegistry: ChannelRegistry) {
  return {
    slack_action: {
      description:
        "Perform Slack-specific actions beyond basic messaging. Supports: sendMessage, editMessage, deleteMessage, " +
        "readMessages, react, removeReaction, pinMessage, unpinMessage, listPins, memberInfo, emojiList.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description:
              "Action to perform: sendMessage, editMessage, deleteMessage, readMessages, " +
              "react, removeReaction, pinMessage, unpinMessage, listPins, memberInfo, emojiList",
          },
          channel: {
            type: "string" as const,
            description: "Slack channel ID",
          },
          text: {
            type: "string" as const,
            description: "Message text",
          },
          threadTs: {
            type: "string" as const,
            description: "Thread timestamp (for threaded messages)",
          },
          messageTs: {
            type: "string" as const,
            description: "Message timestamp (for edit, delete, react, pin/unpin)",
          },
          emoji: {
            type: "string" as const,
            description: "Emoji name without colons (for react, removeReaction)",
          },
          limit: {
            type: "integer" as const,
            description: "Number of messages to read (default 10, max 100)",
          },
          before: {
            type: "string" as const,
            description: "Timestamp to read messages before (for pagination)",
          },
          userId: {
            type: "string" as const,
            description: "User ID (for memberInfo)",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const adapter = channelRegistry.getById("slack");
        if (!adapter) {
          return { error: "Slack adapter is not registered" };
        }
        if (!channelRegistry.isRunning("slack")) {
          return { error: "Slack adapter is not running" };
        }

        // Access the Slack Bolt App to get the WebClient
        const app = (adapter as unknown as { app: unknown }).app as {
          client: {
            chat: {
              postMessage(opts: Record<string, unknown>): Promise<{ ts?: string; ok: boolean }>;
              update(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
              delete(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
            };
            conversations: {
              history(opts: Record<string, unknown>): Promise<{
                ok: boolean;
                messages?: Array<{
                  ts: string;
                  text: string;
                  user?: string;
                  thread_ts?: string;
                }>;
              }>;
            };
            reactions: {
              add(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
              remove(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
            };
            pins: {
              add(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
              remove(opts: Record<string, unknown>): Promise<{ ok: boolean }>;
              list(opts: Record<string, unknown>): Promise<{
                ok: boolean;
                items?: Array<{
                  message?: { ts: string; text: string; user?: string };
                }>;
              }>;
            };
            users: {
              info(opts: Record<string, unknown>): Promise<{
                ok: boolean;
                user?: {
                  id: string;
                  name: string;
                  real_name?: string;
                  profile?: { display_name?: string; email?: string; image_72?: string };
                  is_admin?: boolean;
                  is_owner?: boolean;
                  tz?: string;
                };
              }>;
            };
            emoji: {
              list(): Promise<{ ok: boolean; emoji?: Record<string, string> }>;
            };
          };
        } | null;

        if (!app) {
          return { error: "Slack app is not available" };
        }

        const action = params.action as string;

        try {
          switch (action) {
            case "sendMessage": {
              if (!params.channel || !params.text) {
                return { error: "channel and text are required" };
              }
              const opts: Record<string, unknown> = {
                channel: params.channel as string,
                text: params.text as string,
              };
              if (params.threadTs) opts.thread_ts = params.threadTs as string;
              const result = await app.client.chat.postMessage(opts);
              return { messageTs: result.ts, success: result.ok };
            }

            case "editMessage": {
              if (!params.channel || !params.messageTs || !params.text) {
                return { error: "channel, messageTs, and text are required" };
              }
              await app.client.chat.update({
                channel: params.channel as string,
                ts: params.messageTs as string,
                text: params.text as string,
              });
              return { success: true };
            }

            case "deleteMessage": {
              if (!params.channel || !params.messageTs) {
                return { error: "channel and messageTs are required" };
              }
              await app.client.chat.delete({
                channel: params.channel as string,
                ts: params.messageTs as string,
              });
              return { success: true };
            }

            case "readMessages": {
              if (!params.channel) return { error: "channel is required" };
              const limit = Math.min(Number(params.limit) || 10, 100);
              const opts: Record<string, unknown> = {
                channel: params.channel as string,
                limit,
              };
              if (params.before) opts.latest = params.before as string;
              const result = await app.client.conversations.history(opts);
              const messages = (result.messages ?? []).map((m) => ({
                ts: m.ts,
                text: m.text,
                userId: m.user,
                threadTs: m.thread_ts,
              }));
              return { messages };
            }

            case "react": {
              if (!params.channel || !params.messageTs || !params.emoji) {
                return { error: "channel, messageTs, and emoji are required" };
              }
              const emoji = (params.emoji as string).replace(/^:|:$/g, "");
              await app.client.reactions.add({
                channel: params.channel as string,
                name: emoji,
                timestamp: params.messageTs as string,
              });
              return { success: true };
            }

            case "removeReaction": {
              if (!params.channel || !params.messageTs || !params.emoji) {
                return { error: "channel, messageTs, and emoji are required" };
              }
              const emoji = (params.emoji as string).replace(/^:|:$/g, "");
              await app.client.reactions.remove({
                channel: params.channel as string,
                name: emoji,
                timestamp: params.messageTs as string,
              });
              return { success: true };
            }

            case "pinMessage": {
              if (!params.channel || !params.messageTs) {
                return { error: "channel and messageTs are required" };
              }
              await app.client.pins.add({
                channel: params.channel as string,
                timestamp: params.messageTs as string,
              });
              return { success: true };
            }

            case "unpinMessage": {
              if (!params.channel || !params.messageTs) {
                return { error: "channel and messageTs are required" };
              }
              await app.client.pins.remove({
                channel: params.channel as string,
                timestamp: params.messageTs as string,
              });
              return { success: true };
            }

            case "listPins": {
              if (!params.channel) return { error: "channel is required" };
              const result = await app.client.pins.list({
                channel: params.channel as string,
              });
              const pins = (result.items ?? [])
                .filter((item) => item.message)
                .map((item) => ({
                  ts: item.message!.ts,
                  text: item.message!.text,
                  userId: item.message!.user,
                }));
              return { pins };
            }

            case "memberInfo": {
              if (!params.userId) return { error: "userId is required" };
              const result = await app.client.users.info({
                user: params.userId as string,
              });
              if (!result.user) return { error: "User not found" };
              const u = result.user;
              return {
                id: u.id,
                name: u.name,
                realName: u.real_name,
                displayName: u.profile?.display_name,
                email: u.profile?.email,
                avatar: u.profile?.image_72,
                isAdmin: u.is_admin,
                isOwner: u.is_owner,
                timezone: u.tz,
              };
            }

            case "emojiList": {
              const result = await app.client.emoji.list();
              const emojis = Object.keys(result.emoji ?? {});
              return { emojis, count: emojis.length };
            }

            default:
              return { error: `Unknown Slack action: ${action}` };
          }
        } catch (err) {
          return { error: `Slack action failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  };
}
