import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Streaming-input mock for background tasks. LIMIT on a limited account
 * (options.env.CLAUDE_CONFIG_DIR) returns a limit error result; MODEL on an
 * unavailable model returns a model refusal; anything else answers.
 */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown>; first?: string }>,
  limited: new Set<string>(),
  unavailable: new Set<string>(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> & { env?: Record<string, string>; resume?: string; model?: string } }) => {
    const call: { options: Record<string, unknown>; first?: string } = { options };
    sdk.calls.push(call);
    const dir = options.env?.CLAUDE_CONFIG_DIR ?? "ambient";
    const base = { session_id: options.resume ?? "55555555-5555-4555-8555-555555555555", uuid: "m", parent_tool_use_id: null };
    const result = (text: string, isError = false) => ({ type: "result", subtype: "success", result: text, is_error: isError, total_cost_usd: 0.01, num_turns: 1, ...base });
    const stream = (async function* () {
      for await (const raw of prompt) {
        const content = (raw as { message: { content: string } }).message.content;
        call.first ??= content;
        if (content.includes("LIMIT") && sdk.limited.has(dir)) {
          yield { type: "assistant", message: { model: String(options.model), content: [{ type: "text", text: "partial" }] }, ...base };
          yield result("You've hit your weekly limit · resets 5pm (Africa/Cairo)", true);
        } else if (content.includes("MODEL") && sdk.unavailable.has(String(options.model))) {
          yield result("API Error: 400 Claude Code does not support this model", true);
        } else {
          yield { type: "assistant", message: { model: String(options.model), content: [{ type: "text", text: `done on ${dir}` }] }, ...base };
          yield result(`done on ${dir}`);
        }
      }
    })();
    return Object.assign(stream, { close: vi.fn(() => void stream.return(undefined)), interrupt: vi.fn(async () => undefined) });
  }),
}));

import { BackgroundTaskStore, type BackgroundTask } from "./background-task-store.js";
import { BackgroundTaskManager, TASK_ROTATION_NOTE } from "./background-task-manager.js";
import { TurnResilience, type AccountAcquireResult, type ResilienceAccountSource, type ResilienceModelSource } from "./resilience.js";

class Accounts implements ResilienceAccountSource {
  active: string;
  readonly benched = new Set<string>();
  constructor(readonly ids: string[]) {
    this.active = ids[0] ?? "";
  }
  hasAccounts() { return this.ids.length > 0; }
  enabledCount() { return this.ids.length; }
  acquire(opts: { exclude?: ReadonlySet<string> } = {}): AccountAcquireResult {
    const ok = (id: string) => !this.benched.has(id) && !(opts.exclude?.has(id) ?? false);
    const next = ok(this.active) ? this.active : this.ids.find(ok);
    if (!next) return { accountId: this.active, env: { CLAUDE_CONFIG_DIR: `/${this.active}` }, exhausted: true };
    this.active = next;
    return { accountId: next, env: { CLAUDE_CONFIG_DIR: `/${next}` }, exhausted: false };
  }
  reportFailure(id: string) { this.benched.add(id); }
  reportSuccess() {}
  rotationEnabled() { return true; }
  maxRotationsPerTurn() { return 3; }
  carrySession() { return true; }
  carryTranscript(): "same" { return "same"; }
}

function models(chain: string[]): ResilienceModelSource {
  const benched = new Set<string>();
  return {
    enabled: () => true,
    chain: () => chain,
    advancesOn: () => true,
    isBenched: (a, m) => benched.has(`${a}|${m}`),
    bench: (a, m) => { benched.add(`${a}|${m}`); },
    maxAttemptsPerTurn: () => 4,
    answered: () => undefined,
  };
}

async function settle(store: BackgroundTaskStore, id: string): Promise<BackgroundTask> {
  for (let i = 0; i < 200; i++) {
    const t = store.get(id)!;
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("task did not settle");
}

describe("BackgroundTaskManager with account rotation and model fallback", () => {
  let dir: string;
  let store: BackgroundTaskStore;
  let manager: BackgroundTaskManager | null;
  const onTaskComplete = vi.fn();
  const onTaskFailed = vi.fn();

  beforeEach(() => {
    sdk.calls.length = 0;
    sdk.limited.clear();
    sdk.unavailable.clear();
    onTaskComplete.mockClear();
    onTaskFailed.mockClear();
    dir = mkdtempSync(join(tmpdir(), "kirie-bgacc-"));
    store = new BackgroundTaskStore(join(dir, "tasks.db"));
    manager = null;
  });

  afterEach(async () => {
    await manager?.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(resilience: TurnResilience | null): BackgroundTaskManager {
    manager = new BackgroundTaskManager(store, { model: "opus", cwd: dir, pollIntervalMs: 15, onTaskComplete, onTaskFailed });
    manager.setResilience(resilience);
    manager.start();
    return manager;
  }

  it("zero accounts: options.env is undefined and the task completes as before", async () => {
    start(new TurnResilience({ accounts: new Accounts([]) }));
    const task = store.create("telegram:dm:1", "plain", "do it");
    expect((await settle(store, task.id)).status).toBe("completed");
    expect(sdk.calls[0]!.options.env).toBeUndefined();
  });

  it("a limit re-queues the task with its session id; it finishes on the next account", async () => {
    sdk.limited.add("/a");
    start(new TurnResilience({ accounts: new Accounts(["a", "b"]) }));
    const task = store.create("telegram:dm:1", "research", "LIMIT then work");
    const done = await settle(store, task.id);
    expect(done.status).toBe("completed");
    expect(done.result).toBe("done on /b");
    expect(done.rotation_attempts).toBe(1);
    expect(done.account_id).toBe("b");
    expect(sdk.calls.map((c) => (c.options.env as Record<string, string>).CLAUDE_CONFIG_DIR)).toEqual(["/a", "/b"]);
    expect(sdk.calls[1]!.options.resume).toBe("55555555-5555-4555-8555-555555555555");
    expect(sdk.calls[1]!.first!.startsWith(TASK_ROTATION_NOTE)).toBe(true);
    expect(onTaskFailed).not.toHaveBeenCalled();
    expect(onTaskComplete).toHaveBeenCalledTimes(1);
  });

  it("exhaustion marks the task failed and does not fire onTaskComplete", async () => {
    sdk.limited.add("/a");
    sdk.limited.add("/b");
    start(new TurnResilience({ accounts: new Accounts(["a", "b"]) }));
    const task = store.create("telegram:dm:1", "research", "LIMIT");
    const done = await settle(store, task.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/\[usage_limit_account\]$/);
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(onTaskFailed).toHaveBeenCalledTimes(1);
  });

  it("re-queues are capped", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) sdk.limited.add(`/${id}`);
    start(new TurnResilience({ accounts: new Accounts(ids) }));
    const task = store.create("telegram:dm:1", "research", "LIMIT");
    const done = await settle(store, task.id);
    expect(done.status).toBe("failed");
    expect(done.rotation_attempts).toBe(3);
    expect(sdk.calls).toHaveLength(4);
  });

  it("a model failure re-queues on the next model", async () => {
    sdk.unavailable.add("opus");
    start(new TurnResilience({ models: models(["sonnet"]) }));
    const task = store.create("telegram:dm:1", "research", "MODEL");
    const done = await settle(store, task.id);
    expect(done.status).toBe("completed");
    expect(sdk.calls.map((c) => c.options.model)).toEqual(["opus", "sonnet"]);
  });
});
