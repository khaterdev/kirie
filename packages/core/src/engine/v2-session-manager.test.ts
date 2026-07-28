import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./session-store.js";
import { V2SessionManager } from "./v2-session-manager.js";
import type { IncomingMessage } from "./agent-engine.js";
import type { SenderIdentity } from "./prompt-builder.js";

/**
 * Mock `query()` in streaming-input mode.
 *
 * The real SDK consumes the AsyncIterable prompt and emits an assistant
 * message plus a result message per user message pushed into it. The mock
 * mirrors that contract so the manager's stream consumer is exercised for
 * real: it stays open across multiple sends and only ends when the input
 * iterable is closed.
 */
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  let sessionCounter = 0;

  return {
    query: vi.fn(
      ({ prompt, options }: { prompt: AsyncIterable<unknown>; options?: { resume?: string } }) => {
        const sessionId = options?.resume ?? `mock-session-${++sessionCounter}`;

        const stream = (async function* () {
          // One request/response cycle per pushed user message. The loop ends
          // when the manager closes the input queue, which is what shuts the
          // "subprocess" down.
          for await (const _userMessage of prompt) {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "Mock response" }] },
              parent_tool_use_id: null,
              uuid: "mock-uuid",
              session_id: sessionId,
            };
            yield {
              type: "result",
              subtype: "success",
              result: "Mock response",
              session_id: sessionId,
              total_cost_usd: 0.01,
              num_turns: 1,
              is_error: false,
              duration_ms: 100,
              duration_api_ms: 80,
              stop_reason: null,
              usage: {},
              modelUsage: {},
              permission_denials: [],
              uuid: "mock-uuid",
            };
          }
        })();

        return Object.assign(stream, {
          interrupt: vi.fn(async () => undefined),
          setPermissionMode: vi.fn(async () => undefined),
        });
      },
    ),
  };
});

/** Build the IncomingMessage shape the pipeline hands to an AgentExecutor. */
function makeMessage(chatId: string, text: string): IncomingMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    channel: chatId.split(":")[0] ?? "telegram",
    senderName: "Tester",
    senderId: "tester-1",
    text,
    chatType: "dm",
    chatId: chatId.split(":").pop() ?? chatId,
  };
}

const SENDER: SenderIdentity = { name: "Tester", platformId: "tester-1", role: "owner" };

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
      const result = await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      expect(result.response).toBe("Mock response");
      expect(result.sessionId).toBeTruthy();
      expect(result.costUsd).toBe(0.01);
      expect(result.numTurns).toBe(1);
      expect(result.isError).toBe(false);
    });

    it("keeps one session alive across multiple messages", async () => {
      const result1 = await manager.execute(makeMessage("telegram:dm:123", "First message"), SENDER);
      expect(result1.response).toBe("Mock response");

      const result2 = await manager.execute(makeMessage("telegram:dm:123", "Second message"), SENDER);
      expect(result2.response).toBe("Mock response");

      // The whole point of streaming-input mode: the same session serves both
      // messages, so the SDK session ID is stable and only one session exists.
      expect(result2.sessionId).toBe(result1.sessionId);
      expect(manager.activeSessionCount).toBe(1);
    });

    it("persists the SDK session id to the session store", async () => {
      const result = await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      expect(sessionStore.get("telegram:dm:123")).toBe(result.sessionId);
    });

    it("creates different sessions for different keys", async () => {
      const r1 = manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      const r2 = manager.execute(makeMessage("discord:dm:456", "World"), SENDER);
      const [result1, result2] = await Promise.all([r1, r2]);
      expect(result1.response).toBeTruthy();
      expect(result2.response).toBeTruthy();
      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("resumes the stored session id after the session is closed", async () => {
      const first = await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      manager.closeSession("telegram:dm:123");

      const resumed = await manager.execute(makeMessage("telegram:dm:123", "Follow up"), SENDER);
      expect(resumed.sessionId).toBe(first.sessionId);
    });
  });

  describe("hasSession", () => {
    it("returns false when no session exists", () => {
      expect(manager.hasSession("no:such:key")).toBe(false);
    });

    it("returns true while a session is open", async () => {
      await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      expect(manager.hasSession("telegram:dm:123")).toBe(true);
    });
  });

  describe("closeSession", () => {
    it("removes the session from active sessions", async () => {
      await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
      manager.closeSession("telegram:dm:123");
      expect(manager.hasSession("telegram:dm:123")).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("closes all active sessions", async () => {
      await manager.execute(makeMessage("telegram:dm:123", "Hello"), SENDER);
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
