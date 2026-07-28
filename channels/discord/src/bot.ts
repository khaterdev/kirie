/**
 * Discord.js client setup with Gateway Intents and messageCreate handler.
 * Converts incoming Discord messages into UnifiedMessage format.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from "discord.js";
import type {
  UnifiedMessage,
  MessageListener,
  ChatType,
  UnifiedMedia,
  MediaType,
} from "@kirie/core";

/**
 * Configuration for the Discord bot client.
 */
export interface DiscordBotConfig {
  /** Bot token */
  token: string;
  /** Bot's own user ID (for mention detection) */
  botId: string;
}

/**
 * Creates and configures a Discord.js Client with appropriate intents
 * and event handlers.
 *
 * @param config - Bot configuration
 * @param listeners - Message listeners to notify on incoming messages
 * @returns Configured Client instance (not yet logged in)
 */
export function createBot(
  config: DiscordBotConfig,
  listeners: MessageListener[],
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel, // Required for DM support
      Partials.Message,
      Partials.Reaction,
    ],
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore messages from bots (including self)
    if (message.author.bot) return;

    const unified = await normalizeMessage(message, config.botId);
    if (!unified) return;

    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(unified));
      } catch {
        // Swallow listener errors to protect the event loop
      }
    }
  });

  // Handle edited messages
  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    // Fetch the full message if partial
    let message: Message;
    try {
      message = newMessage.partial ? await newMessage.fetch() : (newMessage as Message);
    } catch {
      return; // Message was deleted or inaccessible
    }

    if (message.author.bot) return;

    const unified = await normalizeMessage(message, config.botId);
    if (!unified) return;

    // Re-create with isEdited flag
    const editedUnified: UnifiedMessage = { ...unified, isEdited: true };

    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(editedUnified));
      } catch {
        // Swallow listener errors
      }
    }
  });

  // Handle incoming reactions (add)
  client.on("messageReactionAdd", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    if (user.bot) return;
    // Fetch partial reaction data if needed
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }

    const chatId = reaction.message.channelId;
    const emoji = reaction.emoji.name ?? reaction.emoji.toString();
    const unified: UnifiedMessage = {
      id: `reaction-${reaction.message.id}-${Date.now()}`,
      channel: "discord",
      senderId: user.id,
      senderName: user.displayName ?? user.username,
      text: "",
      chatType: "group",
      chatId,
      reaction: { emoji, messageId: reaction.message.id, action: "add" },
      timestamp: Date.now(),
      raw: reaction,
    };

    for (const listener of listeners) {
      try { void Promise.resolve(listener(unified)); } catch { /* swallow */ }
    }
  });

  // Handle incoming reactions (remove)
  client.on("messageReactionRemove", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }

    const chatId = reaction.message.channelId;
    const emoji = reaction.emoji.name ?? reaction.emoji.toString();
    const unified: UnifiedMessage = {
      id: `reaction-${reaction.message.id}-${Date.now()}`,
      channel: "discord",
      senderId: user.id,
      senderName: user.displayName ?? user.username,
      text: "",
      chatType: "group",
      chatId,
      reaction: { emoji, messageId: reaction.message.id, action: "remove" },
      timestamp: Date.now(),
      raw: reaction,
    };

    for (const listener of listeners) {
      try { void Promise.resolve(listener(unified)); } catch { /* swallow */ }
    }
  });

  return client;
}

/**
 * Converts a Discord.js Message into a UnifiedMessage.
 * Returns null if the message should be ignored.
 */
async function normalizeMessage(
  message: Message,
  botId: string,
): Promise<UnifiedMessage | null> {
  const text = stripBotMention(message.content, botId);

  // Skip empty messages with no media
  if (!text && message.attachments.size === 0) return null;

  const chatType = resolveChatType(message);
  const chatId = resolveChatId(message);

  const media = normalizeAttachments(message);

  // Fetch rich reply context when the message is a reply
  let replyTo: UnifiedMessage["replyTo"];
  if (message.reference?.messageId) {
    try {
      const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
      replyTo = {
        messageId: message.reference.messageId,
        text: referencedMsg.content ? referencedMsg.content.slice(0, 500) : undefined,
        senderId: referencedMsg.author?.id,
        senderName: referencedMsg.author?.displayName || referencedMsg.author?.username || undefined,
      };
    } catch {
      // Fallback if referenced message was deleted or inaccessible
      replyTo = { messageId: message.reference.messageId };
    }
  }

  const unified: UnifiedMessage = {
    id: message.id,
    channel: "discord",
    senderId: message.author.id,
    senderName:
      message.member?.displayName ?? message.author.displayName ?? message.author.username,
    text,
    chatType,
    chatId,
    threadId: resolveThreadId(message),
    replyToId: message.reference?.messageId ?? undefined,
    replyTo,
    media: media.length > 0 ? media : undefined,
    timestamp: message.createdTimestamp,
    raw: message,
  };

  return unified;
}

/**
 * Determine the chat type based on the Discord channel type.
 */
function resolveChatType(message: Message): ChatType {
  const channel = message.channel;

  if (
    channel.type === ChannelType.DM ||
    channel.type === ChannelType.GroupDM
  ) {
    return "dm";
  }

  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    return "thread";
  }

  return "group";
}

/**
 * Resolve the canonical chat ID.
 * For threads, use the parent channel ID so session continuity works
 * at the channel level.
 */
function resolveChatId(message: Message): string {
  const channel = message.channel;

  if (
    "parentId" in channel &&
    channel.parentId &&
    (channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread)
  ) {
    return channel.parentId;
  }

  return message.channelId;
}

/**
 * Resolve thread ID if the message is in a thread.
 */
function resolveThreadId(message: Message): string | undefined {
  const channel = message.channel;

  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    return message.channelId;
  }

  return undefined;
}

/**
 * Strip the bot mention from the beginning of the message text.
 * Discord mentions look like <@BOT_ID> or <@!BOT_ID>.
 */
function stripBotMention(content: string, botId: string): string {
  const mentionPattern = new RegExp(`^\\s*<@!?${botId}>\\s*`, "");
  return content.replace(mentionPattern, "").trim();
}

/**
 * Convert Discord attachments to UnifiedMedia.
 */
function normalizeAttachments(message: Message): UnifiedMedia[] {
  const media: UnifiedMedia[] = [];

  for (const [, attachment] of message.attachments) {
    const type = resolveMediaType(attachment.contentType ?? "");

    media.push({
      type,
      url: attachment.url,
      filename: attachment.name ?? undefined,
      mimeType: attachment.contentType ?? undefined,
      sizeBytes: attachment.size,
    });
  }

  return media;
}

/**
 * Map MIME type to UnifiedMedia type.
 */
function resolveMediaType(mimeType: string): MediaType {
  if (mimeType.startsWith("image/gif")) return "animation";
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
