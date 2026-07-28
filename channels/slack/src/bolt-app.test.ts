import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UnifiedMessage } from "@kirie/core";

// Capture registered handlers
const messageHandler = vi.fn();
const eventHandler = vi.fn();

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    message: (handler: unknown) => messageHandler(handler),
    event: (name: string, handler: unknown) => eventHandler(name, handler),
    client: {},
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

import { createBoltApp } from "./bolt-app.js";

describe("Slack bolt-app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an app and registers message + app_mention handlers", () => {
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [],
    );

    expect(messageHandler).toHaveBeenCalledTimes(2);
    expect(eventHandler).toHaveBeenCalledWith("app_mention", expect.any(Function));
  });

  it("normalizes a DM message", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000000.123456",
        user: "U-ALICE",
        text: "Hello from Slack",
        channel: "D12345",
        channel_type: "im",
      },
      client: {
        users: {
          info: vi.fn().mockResolvedValue({
            user: {
              profile: { display_name: "Alice" },
              real_name: "Alice Smith",
              name: "alice",
            },
          }),
        },
      },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.id).toBe("1700000000.123456");
    expect(msg.channel).toBe("slack");
    expect(msg.senderId).toBe("U-ALICE");
    expect(msg.senderName).toBe("Alice");
    expect(msg.text).toBe("Hello from Slack");
    expect(msg.chatType).toBe("dm");
    expect(msg.chatId).toBe("D12345");
    expect(msg.timestamp).toBe(1700000000123);
  });

  it("normalizes a channel (group) message", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000001.000000",
        user: "U-BOB",
        text: "Group hello",
        channel: "C12345",
        channel_type: "channel",
      },
      client: {
        users: {
          info: vi.fn().mockResolvedValue({
            user: {
              profile: {},
              real_name: "Bob Jones",
              name: "bob",
            },
          }),
        },
      },
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("group");
    expect(msg.senderName).toBe("Bob Jones");
  });

  it("skips messages with subtype (message_changed, etc.)", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000002.000000",
        user: "U-CAROL",
        text: "edited",
        channel: "C12345",
        channel_type: "channel",
        subtype: "message_changed",
      },
      client: { users: { info: vi.fn() } },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("skips messages without a user field", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000003.000000",
        text: "system",
        channel: "C12345",
        channel_type: "channel",
      },
      client: { users: { info: vi.fn() } },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("skips bot's own messages", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test", botUserId: "U-BOT" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000004.000000",
        user: "U-BOT",
        text: "echo",
        channel: "C12345",
        channel_type: "channel",
      },
      client: { users: { info: vi.fn() } },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("includes threadId from thread_ts", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000005.000100",
        user: "U-DAVE",
        text: "thread reply",
        channel: "C12345",
        channel_type: "channel",
        thread_ts: "1700000000.000000",
      },
      client: {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: "dave" },
          }),
        },
      },
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.chatType).toBe("thread");
    expect(msg.threadId).toBe("1700000000.000000");
  });

  it("extracts file attachments as media", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000006.000000",
        user: "U-EVE",
        text: "here is a file",
        channel: "C12345",
        channel_type: "channel",
        files: [
          {
            url_private: "https://files.slack.com/file1.png",
            name: "file1.png",
            mimetype: "image/png",
            size: 5000,
          },
        ],
      },
      client: {
        users: {
          info: vi.fn().mockResolvedValue({
            user: { name: "eve" },
          }),
        },
      },
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.media).toBeDefined();
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0]!.type).toBe("photo");
    expect(msg.media![0]!.url).toBe("https://files.slack.com/file1.png");
  });

  it("falls back to user ID as name when user info lookup fails", async () => {
    const listener = vi.fn();
    createBoltApp(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      [listener],
    );

    const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

    await handler({
      message: {
        ts: "1700000007.000000",
        user: "U-FRANK",
        text: "hi",
        channel: "D99999",
        channel_type: "im",
      },
      client: {
        users: {
          info: vi.fn().mockRejectedValue(new Error("user_not_found")),
        },
      },
    });

    const msg: UnifiedMessage = listener.mock.calls[0]![0];
    expect(msg.senderName).toBe("U-FRANK");
  });

  describe("app_mention handler", () => {
    it("normalizes an app_mention event", async () => {
      const listener = vi.fn();
      createBoltApp(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        [listener],
      );

      const mentionHandler = eventHandler.mock.calls.find(
        (c: unknown[]) => c[0] === "app_mention",
      )![1] as (args: unknown) => Promise<void>;

      await mentionHandler({
        event: {
          ts: "1700000010.000000",
          user: "U-GRACE",
          text: "<@UBOT> what is up",
          channel: "C55555",
          thread_ts: undefined,
        },
        client: {
          users: {
            info: vi.fn().mockResolvedValue({
              user: {
                profile: { display_name: "Grace" },
                real_name: "Grace H",
                name: "grace",
              },
            }),
          },
        },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const msg: UnifiedMessage = listener.mock.calls[0]![0];
      expect(msg.channel).toBe("slack");
      expect(msg.senderId).toBe("U-GRACE");
      expect(msg.senderName).toBe("Grace");
      expect(msg.chatType).toBe("group");
      expect(msg.chatId).toBe("C55555");
    });

    it("sets chatType to thread when thread_ts is present", async () => {
      const listener = vi.fn();
      createBoltApp(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        [listener],
      );

      const mentionHandler = eventHandler.mock.calls.find(
        (c: unknown[]) => c[0] === "app_mention",
      )![1] as (args: unknown) => Promise<void>;

      await mentionHandler({
        event: {
          ts: "1700000011.000100",
          user: "U-HANK",
          text: "mention in thread",
          channel: "C66666",
          thread_ts: "1700000010.000000",
        },
        client: {
          users: {
            info: vi.fn().mockResolvedValue({
              user: { name: "hank" },
            }),
          },
        },
      });

      const msg: UnifiedMessage = listener.mock.calls[0]![0];
      expect(msg.chatType).toBe("thread");
      expect(msg.threadId).toBe("1700000010.000000");
    });

    it("skips bot's own app_mention events", async () => {
      const listener = vi.fn();
      createBoltApp(
        { botToken: "xoxb-test", appToken: "xapp-test", botUserId: "U-BOT" },
        [listener],
      );

      const mentionHandler = eventHandler.mock.calls.find(
        (c: unknown[]) => c[0] === "app_mention",
      )![1] as (args: unknown) => Promise<void>;

      await mentionHandler({
        event: {
          ts: "1700000012.000000",
          user: "U-BOT",
          text: "self mention",
          channel: "C77777",
        },
        client: { users: { info: vi.fn() } },
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("mpim channel type", () => {
    it("maps mpim to group", async () => {
      const listener = vi.fn();
      createBoltApp(
        { botToken: "xoxb-test", appToken: "xapp-test" },
        [listener],
      );

      const handler = messageHandler.mock.calls[0]![0] as (args: unknown) => Promise<void>;

      await handler({
        message: {
          ts: "1700000008.000000",
          user: "U-IVY",
          text: "mpim msg",
          channel: "G12345",
          channel_type: "mpim",
        },
        client: {
          users: {
            info: vi.fn().mockResolvedValue({
              user: { name: "ivy" },
            }),
          },
        },
      });

      const msg: UnifiedMessage = listener.mock.calls[0]![0];
      expect(msg.chatType).toBe("group");
    });
  });
});
