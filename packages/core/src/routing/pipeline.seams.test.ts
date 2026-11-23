/**
 * Pipeline extension points and the synthetic-text rules (PLAN B.4, B.14, E.2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessagePipeline, isSyntheticId, isQuietReply } from "./pipeline.js";
import { ScheduledInjectionQueue } from "./scheduled-injection.js";
import { CommandRegistry } from "../commands/registry.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { TurnContextRegistry, type TurnInfo } from "../engine/turn-context.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ChannelStatus, SendTextParams, SentMessage } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SecurityGate, GateResult } from "../security/gate.js";
import type { SessionStore } from "../engine/session-store.js";
import type { AgentEngine, ExecutionResult, IncomingMessage } from "../engine/agent-engine.js";
import type { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import type { TurnCompleteEvent } from "./pipeline.js";

const OWNER = "1001";
const STRANGER = "2002";

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

function createMockAdapter() {
  const listeners: Array<(msg: UnifiedMessage) => void> = [];
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
    sendText: vi.fn(async (_params: SendTextParams): Promise<SentMessage[]> => [{ id: "sent-1", timestamp: Date.now() }]),
    sendTyping: vi.fn(async () => {}),
    listeners,
  };
  return adapter;
}

function okResult(response: string): ExecutionResult {
  return { response, sessionId: "sdk-1", costUsd: 0.01, numTurns: 1, isError: false };
}

/** An engine whose turns finish only when the test releases them. */
function controllableEngine() {
  const pending: Array<{ msg: IncomingMessage; resolve: (r: ExecutionResult) => void }> = [];
  const execute = vi.fn((msg: IncomingMessage): Promise<ExecutionResult> =>
    new Promise((resolve) => { pending.push({ msg, resolve }); }));
  return { engine: { execute } as unknown as AgentEngine, execute, pending };
}

function sentTexts(adapter: ReturnType<typeof createMockAdapter>): string[] {
  return adapter.sendText.mock.calls.map((c) => c[0].text);
}

describe("MessagePipeline seams", () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let registry: ChannelRegistry;
  let gate: SecurityGate;
  let sessionStore: SessionStore;
  let engine: AgentEngine;
  let execute: ReturnType<typeof vi.fn>;
  let commands: CommandRegistry;
  let owners: OwnerDirectory;
  let turnContext: TurnContextRegistry;
  let restart: ReturnType<typeof vi.fn>;
  let history: { append: ReturnType<typeof vi.fn>; recent: ReturnType<typeof vi.fn> };
  let pipeline: MessagePipeline;

  function build(overrideEngine?: AgentEngine): MessagePipeline {
    return new MessagePipeline({
      channelRegistry: registry,
      securityGate: gate,
      sessionStore,
      agentEngine: overrideEngine ?? engine,
      debounceMs: 0,
      commands,
      owners,
      turnContext,
      chatHistoryStore: history as unknown as ChatHistoryStore,
    });
  }

  beforeEach(() => {
    adapter = createMockAdapter();
    registry = {
      getAll: vi.fn(() => new Map([["telegram", adapter]])),
      getById: vi.fn(() => adapter),
      isRunning: vi.fn(() => true),
      on: vi.fn(),
    } as unknown as ChannelRegistry;
    gate = {
      check: vi.fn((m: UnifiedMessage): GateResult => ({
        passed: true,
        identity: { canonicalId: m.senderId, senderId: m.senderId, role: m.senderId === OWNER ? "owner" : "user", channel: "telegram" },
        wrappedText: m.text,
      })),
    } as unknown as SecurityGate;
    sessionStore = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn() } as unknown as SessionStore;
    execute = vi.fn(async () => okResult("agent reply"));
    engine = { execute } as unknown as AgentEngine;
    owners = new OwnerDirectory({ telegram: [OWNER] });
    restart = vi.fn();
    commands = new CommandRegistry({ owners });
    commands.registerAll([
      { name: "restart", description: "Restart", category: "core", ownerOnly: true, handler: () => { restart(); return "Restarting"; } },
      { name: "approvals", description: "Approvals", category: "security", ownerOnly: true, handler: () => "approvals changed" },
      { name: "sandbox", description: "Sandbox", category: "security", ownerOnly: true, handler: () => "sandbox changed" },
      { name: "help", description: "Help", category: "core", ownerOnly: false, scope: "any", handler: () => "help text" },
    ]);
    turnContext = new TurnContextRegistry();
    let rowId = 0;
    history = { append: vi.fn(() => ++rowId), recent: vi.fn(() => []) };
    pipeline = build();
  });

  afterEach(async () => {
    await pipeline.stop();
  });

  async function sendFromChannel(msg: UnifiedMessage): Promise<void> {
    adapter.listeners[0]!(msg);
  }

  describe("commands", () => {
    it("an owner command is handled without calling the engine, replied plain, not re-sent", async () => {
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "/restart" }));
      await vi.waitFor(() => expect(adapter.sendText).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(restart).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(adapter.sendText).toHaveBeenCalledTimes(1);
      const params = adapter.sendText.mock.calls[0]![0];
      expect(params.text).toBe("Restarting");
      expect(params.plain).toBe(true);
      expect(params.ctx.replyToId).toBe("555");
    });

    it("a denied owner-only command is refused and never forwarded to the engine (dmPolicy open)", async () => {
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "/restart", senderId: STRANGER, chatId: STRANGER }));
      await vi.waitFor(() => expect(adapter.sendText).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(restart).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(sentTexts(adapter)).toEqual(["This command is owner-only."]);
    });

    it("an unknown /name continues to the agent (today's behaviour)", async () => {
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "/weather Cairo" }));
      await vi.waitFor(() => expect(execute).toHaveBeenCalled());
      expect((execute.mock.calls[0]![0] as IncomingMessage).text).toContain("/weather Cairo");
    });

    for (const text of ["/restart", "/approvals mode yolo", "/sandbox off"]) {
      it(`injected schedule text "${text}" is not dispatched and reaches the engine as plain text`, async () => {
        pipeline.start();
        const res = await pipeline.injectScheduleMessage({ channel: "telegram", chatId: OWNER, text, senderId: OWNER });
        expect(res.status).toBe("ok");
        expect(restart).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledTimes(1);
        expect((execute.mock.calls[0]![0] as IncomingMessage).text).toBe(text);
        expect(sentTexts(adapter)).toEqual(["agent reply"]);
      });
    }

    it("every injection origin is synthetic, never a command", async () => {
      pipeline.start();
      for (const origin of ["loop", "goal", "webhook"] as const) {
        await pipeline.injectMessage({ channel: "telegram", chatId: OWNER, text: "/restart", senderId: OWNER, origin });
      }
      expect(restart).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe("turn origin", () => {
    it("is owner_message for the owner's channel message, other_user for a stranger, and the inject origin for synthetic text", async () => {
      const seen: TurnInfo[] = [];
      execute.mockImplementation(async (msg: IncomingMessage) => {
        const key = `telegram:${msg.chatType}:${msg.chatId}`;
        seen.push(turnContext.get(key)!);
        return okResult("ok");
      });
      const events: TurnCompleteEvent[] = [];
      pipeline.onTurnComplete((ev) => events.push(ev));
      pipeline.start();

      await sendFromChannel(makeMessage({ text: "hi from owner" }));
      await vi.waitFor(() => expect(events).toHaveLength(1));
      await sendFromChannel(makeMessage({ text: "hi from stranger", senderId: STRANGER, chatId: STRANGER, id: "556" }));
      await vi.waitFor(() => expect(events).toHaveLength(2));
      // Injected with the owner's id as sender, as the daemon does for post-to-main.
      await pipeline.injectScheduleMessage({ channel: "telegram", chatId: OWNER, text: "scheduled", senderId: OWNER });
      expect(events).toHaveLength(3);

      expect(seen.map((s) => s.origin)).toEqual(["owner_message", "other_user", "schedule"]);
      expect(seen[0]!.textPreview).toBe("hi from owner");
      expect(seen[2]!.textPreview).toBeUndefined();
      expect(events.map((e) => e.origin)).toEqual(["owner_message", "other_user", "schedule"]);
      // The registry is cleared after each turn.
      expect(turnContext.get(`telegram:dm:${OWNER}`)).toBeUndefined();
      expect(events[0]!.userMsgId).toBe(1);
      expect(events[0]!.assistantMsgId).toBe(2);
      expect(events[0]!.result.response).toBe("ok");
    });
  });

  describe("forwarded messages", () => {
    it("are stored in chat history with the forwarded flag; typed ones without it", async () => {
      pipeline.start();
      await sendFromChannel(makeMessage({ id: "600", text: "forwarded text", isForwarded: true }));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      await sendFromChannel(makeMessage({ id: "601", text: "typed text" }));
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      const userRows = history.append.mock.calls.filter((c) => c[1] === "user");
      expect(userRows[0]![2]).toBe("forwarded text");
      expect(userRows[0]![3]).toMatchObject({ forwarded: true });
      expect(userRows[1]![3]).not.toHaveProperty("forwarded");
    });
  });

  describe("injectMessage", () => {
    it("returns busy with skipIfBusy and does not abort the running turn", async () => {
      const ctl = controllableEngine();
      await pipeline.stop();
      pipeline = build(ctl.engine);
      const abortSpy = vi.spyOn(pipeline, "abortSession");
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "long user turn" }));
      await vi.waitFor(() => expect(ctl.pending).toHaveLength(1));
      expect(pipeline.isBusy(`telegram:dm:${OWNER}`)).toBe(true);

      const res = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "loop tick", senderId: OWNER, origin: "loop", skipIfBusy: true,
      });
      expect(res).toEqual({ status: "busy" });
      expect(abortSpy).not.toHaveBeenCalled();
      expect(ctl.execute).toHaveBeenCalledTimes(1);
      ctl.pending[0]!.resolve(okResult("user answer"));
      await vi.waitFor(() => expect(sentTexts(adapter)).toContain("user answer"));
      expect(pipeline.isBusy(`telegram:dm:${OWNER}`)).toBe(false);
    });

    it("reports channel-down when the channel is not running", async () => {
      pipeline.start();
      (registry.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const res = await pipeline.injectMessage({ channel: "telegram", chatId: OWNER, text: "x", senderId: OWNER, origin: "loop" });
      expect(res.status).toBe("channel-down");
    });

    it("a quiet sentinel reply is neither sent nor stored as an assistant message", async () => {
      execute.mockResolvedValue(okResult("Nothing changed.\nNO_REPLY"));
      pipeline.start();
      const res = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "check the build", senderId: OWNER, origin: "loop",
        quietSentinels: ["NO_REPLY"], historyLabel: "[loop l-abc12] check the build",
      });
      expect(res.status).toBe("ok");
      expect(res.silent).toBe(true);
      expect(adapter.sendText).not.toHaveBeenCalled();
      const roles = history.append.mock.calls.map((c) => c[1]);
      expect(roles).toEqual(["user"]);
      expect(history.append.mock.calls[0]![2]).toBe("[loop l-abc12] check the build");
    });

    it("beforeDeliver can suppress a non-quiet reply: not sent, not stored, reported silent and suppressed", async () => {
      execute.mockResolvedValueOnce(okResult("same as before"));
      pipeline.start();
      const hook = vi.fn(() => "suppress" as const);
      const res = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "tick", senderId: OWNER, origin: "loop", quietSentinels: ["NO_REPLY"], beforeDeliver: hook,
      });
      expect(hook).toHaveBeenCalledWith("same as before");
      expect(res).toMatchObject({ status: "ok", response: "same as before", silent: true, suppressed: true });
      expect(adapter.sendText).not.toHaveBeenCalled();
      expect(history.append.mock.calls.filter((c) => c[1] === "assistant")).toHaveLength(0);
    });

    it("beforeDeliver is not asked about a quiet reply; \"send\" or a throwing hook sends the reply", async () => {
      pipeline.start();
      execute.mockResolvedValueOnce(okResult("NO_REPLY"));
      const hook = vi.fn(() => "suppress" as const);
      const quiet = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "tick", senderId: OWNER, origin: "loop", quietSentinels: ["NO_REPLY"], beforeDeliver: hook,
      });
      expect(hook).not.toHaveBeenCalled();
      expect(quiet).toMatchObject({ silent: true });
      expect(quiet.suppressed).toBeUndefined();

      execute.mockResolvedValueOnce(okResult("news"));
      const sent = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "tick", senderId: OWNER, origin: "loop", beforeDeliver: () => "send",
      });
      expect(sent.silent).toBeUndefined();
      execute.mockResolvedValueOnce(okResult("more news"));
      await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "tick", senderId: OWNER, origin: "loop", beforeDeliver: () => { throw new Error("boom"); },
      });
      expect(sentTexts(adapter)).toEqual(["news", "more news"]);
    });

    it("a non-quiet reply is sent without a replyToId (synthetic id)", async () => {
      pipeline.start();
      const res = await pipeline.injectMessage({
        channel: "telegram", chatId: OWNER, text: "check", senderId: OWNER, origin: "loop", quietSentinels: ["NO_REPLY"],
      });
      expect(res).toMatchObject({ status: "ok", response: "agent reply" });
      const params = adapter.sendText.mock.calls[0]![0];
      expect(params.ctx.replyToId).toBeUndefined();
    });
  });

  describe("listeners, transform and notes", () => {
    it("a throwing turn listener or transform does not break the reply", async () => {
      pipeline.onTurnComplete(() => { throw new Error("listener boom"); });
      pipeline.setMessageTransform(async () => { throw new Error("transform boom"); });
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "hello" }));
      await vi.waitFor(() => expect(sentTexts(adapter)).toEqual(["agent reply"]));
      expect((execute.mock.calls[0]![0] as IncomingMessage).text).toBe("hello");
    });

    it("the transform rewrites the text the engine sees, not the stored history", async () => {
      pipeline.setMessageTransform(async (text) => text.toUpperCase());
      pipeline.start();
      await sendFromChannel(makeMessage({ text: "hello" }));
      await vi.waitFor(() => expect(execute).toHaveBeenCalled());
      expect((execute.mock.calls[0]![0] as IncomingMessage).text).toBe("HELLO");
      expect(history.append.mock.calls[0]![2]).toBe("hello");
    });

    it("a next-turn note is used once", async () => {
      pipeline.addNextTurnNote(`telegram:dm:${OWNER}`, "Files were restored by /undo.");
      pipeline.start();
      await pipeline.injectMessage({ channel: "telegram", chatId: OWNER, text: "first", senderId: OWNER, origin: "loop" });
      await pipeline.injectMessage({ channel: "telegram", chatId: OWNER, text: "second", senderId: OWNER, origin: "loop" });
      const texts = execute.mock.calls.map((c) => (c[0] as IncomingMessage).text);
      expect(texts[0]).toBe("<system_note>Files were restored by /undo.</system_note>first");
      expect(texts[1]).toBe("second");
    });

    it("onTurnError fires on a failure and an unsubscribed listener is not called", async () => {
      execute.mockRejectedValue(new Error("engine down"));
      const errors: unknown[] = [];
      const late = vi.fn();
      pipeline.onTurnError((ev) => errors.push(ev));
      const off = pipeline.onTurnError(late);
      off();
      pipeline.start();
      const res = await pipeline.injectMessage({ channel: "telegram", chatId: OWNER, text: "x", senderId: OWNER, origin: "goal" });
      expect(res.status).toBe("error");
      expect(errors).toEqual([{ sessionKey: `telegram:dm:${OWNER}`, name: "Error", message: "engine down" }]);
      expect(late).not.toHaveBeenCalled();
    });
  });

  describe("scheduled post-to-main during a user turn (DECISIONS 16)", () => {
    it("does not abort, is retried, and is delivered once the chat is idle", async () => {
      const ctl = controllableEngine();
      await pipeline.stop();
      pipeline = build(ctl.engine);
      const abortSpy = vi.spyOn(pipeline, "abortSession");
      let now = 1_000_000;
      const notices: string[] = [];
      const queue = new ScheduledInjectionQueue({
        inject: (ev) => pipeline.injectScheduleMessage({ channel: ev.channel, chatId: ev.chatId, text: ev.message, senderId: ev.chatId }),
        notifyOwner: (t) => { notices.push(t); },
        now: () => now,
      });
      pipeline.start();

      await sendFromChannel(makeMessage({ text: "user is talking" }));
      await vi.waitFor(() => expect(ctl.pending).toHaveLength(1));

      const first = await queue.deliver({ name: "morning-brief", message: "Give me the brief", channel: "telegram", chatId: OWNER });
      expect(first.status).toBe("busy");
      expect(queue.pendingCount()).toBe(1);

      // Not due yet.
      now += 10_000;
      await queue.onTick();
      expect(ctl.execute).toHaveBeenCalledTimes(1);

      // Due but still busy.
      now += 25_000;
      await queue.onTick();
      expect(ctl.execute).toHaveBeenCalledTimes(1);
      expect(abortSpy).not.toHaveBeenCalled();

      // Still busy at 30 minutes: one notice naming the schedule, retries continue.
      now += 30 * 60_000;
      await queue.onTick();
      now += 31_000;
      await queue.onTick();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("morning-brief");
      expect(queue.pendingCount()).toBe(1);

      // The user turn finishes; the next retry delivers.
      ctl.pending[0]!.resolve(okResult("user answer"));
      await vi.waitFor(() => expect(pipeline.isBusy(`telegram:dm:${OWNER}`)).toBe(false));
      now += 31_000;
      const tick = queue.onTick();
      await vi.waitFor(() => expect(ctl.pending).toHaveLength(2));
      expect((ctl.pending[1]!.msg).text).toBe("Give me the brief");
      ctl.pending[1]!.resolve(okResult("brief"));
      await tick;
      expect(queue.pendingCount()).toBe(0);
      expect(abortSpy).not.toHaveBeenCalled();
      expect(sentTexts(adapter)).toEqual(["user answer", "brief"]);
      expect(notices).toHaveLength(1);
    });

    it("an idle chat gets the scheduled message at once", async () => {
      const queue = new ScheduledInjectionQueue({
        inject: (ev) => pipeline.injectScheduleMessage({ channel: ev.channel, chatId: ev.chatId, text: ev.message, senderId: ev.chatId }),
      });
      pipeline.start();
      const res = await queue.deliver({ name: "n", message: "hello", channel: "telegram", chatId: OWNER });
      expect(res.status).toBe("ok");
      expect(queue.pendingCount()).toBe(0);
    });
  });
});

describe("helpers", () => {
  it("isSyntheticId matches only injected ids", () => {
    expect(isSyntheticId("schedule-1738000000000")).toBe(true);
    expect(isSyntheticId("loop-1")).toBe(true);
    expect(isSyntheticId("goal-1")).toBe(true);
    expect(isSyntheticId("webhook-1")).toBe(true);
    expect(isSyntheticId("12345")).toBe(false);
    expect(isSyntheticId("schedule-abc")).toBe(false);
    expect(isSyntheticId("x-schedule-1")).toBe(false);
  });

  it("isQuietReply matches a reply that is or ends with a sentinel", () => {
    expect(isQuietReply("NO_REPLY", ["NO_REPLY"])).toBe(true);
    expect(isQuietReply("  all good\nNO_REPLY  ", ["NO_REPLY"])).toBe(true);
    expect(isQuietReply("NO_REPLY but the build broke", ["NO_REPLY"])).toBe(false);
    expect(isQuietReply("anything", undefined)).toBe(false);
    expect(isQuietReply("", ["NO_REPLY"])).toBe(false);
  });
});
