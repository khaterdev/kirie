import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopStore, LOOP_ID_RE, type LoopCreateInput } from "./loop-store.js";

const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);

function input(over: Partial<LoopCreateInput> = {}): LoopCreateInput {
  return {
    sessionKey: "telegram:dm:1001",
    channel: "telegram",
    chatId: "1001",
    chatType: "dm",
    prompt: "check the deploy",
    intervalSec: 300,
    backoff: true,
    maxRuns: 100,
    expiresAt: T0 + 72 * 3_600_000,
    createdBy: "owner",
    status: "active",
    now: T0,
    ...over,
  };
}

describe("LoopStore", () => {
  let dir: string;
  let store: LoopStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-loops-"));
    store = new LoopStore(join(dir, "loops.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the DB file 0600", () => {
    expect(statSync(join(dir, "loops.db")).mode & 0o777).toBe(0o600);
  });

  it("creates and reads a loop with defaults", () => {
    const loop = store.create(input());
    expect(loop.id).toMatch(LOOP_ID_RE);
    expect(loop).toMatchObject({
      sessionKey: "telegram:dm:1001", channel: "telegram", chatId: "1001", chatType: "dm",
      prompt: "check the deploy", baseIntervalSec: 300, currentIntervalSec: 300, backoff: true,
      status: "active", runs: 0, maxRuns: 100, quietStreak: 0, errorStreak: 0, lastDigest: null,
      nextRunAt: T0, createdBy: "owner", createdAt: T0, endedReason: null, pauseReason: null,
    });
    expect(store.get(loop.id)).toEqual(loop);
    expect(store.get("l-zzzzz")).toBeNull();
  });

  it("lists by status and session, newest first", () => {
    const a = store.create(input({ now: T0 }));
    const b = store.create(input({ now: T0 + 1, status: "pending_approval", createdBy: "agent" }));
    const c = store.create(input({ now: T0 + 2, sessionKey: "telegram:dm:42", chatId: "42" }));
    expect(store.list().map((l) => l.id)).toEqual([c.id, b.id, a.id]);
    expect(store.list({ statuses: ["active"] }).map((l) => l.id)).toEqual([c.id, a.id]);
    expect(store.list({ sessionKey: "telegram:dm:42" }).map((l) => l.id)).toEqual([c.id]);
    expect(store.count("active")).toBe(2);
    expect(store.count("pending_approval")).toBe(1);
  });

  it("updates fields and booleans", () => {
    const loop = store.create(input());
    const u = store.update(loop.id, { currentIntervalSec: 600, backoff: false, lastDigest: "abc", runs: 3 }, T0 + 5);
    expect(u).toMatchObject({ currentIntervalSec: 600, backoff: false, lastDigest: "abc", runs: 3, updatedAt: T0 + 5 });
  });

  it("due() returns only active loops whose next run has come, soonest first", () => {
    const late = store.create(input({ nextRunAt: T0 + 2000 }));
    const soon = store.create(input({ nextRunAt: T0 + 1000 }));
    store.create(input({ nextRunAt: T0 + 9000 }));
    const paused = store.create(input({ nextRunAt: T0 }));
    store.update(paused.id, { status: "paused" });
    expect(store.due(T0 + 2000).map((l) => l.id)).toEqual([soon.id, late.id]);
  });

  it("claim() is compare-and-set on the next run time", () => {
    const loop = store.create(input({ nextRunAt: T0 }));
    expect(store.claim(loop.id, T0, T0 + 300_000, T0)).toBe(true);
    expect(store.get(loop.id)).toMatchObject({ nextRunAt: T0 + 300_000, lastRunAt: T0 });
    // A second driver that saw the old time loses
    expect(store.claim(loop.id, T0, T0 + 300_000, T0)).toBe(false);
    store.update(loop.id, { status: "paused" });
    expect(store.claim(loop.id, T0 + 300_000, T0 + 600_000, T0)).toBe(false);
  });

  it("transition() changes status only from the expected states", () => {
    const loop = store.create(input());
    expect(store.transition(loop.id, ["active"], { status: "paused", pauseReason: "owner" }, T0 + 1)).toMatchObject({ status: "paused", pauseReason: "owner" });
    expect(store.transition(loop.id, ["active"], { status: "paused", pauseReason: "errors" })).toBeNull();
    store.end(loop.id, "cancelled", "agent");
    expect(store.transition(loop.id, ["paused", "active"], { status: "active" })).toBeNull();
    expect(store.get(loop.id)!.status).toBe("cancelled");
    expect(store.transition(loop.id, [], { status: "active" })).toBeNull();
  });

  it("end() ends a live loop once; ended loops stay ended", () => {
    const loop = store.create(input());
    const ended = store.end(loop.id, "cancelled", "owner", T0 + 1);
    expect(ended).toMatchObject({ status: "cancelled", endedReason: "owner" });
    expect(store.end(loop.id, "done", "complete")).toBeNull();
    expect(store.get(loop.id)!.status).toBe("cancelled");
    expect(store.end("l-zzzzz", "cancelled", "owner")).toBeNull();
  });

  it("reanchorOverdue() moves overdue active loops to one run soon after start", () => {
    const overdue = store.create(input({ nextRunAt: T0 - 3_600_000 }));
    const future = store.create(input({ nextRunAt: T0 + 60_000 }));
    const pausedOverdue = store.create(input({ nextRunAt: T0 - 3_600_000 }));
    store.update(pausedOverdue.id, { status: "paused" });
    expect(store.reanchorOverdue(T0, 15_000)).toBe(1);
    expect(store.get(overdue.id)!.nextRunAt).toBe(T0 + 15_000);
    expect(store.get(future.id)!.nextRunAt).toBe(T0 + 60_000);
    expect(store.get(pausedOverdue.id)!.nextRunAt).toBe(T0 - 3_600_000);
  });

  it("rows survive reopening the file (restart)", () => {
    const loop = store.create(input());
    store.close();
    store = new LoopStore(join(dir, "loops.db"));
    expect(store.get(loop.id)).toMatchObject({ id: loop.id, status: "active", prompt: "check the deploy" });
  });
});
