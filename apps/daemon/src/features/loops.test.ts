import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommandRegistry,
  KirieConfigSchema,
  LoopStore,
  OwnerDirectory,
  RuntimeSettings,
  effectiveSettingFlag,
  type CommandReply,
  type InjectMessageOptions,
  type InjectMessageResult,
  type ProactiveEngineStatus,
  type UnifiedMessage,
} from "@kirie/core";
import { setupLoops } from "./loops.js";
import { setupHeartbeatControl } from "./heartbeat-control.js";
import type { DaemonContext, FeatureHandle } from "./types.js";

const OWNER = "1001";
const STRANGER = "2002";

interface Harness {
  ctx: DaemonContext;
  heartbeat: EventEmitter;
  inject: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  historyAppend: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
}

function harness(dataDir: string, over: Partial<DaemonContext> = {}, config: Record<string, unknown> = {}): Harness {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const heartbeat = new EventEmitter();
  const inject = vi.fn(async (_o: InjectMessageOptions): Promise<InjectMessageResult> => ({ status: "ok", response: "NO_REPLY", silent: true }));
  const sendText = vi.fn(async () => [{ id: "s1", timestamp: Date.now() }]);
  const historyAppend = vi.fn(() => 1);
  const ask = vi.fn(async () => ({ optionId: "start", outcome: "answered", code: "K7Q2" }));
  const audit = vi.fn();
  const ctx = {
    config: KirieConfigSchema.parse({ proactive: { heartbeatFile: join(dataDir, "HEARTBEAT.md") }, ...config }),
    dataDir,
    agentCwd: dataDir,
    commands: new CommandRegistry({ owners }),
    owners,
    ownerPrompts: { ask },
    settings: new RuntimeSettings(join(dataDir, "state", "runtime-settings.json")),
    audit: { record: audit },
    channelRegistry: { getById: () => ({ sendText }), isRunning: () => true },
    pipeline: { injectMessage: inject, isBusy: () => false },
    heartbeat,
    proactive: null,
    heartbeatLogStore: null,
    scheduleStore: { list: () => [] },
    chatHistoryStore: { append: historyAppend },
    kirieToolsEnv: {},
    notifyOwner: vi.fn(async () => {}),
    ...over,
  } as unknown as DaemonContext;
  return { ctx, heartbeat, inject, sendText, historyAppend, ask, audit };
}

/** Dispatch a channel message through the real registry; returns the reply texts. */
async function send(ctx: DaemonContext, text: string, senderId = OWNER): Promise<string[]> {
  const replies: string[] = [];
  const message = {
    id: "m1", channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, raw: {},
  } as unknown as UnifiedMessage;
  await ctx.commands.dispatch({
    message,
    identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" },
    source: "channel",
    send: async (r: CommandReply) => { replies.push(r.text); },
  });
  return replies;
}

async function tick(h: Harness): Promise<void> {
  h.heartbeat.emit("tick", { tickNumber: 1, timestamp: Date.now(), pendingRetries: 0, scheduleFires: 0, sessionsPruned: 0 });
  // Let the started tick and its result handling finish
  await new Promise((r) => setTimeout(r, 20));
}

describe("setupLoops", () => {
  let dataDir: string;
  let handle: FeatureHandle;
  let h: Harness;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "kirie-feat-loops-"));
    h = harness(dataDir);
    handle = await setupLoops(h.ctx);
    await handle.start?.();
  });

  afterEach(async () => {
    await handle.stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("registers /loop and hands the boot loops config to the tools env (off by default)", () => {
    expect(h.ctx.commands.get("loop")).toMatchObject({ ownerOnly: true, scope: "dm" });
    expect(JSON.parse(h.ctx.kirieToolsEnv.KIRIE_LOOPS_CONFIG!)).toMatchObject({ enabled: false, agentCreate: "ask" });
  });

  it("is off by default; /loop on persists; then a loop runs on the heartbeat tick", async () => {
    expect(await send(h.ctx, "/loop 5m check the deploy")).toEqual(["Loops are off. Turn them on with /loop on, then send this again."]);
    expect((await send(h.ctx, "/loop on"))[0]).toMatch(/^Loops are on\./);
    expect(effectiveSettingFlag(new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { readonly: true }), "loops.enabled", false)).toBe(true);
    expect((await send(h.ctx, "/loop 5m check the deploy"))[0]).toMatch(/^Started loop l-/);
    await tick(h);
    expect(h.inject).toHaveBeenCalledTimes(1);
    expect(h.inject.mock.calls[0]![0]).toMatchObject({ origin: "loop", skipIfBusy: true, channel: "telegram", chatId: OWNER, senderId: OWNER });
  });

  it("a non-owner cannot use /loop", async () => {
    expect(await send(h.ctx, "/loop on", STRANGER)).toEqual(["This command is owner-only."]);
    expect(effectiveSettingFlag(h.ctx.settings, "loops.enabled", false)).toBe(false);
  });

  it("loops and the on switch survive a restart; the overdue run happens once, soon after start", async () => {
    await send(h.ctx, "/loop on");
    await send(h.ctx, "/loop 5m check the deploy");
    await handle.stop?.();

    const h2 = harness(dataDir);
    const store = new LoopStore(join(dataDir, "loops.db"));
    const [loop] = store.list();
    store.update(loop!.id, { nextRunAt: Date.now() - 3_600_000 });
    store.close();
    handle = await setupLoops(h2.ctx);
    await handle.start?.();
    const reread = new LoopStore(join(dataDir, "loops.db"));
    const after = reread.get(loop!.id)!;
    reread.close();
    expect(after.status).toBe("active");
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(after.nextRunAt - Date.now()).toBeLessThanOrEqual(15_000);
    expect((await send(h2.ctx, "/loop list"))[0]).toContain("Loops are on. 1 loop:");
  });

  it("a LOOP_COMPLETE reply is sent without the marker and kept in chat history", async () => {
    await send(h.ctx, "/loop on");
    await send(h.ctx, "/loop 5m check the deploy");
    h.inject.mockResolvedValueOnce({ status: "ok", response: "Healthy now.\nLOOP_COMPLETE", silent: true });
    await tick(h);
    expect(h.sendText).toHaveBeenCalledWith({ ctx: { chatId: OWNER }, text: "Healthy now." });
    expect(h.historyAppend).toHaveBeenCalledWith(`telegram:dm:${OWNER}`, "assistant", "Healthy now.", { channel: "telegram" });
    expect(h.sendText.mock.calls.some((c) => (c[0] as { plain?: boolean }).plain === true)).toBe(true);
  });

  it("an agent-created loop asks the owner with Start / Decline, default Decline", async () => {
    await send(h.ctx, "/loop on");
    const store = new LoopStore(join(dataDir, "loops.db"));
    const loop = store.create({
      sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", chatId: OWNER, chatType: "dm", prompt: "watch the queue",
      intervalSec: 300, backoff: true, maxRuns: 10, expiresAt: Date.now() + 3_600_000, createdBy: "agent", status: "pending_approval",
    });
    store.close();
    await send(h.ctx, "/loop list"); // any local change reloads; the heartbeat also reloads every 6 ticks
    await tick(h);
    expect(h.ask).toHaveBeenCalledWith(expect.objectContaining({
      kind: "loop",
      options: [{ id: "start", label: "Start" }, { id: "decline", label: "Decline" }],
      defaultOptionId: "decline",
    }));
    await vi.waitFor(() => {
      const s = new LoopStore(join(dataDir, "loops.db"));
      const status = s.get(loop.id)!.status;
      s.close();
      expect(status).toBe("active");
    });
  });
});

describe("setupHeartbeatControl", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "kirie-feat-hb-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function engine(running: boolean) {
    const state = { running, interval: 15, snoozedUntil: 0 };
    return {
      state,
      start: vi.fn(() => { state.running = true; }),
      stop: vi.fn(() => { state.running = false; }),
      get isRunning() { return state.running; },
      runTriage: vi.fn(async () => ({ signalsProcessed: 0, decisions: [] })),
      setTier2IntervalMinutes: vi.fn((m: number) => { state.interval = m; }),
      snooze: vi.fn((u: number | null) => { state.snoozedUntil = u ?? 0; }),
      status: (): ProactiveEngineStatus => ({
        running: state.running, signalQueueSize: 0, lastTriageAt: 0, nextTriageAt: 0, digestQueueSize: 0,
        dedupCacheSize: 0, notifiedTypesCacheSize: 0, tier2IntervalMinutes: state.interval, snoozedUntil: state.snoozedUntil,
        triageInProgress: false,
      }),
    };
  }

  it("/heartbeat off then on persist across a restart (what lifecycle reads at boot)", async () => {
    const e = engine(true);
    const h = harness(dataDir, { proactive: e as unknown as DaemonContext["proactive"] });
    await setupHeartbeatControl(h.ctx);
    await send(h.ctx, "/heartbeat off");
    expect(e.stop).toHaveBeenCalled();
    const boot = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { readonly: true });
    expect(effectiveSettingFlag(boot, "proactive.enabled", true)).toBe(false);
    await send(h.ctx, "/hb on");
    expect(effectiveSettingFlag(new RuntimeSettings(boot.path, { readonly: true }), "proactive.enabled", true)).toBe(true);
  });

  it("/heartbeat on after a boot with the heartbeat off starts the engine with no restart note", async () => {
    const e = engine(false);
    const h = harness(dataDir, { proactive: e as unknown as DaemonContext["proactive"] }, { proactive: { enabled: false, heartbeatFile: join(dataDir, "HEARTBEAT.md") } });
    await setupHeartbeatControl(h.ctx);
    const [reply] = await send(h.ctx, "/heartbeat on");
    expect(e.start).toHaveBeenCalled();
    expect(reply).toContain("Heartbeat on");
    expect(reply).not.toMatch(/after a restart|proactive_status/);
  });

  it("applies the persisted interval and snooze to the engine at setup", async () => {
    const settings = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"));
    settings.set("proactive.tier2IntervalMinutes", 30, "owner:telegram:1001");
    settings.set("proactive.snoozedUntil", Date.now() + 3_600_000, "owner:telegram:1001");
    const e = engine(true);
    const h = harness(dataDir, { proactive: e as unknown as DaemonContext["proactive"] });
    await setupHeartbeatControl(h.ctx);
    expect(e.setTier2IntervalMinutes).toHaveBeenCalledWith(30);
    expect(e.snooze).toHaveBeenCalledWith(expect.any(Number));
  });

  it("status counts active loops from loops.db and edits the configured checklist file", async () => {
    const store = new LoopStore(join(dataDir, "loops.db"));
    store.create({
      sessionKey: "telegram:dm:1001", channel: "telegram", chatId: OWNER, chatType: "dm", prompt: "x",
      intervalSec: 300, backoff: true, maxRuns: 10, expiresAt: Date.now() + 3_600_000, createdBy: "owner", status: "active",
    });
    store.close();
    writeFileSync(join(dataDir, "HEARTBEAT.md"), "- first\n");
    const h = harness(dataDir, { proactive: engine(true) as unknown as DaemonContext["proactive"] });
    const handle = await setupHeartbeatControl(h.ctx);
    expect((await send(h.ctx, "/heartbeat"))[0]).toContain("active loops: 1, schedules: 0");
    expect((await send(h.ctx, "/heartbeat add second"))[0]).toBe("Added item 2: second\nThe next triage reads it.");
    await handle.stop?.();
  });
});
