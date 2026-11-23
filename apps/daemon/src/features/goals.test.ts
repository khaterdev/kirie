import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BackgroundTaskStore,
  CommandRegistry,
  GoalStore,
  KirieConfigSchema,
  OwnerDirectory,
  RuntimeSettings,
  SdkOptionsPipeline,
  GOAL_OFF_TEXT,
  type CommandReply,
  type ResolvedIdentity,
  type UnifiedMessage,
} from "@kirie/core";
import { TaskHooks } from "../task-hooks.js";
import { setupGoals } from "./goals.js";
import type { DaemonContext, FeatureHandle } from "./types.js";

const OWNER = "1001";

describe("setupGoals", () => {
  let dir: string;
  let ctx: DaemonContext;
  let handle: FeatureHandle;
  let sent: Array<{ chatId: string; text: string; plain?: boolean }>;
  let cancelTask: ReturnType<typeof vi.fn>;
  let taskStore: BackgroundTaskStore;

  function makeContext(): DaemonContext {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    sent = [];
    const adapter = {
      sendText: vi.fn(async (p: { ctx: { chatId: string }; text: string; plain?: boolean }) => {
        sent.push({ chatId: p.ctx.chatId, text: p.text, plain: p.plain });
        return [];
      }),
    };
    return {
      config: KirieConfigSchema.parse({}),
      dataDir: dir,
      agentCwd: dir,
      commands: new CommandRegistry({ owners }),
      owners,
      ownerPrompts: { ask: vi.fn(async () => ({ optionId: "decline", outcome: "unavailable", code: "" })) },
      settings: new RuntimeSettings(join(dir, "state", "runtime-settings.json")),
      audit: { record: vi.fn() },
      sdkOptions: new SdkOptionsPipeline(),
      taskHooks: new TaskHooks(),
      channelRegistry: { getById: () => adapter, isRunning: () => true },
      backgroundTaskStore: taskStore,
      backgroundTaskManager: { cancelTask },
    } as unknown as DaemonContext;
  }

  async function run(text: string): Promise<string> {
    const replies: CommandReply[] = [];
    const message = { id: "1", channel: "telegram", senderId: OWNER, senderName: "o", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null } as UnifiedMessage;
    await ctx.commands.dispatch({
      message,
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r) => {
        replies.push(r);
      },
    });
    return replies.map((r) => r.text).join("\n");
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-goals-feature-"));
    taskStore = new BackgroundTaskStore(join(dir, "background-tasks.db"));
    cancelTask = vi.fn(() => false);
    ctx = makeContext();
    handle = await setupGoals(ctx);
  });

  afterEach(async () => {
    await handle.stop?.();
    taskStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers /goal and the goal task hooks", () => {
    expect(handle.name).toBe("goals");
    expect(ctx.commands.get("goal")).toMatchObject({ ownerOnly: true, scope: "dm" });
    const task = taskStore.create("telegram:dm:1001", "Goal g-aaaaaa: x", "x", { origin: "goal", profile: "goal", data: { goalId: "g-aaaaaa" } });
    expect(ctx.taskHooks.controllerFor(task)?.ownsCompletion).toBe(true);
    expect(ctx.taskHooks.profileFor(task)?.kind).toBe("goal");
    expect(ctx.taskHooks.completionHandlerFor(task)).toBeTypeOf("function");
    expect(ctx.taskHooks.failureHandlerFor(task)).toBeTypeOf("function");
    // A plain background task is untouched.
    expect(ctx.taskHooks.controllerFor(taskStore.create("k", "d", "p"))).toBeUndefined();
  });

  it("ships off; /goal on persists across a restart", async () => {
    expect(await run("/goal fix it")).toBe(GOAL_OFF_TEXT);
    const kv = new GoalStore(join(dir, "goals.db"));
    expect(kv.getKv("goals.enabled")).toBe("false");
    await run("/goal on");
    expect(kv.getKv("goals.enabled")).toBe("true");
    kv.close();
    await handle.stop?.();

    // Restart: a fresh context reads the same settings file.
    ctx = makeContext();
    handle = await setupGoals(ctx);
    expect(await run("/goal fix it")).not.toBe(GOAL_OFF_TEXT);
  });

  it("evaluates check commands through the tool gates; a denied check rejects the goal", async () => {
    ctx.sdkOptions.registerGate({
      name: "approvals",
      order: 900,
      check: (call) => (String(call.input.command).includes("rm -rf") ? { decision: "deny", reason: "hardline" } : { decision: "pass" }),
    });
    await run("/goal on");
    expect(await run("/goal clean --check \"rm -rf build\"")).toContain("denied by the tool gates (hardline)");
    // The reply echoes the checks and caps as parsed (RUNTIME-B1).
    expect(await run("/goal fix --check \"pnpm test\"")).toMatch(/^Goal g-[a-z2-7]{6} accepted\.\nChecks \(each must exit 0 before the judge is asked\):\n  1\. pnpm test\nCaps: /);
    const store = new GoalStore(join(dir, "goals.db"));
    expect(store.listRecent().map((g) => g.goal)).toEqual(["fix"]);
    store.close();
  });

  it("posts goal messages to the goal's chat as plain text once started", async () => {
    await run("/goal on");
    await run("/goal fix the tests");
    await handle.start?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.some((m) => m.chatId === OWNER && m.plain === true && /Goal g-[a-z2-7]{6} started/.test(m.text))).toBe(true);
    const task = taskStore.listByStatus("pending")[0]!;
    expect(task.meta).toMatchObject({ origin: "goal", profile: "goal" });
  });

  it("reconciles at setup: a worker of a paused goal is cancelled before the task manager could resume it", async () => {
    await handle.stop?.();
    const store = new GoalStore(join(dir, "goals.db"));
    const g = store.create({ sessionKey: "telegram:dm:1001", goal: "x", status: "pending", maxRounds: 1, maxMinutes: 1, maxCostUsd: 1, createdBy: "owner" });
    const t = taskStore.create("telegram:dm:1001", "Goal", "x", { origin: "goal", profile: "goal", data: { goalId: g.id } });
    taskStore.markRunning(t.id, "sess-x");
    store.transition(g.id, ["pending"], "running", { taskId: t.id });
    store.transition(g.id, ["running"], "paused");
    store.close();
    ctx = makeContext();
    handle = await setupGoals(ctx);
    expect(taskStore.get(t.id)!.status).toBe("cancelled");
  });
});
