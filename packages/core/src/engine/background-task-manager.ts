import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { BackgroundTaskStore, BackgroundTask } from "./background-task-store.js";

const log = pino({ name: "background-task-manager" });

/**
 * Callback invoked when a background task completes.
 */
export interface TaskCompleteCallback {
  (task: BackgroundTask): void | Promise<void>;
}

/**
 * Configuration for the BackgroundTaskManager.
 */
export interface BackgroundTaskManagerConfig {
  /** Model to use */
  model: string;
  /** MCP server configs to pass to each task query */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tools to auto-allow */
  allowedTools?: string[];
  /** Working directory for task sessions */
  cwd?: string;
  /** System prompt for background tasks */
  systemPrompt?: string;
  /** Poll interval in ms for picking up pending tasks (default 2000) */
  pollIntervalMs?: number;
  /** Callback when a task completes */
  onTaskComplete?: TaskCompleteCallback;
}

/**
 * A pushable async iterable. Items pushed are yielded to consumers.
 * Call end() to signal no more items will be pushed.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * Tracks a running background task's query.
 */
interface RunningTask {
  taskId: string;
  query: Query;
  messageQueue: AsyncQueue<SDKUserMessage>;
  execution: Promise<void>;
}

/**
 * BackgroundTaskManager orchestrates async background tasks using V1 query() calls.
 *
 * It polls the BackgroundTaskStore for pending tasks and starts V1 query()
 * calls to execute them. Each background task gets its own query() call with
 * mcpServers passed directly, which ensures the kirie-tools MCP server is
 * discovered and available.
 *
 * This decouples the MCP server (which writes tasks to the DB)
 * from the daemon (which executes them).
 */
export class BackgroundTaskManager {
  private readonly store: BackgroundTaskStore;
  private readonly config: BackgroundTaskManagerConfig;
  private readonly runningTasks = new Map<string, RunningTask>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;

  constructor(store: BackgroundTaskStore, config: BackgroundTaskManagerConfig) {
    this.store = store;
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
  }

  /**
   * Start polling for pending tasks.
   */
  start(): void {
    if (this.pollTimer) return;

    log.info({ pollIntervalMs: this.pollIntervalMs }, "background task manager started");

    // Initial poll
    this.pollPendingTasks();

    // Periodic poll
    this.pollTimer = setInterval(() => this.pollPendingTasks(), this.pollIntervalMs);
  }

  /**
   * Stop polling and shut down all running task sessions.
   */
  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Collect executions before cancelling (cancelTask removes from map)
    const executions = [...this.runningTasks.values()].map((t) => t.execution);
    const taskIds = [...this.runningTasks.keys()];

    // Cancel all running tasks
    for (const taskId of taskIds) {
      this.cancelTask(taskId);
    }

    // Wait for executions to finish
    await Promise.allSettled(executions);

    log.info({ cancelledTasks: taskIds.length }, "background task manager shut down");
  }

  /**
   * Poll for pending tasks and start queries for them.
   * Also poll for unprocessed commands.
   */
  private pollPendingTasks(): void {
    try {
      const pendingTasks = this.store.listByStatus("pending");
      for (const task of pendingTasks) {
        if (!this.runningTasks.has(task.id)) {
          this.runTask(task);
        }
      }
    } catch (err) {
      log.error({ err }, "error polling for pending tasks");
    }

    this.pollCommands();
  }

  /**
   * Poll for unprocessed commands and execute them against running tasks.
   */
  private pollCommands(): void {
    try {
      const commands = this.store.getUnprocessedCommands();
      for (const cmd of commands) {
        const running = this.runningTasks.get(cmd.task_id);
        if (!running) {
          // Task not running — mark command processed and skip
          this.store.markCommandProcessed(cmd.id);
          continue;
        }

        switch (cmd.action) {
          case "kill": {
            log.info({ taskId: cmd.task_id }, "killing task via command");
            if (running.query) {
              running.query.close();
            }
            running.messageQueue.end();
            this.store.markCancelled(cmd.task_id);
            this.runningTasks.delete(cmd.task_id);
            break;
          }
          case "send_message": {
            if (cmd.data) {
              if (cmd.interrupt) {
                log.info({ taskId: cmd.task_id }, "interrupting task and sending message");
                running.query.interrupt().then(() => {
                  running.messageQueue.push(this.createUserMessage(cmd.data!));
                }).catch((err) => {
                  log.error({ taskId: cmd.task_id, err }, "error interrupting task");
                });
              } else {
                log.info({ taskId: cmd.task_id }, "sending message to task");
                running.messageQueue.push(this.createUserMessage(cmd.data));
              }
            }
            break;
          }
        }

        this.store.markCommandProcessed(cmd.id);
      }
    } catch (err) {
      log.error({ err }, "error polling commands");
    }
  }

  /**
   * Start a V1 query() to execute a background task.
   */
  private runTask(task: BackgroundTask): void {
    log.info({ taskId: task.id, description: task.description }, "starting background task");

    this.store.markRunning(task.id);

    const messageQueue = new AsyncQueue<SDKUserMessage>();

    // Push the initial task prompt as the first message
    messageQueue.push(this.createUserMessage(this.buildTaskPrompt(task)));

    const running: RunningTask = {
      taskId: task.id,
      query: null as unknown as Query, // set inside executeTask before any await
      messageQueue,
      execution: Promise.resolve(), // placeholder, replaced below
    };

    running.execution = this.executeTask(task, running);

    this.runningTasks.set(task.id, running);
  }

  /**
   * Execute a background task using V1 query() with an async iterable prompt.
   */
  private async executeTask(task: BackgroundTask, running: RunningTask): Promise<void> {
    const textParts: string[] = [];

    try {
      const options: Options = {
        model: this.config.model,
        permissionMode: "bypassPermissions",
        allowedTools: this.config.allowedTools,
        mcpServers: this.config.mcpServers,
        cwd: this.config.cwd,
      };

      // If the task has a saved SDK session ID, try to resume it
      if (task.sdk_session_id) {
        options.resume = task.sdk_session_id;
      }

      // If we have a system prompt, set it
      if (this.config.systemPrompt) {
        options.systemPrompt = this.config.systemPrompt;
      }

      const stream = query({ prompt: running.messageQueue, options });

      // Store the Query object on the RunningTask so commands can control it
      running.query = stream;

      let resultReceived = false;

      for await (const msg of stream) {
        switch (msg.type) {
          case "assistant": {
            for (const block of msg.message.content) {
              if (block.type === "text") {
                textParts.push(block.text);
              }
            }

            // Update SDK session ID for potential resume
            if (msg.session_id) {
              this.store.markRunning(task.id, msg.session_id);
            }
            break;
          }

          case "result": {
            resultReceived = true;
            let response: string;
            let costUsd = 0;
            let numTurns = 0;

            if (msg.subtype === "success") {
              response = msg.result;
              costUsd = msg.total_cost_usd;
              numTurns = msg.num_turns;
            } else {
              const errMsg = msg as SDKMessage & { errors?: string[]; total_cost_usd?: number; num_turns?: number };
              response = errMsg.errors && errMsg.errors.length > 0
                ? errMsg.errors.join("\n")
                : textParts.join("");
              costUsd = errMsg.total_cost_usd ?? 0;
              numTurns = errMsg.num_turns ?? 0;
            }

            this.store.markCompleted(task.id, response, costUsd, numTurns);

            log.info(
              { taskId: task.id, costUsd, numTurns },
              "background task completed",
            );

            // Notify callback
            if (this.config.onTaskComplete) {
              const completedTask = this.store.get(task.id);
              if (completedTask) {
                try {
                  await this.config.onTaskComplete(completedTask);
                } catch (cbErr) {
                  log.error({ taskId: task.id, cbErr }, "onTaskComplete callback error");
                }
              }
            }
            break;
          }

          default:
            break;
        }
      }

      // If stream ended without a result message, mark the task as failed
      if (!resultReceived) {
        const currentTask = this.store.get(task.id);
        if (currentTask && currentTask.status === "running") {
          const collectedText = textParts.join("").trim();
          const errorMsg = collectedText
            ? `Session ended without result: ${collectedText.slice(0, 500)}`
            : "Session ended without producing a result (subprocess may have exited)";
          log.warn({ taskId: task.id }, errorMsg);
          this.store.markFailed(task.id, errorMsg);
        }
      }
    } catch (err) {
      // If task was already cancelled, don't overwrite the status
      const currentTask = this.store.get(task.id);
      if (currentTask && currentTask.status === "cancelled") {
        return;
      }

      log.error({ taskId: task.id, err }, "background task execution error");
      this.store.markFailed(
        task.id,
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // End the message queue so the SDK's streamInput() finishes iterating
      // and calls endInput() to close stdin. Without this, the subprocess
      // stdin stays open, the process never exits, and the SDK's
      // process.on("exit") listener is never cleaned up — causing the
      // MaxListenersExceededWarning memory leak.
      running.messageQueue.end();

      // Close the query to forcefully terminate the subprocess and clean up
      // all resources (including the process "exit" listener on the global
      // process object). This is safe to call even if the stream already ended.
      if (running.query) {
        running.query.close();
      }

      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Build the prompt for a background task.
   */
  private buildTaskPrompt(task: BackgroundTask): string {
    return [
      `<background_task id="${task.id}" session_key="${task.session_key}">`,
      `<session_context session_key="${task.session_key}" />`,
      "",
      `Description: ${task.description}`,
      "",
      "Instructions:",
      task.prompt,
      "",
      "You are running as a background task. Take your time and be thorough.",
      "Use your available tools (memory, web search, file operations, etc.) to gather information and complete the work.",
      "Store important findings in memory using memory_store so they persist.",
      "When done, provide a detailed summary of what was accomplished and any key findings.",
      "</background_task>",
    ].join("\n");
  }

  /**
   * Create an SDKUserMessage from a text string.
   */
  private createUserMessage(text: string): SDKUserMessage {
    return {
      type: "user",
      message: {
        role: "user",
        content: text,
      },
      parent_tool_use_id: null,
      session_id: "",
    };
  }

  /**
   * Cancel a running background task.
   */
  cancelTask(taskId: string): boolean {
    const running = this.runningTasks.get(taskId);
    if (!running) return false;

    if (running.query) {
      running.query.close();
    }
    running.messageQueue.end();
    this.store.markCancelled(taskId);
    this.runningTasks.delete(taskId);

    log.info({ taskId }, "background task cancelled");
    return true;
  }

  /**
   * Cancel all running background tasks. Returns the number cancelled.
   */
  cancelAll(): number {
    let count = 0;
    for (const taskId of [...this.runningTasks.keys()]) {
      if (this.cancelTask(taskId)) count++;
    }
    return count;
  }

  /**
   * Resume tasks that were running when the daemon died.
   * Called on startup to recover in-flight tasks.
   */
  resumeOnStartup(): void {
    const runningTasks = this.store.listByStatus("running");
    for (const task of runningTasks) {
      if (task.sdk_session_id) {
        log.info({ taskId: task.id, description: task.description }, "resuming interrupted task");
        this.runTask(task);
      } else {
        // No session to resume — mark as failed so user can retry
        log.warn({ taskId: task.id }, "cannot resume task without SDK session ID, marking failed");
        this.store.markFailed(task.id, "Daemon restarted: no SDK session to resume");
      }
    }
  }

  /**
   * Get the number of currently running tasks.
   */
  get runningTaskCount(): number {
    return this.runningTasks.size;
  }
}
