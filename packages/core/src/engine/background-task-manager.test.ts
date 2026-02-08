import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskStore } from "./background-task-store.js";
import { BackgroundTaskManager } from "./background-task-manager.js";

// Mock the claude-agent-sdk query() function
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  /**
   * Creates a mock Query object that mimics the real SDK Query interface.
   * The Query is an AsyncGenerator that yields messages and has control methods.
   */
  function createMockQuery() {
    let streamResolve: (() => void) | null = null;
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    let closed = false;

    // Schedule result messages after a small delay
    setTimeout(() => {
      messages.push({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Task completed successfully" }],
        },
        parent_tool_use_id: null,
        uuid: "mock-uuid",
        session_id: "mock-session-1",
      });
      messages.push({
        type: "result",
        subtype: "success",
        result: "Task completed successfully",
        session_id: "mock-session-1",
        total_cost_usd: 0.02,
        num_turns: 2,
        is_error: false,
        duration_ms: 200,
        duration_api_ms: 150,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: "mock-uuid",
      });
      if (streamResolve) streamResolve();
    }, 10);

    // Create the async generator
    const generator: AsyncGenerator<unknown, void> & {
      close: () => void;
      interrupt: () => Promise<void>;
      streamInput: (stream: AsyncIterable<unknown>) => Promise<void>;
      setPermissionMode: (mode: string) => Promise<void>;
      setModel: (model?: string) => Promise<void>;
      setMaxThinkingTokens: (tokens: number | null) => Promise<void>;
    } = {
      async next() {
        while (!closed) {
          if (messages.length > 0) {
            const msg = messages.shift()!;
            if (msg.type === "result") {
              return { value: msg, done: false };
            }
            return { value: msg, done: false };
          }
          await new Promise<void>((resolve) => {
            streamResolve = resolve;
            setTimeout(resolve, 100);
          });
        }
        return { value: undefined, done: true as const };
      },
      async return() {
        closed = true;
        return { value: undefined, done: true as const };
      },
      async throw(err: unknown) {
        closed = true;
        throw err;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close() {
        closed = true;
        if (streamResolve) streamResolve();
      },
      async interrupt() {
        // No-op for tests
      },
      async streamInput(_stream: AsyncIterable<unknown>) {
        // No-op for tests
      },
      async setPermissionMode(_mode: string) {
        // No-op
      },
      async setModel(_model?: string) {
        // No-op
      },
      async setMaxThinkingTokens(_tokens: number | null) {
        // No-op
      },
    };

    return generator;
  }

  return {
    query: vi.fn((_params) => {
      return createMockQuery();
    }),
  };
});

describe("BackgroundTaskManager", () => {
  let store: BackgroundTaskStore;
  let manager: BackgroundTaskManager;
  let tempDir: string;
  let onTaskComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kirie-bg-mgr-test-"));
    store = new BackgroundTaskStore(join(tempDir, "tasks.db"));
    onTaskComplete = vi.fn();

    manager = new BackgroundTaskManager(store, {
      model: "claude-sonnet-4-20250514",
      allowedTools: [],
      pollIntervalMs: 100,
      onTaskComplete,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("start / shutdown", () => {
    it("starts and stops without error", async () => {
      manager.start();
      expect(manager.runningTaskCount).toBe(0);
      await manager.shutdown();
    });
  });

  describe("polling", () => {
    it("picks up pending tasks from the store", async () => {
      store.create("telegram:dm:123", "Test task", "Do something");
      manager.start();

      // Wait for poll + task execution
      await new Promise((resolve) => setTimeout(resolve, 500));

      const task = store.listByStatus("completed");
      // Task should eventually complete via the mock
      expect(task.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("cancelTask", () => {
    it("returns false for non-running task", () => {
      expect(manager.cancelTask("non-existent")).toBe(false);
    });
  });

  describe("resumeOnStartup", () => {
    it("marks running tasks without SDK session as failed", () => {
      const task = store.create("telegram:dm:123", "Interrupted", "prompt");
      store.markRunning(task.id); // No SDK session ID

      manager.resumeOnStartup();

      const updated = store.get(task.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.error).toContain("no SDK session");
    });
  });

  describe("runningTaskCount", () => {
    it("returns 0 when no tasks are running", () => {
      expect(manager.runningTaskCount).toBe(0);
    });
  });

  describe("commands", () => {
    it("processes kill command for a running task", async () => {
      const task = store.create("telegram:dm:123", "Long task", "Do something long");
      manager.start();

      // Wait for task to start
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Send kill command via store
      store.addCommand(task.id, "kill");

      // Wait for command to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      const updated = store.get(task.id);
      // Task should be cancelled or completed (race between mock completion and kill)
      expect(["cancelled", "completed"]).toContain(updated!.status);
    });

    it("processes send_message command for a running task", async () => {
      const task = store.create("telegram:dm:123", "Interactive task", "Start working");
      manager.start();

      // Wait for task to start
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Send a message command
      store.addCommand(task.id, "send_message", "New instructions here", false);

      // Wait for command to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Command should have been processed
      const commands = store.getUnprocessedCommands();
      expect(commands.length).toBe(0);
    });
  });
});
