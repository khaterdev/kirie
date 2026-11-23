/**
 * LoopService - runs /loop recurring prompts on the heartbeat tick (PLAN C.8,
 * R2 section 3.2).
 *
 * Each due loop is injected into its own chat with `pipeline.injectMessage`
 * (origin "loop", skipIfBusy), so a tick is synthetic text: never a command,
 * never the owner, never an interruption of a user turn. At most one loop tick
 * starts per heartbeat tick, and at most one runs per chat.
 *
 * Quiet unless changed: the tick wrapper tells the agent to answer NO_REPLY
 * when nothing changed (the pipeline neither sends nor stores that). A digest
 * of the normalised reply decides "unchanged": unchanged multiplies the
 * interval up to base * backoffMaxMultiplier; a change resets it to base. An
 * unchanged reply to a scheduled tick is not sent (the pipeline's beforeDeliver
 * hook); `/loop now` always shows the reply.
 * A reply ending with LOOP_COMPLETE ends the loop; that reply is held back by
 * the pipeline (it is one of the quiet sentinels) and sent here without the
 * marker.
 */

import { createHash } from "node:crypto";
import type { LoopsConfig } from "../config/sections/loops.js";
import type { InjectMessageOptions, InjectMessageResult } from "../routing/pipeline.js";
import { isQuietReply } from "../routing/pipeline.js";
import { formatDuration } from "../commands/parse.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import { createModuleLogger } from "../logging/logger.js";
import { LOOP_ENDED_STATUSES, type LoopRecord, type LoopStore } from "./loop-store.js";

const log = createModuleLogger("loops");

/** Env key the loops feature sets in the kirie-tools server env: the boot `loops` config as JSON (read by loop_create). */
export const LOOPS_TOOLS_CONFIG_ENV = "KIRIE_LOOPS_CONFIG";
export const LOOP_COMPLETE_SENTINEL = "LOOP_COMPLETE";
export const LOOP_SILENT_SENTINEL = "[SILENT]";
/** A busy chat defers the tick this long, without counting a run. */
export const LOOP_BUSY_RETRY_MS = 30_000;
/** After a restart, overdue loops run once, this long after start. */
export const LOOP_RESTART_DELAY_MS = 15_000;
/** Rows are reloaded from the DB every this many heartbeat ticks (agent-created and agent-stopped loops). */
export const LOOP_RELOAD_EVERY_TICKS = 6;
/** Consecutive failed runs that pause a loop. */
export const LOOP_MAX_ERROR_STREAK = 3;
/** An agent-created loop nobody answered for this long is declined. */
export const LOOP_PENDING_TTL_MS = 24 * 3_600_000;
export const LOOP_PROMPT_MAX_CHARS = 2000;
/** Owner-set caps for --times and --for (the schema's own maxima). */
export const LOOP_OWNER_MAX_RUNS = 10_000;
export const LOOP_OWNER_MAX_EXPIRY_HOURS = 720;
const LAST_REPORT_CHARS = 300;

export type LoopDeliveryKind = "reply" | "notice";

export interface LoopServiceDeps {
  store: LoopStore;
  /** Live loops config (limits, sentinel, agentCreate) */
  config: () => LoopsConfig;
  /** Effective `loops.enabled` (runtime override ?? config) */
  isEnabled: () => boolean;
  inject: (opts: InjectMessageOptions) => Promise<InjectMessageResult>;
  /**
   * Send text to the loop's chat. "reply" is agent text the pipeline held back
   * (a LOOP_COMPLETE reply) and is also stored in chat history; "notice" is a
   * plain status line.
   */
  deliver: (loop: LoopRecord, text: string, kind: LoopDeliveryKind) => Promise<void>;
  notifyOwner: (text: string, opts?: { key?: string }) => Promise<void>;
  /** Loops only ever run in an owner's DM */
  isOwnerChat: (channel: string, chatId: string) => boolean;
  /** Ask the owner to start an agent-created loop; true = Start. Absent: agent loops are declined */
  askOwner?: (loop: LoopRecord) => Promise<boolean>;
  audit?: (action: string, actor: string, loop: LoopRecord, detail?: Record<string, unknown>) => void;
  /** pipeline.isBusy: `/loop now` refuses at once instead of starting a tick that would be skipped */
  isChatBusy?: (sessionKey: string) => boolean;
  now?: () => number;
}

export interface LoopRequest {
  intervalSec: number;
  maxRuns: number;
  expiryMs: number;
  createdBy: "owner" | "agent";
}

/**
 * Check a loop request against the config. Owners may raise --times and --for
 * up to the schema maxima; the agent never past the configured defaults.
 * Returns an error sentence, or null when the request is within limits.
 */
export function checkLoopLimits(cfg: LoopsConfig, req: LoopRequest): string | null {
  if (!Number.isFinite(req.intervalSec) || req.intervalSec < cfg.minIntervalSeconds) {
    return `The interval must be at least ${formatDuration(cfg.minIntervalSeconds * 1000)}.`;
  }
  if (req.intervalSec > cfg.maxIntervalSeconds) {
    return `The interval can be at most ${formatDuration(cfg.maxIntervalSeconds * 1000)}.`;
  }
  const maxRuns = req.createdBy === "owner" ? LOOP_OWNER_MAX_RUNS : cfg.defaultMaxRuns;
  if (!Number.isInteger(req.maxRuns) || req.maxRuns < 1 || req.maxRuns > maxRuns) {
    return `The number of runs must be between 1 and ${maxRuns}.`;
  }
  const maxExpiryHours = req.createdBy === "owner" ? LOOP_OWNER_MAX_EXPIRY_HOURS : cfg.defaultExpiryHours;
  if (!Number.isFinite(req.expiryMs) || req.expiryMs < 60_000 || req.expiryMs > maxExpiryHours * 3_600_000) {
    return `The duration must be between 1m and ${maxExpiryHours}h.`;
  }
  return null;
}

/** Lowercase, strip timestamps, clock times and durations, collapse whitespace. */
export function normalizeLoopReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b(?:\s+ago)?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function loopReplyDigest(text: string): string {
  return createHash("sha256").update(normalizeLoopReply(text)).digest("hex");
}

/** True when a reply's digest equals the last reported one (never for a loop's first report). */
export function isUnchangedLoopReply(loop: Pick<LoopRecord, "lastDigest">, response: string): boolean {
  return !!loop.lastDigest && loopReplyDigest(response) === loop.lastDigest;
}

/** The reply without a trailing LOOP_COMPLETE, when it ends with one. Null otherwise. */
export function stripLoopComplete(response: string): string | null {
  const trimmed = response.trim();
  if (!trimmed.endsWith(LOOP_COMPLETE_SENTINEL)) return null;
  return trimmed.slice(0, -LOOP_COMPLETE_SENTINEL.length).trim();
}

/** The tick prompt (R2 "Tick prompt wrapper"). */
/**
 * Text placed inside the wrapper can never open or close it: the tag name is
 * rewritten ("loop_tick" -> "loop tick"), which removes no characters, so no
 * nesting trick can rebuild it.
 */
function neutralizeLoopTag(text: string): string {
  return text.replace(/loop_tick/gi, "loop tick");
}

export function wrapLoopPrompt(loop: LoopRecord, run: number, quietSentinel: string): string {
  const prompt = neutralizeLoopTag(loop.prompt);
  const lines = [
    `<loop_tick id="${loop.id}" run="${run}" every="${formatDuration(loop.currentIntervalSec * 1000)}">`,
    prompt,
    "",
    `This is an automatic recurring check (loop ${loop.id}), not a new message from the owner.`,
  ];
  if (loop.lastReport) {
    lines.push(`What you reported last time began: "${neutralizeLoopTag(loop.lastReport).replace(/"/g, "'")}"`);
  }
  lines.push(
    `Compare with what you reported last time in this conversation. If nothing changed that the owner needs to know, reply with exactly ${quietSentinel} and nothing else. If something changed, report only the change, briefly.`,
    `If the watched condition is finished for good, end your reply with ${LOOP_COMPLETE_SENTINEL} on its own line.`,
    "</loop_tick>",
  );
  return lines.join("\n");
}

export function loopHistoryLabel(loop: LoopRecord): string {
  const prompt = loop.prompt.length > 200 ? `${loop.prompt.slice(0, 200)}…` : loop.prompt;
  return `[loop ${loop.id}] ${prompt}`;
}

export type LoopRunNowResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "ended" | "pending" | "disabled" | "running" | "busy" };

export class LoopService {
  private readonly now: () => number;
  private active: LoopRecord[] = [];
  private tickCount = 0;
  private stopped = false;
  private readonly inflightLoops = new Set<string>();
  /** The row as it was when its tick started, for delivering a LOOP_COMPLETE reply after stop() */
  private readonly inflightRecords = new Map<string, LoopRecord>();
  private readonly inflightSessions = new Set<string>();
  private readonly asking = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  /** Result handlers (not agent turns): shutdown waits for these before the DB closes */
  private readonly handlers = new Set<Promise<void>>();

  constructor(private readonly deps: LoopServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Re-anchor overdue loops (missed ticks coalesce into one) and load rows. */
  start(): void {
    this.stopped = false;
    const moved = this.deps.store.reanchorOverdue(this.now(), LOOP_RESTART_DELAY_MS);
    if (moved > 0) log.info({ moved }, "overdue loops re-anchored after start");
    this.reload();
  }

  /**
   * Stop starting ticks. A tick still running finishes in the pipeline; its
   * result is not recorded (a LOOP_COMPLETE reply is still delivered).
   */
  stop(): void {
    this.stopped = true;
  }

  /** Wait for result handlers already running (they may touch the DB). Call after stop(), before closing the store. */
  async settle(): Promise<void> {
    while (this.handlers.size > 0) await Promise.all([...this.handlers]);
  }

  /** Resolves when every started tick has been processed (tests and shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** Reload the active rows and handle agent-created loops waiting for approval. */
  reload(): void {
    if (this.stopped) return;
    try {
      this.active = this.deps.store.list({ statuses: ["active"] });
      this.processPending();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "loop reload failed");
    }
  }

  /** Heartbeat tick. Synchronous: a tick is started, never awaited here. */
  onTick(timestamp?: number): void {
    if (this.stopped) return;
    this.tickCount += 1;
    if (this.tickCount % LOOP_RELOAD_EVERY_TICKS === 1) this.reload();
    if (!this.deps.isEnabled()) return;
    const now = timestamp ?? this.now();
    for (const loop of this.active) {
      if (loop.nextRunAt > now) continue;
      if (this.inflightLoops.has(loop.id) || this.inflightSessions.has(loop.sessionKey)) continue;
      if (this.endIfSpent(loop, now)) {
        this.reload();
        return;
      }
      if (this.fire(loop, now, false)) return;   // one loop tick per heartbeat tick
    }
  }

  /** `/loop now <id>`: one tick immediately. The reply is always shown. */
  runNow(id: string): LoopRunNowResult {
    const loop = this.deps.store.get(id);
    if (!loop) return { ok: false, reason: "not-found" };
    if (loop.status === "pending_approval") return { ok: false, reason: "pending" };
    if (loop.status !== "active" && loop.status !== "paused") return { ok: false, reason: "ended" };
    if (!this.deps.isEnabled()) return { ok: false, reason: "disabled" };
    if (this.inflightLoops.has(id) || this.inflightSessions.has(loop.sessionKey)) return { ok: false, reason: "running" };
    if (this.deps.isChatBusy?.(loop.sessionKey)) return { ok: false, reason: "busy" };
    if (this.endIfSpent(loop, this.now())) {
      this.reload();
      return { ok: false, reason: "ended" };
    }
    this.fire(loop, this.now(), true);
    return { ok: true };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Expired or out of runs: end it. True when it ended. */
  private endIfSpent(loop: LoopRecord, now: number): boolean {
    if (now >= loop.expiresAt) {
      const ended = this.deps.store.end(loop.id, "expired", "expired", now);
      if (ended) {
        this.deps.audit?.("loop.ended", "system", ended, { reason: "expired" });
        void this.safeDeliver(ended, `Loop ${loop.id} expired after ${loop.runs} run${loop.runs === 1 ? "" : "s"}.`, "notice");
      }
      return true;
    }
    if (loop.runs >= loop.maxRuns) {
      const ended = this.deps.store.end(loop.id, "done", "max-runs", now);
      if (ended) {
        this.deps.audit?.("loop.ended", "system", ended, { reason: "max-runs" });
        void this.safeDeliver(ended, `Loop ${loop.id} finished its ${loop.maxRuns} runs.`, "notice");
      }
      return true;
    }
    return false;
  }

  /** Start one tick. False when the claim failed (the row changed under us). */
  private fire(loop: LoopRecord, now: number, manual: boolean): boolean {
    if (!manual) {
      const provisional = nextRunAt(loop, now, loop.currentIntervalSec * 1000);
      if (!this.deps.store.claim(loop.id, loop.nextRunAt, provisional, now)) {
        this.reload();
        return false;
      }
    }
    const cfg = this.deps.config();
    this.inflightLoops.add(loop.id);
    this.inflightRecords.set(loop.id, loop);
    this.inflightSessions.add(loop.sessionKey);
    const run = loop.runs + 1;
    const started = this.deps
      .inject({
        channel: loop.channel,
        chatId: loop.chatId,
        chatType: loop.chatType as InjectMessageOptions["chatType"],
        text: wrapLoopPrompt(loop, run, cfg.quietSentinel),
        senderId: loop.chatId,
        senderName: "Loop",
        origin: "loop",
        skipIfBusy: true,
        quietSentinels: [cfg.quietSentinel, LOOP_SILENT_SENTINEL, LOOP_COMPLETE_SENTINEL],
        historyLabel: loopHistoryLabel(loop),
        // A scheduled tick whose reply is unchanged since the last reported one is not sent.
        // `/loop now` (manual) always shows the reply.
        ...(manual ? {} : { beforeDeliver: (response: string) => (isUnchangedLoopReply(loop, response) ? "suppress" : "send") }),
      })
      .then(
        (res) => this.handle(loop.id, res, manual),
        (err: unknown) => {
          log.error({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "loop tick failed");
          return this.handle(loop.id, { status: "error" }, manual);
        },
      )
      .catch((err: unknown) => {
        log.error({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "loop result handling failed");
      })
      .finally(() => {
        this.inflightLoops.delete(loop.id);
        this.inflightRecords.delete(loop.id);
        this.inflightSessions.delete(loop.sessionKey);
        this.running.delete(started);
      });
    this.running.add(started);
    log.info({ loopId: loop.id, run, manual }, "loop tick started");
    return true;
  }

  private handle(id: string, res: InjectMessageResult, manual: boolean): Promise<void> {
    const h = this.afterRun(id, res, manual).finally(() => { this.handlers.delete(h); });
    this.handlers.add(h);
    return h;
  }

  private async afterRun(id: string, res: InjectMessageResult, manual: boolean): Promise<void> {
    const cfg = this.deps.config();
    // The pipeline holds a LOOP_COMPLETE reply back (it is a quiet sentinel), so
    // it is delivered here even if the loop was paused, turned off or the daemon
    // is stopping while the tick ran.
    const completed = res.status === "ok" ? stripLoopComplete(res.response ?? "") : null;
    const completedBody = completed && !isQuietReply(completed, [cfg.quietSentinel, LOOP_SILENT_SENTINEL]) ? completed : "";
    if (this.stopped) {
      if (completedBody) {
        const snapshot = this.inflightRecords.get(id);
        if (snapshot) await this.safeDeliver(snapshot, completedBody, "reply");
      }
      return;
    }
    const loop = this.deps.store.get(id);
    if (!loop) return;
    const now = this.now();
    if (completed !== null) {
      if (!LOOP_ENDED_STATUSES.has(loop.status)) await this.finishComplete(loop, completedBody, now);
      else if (completedBody) await this.safeDeliver(loop, completedBody, "reply");
      this.reload();
      return;
    }
    const live = loop.status === "active" || (manual && loop.status === "paused");
    if (!live) return;   // stopped or paused while the tick ran
    const base = loop.baseIntervalSec;
    const keepSchedule = manual && loop.status === "paused";

    switch (res.status) {
      case "busy": {
        this.deps.store.update(id, {
          lastStatus: "busy",
          ...(manual ? {} : { nextRunAt: now + LOOP_BUSY_RETRY_MS }),
        }, now);
        if (manual) await this.safeDeliver(loop, `Loop ${id} did not run: this chat is busy. Try again when the current reply is done.`, "notice");
        break;
      }
      case "aborted":
      case "channel-down": {
        // Not counted. A real user message cut the tick short, or the channel is down: next normal interval.
        this.deps.store.update(id, {
          lastStatus: res.status,
          ...(keepSchedule ? {} : { nextRunAt: nextRunAt(loop, now, loop.currentIntervalSec * 1000) }),
        }, now);
        break;
      }
      case "error": {
        const errorStreak = loop.errorStreak + 1;
        if (errorStreak >= LOOP_MAX_ERROR_STREAK && loop.status === "active") {
          const paused = this.deps.store.transition(id, ["active"], {
            runs: loop.runs + 1, errorStreak, lastStatus: "error", status: "paused", pauseReason: "errors",
          }, now);
          if (paused) {
            this.deps.audit?.("loop.paused", "system", paused, { reason: "errors" });
            await this.safeDeliver(paused, `Loop ${id} paused after ${errorStreak} failed runs in a row. Resume it with /loop resume ${id}.`, "notice");
          }
        } else {
          this.deps.store.update(id, {
            runs: loop.runs + 1, errorStreak, lastStatus: "error",
            ...(keepSchedule ? {} : { nextRunAt: nextRunAt(loop, now, loop.currentIntervalSec * 1000) }),
          }, now);
        }
        break;
      }
      case "ok": {
        await this.afterOk(loop, res, now, cfg, base, manual, keepSchedule);
        break;
      }
    }
    this.reload();
  }

  private async afterOk(
    loop: LoopRecord,
    res: InjectMessageResult,
    now: number,
    cfg: LoopsConfig,
    base: number,
    manual: boolean,
    keepSchedule: boolean,
  ): Promise<void> {
    const response = res.response ?? "";
    const runs = loop.runs + 1;
    const quietSentinels = [cfg.quietSentinel, LOOP_SILENT_SENTINEL];

    // A reply the pipeline suppressed as unchanged is "unchanged", not "quiet".
    const suppressed = res.suppressed === true;
    const silent = (res.silent === true && !suppressed) || isQuietReply(response, quietSentinels);
    const digest = silent ? null : loopReplyDigest(response);
    const unchanged = silent || suppressed || digest === loop.lastDigest;

    let current = loop.currentIntervalSec;
    let quietStreak = loop.quietStreak;
    const patch: Parameters<LoopStore["update"]>[1] = { runs, errorStreak: 0 };
    if (unchanged) {
      quietStreak += 1;
      if (loop.backoff) {
        current = Math.min(
          Math.round(current * cfg.backoffFactor),
          Math.round(base * cfg.backoffMaxMultiplier),
          cfg.maxIntervalSeconds,
        );
        current = Math.max(current, base);
      }
      patch.lastStatus = silent ? "quiet" : "unchanged";
    } else {
      current = base;
      quietStreak = 0;
      patch.lastStatus = "changed";
      patch.lastDigest = digest;
      patch.lastReport = scrubSecrets(response.trim().slice(0, LAST_REPORT_CHARS), { sink: "chat-history" });
    }
    patch.currentIntervalSec = current;
    patch.quietStreak = quietStreak;
    if (!keepSchedule) patch.nextRunAt = nextRunAt(loop, now, current * 1000);
    const updated = this.deps.store.update(loop.id, patch, now);

    // Checked before the await below, so a shutdown during delivery never meets a closed DB.
    if (updated) this.endIfSpent(updated, now);
    if (manual && silent) {
      await this.safeDeliver(loop, `Loop ${loop.id} ran: nothing changed (the agent answered ${cfg.quietSentinel}).`, "notice");
    }
  }

  /** The agent marked the watched condition finished: end the loop, send the reply without the marker. */
  private async finishComplete(loop: LoopRecord, body: string, now: number): Promise<void> {
    const runs = loop.runs + 1;
    this.deps.store.update(loop.id, { runs, errorStreak: 0, lastStatus: "complete" }, now);
    const ended = this.deps.store.end(loop.id, "done", "complete", now);
    if (ended) this.deps.audit?.("loop.ended", "system", ended, { reason: "complete", runs });
    if (body) await this.safeDeliver(loop, body, "reply");
    if (ended) {
      await this.safeDeliver(ended, `Loop ${loop.id} is done (the agent marked it complete after ${runs} run${runs === 1 ? "" : "s"}).`, "notice");
    }
  }

  /** Agent-created loops: apply the agentCreate policy or ask the owner. */
  private processPending(): void {
    const pending = this.deps.store.list({ statuses: ["pending_approval"] });
    if (pending.length === 0) return;
    const now = this.now();
    const cfg = this.deps.config();
    for (const loop of pending) {
      if (this.asking.has(loop.id)) continue;
      if (now - loop.createdAt > LOOP_PENDING_TTL_MS) {
        this.decline(loop, "timeout");
        continue;
      }
      const problem = this.agentLoopProblem(loop, cfg);
      if (problem) {
        this.decline(loop, problem.reason, problem.notice);
        continue;
      }
      if (cfg.agentCreate === "allow") {
        this.activateAgentLoop(loop, true);
        continue;
      }
      if (!this.deps.askOwner) {
        this.decline(loop, "no-owner-prompt");
        continue;
      }
      this.asking.add(loop.id);
      const asked = this.deps.askOwner(loop)
        .then((start) => {
          if (this.stopped) return;
          const fresh = this.deps.store.get(loop.id);
          if (!fresh || fresh.status !== "pending_approval") return;
          if (!start) {
            this.decline(fresh, "owner");
            return;
          }
          const again = this.agentLoopProblem(fresh, this.deps.config());
          if (again) {
            this.decline(fresh, again.reason, again.notice);
            return;
          }
          this.activateAgentLoop(fresh, false);
        })
        .catch((err: unknown) => {
          log.error({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "loop approval failed");
        })
        .finally(() => {
          this.asking.delete(loop.id);
          this.running.delete(asked);
          this.reload();
        });
      this.running.add(asked);
    }
  }

  private agentLoopProblem(loop: LoopRecord, cfg: LoopsConfig): { reason: string; notice?: string } | null {
    if (!this.deps.isEnabled()) return { reason: "loops-off" };
    if (cfg.agentCreate === "deny") return { reason: "agent-create-deny" };
    if (loop.chatType !== "dm" || !this.deps.isOwnerChat(loop.channel, loop.chatId)) {
      return { reason: "not-owner-dm", notice: `Declined loop ${loop.id} from the agent: loops only run in your DM.` };
    }
    const limits = checkLoopLimits(cfg, {
      intervalSec: loop.baseIntervalSec,
      maxRuns: loop.maxRuns,
      expiryMs: loop.expiresAt - loop.createdAt,
      createdBy: "agent",
    });
    if (limits) return { reason: "limits", notice: `Declined loop ${loop.id} from the agent: ${limits}` };
    if (this.deps.store.count("active") >= cfg.maxActive) {
      return { reason: "max-active", notice: `Declined loop ${loop.id} from the agent: ${cfg.maxActive} loops are already active.` };
    }
    return null;
  }

  private decline(loop: LoopRecord, reason: string, notice?: string): void {
    const ended = this.deps.store.end(loop.id, "declined", `declined:${reason}`, this.now());
    if (!ended) return;
    this.deps.audit?.("loop.declined", "system", ended, { reason });
    if (notice) void this.notify(ended, notice, { key: "loops-declined" });
  }

  private activateAgentLoop(loop: LoopRecord, announce: boolean): void {
    const now = this.now();
    const updated = this.deps.store.transition(loop.id, ["pending_approval"], { status: "active", nextRunAt: now, pauseReason: null }, now);
    if (!updated) return;   // stopped by the agent meanwhile
    this.deps.audit?.("loop.started", announce ? "system" : "owner", updated, { createdBy: "agent", via: announce ? "agentCreate:allow" : "owner-prompt" });
    if (announce) {
      void this.notify(
        updated,
        `The agent started loop ${loop.id}: every ${formatDuration(loop.baseIntervalSec * 1000)}, up to ${loop.maxRuns} runs. "${truncate(loop.prompt, 200)}". Stop it with /loop stop ${loop.id}.`,
      );
    }
  }

  /** Owner notice; when it cannot be sent, the line goes to the loop's own chat (the owner's DM) instead. */
  private async notify(loop: LoopRecord, text: string, opts?: { key?: string }): Promise<void> {
    try {
      await this.deps.notifyOwner(text, opts);
    } catch (err) {
      log.warn({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "owner notice failed; sending it to the loop's chat");
      await this.safeDeliver(loop, text, "notice");
    }
  }

  private async safeDeliver(loop: LoopRecord, text: string, kind: LoopDeliveryKind): Promise<void> {
    try {
      await this.deps.deliver(loop, text, kind);
    } catch (err) {
      log.warn({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "loop delivery failed");
    }
  }
}

/** The next run, never later than the expiry (so a backed-off loop still ends on time). */
function nextRunAt(loop: LoopRecord, now: number, delayMs: number): number {
  return Math.min(now + delayMs, Math.max(loop.expiresAt, now));
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
