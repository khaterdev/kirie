/**
 * Bolt app setup with Socket Mode and event handlers.
 * Handles message events and app_mention events from Slack.
 */

import { App, type types } from "@slack/bolt";
import type { UnifiedMessage, MessageListener, ChatType } from "@kirie/core";
import { makeSenderId } from "./auth.js";

type GenericMessageEvent = types.GenericMessageEvent;

/** Configuration for the Slack Bolt app */
export interface SlackBoltConfig {
  /** Bot OAuth token (xoxb-...) */
  botToken: string;
  /** App-level token for Socket Mode (xapp-...) */
  appToken: string;
  /** Bot's own user ID, set after auth.test */
  botUserId?: string;
}

/**
 * Create and configure a Bolt App with Socket Mode.
 *
 * @param config - Bolt configuration
 * @param listeners - Message listeners to invoke on incoming messages
 * @returns The configured Bolt App instance
 */
export function createBoltApp(config: SlackBoltConfig, listeners: MessageListener[]): App {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  // Handle regular messages
  app.message(async ({ message, client }) => {
    // Only handle standard messages (not subtypes like message_changed, etc.)
    const msg = message as GenericMessageEvent;
    if (msg.subtype) return;
    if (!msg.user) return;

    // Skip bot's own messages
    if (config.botUserId && msg.user === config.botUserId) return;

    // Look up user info for display name
    let senderName = msg.user;
    try {
      const userInfo = await client.users.info({ user: msg.user });
      if (userInfo.user) {
        senderName =
          userInfo.user.profile?.display_name ||
          userInfo.user.real_name ||
          userInfo.user.name ||
          msg.user;
      }
    } catch {
      // Fall back to user ID as name
    }

    const chatType = resolveChatType(msg.channel_type);
    let unified = normalizeSlackMessage(msg, senderName, chatType);
    if (!unified) return;

    // Detect thread replies: thread_ts present and different from the message's own ts
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      try {
        const parentResult = await client.conversations.history({
          channel: msg.channel,
          latest: msg.thread_ts,
          inclusive: true,
          limit: 1,
        });
        const parentMsg = parentResult.messages?.[0];
        if (parentMsg) {
          unified = {
            ...unified,
            replyToId: msg.thread_ts,
            replyTo: {
              messageId: msg.thread_ts,
              text: parentMsg.text ? parentMsg.text.slice(0, 500) : undefined,
              senderId: parentMsg.user || parentMsg.bot_id || undefined,
              senderName: undefined,
            },
          };
        }
      } catch {
        // Fallback: set replyTo with just the thread_ts
        unified = {
          ...unified,
          replyToId: msg.thread_ts,
          replyTo: { messageId: msg.thread_ts },
        };
      }
    }

    // Fire-and-forget: don't block Bolt's event loop.
    // Per-session serialization is handled by the pipeline's LaneQueue.
    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  // Handle edited messages (message_changed subtype)
  app.message(async ({ message, client }) => {
    const msg = message as unknown as Record<string, unknown>;
    if (msg.subtype !== "message_changed") return;

    // Extract the edited message from the nested structure
    const editedMsg = msg.message as { user?: string; text?: string; ts?: string; thread_ts?: string } | undefined;
    if (!editedMsg || !editedMsg.user || !editedMsg.ts) return;

    // Skip bot's own messages
    if (config.botUserId && editedMsg.user === config.botUserId) return;

    let senderName = editedMsg.user;
    try {
      const userInfo = await client.users.info({ user: editedMsg.user });
      if (userInfo.user) {
        senderName =
          userInfo.user.profile?.display_name ||
          userInfo.user.real_name ||
          userInfo.user.name ||
          editedMsg.user;
      }
    } catch {
      // Fall back to user ID
    }

    const channel = (msg.channel ?? "") as string;
    const channelType = (msg.channel_type ?? "channel") as string;
    const chatType = resolveChatType(channelType);

    const unified: UnifiedMessage = {
      id: editedMsg.ts,
      channel: "slack",
      senderId: makeSenderId(editedMsg.user),
      senderName,
      text: editedMsg.text ?? "",
      chatType: editedMsg.thread_ts ? "thread" : chatType,
      chatId: channel,
      threadId: editedMsg.thread_ts,
      isEdited: true,
      timestamp: parseSlackTs(editedMsg.ts),
      raw: msg,
    };

    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  // Handle app_mention events (when bot is @mentioned in channels)
  app.event("app_mention", async ({ event, client }) => {
    if (!event.user) return;
    if (config.botUserId && event.user === config.botUserId) return;

    let senderName = event.user;
    try {
      const userInfo = await client.users.info({ user: event.user });
      if (userInfo.user) {
        senderName =
          userInfo.user.profile?.display_name ||
          userInfo.user.real_name ||
          userInfo.user.name ||
          event.user;
      }
    } catch {
      // Fall back to user ID
    }

    let unified: UnifiedMessage = {
      id: event.ts,
      channel: "slack",
      senderId: makeSenderId(event.user),
      senderName,
      text: event.text ?? "",
      chatType: event.thread_ts ? "thread" : "group",
      chatId: event.channel,
      threadId: event.thread_ts,
      replyToId: undefined,
      timestamp: parseSlackTs(event.ts),
      raw: event,
    };

    // Detect thread replies: thread_ts present and different from the message's own ts
    if (event.thread_ts && event.thread_ts !== event.ts) {
      try {
        const parentResult = await client.conversations.history({
          channel: event.channel,
          latest: event.thread_ts,
          inclusive: true,
          limit: 1,
        });
        const parentMsg = parentResult.messages?.[0];
        if (parentMsg) {
          unified = {
            ...unified,
            replyToId: event.thread_ts,
            replyTo: {
              messageId: event.thread_ts,
              text: parentMsg.text ? parentMsg.text.slice(0, 500) : undefined,
              senderId: parentMsg.user || parentMsg.bot_id || undefined,
              senderName: undefined,
            },
          };
        }
      } catch {
        // Fallback: set replyTo with just the thread_ts
        unified = {
          ...unified,
          replyToId: event.thread_ts,
          replyTo: { messageId: event.thread_ts },
        };
      }
    }

    // Fire-and-forget: don't block Bolt's event loop.
    // Per-session serialization is handled by the pipeline's LaneQueue.
    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  // Handle reaction_added events
  app.event("reaction_added", async ({ event }) => {
    if (!event.user) return;
    if (config.botUserId && event.user === config.botUserId) return;

    const unified: UnifiedMessage = {
      id: `reaction-${event.event_ts}`,
      channel: "slack",
      senderId: makeSenderId(event.user),
      senderName: event.user,
      text: "",
      chatType: "group",
      chatId: event.item.channel,
      reaction: {
        emoji: event.reaction,
        messageId: (event.item as { ts?: string }).ts ?? "",
        action: "add",
      },
      timestamp: parseSlackTs(event.event_ts),
      raw: event,
    };

    // Fire-and-forget: don't block Bolt's event loop.
    // Per-session serialization is handled by the pipeline's LaneQueue.
    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  // Handle reaction_removed events
  app.event("reaction_removed", async ({ event }) => {
    if (!event.user) return;
    if (config.botUserId && event.user === config.botUserId) return;

    const unified: UnifiedMessage = {
      id: `reaction-${event.event_ts}`,
      channel: "slack",
      senderId: makeSenderId(event.user),
      senderName: event.user,
      text: "",
      chatType: "group",
      chatId: event.item.channel,
      reaction: {
        emoji: event.reaction,
        messageId: (event.item as { ts?: string }).ts ?? "",
        action: "remove",
      },
      timestamp: parseSlackTs(event.event_ts),
      raw: event,
    };

    // Fire-and-forget: don't block Bolt's event loop.
    // Per-session serialization is handled by the pipeline's LaneQueue.
    for (const l of listeners) {
      void Promise.resolve(l(unified)).catch(() => {});
    }
  });

  return app;
}

function resolveChatType(channelType?: string): ChatType {
  switch (channelType) {
    case "im":
      return "dm";
    case "mpim":
    case "group":
    case "channel":
      return "group";
    default:
      return "group";
  }
}

function normalizeSlackMessage(
  msg: GenericMessageEvent,
  senderName: string,
  chatType: ChatType,
): UnifiedMessage | null {
  if (!msg.user) return null;

  return {
    id: msg.ts,
    channel: "slack",
    senderId: makeSenderId(msg.user),
    senderName,
    text: msg.text ?? "",
    chatType: msg.thread_ts ? "thread" : chatType,
    chatId: msg.channel,
    threadId: msg.thread_ts,
    replyToId: undefined,
    media: extractMedia(msg),
    timestamp: parseSlackTs(msg.ts),
    raw: msg,
  };
}

interface SlackFileInfo {
  type: "document" | "photo" | "video" | "audio";
  url: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

function extractMedia(msg: GenericMessageEvent): SlackFileInfo[] | undefined {
  const files = (msg as unknown as { files?: Array<{ url_private: string; name: string; mimetype: string; size: number }> }).files;
  if (!files || files.length === 0) return undefined;

  return files.map((f) => ({
    type: resolveMediaType(f.mimetype),
    url: f.url_private,
    filename: f.name,
    mimeType: f.mimetype,
    sizeBytes: f.size,
  }));
}

function resolveMediaType(mimetype: string): "document" | "photo" | "video" | "audio" {
  if (mimetype.startsWith("image/")) return "photo";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Parse a Slack timestamp (e.g. "1234567890.123456") into ms epoch.
 */
function parseSlackTs(ts: string): number {
  return Math.floor(parseFloat(ts) * 1000);
}
