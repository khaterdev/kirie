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
      const callArgs = mockQuery.mock.calls[0][0];
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

      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.prompt).toContain("[Replying to Bob");
      expect(callArgs.prompt).toContain("What do you think about this?");
    });

    it("falls back to replyToId when replyTo is not present", async () => {
      mockQuery.mockReturnValue(makeSuccessStream("Got it"));

      await engine.execute(
        makeMessage({ replyToId: "msg-old-42" }),
        { name: "Alice", platformId: "user-123", role: "owner" },
      );

      const callArgs = mockQuery.mock.calls[0][0];
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

      const callArgs = mockQuery.mock.calls[0][0];
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

      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.options.mcpServers).toHaveProperty("server-a");
      expect(callArgs.options.mcpServers).toHaveProperty("server-b");
    });
  });
});
