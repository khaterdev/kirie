/**
 * ProactiveEngine - orchestrator for the Proactive Intelligence Layer.
 *
 * Runs on each heartbeat tick and coordinates three tiers:
 *   Tier 1 (every tick):  Signal detectors scan for conditions
 *   Tier 2 (periodic):   LLM triage evaluates signals + checklist
 *   Tier 3 (on-demand):  Escalation to background tasks for deep work
 *
 * Usage:
 *   const proactive = new ProactiveEngine({ ... });
 *   heartbeat.on("tick", (event) => proactive.onTick(event));
 *   proactive.start();
 */

import { EventEmitter } from "node:events";
import pino from "pino";
import type { ProactiveConfig } from "../config/schema.js";
import type { HeartbeatTickEvent, HeartbeatService } from "./heartbeat.js";
import type {
  Signal,
  SignalDetector,
  DetectorContext,
  RunningTaskInfo,
} from "./signals.js";
import { createDefaultDetectors } from "./signals.js";
import type { TriageDecision } from "./triage.js";
import { TriageRunner } from "./triage.js";
import { NotificationManager } from "./notifications.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SessionStore } from "./session-store.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { HeartbeatLogStore } from "../mcp/tools/heartbeat-logs.js";

const log = pino({ name: "proactive" });

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ProactiveEngineEvents {
  signalDetected: [Signal];
  triageCompleted: [{ decisions: TriageDecision[]; signalsProcessed: number }];
  notificationSent: [{ message: string; channel: string; chatId: string }];
  escalationSpawned: [{ decision: TriageDecision; sessionKey: string }];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ProactiveEngineDeps {
  config: ProactiveConfig;
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  /** Default channel for proactive notifications */
  defaultChannel: ChannelName;
  /** Default chat ID for owner notifications */
  defaultChatId: string;
  /** Callback to get running background tasks */
  getRunningTasks?: () => RunningTaskInfo[];
  /** Callback to get failed delivery count from heartbeat */
  getFailedDeliveryCount?: () => number;
  /** Callback to create a background task (Tier 3 escalation) */
  createBackgroundTask?: (sessionKey: string, description: string, prompt: string) => void;
  /** Optional HeartbeatLogStore for triage context injection */
  heartbeatLogStore?: HeartbeatLogStore;
}

// ---------------------------------------------------------------------------
// ProactiveEngine
// ---------------------------------------------------------------------------

/** Dedup window: ignore duplicate signals within this period (5 minutes) */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Clean up old dedup entries every 100 ticks */
const DEDUP_CLEANUP_INTERVAL = 100;

/** Default cooldown: suppress repeat notifications for the same signal type */
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export class ProactiveEngine extends EventEmitter<ProactiveEngineEvents> {
  private readonly config: ProactiveConfig;
  private readonly channelRegistry: ChannelRegistry;
  private readonly sessionStore: SessionStore;

  /** Pending signals waiting for triage */
  private signalQueue: Signal[] = [];

  /** Signal hash -> last seen timestamp, for dedup */
  private readonly dedupCache = new Map<string, number>();

  /** signal.type -> timestamp of last notification/escalation, for decision-level dedup */
  private readonly notifiedTypes = new Map<string, number>();

  /** Timestamp of the last triage run */
  private lastTriageAt = 0;

  /** Signal detectors */
  private readonly detectors: SignalDetector[];

  /** Triage runner (calls LLM) */
  private readonly triageRunner: TriageRunner;

  /** Notification manager */
  private readonly notificationManager: NotificationManager;

  /** Whether the engine is actively processing ticks */
  private running = false;

  /** Whether a triage is currently in progress */
  private triageInProgress = false;

  /** Tier 2 interval in milliseconds */
  private readonly tier2IntervalMs: number;

  /** Callbacks for detector context */
  private readonly getRunningTasks?: () => RunningTaskInfo[];
  private readonly getFailedDeliveryCount?: () => number;
  private readonly createBackgroundTask?: (sessionKey: string, description: string, prompt: string) => void;
  private readonly defaultChannel: string;
  private readonly defaultChatId: string;

  constructor(deps: ProactiveEngineDeps) {
    super();

    this.config = deps.config;
    this.channelRegistry = deps.channelRegistry;
    this.sessionStore = deps.sessionStore;
    this.getRunningTasks = deps.getRunningTasks;
    this.getFailedDeliveryCount = deps.getFailedDeliveryCount;
    this.createBackgroundTask = deps.createBackgroundTask;
    this.defaultChannel = deps.defaultChannel;
    this.defaultChatId = deps.defaultChatId;

    this.tier2IntervalMs = deps.config.tier2IntervalMinutes * 60 * 1000;

    // Initialize signal detectors
    this.detectors = createDefaultDetectors(deps.config);

    // Initialize triage runner (with optional heartbeat log store for context injection)
    this.triageRunner = new TriageRunner(deps.config, deps.heartbeatLogStore);

    // Initialize notification manager
    this.notificationManager = new NotificationManager(deps.channelRegistry, {
      defaultChannel: deps.defaultChannel,
      defaultChatId: deps.defaultChatId,
    });

    log.info(
      {
        tier2IntervalMin: deps.config.tier2IntervalMinutes,
        detectorsCount: this.detectors.length,
        tier2Model: deps.config.tier2Model,
      },
      "proactive engine initialized",
    );
  }

  /**
   * Wire the heartbeat service into the notification manager for retry support.
   * Called after HeartbeatService is created (it depends on ProactiveEngine
   * via ticks, so the engine is created first).
   */
  setHeartbeat(heartbeat: HeartbeatService): void {
    this.notificationManager.setHeartbeat(heartbeat);
  }

  /**
   * Called on each heartbeat tick. Runs Tier 1 signal detection
   * and triggers Tier 2 triage when appropriate.
   */
  onTick(event: HeartbeatTickEvent): void {
    if (!this.running) return;

    const now = event.timestamp;

    // ── Tier 1: Run all signal detectors ──────────────────────
    const context: DetectorContext = {
      channelRegistry: this.channelRegistry,
      sessionStore: this.sessionStore,
      now,
      tickNumber: event.tickNumber,
      getRunningTasks: this.getRunningTasks,
      getFailedDeliveryCount: this.getFailedDeliveryCount,
    };

    for (const detector of this.detectors) {
      try {
        const signals = detector.detect(context);
        for (const signal of signals) {
          if (!this.isDuplicate(signal, now)) {
            this.signalQueue.push(signal);
            this.dedupCache.set(this.hashSignal(signal), now);
            this.emit("signalDetected", signal);
          }
        }
      } catch (err) {
        log.error({ detector: detector.name, err }, "signal detector error");
      }
    }

    // ── Periodic dedup cache cleanup ──────────────────────────
    if (event.tickNumber % DEDUP_CLEANUP_INTERVAL === 0) {
      this.cleanupDedupCache(now);
    }

    // ── Tier 2: Check if triage is needed ─────────────────────
    const hasCriticalSignals = this.signalQueue.some((s) => s.severity === "critical");
    const timeSinceLastTriage = now - this.lastTriageAt;
    const triageOverdue = timeSinceLastTriage >= this.tier2IntervalMs;

    if ((triageOverdue || hasCriticalSignals) && !this.triageInProgress) {
      // Run triage asynchronously (don't block the tick)
      void this.runTriage();
    }
  }

  /**
   * Run a triage cycle: drain the signal queue, call the LLM,
   * and process the resulting decisions.
   */
  async runTriage(): Promise<{ signalsProcessed: number; decisions: TriageDecision[] }> {
    if (this.triageInProgress) {
      return { signalsProcessed: 0, decisions: [] };
    }

    this.triageInProgress = true;
    const now = Date.now();

    try {
      // Clean expired entries from notifiedTypes cache
      this.cleanupNotifiedTypes(now);

      // Drain the signal queue
      const allSignals = this.signalQueue.splice(0);

      // Handle daily-digest-time signals directly (bypass triage)
      const hasDigestSignal = allSignals.some((s) => s.type === "daily-digest-time");
      if (hasDigestSignal) {
        try {
          await this.notificationManager.sendDigest();
        } catch (err) {
          log.error({ err }, "failed to send digest");
        }
      }

      // Filter out informational signals — they're not actionable by triage
      const signals = allSignals.filter(
        (s) => s.type !== "daily-digest-time" && s.type !== "late-night" && s.type !== "task-long-running",
      );

      log.debug({ signalCount: signals.length, filtered: allSignals.length - signals.length }, "starting triage");

      // Call the triage runner
      const result = await this.triageRunner.triage(signals);

      // Process decisions
      for (const decision of result.decisions) {
        await this.processDecision(decision, signals);
      }

      this.lastTriageAt = now;

      this.emit("triageCompleted", {
        decisions: result.decisions,
        signalsProcessed: result.signalsProcessed,
      });

      log.info(
        {
          signalsProcessed: result.signalsProcessed,
          decisions: result.decisions.length,
          llmCalled: result.llmCalled,
        },
        "triage completed",
      );

      return { signalsProcessed: result.signalsProcessed, decisions: result.decisions };
    } catch (err) {
      log.error({ err }, "triage run failed");
      return { signalsProcessed: 0, decisions: [] };
    } finally {
      this.triageInProgress = false;
    }
  }

  /**
   * Process a single triage decision.
   */
  private async processDecision(
    decision: TriageDecision,
    signals: Signal[],
  ): Promise<void> {
    switch (decision.action) {
      case "notify-now": {
        if (decision.message) {
          const deduKey = this.getDecisionDeduKey(decision, signals);
          const cooldownMs = (this.config.notificationCooldownMinutes ?? 60) * 60 * 1000;
          const lastNotified = this.notifiedTypes.get(deduKey);
          if (lastNotified && (Date.now() - lastNotified) < cooldownMs) {
            log.debug({ deduKey, action: "notify-now" }, "suppressed: notification cooldown active");
            break;
          }
          const sent = await this.notificationManager.notifyNow(decision.message);
          if (sent) {
            this.notifiedTypes.set(deduKey, Date.now());
            this.emit("notificationSent", {
              message: decision.message,
              channel: "default",
              chatId: "default",
            });
          }
        }
        break;
      }

      case "queue-digest": {
        // Find the signal this decision applies to
        const signal = decision.signalId
          ? signals.find((s) => s.id === decision.signalId)
          : undefined;

        if (signal) {
          this.notificationManager.queueForDigest(signal);
        } else if (decision.message) {
          // Create a synthetic signal for the digest
          this.notificationManager.queueForDigest({
            id: `triage-${Date.now()}`,
            type: "triage-item",
            severity: "info",
            title: decision.message,
            details: "",
            timestamp: Date.now(),
            source: "triage",
          });
        }
        break;
      }

      case "escalate": {
        if (this.createBackgroundTask) {
          const deduKey = this.getDecisionDeduKey(decision, signals);
          const cooldownMs = (this.config.notificationCooldownMinutes ?? 60) * 60 * 1000;
          const lastNotified = this.notifiedTypes.get(deduKey);
          if (lastNotified && (Date.now() - lastNotified) < cooldownMs) {
            log.debug({ deduKey, action: "escalate" }, "suppressed: escalation cooldown active");
            break;
          }
          const sessionKey = `${this.defaultChannel}:dm:${this.defaultChatId}`;
          const description = `Proactive escalation: ${decision.message ?? "investigate signal"}`;
          const prompt = decision.message
            ? `You are Kirie's proactive intelligence system. A triage check escalated this to you for deep investigation:\n\n${decision.message}\n\nCRITICAL RULES:\n- NEVER cancel or kill background tasks unless you are 100% certain they have FAILED (e.g., process crashed, SDK session dead, explicit error in logs).\n- A task running for 10, 20, 30, or even 60+ minutes is NOT stuck. Complex tasks like builds, test suites, and multi-phase implementations routinely take this long.\n- If a background task has cost > $0 and num_turns > 0, it is ACTIVELY WORKING. Do NOT kill it.\n- If you're unsure whether a task is stuck or just slow, ASK THE USER first by sending a message. Do NOT take destructive action.\n- The ONLY acceptable reasons to auto-cancel a task are: SDK session is dead/disconnected, the task has had 0 turns for 30+ minutes, or the task explicitly errored out.\n- Your default action should be to INFORM the user about your findings, NOT to cancel anything.\n\nInvestigate thoroughly using all available tools. Send your findings as a message to telegram chat ${this.defaultChatId} using the send_message tool.`
            : "Proactive escalation triggered but no details provided.";
          try {
            this.createBackgroundTask(sessionKey, description, prompt);
            this.notifiedTypes.set(deduKey, Date.now());
            this.emit("escalationSpawned", { decision, sessionKey });
            log.info({ decision, sessionKey }, "tier 3: spawned background task for escalation");
          } catch (err) {
            log.error({ err, decision }, "tier 3: failed to create background task");
          }
        } else {
          log.warn({ decision }, "tier 3 escalation requested but no background task creator configured");
        }
        break;
      }

      case "silent":
      default:
        // No action needed
        break;
    }
  }

  /**
   * Check if a signal is a duplicate (same hash within dedup window).
   */
  private isDuplicate(signal: Signal, now: number): boolean {
    const hash = this.hashSignal(signal);
    const lastSeen = this.dedupCache.get(hash);
    if (lastSeen === undefined) return false;
    return (now - lastSeen) < DEDUP_WINDOW_MS;
  }

  /**
   * Create a dedup hash from a signal's deduplicationKey, or type:title fallback.
   */
  private hashSignal(signal: Signal): string {
    return signal.deduplicationKey ?? `${signal.type}:${signal.title}`;
  }

  /**
   * Clean up expired entries from the dedup cache.
   */
  private cleanupDedupCache(now: number): void {
    for (const [hash, timestamp] of this.dedupCache) {
      if (now - timestamp > DEDUP_WINDOW_MS) {
        this.dedupCache.delete(hash);
      }
    }
  }

  /**
   * Derive a stable dedup key for a triage decision based on its source signal type.
   */
  private getDecisionDeduKey(decision: TriageDecision, signals: Signal[]): string {
    if (decision.signalId) {
      const signal = signals.find((s) => s.id === decision.signalId);
      if (signal) return signal.type;
    }
    return "unsourced";
  }

  /**
   * Clean up expired entries from the notifiedTypes cache.
   */
  private cleanupNotifiedTypes(now: number): void {
    const cooldownMs = (this.config.notificationCooldownMinutes ?? 60) * 60 * 1000
      || DEFAULT_NOTIFICATION_COOLDOWN_MS;
    for (const [key, timestamp] of this.notifiedTypes) {
      if (now - timestamp > cooldownMs) {
        this.notifiedTypes.delete(key);
      }
    }
  }

  /**
   * Start the proactive engine. After this, onTick() will process events.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("proactive engine started");
  }

  /**
   * Stop the proactive engine. onTick() will no-op after this.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    log.info("proactive engine stopped");
  }

  /** Whether the engine is currently running */
  get isRunning(): boolean {
    return this.running;
  }

  /** Number of signals waiting for triage */
  get signalQueueSize(): number {
    return this.signalQueue.length;
  }

  /** Timestamp of the last triage run */
  get lastTriageTimestamp(): number {
    return this.lastTriageAt;
  }

  /** Number of entries in the dedup cache */
  get dedupCacheSize(): number {
    return this.dedupCache.size;
  }

  /** Number of entries in the notifiedTypes cache */
  get notifiedTypesCacheSize(): number {
    return this.notifiedTypes.size;
  }

  /** Get the notification manager for direct access */
  get notifications(): NotificationManager {
    return this.notificationManager;
  }

  /** Calculated next triage timestamp */
  get nextTriageAt(): number {
    return this.lastTriageAt + this.tier2IntervalMs;
  }

  /** Get the proactive configuration */
  getConfig(): ProactiveConfig {
    return this.config;
  }
}
