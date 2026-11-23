/**
 * ScheduledInjectionQueue - delivery of "post-to-main" schedule events that
 * never interrupts a user turn (DECISIONS 16, PLAN B.14).
 *
 * The first attempt runs when the schedule fires. If the chat is busy (a turn
 * is running or queued), the event waits here and is retried on heartbeat
 * ticks every 30 s until the chat is idle. It is never dropped for being busy
 * and never falls back to interrupting. After it has waited 30 minutes the
 * owner gets one notice naming the schedule; the retries continue.
 *
 * Waiting events live in memory: a daemon restart drops them (the schedule
 * itself fires again at its next time).
 */

import type { InjectMessageResult } from "./pipeline.js";
import { createModuleLogger } from "../logging/logger.js";

const log = createModuleLogger("scheduled-injection");

export const SCHEDULE_RETRY_INTERVAL_MS = 30_000;
export const SCHEDULE_WAIT_NOTICE_MS = 30 * 60_000;

/** The fields of a ScheduleFireEvent this queue needs. */
export interface ScheduledInjectionEvent {
  name: string;
  message: string;
  channel: string;
  chatId: string;
}

export interface ScheduledInjectionDeps {
  /** Runs one attempt. Must not interrupt a busy chat (pipeline.injectScheduleMessage does not). */
  inject(event: ScheduledInjectionEvent): Promise<InjectMessageResult>;
  /** One plain line to the owner. Called once per event after it has waited `noticeAfterMs`. */
  notifyOwner?(text: string): void | Promise<void>;
  now?(): number;
  retryIntervalMs?: number;
  noticeAfterMs?: number;
}

interface WaitingEvent {
  event: ScheduledInjectionEvent;
  firstAttemptAt: number;
  nextAttemptAt: number;
  attempts: number;
  noticed: boolean;
  inFlight: boolean;
}

export class ScheduledInjectionQueue {
  private readonly waiting: WaitingEvent[] = [];
  private readonly now: () => number;
  private readonly retryIntervalMs: number;
  private readonly noticeAfterMs: number;
  private stopped = false;

  constructor(private readonly deps: ScheduledInjectionDeps) {
    this.now = deps.now ?? Date.now;
    this.retryIntervalMs = deps.retryIntervalMs ?? SCHEDULE_RETRY_INTERVAL_MS;
    this.noticeAfterMs = deps.noticeAfterMs ?? SCHEDULE_WAIT_NOTICE_MS;
  }

  /** First attempt, when the schedule fires. A busy chat queues the event for retry. */
  async deliver(event: ScheduledInjectionEvent): Promise<InjectMessageResult> {
    const result = await this.attemptOnce(event);
    if (result.status === "busy" && !this.stopped) {
      const now = this.now();
      this.waiting.push({
        event,
        firstAttemptAt: now,
        nextAttemptAt: now + this.retryIntervalMs,
        attempts: 1,
        noticed: false,
        inFlight: false,
      });
      log.info({ schedule: event.name, channel: event.channel }, "chat busy, scheduled message waits for it to go idle");
    }
    return result;
  }

  /** Call on every heartbeat tick. Retries due events; never awaits a whole turn per event in sequence. */
  async onTick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const due = this.waiting.filter((w) => !w.inFlight && w.nextAttemptAt <= now);
    await Promise.all(due.map((w) => this.retry(w)));
  }

  /** Events waiting for an idle chat. */
  pendingCount(): number {
    return this.waiting.length;
  }

  /** Daemon stop: forget waiting events and refuse new retries. */
  stop(): void {
    this.stopped = true;
    if (this.waiting.length > 0) {
      log.warn({ dropped: this.waiting.length }, "daemon stopping, waiting scheduled messages dropped");
    }
    this.waiting.length = 0;
  }

  private async retry(w: WaitingEvent): Promise<void> {
    w.inFlight = true;
    w.attempts += 1;
    try {
      const result = await this.attemptOnce(w.event);
      if (this.stopped) return;
      if (result.status === "busy") {
        w.nextAttemptAt = this.now() + this.retryIntervalMs;
        if (!w.noticed && this.now() - w.firstAttemptAt >= this.noticeAfterMs) {
          w.noticed = true;
          await this.notice(w);
        }
        return;
      }
      this.remove(w);
      log.info({ schedule: w.event.name, attempts: w.attempts, status: result.status }, "waiting scheduled message delivered");
    } finally {
      w.inFlight = false;
    }
  }

  private async attemptOnce(event: ScheduledInjectionEvent): Promise<InjectMessageResult> {
    try {
      return await this.deps.inject(event);
    } catch (err) {
      log.error({ schedule: event.name, err: err instanceof Error ? err.message : String(err) }, "scheduled message injection failed");
      return { status: "error" };
    }
  }

  private async notice(w: WaitingEvent): Promise<void> {
    if (!this.deps.notifyOwner) return;
    const minutes = Math.round((this.now() - w.firstAttemptAt) / 60_000);
    const text =
      `Scheduled message "${w.event.name}" has been waiting ${minutes} minutes because the chat is busy. ` +
      "It will be delivered as soon as the chat is idle.";
    try {
      await this.deps.notifyOwner(text);
    } catch (err) {
      log.warn({ schedule: w.event.name, err: err instanceof Error ? err.message : String(err) }, "could not send the waiting-schedule notice");
    }
  }

  private remove(w: WaitingEvent): void {
    const i = this.waiting.indexOf(w);
    if (i >= 0) this.waiting.splice(i, 1);
  }
}
