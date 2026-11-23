import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./session-store.js";
import { BackgroundTaskStore } from "./background-task-store.js";

describe("account binding columns", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-acc-cols-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sessions: an existing database gains account_id; set() without it leaves the value alone", () => {
    const path = join(dir, "sessions.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, sdk_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    old.prepare("INSERT INTO sessions (session_key, sdk_session_id) VALUES (?, ?)").run("telegram:dm:1", "old-sid");
    old.close();

    const store = new SessionStore(path);
    expect(store.get("telegram:dm:1")).toBe("old-sid");
    expect(store.getAccountId("telegram:dm:1")).toBeNull();
    expect(store.getAccountId("missing")).toBeUndefined();
    store.set("telegram:dm:1", "sid-2", "claude2");
    expect(store.getAccountId("telegram:dm:1")).toBe("claude2");
    store.set("telegram:dm:1", "sid-3");
    expect(store.get("telegram:dm:1")).toBe("sid-3");
    expect(store.getAccountId("telegram:dm:1")).toBe("claude2");
    store.set("telegram:dm:1", "sid-4", null);
    expect(store.getAccountId("telegram:dm:1")).toBeNull();
    store.close();
    // Re-opening is idempotent.
    new SessionStore(path).close();
  });

  it("background tasks: account_id and rotation_attempts; re-queue keeps the session id", () => {
    const path = join(dir, "tasks.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE background_tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, description TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, cost_usd REAL NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), sdk_session_id TEXT)`);
    old.close();

    const store = new BackgroundTaskStore(path);
    const task = store.create("telegram:dm:1", "d", "p");
    expect(store.get(task.id)).toMatchObject({ account_id: null, rotation_attempts: 0 });
    store.markRunning(task.id, "sid-1");
    store.setAccount(task.id, "main");
    expect(store.requeueForRotation(task.id)).toBe(true);
    expect(store.get(task.id)).toMatchObject({ status: "pending", sdk_session_id: "sid-1", account_id: "main", rotation_attempts: 1 });
    // Only a running task can be re-queued.
    expect(store.requeueForRotation(task.id)).toBe(false);
    store.markCancelled(task.id);
    expect(store.requeueForRotation(task.id)).toBe(false);
    store.close();
  });
});
