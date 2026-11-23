import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { CURATOR_CHECK_TICKS, CURATOR_LAST_RUN_KEY, CuratorRunStore, CuratorScheduler, curatorLocalHour, type CuratorReport, type CuratorSchedulerDeps } from "./curator-scheduler.js";
import { tempLearningEnv, type TempLearningEnv } from "./learning.test-util.js";

const HOUR = 3_600_000;

function harness(over: Partial<CuratorSchedulerDeps> = {}) {
  const kv = new Map<string, string>();
  let now = new Date("2026-11-23T02:00:00.000Z"); // 04:00 in Africa/Cairo (UTC+2)
  let enabled = true;
  let running = false;
  let lastActivity: number | null = null;
  const run = vi.fn(async () => undefined);
  const scheduler = new CuratorScheduler({
    kv: { get: (k) => kv.get(k), set: (k, v) => { kv.set(k, v); } },
    enabled: () => enabled,
    config: () => ({ intervalHours: 168, preferredHour: 4, minIdleMinutes: 30 }),
    timeZone: () => "Africa/Cairo",
    lastActivityAt: () => lastActivity,
    isRunning: () => running,
    run,
    now: () => now,
    ...over,
  });
  return {
    scheduler, kv, run,
    setNow: (d: Date) => { now = d; },
    setEnabled: (v: boolean) => { enabled = v; },
    setRunning: (v: boolean) => { running = v; },
    setActivity: (ms: number | null) => { lastActivity = ms; },
  };
}

describe("CuratorScheduler", () => {
  it("does nothing while disabled (the default), not even seeding", () => {
    const h = harness();
    h.setEnabled(false);
    expect(h.scheduler.check()).toBe("disabled");
    expect(h.kv.size).toBe(0);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("the first check only seeds the clock; the first run is one interval later", () => {
    const h = harness();
    expect(h.scheduler.check()).toBe("seeded");
    expect(h.run).not.toHaveBeenCalled();
    h.setNow(new Date(Date.parse("2026-11-23T02:00:00.000Z") + 24 * HOUR));
    expect(h.scheduler.check()).toBe("not_due");
    h.setNow(new Date(Date.parse("2026-11-23T02:00:00.000Z") + 168 * HOUR));
    expect(h.scheduler.check()).toBe("started");
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.kv.get(CURATOR_LAST_RUN_KEY)).toBe(new Date(Date.parse("2026-11-23T02:00:00.000Z") + 168 * HOUR).toISOString());
  });

  it("waits for the preferred local hour unless more than a day overdue", () => {
    const h = harness();
    h.kv.set(CURATOR_LAST_RUN_KEY, "2026-11-10T06:00:00.000Z");
    h.setNow(new Date("2026-11-17T10:00:00.000Z")); // 12:00 Cairo, 7 days + 4 h later
    expect(h.scheduler.check()).toBe("not_hour");
    h.setNow(new Date("2026-11-18T02:00:00.000Z")); // 04:00 Cairo, 7 days + 20 h (not overdue)
    expect(h.scheduler.check()).toBe("started");

    const late = harness();
    late.kv.set(CURATOR_LAST_RUN_KEY, "2026-11-10T00:00:00.000Z");
    late.setNow(new Date("2026-11-18T10:00:00.000Z")); // 8 days 10 h: overdue
    expect(late.scheduler.check()).toBe("started");
  });

  it("does not run while the chat is active or a run is in progress", () => {
    const h = harness();
    h.kv.set(CURATOR_LAST_RUN_KEY, "2026-11-01T00:00:00.000Z");
    const now = Date.parse("2026-11-23T02:00:00.000Z");
    h.setActivity(now - 10 * 60_000);
    expect(h.scheduler.check()).toBe("busy");
    h.setActivity(now - 31 * 60_000);
    h.setRunning(true);
    expect(h.scheduler.check()).toBe("running");
    h.setRunning(false);
    expect(h.scheduler.check()).toBe("started");
  });

  it("checks only every 360th heartbeat tick", () => {
    const h = harness();
    h.scheduler.onTick({ tickNumber: CURATOR_CHECK_TICKS - 1 });
    expect(h.kv.size).toBe(0);
    h.scheduler.onTick({ tickNumber: CURATOR_CHECK_TICKS });
    expect(h.kv.has(CURATOR_LAST_RUN_KEY)).toBe(true);
  });

  it("reports the next eligible run only when enabled and seeded", () => {
    const h = harness();
    expect(h.scheduler.nextEligibleAt()).toBeNull();
    h.kv.set(CURATOR_LAST_RUN_KEY, "2026-11-20T00:00:00.000Z");
    expect(h.scheduler.nextEligibleAt()!.toISOString()).toBe("2026-11-27T00:00:00.000Z");
    h.setEnabled(false);
    expect(h.scheduler.nextEligibleAt()).toBeNull();
  });

  it("curatorLocalHour uses the time zone and falls back to UTC", () => {
    const d = new Date("2026-11-23T02:30:00.000Z");
    expect(curatorLocalHour(d, "Africa/Cairo")).toBe(4);
    expect(curatorLocalHour(d, "Not/AZone")).toBe(2);
  });
});

describe("CuratorRunStore", () => {
  let env: TempLearningEnv;
  beforeEach(() => { env = tempLearningEnv("kirie-curator-runs-"); });
  afterEach(() => env.cleanup());

  it("stores finished runs with their report and returns the newest", () => {
    const runs = new CuratorRunStore(env.db);
    expect(runs.last()).toBeNull();
    const id = runs.start("command", "2026-11-23T00:00:00.000Z");
    expect(runs.last()).toBeNull();
    const report = {
      version: 1, trigger: "command", startedAt: "2026-11-23T00:00:00.000Z", finishedAt: "2026-11-23T00:00:01.000Z", merge: false,
      counts: { skills: 2, broken: 1, duplicates: 0, stale: 0, drift: 0, proposals: 1 },
      findings: [{ skill: "x", root: "project", detector: "B1", category: "broken", severity: "error", message: "no SKILL.md" }],
      proposals: [{ id: 4, kind: "skill.archive", skill: "x", title: "Archive x" }],
      dropped: [], staleMarked: [], possibleDuplicates: [], autoAdopted: [], llm: { calls: 0, costUsd: 0, errors: 0 }, errors: [],
    } satisfies CuratorReport;
    runs.finish(id, report);
    const last = runs.last()!;
    expect(last).toMatchObject({ id, trigger: "command", finishedAt: "2026-11-23T00:00:01.000Z" });
    expect(last.report).toEqual(report);
    expect(runs.list(5)).toHaveLength(1);
  });
});
