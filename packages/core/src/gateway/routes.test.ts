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

  describe("secret scrubbing of HTTP responses", () => {
    const token = (): string => ["gh", "p_", "Rt5Yu6Io7Pa8Sd9Fg0Hj1Kl2Zx3Cv4Bn5Mq6We7"].join("");
    const MARK = "«redacted:github-token»";

    it("scrubs lastError in GET /status", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.getStatus = () => ({ state: "error", failureCount: 2, lastError: `401 for https://x/bot?token=${token()}` });
      channelRegistry.register(adapter);
      const res = await createRoutes(deps).request("/status");
      const body = await res.json() as { channels: Record<string, { lastError: string }> };
      expect(body.channels.telegram!.lastError).not.toContain(token());
      expect(JSON.stringify(body)).not.toContain(token().slice(4));
    });

    it("scrubs the channel-action error message", async () => {
      const adapter = createMockAdapter("telegram");
      adapter.sendText = async () => {
        throw new Error(`send failed with ${token()}`);
      };
      channelRegistry.register(adapter);
      const res = await createRoutes(deps).request("/api/channel-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram", action: "send_text", chatId: "1", text: "hello" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ status: "error", message: `send failed with ${MARK}` });
    });

    it("scrubs text sent through /api/channel-action (adapter proxy)", async () => {
      const sent: string[] = [];
      const adapter = createMockAdapter("telegram");
      adapter.sendText = async (p) => {
        sent.push(p.text);
        return [];
      };
      channelRegistry.register(adapter);
      const res = await createRoutes(deps).request("/api/channel-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram", action: "send_text", chatId: "1", text: `key ${token()}` }),
      });
      expect(res.status).toBe(200);
      expect(sent).toEqual([`key ${MARK}`]);
    });
  });

  describe("open approval cards (CORE-B1)", () => {
    it("refuses to edit an open prompt card, allows other messages", async () => {
      const edits: string[] = [];
      const adapter = createMockAdapter("telegram");
      adapter.editMessage = async (p) => {
        edits.push(p.messageId);
      };
      channelRegistry.register(adapter);
      adapter.sendText = async () => [{ id: "78", timestamp: 1 }];
      const guarded = { ...deps, isProtectedMessage: (ch: string, chat: string, id: string) => ch === "telegram" && chat === "1001" && id === "77" };
      const routes = createRoutes(guarded);
      const call = (body: Record<string, unknown>) =>
        routes.request("/api/channel-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "telegram", chatId: "1001", ...body }) });
      const edit = (messageId: unknown, extra: Record<string, unknown> = {}) =>
        call({ action: "edit_message", messageId, text: "Approval needed: Read README.md. Reply /approve K7Q2", ...extra });
      // An open card, a page Kirie sent, and number tricks on the card's id: all refused.
      for (const id of ["77", "76", "77.0", " 77", "0x4d", 77]) expect((await edit(id)).status, String(id)).toBe(403);
      expect(edits).toEqual([]);
      // A message the agent sent through send_text can be edited, from any chat id or thread.
      expect((await call({ action: "send_text", text: "progress 1/3" })).status).toBe(200);
      expect((await edit("78", { chatId: "2002", threadId: "x" })).status).toBe(200);
      expect(edits).toEqual(["78"]);
    });
  });
});
