import { describe, it, expect, vi, afterEach } from "vitest";
import { HookRegistry } from "./registry.js";
import type { HookEventPayload } from "./types.js";

describe("HookRegistry", () => {
  let registry: HookRegistry;

  afterEach(() => {
    registry?.clear();
  });

  describe("register / unregister", () => {
    it("registers a hook and returns a disposer", () => {
      registry = new HookRegistry();
      const dispose = registry.register("beforeMessage", vi.fn());
      expect(registry.count("beforeMessage")).toBe(1);
      dispose();
      expect(registry.count("beforeMessage")).toBe(0);
    });

    it("registers multiple hooks for the same event", () => {
      registry = new HookRegistry();
      registry.register("beforeMessage", vi.fn());
      registry.register("beforeMessage", vi.fn());
      expect(registry.count("beforeMessage")).toBe(2);
    });

    it("unregisters a hook by disposer", () => {
      registry = new HookRegistry();
      const dispose = registry.register("onError", vi.fn());
      dispose();
      expect(registry.count("onError")).toBe(0);
    });

    it("unregisterPlugin removes all hooks for a plugin", () => {
      registry = new HookRegistry();
      registry.register("beforeMessage", vi.fn(), { pluginName: "pluginA" });
      registry.register("afterMessage", vi.fn(), { pluginName: "pluginA" });
      registry.register("beforeMessage", vi.fn(), { pluginName: "pluginB" });

      const removed = registry.unregisterPlugin("pluginA");
      expect(removed).toBe(2);
      expect(registry.count("beforeMessage")).toBe(1);
      expect(registry.count("afterMessage")).toBe(0);
    });
  });

  describe("dispatch", () => {
    it("dispatches event to registered handler", async () => {
      registry = new HookRegistry();
      const handler = vi.fn();
      registry.register("onChannelConnect", handler);

      await registry.dispatch({ type: "onChannelConnect", channel: "telegram" });
      expect(handler).toHaveBeenCalledWith({ type: "onChannelConnect", channel: "telegram" });
    });

    it("dispatches to handlers in priority order", async () => {
      registry = new HookRegistry();
      const order: number[] = [];

      registry.register("onChannelConnect", () => { order.push(2); }, { priority: 200 });
      registry.register("onChannelConnect", () => { order.push(1); }, { priority: 100 });
      registry.register("onChannelConnect", () => { order.push(3); }, { priority: 300 });

      await registry.dispatch({ type: "onChannelConnect", channel: "test" });
      expect(order).toEqual([1, 2, 3]);
    });

    it("returns original event when no handlers registered", async () => {
      registry = new HookRegistry();
      const event: HookEventPayload<"onChannelConnect"> = {
        type: "onChannelConnect",
        channel: "telegram",
      };
      const result = await registry.dispatch(event);
      expect(result).toEqual(event);
    });

    it("beforeMessage hooks form a pipeline", async () => {
      registry = new HookRegistry();

      registry.register("beforeMessage", (event) => {
        return { ...event, text: event.text.toUpperCase() };
      });

      registry.register("beforeMessage", (event) => {
        return { ...event, text: event.text + "!" };
      });

      const result = await registry.dispatch({
        type: "beforeMessage",
        channel: "telegram",
        senderId: "user-1",
        senderName: "Test",
        chatId: "chat-1",
        text: "hello",
        timestamp: Date.now(),
      });

      expect(result.text).toBe("HELLO!");
    });

    it("non-before hooks do not pipeline", async () => {
      registry = new HookRegistry();

      registry.register("afterMessage", () => {
        return {
          type: "afterMessage" as const,
          channel: "telegram",
          senderId: "user-1",
          chatId: "chat-1",
          inputText: "modified",
          responseText: "modified",
          durationMs: 0,
        };
      });

      const event: HookEventPayload<"afterMessage"> = {
        type: "afterMessage",
        channel: "telegram",
        senderId: "user-1",
        chatId: "chat-1",
        inputText: "original",
        responseText: "response",
        durationMs: 100,
      };

      const result = await registry.dispatch(event);
      // afterMessage is not a pipeline, so the original event is returned
      expect(result.inputText).toBe("original");
    });

    it("swallows handler errors without breaking other handlers", async () => {
      registry = new HookRegistry();
      const handler1 = vi.fn(() => { throw new Error("boom"); });
      const handler2 = vi.fn();

      registry.register("onChannelConnect", handler1, { priority: 1 });
      registry.register("onChannelConnect", handler2, { priority: 2 });

      // Suppress console.error during this test
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await registry.dispatch({ type: "onChannelConnect", channel: "test" });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("handles async handlers", async () => {
      registry = new HookRegistry();
      const order: number[] = [];

      registry.register("onChannelConnect", async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }, { priority: 1 });

      registry.register("onChannelConnect", async () => {
        order.push(2);
      }, { priority: 2 });

      await registry.dispatch({ type: "onChannelConnect", channel: "test" });
      expect(order).toEqual([1, 2]);
    });
  });

  describe("timeout", () => {
    it("times out slow handlers", async () => {
      registry = new HookRegistry({ timeoutMs: 50 });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      registry.register("onChannelConnect", async () => {
        await new Promise((r) => setTimeout(r, 200));
      });

      // Should not throw - error is caught internally
      await registry.dispatch({ type: "onChannelConnect", channel: "test" });

      consoleSpy.mockRestore();
    });
  });

  describe("count and clear", () => {
    it("counts hooks per event type", () => {
      registry = new HookRegistry();
      registry.register("beforeMessage", vi.fn());
      registry.register("afterMessage", vi.fn());
      registry.register("afterMessage", vi.fn());

      expect(registry.count("beforeMessage")).toBe(1);
      expect(registry.count("afterMessage")).toBe(2);
      expect(registry.count()).toBe(3);
    });

    it("clear removes all hooks", () => {
      registry = new HookRegistry();
      registry.register("beforeMessage", vi.fn());
      registry.register("afterMessage", vi.fn());
      registry.clear();
      expect(registry.count()).toBe(0);
    });
  });
});
