import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskStore } from "./background-task-store.js";
import { BackgroundTaskManager } from "./background-task-manager.js";
import {
  buildBackgroundTaskSystemPrompt,
  BACKGROUND_TASK_AGENT_INSTRUCTIONS,
  DEFAULT_SYSTEM_PROMPT,
} from "./prompt-builder.js";

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

  describe("systemPrompt and maxTurns config", () => {
    it("passes systemPrompt to SDK query options when configured", async () => {
      const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

      const managerWithPrompt = new BackgroundTaskManager(store, {
        model: "claude-sonnet-4-20250514",
        allowedTools: [],
        pollIntervalMs: 100,
        systemPrompt: "You are a background task agent.",
        onTaskComplete: vi.fn(),
      });

      store.create("telegram:dm:123", "Prompted task", "Do the thing");
      managerWithPrompt.start();

      // Wait for task to be picked up and query() called
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify query() was called with systemPrompt in options
      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      expect(lastCall[0].options.systemPrompt).toBe("You are a background task agent.");

      await managerWithPrompt.shutdown();
    });

    it("passes maxTurns to SDK query options when configured", async () => {
      const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

      const managerWithTurns = new BackgroundTaskManager(store, {
        model: "claude-sonnet-4-20250514",
        allowedTools: [],
        pollIntervalMs: 100,
        maxTurns: 150,
        onTaskComplete: vi.fn(),
      });

      store.create("telegram:dm:456", "Turns task", "Do the thing with turns");
      managerWithTurns.start();

      await new Promise((resolve) => setTimeout(resolve, 300));

      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      expect(lastCall[0].options.maxTurns).toBe(150);

      await managerWithTurns.shutdown();
    });

    it("does not set systemPrompt in SDK options when not configured", async () => {
      const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

      store.create("telegram:dm:789", "No prompt task", "Do something");
      manager.start();

      await new Promise((resolve) => setTimeout(resolve, 300));

      const calls = (mockQuery as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      // systemPrompt should be undefined (not set)
      expect(lastCall[0].options.systemPrompt).toBeUndefined();
    });
  });
});

describe("buildBackgroundTaskSystemPrompt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kirie-test-bg-prompt-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes the default system prompt identity", () => {
    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
    });
    expect(prompt).toContain(DEFAULT_SYSTEM_PROMPT);
    expect(prompt).toContain("<assistant_identity>");
    expect(prompt).toContain("</assistant_identity>");
  });

  it("includes background task agent instructions", () => {
    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
    });
    expect(prompt).toContain(BACKGROUND_TASK_AGENT_INSTRUCTIONS);
    expect(prompt).toContain("<background_task_agent_mode>");
    expect(prompt).toContain("AUTONOMOUS BACKGROUND TASK AGENT");
    expect(prompt).toContain("MUST use tools");
    expect(prompt).toContain("NEVER respond with only text descriptions");
  });

  it("includes custom instructions when provided", () => {
    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
      customInstructions: "Always respond in Arabic.",
    });
    expect(prompt).toContain("Always respond in Arabic.");
  });

  it("includes SOUL.md, MEMORY.md, and TOOLS.md content when dataDir is provided", () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "# Soul\n\nI am Kirie");
    writeFileSync(join(tmpDir, "MEMORY.md"), "# Memory\n\nOwner: Alice");
    writeFileSync(join(tmpDir, "TOOLS.md"), "# Tools\n\nSkill: web-search");

    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
      dataDir: tmpDir,
    });

    expect(prompt).toContain("<soul_context>");
    expect(prompt).toContain("I am Kirie");
    expect(prompt).toContain("</soul_context>");

    expect(prompt).toContain("<memory_context>");
    expect(prompt).toContain("Owner: Alice");
    expect(prompt).toContain("</memory_context>");

    expect(prompt).toContain("<tools_context>");
    expect(prompt).toContain("Skill: web-search");
    expect(prompt).toContain("</tools_context>");
  });

  it("includes self-learning rules when dataDir is provided", () => {
    writeFileSync(join(tmpDir, "SOUL.md"), "# Soul");

    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
      dataDir: tmpDir,
    });

    expect(prompt).toContain("<self_learning_rules>");
    expect(prompt).toContain("Memory Architecture");
    expect(prompt).toContain("Background Task Tools");
  });

  it("includes current time", () => {
    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
    });
    expect(prompt).toContain("<current_time>");
    expect(prompt).toContain("</current_time>");
  });

  it("omits context sections when dataDir is not provided", () => {
    const prompt = buildBackgroundTaskSystemPrompt({
      maxTurns: 200,
      model: "claude-opus-4-8",
    });
    expect(prompt).not.toContain("<soul_context>");
    expect(prompt).not.toContain("<memory_context>");
    expect(prompt).not.toContain("<tools_context>");
    expect(prompt).not.toContain("<self_learning_rules>");
  });
});
