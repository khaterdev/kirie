import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskStore } from "./background-task-store.js";

/** A synthetic GitHub-style token, assembled at run time. */
function fakeToken(): string {
  return ["gh", "p_"].join("") + "A1b2C3d4E5f6G7h8I9j0".repeat(2).slice(0, 36);
}

describe("BackgroundTaskStore scrubbing (sink task-result)", () => {
  let dir: string;
  let store: BackgroundTaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-task-scrub-"));
    store = new BackgroundTaskStore(join(dir, "tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("scrubs a secret from the stored result but keeps the prompt as written", () => {
    const token = fakeToken();
    const task = store.create("telegram:dm:1", "deploy", `use ${token} to push`);
    store.markRunning(task.id);
    store.markCompleted(task.id, `Pushed with token ${token}. Done.`, 0.1, 3);
    const row = store.get(task.id)!;
    expect(row.result).not.toContain(token);
    expect(row.result).toContain("«redacted:");
    expect(row.result).toContain("Done.");
    expect(row.prompt).toContain(token);
  });

  it("scrubs a secret from the stored error", () => {
    const token = fakeToken();
    const task = store.create("telegram:dm:1", "deploy", "push");
    store.markRunning(task.id);
    store.markFailed(task.id, `auth failed for ${token}`);
    const row = store.get(task.id)!;
    expect(row.error).not.toContain(token);
    expect(row.error).toContain("auth failed for «redacted:");
  });

  it("leaves text without secrets unchanged", () => {
    const task = store.create("telegram:dm:1", "sum", "add");
    store.markRunning(task.id);
    store.markCompleted(task.id, "The sum is 42 (commit 3f2a9c1).", 0, 1);
    expect(store.get(task.id)!.result).toBe("The sum is 42 (commit 3f2a9c1).");
  });
});
