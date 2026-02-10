/**
 * Signal Detectors - Tier 1 of the Proactive Intelligence Layer.
 *
 * Signal detectors run synchronously on each heartbeat tick (every ~10s)
 * to detect conditions that may need proactive action. Detected signals
 * are queued for Tier 2 triage by the ProactiveEngine.
 */

import type { ChannelRegistry } from "../channels/registry.js";
import type { SessionStore } from "./session-store.js";
import type { ProactiveConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity levels for detected signals */
export type SignalSeverity = "info" | "warning" | "critical";

/** A detected condition that may require proactive action */
export interface Signal {
  /** Unique identifier for this signal instance */
  id: string;
  /** Signal type for categorization (e.g. "task-stuck", "channel-down") */
  type: string;
  /** Severity level */
  severity: SignalSeverity;
  /** Short human-readable title */
  title: string;
  /** Detailed description of what was detected */
  details: string;
  /** When the signal was detected (ms since epoch) */
  timestamp: number;
  /** Which detector produced this signal */
  source: string;
  /** Optional stable key for deduplication. If not set, type:title is used. */
  deduplicationKey?: string;
}

/** Information about a running background task, provided via callback */
export interface RunningTaskInfo {
  id: string;
  description: string;
  startedAt: number;
  status: string;
}

/** Context passed to each signal detector on every tick */
export interface DetectorContext {
  /** Channel registry for checking adapter status */
  channelRegistry: ChannelRegistry;
  /** Session store for checking session health */
  sessionStore: SessionStore;
  /** Current timestamp (ms since epoch) */
  now: number;
  /** Current heartbeat tick number */
  tickNumber: number;
  /** Get list of currently running background tasks */
  getRunningTasks?: () => RunningTaskInfo[];
  /** Get count of failed message deliveries pending retry */
  getFailedDeliveryCount?: () => number;
}

/** A signal detector that runs synchronously on each heartbeat tick */
export interface SignalDetector {
  /** Human-readable name of this detector */
  name: string;
  /** Detect signals. Must be synchronous (no async). */
  detect(context: DetectorContext): Signal[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let signalIdCounter = 0;

function createSignalId(source: string): string {
  signalIdCounter += 1;
  return `${source}-${Date.now()}-${signalIdCounter}`;
}

// ---------------------------------------------------------------------------
// Detector: Task Health
// ---------------------------------------------------------------------------

/** Maximum time a background task should run before being flagged (10 minutes) */
const STUCK_TASK_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Checks for background tasks that have been running longer than the threshold.
 */
export class TaskHealthDetector implements SignalDetector {
  readonly name = "task-health";

  detect(context: DetectorContext): Signal[] {
    const signals: Signal[] = [];

    if (!context.getRunningTasks) return signals;

    const tasks = context.getRunningTasks();
    for (const task of tasks) {
      const runningMs = context.now - task.startedAt;
      if (runningMs > STUCK_TASK_THRESHOLD_MS) {
        const minutes = Math.round(runningMs / 60_000);
        signals.push({
          id: createSignalId("task-health"),
          type: "task-stuck",
          severity: "warning",
          title: `Background task stuck (${minutes}min)`,
          details: `Task "${task.description}" (${task.id}) has been running for ${minutes} minutes.`,
          timestamp: context.now,
          source: this.name,
          deduplicationKey: `task-stuck:${task.id}`,
        });
      }
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Detector: Channel Health
// ---------------------------------------------------------------------------

/**
 * Checks channel adapter connection status via the ChannelRegistry.
 */
export class ChannelHealthDetector implements SignalDetector {
  readonly name = "channel-health";

  detect(context: DetectorContext): Signal[] {
    const signals: Signal[] = [];
    const adapters = context.channelRegistry.getAll();

    for (const [channelId, adapter] of adapters) {
      const status = adapter.getStatus();

      if (status.state === "error") {
        signals.push({
          id: createSignalId("channel-health"),
          type: "channel-down",
          severity: "critical",
          title: `Channel ${channelId} is in error state`,
          details: `Channel "${channelId}" status: ${status.state}, failures: ${status.failureCount}${status.lastError ? `, last error: ${status.lastError}` : ""}`,
          timestamp: context.now,
          source: this.name,
          deduplicationKey: `channel-error:${channelId}`,
        });
      } else if (status.state === "disconnected" || status.state === "reconnecting") {
        signals.push({
          id: createSignalId("channel-health"),
          type: "channel-degraded",
          severity: "warning",
          title: `Channel ${channelId} is ${status.state}`,
          details: `Channel "${channelId}" status: ${status.state}, failures: ${status.failureCount}`,
          timestamp: context.now,
          source: this.name,
          deduplicationKey: `channel-${status.state}:${channelId}`,
        });
      }
    }

    // Check for failed deliveries
    if (context.getFailedDeliveryCount) {
      const failedCount = context.getFailedDeliveryCount();
      if (failedCount > 0) {
        signals.push({
          id: createSignalId("channel-health"),
          type: "delivery-failures",
          severity: failedCount > 5 ? "critical" : "warning",
          title: `${failedCount} message deliveries pending retry`,
          details: `There are ${failedCount} failed message deliveries queued for retry.`,
          timestamp: context.now,
          source: this.name,
        });
      }
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Detector: System Health
// ---------------------------------------------------------------------------

/** Default RSS memory threshold: 1GB */
const DEFAULT_MEMORY_THRESHOLD_MB = 1024;

/**
 * Checks process-level health metrics (memory usage, etc.)
 */
export class SystemHealthDetector implements SignalDetector {
  readonly name = "system-health";
  private readonly thresholdBytes: number;

  constructor(thresholdMB: number = DEFAULT_MEMORY_THRESHOLD_MB) {
    this.thresholdBytes = thresholdMB * 1024 * 1024;
  }

  detect(context: DetectorContext): Signal[] {
    const signals: Signal[] = [];
    const thresholdMB = Math.round(this.thresholdBytes / (1024 * 1024));

    const mem = process.memoryUsage();
    if (mem.rss > this.thresholdBytes) {
      const rssMb = Math.round(mem.rss / (1024 * 1024));
      signals.push({
        id: createSignalId("system-health"),
        type: "high-memory",
        severity: "warning",
        title: `High memory usage (${rssMb}MB RSS)`,
        details: `Process RSS is ${rssMb}MB (threshold: ${thresholdMB}MB). Heap used: ${Math.round(mem.heapUsed / (1024 * 1024))}MB.`,
        timestamp: context.now,
        source: this.name,
      });
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Detector: Time Awareness
// ---------------------------------------------------------------------------

/**
 * Detects time-based events: daily digest time, late night awareness.
 * Uses the configured timezone and active hours.
 */
export class TimeAwarenessDetector implements SignalDetector {
  readonly name = "time-awareness";
  private readonly timezone: string;
  private readonly digestTime: string;
  private readonly activeHoursEnd: string;
  private lastDigestTick = -1;
  private lastLateNightTick = -1;

  constructor(config: ProactiveConfig) {
    this.timezone = config.activeHours.timezone;
    this.digestTime = config.dailyDigestTime;
    this.activeHoursEnd = config.activeHours.end;
  }

  detect(context: DetectorContext): Signal[] {
    const signals: Signal[] = [];

    // Get current time in configured timezone
    const nowDate = new Date(context.now);
    const timeStr = this.getTimeInTimezone(nowDate);
    const timeParts = timeStr.split(":").map(Number);
    const currentH = timeParts[0] ?? 0;
    const currentM = timeParts[1] ?? 0;
    const currentMinutes = currentH * 60 + currentM;

    // Check for daily digest time (trigger within a 2-minute window)
    const digestParts = this.digestTime.split(":").map(Number);
    const digestH = digestParts[0] ?? 0;
    const digestM = digestParts[1] ?? 0;
    const digestMinutes = digestH * 60 + digestM;

    if (
      Math.abs(currentMinutes - digestMinutes) <= 1 &&
      context.tickNumber - this.lastDigestTick > 12 // ~2 min cooldown at 10s ticks
    ) {
      this.lastDigestTick = context.tickNumber;
      signals.push({
        id: createSignalId("time-awareness"),
        type: "daily-digest-time",
        severity: "info",
        title: "Daily digest time",
        details: `It's ${this.digestTime} in ${this.timezone} — time for the daily digest.`,
        timestamp: context.now,
        source: this.name,
      });
    }

    // Check for late night (past active hours end)
    const endParts = this.activeHoursEnd.split(":").map(Number);
    const endH = endParts[0] ?? 0;
    const endM = endParts[1] ?? 0;
    const endMinutes = endH * 60 + endM;

    // If end is past midnight (e.g. "02:00"), check if we're in the 02:00-02:10 window
    const isLateNightWindow = endMinutes < 12 * 60
      ? (currentMinutes >= endMinutes && currentMinutes <= endMinutes + 10)
      : (currentMinutes >= endMinutes && currentMinutes <= endMinutes + 10);

    if (
      isLateNightWindow &&
      context.tickNumber - this.lastLateNightTick > 360 // ~1 hour cooldown
    ) {
      this.lastLateNightTick = context.tickNumber;
      signals.push({
        id: createSignalId("time-awareness"),
        type: "late-night",
        severity: "info",
        title: "Late night detected",
        details: `It's past ${this.activeHoursEnd} in ${this.timezone}. Consider suggesting rest.`,
        timestamp: context.now,
        source: this.name,
      });
    }

    return signals;
  }

  /**
   * Get current time as HH:MM in the configured timezone.
   * Falls back to local time if timezone is not supported.
   */
  private getTimeInTimezone(date: Date): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: this.timezone,
      });
      const parts = formatter.formatToParts(date);
      const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
      const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
      return `${hour}:${minute}`;
    } catch {
      // Fallback to local time
      const h = String(date.getHours()).padStart(2, "0");
      const m = String(date.getMinutes()).padStart(2, "0");
      return `${h}:${m}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the default set of signal detectors.
 */
export function createDefaultDetectors(config: ProactiveConfig): SignalDetector[] {
  return [
    new TaskHealthDetector(),
    new ChannelHealthDetector(),
    new SystemHealthDetector(config.memoryThresholdMB),
    new TimeAwarenessDetector(config),
  ];
}
