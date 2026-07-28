import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelRegistry } from "./registry.js";
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
      expect(registry.getById("telegram")).toBe(adapter);
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
      expect(all.get("telegram")).toBe(tg);
      expect(all.get("discord")).toBe(dc);
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
});
