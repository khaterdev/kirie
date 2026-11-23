/**
 * Loops through the real MessagePipeline (PLAN C.8, E.2): a loop tick is
 * synthetic text, never a command and never the owner, never interrupts a
 * user turn, and a quiet reply is neither sent nor stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessagePipeline } from "../routing/pipeline.js";
import { CommandRegistry } from "../commands/registry.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { TurnContextRegistry, type TurnInfo } from "../engine/turn-context.js";
import { LoopsConfigSchema } from "../config/sections/loops.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ChannelStatus, SendTextParams, SentMessage } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SecurityGate, GateResult } from "../security/gate.js";
import type { SessionStore } from "../engine/session-store.js";
import type { AgentEngine, ExecutionResult, IncomingMessage } from "../engine/agent-engine.js";
import type { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import type { TurnCompleteEvent } from "../routing/pipeline.js";
import { LoopStore, type LoopRecord } from "./loop-store.js";
import { LoopService, LOOP_BUSY_RETRY_MS } from "./loop-service.js";

const OWNER = "1001";

function okResult(response: string, extra: Partial<ExecutionResult> = {}): ExecutionResult {
  return { response, sessionId: "sdk-1", costUsd: 0.01, numTurns: 1, isError: false, ...extra };
}

describe("loops through the real pipeline", () => {
  let dir: string;
  let store: LoopStore;
  let adapter: ReturnType<typeof createMockAdapter>;
  let execute: ReturnType<typeof vi.fn>;
  let restart: ReturnType<typeof vi.fn>;
  let turnContext: TurnContextRegistry;
  let beginSpy: ReturnType<typeof vi.spyOn>;
  let history: { append: ReturnType<typeof vi.fn>; recent: ReturnType<typeof vi.fn> };
  let pipeline: MessagePipeline;
  let service: LoopService;
  let turns: TurnCompleteEvent[];

  function createMockAdapter() {
    const listeners: Array<(msg: UnifiedMessage) => void> = [];
    return {
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
      sendText: vi.fn(async (_p: SendTextParams): Promise<SentMessage[]> => [{ id: "sent-1", timestamp: Date.now() }]),
      sendTyping: vi.fn(async () => {}),
      listeners,
    };
  }

  function createLoop(prompt: string): LoopRecord {
    const loop = store.create({
      sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", chatId: OWNER, chatType: "dm", prompt,
      intervalSec: 300, backoff: true, maxRuns: 100, expiresAt: Date.now() + 3_600_000,
      createdBy: "owner", status: "active", nextRunAt: Date.now(),
    });
    service.reload();
    return loop;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-looppipe-"));
    store = new LoopStore(join(dir, "loops.db"));
    adapter = createMockAdapter();
    const registry = {
      getAll: vi.fn(() => new Map([["telegram", adapter]])),
      getById: vi.fn(() => adapter),
      isRunning: vi.fn(() => true),
      on: vi.fn(),
    } as unknown as ChannelRegistry;
    const gate = {
      check: vi.fn((m: UnifiedMessage): GateResult => ({
        passed: true,
        identity: { canonicalId: m.senderId, senderId: m.senderId, role: m.senderId === OWNER ? "owner" : "user", channel: "telegram" },
        wrappedText: m.text,
      })),
    } as unknown as SecurityGate;
    const sessionStore = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    execute = vi.fn(async () => okResult("NO_REPLY"));
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    restart = vi.fn();
    const commands = new CommandRegistry({ owners });
    commands.registerAll([
      { name: "restart", description: "Restart", category: "core", ownerOnly: true, handler: () => { restart(); return "Restarting"; } },
    ]);
    turnContext = new TurnContextRegistry();
    beginSpy = vi.spyOn(turnContext, "begin");
    let rowId = 0;
    history = { append: vi.fn(() => ++rowId), recent: vi.fn(() => []) };
    pipeline = new MessagePipeline({
      channelRegistry: registry,
      securityGate: gate,
      sessionStore,
      agentEngine: { execute } as unknown as AgentEngine,
      debounceMs: 0,
      commands,
      owners,
      turnContext,
      chatHistoryStore: history as unknown as ChatHistoryStore,
    });
    turns = [];
    pipeline.onTurnComplete((ev) => turns.push(ev));
    pipeline.start();
    const cfg = LoopsConfigSchema.parse({ enabled: true });
    service = new LoopService({
      store,
      config: () => cfg,
      isEnabled: () => true,
      inject: (opts) => pipeline.injectMessage(opts),
      isChatBusy: (key) => pipeline.isBusy(key),
      deliver: async () => {},
      notifyOwner: async () => {},
      isOwnerChat: () => true,
    });
    service.start();
  });

  afterEach(async () => {
    service.stop();
    await pipeline.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a loop whose prompt is /restart runs no command and reaches the agent as text, as a loop turn", async () => {
    const loop = createLoop("/restart");
    service.onTick(Date.now());
    await service.whenIdle();
    expect(restart).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    const msg = execute.mock.calls[0]![0] as IncomingMessage;
    expect(msg.text).toContain("/restart");
    expect(msg.text).toContain(`<loop_tick id="${loop.id}"`);
    // Never a command reply, never "Restarting"
    expect(adapter.sendText.mock.calls.map((c) => c[0].text)).not.toContain("Restarting");
    // The turn's origin is "loop", never the owner
    const info = beginSpy.mock.calls[0]![1] as TurnInfo;
    expect(info.origin).toBe("loop");
    expect(turns[0]!.origin).toBe("loop");
    expect(store.get(loop.id)!.runs).toBe(1);
  });

  it("a quiet reply is neither sent nor stored as an assistant message", async () => {
    const loop = createLoop("check the deploy");
    service.onTick(Date.now());
    await service.whenIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(history.append.mock.calls.filter((c) => c[1] === "assistant")).toHaveLength(0);
    // The user row is the history label, not the wrapped prompt
    expect(history.append.mock.calls.find((c) => c[1] === "user")![2]).toBe(`[loop ${loop.id}] check the deploy`);
    expect(store.get(loop.id)).toMatchObject({ lastStatus: "quiet", currentIntervalSec: 600 });
  });

  it("a changed reply goes out through the pipeline", async () => {
    execute.mockResolvedValueOnce(okResult("The deploy failed at step 3."));
    const loop = createLoop("check the deploy");
    service.onTick(Date.now());
    await service.whenIdle();
    expect(adapter.sendText.mock.calls.map((c) => c[0].text)).toEqual(["The deploy failed at step 3."]);
    expect(store.get(loop.id)).toMatchObject({ lastStatus: "changed", currentIntervalSec: 300 });
  });

  it("an unchanged reply to a scheduled tick is neither sent nor stored; a changed one is; /loop now always shows it", async () => {
    const assistantRows = () => history.append.mock.calls.filter((c) => c[1] === "assistant").map((c) => c[2]);
    const due = (id: string) => { store.update(id, { nextRunAt: Date.now() }, Date.now()); service.reload(); };
    execute.mockResolvedValue(okResult("Deploy is at step 3."));
    const loop = createLoop("check the deploy");
    service.onTick(Date.now());
    await service.whenIdle();
    expect(adapter.sendText.mock.calls.map((c) => c[0].text)).toEqual(["Deploy is at step 3."]);
    expect(store.get(loop.id)).toMatchObject({ lastStatus: "changed" });

    due(loop.id);
    service.onTick(Date.now());
    await service.whenIdle();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(assistantRows()).toEqual(["Deploy is at step 3."]);
    expect(store.get(loop.id)).toMatchObject({ lastStatus: "unchanged", runs: 2, currentIntervalSec: 600 });

    await service.runNow(loop.id);
    await service.whenIdle();
    expect(adapter.sendText.mock.calls.map((c) => c[0].text)).toEqual(["Deploy is at step 3.", "Deploy is at step 3."]);

    execute.mockResolvedValue(okResult("Deploy finished."));
    due(loop.id);
    service.onTick(Date.now());
    await service.whenIdle();
    expect(adapter.sendText.mock.calls.at(-1)![0].text).toBe("Deploy finished.");
    expect(store.get(loop.id)).toMatchObject({ lastStatus: "changed", currentIntervalSec: 300 });
  });

  it("never interrupts a running user turn: the tick is deferred 30 s and not counted", async () => {
    let finishUser!: (r: ExecutionResult) => void;
    execute.mockImplementationOnce(() => new Promise<ExecutionResult>((r) => { finishUser = r; }));
    adapter.listeners[0]!({
      id: "555", channel: "telegram" as ChannelName, senderName: "Owner", senderId: OWNER, text: "hello",
      chatType: "dm", chatId: OWNER, raw: {},
    } as UnifiedMessage);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const loop = createLoop("check the deploy");
    const now = Date.now();
    service.onTick(now);
    await service.whenIdle();
    expect(execute).toHaveBeenCalledTimes(1); // the user's turn only
    const after = store.get(loop.id)!;
    expect(after.runs).toBe(0);
    expect(after.lastStatus).toBe("busy");
    expect(after.nextRunAt).toBeGreaterThanOrEqual(now + LOOP_BUSY_RETRY_MS);
    finishUser(okResult("hi there"));
    await vi.waitFor(() => expect(adapter.sendText.mock.calls.map((c) => c[0].text)).toContain("hi there"));
  });

  it("a user message during a loop tick wins: the tick is aborted and not counted", async () => {
    execute.mockImplementationOnce((_m: IncomingMessage, _s: unknown, _sid: unknown, onQuery?: (q: { close(): void }) => void) =>
      new Promise<ExecutionResult>((resolve) => {
        onQuery?.({ close: () => resolve(okResult("partial", { wasAborted: true })) });
      }));
    execute.mockResolvedValueOnce(okResult("answer to the user"));
    const loop = createLoop("check the deploy");
    service.onTick(Date.now());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    adapter.listeners[0]!({
      id: "556", channel: "telegram" as ChannelName, senderName: "Owner", senderId: OWNER, text: "what's up?",
      chatType: "dm", chatId: OWNER, raw: {},
    } as UnifiedMessage);
    await service.whenIdle();
    await vi.waitFor(() => expect(adapter.sendText.mock.calls.map((c) => c[0].text)).toContain("answer to the user"));
    expect(adapter.sendText.mock.calls.map((c) => c[0].text)).not.toContain("partial");
    expect(store.get(loop.id)).toMatchObject({ runs: 0, lastStatus: "aborted" });
  });
});
