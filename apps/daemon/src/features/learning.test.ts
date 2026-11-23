import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  CommandRegistry,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  TurnContextRegistry,
  USAGE_TRACKING_STARTED_KEY,
  type ExecutionResult,
  type TurnCompleteEvent,
} from "@kirie/core";
import type { DaemonContext } from "./types.js";
import { MEMORY_PROPOSE_ADDENDUM, getLearningSystem, setupLearning } from "./learning.js";

const OWNER = "1001";
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-feature-learning-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function context(learning: Record<string, unknown> = {}): DaemonContext & { heartbeat: EventEmitter; turnListeners: Array<(ev: TurnCompleteEvent) => void> } {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const turnListeners: Array<(ev: TurnCompleteEvent) => void> = [];
  const actions = new Map<string, unknown>();
  const ctx = {
    config: KirieConfigSchema.parse({ learning }),
    dataDir: dir,
    agentCwd: dir,
    commands: new CommandRegistry({ owners }),
    owners,
    ownerPrompts: { sendCard: vi.fn(async () => null), onAction: (ns: string, h: unknown) => { actions.set(ns, h); } },
    settings: new RuntimeSettings(join(dir, "state", "runtime-settings.json")),
    audit: new AuditTrail(join(dir, "logs", "audit.jsonl")),
    sdkOptions: new SdkOptionsPipeline(),
    turnContext: new TurnContextRegistry(),
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    pipeline: { onTurnComplete: (l: (ev: TurnCompleteEvent) => void) => { turnListeners.push(l); return () => { turnListeners.splice(turnListeners.indexOf(l), 1); }; } },
    heartbeat: new EventEmitter(),
    chatHistoryStore: { recent: () => [] },
    memoryManager: null,
    kirieToolsEnv: {} as Record<string, string>,
    turnListeners,
    actions,
  };
  return ctx as unknown as DaemonContext & { heartbeat: EventEmitter; turnListeners: Array<(ev: TurnCompleteEvent) => void> };
}

function ownerTurn(n: number): TurnCompleteEvent {
  const now = Date.now();
  return {
    sessionKey: `telegram:dm:${OWNER}`, origin: "owner_message", channel: "telegram", senderId: OWNER, senderRole: "owner",
    userMsgId: n * 2, assistantMsgId: n * 2 + 1, startedAt: now - 1000, endedAt: now, durationMs: 1000,
    result: { response: "ok", sessionId: "s", costUsd: 0, numTurns: 1, isError: false } as ExecutionResult,
  };
}

describe("learning feature", () => {
  it("registers the guard, observer, commands, button namespace and tool env; no addendum with the direct memory policy", async () => {
    const ctx = context();
    const handle = await setupLearning(ctx);
    expect(ctx.sdkOptions.gateNames()).toContain("skill-write-guard");
    expect(ctx.commands.list().map((c) => c.name).sort()).toEqual(["learn", "proposals"]);
    expect((ctx as unknown as { actions: Map<string, unknown> }).actions.has("prop")).toBe(true);
    expect(Object.keys(ctx.kirieToolsEnv).sort()).toEqual(["KIRIE_LEARNING_CONFIG", "KIRIE_LEARNING_SKILLS_ROOT"]);
    expect(ctx.kirieToolsEnv.KIRIE_LEARNING_SKILLS_ROOT).toBe(join(dir, ".claude", "skills"));
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toBe("");
    expect(ctx.internalApi.apps()).toEqual([]);
    expect(existsSync(join(dir, "learning.db"))).toBe(true);
    const system = getLearningSystem(ctx)!;
    expect(system.kv.get(USAGE_TRACKING_STARTED_KEY)).toBeTruthy();
    await handle.start?.();
    expect(ctx.heartbeat.listenerCount("tick")).toBe(1);
    await handle.stop?.();
    expect(ctx.heartbeat.listenerCount("tick")).toBe(0);
    expect(ctx.turnListeners).toHaveLength(0);
    expect(ctx.sdkOptions.gateNames()).not.toContain("skill-write-guard");
    expect(getLearningSystem(ctx)).toBeNull();
  });

  it("is off by default: turns are logged but no reflection runs, on turns or on ticks", async () => {
    const ctx = context({ minTurns: 1 });
    const handle = await setupLearning(ctx);
    await handle.start?.();
    const system = getLearningSystem(ctx)!;
    const run = vi.spyOn(system.reflection, "run");
    for (let i = 1; i <= 5; i++) ctx.turnListeners.forEach((l) => l(ownerTurn(i)));
    for (let t = 1; t <= 12; t++) ctx.heartbeat.emit("tick", { tickNumber: t * 6, timestamp: Date.now(), pendingRetries: 0, scheduleFires: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(system.recorder.lastTurn(`telegram:dm:${OWNER}`)).toMatchObject({ origin: "owner_message" });
    await handle.stop?.();
  });

  it("the memoryPolicy propose variant adds the override addendum", async () => {
    const ctx = context({ memoryPolicy: "propose" });
    const handle = await setupLearning(ctx);
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toContain(MEMORY_PROPOSE_ADDENDUM);
    await handle.stop?.();
  });

  it("the guard denies a background task's skill write through the SDK options", async () => {
    const ctx = context();
    const handle = await setupLearning(ctx);
    const options: Parameters<SdkOptionsPipeline["apply"]>[0] = { model: "m", permissionMode: "bypassPermissions", cwd: dir };
    ctx.sdkOptions.apply(options, { kind: "background", taskId: "t1", ownerDm: false, interactive: false, label: "task", cwd: dir });
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const out = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, ".claude", "skills", "x", "SKILL.md") }, tool_use_id: "tu", session_id: "s", transcript_path: "/t", cwd: dir } as never,
      "tu",
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await handle.stop?.();
  });
});
