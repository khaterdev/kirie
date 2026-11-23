import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelRegistry } from "./registry.js";
import { resetScrubberForTesting } from "../security/secret-scrubber.js";
import type { ChannelAdapter, ChannelStatus, SentMessage } from "./adapter.js";
import type { ChannelName, MessageListener } from "./normalizer.js";

/** Create a minimal mock adapter for testing the registry */
function createMockAdapter(id: ChannelName = "mock", overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  let running = false;
  return {
    id,
    capabilities: {
      sendMedia: false,
      sendReaction: false,
      editMessage: false,
      deleteMessage: false,
      sendTyping: true,
      threads: false,
      multipleImages: false,
      reactions: false,
      replyContext: false,
      voiceMessages: false,
      maxTextLength: 4000,
    },
    async start(_signal: AbortSignal) {
      running = true;
    },
    async stop() {
      running = false;
    },
    getStatus(): ChannelStatus {
      return {
        state: running ? "connected" : "disconnected",
        failureCount: 0,
      };
    },
    onMessage(_listener: MessageListener) {},
    async sendText(): Promise<SentMessage[]> {
      return [{ id: "sent-1", timestamp: Date.now() }];
    },
    async sendTyping() {},
    ...overrides,
  };
}

describe("ChannelRegistry", () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe("register / unregister", () => {
    it("registers an adapter", () => {
      const adapter = createMockAdapter("telegram");
      registry.register(adapter);
      const got = registry.getById("telegram");
      expect(got).toBeDefined();
      expect(got!.id).toBe("telegram");
      expect(got!.capabilities).toBe(adapter.capabilities);
      expect(registry.size).toBe(1);
    });

    it("throws when registering duplicate id", () => {
      registry.register(createMockAdapter("telegram"));
      expect(() => registry.register(createMockAdapter("telegram"))).toThrow(
        'Channel "telegram" is already registered',
      );
    });

    it("unregisters an adapter", async () => {
      registry.register(createMockAdapter("telegram"));
      const removed = await registry.unregister("telegram");
      expect(removed).toBe(true);
      expect(registry.getById("telegram")).toBeUndefined();
      expect(registry.size).toBe(0);
    });

    it("returns false when unregistering non-existent adapter", async () => {
      expect(await registry.unregister("nonexistent")).toBe(false);
    });

    it("stops a running adapter before unregistering", async () => {
      const stopSpy = vi.fn();
      const adapter = createMockAdapter("telegram", { stop: stopSpy });
      registry.register(adapter);
      await registry.start("telegram");
      await registry.unregister("telegram");
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("start / stop", () => {
    it("starts an adapter", async () => {
      const startSpy = vi.fn();
      const adapter = createMockAdapter("telegram", { start: startSpy });
      registry.register(adapter);
      await registry.start("telegram");
      expect(startSpy).toHaveBeenCalled();
      expect(registry.isRunning("telegram")).toBe(true);
    });

    it("is idempotent - starting an already running adapter is a no-op", async () => {
      const startSpy = vi.fn();
      const adapter = createMockAdapter("telegram", { start: startSpy });
      registry.register(adapter);
      await registry.start("telegram");
      await registry.start("telegram");
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it("throws when starting unregistered adapter", async () => {
      await expect(registry.start("nonexistent")).rejects.toThrow(
        'Channel "nonexistent" is not registered',
      );
    });

    it("stops an adapter", async () => {
      const stopSpy = vi.fn();
      const adapter = createMockAdapter("telegram", { stop: stopSpy });
      registry.register(adapter);
      await registry.start("telegram");
      await registry.stop("telegram");
      expect(stopSpy).toHaveBeenCalled();
      expect(registry.isRunning("telegram")).toBe(false);
    });

    it("stopping an already stopped adapter is a no-op", async () => {
      const stopSpy = vi.fn();
      const adapter = createMockAdapter("telegram", { stop: stopSpy });
      registry.register(adapter);
      await registry.stop("telegram");
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it("throws when stopping unregistered adapter", async () => {
      await expect(registry.stop("nonexistent")).rejects.toThrow(
        'Channel "nonexistent" is not registered',
      );
    });

    it("emits error event when start fails", async () => {
      const adapter = createMockAdapter("telegram", {
        start: async () => {
          throw new Error("Connection failed");
        },
      });
      registry.register(adapter);

      const errorHandler = vi.fn();
      registry.on("error", errorHandler);

      await expect(registry.start("telegram")).rejects.toThrow("Connection failed");
      expect(errorHandler).toHaveBeenCalledWith("telegram", expect.any(Error));
      expect(registry.isRunning("telegram")).toBe(false);
    });

    it("passes AbortSignal to adapter.start()", async () => {
      let receivedSignal: AbortSignal | null = null;
      const adapter = createMockAdapter("telegram", {
        start: async (signal: AbortSignal) => {
          receivedSignal = signal;
        },
      });
      registry.register(adapter);
      await registry.start("telegram");
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("startAll / stopAll", () => {
    it("starts all registered adapters", async () => {
      registry.register(createMockAdapter("telegram"));
      registry.register(createMockAdapter("discord"));
      registry.register(createMockAdapter("slack"));

      const errors = await registry.startAll();
      expect(errors.size).toBe(0);
      expect(registry.getRunning()).toHaveLength(3);
    });

    it("collects errors without failing other adapters", async () => {
      registry.register(createMockAdapter("telegram"));
      registry.register(
        createMockAdapter("discord", {
          start: async () => {
            throw new Error("Discord failed");
          },
        }),
      );
      registry.register(createMockAdapter("slack"));

      const errors = await registry.startAll();
      expect(errors.size).toBe(1);
      expect(errors.get("discord")?.message).toBe("Discord failed");
      expect(registry.isRunning("telegram")).toBe(true);
      expect(registry.isRunning("discord")).toBe(false);
      expect(registry.isRunning("slack")).toBe(true);
    });

    it("stops all running adapters", async () => {
      registry.register(createMockAdapter("telegram"));
      registry.register(createMockAdapter("discord"));
      await registry.startAll();

      const errors = await registry.stopAll();
      expect(errors.size).toBe(0);
      expect(registry.getRunning()).toHaveLength(0);
    });

    it("collects stop errors without failing other adapters", async () => {
      registry.register(createMockAdapter("telegram"));
      registry.register(
        createMockAdapter("discord", {
          stop: async () => {
            throw new Error("Discord stop failed");
          },
        }),
      );
      await registry.startAll();

      const errors = await registry.stopAll();
      expect(errors.size).toBe(1);
      expect(errors.get("discord")?.message).toBe("Discord stop failed");
    });
  });

  describe("getAll / getById / getRunning", () => {
    it("getAll returns a map of all adapters", () => {
      const tg = createMockAdapter("telegram");
      const dc = createMockAdapter("discord");
      registry.register(tg);
      registry.register(dc);

      const all = registry.getAll();
      expect(all.size).toBe(2);
      expect(all.get("telegram")?.id).toBe("telegram");
      expect(all.get("discord")?.id).toBe("discord");
      // getAll hands out the same filtered proxies as getById
      expect(all.get("telegram")).toBe(registry.getById("telegram"));
    });

    it("getRunning only returns started adapters", async () => {
      registry.register(createMockAdapter("telegram"));
      registry.register(createMockAdapter("discord"));
      await registry.start("telegram");

      expect(registry.getRunning()).toEqual(["telegram"]);
    });

    it("isRunning returns false for unregistered adapter", () => {
      expect(registry.isRunning("nonexistent")).toBe(false);
    });
  });

  describe("events", () => {
    it("emits registered event", () => {
      const handler = vi.fn();
      registry.on("registered", handler);
      registry.register(createMockAdapter("telegram"));
      expect(handler).toHaveBeenCalledWith("telegram");
    });

    it("emits unregistered event", async () => {
      const handler = vi.fn();
      registry.on("unregistered", handler);
      registry.register(createMockAdapter("telegram"));
      await registry.unregister("telegram");
      expect(handler).toHaveBeenCalledWith("telegram");
    });

    it("emits started event", async () => {
      const handler = vi.fn();
      registry.on("started", handler);
      registry.register(createMockAdapter("telegram"));
      await registry.start("telegram");
      expect(handler).toHaveBeenCalledWith("telegram");
    });

    it("emits stopped event", async () => {
      const handler = vi.fn();
      registry.on("stopped", handler);
      registry.register(createMockAdapter("telegram"));
      await registry.start("telegram");
      await registry.stop("telegram");
      expect(handler).toHaveBeenCalledWith("telegram");
    });

    it("can remove event listeners", () => {
      const handler = vi.fn();
      registry.on("registered", handler);
      registry.off("registered", handler);
      registry.register(createMockAdapter("telegram"));
      expect(handler).not.toHaveBeenCalled();
    });

    it("swallows listener errors without breaking registry", async () => {
      registry.on("started", () => {
        throw new Error("Listener crash");
      });
      registry.register(createMockAdapter("telegram"));
      // Should not throw despite listener error
      await expect(registry.start("telegram")).resolves.toBeUndefined();
      expect(registry.isRunning("telegram")).toBe(true);
    });
  });

  describe("outbound filter (secret scrubbing)", () => {
    const token = (): string => ["gh", "p_", "Zx8Cv7Bn6Mq5Wp4Ok3Ij2Uh1Yg0Tf9Rd8Es7Wa"].join("");
    const MARK = "«redacted:github-token»";
    const ctx = { chatId: "42" };

    beforeEach(() => resetScrubberForTesting());

    function capturingAdapter() {
      const calls: Record<string, unknown[]> = {};
      const record = (name: string) => (...args: unknown[]) => {
        calls[name] = args;
        return Promise.resolve(name === "sendMedia" ? { id: "m", timestamp: 1 } : []);
      };
      const adapter = createMockAdapter("telegram", {
        sendText: record("sendText") as unknown as ChannelAdapter["sendText"],
        editMessage: record("editMessage") as unknown as ChannelAdapter["editMessage"],
        sendMedia: record("sendMedia") as unknown as ChannelAdapter["sendMedia"],
        sendMediaBatch: record("sendMediaBatch") as unknown as ChannelAdapter["sendMediaBatch"],
        sendReaction: record("sendReaction") as unknown as ChannelAdapter["sendReaction"],
      });
      const extra = adapter as ChannelAdapter & {
        bot: { api: string };
        sendInteractive: (p: unknown) => Promise<unknown>;
        updateInteractive: (p: unknown) => Promise<unknown>;
      };
      extra.bot = { api: "raw-bot" };
      extra.sendInteractive = record("sendInteractive") as unknown as typeof extra.sendInteractive;
      extra.updateInteractive = record("updateInteractive") as unknown as typeof extra.updateInteractive;
      return { adapter: extra, calls };
    }

    it("scrubs sendText and editMessage text by default", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      const proxy = registry.getById("telegram")!;
      await proxy.sendText({ ctx, text: `here ${token()}` });
      await proxy.editMessage!({ ctx, messageId: "1", text: token() });
      expect(calls.sendText![0]).toEqual({ ctx, text: `here ${MARK}` });
      expect(calls.editMessage![0]).toEqual({ ctx, messageId: "1", text: MARK });
    });

    it("scrubs media and batch captions", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      const proxy = registry.getById("telegram")!;
      await proxy.sendMedia!({ ctx, media: { type: "photo", url: "file:///x.png", caption: token() } });
      await proxy.sendMediaBatch!({
        ctx,
        media: [
          { type: "photo", url: "file:///a.png", caption: `a ${token()}` },
          { type: "photo", url: "file:///b.png" },
        ],
      });
      expect((calls.sendMedia![0] as { media: { caption: string; url: string } }).media).toEqual({
        type: "photo", url: "file:///x.png", caption: MARK,
      });
      const batch = (calls.sendMediaBatch![0] as { media: Array<{ caption?: string }> }).media;
      expect(batch[0]!.caption).toBe(`a ${MARK}`);
      expect(batch[1]).toEqual({ type: "photo", url: "file:///b.png" });
    });

    it("scrubs interactive text and button labels, not callback data", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      const proxy = registry.getById("telegram") as typeof adapter;
      const buttons = [[{ label: `ok ${token()}`, data: "k1|ask|abc:yes" }]];
      await proxy.sendInteractive({ ctx, text: token(), buttons });
      await proxy.updateInteractive({ ctx, messageId: "9", text: `done ${token()}` });
      expect(calls.sendInteractive![0]).toEqual({ ctx, text: MARK, buttons: [[{ label: `ok ${MARK}`, data: "k1|ask|abc:yes" }]] });
      expect(calls.updateInteractive![0]).toEqual({ ctx, messageId: "9", text: `done ${MARK}` });
    });

    it("forwards other methods and properties unchanged", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      const proxy = registry.getById("telegram") as typeof adapter;
      expect(proxy.bot).toBe(adapter.bot);
      expect(proxy.capabilities).toBe(adapter.capabilities);
      await proxy.sendReaction!({ ctx, messageId: "1", emoji: token() });
      expect(calls.sendReaction![0]).toEqual({ ctx, messageId: "1", emoji: token() });
      expect(proxy.getStatus().state).toBe("disconnected");
      expect(proxy.sendText).toBe(proxy.sendText);
    });

    it("calls methods with the real adapter as this (class private fields keep working)", async () => {
      class ClassAdapter {
        readonly id = "discord" as const;
        readonly capabilities = createMockAdapter().capabilities;
        #sent: string[] = [];
        async start() {}
        async stop() {}
        getStatus() { return { state: "connected" as const, failureCount: 0 }; }
        onMessage() {}
        async sendTyping() {}
        async sendText(p: { text: string }) {
          this.#sent.push(p.text);
          return [];
        }
        sent() { return this.#sent; }
      }
      const real = new ClassAdapter();
      registry.register(real as unknown as ChannelAdapter);
      const proxy = registry.getById("discord") as unknown as ClassAdapter;
      await proxy.sendText({ text: token() });
      expect(proxy.sent()).toEqual([MARK]);
    });

    it("scrubs ackInteraction text and forwards registerCommands options", async () => {
      const acks: unknown[] = [];
      const cmds: unknown[][] = [];
      const adapter = createMockAdapter("telegram") as ChannelAdapter & { ackInteraction: (p: unknown) => Promise<void> };
      adapter.ackInteraction = async (p) => { acks.push(p); };
      adapter.registerCommands = async (...args: unknown[]) => { cmds.push(args); };
      registry.register(adapter);
      const proxy = registry.getById("telegram") as typeof adapter;
      await proxy.ackInteraction({ interactionId: "q1", text: `t ${token()}` });
      // The options argument arrives with W0T's adapter types; call it untyped here.
      const register = proxy.registerCommands as unknown as (...args: unknown[]) => Promise<void>;
      await register([{ command: "help", description: "Help" }], { chatId: "42" });
      expect(acks).toEqual([{ interactionId: "q1", text: `t ${MARK}` }]);
      expect(cmds[0]).toEqual([[{ command: "help", description: "Help" }], { chatId: "42" }]);
    });

    it("writes through to the real adapter (setters with private fields work)", () => {
      class WithSetter {
        readonly id = "slack" as const;
        #mode = "a";
        get mode() { return this.#mode; }
        set mode(v: string) { this.#mode = v; }
      }
      const real = new WithSetter();
      registry.register(real as unknown as ChannelAdapter);
      const proxy = registry.getById("slack") as unknown as WithSetter;
      proxy.mode = "b";
      expect(real.mode).toBe("b");
      expect(proxy.mode).toBe("b");
    });

    it("leaves text without secrets byte-identical", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      const text = "Plain reply with a SHA 3f786850e387550fdab836ed7e6dc881de23001b and max_tokens=4096";
      await registry.getById("telegram")!.sendText({ ctx, text });
      expect((calls.sendText![0] as { text: string }).text).toBe(text);
    });

    it("uses a custom filter set after registration, and withholds when it throws", async () => {
      const { adapter, calls } = capturingAdapter();
      registry.register(adapter);
      registry.setOutboundFilter((t) => t.toUpperCase());
      await registry.getById("telegram")!.sendText({ ctx, text: "abc" });
      expect((calls.sendText![0] as { text: string }).text).toBe("ABC");
      registry.setOutboundFilter(() => {
        throw new Error("filter failed");
      });
      await registry.getById("telegram")!.sendText({ ctx, text: "abc" });
      expect((calls.sendText![0] as { text: string }).text).toBe("«message withheld: scrubber error»");
    });
  });
});
