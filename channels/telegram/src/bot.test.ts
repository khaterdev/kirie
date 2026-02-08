import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UnifiedMessage, MessageListener } from "@kirie/core";

// Mock the Grammy Bot class
const mockOn = vi.fn();
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: mockOn,
    start: vi.fn(),
    stop: vi.fn(),
    api: {},
  })),
}));

import { createBot } from "./bot.js";

describe("Telegram bot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a bot and registers a message handler", () => {
    const listeners: MessageListener[] = [];
    createBot({ token: "test-token" }, listeners);

    expect(mockOn).toHaveBeenCalledWith(
      ["message", "edited_message"],
      expect.any(Function),
    );
  });

  it("skips messages from the bot itself", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: 999 }, [listener]);

    // Get the handler that was registered
    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    // Feed a message from the bot itself
    await handler({
      message: {
        message_id: 1,
        date: 1700000000,
        from: { id: 999, first_name: "Bot" },
        chat: { id: 100, type: "private" },
        text: "echo",
      },
      editedMessage: undefined,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes a private text message into UnifiedMessage", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token", botId: 999 }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 42,
        date: 1700000000,
        from: { id: 123, first_name: "Alice", last_name: "Smith", username: "asmith" },
        chat: { id: 500, type: "private" },
        text: "Hello Kirie",
      },
      editedMessage: undefined,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.id).toBe("42");
    expect(msg.channel).toBe("telegram");
    expect(msg.senderId).toBe("123");
    expect(msg.senderName).toBe("Alice Smith");
    expect(msg.text).toBe("Hello Kirie");
    expect(msg.chatType).toBe("dm");
    expect(msg.chatId).toBe("500");
    expect(msg.timestamp).toBe(1700000000000);
  });

  it("normalizes a group message", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 10,
        date: 1700000000,
        from: { id: 456, first_name: "Bob", username: "bob" },
        chat: { id: -1001234, type: "supergroup" },
        text: "Hey",
      },
      editedMessage: undefined,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("group");
    expect(msg.chatId).toBe("-1001234");
    expect(msg.senderName).toBe("Bob");
  });

  it("maps 'group' chat type correctly", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 11,
        date: 1700000000,
        from: { id: 789, first_name: "Carol" },
        chat: { id: -555, type: "group" },
        text: "Hi",
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("group");
  });

  it("includes threadId when message_thread_id is present", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 20,
        date: 1700000000,
        from: { id: 111, first_name: "Dave" },
        chat: { id: -100, type: "supergroup" },
        text: "threaded",
        message_thread_id: 99,
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.threadId).toBe("99");
  });

  it("includes replyToId when reply_to_message is present", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 30,
        date: 1700000000,
        from: { id: 222, first_name: "Eve" },
        chat: { id: -200, type: "group" },
        text: "reply",
        reply_to_message: { message_id: 25 },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.replyToId).toBe("25");
  });

  it("populates replyTo with text and sender from reply_to_message", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 31,
        date: 1700000000,
        from: { id: 222, first_name: "Eve" },
        chat: { id: -200, type: "group" },
        text: "I agree!",
        reply_to_message: {
          message_id: 25,
          text: "What do you think?",
          from: { id: 100, first_name: "Alice", last_name: "Smith" },
        },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.replyToId).toBe("25");
    expect(msg.replyTo).toEqual({
      messageId: "25",
      text: "What do you think?",
      senderId: "100",
      senderName: "Alice Smith",
    });
  });

  it("uses caption as replyTo text for media replies", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 32,
        date: 1700000000,
        from: { id: 222, first_name: "Eve" },
        chat: { id: -200, type: "group" },
        text: "Nice photo!",
        reply_to_message: {
          message_id: 26,
          caption: "Sunset at the beach",
          from: { id: 101, first_name: "Bob" },
        },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.replyTo).toBeDefined();
    expect(msg.replyTo!.messageId).toBe("26");
    expect(msg.replyTo!.text).toBe("Sunset at the beach");
    expect(msg.replyTo!.senderId).toBe("101");
    expect(msg.replyTo!.senderName).toBe("Bob");
  });

  it("sets replyTo.text to undefined when reply has no text or caption", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 33,
        date: 1700000000,
        from: { id: 222, first_name: "Eve" },
        chat: { id: -200, type: "group" },
        text: "What was that?",
        reply_to_message: {
          message_id: 27,
          from: { id: 102, first_name: "Carol", last_name: "Jones" },
        },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.replyTo).toBeDefined();
    expect(msg.replyTo!.messageId).toBe("27");
    expect(msg.replyTo!.text).toBeUndefined();
    expect(msg.replyTo!.senderId).toBe("102");
    expect(msg.replyTo!.senderName).toBe("Carol Jones");
  });

  it("extracts photo media with largest size", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 40,
        date: 1700000000,
        from: { id: 333, first_name: "Frank" },
        chat: { id: 600, type: "private" },
        caption: "Look at this",
        photo: [
          { file_id: "small", file_size: 100 },
          { file_id: "medium", file_size: 500 },
          { file_id: "large", file_size: 2000 },
        ],
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.text).toBe("Look at this");
    expect(msg.media).toBeDefined();
    expect(msg.media![0]!.type).toBe("photo");
    expect(msg.media![0]!.url).toBe("large");
  });

  it("extracts video media", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 41,
        date: 1700000000,
        from: { id: 444, first_name: "Grace" },
        chat: { id: 700, type: "private" },
        video: {
          file_id: "vid-123",
          file_name: "clip.mp4",
          mime_type: "video/mp4",
          file_size: 50000,
        },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.media).toBeDefined();
    expect(msg.media![0]!.type).toBe("video");
    expect(msg.media![0]!.url).toBe("vid-123");
  });

  it("extracts document media", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 42,
        date: 1700000000,
        from: { id: 555, first_name: "Hank" },
        chat: { id: 800, type: "private" },
        document: {
          file_id: "doc-456",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 100000,
        },
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.media).toBeDefined();
    expect(msg.media![0]!.type).toBe("document");
    expect(msg.media![0]!.filename).toBe("report.pdf");
  });

  it("handles edited messages via editedMessage", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: undefined,
      editedMessage: {
        message_id: 50,
        date: 1700000000,
        from: { id: 666, first_name: "Ivy" },
        chat: { id: 900, type: "private" },
        text: "corrected text",
      },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.text).toBe("corrected text");
  });

  it("skips messages with no from field", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 60,
        date: 1700000000,
        from: undefined,
        chat: { id: 1000, type: "private" },
        text: "system msg",
      },
      editedMessage: undefined,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("skips context with no message or editedMessage", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: undefined,
      editedMessage: undefined,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("uses caption as text when msg.text is absent", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 70,
        date: 1700000000,
        from: { id: 777, first_name: "Jack" },
        chat: { id: 1100, type: "private" },
        caption: "photo caption",
        photo: [{ file_id: "pic", file_size: 100 }],
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.text).toBe("photo caption");
  });

  it("falls back to @username when first_name is empty", async () => {
    const listener = vi.fn();
    createBot({ token: "test-token" }, [listener]);

    const handler = mockOn.mock.calls[0]![1] as (ctx: unknown) => Promise<void>;

    await handler({
      message: {
        message_id: 80,
        date: 1700000000,
        from: { id: 888, first_name: "", username: "testbot" },
        chat: { id: 1200, type: "private" },
        text: "test",
      },
      editedMessage: undefined,
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.senderName).toBe("@testbot");
  });
});
