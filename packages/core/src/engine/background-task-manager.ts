import { randomUUID } from "node:crypto";
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
import { parseSessionKey } from "../routing/session-key.js";
import {
  classifyFailure,
  feedTurnSignals,
  formatTaskFailure,
  isHardFailure,
  logSdkSignal,
  newTurnSignals,
  type FailureInfo,
  type TurnSignals,
} from "./failure.js";
import {
  addHook,
  type SdkCallContext,
  type SdkCallKind,
  type SdkOptionsPipeline,
  type SdkTurnEndResult,
} from "./sdk-options.js";

const log = pino({ name: "background-task-manager" });

/** A result that arrives while a subagent is still running is intermediate; give up waiting after this. */
export const SUBAGENT_RESULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Callback invoked when a background task completes.
 */
export interface TaskCompleteCallback {
  (task: BackgroundTask): void | Promise<void>;
}

/** Callback invoked when the manager marks a running task failed. */
export interface TaskFailedCallback {
  (task: BackgroundTask): void | Promise<void>;
}

/** One finished turn of a task (PLAN B.14). */
export interface TaskTurnResult {
  response: string;
  isError: boolean;
  subtype: string;
  costUsd: number;
  numTurns: number;
  failure?: FailureInfo;
}

export type TurnDecision = { action: "finish" } | { action: "continue"; message: string } | { action: "hold" };

/**
 * Drives a task turn by turn (goals, webhooks). Without a controller a task
 * finishes at its first final result.
 */
export interface TaskTurnController {
  /** First user message. Default: the background task prompt. `resumed` is true after a daemon restart. */
  initialMessage?(task: BackgroundTask, resumed: boolean): string;
  /** Called after every final result (no subagent active). */
  onTurnResult(task: BackgroundTask, turn: TaskTurnResult): Promise<TurnDecision>;
  /** If true, the manager does not mark the task completed or failed, or push its result; the controller does. */
  ownsCompletion?: boolean;
}

/** Per-task SDK shape, chosen by `profileFor` (usually from `task.meta.profile`). */
export interface TaskProfile {
  /** "background" (default) | "goal" | "webhook" */
  kind?: SdkCallKind;
  /** Merged over the base options before sdkOptions.apply. */
  options?: Partial<Options>;
  /** Replaces the background task system prompt. */
  systemPrompt?: string;
  /**
   * Exact tool names or "prefix*". Enforced on every call (subagents too) by
   * the built-in task-profile gate, whatever the permission mode.
   */
  toolAllowlist?: readonly string[];
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
  /** Maximum turns per background task (default: unlimited) */
  maxTurns?: number;
  /** Poll interval in ms for picking up pending tasks (default 2000) */
  pollIntervalMs?: number;
  /** Callback when a task completes */
  onTaskComplete?: TaskCompleteCallback;
  /**
   * Callback when the manager marks a running task failed: a limit or account
   * failure, a session that ended without a result, or an execution error.
   * Not called for cancellations.
   */
  onTaskFailed?: TaskFailedCallback;
  /** Turn controller for a task, or undefined for the default one-turn behaviour. */
  controllerFor?(task: BackgroundTask): TaskTurnController | undefined;
  /** SDK profile for a task, or undefined for the default. */
  profileFor?(task: BackgroundTask): TaskProfile | undefined;
  /** Shared SDK options seam (hooks, gates, contributors, stream observers) */
  sdkOptions?: SdkOptionsPipeline;
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
  query: Query | null;
  messageQueue: AsyncQueue<SDKUserMessage>;
  execution: Promise<void>;
  ctx: SdkCallContext;
  controller: TaskTurnController | undefined;
  profile: TaskProfile | undefined;
  /** uuid of the user message whose turn is in flight. */
  currentUuid: string | undefined;
  /** Subagents started and not yet stopped (SubagentStart/SubagentStop hooks). */
  activeSubagents: number;
  /** Set once the task's outcome is decided; the stream is then wound down. */
  finished: boolean;
}

/**
 * BackgroundTaskManager orchestrates async background tasks using V1 query() calls.
 *
 * It polls the BackgroundTaskStore for pending tasks and starts V1 query()
 * calls to execute them. Each background task gets its own query() call with
 * mcpServers passed directly, which ensures the kirie-tools MCP server is
 * discovered and available.
 *
 * A task's input stream is ended as soon as its outcome is decided, so its
 * subprocess exits instead of idling until shutdown. A result that arrives
 * while a subagent is still running is treated as intermediate.
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
              const text = cmd.data;
              if (cmd.interrupt && running.query) {
                log.info({ taskId: cmd.task_id }, "interrupting task and sending message");
                running.query.interrupt().then(() => {
                  this.pushTurn(running, text);
                }).catch((err) => {
                  log.error({ taskId: cmd.task_id, err }, "error interrupting task");
                });
              } else {
                log.info({ taskId: cmd.task_id }, "sending message to task");
                this.pushTurn(running, text);
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
   * Send a follow-up message into a running task's session (used by
   * controllers that returned "hold"). Returns false when the task is not running.
   */
  sendMessage(taskId: string, text: string): boolean {
    const running = this.runningTasks.get(taskId);
    if (!running || running.finished) return false;
    this.pushTurn(running, text);
    return true;
  }

  /** Call a task hook, treating a throw as "no answer". */
  private safeHook<T>(name: string, task: BackgroundTask, fn: (() => T | undefined) | undefined): T | undefined {
    if (!fn) return undefined;
    try {
      return fn();
    } catch (err) {
      log.error({ taskId: task.id, hook: name, err }, "task hook threw; using the default");
      return undefined;
    }
  }

  private buildContext(task: BackgroundTask, profile: TaskProfile | undefined): SdkCallContext {
    const kind: SdkCallKind = profile?.kind ?? "background";
    const parts = parseSessionKey(task.session_key);
    const goalIdRaw = task.meta?.data?.goalId;
    const goalId = typeof goalIdRaw === "string" ? goalIdRaw : undefined;
    const name = kind === "goal" && goalId ? `goal ${goalId}` : `${kind === "background" ? "task" : kind} ${task.id.slice(0, 8)}`;
    return {
      kind,
      sessionKey: task.session_key,
      taskId: task.id,
      ...(goalId ? { goalId } : {}),
      ...(parts ? { channel: parts.channel, chatType: parts.chatType } : {}),
      ownerDm: false,
      interactive: false,
      label: `${name} "${task.description.slice(0, 40)}"`,
      cwd: this.config.cwd ?? process.cwd(),
      ...(profile?.toolAllowlist ? { toolAllowlist: profile.toolAllowlist } : {}),
    };
  }

  /**
   * Start a V1 query() to execute a background task.
   */
  private runTask(task: BackgroundTask, resumed = false): void {
    log.info({ taskId: task.id, description: task.description, resumed }, "starting background task");

    this.store.markRunning(task.id, task.sdk_session_id ?? undefined);

    const controller = this.safeHook("controllerFor", task, this.config.controllerFor && (() => this.config.controllerFor!(task)));
    const profile = this.safeHook("profileFor", task, this.config.profileFor && (() => this.config.profileFor!(task)));

    let firstMessage = this.buildTaskPrompt(task);
    if (controller?.initialMessage) {
      const custom = this.safeHook("initialMessage", task, () => controller.initialMessage!(task, resumed));
      if (custom !== undefined) firstMessage = custom;
    }

    const running: RunningTask = {
      taskId: task.id,
      query: null,
      messageQueue: new AsyncQueue<SDKUserMessage>(),
      execution: Promise.resolve(),
      ctx: this.buildContext(task, profile),
      controller,
      profile,
      currentUuid: undefined,
      activeSubagents: 0,
      finished: false,
    };

    // Registered before executeTask runs so its finally block always finds it.
    this.runningTasks.set(task.id, running);
    running.execution = this.executeTask(task, running, firstMessage);
  }

  /** Queue a user message for a task and emit turn_start for it. */
  private pushTurn(running: RunningTask, text: string): void {
    const message = this.createUserMessage(text);
    running.currentUuid = message.uuid;
    running.messageQueue.push(message);
    this.config.sdkOptions?.observe({
      type: "turn_start",
      ctx: running.ctx,
      ...(message.uuid ? { userMessageUuid: message.uuid } : {}),
      accountId: null,
    });
  }

  private endTurn(running: RunningTask, sdkSessionId: string | undefined, result: SdkTurnEndResult): void {
    this.config.sdkOptions?.observe({
      type: "turn_end",
      ctx: running.ctx,
      ...(running.currentUuid ? { userMessageUuid: running.currentUuid } : {}),
      ...(sdkSessionId ? { sdkSessionId } : {}),
      accountId: null,
      result,
    });
    running.currentUuid = undefined;
  }

  private buildOptions(task: BackgroundTask, running: RunningTask): Options {
    const options: Options = {
      model: this.config.model,
      permissionMode: "bypassPermissions",
      allowedTools: this.config.allowedTools,
      mcpServers: this.config.mcpServers,
      cwd: this.config.cwd,
      maxTurns: this.config.maxTurns,
    };

    // If the task has a saved SDK session ID, try to resume it
    if (task.sdk_session_id) {
      options.resume = task.sdk_session_id;
    }

    const systemPrompt = running.profile?.systemPrompt ?? this.config.systemPrompt;
    if (systemPrompt) {
      options.systemPrompt = systemPrompt;
    }

    if (running.profile?.options) {
      Object.assign(options, running.profile.options);
    }

    // Count live subagents. A result that arrives while one runs is the
    // parent saying "waiting for the agent", not the task's answer.
    addHook(options, "SubagentStart", {
      hooks: [
        async () => {
          running.activeSubagents += 1;
          return {};
        },
      ],
    });
    addHook(options, "SubagentStop", {
      hooks: [
        async () => {
          running.activeSubagents = Math.max(0, running.activeSubagents - 1);
          return {};
        },
      ],
    });

    this.config.sdkOptions?.apply(options, running.ctx);
    return options;
  }

  /**
   * Execute a background task using V1 query() with an async iterable prompt.
   */
  private async executeTask(task: BackgroundTask, running: RunningTask, firstMessage: string): Promise<void> {
    const textParts: string[] = [];
    let signals: TurnSignals = newTurnSignals();
    let sdkSessionId: string | undefined = task.sdk_session_id ?? undefined;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSafetyTimer = (): void => {
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    try {
      const options = this.buildOptions(task, running);
      this.pushTurn(running, firstMessage);

      const stream = query({ prompt: running.messageQueue, options });

      // Store the Query object on the RunningTask so commands can control it
      running.query = stream;

      for await (const msg of stream) {
        this.config.sdkOptions?.observe({ type: "message", ctx: running.ctx, message: msg });
        feedTurnSignals(signals, msg);
        logSdkSignal(log, running.ctx.label, msg);

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              textParts.push(block.text);
            }
          }

          // Update SDK session ID for potential resume
          if (msg.session_id) {
            sdkSessionId = msg.session_id;
            this.store.markRunning(task.id, msg.session_id);
          }
          continue;
        }

        if (msg.type !== "result") continue;

        const turn = this.toTurnResult(msg, textParts, signals);
        if (msg.session_id) sdkSessionId = msg.session_id;
        textParts.length = 0;
        signals = newTurnSignals();

        if (running.activeSubagents > 0) {
          log.info(
            { taskId: task.id, activeSubagents: running.activeSubagents },
            "result arrived while a subagent is running; waiting for the final result",
          );
          clearSafetyTimer();
          safetyTimer = setTimeout(() => {
            safetyTimer = null;
            if (running.finished) return;
            log.warn(
              { taskId: task.id, activeSubagents: running.activeSubagents },
              "no final result after the subagent wait; using the last result",
            );
            running.activeSubagents = 0;
            void this.handleFinalTurn(task, running, turn, sdkSessionId).then((stop) => {
              if (stop) this.windDown(running);
            });
          }, SUBAGENT_RESULT_TIMEOUT_MS);
          continue;
        }

        clearSafetyTimer();
        if (await this.handleFinalTurn(task, running, turn, sdkSessionId)) {
          // End the input stream so the subprocess exits, and stop reading.
          running.messageQueue.end();
          break;
        }
      }

      // If stream ended without a final result, mark the task as failed
      if (!running.finished) {
        const currentTask = this.store.get(task.id);
        if (currentTask && currentTask.status === "running") {
          const collectedText = textParts.join("").trim();
          const errorMsg = collectedText
            ? `Session ended without result: ${collectedText.slice(0, 500)}`
            : "Session ended without producing a result (subprocess may have exited)";
          log.warn({ taskId: task.id }, errorMsg);
          this.store.markFailed(task.id, errorMsg);
          await this.notifyFailed(task.id);
        }
      }
    } catch (err) {
      // If the outcome is already decided or the task was cancelled, don't overwrite the status
      const currentTask = this.store.get(task.id);
      if (running.finished || (currentTask && currentTask.status !== "running")) {
        return;
      }

      const failure = classifyFailure({ error: err, signals });
      log.error({ taskId: task.id, err, failureClass: failure?.class }, "background task execution error");
      this.store.markFailed(
        task.id,
        isHardFailure(failure)
          ? formatTaskFailure(failure)
          : `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.notifyFailed(task.id);
    } finally {
      clearSafetyTimer();

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

      if (this.runningTasks.get(task.id) === running) {
        this.runningTasks.delete(task.id);
      }
    }
  }

  private toTurnResult(msg: Extract<SDKMessage, { type: "result" }>, textParts: string[], signals: TurnSignals): TaskTurnResult {
    const response =
      msg.subtype === "success"
        ? msg.result
        : msg.errors && msg.errors.length > 0
          ? msg.errors.join("\n")
          : textParts.join("");
    const isError = msg.is_error === true;
    const failure = isError ? classifyFailure({ text: response, signals }) : null;
    return {
      response,
      isError,
      subtype: msg.subtype,
      costUsd: msg.total_cost_usd ?? 0,
      numTurns: msg.num_turns ?? 0,
      ...(failure ? { failure } : {}),
    };
  }

  /**
   * Handle a final result. Returns true when the task is done and its stream
   * should be wound down.
   */
  private async handleFinalTurn(
    task: BackgroundTask,
    running: RunningTask,
    turn: TaskTurnResult,
    sdkSessionId: string | undefined,
  ): Promise<boolean> {
    if (running.finished) return true;

    this.endTurn(running, sdkSessionId, {
      isError: turn.isError,
      wasAborted: false,
      costUsd: turn.costUsd,
      numTurns: turn.numTurns,
    });

    const controller = running.controller;
    if (!controller) {
      await this.finishTask(task, running, turn);
      return true;
    }

    let decision: TurnDecision;
    try {
      decision = await controller.onTurnResult(this.store.get(task.id) ?? task, turn);
    } catch (err) {
      log.error({ taskId: task.id, err }, "task controller threw; failing the task");
      running.finished = true;
      this.store.markFailed(task.id, `Task controller error: ${err instanceof Error ? err.message : String(err)}`);
      await this.notifyFailed(task.id);
      return true;
    }

    switch (decision.action) {
      case "continue":
        this.pushTurn(running, decision.message);
        return false;
      case "hold":
        log.info({ taskId: task.id }, "task on hold; waiting for a message or cancellation");
        return false;
      case "finish":
        if (controller.ownsCompletion) {
          running.finished = true;
        } else {
          await this.finishTask(task, running, turn);
        }
        return true;
    }
  }

  /** Record a task's outcome: failed on a limit or account failure, completed otherwise. */
  private async finishTask(task: BackgroundTask, running: RunningTask, turn: TaskTurnResult): Promise<void> {
    running.finished = true;

    if (turn.isError && isHardFailure(turn.failure)) {
      log.warn(
        { taskId: task.id, failureClass: turn.failure.class, limitType: turn.failure.limitType },
        "background task ended on a limit or account failure",
      );
      this.store.markFailed(task.id, formatTaskFailure(turn.failure));
      await this.notifyFailed(task.id);
      return;
    }

    this.store.markCompleted(task.id, turn.response, turn.costUsd, turn.numTurns);

    log.info(
      { taskId: task.id, costUsd: turn.costUsd, numTurns: turn.numTurns },
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
  }

  private async notifyFailed(taskId: string): Promise<void> {
    if (!this.config.onTaskFailed) return;
    const failedTask = this.store.get(taskId);
    if (!failedTask || failedTask.status !== "failed") return;
    try {
      await this.config.onTaskFailed(failedTask);
    } catch (cbErr) {
      log.error({ taskId, cbErr }, "onTaskFailed callback error");
    }
  }

  /** End a task's input and close its query (used outside the read loop). */
  private windDown(running: RunningTask): void {
    running.messageQueue.end();
    running.query?.close();
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
      uuid: randomUUID(),
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
        this.runTask(task, true);
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
