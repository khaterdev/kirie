/**
 * GoalController: the /goal state machine (PLAN C.7, R2 "Controller flow").
 *
 * A goal is a background worker task (meta.profile "goal") plus this
 * controller, which the daemon registers in TaskHooks. After every final
 * worker result it counts the round and the cost, honours stop and pause,
 * runs the owner's must-pass checks in order (the first failure skips the
 * judge), asks the judge, and decides: finish (done, blocked, exhausted,
 * failed, paused) or continue with the next round's prompt.
 *
 * Fail-closed rules enforced here, in code:
 * - "done" only comes from a judge verdict given after every check passed.
 *   A judge failure or unparseable verdict is a continue; two in a row pause.
 * - Caps (rounds, wall-clock deadline, estimated cost) stop the goal. A round
 *   that ends at a cap is still checked and judged; no round starts past one.
 *   The poll interrupts a worker that runs past the deadline, and the worker
 *   session gets the remaining budget as maxBudgetUsd.
 * - Checks are the owner's commands, fixed at creation, gate-evaluated at
 *   creation (deny rejects, ask is shown to the owner first).
 * - Agent-created goals wait in pending_approval until the owner taps Start.
 *
 * The controller owns the worker task's completion (ownsCompletion): a goal
 * that ends always ends its worker, so no subprocess outlives it. Pausing
 * ends the worker too; resuming starts a new task that resumes the saved SDK
 * session. Goals survive a daemon restart (reconcileOnStartup).
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import { isUsageLimit } from "../engine/failure.js";
import type {
  BackgroundTask,
  BackgroundTaskStore,
} from "../engine/background-task-store.js";
import type {
  BackgroundTaskManager,
  TaskProfile,
  TaskTurnController,
  TaskTurnResult,
  TurnDecision,
} from "../engine/background-task-manager.js";
import type { OwnerAskRequest, OwnerAskResult } from "../interaction/owner-prompts.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { GoalsConfig } from "../config/sections/goals.js";
import { runGoalChecks, type GoalCheckRunOptions } from "./goal-checks.js";
import type { GoalJudgeFn } from "./goal-judge.js";
import {
  GOAL_ACTIVE_STATUSES,
  GOAL_KV_AGENT_CAPS,
  GOAL_KV_AGENT_CREATE,
  GOAL_KV_ENABLED,
  GOAL_OPEN_STATUSES,
  GOAL_RESUMABLE_STATUSES,
  GOAL_ROUND_LOG_MAX,
  GOAL_TERMINAL_STATUSES,
  type GoalAgentCaps,
  type GoalCheck,
  type GoalCheckResult,
  type GoalCheckReview,
  type GoalRecord,
  type GoalStartMode,
  type GoalStatus,
  type GoalStore,
  type GoalVerdictRecord,
} from "./goal-store.js";
import {
  buildGoalContinuePrompt,
  buildGoalInitialPrompt,
  buildGoalRestartPrompt,
  buildGoalResumePrompt,
} from "./goal-prompts.js";
import {
  formatGoalCaps,
  formatGoalCost,
  formatGoalElapsed,
  goalElapsedMs,
  goalTitle,
} from "./goal-format.js";

const log = createModuleLogger("goals");

/** meta.profile of goal worker tasks. */
export const GOAL_TASK_PROFILE = "goal";
/** meta.origin of goal worker tasks (excluded from the stuck-task detector). */
export const GOAL_TASK_ORIGIN = "goal";
export const GOAL_POLL_INTERVAL_MS = 2000;
/**
 * Tools hidden from goal workers: they would start more background work whose
 * cost the goal's caps do not see. A hint to the model, not the binding
 * control (the caps are enforced on the goal's own worker).
 */
export const GOAL_WORKER_DISALLOWED_TOOLS: readonly string[] = [
  "mcp__kirie-tools__goal_create",
  "mcp__kirie-tools__background_task_create",
];
const CHECKS_TAMPERED = "its check list was changed outside /goal (goals.db was edited); start a new goal";
/** Worker reply kept on the goal row and passed to the judge. */
const REPORT_STORE_CHARS = 6000;
const FINAL_REPORT_CHAT_CHARS = 1500;
const STALL_ROUNDS = 3;

export type GoalChecksRunner = (checks: readonly GoalCheck[], opts: GoalCheckRunOptions) => Promise<GoalCheckResult[]>;

export type GoalCheckEvaluator = (
  command: string,
  ctx: { sessionKey: string; cwd: string; goalId?: string },
) => Promise<{ decision: "pass" | "deny" | "ask"; reasons: string[] }>;

export interface GoalControllerDeps {
  store: GoalStore;
  tasks: Pick<BackgroundTaskStore, "create" | "get" | "markCompleted" | "markFailed" | "markCancelled" | "listByStatus">;
  taskManager: Pick<BackgroundTaskManager, "cancelTask">;
  /** Live goals config */
  config: () => GoalsConfig;
  /** Effective goals.enabled (runtime override ?? config) */
  isEnabled: () => boolean;
  judge: GoalJudgeFn;
  /** Runs the gate chain for a check command; never prompts */
  evaluateCheck: GoalCheckEvaluator;
  /** OwnerPrompts.ask */
  ask: (req: OwnerAskRequest) => Promise<OwnerAskResult>;
  askTimeoutMs: number;
  /** One plain message to the goal's chat. Must never throw (the controller catches anyway). */
  sendToChat: (sessionKey: string, text: string) => Promise<void>;
  audit?: Pick<AuditTrail, "record">;
  /** Where checks run when the goal has no --cwd */
  defaultCwd: string;
  runChecks?: GoalChecksRunner;
  now?: () => number;
  pollIntervalMs?: number;
}

export interface GoalCreateRequest {
  sessionKey: string;
  goal: string;
  checks: GoalCheck[];
  checkReview: GoalCheckReview[];
  cwd: string | null;
  maxRounds: number;
  maxMinutes: number;
  maxCostUsd: number;
  actor: string;
}

export interface GoalCheckReviewResult {
  denied: Array<{ command: string; reasons: string[] }>;
  reviews: GoalCheckReview[];
}

export type GoalActionResult = { ok: true; text: string; goal?: GoalRecord } | { ok: false; text: string };

function isActive(s: GoalStatus): boolean {
  return GOAL_ACTIVE_STATUSES.includes(s);
}

function goalIdOf(task: BackgroundTask): string | undefined {
  const raw = task.meta?.data?.goalId;
  return typeof raw === "string" ? raw : undefined;
}

function metaString(task: BackgroundTask, key: string): string | undefined {
  const raw = task.meta?.data?.[key];
  return typeof raw === "string" ? raw : undefined;
}

function normalizeReason(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class GoalController {
  private readonly store: GoalStore;
  private readonly now: () => number;
  private readonly runChecks: GoalChecksRunner;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private ticking = false;
  /** Abort handles for checks of the round being evaluated, by goal id. */
  private readonly inflight = new Map<string, AbortController>();
  /** Owner prompts in flight for agent-created goals, by goal id. */
  private readonly asking = new Map<string, AbortController>();
  private readonly lastProgressAt = new Map<string, number>();
  /** Messages produced before the channels are up (startup reconcile). */
  private readonly queuedNotices: Array<{ sessionKey: string; text: string }> = [];

  constructor(private readonly deps: GoalControllerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.runChecks = deps.runChecks ?? runGoalChecks;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Phase 2: start the poll and send the notices queued at startup. */
  start(): void {
    if (this.timer || this.closed) return;
    for (const n of this.queuedNotices.splice(0)) void this.say(n.sessionKey, n.text);
    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.pollIntervalMs ?? GOAL_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop polling and abandon in-flight evaluations. Goal rows are left as they are; the next start reconciles them. */
  shutdown(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ac of this.inflight.values()) ac.abort();
    for (const ac of this.asking.values()) ac.abort();
    this.inflight.clear();
    this.asking.clear();
  }

  /** Write the effective switches the stdio subprocess's goal tools read. */
  syncSwitches(): void {
    const cfg = this.deps.config();
    const caps: GoalAgentCaps = { maxRounds: cfg.maxRounds, maxMinutes: cfg.maxMinutes, maxCostUsd: cfg.maxCostUsd };
    this.putKv(GOAL_KV_ENABLED, this.deps.isEnabled() ? "true" : "false");
    this.putKv(GOAL_KV_AGENT_CREATE, cfg.agentCreate);
    this.putKv(GOAL_KV_AGENT_CAPS, JSON.stringify(caps));
  }

  /** Write a switch when the stored value differs, including after someone else changed it. */
  private putKv(key: string, value: string): void {
    if (this.store.getKv(key) === value) return;
    this.store.setKv(key, value);
  }

  // ── Creation ─────────────────────────────────────────────────────────────

  /** Run every check command through the tool-gate chain (never prompts). */
  async reviewChecks(commands: readonly string[], sessionKey: string, cwd: string): Promise<GoalCheckReviewResult> {
    const denied: GoalCheckReviewResult["denied"] = [];
    const reviews: GoalCheckReview[] = [];
    for (const command of commands) {
      let res: { decision: "pass" | "deny" | "ask"; reasons: string[] };
      try {
        res = await this.deps.evaluateCheck(command, { sessionKey, cwd });
      } catch (err) {
        res = { decision: "deny", reasons: [`gate evaluation failed: ${err instanceof Error ? err.message : String(err)}`] };
      }
      if (res.decision === "deny") denied.push({ command, reasons: res.reasons });
      else reviews.push({ command, decision: res.decision, reasons: res.reasons });
    }
    return { denied, reviews };
  }

  /** Create an owner goal (status pending). The caller has reviewed the checks and confirmed any "ask". */
  createGoal(req: GoalCreateRequest): GoalRecord {
    if (req.checkReview.length !== req.checks.length) throw new Error("every check needs a gate review");
    const goal = this.store.create({
      sessionKey: req.sessionKey,
      goal: req.goal,
      status: "pending",
      checks: req.checks,
      checkReview: req.checkReview,
      cwd: req.cwd,
      maxRounds: req.maxRounds,
      maxMinutes: req.maxMinutes,
      maxCostUsd: req.maxCostUsd,
      createdBy: "owner",
    });
    this.audit("goal.created", req.actor, goal, { checks: goal.checks.length, createdBy: "owner" });
    log.info({ goalId: goal.id, checks: goal.checks.length }, "goal created");
    this.tick();
    return this.store.get(goal.id) ?? goal;
  }

  // ── Owner actions ────────────────────────────────────────────────────────

  get(id: string): GoalRecord | null {
    return this.store.get(id);
  }

  list(opts: { sessionKey?: string; limit?: number } = {}): GoalRecord[] {
    return this.store.listRecent(opts);
  }

  /** Goals that are not finished. */
  openGoals(): GoalRecord[] {
    return this.store.listByStatus(GOAL_OPEN_STATUSES);
  }

  stop(id: string, actor: string, why = "stopped by the owner"): GoalActionResult {
    const goal = this.store.get(id);
    if (!goal) return { ok: false, text: `No goal ${id}.` };
    if (GOAL_TERMINAL_STATUSES.includes(goal.status)) return { ok: false, text: `Goal ${id} is already ${goal.status}.` };
    if (!this.store.transition(id, GOAL_OPEN_STATUSES, "cancelled", { stopReason: why, pauseRequested: false }, { by: actor })) {
      return { ok: false, text: `Goal ${id} could not be stopped (it just changed state).` };
    }
    this.asking.get(id)?.abort();
    this.inflight.get(id)?.abort();
    this.endWorker(goal, "cancel");
    this.audit("goal.stopped", actor, goal, { from: goal.status });
    const text = `Goal ${id} stopped after ${goal.roundsUsed} round(s), about ${formatGoalCost(goal.costUsd)}.`;
    void this.say(goal.sessionKey, text);
    return { ok: true, text };
  }

  pause(id: string, actor: string): GoalActionResult {
    const goal = this.store.get(id);
    if (!goal) return { ok: false, text: `No goal ${id}.` };
    if (goal.status === "pending_approval") return { ok: false, text: `Goal ${id} is waiting for approval; use /goal stop ${id} to decline it.` };
    if (goal.status === "pending") {
      if (this.store.transition(id, ["pending"], "paused", { stopReason: "paused by the owner" }, { by: actor })) {
        this.audit("goal.paused", actor, goal, {});
        return { ok: true, text: `Goal ${id} paused before it started. /goal resume ${id} to start it.` };
      }
      return { ok: false, text: `Goal ${id} could not be paused (it just changed state).` };
    }
    if (isActive(goal.status)) {
      this.store.update(id, { pauseRequested: true });
      this.audit("goal.pause_requested", actor, goal, {});
      return { ok: true, text: `Goal ${id} will pause at the end of the current round.` };
    }
    return { ok: false, text: `Goal ${id} is ${goal.status}.` };
  }

  /** Resume a paused, blocked or exhausted goal with a fresh allowance of rounds and minutes. Budget grows only when given. */
  resume(id: string, actor: string, opts: { note?: string; addBudgetUsd?: number } = {}): GoalActionResult {
    if (!this.deps.isEnabled()) return { ok: false, text: "Goals are off. Turn them on with /goal on." };
    const goal = this.store.get(id);
    if (!goal) return { ok: false, text: `No goal ${id}.` };
    if (!GOAL_RESUMABLE_STATUSES.includes(goal.status)) {
      return { ok: false, text: `Goal ${id} is ${goal.status}; only paused, blocked or exhausted goals can be resumed.` };
    }
    const costLimitUsd = opts.addBudgetUsd !== undefined
      ? Math.max(goal.costLimitUsd, goal.costUsd + opts.addBudgetUsd)
      : goal.costLimitUsd;
    if (goal.costUsd >= costLimitUsd) {
      return {
        ok: false,
        text: `Goal ${id} has used its budget (about ${formatGoalCost(goal.costUsd)} of ${formatGoalCost(goal.costLimitUsd)}). Resume with more: /goal resume ${id} --budget 5`,
      };
    }
    const startMode: GoalStartMode = goal.sdkSessionId ? "resume" : "start";
    const ok = this.store.transition(
      id,
      GOAL_RESUMABLE_STATUSES,
      "pending",
      {
        roundLimit: goal.roundsUsed + goal.maxRounds,
        deadlineAtMs: this.now() + goal.maxMinutes * 60_000,
        costLimitUsd,
        startMode,
        resumeNote: opts.note?.trim() ? opts.note.trim().slice(0, 2000) : null,
        pauseRequested: false,
        judgeFailures: 0,
        errorRounds: 0,
        stopReason: null,
        taskId: null,
      },
      { by: actor },
    );
    if (!ok) return { ok: false, text: `Goal ${id} could not be resumed (it just changed state).` };
    this.audit("goal.resumed", actor, goal, { from: goal.status, addBudgetUsd: opts.addBudgetUsd ?? 0 });
    this.tick();
    const updated = this.store.get(id)!;
    return {
      ok: true,
      text: `Goal ${id} resumed. New caps: ${formatGoalCaps(updated)} in total (${goal.maxRounds} more rounds, ${goal.maxMinutes} more minutes).`,
      goal: updated,
    };
  }

  // ── Poll ─────────────────────────────────────────────────────────────────

  /** One poll pass. Public for tests; the daemon runs it every 2 s. */
  tick(): void {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      this.syncSwitches();
      this.processCommands();
      this.processApprovals();
      this.watchActive();
      this.startPending();
    } catch (err) {
      log.error({ err }, "goal poll failed");
    } finally {
      this.ticking = false;
    }
  }

  private processCommands(): void {
    this.store.discardUnknownCommands();
    for (const cmd of this.store.unprocessedCommands()) {
      this.store.markCommandProcessed(cmd.id);
      const goal = this.store.get(cmd.goalId);
      if (!goal || GOAL_TERMINAL_STATUSES.includes(goal.status)) continue;
      this.stop(goal.id, "agent", "stopped by the agent (goal_stop)");
    }
  }

  private processApprovals(): void {
    for (const goal of this.store.listByStatus(["pending_approval"])) {
      if (this.asking.has(goal.id)) continue;
      if (!this.deps.isEnabled()) {
        this.cancelRequest(goal, "goals are off");
        continue;
      }
      const mode = this.deps.config().agentCreate;
      if (mode === "deny") {
        this.cancelRequest(goal, "agent-created goals are not allowed (goals.agentCreate is deny)");
        continue;
      }
      if (mode === "allow") {
        if (this.store.transition(goal.id, ["pending_approval"], "pending", { startMode: "start" }, { by: "config:allow" })) {
          this.audit("goal.agent_allowed", "system", goal, {});
        }
        continue;
      }
      this.askOwner(goal);
    }
  }

  private cancelRequest(goal: GoalRecord, reason: string): void {
    if (this.store.transition(goal.id, ["pending_approval"], "cancelled", { stopReason: reason })) {
      this.audit("goal.agent_rejected", "system", goal, { reason });
      void this.say(goal.sessionKey, `Goal ${goal.id} requested by the agent was not started: ${reason}.`);
    }
  }

  private askOwner(goal: GoalRecord): void {
    const ac = new AbortController();
    this.asking.set(goal.id, ac);
    const body = [
      goal.goal.slice(0, 1500),
      "",
      `Chat: ${goal.sessionKey}`,
      `Caps: ${formatGoalCaps(goal)}`,
      "No must-pass checks (only the owner can set checks, with /goal ... --check).",
      "It runs in the background with the same tools and gates as any background task.",
    ].join("\n");
    void this.deps
      .ask({
        kind: "goal",
        title: `The agent wants to start goal ${goal.id}`,
        body,
        options: [
          { id: "start", label: "Start" },
          { id: "decline", label: "Decline" },
        ],
        defaultOptionId: "decline",
        timeoutMs: this.deps.askTimeoutMs,
        signal: ac.signal,
      })
      .then((res) => {
        this.asking.delete(goal.id);
        if (this.closed) return;
        const approved = res.outcome === "answered" && res.optionId === "start";
        if (approved) {
          if (this.store.transition(goal.id, ["pending_approval"], "pending", { startMode: "start" }, { by: res.answeredBy ?? "owner" })) {
            this.audit("goal.agent_approved", res.answeredBy ?? "owner", goal, { code: res.code });
            this.tick();
          }
          return;
        }
        const why = res.outcome === "answered" ? "declined by the owner" : res.outcome === "timeout" ? "no answer from the owner" : `owner prompt ${res.outcome}`;
        if (this.store.transition(goal.id, ["pending_approval"], "cancelled", { stopReason: why }, { by: res.answeredBy ?? "system" })) {
          this.audit("goal.agent_declined", res.answeredBy ?? "system", goal, { outcome: res.outcome });
          void this.say(goal.sessionKey, `Goal ${goal.id} requested by the agent was not started: ${why}.`);
        }
      })
      .catch((err: unknown) => {
        this.asking.delete(goal.id);
        log.error({ goalId: goal.id, err }, "owner prompt for a goal failed");
        if (!this.closed) this.cancelRequest(goal, "the owner could not be asked");
      });
  }

  /** Deadlines of running workers, and worker tasks that ended outside the controller. */
  private watchActive(): void {
    const now = this.now();
    for (const goal of this.store.listByStatus(GOAL_ACTIVE_STATUSES)) {
      if (goal.status === "running" && goal.deadlineAtMs !== null && now >= goal.deadlineAtMs) {
        this.exhaust(goal, `time cap reached (${formatGoalElapsed(goalElapsedMs(goal, now))})`, true);
        continue;
      }
      if (!goal.taskId) continue;
      const task = this.deps.tasks.get(goal.taskId);
      if (!task) {
        this.endGoal(goal, "failed", "its worker task disappeared");
        continue;
      }
      if (task.status === "cancelled") {
        this.inflight.get(goal.id)?.abort();
        if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "cancelled", { stopReason: "its worker task was cancelled" })) {
          this.audit("goal.cancelled", "system", goal, { reason: "task cancelled" });
          void this.say(goal.sessionKey, `Goal ${goal.id} stopped: its worker was cancelled (for example by /stopall).`);
        }
      } else if (task.status === "failed") {
        this.handleWorkerFailure(goal, task);
      } else if (task.status === "completed" && !this.inflight.has(goal.id)) {
        this.endGoal(goal, "failed", "its worker ended without a verdict");
      }
    }
  }

  private startPending(): void {
    if (!this.deps.isEnabled()) return;
    const cfg = this.deps.config();
    let active = this.store.listByStatus(GOAL_ACTIVE_STATUSES).length;
    for (const goal of this.store.listByStatus(["pending"])) {
      if (active >= cfg.maxConcurrent) break;
      if (goal.costUsd >= goal.costLimitUsd) {
        this.store.transition(goal.id, ["pending"], "exhausted", { stopReason: "cost cap reached" });
        continue;
      }
      if (goal.deadlineAtMs !== null && this.now() >= goal.deadlineAtMs && goal.startMode !== "start") {
        if (this.store.transition(goal.id, ["pending"], "exhausted", { stopReason: "time cap reached" })) {
          void this.say(goal.sessionKey, this.endingText(this.store.get(goal.id) ?? goal, "exhausted", "time cap reached"));
        }
        continue;
      }
      if (!goal.checksIntact) {
        this.endGoal(goal, "failed", CHECKS_TAMPERED);
        continue;
      }
      if (this.startWorker(goal)) active++;
    }
  }

  private startWorker(goal: GoalRecord): boolean {
    const now = this.now();
    const mode = goal.startMode;
    const resumeSession = mode !== "start" ? goal.sdkSessionId : null;
    if ((mode === "restart" || mode === "retry") && !resumeSession && goal.roundsUsed > 0) {
      this.endGoal(goal, "failed", "no saved worker session to continue from");
      return false;
    }
    const task = this.deps.tasks.create(goal.sessionKey, `Goal ${goal.id}: ${goalTitle(goal)}`, goal.goal, {
      origin: GOAL_TASK_ORIGIN,
      profile: GOAL_TASK_PROFILE,
      data: { goalId: goal.id, mode, ...(resumeSession ? { resumeSession } : {}) },
    });
    const deadlineAtMs = goal.deadlineAtMs ?? now + goal.maxMinutes * 60_000;
    const ok = this.store.transition(goal.id, ["pending"], "running", {
      taskId: task.id,
      startedAtMs: goal.startedAtMs ?? now,
      deadlineAtMs,
      ...(resumeSession ? {} : { workerCostLast: 0 }),
    }, { taskId: task.id, mode });
    if (!ok) {
      this.deps.tasks.markCancelled(task.id);
      return false;
    }
    const started = this.store.get(goal.id)!;
    if (mode === "start" && goal.roundsUsed === 0) {
      const checks = goal.checks.length > 0 ? ` Checks: ${goal.checks.map((c) => c.command).join("; ")}` : "";
      void this.say(goal.sessionKey, `Goal ${goal.id} started. Caps: ${formatGoalCaps(started)}.${checks}`);
      this.audit("goal.started", "system", goal, {});
    } else if (mode === "resume" || mode === "start") {
      void this.say(goal.sessionKey, `Goal ${goal.id} resumed at round ${goal.roundsUsed + 1}/${started.roundLimit}.`);
    }
    log.info({ goalId: goal.id, taskId: task.id, mode }, "goal worker started");
    return true;
  }

  // ── Task hooks ───────────────────────────────────────────────────────────

  /** TaskHooks controller for meta.profile "goal". */
  taskController(task: BackgroundTask): TaskTurnController {
    const goalId = goalIdOf(task);
    return {
      ownsCompletion: true,
      initialMessage: (t, resumed) => this.initialMessage(goalId, t, resumed),
      onTurnResult: (t, turn) => this.onTurnResult(goalId, t, turn),
    };
  }

  /** TaskHooks profile for meta.profile "goal": kind "goal", worker model, remaining budget, session resume. */
  taskProfile(task: BackgroundTask): TaskProfile {
    const goalId = goalIdOf(task);
    const goal = goalId ? this.store.get(goalId) : null;
    const options: Partial<Options> = {};
    const workerModel = this.deps.config().workerModel;
    if (workerModel) options.model = workerModel;
    // maxBudgetUsd counts only this query()'s own spend (SDK docs), so the remaining budget is the right value.
    if (goal) options.maxBudgetUsd = Math.max(0.01, goal.costLimitUsd - goal.costUsd);
    // A worker must not start work that escapes the goal's caps.
    options.disallowedTools = [...GOAL_WORKER_DISALLOWED_TOOLS];
    const resumeSession = metaString(task, "resumeSession");
    if (resumeSession && !task.sdk_session_id) options.resume = resumeSession;
    return { kind: "goal", options };
  }

  /** TaskHooks failure handler: the manager marked a goal worker failed (crash, stream end, controller error). */
  async onTaskFailed(task: BackgroundTask): Promise<void> {
    const goalId = goalIdOf(task);
    const goal = goalId ? this.store.get(goalId) : null;
    if (!goal || goal.taskId !== task.id || !isActive(goal.status)) return;
    this.handleWorkerFailure(goal, task);
  }

  /** TaskHooks completion handler: goal workers report through the goal, never as a plain task result. */
  async onTaskCompleted(_task: BackgroundTask): Promise<void> {
    // ownsCompletion: the controller has already reported the outcome.
  }

  private handleWorkerFailure(goal: GoalRecord, task: BackgroundTask): void {
    this.inflight.get(goal.id)?.abort();
    const error = task.error ?? "the worker failed";
    if (/\[usage_limit_(account|model)\]\s*$/.test(error)) {
      if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "paused", { stopReason: "usage limit reached", taskId: null }, { error })) {
        this.audit("goal.paused", "system", goal, { reason: "usage limit" });
        void this.say(goal.sessionKey, `Goal ${goal.id} paused: the usage limit was reached. /goal resume ${goal.id} once it resets.`);
      }
      return;
    }
    const sessionId = task.sdk_session_id ?? goal.sdkSessionId;
    if (goal.errorRounds < 1 && (sessionId || goal.roundsUsed === 0) && this.deps.isEnabled()) {
      if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "pending", {
        errorRounds: goal.errorRounds + 1,
        startMode: "retry",
        sdkSessionId: sessionId ?? null,
        taskId: null,
        lastVerdict: { verdict: "continue", reason: error.slice(0, 300), missing: [], source: "error" },
      }, { error: error.slice(0, 200) })) {
        log.warn({ goalId: goal.id }, "goal worker failed; retrying once");
      }
      return;
    }
    this.endGoal(goal, "failed", `its worker failed: ${error.slice(0, 200)}`);
  }

  private initialMessage(goalId: string | undefined, task: BackgroundTask, resumed: boolean): string {
    const goal = goalId ? this.store.get(goalId) : null;
    if (!goal) return "This goal no longer exists. Reply with the single word STOPPED and do nothing else.";
    const now = this.now();
    const continuesSession = Boolean(task.sdk_session_id || metaString(task, "resumeSession"));
    // A resumed SDK session reports its total cost including earlier turns; a fresh one starts at zero.
    if (!continuesSession) this.store.update(goal.id, { workerCostLast: 0 });
    if (resumed) return buildGoalRestartPrompt(goal, now);
    const mode = (metaString(task, "mode") ?? "start") as GoalStartMode;
    switch (mode) {
      case "restart":
        return buildGoalRestartPrompt(goal, now);
      case "retry":
        if (!continuesSession) return buildGoalInitialPrompt(goal, now);
        return buildGoalContinuePrompt(
          goal,
          goal.lastVerdict ?? { verdict: "continue", reason: "the worker stopped unexpectedly", missing: [], source: "error" },
          undefined,
          now,
        );
      case "resume": {
        const note = goal.resumeNote;
        if (note !== null) this.store.update(goal.id, { resumeNote: null });
        return buildGoalResumePrompt(goal, now, note, !continuesSession);
      }
      default: {
        if (goal.roundsUsed > 0) {
          const note = goal.resumeNote;
          if (note !== null) this.store.update(goal.id, { resumeNote: null });
          return buildGoalResumePrompt(goal, now, note, true);
        }
        return buildGoalInitialPrompt(goal, now);
      }
    }
  }

  /** The controller flow for one finished worker round. */
  private async onTurnResult(goalId: string | undefined, task: BackgroundTask, turn: TaskTurnResult): Promise<TurnDecision> {
    // Shutting down: leave the rows as they are; reconcileOnStartup picks the goal up again.
    if (this.closed) return { action: "finish" };
    let goal = goalId ? this.store.get(goalId) : null;
    if (!goal || goal.taskId !== task.id || !isActive(goal.status)) {
      this.deps.tasks.markCompleted(task.id, "Goal ended.", turn.costUsd, turn.numTurns);
      return { action: "finish" };
    }
    const now = this.now();
    const fresh = this.deps.tasks.get(task.id) ?? task;
    const sdkSessionId = fresh.sdk_session_id ?? goal.sdkSessionId;

    // Cost: total_cost_usd is cumulative per query() (and a resumed session carries its saved total). Add the delta.
    const seen = Number.isFinite(turn.costUsd) ? Math.max(0, turn.costUsd) : 0;
    const delta = seen >= goal.workerCostLast ? seen - goal.workerCostLast : seen;
    const workerCostUsd = goal.workerCostUsd + delta;
    const costUsd = workerCostUsd + goal.judgeCostUsd;
    const report = scrubSecrets(turn.response ?? "", { sink: "task-result" }).slice(-REPORT_STORE_CHARS);

    // A usage limit pauses the goal with the reset time, without counting the round.
    if (turn.isError && isUsageLimit(turn.failure)) {
      const hint = turn.failure.resetHint ? ` It resets ${turn.failure.resetHint}.` : "";
      if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "paused", {
        stopReason: `usage limit reached${turn.failure.resetHint ? `, resets ${turn.failure.resetHint}` : ""}`,
        workerCostUsd, workerCostLast: seen, costUsd, sdkSessionId, taskId: null,
      })) {
        this.deps.tasks.markCompleted(task.id, "Goal paused: usage limit reached.", costUsd, turn.numTurns);
        this.audit("goal.paused", "system", goal, { reason: "usage limit" });
        void this.say(goal.sessionKey, `Goal ${goal.id} paused: the usage limit was reached.${hint} /goal resume ${goal.id} to continue.`);
      }
      return { action: "finish" };
    }

    const roundsUsed = goal.roundsUsed + 1;
    this.store.update(goal.id, {
      roundsUsed, workerCostUsd, workerCostLast: seen, costUsd, sdkTurns: turn.numTurns, sdkSessionId, lastReport: report,
    });
    goal = this.store.get(goal.id)!;

    let verdict: GoalVerdictRecord;
    let failedCheck: GoalCheckResult | undefined;
    let errorRounds = 0;
    let judgeFailures = goal.judgeFailures;

    if (turn.isError) {
      errorRounds = goal.errorRounds + 1;
      // Never the worker's own words: they would reach the judge through the round log.
      const reason = turn.failure ? `${turn.failure.class}: ${turn.failure.message}`.slice(0, 300) : `the round ended with ${turn.subtype}`;
      verdict = { verdict: "continue", reason, missing: [], source: "error" };
      const cap = this.capReached(goal, now);
      if (cap) {
        this.endWithTask(goal, task, "exhausted", cap, turn);
        return { action: "finish" };
      }
      if (errorRounds >= 2) {
        this.endWithTask(goal, task, "failed", `two rounds in a row ended with an error: ${reason}`, turn, { errorRounds });
        return { action: "finish" };
      }
    } else {
      if (!goal.checksIntact) {
        this.endWithTask(goal, task, "failed", CHECKS_TAMPERED, turn);
        return { action: "finish" };
      }
      // Must-pass checks, in order; the first failure stops the list and skips the judge.
      if (!this.store.transition(goal.id, ["running"], "checking")) return this.abandoned(goal.id, task, turn);
      const ac = new AbortController();
      this.inflight.set(goal.id, ac);
      try {
        const evaluated = await this.evaluateRound(goal, turn, roundsUsed, ac.signal);
        if (!evaluated) return this.abandoned(goal.id, task, turn);
        ({ verdict, failedCheck, judgeFailures } = evaluated);
      } finally {
        this.inflight.delete(goal.id);
      }
      if (judgeFailures >= 2) {
        goal = this.store.get(goal.id)!;
        this.endWithTask(goal, task, "paused", `the judge failed twice in a row (${verdict.reason})`, turn, {
          judgeFailures, lastVerdict: verdict, roundLog: this.appendRound(goal, roundsUsed, verdict),
        });
        return { action: "finish" };
      }
    }

    goal = this.store.get(goal.id)!;
    const roundLog = this.appendRound(goal, roundsUsed, verdict);
    this.store.update(goal.id, { lastVerdict: verdict, roundLog, errorRounds, judgeFailures });
    goal = this.store.get(goal.id)!;

    // "done" only from the judge, only after every check passed.
    if (verdict.verdict === "done" && verdict.source === "judge" && !failedCheck) {
      this.endWithTask(goal, task, "done", null, turn);
      return { action: "finish" };
    }
    if (verdict.verdict === "blocked" && verdict.source === "judge") {
      this.endWithTask(goal, task, "blocked", verdict.reason, turn);
      return { action: "finish" };
    }

    const cap = this.capReached(goal, this.now());
    if (cap) {
      this.endWithTask(goal, task, "exhausted", cap, turn);
      return { action: "finish" };
    }
    if (this.stalled(goal)) {
      this.endWithTask(goal, task, "paused", `no progress: the same verdict ${STALL_ROUNDS} rounds in a row`, turn);
      return { action: "finish" };
    }

    if (goal.pauseRequested) {
      this.endWithTask(goal, task, "paused", "paused by the owner", turn, { pauseRequested: false });
      return { action: "finish" };
    }

    if (!this.store.transition(goal.id, ["running", "checking", "judging"], "running")) return this.abandoned(goal.id, task, turn);
    goal = this.store.get(goal.id)!;
    this.progress(goal, verdict);
    return { action: "continue", message: buildGoalContinuePrompt(goal, verdict, failedCheck, this.now()) };
  }

  /**
   * Checks, then (only if every check passed) the judge. Returns null when the
   * goal changed state meanwhile (stop, deadline, shutdown). A judge failure
   * comes back as a continue verdict with judgeFailures counted; never as done.
   */
  private async evaluateRound(
    goal: GoalRecord,
    turn: TaskTurnResult,
    round: number,
    signal: AbortSignal,
  ): Promise<{ verdict: GoalVerdictRecord; failedCheck: GoalCheckResult | undefined; judgeFailures: number } | null> {
    const results = goal.checks.length > 0
      ? await this.runChecks(goal.checks, { cwd: goal.cwd ?? this.deps.defaultCwd, signal })
      : [];
    if (this.closed || signal.aborted || this.store.get(goal.id)?.status !== "checking") return null;
    this.store.update(goal.id, { lastChecks: results });
    let failedCheck = results.find((r) => !r.passed);
    if (!failedCheck && results.length < goal.checks.length) {
      // A runner that returned fewer results than checks is a failure, never a pass.
      failedCheck = { command: goal.checks[results.length]!.command, passed: false, exitCode: null, signal: null, timedOut: false, output: "the check did not run", durationMs: 0 };
    }
    if (failedCheck) {
      return {
        verdict: {
          verdict: "continue",
          reason: `check failed: ${failedCheck.command} (${failedCheck.timedOut ? "timed out" : `exit ${failedCheck.exitCode ?? "none"}`})`,
          missing: [],
          source: "check",
        },
        failedCheck,
        judgeFailures: goal.judgeFailures,
      };
    }

    if (!this.store.transition(goal.id, ["checking"], "judging")) return null;
    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const judging = this.deps.judge({
      goalId: goal.id,
      goal: goal.goal,
      createdBy: goal.createdBy,
      checks: results,
      report: turn.response ?? "",
      previousRounds: goal.roundLog,
      round,
      roundLimit: goal.roundLimit,
    });
    const outcome = await Promise.race([
      judging,
      aborted,
    ]);
    if (!outcome) {
      // Abandoned (stop, deadline, shutdown): the call still finishes on its own; count what it cost.
      void judging.then((late) => {
        if (this.closed || !(late.costUsd > 0)) return;
        const g = this.store.get(goal.id);
        if (g) this.store.update(goal.id, { judgeCostUsd: g.judgeCostUsd + late.costUsd, costUsd: g.costUsd + late.costUsd });
      }, () => undefined);
      return null;
    }
    if (this.closed) return null;
    const latest = this.store.get(goal.id);
    if (latest) {
      const judgeCostUsd = latest.judgeCostUsd + Math.max(0, outcome.costUsd || 0);
      this.store.update(goal.id, { judgeCostUsd, costUsd: latest.workerCostUsd + judgeCostUsd });
    }
    if (this.closed || signal.aborted || latest?.status !== "judging") return null;
    if (!outcome.ok) {
      const judgeFailures = goal.judgeFailures + 1;
      log.warn({ goalId: goal.id, error: outcome.error, judgeFailures }, "goal judge failed; counted as continue");
      return {
        verdict: { verdict: "continue", reason: `the judge could not decide (${outcome.error})`, missing: [], source: "judge_failure" },
        failedCheck: undefined,
        judgeFailures,
      };
    }
    return { verdict: { ...outcome.verdict, source: "judge" }, failedCheck: undefined, judgeFailures: 0 };
  }

  /** The goal changed state while its round was evaluated (stop, deadline, shutdown): end the worker. */
  private abandoned(goalId: string, task: BackgroundTask, turn: TaskTurnResult): TurnDecision {
    if (!this.closed) {
      const goal = this.store.get(goalId);
      this.deps.tasks.markCompleted(task.id, `Goal ended: ${goal?.status ?? "removed"}.`, goal?.costUsd ?? turn.costUsd, turn.numTurns);
    }
    return { action: "finish" };
  }

  private appendRound(goal: GoalRecord, round: number, verdict: GoalVerdictRecord): string[] {
    const line = `round ${round}: ${verdict.verdict} (${verdict.source}): ${verdict.reason.replace(/\s+/g, " ").slice(0, 160)}`;
    return [...goal.roundLog, line].slice(-GOAL_ROUND_LOG_MAX);
  }

  private capReached(goal: GoalRecord, now: number): string | null {
    if (goal.roundsUsed >= goal.roundLimit) return `round cap reached (${goal.roundsUsed}/${goal.roundLimit})`;
    if (goal.deadlineAtMs !== null && now >= goal.deadlineAtMs) return `time cap reached (${formatGoalElapsed(goalElapsedMs(goal, now))})`;
    if (goal.costUsd >= goal.costLimitUsd) return `cost cap reached (about ${formatGoalCost(goal.costUsd)} of ${formatGoalCost(goal.costLimitUsd)})`;
    return null;
  }

  /** The same judge reason three rounds in a row. */
  private stalled(goal: GoalRecord): boolean {
    const recent = goal.roundLog.slice(-STALL_ROUNDS);
    if (recent.length < STALL_ROUNDS) return false;
    const reasons = recent.map((l) => (l.includes("(judge):") ? normalizeReason(l.replace(/^round \d+: /, "")) : null));
    return reasons.every((r) => r !== null && r === reasons[0]);
  }

  private progress(goal: GoalRecord, verdict: GoalVerdictRecord): void {
    const now = this.now();
    const minGap = this.deps.config().progressMinIntervalSeconds * 1000;
    const last = this.lastProgressAt.get(goal.id);
    if (last !== undefined && now - last < minGap) return;
    this.lastProgressAt.set(goal.id, now);
    void this.say(
      goal.sessionKey,
      `Goal ${goal.id} round ${goal.roundsUsed}/${goal.roundLimit}: ${verdict.reason.slice(0, 200)} ${formatGoalElapsed(goalElapsedMs(goal, now))} elapsed, about ${formatGoalCost(goal.costUsd)}.`,
    );
  }

  // ── Endings ──────────────────────────────────────────────────────────────

  /** End a goal from inside its round: move the goal, record the worker task's outcome, tell the chat. */
  private endWithTask(
    goal: GoalRecord,
    task: BackgroundTask,
    to: "done" | "blocked" | "exhausted" | "paused" | "failed",
    reason: string | null,
    turn: TaskTurnResult,
    extra: Parameters<GoalStore["update"]>[1] = {},
  ): void {
    if (!this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, to, { ...extra, stopReason: reason })) return;
    const latest = this.store.get(goal.id) ?? goal;
    const summary = this.endingText(latest, to, reason);
    if (to === "failed") this.deps.tasks.markFailed(task.id, summary);
    else this.deps.tasks.markCompleted(task.id, to === "done" ? `${summary}\n\n${latest.lastReport ?? ""}`.trim() : summary, latest.costUsd, turn.numTurns);
    this.audit(`goal.${to}`, "system", latest, { reason, rounds: latest.roundsUsed, costUsd: Number(latest.costUsd.toFixed(4)) });
    this.lastProgressAt.delete(goal.id);
    void this.say(goal.sessionKey, to === "done" ? `${summary}\n\n${(latest.lastReport ?? "").slice(-FINAL_REPORT_CHAT_CHARS)}`.trim() : summary);
  }

  /** End a goal outside a round (poll, restart, failure handler) and stop its worker. */
  private endGoal(goal: GoalRecord, to: "failed" | "exhausted", reason: string): void {
    if (!this.store.transition(goal.id, GOAL_OPEN_STATUSES.filter((s) => s !== "paused" && s !== "blocked" && s !== "exhausted"), to, { stopReason: reason })) return;
    this.inflight.get(goal.id)?.abort();
    this.endWorker(goal, to === "failed" ? "fail" : "complete", reason);
    const latest = this.store.get(goal.id) ?? goal;
    this.audit(`goal.${to}`, "system", latest, { reason });
    this.lastProgressAt.delete(goal.id);
    void this.say(goal.sessionKey, this.endingText(latest, to, reason));
  }

  private exhaust(goal: GoalRecord, reason: string, interrupt: boolean): void {
    if (!this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "exhausted", { stopReason: reason, taskId: null })) return;
    this.inflight.get(goal.id)?.abort();
    if (interrupt) this.endWorker(goal, "complete", reason);
    const latest = this.store.get(goal.id) ?? goal;
    this.audit("goal.exhausted", "system", latest, { reason });
    this.lastProgressAt.delete(goal.id);
    void this.say(goal.sessionKey, this.endingText(latest, "exhausted", reason));
  }

  /** Stop the goal's worker task and give its row a final status. */
  private endWorker(goal: GoalRecord, how: "cancel" | "complete" | "fail", reason?: string): void {
    if (!goal.taskId) return;
    const task = this.deps.tasks.get(goal.taskId);
    if (!task || (task.status !== "pending" && task.status !== "running")) return;
    if (how === "complete") this.deps.tasks.markCompleted(task.id, `Goal stopped: ${reason ?? goal.status}.`, goal.costUsd, goal.sdkTurns);
    else if (how === "fail") this.deps.tasks.markFailed(task.id, `Goal failed: ${reason ?? "unknown"}.`);
    // cancelTask closes the query (the subprocess exits); it only relabels a row still pending or running.
    if (!this.deps.taskManager.cancelTask(task.id)) this.deps.tasks.markCancelled(task.id);
  }

  private endingText(goal: GoalRecord, to: GoalStatus, reason: string | null): string {
    const stats = `${goal.roundsUsed} round(s), ${formatGoalElapsed(goalElapsedMs(goal, this.now()))}, about ${formatGoalCost(goal.costUsd)}`;
    switch (to) {
      case "done":
        return `Goal ${goal.id} done in ${stats}.`;
      case "blocked":
        return `Goal ${goal.id} is blocked after ${stats}: ${reason ?? "the worker needs you"}. /goal resume ${goal.id} [instructions] once it is unblocked, or /goal stop ${goal.id}.`;
      case "exhausted":
        return `Goal ${goal.id} stopped: ${reason ?? "a cap was reached"}. ${stats}. /goal resume ${goal.id} to add ${goal.maxRounds} rounds and ${formatGoalElapsed(goal.maxMinutes * 60_000)} (add --budget N if the budget is used up), or /goal stop ${goal.id}.`;
      case "paused":
        return `Goal ${goal.id} paused: ${reason ?? "paused"}. ${stats}. /goal resume ${goal.id} to continue, /goal stop ${goal.id} to end it.`;
      case "failed":
        return `Goal ${goal.id} failed: ${reason ?? "unknown error"}. ${stats}.`;
      default:
        return `Goal ${goal.id} is ${to}.`;
    }
  }

  // ── Restart ──────────────────────────────────────────────────────────────

  /**
   * Run once at daemon setup, before the task manager resumes tasks.
   * Goal workers whose goal is no longer active are cancelled so they are not
   * resumed. Active goals continue: through the task manager's resume path when
   * their task row still holds an SDK session, otherwise through a new task
   * that resumes the goal's saved session. Without any session the goal fails.
   */
  reconcileOnStartup(): void {
    const cfg = this.deps.config();
    const goalTasks = [...this.deps.tasks.listByStatus("running"), ...this.deps.tasks.listByStatus("pending")].filter(
      (t) => t.meta?.profile === GOAL_TASK_PROFILE,
    );
    for (const t of goalTasks) {
      const id = goalIdOf(t);
      const goal = id ? this.store.get(id) : null;
      if (!goal || goal.taskId !== t.id || !isActive(goal.status)) {
        this.deps.tasks.markCancelled(t.id);
        log.info({ taskId: t.id, goalId: id }, "cancelled a goal worker whose goal is not active");
      }
    }

    for (const goal of this.store.listByStatus(GOAL_ACTIVE_STATUSES)) {
      const task = goal.taskId ? this.deps.tasks.get(goal.taskId) : null;
      // The deadline is absolute: downtime counts. Do not resume a goal that ran out meanwhile.
      const cap = this.capReached(goal, this.now());
      if (cap) {
        if (task && (task.status === "running" || task.status === "pending")) this.deps.tasks.markCancelled(task.id);
        if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "exhausted", { stopReason: cap, sdkSessionId: task?.sdk_session_id ?? goal.sdkSessionId })) {
          this.queueNotice(goal.sessionKey, this.endingText(this.store.get(goal.id) ?? goal, "exhausted", cap));
        }
        continue;
      }
      if (!cfg.resumeOnRestart) {
        if (task && (task.status === "running" || task.status === "pending")) this.deps.tasks.markCancelled(task.id);
        if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "paused", { stopReason: "the daemon restarted (goals.resumeOnRestart is off)", taskId: null, sdkSessionId: task?.sdk_session_id ?? goal.sdkSessionId })) {
          this.queueNotice(goal.sessionKey, `Goal ${goal.id} paused because the daemon restarted. /goal resume ${goal.id} to continue.`);
        }
        continue;
      }
      if (task && task.status === "running" && task.sdk_session_id) {
        // The task manager resumes it with initialMessage(task, true).
        this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "running", { sdkSessionId: task.sdk_session_id }, { restart: "task-resume" });
        continue;
      }
      if (task && task.status === "pending") {
        this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "running", {}, { restart: "task-pending" });
        continue;
      }
      if (task && task.status === "running") this.deps.tasks.markCancelled(task.id);
      const sessionId = task?.sdk_session_id ?? goal.sdkSessionId;
      if (sessionId) {
        this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "pending", { startMode: "restart", sdkSessionId: sessionId, taskId: null }, { restart: "new-task" });
        continue;
      }
      if (goal.roundsUsed === 0) {
        // Nothing was done yet: start the first round again.
        this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "pending", { startMode: "start", taskId: null }, { restart: "fresh" });
        continue;
      }
      if (this.store.transition(goal.id, GOAL_ACTIVE_STATUSES, "failed", { stopReason: "the daemon restarted before the worker session was saved", taskId: null })) {
        this.audit("goal.failed", "system", goal, { reason: "restart without session" });
        this.queueNotice(goal.sessionKey, `Goal ${goal.id} failed: the daemon restarted before its worker session was saved. Start it again with /goal.`);
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private queueNotice(sessionKey: string, text: string): void {
    if (this.timer) void this.say(sessionKey, text);
    else this.queuedNotices.push({ sessionKey, text });
  }

  private async say(sessionKey: string, text: string): Promise<void> {
    try {
      await this.deps.sendToChat(sessionKey, text);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "goal message not sent");
    }
  }

  private audit(action: string, actor: string, goal: GoalRecord, detail: Record<string, unknown>): void {
    try {
      this.deps.audit?.record({ feature: "goals", action, actor, detail: { goalId: goal.id, ...detail } });
    } catch {
      // AuditTrail never throws; a fake might.
    }
  }
}
