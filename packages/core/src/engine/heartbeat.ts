import { EventEmitter } from "node:events";
import pino from "pino";
import type { SessionStore } from "./session-store.js";
import type { ScheduleFireEvent, ScheduleStore } from "../mcp/tools/schedule.js";
import type { ChannelRegistry } from "../channels/registry.js";

const log = pino({ name: "heartbeat" });

/**
 * Default heartbeat interval: 10 seconds.
 */
const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Maximum retry attempts before a failed delivery is dropped.
 */
const MAX_RETRY_ATTEMPTS = 5;

/**
 * Base backoff delay for retries in milliseconds.
 */
const BASE_BACKOFF_MS = 2_000;

/**
 * A failed message delivery queued for retry.
 */
export interface FailedDelivery {
  /** Unique identifier for this delivery attempt */
  id: string;
  /** Target channel */
  channel: string;
  /** Target chat ID */
  chatId: string;
  /** Message text to deliver */
  text: string;
  /** Thread ID if applicable */
  threadId?: string;
  /** Number of retry attempts so far */
  attempts: number;
  /** Timestamp of the next retry (ms since epoch) */
  nextRetryAt: number;
  /** Original error that caused the failure */
  lastError: string;
}

/**
 * Event emitted on each heartbeat tick for plugin/hook extensibility.
 */
export interface HeartbeatTickEvent {
  /** Monotonically increasing tick counter */
  tickNumber: number;
  /** Timestamp of this tick (ms since epoch) */
  timestamp: number;
  /** Number of pending delivery retries */
  pendingRetries: number;
  /** Number of schedule events processed this tick */
  scheduleFires: number;
  /** Number of stale sessions pruned this tick */
  sessionsPruned: number;
}

/**
 * Events emitted by the HeartbeatService.
 */
export interface HeartbeatEvents {
  tick: [HeartbeatTickEvent];
  scheduleFired: [ScheduleFireEvent];
  deliveryRetried: [FailedDelivery & { success: boolean }];
  sessionsPruned: [{ count: number; sessionKeys: string[] }];
}

/**
 * Configuration for the HeartbeatService.
 */
export interface HeartbeatConfig {
  /** Tick interval in milliseconds (default: 10000) */
  intervalMs?: number;
}

/**
 * Callback for delivering a scheduled message through the channel system.
 */
export type ScheduleDeliveryFn = (event: ScheduleFireEvent) => Promise<void>;

/**
 * Callback for retrying a failed message delivery.
 */
export type RetryDeliveryFn = (delivery: FailedDelivery) => Promise<void>;

/**
 * HeartbeatService runs a periodic background loop that handles:
 *
 * 1. Processing fired schedule events and routing them to the agent engine
 * 2. Retrying failed message deliveries with exponential backoff
 * 3. Periodically pruning stale sessions from the session store
 * 4. Emitting "tick" events for plugin/hook extensibility
 *
 * Usage:
 *   const heartbeat = new HeartbeatService({ ... });
 *   heartbeat.start();
 *   // ... later ...
 *   heartbeat.stop();
 */
export class HeartbeatService extends EventEmitter<HeartbeatEvents> {
  private readonly intervalMs: number;
  private readonly maxSessionsPerChannel: number;
  private readonly sessionStore: SessionStore;
  private readonly channelRegistry: ChannelRegistry;
  private readonly onScheduleFire: ScheduleDeliveryFn;
  private readonly onRetryDelivery: RetryDeliveryFn;
  private readonly scheduleStore: ScheduleStore | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private tickNumber = 0;
  private pendingScheduleEvents: ScheduleFireEvent[] = [];
  private failedDeliveries: Map<string, FailedDelivery> = new Map();
  private deliveryIdCounter = 0;

  constructor(deps: {
    sessionStore: SessionStore;
    channelRegistry: ChannelRegistry;
    onScheduleFire: ScheduleDeliveryFn;
    onRetryDelivery: RetryDeliveryFn;
    /** Optional ScheduleStore — if provided, the heartbeat will sync new schedules from DB on each tick */
    scheduleStore?: ScheduleStore;
    config?: HeartbeatConfig;
  }) {
    super();
    this.sessionStore = deps.sessionStore;
    this.channelRegistry = deps.channelRegistry;
    this.onScheduleFire = deps.onScheduleFire;
    this.onRetryDelivery = deps.onRetryDelivery;
    this.scheduleStore = deps.scheduleStore ?? null;
    this.intervalMs = deps.config?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxSessionsPerChannel = 500;
  }

  /**
   * Enqueue a schedule fire event to be processed on the next tick.
   * Called by the ScheduleStore's "fire" event listener.
   */
  enqueueScheduleEvent(event: ScheduleFireEvent): void {
    this.pendingScheduleEvents.push(event);
  }

  /**
   * Register a failed delivery for retry with exponential backoff.
   */
  addFailedDelivery(
    channel: string,
    chatId: string,
    text: string,
    error: string,
    threadId?: string,
  ): string {
    this.deliveryIdCounter += 1;
    const id = `retry_${this.deliveryIdCounter}`;
    const delivery: FailedDelivery = {
      id,
      channel,
      chatId,
      text,
      threadId,
      attempts: 0,
      nextRetryAt: Date.now() + BASE_BACKOFF_MS,
      lastError: error,
    };
    this.failedDeliveries.set(id, delivery);
    log.info({ id, channel, chatId }, "queued failed delivery for retry");
    return id;
  }

  /**
   * Start the heartbeat timer.
   */
  start(): void {
    if (this.timer) return;

    log.info({ intervalMs: this.intervalMs }, "heartbeat started");

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Allow the process to exit even if the timer is running
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop the heartbeat timer.
   */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info({ tickNumber: this.tickNumber }, "heartbeat stopped");
  }

  /** Whether the heartbeat is currently running. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Get the number of pending delivery retries. */
  get pendingRetryCount(): number {
    return this.failedDeliveries.size;
  }

  /**
   * Execute a single heartbeat tick. This is the core loop body.
   */
  private async tick(): Promise<void> {
    this.tickNumber += 1;
    const now = Date.now();
    let scheduleFires = 0;
    let sessionsPruned = 0;

    // 1. Process pending schedule events
    const events = this.pendingScheduleEvents.splice(0);
    for (const event of events) {
      try {
        await this.onScheduleFire(event);
        this.emit("scheduleFired", event);
        scheduleFires++;
        log.debug({ schedule: event.name, channel: event.channel }, "schedule event processed");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ schedule: event.name, err }, "schedule delivery failed");
        this.addFailedDelivery(event.channel, event.chatId, event.message, errorMsg);
      }
    }

    // 2. Retry failed deliveries
    for (const [id, delivery] of this.failedDeliveries) {
      if (delivery.nextRetryAt > now) continue;

      delivery.attempts += 1;

      if (delivery.attempts > MAX_RETRY_ATTEMPTS) {
        log.warn({ id, channel: delivery.channel, attempts: delivery.attempts }, "dropping failed delivery after max retries");
        this.failedDeliveries.delete(id);
        this.emit("deliveryRetried", { ...delivery, success: false });
        continue;
      }

      try {
        await this.onRetryDelivery(delivery);
        this.failedDeliveries.delete(id);
        this.emit("deliveryRetried", { ...delivery, success: true });
        log.info({ id, attempts: delivery.attempts }, "retry delivery succeeded");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        delivery.lastError = errorMsg;
        // Exponential backoff with jitter
        const backoff = BASE_BACKOFF_MS * Math.pow(2, delivery.attempts - 1);
        const jitter = Math.random() * backoff * 0.3;
        delivery.nextRetryAt = now + backoff + jitter;
        log.debug(
          { id, attempts: delivery.attempts, nextRetryMs: delivery.nextRetryAt - now },
          "retry delivery failed, backing off",
        );
      }
    }

    // 3. Sync new schedules from DB (picks up schedules created by stdio MCP server)
    if (this.scheduleStore) {
      this.scheduleStore.syncFromDb();
    }

    // 4. Prune stale sessions (every 60 ticks, ~10 minutes at default interval)
    if (this.tickNumber % 60 === 0) {
      sessionsPruned = this.pruneStaleSessionsSync();
    }

    // 5. Emit tick event
    const tickEvent: HeartbeatTickEvent = {
      tickNumber: this.tickNumber,
      timestamp: now,
      pendingRetries: this.failedDeliveries.size,
      scheduleFires,
      sessionsPruned,
    };
    this.emit("tick", tickEvent);
  }

  /**
   * Prune sessions that haven't been updated within the stale threshold.
   *
   * Since the SessionStore's SQLite schema tracks `updated_at`, we query
   * for sessions older than the threshold and delete them.
   */
  private pruneStaleSessionsSync(): number {
    const adapters = this.channelRegistry.getAll();
    const prunedKeys: string[] = [];

    for (const [channelId] of adapters) {
      const keys = this.sessionStore.listByChannel(channelId);
      // Limit total session count per channel. Sessions that have been inactive
      // will naturally be overwritten when new messages come in.
      if (keys.length > this.maxSessionsPerChannel) {
        // Prune oldest sessions (keys are returned in insertion order)
        const toRemove = keys.slice(0, keys.length - this.maxSessionsPerChannel);
        for (const key of toRemove) {
          this.sessionStore.delete(key);
          prunedKeys.push(key);
        }
      }
    }

    if (prunedKeys.length > 0) {
      log.info({ count: prunedKeys.length }, "stale sessions pruned");
      this.emit("sessionsPruned", { count: prunedKeys.length, sessionKeys: prunedKeys });
    }

    return prunedKeys.length;
  }
}
