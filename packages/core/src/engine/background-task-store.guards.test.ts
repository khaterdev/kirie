import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskStore } from "./background-task-store.js";

describe("BackgroundTaskStore status guards (W2-GOAL report)", () => {
  let dir: string;
  let store: BackgroundTaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-bgguard-"));
    store = new BackgroundTaskStore(join(dir, "tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("markRunning moves pending and running rows only", () => {
    const t = store.create("telegram:dm:1", "d", "p");
    expect(store.markRunning(t.id)).toBe(true);
    expect(store.markRunning(t.id, "sid-1")).toBe(true);
    expect(store.get(t.id)).toMatchObject({ status: "running", sdk_session_id: "sid-1" });
  });

  it("a late markRunning never flips a completed, failed or cancelled task back to running", () => {
    const done = store.create("k", "d", "p");
    store.markRunning(done.id, "s");
    store.markCompleted(done.id, "result", 0.1, 2);
    const failed = store.create("k", "d", "p");
    store.markRunning(failed.id, "s");
    store.markFailed(failed.id, "boom");
    const cancelled = store.create("k", "d", "p");
    store.markCancelled(cancelled.id);

    for (const [task, status] of [[done, "completed"], [failed, "failed"], [cancelled, "cancelled"]] as const) {
      expect(store.markRunning(task.id, "late-sid")).toBe(false);
      const row = store.get(task.id)!;
      expect(row.status).toBe(status);
      expect(row.sdk_session_id).not.toBe("late-sid");
    }
  });

  it("create can name an SDK session to resume", () => {
    const t = store.create("k", "d", "p", { profile: "goal" }, { resumeSessionId: "sid-saved" });
    expect(t.sdk_session_id).toBe("sid-saved");
    expect(store.get(t.id)).toMatchObject({ status: "pending", sdk_session_id: "sid-saved", meta: { profile: "goal" } });
    expect(store.create("k", "d", "p").sdk_session_id).toBeNull();
  });
});
