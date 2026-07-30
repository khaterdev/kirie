import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessagePipeline, formatReplyContext } from "./pipeline.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ChannelAdapter, ChannelStatus, SentMessage } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SecurityGate, GateResult } from "../security/gate.js";
import type { SessionStore } from "../engine/session-store.js";
import type { AgentEngine, ExecutionResult } from "../engine/agent-engine.js";
import type { HeartbeatService } from "../engine/heartbeat.js";

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "msg-1",
    channel: "telegram" as ChannelName,
    senderName: "Alice",
    senderId: "user-123",
    text: "Hello bot",
    chatType: "dm",
    chatId: "chat-456",
    raw: {},
    ...overrides,
  } as UnifiedMessage;
}

function createMockAdapter(): ChannelAdapter & { messageListeners: Array<(msg: UnifiedMessage) => void> } {
  const listeners: Array<(msg: UnifiedMessage) => void> = [];
  return {
    id: "telegram" as ChannelName,
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
      return { state: "connected", failureCount: 0 };
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    sendText: vi.fn(async (): Promise<SentMessage[]> => {
      return [{ id: "sent-1", timestamp: Date.now() }];
    }),
    sendTyping: vi.fn(async () => {}),
    messageListeners: listeners,
  };
}

describe("MessagePipeline", () => {
  let mockAdapter: ReturnType<typeof createMockAdapter>;
  let mockRegistry: ChannelRegistry;
  let mockGate: SecurityGate;
  let mockSessionStore: SessionStore;
  let mockEngine: AgentEngine;
  let pipeline: MessagePipeline;

  beforeEach(() => {
    mockAdapter = createMockAdapter();

    mockRegistry = {
      getAll: vi.fn(() => new Map([["telegram", mockAdapter]])),
      getById: vi.fn(() => mockAdapter),
      on: vi.fn(),
    } as unknown as ChannelRegistry;

    mockGate = {
      check: vi.fn((): GateResult => ({
        passed: true,
        identity: {
          canonicalId: "user-123",
          senderId: "user-123",
          role: "owner" as const,
          channel: "telegram",
        },
        wrappedText: "<user_message>Hello bot</user_message>",
      })),
    } as unknown as SecurityGate;

    mockSessionStore = {
      get: vi.fn(() => null),
      set: vi.fn(),
    } as unknown as SessionStore;

    mockEngine = {
      execute: vi.fn(async (): Promise<ExecutionResult> => ({
        response: "Hello human!",
        sessionId: "sdk-sess-1",
        costUsd: 0.01,
        numTurns: 1,
        isError: false,
      })),
    } as unknown as AgentEngine;

    pipeline = new MessagePipeline({
      channelRegistry: mockRegistry,
      securityGate: mockGate,
      sessionStore: mockSessionStore,
      agentEngine: mockEngine,
      debounceMs: 0,
    });
  });

  afterEach(() => {
    pipeline.stop();
  });

  describe("message routing", () => {
    it("routes a message through the full pipeline", async () => {
      pipeline.start();

      const msg = makeMessage();
      // Trigger the listener
      mockAdapter.messageListeners[0]!(msg);

      // Wait for the full async processing chain to complete
      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalled();
      }, { timeout: 3000 });

      expect(mockGate.check).toHaveBeenCalledWith(msg);
      expect(mockEngine.execute).toHaveBeenCalled();
    });

    it("rejects messages that fail the security gate", async () => {
      (mockGate.check as ReturnType<typeof vi.fn>).mockReturnValue({
        passed: false,
        reason: "Not authorized",
      });

      pipeline.start();
      mockAdapter.messageListeners[0]!(makeMessage());

      // Give the pipeline time to process the message
      await new Promise((r) => setTimeout(r, 100));

      // Engine should NOT have been called
      expect(mockEngine.execute).not.toHaveBeenCalled();

      // Silently drops unauthorized messages (no response sent)
      expect(mockAdapter.sendText).not.toHaveBeenCalled();
    });
  });

  describe("error sanitization", () => {
    it("returns a generic error message to users when pipeline errors occur", async () => {
      (mockEngine.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ECONNREFUSED 127.0.0.1:5432 - database connection failed at /home/user/app/db.ts:42"),
      );

      pipeline.start();
      mockAdapter.messageListeners[0]!(makeMessage());

      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalled();
      }, { timeout: 3000 });

      const sendCall = (mockAdapter.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // Should NOT contain internal error details
      expect(sendCall.text).not.toContain("ECONNREFUSED");
      expect(sendCall.text).not.toContain("database");
      expect(sendCall.text).not.toContain("/home/user");
      // Should contain generic message
      expect(sendCall.text).toContain("internal error occurred");
    });

    it("reports a usage limit as a usage limit rather than a context reset", async () => {
      // Verbatim error that blocked four messages on 2026-07-29. It contains
      // the word "session", which the old substring match mistook for a
      // broken session and reported as "Context has been reset".
      (mockEngine.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error(
          "Claude Code returned an error result: You've hit your session limit · resets 2:30am (Africa/Cairo)",
        ),
      );

      pipeline.start();
      mockAdapter.messageListeners[0]!(makeMessage());

      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalled();
      }, { timeout: 3000 });

      const sendCall = (mockAdapter.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(sendCall.text).toContain("Usage limit reached");
      expect(sendCall.text).toContain("2:30am (Africa/Cairo)");
      expect(sendCall.text).not.toContain("Context has been reset");
    });
  });

  describe("schedule-injected messages", () => {
    it("does not set replyToId for schedule-injected messages", async () => {
      // Add isRunning to the mock registry
      (mockRegistry as any).isRunning = vi.fn(() => true);

      pipeline.start();

      // Use injectScheduleMessage which creates a message with id "schedule-..."
      await pipeline.injectScheduleMessage({
        channel: "telegram",
        chatId: "chat-456",
        text: "Scheduled reminder",
        senderId: "user-123",
        senderName: "Schedule",
      });

      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalled();
      }, { timeout: 3000 });

      // Find the response send call (not the typing indicator)
      const sendCalls = (mockAdapter.sendText as ReturnType<typeof vi.fn>).mock.calls;
      const responseSend = sendCalls.find(
        (call: any[]) => call[0].text === "Hello human!",
      );
      expect(responseSend).toBeDefined();
      // replyToId should NOT be set for schedule messages
      expect(responseSend![0].ctx.replyToId).toBeUndefined();
    });

    it("sends error responses without replyToId for schedule messages", async () => {
      (mockRegistry as any).isRunning = vi.fn(() => true);
      (mockEngine.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Something broke"),
      );

      pipeline.start();

      await pipeline.injectScheduleMessage({
        channel: "telegram",
        chatId: "chat-456",
        text: "Scheduled reminder",
        senderId: "user-123",
      });

      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalled();
      }, { timeout: 3000 });

      const sendCalls = (mockAdapter.sendText as ReturnType<typeof vi.fn>).mock.calls;
      const errorSend = sendCalls.find(
        (call: any[]) => call[0].text.includes("internal error"),
      );
      expect(errorSend).toBeDefined();
      expect(errorSend![0].ctx.replyToId).toBeUndefined();
    });
  });

  describe("error response reply fallback", () => {
    it("falls back to sending without replyToId when reply fails", async () => {
      // Make the agent execution throw so the catch block fires sendErrorResponse
      (mockEngine.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Something went wrong"),
      );

      // First call (with replyToId) fails, second call (without) succeeds
      let callCount = 0;
      (mockAdapter.sendText as ReturnType<typeof vi.fn>).mockImplementation(
        async (params: any) => {
          callCount++;
          if (callCount === 1 && params.ctx.replyToId) {
            throw new Error("Bad Request: message to reply not found");
          }
          return [{ id: "sent-1", timestamp: Date.now() }];
        },
      );

      pipeline.start();
      mockAdapter.messageListeners[0]!(makeMessage());

      await vi.waitFor(() => {
        expect(mockAdapter.sendText).toHaveBeenCalledTimes(2);
      }, { timeout: 3000 });

      // Second call should NOT have replyToId
      const secondCall = (mockAdapter.sendText as ReturnType<typeof vi.fn>).mock.calls[1]![0];
      expect(secondCall.ctx.replyToId).toBeUndefined();
      expect(secondCall.text).toContain("internal error");
    });
  });

  describe("start/stop", () => {
    it("does not process messages after stop", () => {
      pipeline.start();
      pipeline.stop();

      // The adapter's listener was registered, but pipeline is stopped
      // Internal state should be marked as stopped
      expect(pipeline["started"]).toBe(false);
    });

    it("start is idempotent", () => {
      pipeline.start();
      pipeline.start();

      // getAll should only have been called once
      expect(mockRegistry.getAll).toHaveBeenCalledTimes(1);
    });

    it("stop() waits for an in-flight handler to finish before resolving", async () => {
      // Make agent execution hang until we release it, simulating a long-running
      // task that is still persisting its session ID when shutdown begins.
      let releaseExecute!: () => void;
      const executeStarted = new Promise<void>((resolveStarted) => {
        (mockEngine.execute as ReturnType<typeof vi.fn>).mockImplementation(
          async () => {
            resolveStarted();
            await new Promise<void>((r) => {
              releaseExecute = r;
            });
            return {
              response: "done",
              sessionId: "sdk-sess-1",
              costUsd: 0.01,
              numTurns: 1,
              isError: false,
            } satisfies ExecutionResult;
          },
        );
      });

      pipeline.start();
      mockAdapter.messageListeners[0]!(makeMessage());
      await executeStarted; // handler is now mid-execution

      let stopResolved = false;
      const stopPromise = pipeline.stop().then(() => {
        stopResolved = true;
      });

      // stop() must not resolve while the handler is still running.
      await new Promise((r) => setTimeout(r, 50));
      expect(stopResolved).toBe(false);

      releaseExecute();
      await stopPromise;
      expect(stopResolved).toBe(true);
      // The in-flight task got to persist its session before stores would close.
      expect(mockSessionStore.set).toHaveBeenCalledWith("telegram:dm:chat-456", "sdk-sess-1");
    });
  });
});

describe("MessagePipeline retry integration", () => {
  let mockAdapter: ReturnType<typeof createMockAdapter>;
  let mockRegistry: ChannelRegistry;
  let mockGate: SecurityGate;
  let mockSessionStore: SessionStore;
  let mockEngine: AgentEngine;
  let mockHeartbeat: HeartbeatService;
  let pipeline: MessagePipeline;

  beforeEach(() => {
    mockAdapter = createMockAdapter();

    mockRegistry = {
      getAll: vi.fn(() => new Map([["telegram", mockAdapter]])),
      getById: vi.fn(() => mockAdapter),
      isRunning: vi.fn(() => true),
      on: vi.fn(),
    } as unknown as ChannelRegistry;

    mockGate = {
      check: vi.fn((): GateResult => ({
        passed: true,
        identity: {
          canonicalId: "user-123",
          senderId: "user-123",
          role: "owner" as const,
          channel: "telegram",
        },
        wrappedText: "<user_message>Hello bot</user_message>",
      })),
    } as unknown as SecurityGate;

    mockSessionStore = {
      get: vi.fn(() => null),
      set: vi.fn(),
    } as unknown as SessionStore;

    mockEngine = {
      execute: vi.fn(async (): Promise<ExecutionResult> => ({
        response: "Hello human!",
        sessionId: "sdk-sess-1",
        costUsd: 0.01,
        numTurns: 1,
        isError: false,
      })),
    } as unknown as AgentEngine;

    mockHeartbeat = {
      addFailedDelivery: vi.fn(() => "retry_1"),
    } as unknown as HeartbeatService;

    pipeline = new MessagePipeline({
      channelRegistry: mockRegistry,
      securityGate: mockGate,
      sessionStore: mockSessionStore,
      agentEngine: mockEngine,
      debounceMs: 0,
    });

    // Wire heartbeat for retry support
    pipeline.setHeartbeat(mockHeartbeat);
  });

  afterEach(() => {
    pipeline.stop();
  });

  it("queues response for heartbeat retry on ETIMEDOUT", async () => {
    const etimedoutErr = new Error("connect ETIMEDOUT 149.154.167.220:443");
    (etimedoutErr as NodeJS.ErrnoException).code = "ETIMEDOUT";

    (mockAdapter.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(etimedoutErr);

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    await vi.waitFor(() => {
      expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalledWith(
      "telegram",
      "chat-456",
      "Hello human!",
      expect.stringContaining("ETIMEDOUT"),
      undefined,
    );
  });

  it("queues response for heartbeat retry on ECONNRESET", async () => {
    const err = new Error("socket hang up");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";

    (mockAdapter.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    await vi.waitFor(() => {
      expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  it("does NOT queue for retry on non-transient errors", async () => {
    (mockAdapter.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Bad Request: chat not found"),
    );

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    // Wait for the error response to be attempted (the outer catch sends error message)
    await vi.waitFor(() => {
      expect(mockAdapter.sendText).toHaveBeenCalledTimes(2); // original + error response
    }, { timeout: 3000 });

    // Heartbeat should NOT have been called (not a transient error)
    expect(mockHeartbeat.addFailedDelivery).not.toHaveBeenCalled();
  });

  it("queues background task result for retry on ETIMEDOUT", async () => {
    const etimedoutErr = new Error("connect ETIMEDOUT");
    (etimedoutErr as NodeJS.ErrnoException).code = "ETIMEDOUT";

    (mockAdapter.sendText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(etimedoutErr);

    await pipeline.pushBackgroundTaskResult({
      id: "task-1",
      session_key: "telegram:dm:chat-456",
      description: "Test task",
      prompt: "test",
      result: "Task result text",
      status: "completed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalledWith(
      "telegram",
      "chat-456",
      expect.stringContaining("Task result text"),
      expect.stringContaining("ETIMEDOUT"),
      undefined,
    );
  });

  it("queues media send for heartbeat retry on transient network error", async () => {
    // Agent responds with a MEDIA: token (the format splitMediaFromOutput expects)
    (mockEngine.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "Here is the file\nMEDIA: https://example.com/file.png",
      sessionId: "sdk-sess-1",
      costUsd: 0.01,
      numTurns: 1,
      isError: false,
    });

    // Enable sendMedia on the adapter
    const sendMediaMock = vi.fn();
    const etimedoutErr = new Error("connect ETIMEDOUT");
    (etimedoutErr as NodeJS.ErrnoException).code = "ETIMEDOUT";
    sendMediaMock.mockRejectedValueOnce(etimedoutErr);

    (mockAdapter as any).sendMedia = sendMediaMock;
    (mockAdapter as any).capabilities.sendMedia = true;

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    await vi.waitFor(() => {
      expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalled();
    }, { timeout: 3000 });

    // Should queue a text fallback for the failed media
    expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalledWith(
      "telegram",
      "chat-456",
      expect.stringContaining("[media:"),
      expect.stringContaining("ETIMEDOUT"),
      undefined,
    );
  });

  it("does NOT queue media send for retry on non-transient error", async () => {
    // Agent responds with a MEDIA: token
    (mockEngine.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: "Here is the file\nMEDIA: https://example.com/file.png",
      sessionId: "sdk-sess-1",
      costUsd: 0.01,
      numTurns: 1,
      isError: false,
    });

    // Enable sendMedia on the adapter
    const sendMediaMock = vi.fn();
    sendMediaMock.mockRejectedValueOnce(new Error("File not found"));

    (mockAdapter as any).sendMedia = sendMediaMock;
    (mockAdapter as any).capabilities.sendMedia = true;

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    // Wait for text to be sent (the non-media part)
    await vi.waitFor(() => {
      expect(mockAdapter.sendText).toHaveBeenCalled();
    }, { timeout: 3000 });

    // Heartbeat should NOT have been called (not a transient error)
    expect(mockHeartbeat.addFailedDelivery).not.toHaveBeenCalled();
  });

  it("queues error response for retry when both reply and fallback fail with network error", async () => {
    const netErr = new Error("connect ETIMEDOUT");
    (netErr as NodeJS.ErrnoException).code = "ETIMEDOUT";

    // Make agent execution throw to trigger sendErrorResponse
    (mockEngine.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Something went wrong"),
    );

    // Both attempts fail with network error
    (mockAdapter.sendText as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(netErr)  // first attempt with replyToId
      .mockRejectedValueOnce(netErr); // fallback without replyToId

    pipeline.start();
    mockAdapter.messageListeners[0]!(makeMessage());

    await vi.waitFor(() => {
      expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(mockHeartbeat.addFailedDelivery).toHaveBeenCalledWith(
      "telegram",
      "chat-456",
      "Sorry, an internal error occurred. Please try again.",
      expect.stringContaining("ETIMEDOUT"),
      undefined,
    );
  });
});

describe("formatReplyContext", () => {
  it("returns formatted string with all fields present", () => {
    const result = formatReplyContext({
      messageId: "msg-100",
      text: "What do you think?",
      senderId: "user-42",
      senderName: "Alice",
    });
    expect(result).toBe('[Replying to Alice: "What do you think?"]\n');
  });

  it("falls back to senderId when senderName is missing", () => {
    const result = formatReplyContext({
      messageId: "msg-100",
      senderId: "12345",
    });
    expect(result).toBe("[Replying to user 12345]\n");
  });

  it("falls back to messageId when both senderName and senderId are missing", () => {
    const result = formatReplyContext({
      messageId: "789",
    });
    expect(result).toBe("[Replying to message 789]\n");
  });

  it("truncates reply text longer than 200 characters", () => {
    const longText = "A".repeat(250);
    const result = formatReplyContext({
      messageId: "msg-100",
      senderName: "Bob",
      text: longText,
    });
    expect(result).toBe(`[Replying to Bob: "${"A".repeat(200)}..."]\n`);
    // Verify it does NOT contain the full 250-char text
    expect(result).not.toContain("A".repeat(250));
  });

  it("does not truncate text at exactly 200 characters", () => {
    const exactText = "B".repeat(200);
    const result = formatReplyContext({
      messageId: "msg-100",
      senderName: "Carol",
      text: exactText,
    });
    expect(result).toBe(`[Replying to Carol: "${exactText}"]\n`);
    expect(result).not.toContain("...");
  });

  it("returns empty string when replyTo is undefined", () => {
    const result = formatReplyContext(undefined);
    expect(result).toBe("");
  });

  it("includes senderId with text when senderName is missing", () => {
    const result = formatReplyContext({
      messageId: "msg-100",
      senderId: "user-99",
      text: "Some context",
    });
    expect(result).toBe('[Replying to user user-99: "Some context"]\n');
  });

  it("includes messageId with text when both sender fields are missing", () => {
    const result = formatReplyContext({
      messageId: "msg-555",
      text: "Original message",
    });
    expect(result).toBe('[Replying to message msg-555: "Original message"]\n');
  });
});
