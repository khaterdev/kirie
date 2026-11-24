import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock discord.js before importing adapter
const mockChannelSend = vi.fn();
const mockChannelFetch = vi.fn();
vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    login: vi.fn(),
    destroy: vi.fn(),
    channels: {
      fetch: mockChannelFetch,
    },
  })),
  GatewayIntentBits: {
    Guilds: 1, GuildMessages: 2, GuildMessageReactions: 4,
    DirectMessages: 8, DirectMessageReactions: 16, MessageContent: 32,
  },
  Partials: { Channel: 0, Message: 1, Reaction: 2 },
  AttachmentBuilder: vi.fn(),
}));

import { DiscordAdapter } from "./adapter.js";

describe("DiscordAdapter: a user id is sent to that user's DM channel (CORE-N4)", () => {
  it("falls back to users.fetch().createDM() and reports the DM channel id", async () => {
    const adapter = new DiscordAdapter({ token: "test-token" });
    const dmSend = vi.fn().mockResolvedValue({ id: "m-1", createdTimestamp: 1 });
    const createDM = vi.fn().mockResolvedValue({ id: "dm-999", send: dmSend });
    const usersFetch = vi.fn().mockResolvedValue({ createDM });
    (adapter as any).state = "connected";
    (adapter as any).client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("Unknown Channel")) },
      users: { fetch: usersFetch },
      destroy: vi.fn(),
    };
    const sent = await adapter.sendText({ ctx: { chatId: "123456789012345678" }, text: "hi" });
    expect(usersFetch).toHaveBeenCalledWith("123456789012345678");
    expect(dmSend).toHaveBeenCalledWith({ content: "hi" });
    expect(sent).toEqual([{ id: "m-1", timestamp: 1, chatId: "dm-999" }]);
    // Cached: the DM is opened once.
    await adapter.sendText({ ctx: { chatId: "123456789012345678" }, text: "again" });
    expect(createDM).toHaveBeenCalledTimes(1);
  });

  it("keeps the original error for an id that is neither a channel nor a user", async () => {
    const adapter = new DiscordAdapter({ token: "test-token" });
    (adapter as any).state = "connected";
    (adapter as any).client = {
      channels: { fetch: vi.fn().mockRejectedValue(new Error("Unknown Channel")) },
      users: { fetch: vi.fn().mockRejectedValue(new Error("Unknown User")) },
      destroy: vi.fn(),
    };
    await expect(adapter.sendText({ ctx: { chatId: "123456789012345678" }, text: "hi" })).rejects.toThrow("Unknown Channel");
  });
});

describe("DiscordAdapter.sendText reply fallback", () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter({ token: "test-token" });

    // Set internal state to connected so sendText works
    (adapter as any).state = "connected";
    (adapter as any).client = {
      channels: { fetch: mockChannelFetch },
      destroy: vi.fn(),
    };

    mockChannelFetch.mockResolvedValue({
      send: mockChannelSend,
    });
  });

  it("sends message with reply when replyToId is provided", async () => {
    mockChannelSend.mockResolvedValue({ id: "sent-1", createdTimestamp: 1000 });

    const result = await adapter.sendText({
      ctx: { chatId: "ch-1", replyToId: "msg-42" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sent-1");

    // First call should include the reply parameter
    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(mockChannelSend.mock.calls[0]![0]).toEqual({
      content: "Hello",
      reply: { messageReference: "msg-42" },
    });
  });

  it("falls back to sending without reply when reply fails", async () => {
    // First call (with reply) fails, second call (without reply) succeeds
    mockChannelSend
      .mockRejectedValueOnce(new Error("Unknown Message"))
      .mockResolvedValueOnce({ id: "sent-2", createdTimestamp: 2000 });

    const result = await adapter.sendText({
      ctx: { chatId: "ch-1", replyToId: "msg-deleted" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sent-2");
    expect(mockChannelSend).toHaveBeenCalledTimes(2);

    // Second call should NOT include the reply parameter
    expect(mockChannelSend.mock.calls[1]![0]).toEqual({ content: "Hello" });
  });

  it("sends message without reply when no replyToId", async () => {
    mockChannelSend.mockResolvedValue({ id: "sent-3", createdTimestamp: 3000 });

    const result = await adapter.sendText({
      ctx: { chatId: "ch-1" },
      text: "No reply",
    });

    expect(result).toHaveLength(1);
    expect(mockChannelSend).toHaveBeenCalledTimes(1);
    expect(mockChannelSend.mock.calls[0]![0]).toEqual({ content: "No reply" });
  });

  it("propagates error when fallback send also fails", async () => {
    mockChannelSend
      .mockRejectedValueOnce(new Error("Reply failed"))
      .mockRejectedValueOnce(new Error("Channel not found"));

    await expect(
      adapter.sendText({
        ctx: { chatId: "ch-1", replyToId: "msg-bad" },
        text: "Hello",
      }),
    ).rejects.toThrow("Channel not found");

    expect(mockChannelSend).toHaveBeenCalledTimes(2);
  });

  it("only applies reply to the first chunk in multi-chunk messages", async () => {
    mockChannelSend.mockResolvedValue({ id: "sent-4", createdTimestamp: 4000 });

    // Create a message longer than 2000 chars to trigger chunking
    const longText = "A".repeat(2001);

    const result = await adapter.sendText({
      ctx: { chatId: "ch-1", replyToId: "msg-100" },
      text: longText,
    });

    expect(result).toHaveLength(2);
    // First chunk should have reply
    expect(mockChannelSend.mock.calls[0]![0]).toHaveProperty("reply");
    // Second chunk should NOT have reply
    expect(mockChannelSend.mock.calls[1]![0]).not.toHaveProperty("reply");
  });
});
