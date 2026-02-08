import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LaneQueue } from "./lane-queue.js";

describe("LaneQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic enqueue and execution", () => {
    it("executes a single task and returns its result", async () => {
      const queue = new LaneQueue<string>(0);
      const result = await queue.enqueue("session-1", async () => "hello");
      expect(result).toBe("hello");
    });

    it("propagates task errors as rejections", async () => {
      const queue = new LaneQueue<string>(0);
      await expect(
        queue.enqueue("session-1", async () => {
          throw new Error("task failed");
        }),
      ).rejects.toThrow("task failed");
    });
  });

  describe("FIFO ordering", () => {
    it("executes tasks in FIFO order within a lane", async () => {
      const queue = new LaneQueue<number>(0);
      const order: number[] = [];

      const p1 = queue.enqueue("session-1", async () => {
        order.push(1);
        return 1;
      });
      const p2 = queue.enqueue("session-1", async () => {
        order.push(2);
        return 2;
      });
      const p3 = queue.enqueue("session-1", async () => {
        order.push(3);
        return 3;
      });

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual([1, 2, 3]);
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("concurrency = 1 per lane", () => {
    it("does not run tasks concurrently within the same lane", async () => {
      vi.useRealTimers();
      const queue = new LaneQueue<void>(0);
      let concurrency = 0;
      let maxConcurrency = 0;

      const makeTask = () => async () => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        // Yield to event loop
        await new Promise((r) => setTimeout(r, 5));
        concurrency--;
      };

      const p1 = queue.enqueue("session-1", makeTask());
      const p2 = queue.enqueue("session-1", makeTask());
      const p3 = queue.enqueue("session-1", makeTask());

      await Promise.all([p1, p2, p3]);
      expect(maxConcurrency).toBe(1);
    });

    it("runs tasks from different lanes in parallel", async () => {
      vi.useRealTimers();
      const queue = new LaneQueue<string>(0);
      const started: string[] = [];

      const makeTask = (id: string) => async () => {
        started.push(id);
        await new Promise((r) => setTimeout(r, 10));
        return id;
      };

      const p1 = queue.enqueue("session-A", makeTask("A"));
      const p2 = queue.enqueue("session-B", makeTask("B"));

      // Let both tasks start
      await new Promise((r) => setTimeout(r, 5));

      // Both should have started (running in parallel)
      expect(started).toContain("A");
      expect(started).toContain("B");

      await Promise.all([p1, p2]);
    });
  });

  describe("debounce behavior", () => {
    it("delays execution by the debounce window", async () => {
      const queue = new LaneQueue<string>(100);
      let executed = false;

      const promise = queue.enqueue("session-1", async () => {
        executed = true;
        return "done";
      });

      // Should not have executed yet
      expect(executed).toBe(false);

      // Advance past the debounce window
      vi.advanceTimersByTime(100);
      const result = await promise;
      expect(executed).toBe(true);
      expect(result).toBe("done");
    });

    it("resets the debounce timer when new tasks arrive (latest-wins)", async () => {
      const queue = new LaneQueue<string>(100);
      const order: number[] = [];

      const p1 = queue.enqueue("session-1", async () => {
        order.push(1);
        return "first";
      });

      // Advance 50ms (halfway through debounce)
      vi.advanceTimersByTime(50);
      expect(order).toEqual([]); // Not executed yet

      // Enqueue another task, which resets the debounce timer
      const p2 = queue.enqueue("session-1", async () => {
        order.push(2);
        return "second";
      });

      // Advance another 50ms (100ms total from start, but only 50ms from reset)
      vi.advanceTimersByTime(50);
      expect(order).toEqual([]); // Still not executed (timer was reset)

      // Advance to complete the new debounce window
      vi.advanceTimersByTime(50);
      const results = await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
      expect(results).toEqual(["first", "second"]);
    });

    it("executes immediately with debounce=0", async () => {
      const queue = new LaneQueue<string>(0);
      let executed = false;

      const promise = queue.enqueue("session-1", async () => {
        executed = true;
        return "immediate";
      });

      const result = await promise;
      expect(executed).toBe(true);
      expect(result).toBe("immediate");
    });
  });

  describe("lane cleanup", () => {
    it("removes the lane after all tasks drain", async () => {
      const queue = new LaneQueue<string>(0);

      await queue.enqueue("session-1", async () => "done");

      expect(queue.activeKeys()).not.toContain("session-1");
    });

    it("shows active keys while tasks are queued", () => {
      const queue = new LaneQueue<string>(200);

      queue.enqueue("session-A", async () => "a");
      queue.enqueue("session-B", async () => "b");

      expect(queue.activeKeys()).toContain("session-A");
      expect(queue.activeKeys()).toContain("session-B");
    });
  });

  describe("getQueueLength", () => {
    it("returns 0 for an unknown session", () => {
      const queue = new LaneQueue<string>(0);
      expect(queue.getQueueLength("nonexistent")).toBe(0);
    });

    it("reflects queued tasks", () => {
      const queue = new LaneQueue<string>(500);

      queue.enqueue("session-1", async () => "a");
      queue.enqueue("session-1", async () => "b");

      // 2 queued, 0 running (debounce hasn't fired)
      expect(queue.getQueueLength("session-1")).toBe(2);
    });
  });

  describe("clear", () => {
    it("rejects pending tasks when cleared", async () => {
      const queue = new LaneQueue<string>(500);

      const p1 = queue.enqueue("session-1", async () => "a");
      const p2 = queue.enqueue("session-1", async () => "b");

      queue.clear("session-1");

      await expect(p1).rejects.toThrow("Lane cleared");
      await expect(p2).rejects.toThrow("Lane cleared");
    });

    it("is safe to clear a nonexistent lane", () => {
      const queue = new LaneQueue<string>(0);
      expect(() => queue.clear("nonexistent")).not.toThrow();
    });
  });

  describe("clearAll", () => {
    it("rejects tasks across all lanes", async () => {
      const queue = new LaneQueue<string>(500);

      const pA = queue.enqueue("session-A", async () => "a");
      const pB = queue.enqueue("session-B", async () => "b");

      queue.clearAll();

      await expect(pA).rejects.toThrow("Lane cleared");
      await expect(pB).rejects.toThrow("Lane cleared");
      expect(queue.activeKeys()).toEqual([]);
    });

    it("clears lanes even when tasks are running (no orphaned lanes)", async () => {
      vi.useRealTimers();
      const queue = new LaneQueue<string>(0);

      let taskResolve: ((v: string) => void) | undefined;
      const taskStarted = new Promise<void>((r) => {
        queue.enqueue("session-1", () => {
          r(); // signal that the task has started
          return new Promise<string>((resolve) => {
            taskResolve = resolve;
          });
        });
      });

      // Wait for the task to start running
      await taskStarted;

      // Enqueue another task that will be pending
      const p2 = queue.enqueue("session-1", async () => "second");

      // clearAll should force-clear all lanes including running ones
      queue.clearAll();

      // All lanes should be removed
      expect(queue.activeKeys()).toEqual([]);

      // The pending task should be rejected
      await expect(p2).rejects.toThrow("Lane cleared");

      // Resolve the running task to avoid unhandled rejection
      taskResolve?.("done");
    });
  });

  describe("error isolation", () => {
    it("a failing task does not block subsequent tasks in the same lane", async () => {
      const queue = new LaneQueue<string>(0);

      const p1 = queue.enqueue("session-1", async () => {
        throw new Error("boom");
      });

      const p2 = queue.enqueue("session-1", async () => "recovered");

      await expect(p1).rejects.toThrow("boom");
      expect(await p2).toBe("recovered");
    });
  });
});
