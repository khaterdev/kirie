import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentEngine } from "./agent-engine.js";
import type { IncomingMessage, ChatHistoryMessage } from "./agent-engine.js";

// Mock the SDK query function
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Mock pino
vi.mock("pino", () => {
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { default: () => mockLogger };
});

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { failureOf } from "./failure.js";
import { SdkOptionsPipeline, type SdkStreamEvent } from "./sdk-options.js";

const mockQuery = sdkQuery as ReturnType<typeof vi.fn>;

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "msg-1",
    channel: "telegram",
    senderName: "Alice",
    senderId: "user-123",
    text: "Hello",
    chatType: "dm",
    chatId: "chat-456",
    ...overrides,
  };
}

function makeSuccessStream(text: string, sessionId: string = "sess-1") {
  return (async function* () {
    yield {
      type: "assistant" as const,
      session_id: sessionId,
      message: { content: [{ type: "text" as const, text }] },
    };
    yield {
      type: "result" as const,
      session_id: sessionId,
      subtype: "success" as const,
      result: text,
      total_cost_usd: 0.01,
      num_turns: 1,
      is_error: false,
    };
  })();
}

function makeFailingStream() {
  return (async function* () {
    throw new Error("SDK session expired");
  })();
}

describe("AgentEngine", () => {
  let engine: AgentEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new AgentEngine({
      prompt: {
        maxTurns: 5,
        model: "claude-sonnet-4-20250514",
      },
    });
  });

  describe("execute", () => {
    it("dispatches a query and returns the result", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Hi there!"));

      const result = await engine.execute(
        makeMessage(),
        { name: "Alice", platformId: "user-123", role: "owner" },
      );

      expect(result.response).toBe("Hi there!");
      expect(result.sessionId).toBe("sess-1");
      expect(result.costUsd).toBe(0.01);
      expect(result.numTurns).toBe(1);
      expect(result.isError).toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("resumes a session when sessionId is provided", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Resumed!", "sess-existing"));

      const result = await engine.execute(
        makeMessage(),
        { name: "Alice", platformId: "user-123", role: "owner" },
        "sess-existing",
      );

      expect(result.response).toBe("Resumed!");
      expect(result.sessionId).toBe("sess-existing");

      // Should have been called with resume option
      const callArgs = mockQuery.mock.calls[0]![0];
      expect(callArgs.options.resume).toBe("sess-existing");
    });

    it("falls back to fresh session when resume fails and logs the error", async () => {
      // First call (with resume) fails, second call (without) succeeds
      mockQuery
        .mockReturnValueOnce(makeFailingStream())
        .mockReturnValueOnce(makeSuccessStream("Fresh session", "sess-new"));

      const result = await engine.execute(
        makeMessage(),
        { name: "Alice", platformId: "user-123", role: "owner" },
        "sess-old",
      );

      expect(result.response).toBe("Fresh session");
      expect(result.sessionId).toBe("sess-new");
      expect(mockQuery).toHaveBeenCalledTimes(2);

      // Verify error was logged (not silently swallowed)
      const logger = pino({ name: "agent-engine" });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-old" }),
        expect.stringContaining("session resume failed"),
      );
    });

    it("includes rich replyTo context in the prompt when provided", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Got it"));

      await engine.execute(
        makeMessage({
          replyTo: {
            messageId: "msg-99",
            senderName: "Bob",
            text: "What do you think about this?",
          },
        }),
        { name: "Alice", platformId: "user-123", role: "owner" },
      );

      const callArgs = mockQuery.mock.calls[0]![0];
      expect(callArgs.prompt).toContain("[Replying to Bob");
      expect(callArgs.prompt).toContain("What do you think about this?");
    });

    it("falls back to replyToId when replyTo is not present", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Got it"));

      await engine.execute(
        makeMessage({ replyToId: "msg-old-42" }),
        { name: "Alice", platformId: "user-123", role: "owner" },
      );

      const callArgs = mockQuery.mock.calls[0]![0];
      expect(callArgs.prompt).toContain("[Replying to message: msg-old-42]");
    });

    it("includes chat history in the prompt when provided", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Got it"));

      const history: ChatHistoryMessage[] = [
        { role: "user", content: "First message", senderName: "Alice" },
        { role: "assistant", content: "First reply" },
      ];

      await engine.execute(
        makeMessage(),
        { name: "Alice", platformId: "user-123", role: "owner" },
        undefined,
        undefined,
        history,
      );

      const callArgs = mockQuery.mock.calls[0]![0];
      expect(callArgs.prompt).toContain("conversation_history");
      expect(callArgs.prompt).toContain("First message");
      expect(callArgs.prompt).toContain("First reply");
    });
  });

  describe("setMcpServers", () => {
    it("merges new MCP servers into existing config", () => {
      engine.setMcpServers({ "server-a": { command: "npx", args: ["-y", "server-a"] } } as never);
      engine.setMcpServers({ "server-b": { command: "npx", args: ["-y", "server-b"] } } as never);

      // Verify both servers are available by executing a query and checking the options
      mockQuery.mockReturnValue(makeSuccessStream("ok"));

      engine.execute(
        makeMessage(),
        { name: "Alice", platformId: "user-123", role: "owner" },
      );

      const callArgs = mockQuery.mock.calls[0]![0];
      expect(callArgs.options.mcpServers).toHaveProperty("server-a");
      expect(callArgs.options.mcpServers).toHaveProperty("server-b");
    });
  });

  describe("limits and the SDK options seam", () => {
    const LIMIT = "You've hit your weekly limit · resets 5pm (Africa/Cairo)";
    const owner = { name: "Alice", platformId: "user-123", role: "owner" as const };

    function limitResultStream(sessionId = "sess-old") {
      return (async function* () {
        yield {
          type: "assistant" as const,
          session_id: sessionId,
          error: "rate_limit",
          message: { model: "<synthetic>", content: [{ type: "text" as const, text: LIMIT }] },
        };
        yield {
          type: "result" as const,
          session_id: sessionId,
          subtype: "success" as const,
          result: LIMIT,
          total_cost_usd: 0,
          num_turns: 1,
          is_error: true,
          api_error_status: 429,
        };
      })();
    }

    /** The one-shot shape: the error result, then the iterator throws. */
    function limitThenThrowStream(sessionId = "sess-old") {
      return (async function* () {
        yield {
          type: "result" as const,
          session_id: sessionId,
          subtype: "success" as const,
          result: LIMIT,
          total_cost_usd: 0,
          num_turns: 1,
          is_error: true,
        };
        throw new Error(`Claude Code returned an error result: ${LIMIT}`);
      })();
    }

    it("does not retry in a fresh session after a returned limit error", async () => {
      mockQuery.mockReturnValueOnce(limitResultStream());

      const result = await engine.execute(makeMessage(), owner, "sess-old");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.sessionId).toBe("sess-old");
      expect(result.failure?.class).toBe("usage_limit_account");
      expect(result.failure?.resetHint).toBe("5pm (Africa/Cairo)");
    });

    it("does not retry fresh after a thrown limit error, and the error carries its classification", async () => {
      mockQuery.mockReturnValueOnce(limitThenThrowStream());

      const err = await engine.execute(makeMessage(), owner, "sess-old").catch((e: unknown) => e);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(Error);
      expect(failureOf(err)?.class).toBe("usage_limit_account");
    });

    it("stops the fresh-session retries at a limit when there was no session to resume", async () => {
      mockQuery.mockReturnValueOnce(limitThenThrowStream(""));

      await expect(engine.execute(makeMessage(), owner)).rejects.toThrow(/weekly limit/);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("still retries fresh after an unclassified error result (today's behaviour)", async () => {
      mockQuery
        .mockReturnValueOnce((async function* () {
          yield { type: "result" as const, session_id: "sess-old", subtype: "success" as const, result: "weird", total_cost_usd: 0, num_turns: 1, is_error: true };
        })())
        .mockReturnValueOnce(makeSuccessStream("Fresh", "sess-new"));

      const result = await engine.execute(makeMessage(), owner, "sess-old");
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.sessionId).toBe("sess-new");
    });

    it("applies the pipeline before every query and emits turn_start, message and turn_end in order", async () => {
      const sdkOptions = new SdkOptionsPipeline();
      const events: SdkStreamEvent[] = [];
      sdkOptions.registerStreamObserver("test", (ev) => events.push(ev));
      const seamEngine = new AgentEngine({ prompt: { maxTurns: 5, model: "claude-sonnet-4-20250514" }, cwd: "/tmp/ws", sdkOptions });
      mockQuery.mockReturnValueOnce((async function* () {
        yield { type: "assistant" as const, session_id: "s1", message: { model: "claude-sonnet-4-20250514", content: [{ type: "text" as const, text: "Hi" }] } };
        yield { type: "result" as const, session_id: "s1", subtype: "success" as const, result: "Hi", total_cost_usd: 0.01, num_turns: 1, is_error: false };
      })());

      const result = await seamEngine.execute(makeMessage(), owner);

      expect(result.model).toBe("claude-sonnet-4-20250514");
      expect(result.accountId).toBeNull();
      expect(result.userMessageUuid).toBeUndefined();
      const { options } = mockQuery.mock.calls[0]![0];
      expect(options.hooks.PreToolUse).toHaveLength(1);
      expect(options.canUseTool).toBeTypeOf("function");
      expect(options.permissionMode).toBe("bypassPermissions");

      expect(events.map((e) => e.type)).toEqual(["turn_start", "message", "message", "turn_end"]);
      const start = events[0]!;
      expect(start.ctx).toMatchObject({ kind: "chat", ownerDm: true, interactive: true, sessionKey: "telegram:dm:chat-456" });
      expect(start.type === "turn_start" && start.userMessageUuid).toBeUndefined();
      const end = events[3]!;
      expect(end.type === "turn_end" && end.result).toEqual({ isError: false, wasAborted: false, costUsd: 0.01, numTurns: 1, model: "claude-sonnet-4-20250514" });
    });
  });
});
