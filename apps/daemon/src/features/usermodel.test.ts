import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
  type TurnCompleteEvent,
} from "@kirie/core";
import type { DaemonContext } from "./types.js";
import { getLearningSystem, setupLearning } from "./learning.js";
import { getUserModelSystem, setupUserModel } from "./usermodel.js";
import type { SdkCallContext } from "@kirie/core";

const OWNER = "1001";
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-feature-usermodel-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type TestContext = DaemonContext & { heartbeat: EventEmitter; turnListeners: Array<(ev: TurnCompleteEvent) => void>; closeIdle: ReturnType<typeof vi.fn> };

function context(over: Record<string, unknown> = {}): TestContext {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const turnListeners: Array<(ev: TurnCompleteEvent) => void> = [];
  const closeIdle = vi.fn(() => 0);
  const ctx = {
    config: KirieConfigSchema.parse(over),
    dataDir: dir,
    agentCwd: dir,
    commands: new CommandRegistry({ owners }),
    owners,
    ownerPrompts: { sendCard: vi.fn(async () => null), onAction: () => {} },
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
    embeddingProvider: null,
    v2Sessions: { closeIdleSessions: closeIdle },
    kirieToolsEnv: {} as Record<string, string>,
    turnListeners,
    closeIdle,
  };
  return ctx as unknown as TestContext;
}

const OWNER_DM = { kind: "chat" as const, channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true };

describe("usermodel feature", () => {
  it("registers /profile, the addendum, the tool env and the user_fact.add kind; stop cleans up", async () => {
    const ctx = context();
    const learning = await setupLearning(ctx);
    const handle = await setupUserModel(ctx);
    expect(ctx.commands.list().map((c) => c.name)).toContain("profile");
    expect(ctx.promptAddenda.names()).toContain("user-model");
    expect(JSON.parse(ctx.kirieToolsEnv.KIRIE_USERMODEL_CONFIG!)).toMatchObject({ enabled: false });
    expect(getLearningSystem(ctx)!.applier.hasKind("user_fact.add")).toBe(true);
    expect(ctx.internalApi.apps()).toEqual([]);
    await handle.start?.();
    expect(ctx.heartbeat.listenerCount("tick")).toBe(1);
    await handle.stop?.();
    expect(ctx.heartbeat.listenerCount("tick")).toBe(0);
    expect(ctx.promptAddenda.names()).not.toContain("user-model");
    expect(ctx.turnListeners).toHaveLength(1);
    expect(getUserModelSystem(ctx)).toBeNull();
    await learning.stop?.();
  });

  it("works without the learning feature (no proposals kind)", async () => {
    const ctx = context();
    const handle = await setupUserModel(ctx);
    expect(getUserModelSystem(ctx)).not.toBeNull();
    await handle.stop?.();
  });

  it("is off by default: no derivation on ticks or turns, no addendum, even with history and facts", async () => {
    const ctx = context();
    const handle = await setupUserModel(ctx);
    await handle.start?.();
    const system = getUserModelSystem(ctx)!;
    system.store.insert({ category: "communication", statement: "Prefers short replies", kind: "explicit", confidence: 0.8, evidence: [], now: new Date() });
    system.refreshCard();
    const run = vi.spyOn(system.deriver, "run");
    const maybe = vi.spyOn(system.deriver, "maybeRun");
    for (let t = 1; t <= 20; t++) ctx.heartbeat.emit("tick", { tickNumber: t * 60, timestamp: Date.now(), pendingRetries: 0, scheduleFires: 0, sessionsPruned: 0 });
    ctx.turnListeners.forEach((l) => l({ sessionKey: `telegram:dm:${OWNER}`, origin: "owner_message", channel: "telegram", senderId: OWNER, senderRole: "owner", startedAt: 0, endedAt: 1, durationMs: 1, result: {} as never, inputs: { chatType: "dm", forwarded: false, replyContext: false, taskResults: false, attachments: false } }));
    expect(run).not.toHaveBeenCalled();
    expect(maybe).not.toHaveBeenCalled();
    expect(ctx.promptAddenda.render(OWNER_DM)).toBe("");
    await handle.stop?.();
  });

  it("/profile on makes the card reach the owner's DM prompt only; /profile off closes idle sessions", async () => {
    const ctx = context();
    const handle = await setupUserModel(ctx);
    const system = getUserModelSystem(ctx)!;
    system.store.insert({ category: "communication", statement: "Prefers short replies", kind: "explicit", confidence: 0.8, evidence: [], now: new Date() });
    system.refreshCard();
    const send = async (text: string): Promise<void> => {
      await ctx.commands.dispatch({
        message: { id: `m${Math.random()}`, channel: "telegram", senderId: OWNER, senderName: "o", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null },
        identity: { role: "owner", canonicalId: `telegram:${OWNER}`, channel: "telegram", senderId: OWNER },
        source: "channel",
        send: async () => {},
      });
    };
    await send("/profile on");
    expect(ctx.promptAddenda.render(OWNER_DM)).toContain("Prefers short replies");
    expect(ctx.promptAddenda.render({ ...OWNER_DM, senderRole: "user", ownerDm: false })).toBe("");
    expect(ctx.promptAddenda.render({ ...OWNER_DM, chatType: "group", ownerDm: false })).toBe("");
    expect(ctx.promptAddenda.render({ kind: "background", ownerDm: false })).toBe("");
    await send("/profile off");
    expect(ctx.closeIdle).toHaveBeenCalledWith(0);
    expect(ctx.promptAddenda.render(OWNER_DM)).toBe("");
    await handle.stop?.();
  });

  it("the reserved-mcp gate allows user_model_query only in the owner's DM chat", async () => {
    const ctx = context();
    const handle = await setupUserModel(ctx);
    const decide = async (c: Partial<SdkCallContext>): Promise<unknown> => {
      const options: Parameters<SdkOptionsPipeline["apply"]>[0] = { model: "m", permissionMode: "bypassPermissions", cwd: dir };
      ctx.sdkOptions.apply(options, { kind: "chat", ownerDm: false, interactive: true, label: "t", cwd: dir, ...c } as SdkCallContext);
      const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
      const out = (await hook(
        { hook_event_name: "PreToolUse", tool_name: "mcp__kirie-tools__user_model_query", tool_input: { question: "x" }, tool_use_id: "tu", session_id: "s", transcript_path: "/t", cwd: dir } as never,
        "tu",
        { signal: new AbortController().signal },
      )) as { hookSpecificOutput?: { permissionDecision?: string } };
      return out.hookSpecificOutput?.permissionDecision ?? "allow";
    };
    expect(await decide({ kind: "chat", ownerDm: true, chatType: "dm", channel: "telegram" })).toBe("allow");
    expect(await decide({ kind: "chat", ownerDm: false, chatType: "group", channel: "telegram" })).toBe("deny");
    expect(await decide({ kind: "chat", ownerDm: false, chatType: "dm", channel: "telegram", senderRole: "user" })).toBe("deny");
    expect(await decide({ kind: "chat", ownerDm: true, chatType: "dm", channel: "voice" })).toBe("deny");
    expect(await decide({ kind: "background", ownerDm: false, interactive: false })).toBe("deny");
    expect(await decide({ kind: "webhook", ownerDm: false, interactive: false })).toBe("deny");
    await handle.stop?.();
  });
});
