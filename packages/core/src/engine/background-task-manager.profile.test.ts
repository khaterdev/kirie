import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sdk = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    sdk.calls.push(options);
    const base = { session_id: "66666666-6666-4666-8666-666666666666", uuid: "m", parent_tool_use_id: null };
    const stream = (async function* () {
      for await (const _ of prompt) {
        yield { type: "result", subtype: "success", result: "done", is_error: false, total_cost_usd: 0, num_turns: 1, ...base };
      }
    })();
    return Object.assign(stream, { close: vi.fn(() => void stream.return(undefined)), interrupt: vi.fn(async () => undefined) });
  }),
}));

import { BackgroundTaskStore, type BackgroundTask } from "./background-task-store.js";
import { BackgroundTaskManager, TASK_PROFILE_UNAVAILABLE_ERROR, type TaskProfile } from "./background-task-manager.js";

async function settle(store: BackgroundTaskStore, id: string): Promise<BackgroundTask> {
  for (let i = 0; i < 200; i++) {
    const t = store.get(id)!;
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("task did not settle");
}

describe("BackgroundTaskManager task profiles fail closed (W2-HOOK report)", () => {
  let dir: string;
  let store: BackgroundTaskStore;
  let manager: BackgroundTaskManager | null;
  const onTaskFailed = vi.fn();
  const onTaskComplete = vi.fn();

  beforeEach(() => {
    sdk.calls.length = 0;
    onTaskFailed.mockClear();
    onTaskComplete.mockClear();
    dir = mkdtempSync(join(tmpdir(), "kirie-bgprofile-"));
    store = new BackgroundTaskStore(join(dir, "tasks.db"));
    manager = null;
  });

  afterEach(async () => {
    await manager?.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(profileFor?: (task: BackgroundTask) => TaskProfile | undefined): void {
    manager = new BackgroundTaskManager(store, {
      model: "opus", cwd: dir, pollIntervalMs: 15, onTaskFailed, onTaskComplete, allowedTools: ["Bash"],
      ...(profileFor ? { profileFor } : {}),
    });
    manager.start();
  }

  const cases: Array<[string, ((task: BackgroundTask) => TaskProfile | undefined) | undefined]> = [
    ["no profile resolver at all", undefined],
    ["the profile is not registered", () => undefined],
    ["the profile factory throws", () => { throw new Error("db down"); }],
  ];
  for (const [name, resolver] of cases) {
    it(`a task naming a profile is failed, never run with the default, when ${name}`, async () => {
      start(resolver);
      const task = store.create("telegram:dm:1", "webhook x", "p", { origin: "webhook", profile: "webhook" });
      const done = await settle(store, task.id);
      expect(done.status).toBe("failed");
      expect(done.error).toContain(TASK_PROFILE_UNAVAILABLE_ERROR);
      expect(sdk.calls).toHaveLength(0);
      await vi.waitFor(() => expect(onTaskFailed).toHaveBeenCalledTimes(1));
      expect(onTaskComplete).not.toHaveBeenCalled();
    });
  }

  it("a task with no profile in meta runs with the default options, as before", async () => {
    start(() => { throw new Error("not consulted for a usable answer"); });
    const task = store.create("telegram:dm:1", "plain", "p");
    expect((await settle(store, task.id)).status).toBe("completed");
    expect(sdk.calls[0]!.allowedTools).toEqual(["Bash"]);
  });

  it("a task whose profile resolves runs with it", async () => {
    start(() => ({ kind: "webhook", options: { tools: ["Read"] } }));
    const task = store.create("telegram:dm:1", "webhook x", "p", { profile: "webhook" });
    expect((await settle(store, task.id)).status).toBe("completed");
    expect(sdk.calls[0]!.tools).toEqual(["Read"]);
  });
});
