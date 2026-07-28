import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRoutes, type GatewayDeps } from "./routes.js";
import { ChannelRegistry } from "../channels/registry.js";
import { SessionStore } from "../engine/session-store.js";
import type { ChannelAdapter, ChannelStatus, SentMessage } from "../channels/adapter.js";
import type { MessageListener } from "../channels/normalizer.js";

const TEST_DIR = `/tmp/kirie-gateway-test-${process.pid}`;
const TEST_DB = join(TEST_DIR, "sessions.db");

function createMockAdapter(id: string): ChannelAdapter {
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
    async start() {},
    async stop() {},
    getStatus(): ChannelStatus {
      return { state: "connected", failureCount: 0, connectedAt: Date.now() };
    },
    onMessage(_listener: MessageListener) {},
    async sendText(): Promise<SentMessage[]> {
      return [{ id: "sent-1", timestamp: Date.now() }];
    },
    async sendTyping() {},
  };
}

let sessionStore: SessionStore;
let channelRegistry: ChannelRegistry;
let deps: GatewayDeps;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  sessionStore = new SessionStore(TEST_DB);
  channelRegistry = new ChannelRegistry();

  deps = {
    channelRegistry,
    sessionStore,
    onConfigReload: vi.fn(async () => {}),
    onShutdown: vi.fn(),
    onRestart: vi.fn(),
  };
});

afterEach(() => {
  sessionStore.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Gateway routes", () => {
  describe("GET /status", () => {
    it("returns status with empty channels", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/status");
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.channels).toEqual({});
      expect(body.sessions).toBe(0);
    });

    it("returns status with registered channels", async () => {
      channelRegistry.register(createMockAdapter("telegram"));
      channelRegistry.register(createMockAdapter("discord"));

      const app = createRoutes(deps);
      const res = await app.request("/status");
      const body = (await res.json()) as Record<string, unknown>;
      const channels = body.channels as Record<string, Record<string, unknown>>;

      expect(channels).toHaveProperty("telegram");
      expect(channels).toHaveProperty("discord");
      expect(channels.telegram!.state).toBe("connected");
    });

    it("includes session count", async () => {
      sessionStore.set("telegram:dm:123", "sdk-sess-1");
      sessionStore.set("telegram:dm:456", "sdk-sess-2");

      const app = createRoutes(deps);
      const res = await app.request("/status");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sessions).toBe(2);
    });
  });

  describe("POST /config/reload", () => {
    it("calls onConfigReload callback", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/config/reload", { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.message).toContain("reloaded");
      expect(deps.onConfigReload).toHaveBeenCalled();
    });

    it("returns 500 with generic message when reload fails (no internal details leaked)", async () => {
      deps.onConfigReload = vi.fn(async () => {
        throw new Error("Parse error in /home/user/.kirie/config.yaml at line 42");
      });

      const app = createRoutes(deps);
      const res = await app.request("/config/reload", { method: "POST" });
      expect(res.status).toBe(500);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("error");
      // Should NOT leak internal error details
      expect(body.message).not.toContain("Parse error");
      expect(body.message).not.toContain("/home/user");
      expect(body.message).toBe("An internal error occurred");
    });
  });

  describe("POST /channels/:id/start", () => {
    it("starts a registered channel", async () => {
      channelRegistry.register(createMockAdapter("telegram"));

      const app = createRoutes(deps);
      const res = await app.request("/channels/telegram/start", { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.channel).toBe("telegram");
    });

    it("returns 404 for unregistered channel", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/channels/nonexistent/start", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /channels/:id/stop", () => {
    it("stops a running channel", async () => {
      channelRegistry.register(createMockAdapter("telegram"));
      await channelRegistry.start("telegram");

      const app = createRoutes(deps);
      const res = await app.request("/channels/telegram/stop", { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
    });

    it("returns 404 for unregistered channel", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/channels/nonexistent/stop", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /shutdown", () => {
    it("responds with ok and triggers shutdown", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/shutdown", { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.message).toContain("Shutdown");

      // onShutdown is called via setImmediate, so wait a tick
      await new Promise((r) => setTimeout(r, 10));
      expect(deps.onShutdown).toHaveBeenCalled();
    });
  });

  describe("GET /sessions", () => {
    it("returns sessions grouped by channel", async () => {
      channelRegistry.register(createMockAdapter("telegram"));
      channelRegistry.register(createMockAdapter("discord"));

      sessionStore.set("telegram:dm:111", "sdk-1");
      sessionStore.set("telegram:group:222", "sdk-2");
      sessionStore.set("discord:dm:333", "sdk-3");

      const app = createRoutes(deps);
      const res = await app.request("/sessions");
      expect(res.status).toBe(200);

      const body = (await res.json()) as { total: number; byChannel: Record<string, unknown[]> };
      expect(body.total).toBe(3);
      expect(body.byChannel.telegram).toHaveLength(2);
      expect(body.byChannel.discord).toHaveLength(1);
    });

    it("returns empty when no sessions", async () => {
      const app = createRoutes(deps);
      const res = await app.request("/sessions");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.total).toBe(0);
    });
  });
});
