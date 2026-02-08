import type { ChannelRegistry } from "../../channels/registry.js";

/**
 * Discord-specific action tool that provides deep access to Discord.js functionality.
 * Actions are dispatched by the `action` parameter.
 */
export function createDiscordActionToolHandlers(channelRegistry: ChannelRegistry) {
  return {
    discord_action: {
      description:
        "Perform Discord-specific actions beyond basic messaging. Supports: sendMessage, editMessage, deleteMessage, " +
        "react, readMessages, threadCreate, pinMessage, unpinMessage, listPins, memberInfo, roleInfo, roleAdd, roleRemove, setPresence.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description:
              "Action to perform: sendMessage, editMessage, deleteMessage, react, readMessages, threadCreate, " +
              "pinMessage, unpinMessage, listPins, memberInfo, roleInfo, roleAdd, roleRemove, setPresence",
          },
          channelId: {
            type: "string" as const,
            description: "Discord channel ID",
          },
          messageId: {
            type: "string" as const,
            description: "Message ID (for edit, delete, react, pin/unpin)",
          },
          content: {
            type: "string" as const,
            description: "Text content (for sendMessage, editMessage)",
          },
          emoji: {
            type: "string" as const,
            description: "Emoji (for react)",
          },
          threadId: {
            type: "string" as const,
            description: "Thread ID (for sendMessage in a thread)",
          },
          replyTo: {
            type: "string" as const,
            description: "Message ID to reply to",
          },
          limit: {
            type: "integer" as const,
            description: "Number of messages to read (default 10, max 100)",
          },
          before: {
            type: "string" as const,
            description: "Message ID to read before (for pagination)",
          },
          after: {
            type: "string" as const,
            description: "Message ID to read after (for pagination)",
          },
          name: {
            type: "string" as const,
            description: "Thread name (for threadCreate)",
          },
          guildId: {
            type: "string" as const,
            description: "Guild/server ID (for memberInfo, roleInfo, roleAdd, roleRemove)",
          },
          userId: {
            type: "string" as const,
            description: "User ID (for memberInfo, roleAdd, roleRemove)",
          },
          roleId: {
            type: "string" as const,
            description: "Role ID (for roleAdd, roleRemove)",
          },
          activityType: {
            type: "string" as const,
            description: "Activity type for setPresence: Playing, Streaming, Listening, Watching, Competing",
          },
          activityName: {
            type: "string" as const,
            description: "Activity name for setPresence",
          },
          status: {
            type: "string" as const,
            description: "Status for setPresence: online, idle, dnd, invisible",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const adapter = channelRegistry.getById("discord");
        if (!adapter) {
          return { error: "Discord adapter is not registered" };
        }
        if (!channelRegistry.isRunning("discord")) {
          return { error: "Discord adapter is not running" };
        }

        // Access the discord.js Client
        const client = (adapter as unknown as { client: unknown }).client as {
          channels: { fetch(id: string): Promise<unknown> };
          guilds: { fetch(id: string): Promise<unknown> };
          user?: { setPresence(opts: unknown): void; setActivity(name: string, opts: unknown): void };
        } | null;

        if (!client) {
          return { error: "Discord client is not available" };
        }

        const action = params.action as string;

        try {
          switch (action) {
            case "sendMessage": {
              const channelId = params.channelId as string ?? params.threadId as string;
              if (!channelId) return { error: "channelId is required" };
              if (!params.content) return { error: "content is required" };

              const channel = await client.channels.fetch(channelId) as {
                send(opts: unknown): Promise<{ id: string; createdTimestamp: number }>;
              };
              const sent = await channel.send({
                content: params.content as string,
                ...(params.replyTo
                  ? { reply: { messageReference: params.replyTo as string } }
                  : {}),
              });
              return { messageId: sent.id, timestamp: sent.createdTimestamp };
            }

            case "editMessage": {
              if (!params.channelId || !params.messageId || !params.content) {
                return { error: "channelId, messageId, and content are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: { fetch(id: string): Promise<{ edit(text: string): Promise<void> }> };
              };
              const msg = await channel.messages.fetch(params.messageId as string);
              await msg.edit(params.content as string);
              return { success: true };
            }

            case "deleteMessage": {
              if (!params.channelId || !params.messageId) {
                return { error: "channelId and messageId are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: { fetch(id: string): Promise<{ delete(): Promise<void> }> };
              };
              const msg = await channel.messages.fetch(params.messageId as string);
              await msg.delete();
              return { success: true };
            }

            case "react": {
              if (!params.channelId || !params.messageId || !params.emoji) {
                return { error: "channelId, messageId, and emoji are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: { fetch(id: string): Promise<{ react(emoji: string): Promise<void> }> };
              };
              const msg = await channel.messages.fetch(params.messageId as string);
              await msg.react(params.emoji as string);
              return { success: true };
            }

            case "readMessages": {
              if (!params.channelId) return { error: "channelId is required" };
              const limit = Math.min(Number(params.limit) || 10, 100);
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: {
                  fetch(opts: { limit: number; before?: string; after?: string }): Promise<
                    Map<string, { id: string; content: string; author: { id: string; username: string }; createdTimestamp: number }>
                  >;
                };
              };
              const opts: { limit: number; before?: string; after?: string } = { limit };
              if (params.before) opts.before = params.before as string;
              if (params.after) opts.after = params.after as string;
              const messages = await channel.messages.fetch(opts);
              const results = [...messages.values()].map((m) => ({
                id: m.id,
                content: m.content,
                authorId: m.author.id,
                authorName: m.author.username,
                timestamp: m.createdTimestamp,
              }));
              return { messages: results };
            }

            case "threadCreate": {
              if (!params.channelId || !params.name) {
                return { error: "channelId and name are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                threads: {
                  create(opts: { name: string; startMessage?: string }): Promise<{ id: string; name: string }>;
                };
              };
              const opts: { name: string; startMessage?: string } = {
                name: params.name as string,
              };
              if (params.messageId) opts.startMessage = params.messageId as string;
              const thread = await channel.threads.create(opts);
              return { threadId: thread.id, name: thread.name };
            }

            case "pinMessage": {
              if (!params.channelId || !params.messageId) {
                return { error: "channelId and messageId are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: { fetch(id: string): Promise<{ pin(): Promise<void> }> };
              };
              const msg = await channel.messages.fetch(params.messageId as string);
              await msg.pin();
              return { success: true };
            }

            case "unpinMessage": {
              if (!params.channelId || !params.messageId) {
                return { error: "channelId and messageId are required" };
              }
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: { fetch(id: string): Promise<{ unpin(): Promise<void> }> };
              };
              const msg = await channel.messages.fetch(params.messageId as string);
              await msg.unpin();
              return { success: true };
            }

            case "listPins": {
              if (!params.channelId) return { error: "channelId is required" };
              const channel = await client.channels.fetch(params.channelId as string) as {
                messages: {
                  fetchPinned(): Promise<
                    Map<string, { id: string; content: string; author: { username: string }; createdTimestamp: number }>
                  >;
                };
              };
              const pinned = await channel.messages.fetchPinned();
              const results = [...pinned.values()].map((m) => ({
                id: m.id,
                content: m.content,
                authorName: m.author.username,
                timestamp: m.createdTimestamp,
              }));
              return { pins: results };
            }

            case "memberInfo": {
              if (!params.guildId || !params.userId) {
                return { error: "guildId and userId are required" };
              }
              const guild = await client.guilds.fetch(params.guildId as string) as {
                members: {
                  fetch(id: string): Promise<{
                    user: { id: string; username: string; discriminator: string };
                    nickname: string | null;
                    roles: { cache: Map<string, { id: string; name: string }> };
                    joinedAt: Date | null;
                  }>;
                };
              };
              const member = await guild.members.fetch(params.userId as string);
              return {
                id: member.user.id,
                username: member.user.username,
                discriminator: member.user.discriminator,
                nickname: member.nickname,
                roles: [...member.roles.cache.values()].map((r) => ({ id: r.id, name: r.name })),
                joinedAt: member.joinedAt?.toISOString(),
              };
            }

            case "roleInfo": {
              if (!params.guildId) return { error: "guildId is required" };
              const guild = await client.guilds.fetch(params.guildId as string) as {
                roles: {
                  fetch(): Promise<
                    Map<string, { id: string; name: string; color: number; position: number; memberCount: number }>
                  >;
                };
              };
              const roles = await guild.roles.fetch();
              return {
                roles: [...roles.values()].map((r) => ({
                  id: r.id,
                  name: r.name,
                  color: r.color,
                  position: r.position,
                  memberCount: r.memberCount,
                })),
              };
            }

            case "roleAdd": {
              if (!params.guildId || !params.userId || !params.roleId) {
                return { error: "guildId, userId, and roleId are required" };
              }
              const guild = await client.guilds.fetch(params.guildId as string) as {
                members: {
                  fetch(id: string): Promise<{
                    roles: { add(roleId: string): Promise<void> };
                  }>;
                };
              };
              const member = await guild.members.fetch(params.userId as string);
              await member.roles.add(params.roleId as string);
              return { success: true };
            }

            case "roleRemove": {
              if (!params.guildId || !params.userId || !params.roleId) {
                return { error: "guildId, userId, and roleId are required" };
              }
              const guild = await client.guilds.fetch(params.guildId as string) as {
                members: {
                  fetch(id: string): Promise<{
                    roles: { remove(roleId: string): Promise<void> };
                  }>;
                };
              };
              const member = await guild.members.fetch(params.userId as string);
              await member.roles.remove(params.roleId as string);
              return { success: true };
            }

            case "setPresence": {
              if (!client.user) return { error: "Bot user not available" };
              const activityTypeMap: Record<string, number> = {
                Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5,
              };
              client.user.setPresence({
                status: (params.status as string) ?? "online",
                activities: params.activityName
                  ? [{
                      name: params.activityName as string,
                      type: activityTypeMap[(params.activityType as string) ?? "Playing"] ?? 0,
                    }]
                  : [],
              });
              return { success: true };
            }

            default:
              return { error: `Unknown Discord action: ${action}` };
          }
        } catch (err) {
          return { error: `Discord action failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  };
}
