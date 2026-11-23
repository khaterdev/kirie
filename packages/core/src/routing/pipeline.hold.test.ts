/**
 * MessagePipeline.holdSession: while a session is held (for example during an
 * /undo rewind) no turn may start in it; new messages wait and run after release.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessagePipeline } from "./pipeline.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ChannelStatus, SendTextParams, SentMessage } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SecurityGate, GateResult } from "../security/gate.js";
import type { SessionStore } from "../engine/session-store.js";
import type { AgentEngine, ExecutionResult, IncomingMessage } from "../engine/agent-engine.js";

const OWNER = "1001";
const KEY = `telegram:dm:${OWNER}`;

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "555",
    channel: "telegram" as ChannelName,
    senderName: "Owner",
    senderId: OWNER,
    text: "Hello bot",
    chatType: "dm",
    chatId: OWNER,
    raw: {},
    ...overrides,
  } as UnifiedMessage;
}

function okResult(response: string): ExecutionResult {
  return { response, sessionId: "sdk-1", costUsd: 0.01, numTurns: 1, isError: false };
}

describe("MessagePipeline.holdSession", () => {
  let listeners: Array<(msg: UnifiedMessage) => void>;
  let sendText: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;
  let pipeline: MessagePipeline;

  beforeEach(() => {
    listeners = [];
    sendText = vi.fn(async (_p: SendTextParams): Promise<SentMessage[]> => [{ id: "sent-1", timestamp: Date.now() }]);
    const adapter = {
      id: "telegram" as ChannelName,
      capabilities: {
        sendMedia: false, sendReaction: false, editMessage: false, deleteMessage: false, sendTyping: true,
        threads: false, multipleImages: false, reactions: false, replyContext: false, voiceMessages: false,
        maxTextLength: 4000,
      },
      async start() {},
      async stop() {},
      getStatus(): ChannelStatus { return { state: "connected", failureCount: 0 }; },
      onMessage(listener: (msg: UnifiedMessage) => void) { listeners.push(listener); },
      sendText,
      sendTyping: vi.fn(async () => {}),
    };
    const registry = {
      getAll: vi.fn(() => new Map([["telegram", adapter]])),
      getById: vi.fn(() => adapter),
      isRunning: vi.fn(() => true),
      on: vi.fn(),
    } as unknown as ChannelRegistry;
    const gate = {
      check: vi.fn((m: UnifiedMessage): GateResult => ({
        passed: true,
        identity: { canonicalId: m.senderId, senderId: m.senderId, role: "owner", channel: "telegram" },
        wrappedText: m.text,
      })),
    } as unknown as SecurityGate;
    const sessionStore = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    execute = vi.fn(async (msg: IncomingMessage) => okResult(`reply to ${msg.text}`));
    pipeline = new MessagePipeline({
      channelRegistry: registry,
      securityGate: gate,
      sessionStore,
      agentEngine: { execute } as unknown as AgentEngine,
      debounceMs: 0,
    });
    pipeline.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pipeline.stop();
  });

  it("counts as busy, except for a turn-only check", () => {
    expect(pipeline.isBusy(KEY)).toBe(false);
    const release = pipeline.holdSession(KEY);
    expect(pipeline.isBusy(KEY)).toBe(true);
    expect(pipeline.isBusy(KEY, { ignoreHolds: true })).toBe(false);
    expect(pipeline.isBusy("telegram:dm:other")).toBe(false);
    release();
    expect(pipeline.isBusy(KEY)).toBe(false);
  });

  it("a message arriving during the hold waits, does not look like a running turn, and runs after release", async () => {
    const release = pipeline.holdSession(KEY);
    listeners[0]!(makeMessage({ text: "edit the file" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(execute).not.toHaveBeenCalled();
    // The holder's own check sees no turn, so the rewind goes ahead.
    expect(pipeline.isBusy(KEY, { ignoreHolds: true })).toBe(false);
    expect(pipeline.isBusy(KEY)).toBe(true);

    release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sendText.mock.calls.map((c) => (c[0] as SendTextParams).text)).toContain("reply to edit the file"));
  });

  it("several waiting messages run in arrival order after release", async () => {
    const release = pipeline.holdSession(KEY);
    listeners[0]!(makeMessage({ id: "1", text: "first" }));
    listeners[0]!(makeMessage({ id: "2", text: "second" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(execute).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    const texts = execute.mock.calls.map((c) => (c[0] as IncomingMessage).text);
    expect(texts[0]).toBe("first");
  });

  it("an injected message with skipIfBusy is refused as busy during the hold", async () => {
    const release = pipeline.holdSession(KEY);
    const res = await pipeline.injectMessage({
      channel: "telegram", chatId: OWNER, text: "loop tick", senderId: OWNER, origin: "loop", skipIfBusy: true,
    });
    expect(res).toEqual({ status: "busy" });
    expect(execute).not.toHaveBeenCalled();
    release();
  });

  it("stays held until the last of two holds is released; release is idempotent", async () => {
    const a = pipeline.holdSession(KEY);
    const b = pipeline.holdSession(KEY);
    listeners[0]!(makeMessage({ text: "hi" }));
    a();
    a();
    await new Promise((r) => setTimeout(r, 20));
    expect(execute).not.toHaveBeenCalled();
    expect(pipeline.isBusy(KEY)).toBe(true);
    b();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it("a hold that is never released expires after its timeout", async () => {
    vi.useFakeTimers();
    pipeline.holdSession(KEY, { timeoutMs: 5_000 });
    listeners[0]!(makeMessage({ text: "stuck?" }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    vi.useRealTimers();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(pipeline.isBusy(KEY)).toBe(false);
  });

  it("the default timeout is a bounded two minutes", () => {
    expect(MessagePipeline.DEFAULT_HOLD_TIMEOUT_MS).toBe(120_000);
  });

  it("stop() wakes a waiting message, which then ends without running", async () => {
    pipeline.holdSession(KEY);
    listeners[0]!(makeMessage({ text: "late" }));
    await new Promise((r) => setTimeout(r, 10));
    await pipeline.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(execute).not.toHaveBeenCalled();
  });
});
