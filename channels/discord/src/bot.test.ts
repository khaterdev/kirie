import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UnifiedMessage, MessageListener } from "@kirie/core";

// Mock discord.js
const mockClientOn = vi.fn();
vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockClientOn,
    login: vi.fn(),
    destroy: vi.fn(),
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    GuildMessageReactions: 4,
    DirectMessages: 8,
    DirectMessageReactions: 16,
    MessageContent: 32,
  },
  Partials: {
    Channel: 0,
    Message: 1,
    Reaction: 2,
  },
  ChannelType: {
    DM: 1,
    GroupDM: 3,
    GuildText: 0,
    PublicThread: 11,
    PrivateThread: 12,
    AnnouncementThread: 10,
  },
}));

import { createBot } from "./bot.js";
import { ChannelType } from "discord.js";

describe("Discord bot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a client and registers messageCreate handler", () => {
    createBot({ token: "test-token", botId: "bot-123" }, []);

    expect(mockClientOn).toHaveBeenCalledWith("messageCreate", expect.any(Function));
  });

  it("ignores messages from bots", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "1",
      author: { bot: true, id: "bot-123", displayName: "Bot", username: "bot" },
      content: "self message",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-1",
      attachments: new Map(),
      createdTimestamp: Date.now(),
      reference: null,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes a DM message", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-42",
      author: { bot: false, id: "user-1", displayName: "Alice", username: "alice" },
      member: null,
      content: "Hello from DM",
      channel: { type: ChannelType.DM, messages: { fetch: vi.fn() } },
      channelId: "dm-ch-1",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.id).toBe("msg-42");
    expect(msg.channel).toBe("discord");
    expect(msg.senderId).toBe("user-1");
    expect(msg.senderName).toBe("Alice");
    expect(msg.text).toBe("Hello from DM");
    expect(msg.chatType).toBe("dm");
    expect(msg.chatId).toBe("dm-ch-1");
    expect(msg.timestamp).toBe(1700000000000);
  });

  it("normalizes a guild text channel message", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-100",
      author: { bot: false, id: "user-2", displayName: "Bob", username: "bob" },
      member: { displayName: "Bob (Server)" },
      content: "Guild message",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "guild-ch-1",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("group");
    expect(msg.chatId).toBe("guild-ch-1");
    expect(msg.senderName).toBe("Bob (Server)");
  });

  it("normalizes a thread message with parentId", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-200",
      author: { bot: false, id: "user-3", displayName: "Carol", username: "carol" },
      member: null,
      content: "Thread reply",
      channel: { type: ChannelType.PublicThread, parentId: "parent-ch-1", messages: { fetch: vi.fn() } },
      channelId: "thread-ch-1",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("thread");
    expect(msg.chatId).toBe("parent-ch-1");
    expect(msg.threadId).toBe("thread-ch-1");
  });

  it("strips bot mention from message content", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-300",
      author: { bot: false, id: "user-4", displayName: "Dave", username: "dave" },
      member: null,
      content: "<@bot-123> what is the weather?",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-2",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.text).toBe("what is the weather?");
  });

  it("strips bot mention with ! format", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-301",
      author: { bot: false, id: "user-5", displayName: "Eve", username: "eve" },
      member: null,
      content: "<@!bot-123> hello",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-3",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.text).toBe("hello");
  });

  it("includes replyToId from message reference", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-400",
      author: { bot: false, id: "user-6", displayName: "Frank", username: "frank" },
      member: null,
      content: "replying",
      channel: {
        type: ChannelType.GuildText,
        messages: {
          fetch: vi.fn().mockResolvedValue({
            content: "original message",
            author: { id: "user-0", displayName: "OrigAuthor", username: "origauthor" },
          }),
        },
      },
      channelId: "ch-4",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: { messageId: "msg-399" },
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.replyToId).toBe("msg-399");
  });

  it("extracts image attachments as photo media", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    const attachments = new Map([
      ["att-1", {
        url: "https://cdn.discord.com/image.png",
        name: "image.png",
        contentType: "image/png",
        size: 5000,
      }],
    ]);

    await handler({
      id: "msg-500",
      author: { bot: false, id: "user-7", displayName: "Grace", username: "grace" },
      member: null,
      content: "check this image",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-5",
      attachments,
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.media).toBeDefined();
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0]!.type).toBe("photo");
    expect(msg.media![0]!.url).toBe("https://cdn.discord.com/image.png");
  });

  it("classifies gif attachments as animation", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    const attachments = new Map([
      ["att-2", {
        url: "https://cdn.discord.com/anim.gif",
        name: "anim.gif",
        contentType: "image/gif",
        size: 3000,
      }],
    ]);

    await handler({
      id: "msg-501",
      author: { bot: false, id: "user-8", displayName: "Hank", username: "hank" },
      member: null,
      content: "gif",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-6",
      attachments,
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.media![0]!.type).toBe("animation");
  });

  it("skips empty messages with no attachments", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-600",
      author: { bot: false, id: "user-9", displayName: "Ivy", username: "ivy" },
      member: null,
      content: "",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-7",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("uses member displayName over author displayName", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: "bot-123" }, [listener]);

    const handler = mockClientOn.mock.calls.find(
      (c: unknown[]) => c[0] === "messageCreate",
    )![1] as (msg: unknown) => Promise<void>;

    await handler({
      id: "msg-700",
      author: { bot: false, id: "user-10", displayName: "Author Name", username: "user10" },
      member: { displayName: "Server Nickname" },
      content: "hi",
      channel: { type: ChannelType.GuildText, messages: { fetch: vi.fn() } },
      channelId: "ch-8",
      attachments: new Map(),
      createdTimestamp: 1700000000000,
      reference: null,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.senderName).toBe("Server Nickname");
  });
});
