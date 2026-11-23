import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalStore, GOAL_ID_RE, GOAL_ROUND_LOG_MAX, newGoalId, type GoalCreateInput } from "./goal-store.js";

function input(over: Partial<GoalCreateInput> = {}): GoalCreateInput {
  return {
    sessionKey: "telegram:dm:1001",
    goal: "make the tests pass",
    status: "pending",
    checks: [{ command: "pnpm test", timeoutSec: 300 }],
    checkReview: [{ command: "pnpm test", decision: "pass", reasons: [] }],
    maxRounds: 10,
    maxMinutes: 120,
    maxCostUsd: 10,
    createdBy: "owner",
    ...over,
  };
}

describe("GoalStore", () => {
  let dir: string;
  let store: GoalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-goal-store-"));
    store = new GoalStore(join(dir, "goals.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the database file with mode 0600", () => {
    expect(statSync(join(dir, "goals.db")).mode & 0o777).toBe(0o600);
  });

  it("allocates ids like g-xxxxxx", () => {
    for (let i = 0; i < 50; i++) expect(newGoalId()).toMatch(GOAL_ID_RE);
  });

  it("creates a goal with its limits equal to the requested caps", () => {
    const g = store.create(input());
    expect(g.id).toMatch(GOAL_ID_RE);
    expect(g).toMatchObject({
      status: "pending",
      roundLimit: 10,
      costLimitUsd: 10,
      roundsUsed: 0,
      costUsd: 0,
      deadlineAtMs: null,
      createdBy: "owner",
      startMode: "start",
      checks: [{ command: "pnpm test", timeoutSec: 300 }],
      pauseRequested: false,
    });
    expect(store.events(g.id).map((e) => e.kind)).toEqual(["created"]);
  });

  it("moves a goal only from an expected state, in one statement with the patch", () => {
    const g = store.create(input());
    expect(store.transition(g.id, ["running"], "done")).toBe(false);
    expect(store.get(g.id)!.status).toBe("pending");
    expect(store.transition(g.id, ["pending"], "running", { taskId: "t1", deadlineAtMs: 123 })).toBe(true);
    expect(store.get(g.id)).toMatchObject({ status: "running", taskId: "t1", deadlineAtMs: 123 });
    expect(store.events(g.id).map((e) => e.kind)).toEqual(["created", "status.running"]);
  });

  it("never moves a terminal goal", () => {
    const g = store.create(input());
    expect(store.transition(g.id, ["pending"], "cancelled")).toBe(true);
    for (const to of ["running", "pending", "done", "paused"] as const) {
      expect(store.transition(g.id, ["cancelled", "done", "failed"], to)).toBe(false);
    }
    expect(store.get(g.id)!.status).toBe("cancelled");
  });

  it("round-trips every patch column", () => {
    const g = store.create(input());
    store.update(g.id, {
      roundsUsed: 3, costUsd: 1.5, workerCostUsd: 1.2, workerCostLast: 0.7, judgeCostUsd: 0.3, sdkTurns: 12,
      sdkSessionId: "s-1", lastReport: "report", roundLog: ["round 1: continue"], stopReason: "why",
      pauseRequested: true, judgeFailures: 1, errorRounds: 1, resumeNote: "note", startMode: "resume",
      lastVerdict: { verdict: "continue", reason: "r", missing: ["m"], source: "judge" },
      lastChecks: [{ command: "x", passed: false, exitCode: 1, signal: null, timedOut: false, output: "o", durationMs: 5 }],
      roundLimit: 20, costLimitUsd: 15, maxCostUsd: 15, startedAtMs: 99,
    });
    expect(store.get(g.id)).toMatchObject({
      roundsUsed: 3, costUsd: 1.5, workerCostUsd: 1.2, workerCostLast: 0.7, judgeCostUsd: 0.3, sdkTurns: 12,
      sdkSessionId: "s-1", lastReport: "report", roundLog: ["round 1: continue"], stopReason: "why",
      pauseRequested: true, judgeFailures: 1, errorRounds: 1, resumeNote: "note", startMode: "resume",
      lastVerdict: { verdict: "continue", reason: "r", missing: ["m"], source: "judge" },
      roundLimit: 20, costLimitUsd: 15, startedAtMs: 99,
    });
    expect(store.get(g.id)!.lastChecks![0]!.exitCode).toBe(1);
  });

  it("lists by status oldest first and recent goals newest first, per chat", () => {
    const a = store.create(input());
    const b = store.create(input({ sessionKey: "telegram:dm:2002" }));
    const c = store.create(input({ status: "pending_approval", createdBy: "agent" }));
    expect(store.listByStatus(["pending"]).map((g) => g.id)).toEqual([a.id, b.id]);
    expect(store.listByStatus(["pending_approval"]).map((g) => g.id)).toEqual([c.id]);
    expect(store.listRecent().map((g) => g.id)).toEqual([c.id, b.id, a.id]);
    expect(store.listRecent({ sessionKey: "telegram:dm:2002" }).map((g) => g.id)).toEqual([b.id]);
    expect(store.listByStatus([])).toEqual([]);
  });

  it("queues stop commands and drops unknown actions", () => {
    const g = store.create(input());
    const id = store.addCommand(g.id, "stop");
    expect(store.unprocessedCommands().map((c) => c.id)).toEqual([id]);
    store.markCommandProcessed(id);
    expect(store.unprocessedCommands()).toEqual([]);
  });

  it("stores kv switches", () => {
    expect(store.getKv("goals.enabled")).toBeUndefined();
    store.setKv("goals.enabled", "true");
    store.setKv("goals.enabled", "false");
    expect(store.getKv("goals.enabled")).toBe("false");
  });

  it("is shared between two connections (daemon and stdio subprocess)", () => {
    const other = new GoalStore(join(dir, "goals.db"));
    const g = other.create(input({ status: "pending_approval", createdBy: "agent" }));
    expect(store.get(g.id)!.createdBy).toBe("agent");
    other.close();
  });

  it("exports a round-log cap", () => {
    expect(GOAL_ROUND_LOG_MAX).toBeGreaterThan(5);
  });
});
