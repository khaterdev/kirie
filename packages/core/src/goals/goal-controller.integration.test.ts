import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The goal controller driving the real BackgroundTaskManager and
 * BackgroundTaskStore. The SDK's query() is a scripted streaming mock that
 * consumes the prompt iterable: per pushed message one assistant message and
 * one result with a growing cumulative cost. A goal text containing HANG
 * makes the worker hang until the query is closed. No model call, no shell.
 */
const rec = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, unknown>;
    messages: string[];
    close: ReturnType<typeof import("vitest").vi.fn>;
    streamDone: boolean;
  }>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    let release: () => void = () => {};
    const closed = new Promise<void>((r) => (release = r));
    const call = { options, messages: [] as string[], close: vi.fn(() => release()), streamDone: false };
    rec.calls.push(call);
    const session = (options.resume as string | undefined) ?? `sess-${rec.calls.length}`;
    let cost = 0;
    const stream = (async function* () {
      try {
      for await (const raw of prompt) {
        const content = (raw as { message: { content: string } }).message.content;
        call.messages.push(content);
        if (content.includes("HANG")) {
          await closed;
          return;
        }
        cost += 0.25;
        yield { type: "assistant", session_id: session, message: { model: "m", content: [{ type: "text", text: "working" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: `round report ${call.messages.length}\nGOAL_REPORT\nstatus: done`, total_cost_usd: cost, num_turns: call.messages.length * 2, session_id: session };
      }
      } finally {
        call.streamDone = true;
      }
    })();
    return Object.assign(stream, { close: call.close, interrupt: vi.fn(async () => undefined) });
  }),
}));

import { BackgroundTaskStore, type BackgroundTask } from "../engine/background-task-store.js";
import { BackgroundTaskManager } from "../engine/background-task-manager.js";
import { GoalsConfigSchema } from "../config/sections/goals.js";
import { GoalStore, type GoalCheck, type GoalCheckResult } from "./goal-store.js";
import { GoalController, GOAL_TASK_PROFILE } from "./goal-controller.js";
import type { GoalJudgeFn } from "./goal-judge.js";

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("goal worker over the real task manager", () => {
  let dir: string;
  let tasks: BackgroundTaskStore;
  let goals: GoalStore;
  let manager: BackgroundTaskManager;
  let controller: GoalController;
  let checkRuns: number;
  let judge: ReturnType<typeof vi.fn<GoalJudgeFn>>;
  let onTaskComplete: ReturnType<typeof vi.fn>;
  let messages: string[];

  beforeEach(() => {
    rec.calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "kirie-goal-int-"));
    tasks = new BackgroundTaskStore(join(dir, "background-tasks.db"));
    goals = new GoalStore(join(dir, "goals.db"));
    checkRuns = 0;
    messages = [];
    onTaskComplete = vi.fn();
    judge = vi.fn<GoalJudgeFn>(async () => ({ ok: true, verdict: { verdict: "done", reason: "the check passes and the report shows it", missing: [] }, costUsd: 0.01 }));
    const isGoal = (t: BackgroundTask) => t.meta?.profile === GOAL_TASK_PROFILE;
    manager = new BackgroundTaskManager(tasks, {
      model: "claude-test",
      allowedTools: [],
      cwd: dir,
      pollIntervalMs: 20,
      onTaskComplete,
      onTaskFailed: (t) => (isGoal(t) ? controller.onTaskFailed(t) : undefined),
      controllerFor: (t) => (isGoal(t) ? controller.taskController(t) : undefined),
      profileFor: (t) => (isGoal(t) ? controller.taskProfile(t) : undefined),
    });
    controller = new GoalController({
      store: goals,
      tasks,
      taskManager: manager,
      config: () => GoalsConfigSchema.parse({ enabled: true }),
      isEnabled: () => true,
      judge,
      evaluateCheck: async () => ({ decision: "pass", reasons: [] }),
      ask: async () => ({ optionId: "decline", outcome: "unavailable", code: "" }),
      askTimeoutMs: 300_000,
      sendToChat: async (_k, text) => {
        messages.push(text);
      },
      defaultCwd: dir,
      // The check fails twice, then passes.
      runChecks: async (checks: readonly GoalCheck[]): Promise<GoalCheckResult[]> => {
        checkRuns += 1;
        const ok = checkRuns >= 3;
        return [{ command: checks[0]!.command, passed: ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, output: ok ? "14 passed" : "2 failed", durationMs: 1 }];
      },
      pollIntervalMs: 20,
    });
    manager.start();
    controller.start();
  });

  afterEach(async () => {
    controller.shutdown();
    await manager.shutdown();
    goals.close();
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(text: string) {
    return controller.createGoal({
      sessionKey: "telegram:dm:1001",
      goal: text,
      checks: [{ command: "pnpm test", timeoutSec: 60 }],
      checkReview: [{ command: "pnpm test", decision: "pass", reasons: [] }],
      cwd: null,
      maxRounds: 10,
      maxMinutes: 60,
      maxCostUsd: 10,
      actor: "owner:telegram:1001",
    });
  }

  it("keeps working while the check fails, finishes when it passes and the judge says done, and leaves no live worker", async () => {
    const g = start("make the tests pass");
    await until(() => goals.get(g.id)!.status === "done");
    const done = goals.get(g.id)!;
    expect(done.roundsUsed).toBe(3);
    // The judge was asked only once: after the check passed. The worker said "done" every round.
    expect(judge).toHaveBeenCalledTimes(1);
    // One worker session for all three rounds.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.messages).toHaveLength(3);
    expect(rec.calls[0]!.messages[1]).toContain("A must-pass check failed: pnpm test (exit 1)");
    // The manager stopped reading and closed the query: the subprocess exits.
    await until(() => manager.runningTaskCount === 0);
    expect(rec.calls[0]!.streamDone).toBe(true);
    expect(rec.calls[0]!.close).toHaveBeenCalled();
    const task = tasks.get(done.taskId!)!;
    expect(task.status).toBe("completed");
    expect(task.result).toContain(`Goal ${g.id} done in 3 round(s)`);
    // The goal reports itself; no generic "background task completed" push.
    expect(onTaskComplete).not.toHaveBeenCalled();
    // Cost: cumulative 0.75 from the worker plus one judge call.
    expect(done.costUsd).toBeCloseTo(0.76);
    expect(rec.calls[0]!.options.maxBudgetUsd).toBeCloseTo(10);
    expect(messages.at(-1)).toContain("done in 3 round(s)");
  });

  it("/goal stop ends the worker's query and cancels its task", async () => {
    const g = start("HANG until stopped");
    await until(() => rec.calls.length === 1 && rec.calls[0]!.messages.length === 1);
    expect(controller.stop(g.id, "owner:telegram:1001").ok).toBe(true);
    await until(() => manager.runningTaskCount === 0);
    expect(rec.calls[0]!.close).toHaveBeenCalled();
    expect(tasks.get(goals.get(g.id)!.taskId!)!.status).toBe("cancelled");
    expect(goals.get(g.id)!.status).toBe("cancelled");
  });

  it("pause ends the worker; resume continues the same SDK session in a new task", async () => {
    judge.mockResolvedValue({ ok: true, verdict: { verdict: "continue", reason: "keep going", missing: [] }, costUsd: 0 });
    const g = start("long work");
    controller.pause(g.id, "owner");
    await until(() => goals.get(g.id)!.status === "paused");
    await until(() => manager.runningTaskCount === 0);
    const first = goals.get(g.id)!;
    expect(tasks.get(first.taskId!)!.status).toBe("completed");
    expect(first.sdkSessionId).toBe("sess-1");

    judge.mockResolvedValue({ ok: true, verdict: { verdict: "done", reason: "finished", missing: [] }, costUsd: 0 });
    checkRuns = 10;
    expect(controller.resume(g.id, "owner", { note: "carry on" }).ok).toBe(true);
    await until(() => goals.get(g.id)!.status === "done");
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]!.options.resume).toBe("sess-1");
    expect(rec.calls[1]!.messages[0]).toContain("The owner resumed this goal");
    expect(rec.calls[1]!.messages[0]).toContain("carry on");
  });
});
