import { randomUUID } from "node:crypto";
import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { createModuleLogger } from "../logging/logger.js";
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
import type { TurnPlan, TurnResilience } from "./resilience.js";

const log = createModuleLogger("background-task-manager");

/** A result that arrives while a subagent is still running is intermediate; give up waiting after this. */
export const SUBAGENT_RESULT_TIMEOUT_MS = 10 * 60 * 1000;

/** First-message prefix for a task restarted on another account or model (PLAN C.1). */
export const TASK_ROTATION_NOTE =
  "<system_note>The previous attempt at this task stopped because the Claude account or model reached a limit. Kirie restarted it on another account or model. If work on this task already appears above, continue from where it stopped instead of starting over.</system_note>";

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
  /** uuids of pushed user messages that no result has answered yet, oldest first. */
  pendingTurns: Set<string>;
  /** Messages about to be pushed (after an interrupt) that already count as pending. */
  reservedTurns: number;
  /** Subagents started and not yet stopped (SubagentStart/SubagentStop hooks). */
  activeSubagents: number;
  /** Set once the task's outcome is decided or it was cancelled; the stream is then wound down. */
  finished: boolean;
  /** Serialises final-turn handling between the read loop and the subagent safety timer. */
  finalChain: Promise<unknown>;
  /** Account and model plan for this run (null without resilience) */
  plan: TurnPlan | null;
  /** Account the subprocess was spawned with (null = ambient) */
  accountId: string | null;
  /** Set when the task goes back to pending for the next account or model once its process is closed */
  requeue: boolean;
}

/** A result that ended a turn, with the user-message uuids it answered. */
interface SettledTurn {
  turn: TaskTurnResult;
  answered: readonly string[] | null;
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
 * while a subagent is still running, or while a message sent to the task is
 * still unanswered, does not decide the outcome.
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
  /** Account rotation and model fallback (PLAN C.1, C.2). Null: today's behaviour */
  private resilience: TurnResilience | null = null;

  constructor(store: BackgroundTaskStore, config: BackgroundTaskManagerConfig) {
    this.store = store;
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
  }

  /**
   * Install (or remove) account rotation and model fallback. A task that ends
   * on a limit or account failure then goes back to pending with its SDK
   * session id kept, and restarts on the next account or model.
   */
  setResilience(resilience: TurnResilience | null): void {
    this.resilience = resilience;
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
            running.finished = true;
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
                // Count the message as pending now, so the result of the
                // interrupted turn does not finish the task before it is sent.
                running.reservedTurns += 1;
                running.query.interrupt().then(() => {
                  this.pushTurn(running, text, true);
                }).catch((err) => {
                  running.reservedTurns = Math.max(0, running.reservedTurns - 1);
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

    // A task restarted after a limit is a resumption of the same conversation.
    const rotated = (task.rotation_attempts ?? 0) > 0;
    let firstMessage = this.buildTaskPrompt(task);
    if (controller?.initialMessage) {
      const custom = this.safeHook("initialMessage", task, () => controller.initialMessage!(task, resumed || rotated));
      if (custom !== undefined) firstMessage = custom;
    }
    if (rotated && this.resilience) firstMessage = `${TASK_ROTATION_NOTE}\n${firstMessage}`;

    const ctx = this.buildContext(task, profile);
    const primaryModel = typeof profile?.options?.model === "string" ? profile.options.model : this.config.model;
    const plan = this.resilience?.begin({ kind: ctx.kind, primaryModel }) ?? null;
    const accountId = plan?.current.accountId ?? null;
    if (plan) this.store.setAccount(task.id, accountId);

    const running: RunningTask = {
      taskId: task.id,
      query: null,
      messageQueue: new AsyncQueue<SDKUserMessage>(),
      execution: Promise.resolve(),
      ctx,
      controller,
      profile,
      pendingTurns: new Set<string>(),
      reservedTurns: 0,
      activeSubagents: 0,
      finished: false,
      finalChain: Promise.resolve(),
      plan,
      accountId,
      requeue: false,
    };

    // Registered before executeTask runs so its finally block always finds it.
    this.runningTasks.set(task.id, running);
    running.execution = this.executeTask(task, running, firstMessage);
  }

  /** Queue a user message for a task and emit turn_start for it. */
  private pushTurn(running: RunningTask, text: string, reserved = false): void {
    if (reserved) running.reservedTurns = Math.max(0, running.reservedTurns - 1);
    if (running.finished) {
      log.warn({ taskId: running.taskId }, "message for a finished task dropped");
      return;
    }
    const message = this.createUserMessage(text);
    if (message.uuid) running.pendingTurns.add(message.uuid);
    running.messageQueue.push(message);
    this.config.sdkOptions?.observe({
      type: "turn_start",
      ctx: running.ctx,
      ...(message.uuid ? { userMessageUuid: message.uuid } : {}),
      accountId: running.accountId,
    });
  }

  /**
   * Mark the user messages a result answered (its `user_message_uuids`, or
   * the oldest pending one when the result names none) and emit turn_end.
   * Returns true when no sent message is still waiting for an answer.
   */
  private settleTurn(running: RunningTask, settled: SettledTurn, sdkSessionId: string | undefined): boolean {
    let uuid: string | undefined;
    const answered = settled.answered?.filter((u) => running.pendingTurns.has(u)) ?? [];
    if (answered.length > 0) {
      for (const u of answered) running.pendingTurns.delete(u);
      uuid = answered[answered.length - 1];
    } else {
      const oldest = running.pendingTurns.values().next();
      if (!oldest.done) {
        running.pendingTurns.delete(oldest.value);
        uuid = oldest.value;
      }
    }

    const result: SdkTurnEndResult = {
      isError: settled.turn.isError,
      wasAborted: false,
      costUsd: settled.turn.costUsd,
      numTurns: settled.turn.numTurns,
    };
    this.config.sdkOptions?.observe({
      type: "turn_end",
      ctx: running.ctx,
      ...(uuid ? { userMessageUuid: uuid } : {}),
      ...(sdkSessionId ? { sdkSessionId } : {}),
      accountId: running.accountId,
      result,
    });
    return running.pendingTurns.size === 0 && running.reservedTurns === 0;
  }

  /** Run handleFinalTurn so that two calls never overlap. */
  private runFinal(task: BackgroundTask, running: RunningTask, turn: TaskTurnResult): Promise<boolean> {
    const next = running.finalChain.then(() => this.handleFinalTurn(task, running, turn));
    running.finalChain = next.catch(() => undefined);
    return next;
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

    // If the task has a saved SDK session ID, try to resume it. Under another
    // account only when the transcript can be carried there.
    if (task.sdk_session_id) {
      const from = task.account_id ?? null;
      if (!running.plan || !this.resilience || this.resilience.resumableAcross(from, running.accountId, task.sdk_session_id)) {
        options.resume = task.sdk_session_id;
      } else {
        log.warn({ taskId: task.id, fromAccount: from, toAccount: running.accountId }, "task session cannot be carried to the new account; starting fresh");
      }
    }

    const systemPrompt = running.profile?.systemPrompt ?? this.config.systemPrompt;
    if (systemPrompt) {
      options.systemPrompt = systemPrompt;
    }

    if (running.profile?.options) {
      Object.assign(options, running.profile.options);
    }

    if (running.plan) {
      const candidate = running.plan.current;
      if (candidate.model) options.model = candidate.model;
      if (candidate.env) options.env = candidate.env;
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
    /** Last result that arrived while a subagent was running, used if no final one comes. */
    let intermediate: SettledTurn | null = null;
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
        const settled: SettledTurn = {
          turn,
          answered: msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : null),
        };
        if (msg.session_id) sdkSessionId = msg.session_id;
        textParts.length = 0;
        signals = newTurnSignals();

        if (running.finished) continue;

        if (running.activeSubagents > 0) {
          intermediate = settled;
          log.info(
            { taskId: task.id, activeSubagents: running.activeSubagents },
            "result arrived while a subagent is running; waiting for the final result",
          );
          clearSafetyTimer();
          safetyTimer = setTimeout(() => {
            safetyTimer = null;
            const pending = intermediate;
            intermediate = null;
            if (running.finished || !pending) return;
            log.warn(
              { taskId: task.id, activeSubagents: running.activeSubagents },
              "no final result after the subagent wait; using the last result",
            );
            running.activeSubagents = 0;
            if (!this.settleTurn(running, pending, sdkSessionId)) return;
            void this.runFinal(task, running, pending.turn).then((stop) => {
              if (stop) this.windDown(running);
            });
          }, SUBAGENT_RESULT_TIMEOUT_MS);
          continue;
        }

        clearSafetyTimer();
        intermediate = null;
        if (!this.settleTurn(running, settled, sdkSessionId)) {
          log.info({ taskId: task.id, pending: running.pendingTurns.size }, "a message sent to the task is still unanswered; continuing");
          continue;
        }
        if (await this.runFinal(task, running, turn)) {
          // End the input stream so the subprocess exits, and stop reading.
          running.messageQueue.end();
          break;
        }
      }

      // The stream ended while a subagent was still counted as running: the
      // last result is the best answer there is.
      if (!running.finished && intermediate) {
        clearSafetyTimer();
        const pending = intermediate;
        intermediate = null;
        log.warn({ taskId: task.id }, "stream ended while waiting for a subagent; using the last result");
        this.settleTurn(running, pending, sdkSessionId);
        await this.runFinal(task, running, pending.turn);
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
      if (isHardFailure(failure) && this.tryRequeue(task, running, failure)) return;
      this.store.markFailed(
        task.id,
        isHardFailure(failure)
          ? formatTaskFailure(this.finalFailure(running, failure))
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

      // Back to pending only after this process is closed, so the restart on
      // the next account never shares the transcript with a live process.
      if (running.requeue) {
        if (this.store.requeueForRotation(task.id)) {
          log.info({ taskId: task.id }, "task re-queued for the next account or model");
        }
      }
    }
  }

  /**
   * A run ended on a limit or account failure. When another account or model
   * may be tried and the task has re-queues left, mark it for re-queue and
   * return true; the caller must not record a failure then.
   */
  private tryRequeue(task: BackgroundTask, running: RunningTask, failure: FailureInfo): boolean {
    const plan = running.plan;
    if (!plan || !this.resilience) return false;
    // next() records the failure (benches the account or model) even when nothing else is tried.
    const advance = plan.next(failure);
    const attempts = this.store.get(task.id)?.rotation_attempts ?? task.rotation_attempts ?? 0;
    if (!advance || attempts >= this.resilience.maxAttemptsPerTurn() - 1) return false;
    running.finished = true;
    running.requeue = true;
    log.warn(
      { taskId: task.id, failureClass: failure.class, toAccount: advance.accountId, toModel: advance.model, attempts: attempts + 1 },
      "background task hit a limit; restarting it on the next account or model",
    );
    return true;
  }

  /** The failure to store when a task gives up: with the earliest reset when every account is limited. */
  private finalFailure(running: RunningTask, failure: FailureInfo): FailureInfo {
    return running.plan ? running.plan.finalFailure(failure) : failure;
  }

  private toTurnResult(msg: Extract<SDKMessage, { type: "result" }>, textParts: string[], signals: TurnSignals): TaskTurnResult {
    const response =
      msg.subtype === "success"
        ? msg.result
        : msg.errors && msg.errors.length > 0
          ? msg.errors.join("\n")
          : textParts.join("");
    const isError = msg.is_error === true;
    // Classify the error text only, never the model's own words.
    const errorText = msg.subtype === "success" ? msg.result : (msg.errors ?? []).join("\n");
    const failure = isError ? classifyFailure({ text: errorText, signals }) : null;
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
  private async handleFinalTurn(task: BackgroundTask, running: RunningTask, turn: TaskTurnResult): Promise<boolean> {
    if (running.finished) return true;

    // A limit is not the controller's business: restart on the next account or model first.
    if (turn.isError && isHardFailure(turn.failure) && this.tryRequeue(task, running, turn.failure)) return true;

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
      this.store.markFailed(task.id, formatTaskFailure(this.finalFailure(running, turn.failure)));
      await this.notifyFailed(task.id);
      return;
    }

    if (!turn.isError) running.plan?.succeeded();

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

    running.finished = true;
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
