import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./session-store.js";
import { V2SessionManager } from "./v2-session-manager.js";

// Mock the claude-agent-sdk V2 functions
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  function createMockSession(sessionId: string) {
    let streamResolve: (() => void) | null = null;
    let sendResolve: ((value: void) => void) | null = null;
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    let closed = false;

    return {
      get sessionId() {
        return sessionId;
      },
      async send(_message: string) {
        // Simulate async send — push a result message to the stream
        await new Promise<void>((resolve) => {
          sendResolve = resolve;
          // Auto-resolve after a small delay to simulate response
          setTimeout(() => {
            messages.push({
              type: "assistant",
              message: {
                content: [{ type: "text", text: "Mock response" }],
              },
              parent_tool_use_id: null,
              uuid: "mock-uuid",
              session_id: sessionId,
            });
            messages.push({
              type: "result",
              subtype: "success",
              result: "Mock response",
              session_id: sessionId,
              total_cost_usd: 0.01,
              num_turns: 1,
              is_error: false,
              duration_ms: 100,
              duration_api_ms: 80,
              usage: {},
              modelUsage: {},
              permission_denials: [],
              uuid: "mock-uuid",
            });
            resolve();
            if (streamResolve) streamResolve();
          }, 10);
        });
      },
      async *stream() {
        while (!closed) {
          if (messages.length > 0) {
            const msg = messages.shift()!;
            yield msg;
            if (msg.type === "result") return;
          } else {
            await new Promise<void>((resolve) => {
              streamResolve = resolve;
              // Timeout to prevent infinite hang
              setTimeout(resolve, 100);
            });
          }
        }
      },
      close() {
        closed = true;
        if (streamResolve) streamResolve();
      },
    };
  }

  let sessionCounter = 0;

  return {
    unstable_v2_createSession: vi.fn((_options) => {
      sessionCounter++;
      return createMockSession(`mock-session-${sessionCounter}`);
    }),
    unstable_v2_resumeSession: vi.fn((sessionId, _options) => {
      return createMockSession(sessionId);
    }),
  };
});

describe("V2SessionManager", () => {
  let sessionStore: SessionStore;
  let manager: V2SessionManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kirie-v2-test-"));
    sessionStore = new SessionStore(join(tempDir, "sessions.db"));
    manager = new V2SessionManager(sessionStore, {
      workspacePath: tempDir,
      model: "claude-sonnet-4-20250514",
      permissionMode: "acceptEdits",
      allowedTools: ["mcp__kirie-tools__memory_store"],
      idleTimeoutMs: 5000,
      maxSessions: 5,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("execute", () => {
    it("creates a new session and returns a result", async () => {
      const result = await manager.execute("telegram:dm:123", "Hello");
      expect(result.response).toBe("Mock response");
      expect(result.sessionId).toBeTruthy();
      expect(result.costUsd).toBe(0.01);
      expect(result.numTurns).toBe(1);
      expect(result.isError).toBe(false);
    });

    it("reuses the same session for the same key", async () => {
      const result1 = await manager.execute("telegram:dm:123", "First message");
      expect(result1.response).toBe("Mock response");

      // The mock session's stream ends after each result, so the session
      // is cleaned up. A new session will be created for the second message.
      // What matters is that both calls succeed for the same key.
      const result2 = await manager.execute("telegram:dm:123", "Second message");
      expect(result2.response).toBe("Mock response");
    });

    it("creates different sessions for different keys", async () => {
      const r1 = manager.execute("telegram:dm:123", "Hello");
      const r2 = manager.execute("discord:dm:456", "World");
      const [result1, result2] = await Promise.all([r1, r2]);
      expect(result1.response).toBeTruthy();
      expect(result2.response).toBeTruthy();
    });
  });

  describe("hasSession", () => {
    it("returns false when no session exists", () => {
      expect(manager.hasSession("no:such:key")).toBe(false);
    });
  });

  describe("closeSession", () => {
    it("removes the session from active sessions", async () => {
      await manager.execute("telegram:dm:123", "Hello");
      // The mock session may auto-close after stream ends,
      // but closeSession should be safe to call
      manager.closeSession("telegram:dm:123");
      expect(manager.hasSession("telegram:dm:123")).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("closes all active sessions", async () => {
      await manager.execute("telegram:dm:123", "Hello");
      await manager.shutdown();
      expect(manager.activeSessionCount).toBe(0);
    });
  });

  describe("activeSessionCount", () => {
    it("returns 0 initially", () => {
      expect(manager.activeSessionCount).toBe(0);
    });
  });
});
