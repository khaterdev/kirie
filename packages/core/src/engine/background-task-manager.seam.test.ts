import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Scripted streaming-input mock that really consumes the prompt iterable.
 * Per pushed message: SUBAGENT fires SubagentStart, yields an intermediate
 * result, then SubagentStop and the final result; LIMIT yields a limit error
 * result; anything else yields one assistant message and a result.
 */
const rec = vi.hoisted(() => ({
  calls: [] as Array<{
    options: Record<string, unknown>;
    prompt: AsyncIterable<unknown>;
    messages: Array<{ uuid?: string; message: { content: string } }>;
    close: ReturnType<typeof import("vitest").vi.fn>;
  }>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  type HookFn = () => Promise<unknown>;
  const fire = (options: Record<string, unknown>, event: string) => {
    const hooks = (options.hooks as Record<string, Array<{ hooks: HookFn[] }>> | undefined)?.[event] ?? [];
    return Promise.all(hooks.flatMap((m) => m.hooks.map((h) => h())));
  };
  return {
    query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      let releaseStop: () => void = () => {};
      const stopped = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const call = {
        options,
        prompt,
        messages: [] as Array<{ uuid?: string; message: { content: string } }>,
        close: vi.fn(() => releaseStop()),
      };
      rec.calls.push(call);
      const base = { session_id: (options.resume as string | undefined) ?? "task-sess-1", uuid: "m", parent_tool_use_id: null };
      const result = (text: string, isError = false) => ({
        type: "result", subtype: "success", result: text, is_error: isError, total_cost_usd: 0.05, num_turns: 3, ...base,
      });
      const assistant = (text: string) => ({ type: "assistant", message: { model: "claude-task-model", content: [{ type: "text", text }] }, ...base });

      const stream = (async function* () {
        for await (const raw of prompt) {
          const m = raw as { uuid?: string; message: { content: string } };
          call.messages.push(m);
          const content = m.message.content;
          if (content.includes("HANGSUB")) {
            // A subagent starts, the parent reports, then nothing until closed.
            await fire(options, "SubagentStart");
            yield result("Waiting for the agent...");
            await stopped;
            return;
          } else if (content.includes("SLOW")) {
            await new Promise((r) => setTimeout(r, 150));
            yield assistant(`answer to: ${content.slice(0, 30)}`);
            yield result(`answer to: ${content.slice(0, 30)}`);
          } else if (content.includes("ORPHAN")) {
            // A subagent starts, the parent reports, then the process exits.
            await fire(options, "SubagentStart");
            yield result("partial answer before exit");
            return;
          } else if (content.includes("SUBAGENT")) {
            await fire(options, "SubagentStart");
            yield assistant("Waiting for the agent...");
            yield result("Waiting for the agent...");
            await new Promise((r) => setTimeout(r, 30));
            await fire(options, "SubagentStop");
            yield assistant("final findings");
            yield result("final findings");
          } else if (content.includes("LIMIT")) {
            yield result("You've hit your weekly limit · resets 5pm (Africa/Cairo)", true);
          } else {
            yield assistant(`answer to: ${content.slice(0, 30)}`);
            yield result(`answer to: ${content.slice(0, 30)}`);
          }
        }
      })();
      return Object.assign(stream, {
        close: call.close,
        interrupt: vi.fn(async () => undefined),
      });
    }),
  };
});

import { BackgroundTaskStore, type BackgroundTask } from "./background-task-store.js";
import {
  BackgroundTaskManager,
  type BackgroundTaskManagerConfig,
  type TaskTurnController,
  type TaskTurnResult,
  type TurnDecision,
} from "./background-task-manager.js";
import { SdkOptionsPipeline, type SdkCallContext, type SdkStreamEvent } from "./sdk-options.js";

describe("BackgroundTaskManager: leak fix, subagents, controllers, profiles", () => {
  let dir: string;
  let store: BackgroundTaskStore;
  let manager: BackgroundTaskManager | null;
  let onTaskComplete: ReturnType<typeof vi.fn>;
  let onTaskFailed: ReturnType<typeof vi.fn>;

  function makeManager(extra: Partial<BackgroundTaskManagerConfig> = {}): BackgroundTaskManager {
    manager = new BackgroundTaskManager(store, {
      model: "claude-test",
      allowedTools: [],
      cwd: dir,
      pollIntervalMs: 20,
      onTaskComplete,
      onTaskFailed,
      ...extra,
    });
    return manager;
  }

  async function waitForStatus(id: string, status: string): Promise<BackgroundTask> {
    await vi.waitFor(() => expect(store.get(id)?.status).toBe(status), { timeout: 3000, interval: 10 });
    return store.get(id)!;
  }

  beforeEach(() => {
    rec.calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "kirie-bg-seam-"));
    store = new BackgroundTaskStore(join(dir, "tasks.db"));
    manager = null;
    onTaskComplete = vi.fn();
    onTaskFailed = vi.fn();
  });

  afterEach(async () => {
    await manager?.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ends the input queue and leaves the loop after the final result (no live subprocess)", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Research", "Find things");
    m.start();

    const done = await waitForStatus(task.id, "completed");
    expect(done.result).toContain("answer to:");
    await vi.waitFor(() => expect(m.runningTaskCount).toBe(0), { timeout: 1000 });

    const call = rec.calls[0]!;
    expect(call.close).toHaveBeenCalled();
    // The prompt iterable is finished: the subprocess's stdin is closed.
    const next = await call.prompt[Symbol.asyncIterator]().next();
    expect(next.done).toBe(true);
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it("a completed task is not relabelled cancelled by shutdown", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Quick", "Quick job");
    m.start();
    await waitForStatus(task.id, "completed");
    await m.shutdown();
    expect(store.get(task.id)?.status).toBe("completed");
    expect(store.markCancelled(task.id)).toBe(false);
    expect(store.get(task.id)?.status).toBe("completed");
  });

  it("treats a result that arrives while a subagent runs as intermediate", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Delegate", "SUBAGENT please");
    m.start();
    const done = await waitForStatus(task.id, "completed");
    expect(done.result).toBe("final findings");
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it("completes with the last result when the stream ends while a subagent is still counted", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Orphan", "ORPHAN subagent");
    m.start();
    const done = await waitForStatus(task.id, "completed");
    expect(done.result).toBe("partial answer before exit");
    expect(onTaskFailed).not.toHaveBeenCalled();
  });

  it("a message sent while the task works is answered before the task finishes", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Long", "SLOW research");
    m.start();
    await vi.waitFor(() => expect(rec.calls[0]?.messages).toHaveLength(1), { timeout: 2000 });
    store.addCommand(task.id, "send_message", "and add a summary", false);

    const done = await waitForStatus(task.id, "completed");
    expect(rec.calls[0]!.messages.map((x) => x.message.content).slice(1)).toEqual(["and add a summary"]);
    expect(done.result).toBe("answer to: and add a summary");
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it("an interrupting message is not lost to the interrupted turn's result", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Long", "SLOW research");
    m.start();
    await vi.waitFor(() => expect(rec.calls[0]?.messages).toHaveLength(1), { timeout: 2000 });
    store.addCommand(task.id, "send_message", "change of plan", true);

    const done = await waitForStatus(task.id, "completed");
    expect(rec.calls[0]!.messages.map((x) => x.message.content).slice(1)).toEqual(["change of plan"]);
    expect(done.result).toBe("answer to: change of plan");
  });

  it("a task cancelled while waiting for a subagent stays cancelled", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Waits", "HANGSUB");
    m.start();
    await vi.waitFor(() => expect(rec.calls[0]?.messages).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));

    expect(m.cancelTask(task.id)).toBe(true);
    await m.shutdown();
    expect(store.get(task.id)?.status).toBe("cancelled");
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(onTaskFailed).not.toHaveBeenCalled();
  });

  it("a limit error result marks the task failed and calls onTaskFailed, not onTaskComplete", async () => {
    const m = makeManager();
    const task = store.create("telegram:dm:1", "Limited", "LIMIT now");
    m.start();
    const failed = await waitForStatus(task.id, "failed");
    expect(failed.error).toContain("Usage limit reached");
    expect(failed.error).toContain("5pm (Africa/Cairo)");
    expect(failed.error).toMatch(/\[usage_limit_account\]$/);
    await vi.waitFor(() => expect(onTaskFailed).toHaveBeenCalledTimes(1));
    expect(onTaskFailed.mock.calls[0]![0]).toMatchObject({ id: task.id, status: "failed" });
    expect(onTaskComplete).not.toHaveBeenCalled();
  });

  it("controller: continue pushes the next message, finish completes the task", async () => {
    const turns: TaskTurnResult[] = [];
    const decisions: TurnDecision[] = [{ action: "continue", message: "round two" }, { action: "finish" }];
    const controller: TaskTurnController = {
      onTurnResult: async (_task, turn) => {
        turns.push(turn);
        return decisions.shift()!;
      },
    };
    const m = makeManager({ controllerFor: () => controller });
    const task = store.create("telegram:dm:1", "Goal", "round one");
    m.start();

    const done = await waitForStatus(task.id, "completed");
    const call = rec.calls[0]!;
    expect(call.messages.map((x) => x.message.content.includes("round one") || x.message.content)).toEqual([true, "round two"]);
    expect(call.messages.every((x) => typeof x.uuid === "string" && x.uuid.length === 36)).toBe(true);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ isError: false, subtype: "success", costUsd: 0.05, numTurns: 3 });
    expect(done.result).toBe("answer to: round two");
  });

  it("controller: hold keeps the session open until sendMessage, ownsCompletion leaves the row to the controller", async () => {
    const decisions: TurnDecision[] = [{ action: "hold" }, { action: "finish" }];
    const controller: TaskTurnController = {
      ownsCompletion: true,
      onTurnResult: async () => decisions.shift()!,
    };
    const m = makeManager({ controllerFor: () => controller });
    const task = store.create("telegram:dm:1", "Paused goal", "first");
    m.start();

    await vi.waitFor(() => expect(rec.calls[0]?.messages).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(m.runningTaskCount).toBe(1);
    expect(store.get(task.id)?.status).toBe("running");

    expect(m.sendMessage(task.id, "resume now")).toBe(true);
    await vi.waitFor(() => expect(m.runningTaskCount).toBe(0), { timeout: 2000 });
    expect(rec.calls[0]!.messages.map((x) => x.message.content).slice(1)).toEqual(["resume now"]);
    // ownsCompletion: the manager did not mark it or push a result
    expect(store.get(task.id)?.status).toBe("running");
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(m.sendMessage(task.id, "too late")).toBe(false);
  });

  it("merges the task profile over the base options and passes kind and allowlist to the pipeline", async () => {
    const sdkOptions = new SdkOptionsPipeline();
    const contexts: SdkCallContext[] = [];
    sdkOptions.registerContributor("account-env", (_o, ctx) => contexts.push(ctx), 20);
    const events: SdkStreamEvent[] = [];
    sdkOptions.registerStreamObserver("t", (ev) => events.push(ev));

    const m = makeManager({
      sdkOptions,
      maxTurns: 200,
      systemPrompt: "BASE PROMPT",
      profileFor: (task) =>
        task.meta?.profile === "goal"
          ? { kind: "goal", options: { maxTurns: 7 }, systemPrompt: "GOAL PROMPT", toolAllowlist: ["Read", "Bash"] }
          : undefined,
    });
    const task = store.create("telegram:dm:1", "Goal g-1", "work", { origin: "goal", profile: "goal", data: { goalId: "g-1" } });
    m.start();
    await waitForStatus(task.id, "completed");

    const options = rec.calls[0]!.options as Record<string, unknown> & { hooks: Record<string, unknown[]> };
    expect(options.maxTurns).toBe(7);
    expect(options.systemPrompt).toBe("GOAL PROMPT");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.hooks.PreToolUse).toHaveLength(1);
    expect(options.hooks.SubagentStart).toHaveLength(1);
    expect(options.hooks.SubagentStop).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      kind: "goal",
      taskId: task.id,
      goalId: "g-1",
      sessionKey: "telegram:dm:1",
      channel: "telegram",
      ownerDm: false,
      interactive: false,
      toolAllowlist: ["Read", "Bash"],
    });
    expect(contexts[0]!.label).toMatch(/^goal g-1 /);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn_start");
    expect(types[types.length - 1]).toBe("turn_end");
    const start = events[0]!;
    const end = events[events.length - 1]!;
    expect(start.type === "turn_start" && start.userMessageUuid).toBe(rec.calls[0]!.messages[0]!.uuid);
    expect(end.type === "turn_end" && end.userMessageUuid).toBe(rec.calls[0]!.messages[0]!.uuid);
  });

  it("a resumed task starts with the controller's initialMessage(task, true) and its saved session", async () => {
    const task = store.create("telegram:dm:1", "Resumable", "original prompt", { profile: "goal" });
    store.markRunning(task.id, "sess-saved");
    const initialMessage = vi.fn((_t: BackgroundTask, resumed: boolean) => `continue (resumed=${resumed})`);
    const m = makeManager({
      controllerFor: (t) => (t.meta?.profile === "goal" ? { initialMessage, onTurnResult: async () => ({ action: "finish" }) } : undefined),
      // A task that names a profile needs it registered (it fails closed otherwise).
      profileFor: (t) => (t.meta?.profile === "goal" ? { kind: "goal" } : undefined),
    });

    m.resumeOnStartup();
    await waitForStatus(task.id, "completed");
    expect(initialMessage).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), true);
    expect(rec.calls[0]!.messages[0]!.message.content).toBe("continue (resumed=true)");
    expect(rec.calls[0]!.options.resume).toBe("sess-saved");
  });

  it("a throwing controller fails the task instead of leaving it running", async () => {
    const m = makeManager({
      controllerFor: () => ({
        onTurnResult: async () => {
          throw new Error("controller bug");
        },
      }),
    });
    const task = store.create("telegram:dm:1", "Buggy", "go");
    m.start();
    const failed = await waitForStatus(task.id, "failed");
    expect(failed.error).toContain("controller bug");
    await vi.waitFor(() => expect(onTaskFailed).toHaveBeenCalledTimes(1));
  });
});
