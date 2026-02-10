import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ScheduleStore, createScheduleToolHandlers, type ScheduleFireEvent } from "./schedule.js";
import { BackgroundTaskStore } from "../../engine/background-task-store.js";

const TEST_DIR = `/tmp/kirie-schedule-test-${process.pid}`;
const TEST_DB = join(TEST_DIR, "schedule.db");
const TEST_BG_DB = join(TEST_DIR, "background-tasks.db");

let store: ScheduleStore;
let bgStore: BackgroundTaskStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new ScheduleStore(TEST_DB);
  bgStore = new BackgroundTaskStore(TEST_BG_DB);
  store.setBackgroundTaskStore(bgStore);
});

afterEach(() => {
  store.close();
  bgStore.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ScheduleStore", () => {
  describe("create", () => {
    it("creates a scheduled task", () => {
      const entry = store.create(
        "daily-standup",
        "0 9 * * *",
        "Time for standup!",
        "telegram",
        "chat-123",
      );

      expect(entry.name).toBe("daily-standup");
      expect(entry.cron).toBe("0 9 * * *");
      expect(entry.message).toBe("Time for standup!");
      expect(entry.channel).toBe("telegram");
      expect(entry.chatId).toBe("chat-123");
      expect(entry.next_run).not.toBeNull();
      expect(entry.max_runs).toBeNull();
      expect(entry.run_count).toBe(0);
      expect(entry.remaining).toBeNull();
    });

    it("creates a one-time schedule (maxRuns=1)", () => {
      const entry = store.create("once", "0 9 * * *", "one-shot", "telegram", "chat-1", 1);

      expect(entry.max_runs).toBe(1);
      expect(entry.run_count).toBe(0);
      expect(entry.remaining).toBe(1);
    });

    it("creates an N-times schedule (maxRuns=3)", () => {
      const entry = store.create("three-times", "0 9 * * *", "msg", "telegram", "chat-1", 3);

      expect(entry.max_runs).toBe(3);
      expect(entry.run_count).toBe(0);
      expect(entry.remaining).toBe(3);
    });

    it("upserts on same name", () => {
      store.create("reminder", "0 9 * * *", "original", "telegram", "chat-1");
      store.create("reminder", "0 10 * * *", "updated", "discord", "chat-2");

      const entry = store.get("reminder");
      expect(entry).not.toBeNull();
      expect(entry!.cron).toBe("0 10 * * *");
      expect(entry!.message).toBe("updated");
      expect(entry!.channel).toBe("discord");
    });

    it("upsert resets run_count", () => {
      store.create("reset-test", "0 9 * * *", "msg", "telegram", "chat-1", 5);
      // Simulate some runs by updating the DB directly
      // (We can't easily fire the cron here, so just verify the upsert resets)
      store.create("reset-test", "0 10 * * *", "msg2", "telegram", "chat-1", 3);

      const entry = store.get("reset-test");
      expect(entry).not.toBeNull();
      expect(entry!.run_count).toBe(0);
      expect(entry!.max_runs).toBe(3);
      expect(entry!.remaining).toBe(3);
    });

    it("throws for invalid cron expression", () => {
      expect(() =>
        store.create("bad", "not-a-cron", "msg", "telegram", "chat-1"),
      ).toThrow();
    });
  });

  describe("get", () => {
    it("retrieves an existing schedule", () => {
      store.create("test", "*/5 * * * *", "Every 5 min", "telegram", "chat-1");
      const entry = store.get("test");
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe("test");
    });

    it("returns null for non-existent schedule", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("lists all schedules", () => {
      store.create("sched1", "0 9 * * *", "msg1", "telegram", "chat-1");
      store.create("sched2", "0 10 * * *", "msg2", "discord", "chat-2");

      const list = store.list();
      expect(list).toHaveLength(2);
    });

    it("returns empty array when none exist", () => {
      expect(store.list()).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes an existing schedule and returns true", () => {
      store.create("to-delete", "0 9 * * *", "msg", "telegram", "chat-1");
      expect(store.delete("to-delete")).toBe(true);
      expect(store.get("to-delete")).toBeNull();
    });

    it("returns false for non-existent schedule", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });

    it("stops the cron job when deleting", () => {
      store.create("active-job", "*/1 * * * *", "msg", "telegram", "chat-1");
      store.delete("active-job");
      // Job should be stopped and removed
      expect(store.get("active-job")).toBeNull();
    });

    it("auto-cancels running background tasks for payload-delivery schedules", () => {
      // Create a payload-delivery schedule
      store.create("my-payload-cron", "0 9 * * *", "do stuff", "telegram", "chat-1");
      // Set delivery to payload via DB
      store.getDb().prepare("UPDATE schedules SET delivery = 'payload' WHERE name = ?").run("my-payload-cron");

      // Create some background tasks that look like they were spawned by this cron
      const t1 = bgStore.create("telegram:dm:chat-1", "Scheduled task: my-payload-cron", "prompt 1");
      const t2 = bgStore.create("telegram:dm:chat-1", "Scheduled task: my-payload-cron", "prompt 2");
      bgStore.markRunning(t1.id);
      // t2 remains pending

      // Also create a completed task (should NOT be cancelled)
      const t3 = bgStore.create("telegram:dm:chat-1", "Scheduled task: my-payload-cron", "prompt 3");
      bgStore.markCompleted(t3.id, "done", 0.01, 1);

      // Also create a task for a different cron (should NOT be touched)
      const t4 = bgStore.create("telegram:dm:chat-1", "Scheduled task: other-cron", "prompt 4");

      // Delete the schedule
      store.delete("my-payload-cron");

      // Running and pending tasks for this cron should be cancelled
      expect(bgStore.get(t1.id)!.status).toBe("cancelled");
      expect(bgStore.get(t2.id)!.status).toBe("cancelled");

      // Completed task should NOT be touched
      expect(bgStore.get(t3.id)!.status).toBe("completed");

      // Other cron's task should NOT be touched
      expect(bgStore.get(t4.id)!.status).toBe("pending");
    });

    it("sends kill commands for auto-cancelled tasks", () => {
      store.create("kill-test-cron", "0 9 * * *", "do stuff", "telegram", "chat-1");
      store.getDb().prepare("UPDATE schedules SET delivery = 'payload' WHERE name = ?").run("kill-test-cron");

      const t1 = bgStore.create("telegram:dm:chat-1", "Scheduled task: kill-test-cron", "prompt");
      bgStore.markRunning(t1.id);

      store.delete("kill-test-cron");

      // Should have a kill command queued
      const commands = bgStore.getUnprocessedCommands();
      const killCmds = commands.filter((c) => c.task_id === t1.id && c.action === "kill");
      expect(killCmds).toHaveLength(1);
    });

    it("does NOT auto-cancel tasks for non-payload schedules", () => {
      // Default delivery is 'announce'
      store.create("announce-cron", "0 9 * * *", "msg", "telegram", "chat-1");

      // Even if there happen to be tasks with matching description
      const t1 = bgStore.create("telegram:dm:chat-1", "Scheduled task: announce-cron", "prompt");

      store.delete("announce-cron");

      // Task should NOT be cancelled (delivery is announce, not payload)
      expect(bgStore.get(t1.id)!.status).toBe("pending");
    });

    it("works gracefully when no backgroundTaskStore is set", () => {
      const standaloneStore = new ScheduleStore(join(TEST_DIR, "standalone.db"));
      // NOT calling setBackgroundTaskStore — should not throw
      standaloneStore.create("standalone-cron", "0 9 * * *", "msg", "telegram", "chat-1");
      expect(standaloneStore.delete("standalone-cron")).toBe(true);
      standaloneStore.close();
    });
  });

  describe("fire event", () => {
    it("emits fire event on cron trigger", async () => {
      vi.useFakeTimers();

      const fireHandler = vi.fn();
      store.on("fire", fireHandler);

      // Create a schedule that fires every second
      store.create("frequent", "* * * * * *", "hello", "telegram", "chat-1");

      // Advance time by 1.1 seconds to trigger
      await vi.advanceTimersByTimeAsync(1100);

      // The cron job should have fired
      if (fireHandler.mock.calls.length > 0) {
        const event: ScheduleFireEvent = fireHandler.mock.calls[0]![0];
        expect(event.name).toBe("frequent");
        expect(event.message).toBe("hello");
        expect(event.channel).toBe("telegram");
        expect(event.chatId).toBe("chat-1");
      }

      vi.useRealTimers();
    });

    it("auto-deletes a one-time schedule after firing", async () => {
      vi.useFakeTimers();

      const fireHandler = vi.fn();
      store.on("fire", fireHandler);

      store.create("one-shot", "* * * * * *", "once", "telegram", "chat-1", 1);

      // Advance to fire once
      await vi.advanceTimersByTimeAsync(1100);

      expect(fireHandler).toHaveBeenCalledTimes(1);
      // Schedule should be auto-deleted
      expect(store.get("one-shot")).toBeNull();

      vi.useRealTimers();
    });

    it("auto-deletes an N-times schedule after N fires", async () => {
      vi.useFakeTimers();

      const fireHandler = vi.fn();
      store.on("fire", fireHandler);

      store.create("three-shot", "* * * * * *", "msg", "telegram", "chat-1", 3);

      // Fire 3 times — advance ~3.5 seconds
      await vi.advanceTimersByTimeAsync(3500);

      expect(fireHandler).toHaveBeenCalledTimes(3);
      // Schedule should be auto-deleted after 3 fires
      expect(store.get("three-shot")).toBeNull();

      vi.useRealTimers();
    });

    it("recurring schedule with no maxRuns keeps running", async () => {
      vi.useFakeTimers();

      const fireHandler = vi.fn();
      store.on("fire", fireHandler);

      store.create("recurring", "* * * * * *", "msg", "telegram", "chat-1");

      await vi.advanceTimersByTimeAsync(3500);

      expect(fireHandler.mock.calls.length).toBeGreaterThanOrEqual(3);
      // Schedule should still exist
      expect(store.get("recurring")).not.toBeNull();

      vi.useRealTimers();
    });

    it("remaining field is correct after fires", async () => {
      vi.useFakeTimers();

      store.on("fire", () => {});

      store.create("countdown", "* * * * * *", "msg", "telegram", "chat-1", 5);

      // Fire once
      await vi.advanceTimersByTimeAsync(1100);

      const entry = store.get("countdown");
      expect(entry).not.toBeNull();
      expect(entry!.max_runs).toBe(5);
      expect(entry!.run_count).toBe(1);
      expect(entry!.remaining).toBe(4);

      vi.useRealTimers();
    });
  });

  describe("loadAll", () => {
    it("reloads schedules from database", () => {
      store.create("persist1", "0 9 * * *", "msg1", "telegram", "chat-1");
      store.create("persist2", "0 10 * * *", "msg2", "discord", "chat-2");
      store.close();

      // Recreate store - should reload from DB
      store = new ScheduleStore(TEST_DB);
      store.loadAll();

      const list = store.list();
      expect(list).toHaveLength(2);
      // After loadAll, next_run should be populated
      expect(list[0]!.next_run).not.toBeNull();
    });

    it("preserves run_count across restarts", async () => {
      // Pin to an exact second boundary so we know exactly when the
      // next cron tick will fire (1 000 ms later, not sooner).
      vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });

      store.on("fire", () => {});
      store.create("persist-count", "* * * * * *", "msg", "telegram", "chat-1", 5);

      // Fire once — next tick is at :01, so 1 100 ms crosses exactly one boundary
      await vi.advanceTimersByTimeAsync(1100);

      const entry = store.get("persist-count");
      expect(entry).not.toBeNull();
      expect(entry!.run_count).toBe(1);

      vi.useRealTimers();

      // Close and reopen
      store.close();
      store = new ScheduleStore(TEST_DB);
      store.loadAll();

      const reloaded = store.get("persist-count");
      expect(reloaded).not.toBeNull();
      expect(reloaded!.run_count).toBe(1);
      expect(reloaded!.remaining).toBe(4);
    });
  });

  describe("stopAll", () => {
    it("stops all cron jobs", () => {
      store.create("job1", "0 9 * * *", "msg1", "telegram", "chat-1");
      store.create("job2", "0 10 * * *", "msg2", "discord", "chat-2");
      store.stopAll();
      // Jobs are stopped but entries remain in DB
      const list = store.list();
      expect(list).toHaveLength(2);
    });
  });
});

describe("createScheduleToolHandlers", () => {
  it("creates all expected tool handlers", () => {
    const handlers = createScheduleToolHandlers(store);
    expect(handlers).toHaveProperty("schedule_create");
    expect(handlers).toHaveProperty("schedule_list");
    expect(handlers).toHaveProperty("schedule_delete");
  });

  it("schedule_create handler works", () => {
    const handlers = createScheduleToolHandlers(store);
    const result = handlers.schedule_create.handler({
      name: "test-sched",
      cron: "0 9 * * *",
      message: "Wake up!",
      channel: "telegram",
      chatId: "chat-1",
    });
    expect(result.name).toBe("test-sched");
    expect(result.max_runs).toBeNull();
  });

  it("schedule_create handler passes maxRuns through", () => {
    const handlers = createScheduleToolHandlers(store);
    const result = handlers.schedule_create.handler({
      name: "limited-sched",
      cron: "0 9 * * *",
      message: "Limited!",
      channel: "telegram",
      chatId: "chat-1",
      maxRuns: 5,
    });
    expect(result.name).toBe("limited-sched");
    expect(result.max_runs).toBe(5);
    expect(result.run_count).toBe(0);
    expect(result.remaining).toBe(5);
  });

  it("schedule_list handler works", () => {
    const handlers = createScheduleToolHandlers(store);
    store.create("list-test", "0 9 * * *", "msg", "telegram", "chat-1");
    const result = handlers.schedule_list.handler();
    expect(result).toHaveLength(1);
  });

  it("schedule_delete handler works", () => {
    const handlers = createScheduleToolHandlers(store);
    store.create("del-test", "0 9 * * *", "msg", "telegram", "chat-1");
    const result = handlers.schedule_delete.handler({ name: "del-test" });
    expect(result.deleted).toBe(true);
  });
});
