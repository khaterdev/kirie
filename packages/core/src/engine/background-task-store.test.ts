import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskStore } from "./background-task-store.js";

describe("BackgroundTaskStore", () => {
  let store: BackgroundTaskStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kirie-bg-task-test-"));
    store = new BackgroundTaskStore(join(tempDir, "test-tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a task in pending state", () => {
      const task = store.create("telegram:dm:123", "Research topic", "Please research AI trends");
      expect(task.id).toBeTruthy();
      expect(task.session_key).toBe("telegram:dm:123");
      expect(task.description).toBe("Research topic");
      expect(task.prompt).toBe("Please research AI trends");
      expect(task.status).toBe("pending");
      expect(task.result).toBeNull();
      expect(task.error).toBeNull();
      expect(task.cost_usd).toBe(0);
      expect(task.num_turns).toBe(0);
    });

    it("generates unique IDs for each task", () => {
      const task1 = store.create("telegram:dm:123", "Task 1", "prompt 1");
      const task2 = store.create("telegram:dm:123", "Task 2", "prompt 2");
      expect(task1.id).not.toBe(task2.id);
    });
  });

  describe("get", () => {
    it("returns null for non-existent task", () => {
      expect(store.get("non-existent-id")).toBeNull();
    });

    it("returns the task by ID", () => {
      const created = store.create("telegram:dm:123", "Test task", "prompt");
      const fetched = store.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.description).toBe("Test task");
    });
  });

  describe("list", () => {
    it("returns empty array for no tasks", () => {
      expect(store.list("telegram:dm:123")).toEqual([]);
    });

    it("returns tasks for a session key", () => {
      store.create("telegram:dm:123", "Task 1", "prompt 1");
      store.create("telegram:dm:123", "Task 2", "prompt 2");
      store.create("discord:dm:456", "Task 3", "prompt 3");

      const tasks = store.list("telegram:dm:123");
      expect(tasks).toHaveLength(2);
    });

    it("filters by status", () => {
      const task1 = store.create("telegram:dm:123", "Task 1", "prompt 1");
      store.create("telegram:dm:123", "Task 2", "prompt 2");
      store.markRunning(task1.id);

      const pending = store.list("telegram:dm:123", "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.description).toBe("Task 2");

      const running = store.list("telegram:dm:123", "running");
      expect(running).toHaveLength(1);
      expect(running[0]!.description).toBe("Task 1");
    });
  });

  describe("listByStatus", () => {
    it("returns tasks across all sessions with given status", () => {
      store.create("telegram:dm:123", "Task 1", "prompt 1");
      store.create("discord:dm:456", "Task 2", "prompt 2");

      const pending = store.listByStatus("pending");
      expect(pending).toHaveLength(2);
    });
  });

  describe("markRunning", () => {
    it("updates status to running", () => {
      const task = store.create("telegram:dm:123", "Test", "prompt");
      store.markRunning(task.id, "sdk-session-123");

      const updated = store.get(task.id);
      expect(updated!.status).toBe("running");
      expect(updated!.sdk_session_id).toBe("sdk-session-123");
    });
  });

  describe("markCompleted", () => {
    it("updates with result data", () => {
      const task = store.create("telegram:dm:123", "Test", "prompt");
      store.markRunning(task.id);
      store.markCompleted(task.id, "Task result text", 0.05, 3);

      const updated = store.get(task.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.result).toBe("Task result text");
      expect(updated!.cost_usd).toBe(0.05);
      expect(updated!.num_turns).toBe(3);
    });
  });

  describe("markFailed", () => {
    it("updates with error info", () => {
      const task = store.create("telegram:dm:123", "Test", "prompt");
      store.markRunning(task.id);
      store.markFailed(task.id, "Connection timeout");

      const updated = store.get(task.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toBe("Connection timeout");
    });
  });

  describe("markCancelled", () => {
    it("updates status to cancelled", () => {
      const task = store.create("telegram:dm:123", "Test", "prompt");
      store.markCancelled(task.id);

      const updated = store.get(task.id);
      expect(updated!.status).toBe("cancelled");
    });
  });

  describe("listByDescription", () => {
    it("finds tasks matching a description prefix", () => {
      store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt 1");
      store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt 2");
      store.create("telegram:dm:123", "Scheduled task: other-cron", "prompt 3");
      store.create("telegram:dm:123", "Unrelated task", "prompt 4");

      const results = store.listByDescription("Scheduled task: my-cron");
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.description === "Scheduled task: my-cron")).toBe(true);
    });

    it("returns empty array when no tasks match", () => {
      store.create("telegram:dm:123", "Scheduled task: something", "prompt");
      const results = store.listByDescription("Scheduled task: nonexistent");
      expect(results).toHaveLength(0);
    });

    it("filters to active tasks only when activeOnly is true", () => {
      const t1 = store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt 1");
      const t2 = store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt 2");
      store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt 3");

      store.markRunning(t1.id);
      store.markCompleted(t2.id, "done", 0.01, 1);
      // t3 remains pending

      const activeOnly = store.listByDescription("Scheduled task: my-cron", true);
      expect(activeOnly).toHaveLength(2); // t1 (running) and t3 (pending)

      const all = store.listByDescription("Scheduled task: my-cron", false);
      expect(all).toHaveLength(3); // all three
    });

    it("does not match partial description names incorrectly", () => {
      store.create("telegram:dm:123", "Scheduled task: my-cron-extended", "prompt");
      store.create("telegram:dm:123", "Scheduled task: my-cron", "prompt");

      // "Scheduled task: my-cron" prefix also matches "Scheduled task: my-cron-extended"
      // because LIKE uses % wildcard. This is expected behavior for prefix matching.
      const results = store.listByDescription("Scheduled task: my-cron");
      expect(results).toHaveLength(2);
    });
  });

  describe("persistence", () => {
    it("data persists across store instances", () => {
      const dbPath = join(tempDir, "persist-test.db");
      const store1 = new BackgroundTaskStore(dbPath);
      const task = store1.create("telegram:dm:123", "Persistent task", "prompt");
      store1.markCompleted(task.id, "Done", 0.01, 1);
      store1.close();

      const store2 = new BackgroundTaskStore(dbPath);
      const fetched = store2.get(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe("completed");
      expect(fetched!.result).toBe("Done");
      store2.close();
    });
  });
});
