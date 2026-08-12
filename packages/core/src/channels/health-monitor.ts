/**
 * HealthMonitor - periodic health checks, circuit breaker, and automatic
 * recovery for channel adapters.
 *
 * Circuit breaker states:
 *   CLOSED  - normal operation, requests pass through
 *   OPEN    - failures exceeded threshold, requests are rejected
 *   HALF_OPEN - probe period, one request allowed to test recovery
 *
 * Transitions:
 *   CLOSED -> OPEN: after `failureThreshold` consecutive failures
 *   OPEN -> HALF_OPEN: after `probeIntervalMs` since last failure
 *   HALF_OPEN -> CLOSED: on successful probe
 *   HALF_OPEN -> OPEN: on failed probe
 *
 * Recovery: a channel that reports `error` is handed to the recovery handler
 * (see `setRecoveryHandler`) on an exponential backoff. Without a handler the
 * monitor only observes — a channel knocked offline by a transient failure
 * stays offline until something restarts it by hand.
 */

import type { ChannelAdapter, ChannelStatus } from "./adapter.js";
import type { ChannelName } from "./normalizer.js";

// ---------------------------------------------------------------------------
// Circuit breaker types
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  readonly failureThreshold: number;
  /** How long to wait before probing (ms) */
  readonly probeIntervalMs: number;
  /** Base backoff delay (ms) for exponential backoff with jitter */
  readonly baseBackoffMs: number;
  /** Maximum backoff delay (ms) */
  readonly maxBackoffMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  probeIntervalMs: 30_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random in [0, capped)) rather than the raw exponential: several
 * channels knocked out by the same network blip would otherwise retry in
 * lockstep forever.
 *
 * @param attempt - 0-based attempt number; delay doubles with each one
 * @param baseMs - delay for attempt 0, before jitter
 * @param maxMs - ceiling applied before jitter
 */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(exponential, maxMs);
  return Math.random() * capped;
}

export interface CircuitBreakerState {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly nextProbeAt: number | null;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private _failureCount = 0;
  private _lastFailureAt: number | null = null;
  private _lastSuccessAt: number | null = null;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  get state(): CircuitBreakerState {
    return {
      state: this.currentState(),
      failureCount: this._failureCount,
      lastFailureAt: this._lastFailureAt,
      lastSuccessAt: this._lastSuccessAt,
      nextProbeAt: this.getNextProbeTime(),
    };
  }

  /**
   * Determine the effective state, which may transition OPEN -> HALF_OPEN
   * when the probe interval has elapsed.
   */
  currentState(): CircuitState {
    if (this._state === "open") {
      const nextProbe = this.getNextProbeTime();
      if (nextProbe !== null && Date.now() >= nextProbe) {
        this._state = "half_open";
      }
    }
    return this._state;
  }

  /** Whether the circuit allows a request through */
  canExecute(): boolean {
    const state = this.currentState();
    return state === "closed" || state === "half_open";
  }

  /** Record a successful operation */
  recordSuccess(): void {
    this._failureCount = 0;
    this._lastSuccessAt = Date.now();
    this._state = "closed";
  }

  /** Record a failed operation */
  recordFailure(): void {
    this._failureCount++;
    this._lastFailureAt = Date.now();

    if (this._failureCount >= this.config.failureThreshold) {
      this._state = "open";
    }
  }

  /** Reset the breaker to closed state */
  reset(): void {
    this._state = "closed";
    this._failureCount = 0;
    this._lastFailureAt = null;
    this._lastSuccessAt = null;
  }

  /**
   * Calculate the backoff delay for a reconnection attempt.
   * Uses exponential backoff with full jitter.
   */
  getBackoffMs(): number {
    return exponentialBackoffMs(
      this._failureCount - 1,
      this.config.baseBackoffMs,
      this.config.maxBackoffMs,
    );
  }

  private getNextProbeTime(): number | null {
    if (this._state !== "open" || this._lastFailureAt === null) return null;
    return this._lastFailureAt + this.config.probeIntervalMs;
  }
}

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  readonly channelId: ChannelName;
  readonly status: ChannelStatus;
  readonly circuit: CircuitBreakerState;
  readonly checkedAt: number;
}

export interface HealthMonitorConfig {
  /** Interval between health checks (ms) */
  readonly checkIntervalMs: number;
  /** Circuit breaker configuration applied to all channels */
  readonly circuitBreaker: CircuitBreakerConfig;
  /** Consecutive recovery attempts before giving up on a channel (0 = never give up) */
  readonly maxRecoveryAttempts: number;
  /** Base delay before the first recovery attempt (ms) */
  readonly recoveryBaseBackoffMs: number;
  /** Ceiling on the delay between recovery attempts (ms) */
  readonly recoveryMaxBackoffMs: number;
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 15_000,
  circuitBreaker: DEFAULT_CIRCUIT_CONFIG,
  maxRecoveryAttempts: 0,
  recoveryBaseBackoffMs: 1_000,
  recoveryMaxBackoffMs: 60_000,
};

/**
 * Called when a channel is observed unhealthy and is due for a recovery
 * attempt. Implementations should restart the adapter; throwing is fine and
 * simply schedules a later retry.
 */
export type RecoveryHandler = (id: ChannelName, status: ChannelStatus) => Promise<void>;

/** Per-channel recovery bookkeeping. */
export interface RecoveryState {
  /** Consecutive attempts since the channel was last seen healthy */
  readonly attempts: number;
  /** Earliest time the next attempt may run (ms epoch), 0 if immediately eligible */
  readonly nextAttemptAt: number;
  /** Whether an attempt is currently running */
  readonly inFlight: boolean;
  /** Why the last attempt failed, if it did */
  readonly lastError?: string;
  /** Whether the channel has exhausted `maxRecoveryAttempts` */
  readonly exhausted: boolean;
}

interface MutableRecoveryState {
  attempts: number;
  nextAttemptAt: number;
  inFlight: boolean;
  lastError?: string;
}

type HealthListener = (results: ReadonlyMap<ChannelName, HealthCheckResult>) => void;

/** Emitted after each recovery attempt so callers can log/alert. */
export interface RecoveryEvent {
  readonly channelId: ChannelName;
  /** 1-based attempt number in the current unhealthy streak */
  readonly attempt: number;
  /** Whether the handler completed without throwing */
  readonly ok: boolean;
  /** Handler error message, when `ok` is false */
  readonly error?: string;
  /** Delay scheduled before the next attempt (ms) */
  readonly nextBackoffMs: number;
  /** Whether this was the final attempt allowed by `maxRecoveryAttempts` */
  readonly exhausted: boolean;
}

type RecoveryListener = (event: RecoveryEvent) => void;

/**
 * Monitors channel adapter health and manages circuit breakers.
 *
 * Usage:
 *   const monitor = new HealthMonitor(config);
 *   monitor.addAdapter(telegramAdapter);
 *   monitor.start();
 *   // ... later ...
 *   monitor.stop();
 */
/** Timeout in ms for individual adapter getStatus() calls. */
const STATUS_TIMEOUT_MS = 5_000;

export class HealthMonitor {
  private readonly adapters = new Map<ChannelName, ChannelAdapter>();
  private readonly breakers = new Map<ChannelName, CircuitBreaker>();
  private readonly config: HealthMonitorConfig;
  private readonly listeners = new Set<HealthListener>();
  private readonly recoveryListeners = new Set<RecoveryListener>();
  private readonly checking = new Set<ChannelName>();
  private readonly recovery = new Map<ChannelName, MutableRecoveryState>();
  private recoveryHandler: RecoveryHandler | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config };
  }

  /** Register an adapter for health monitoring */
  addAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.breakers.set(adapter.id, new CircuitBreaker(this.config.circuitBreaker));
    this.recovery.set(adapter.id, { attempts: 0, nextAttemptAt: 0, inFlight: false });
  }

  /** Remove an adapter from monitoring */
  removeAdapter(id: ChannelName): void {
    this.adapters.delete(id);
    this.breakers.delete(id);
    this.recovery.delete(id);
  }

  /**
   * Install the handler used to bring an unhealthy channel back up.
   * Recovery is entirely inert until one is set.
   */
  setRecoveryHandler(handler: RecoveryHandler | null): void {
    this.recoveryHandler = handler;
  }

  /** Get the circuit breaker for a specific channel */
  getBreaker(id: ChannelName): CircuitBreaker | undefined {
    return this.breakers.get(id);
  }

  /** Start periodic health checks */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Run an initial check immediately
    void this.check();
    this.timer = setInterval(() => void this.check(), this.config.checkIntervalMs);
  }

  /**
   * Stop periodic health checks.
   *
   * Also blocks recovery from an already-dispatched check, so shutting the
   * monitor down before the channels cannot resurrect one mid-teardown.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single health check cycle across all registered adapters */
  async check(): Promise<ReadonlyMap<ChannelName, HealthCheckResult>> {
    const results = new Map<ChannelName, HealthCheckResult>();
    const now = Date.now();

    const checkPromises: Promise<void>[] = [];
    const recoveryTargets: Array<[ChannelName, ChannelStatus]> = [];

    for (const [id, adapter] of this.adapters) {
      const breaker = this.breakers.get(id);
      if (!breaker) continue;

      // Skip channels already being checked to prevent accumulation
      if (this.checking.has(id)) continue;

      this.checking.add(id);

      const checkOne = async (): Promise<void> => {
        try {
          // Wrap getStatus() in a timeout to prevent slow adapters from blocking
          const status = await Promise.race([
            Promise.resolve(adapter.getStatus()),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Health check timed out")), STATUS_TIMEOUT_MS),
            ),
          ]);

          const isHealthy = status.state === "connected" && status.failureCount === 0;

          if (isHealthy) {
            breaker.recordSuccess();
            this.resetRecovery(id);
          } else if (status.state === "error" || status.failureCount > 0) {
            breaker.recordFailure();
          }

          // Only "error" is recoverable. "disconnected" is also the state of a
          // channel someone stopped on purpose, and resurrecting that would
          // fight the operator; "connecting"/"reconnecting" are already in
          // progress and must be left alone.
          if (status.state === "error") {
            recoveryTargets.push([id, status]);
          }

          results.set(id, {
            channelId: id,
            status,
            circuit: breaker.state,
            checkedAt: now,
          });
        } catch {
          // Timeout or error — treat as failure
          breaker.recordFailure();
          const status: ChannelStatus = { state: "error", failureCount: breaker.state.failureCount };
          recoveryTargets.push([id, status]);
          results.set(id, {
            channelId: id,
            status,
            circuit: breaker.state,
            checkedAt: now,
          });
        } finally {
          this.checking.delete(id);
        }
      };

      checkPromises.push(checkOne());
    }

    await Promise.all(checkPromises);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(results);
      } catch {
        // Swallow listener errors
      }
    }

    // Recovery runs after listeners so observers see the unhealthy state that
    // triggered it. Not awaited: a slow adapter restart must not stall the
    // check cycle, and `inFlight` already prevents overlapping attempts.
    for (const [id, status] of recoveryTargets) {
      void this.attemptRecovery(id, status);
    }

    return results;
  }

  /** Subscribe to health check results */
  onCheck(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to recovery attempts */
  onRecovery(listener: RecoveryListener): () => void {
    this.recoveryListeners.add(listener);
    return () => {
      this.recoveryListeners.delete(listener);
    };
  }

  /** Current recovery bookkeeping for a channel, if it is monitored */
  getRecoveryState(id: ChannelName): RecoveryState | undefined {
    const st = this.recovery.get(id);
    if (!st) return undefined;
    return {
      attempts: st.attempts,
      nextAttemptAt: st.nextAttemptAt,
      inFlight: st.inFlight,
      lastError: st.lastError,
      exhausted: this.isExhausted(st),
    };
  }

  /**
   * Run one recovery attempt for a channel, if it is due.
   *
   * Attempt N is spaced by exponential backoff from the last one, and the
   * counter only resets when a check observes the channel healthy again — so a
   * channel that keeps failing backs off instead of being hammered every tick.
   */
  private async attemptRecovery(id: ChannelName, status: ChannelStatus): Promise<void> {
    const handler = this.recoveryHandler;
    if (!handler || this.stopped) return;

    const st = this.recovery.get(id);
    if (!st) return;
    if (st.inFlight) return;
    if (this.isExhausted(st)) return;
    if (Date.now() < st.nextAttemptAt) return;

    st.inFlight = true;
    st.attempts++;

    // Schedule the next window before awaiting: if the handler hangs, the
    // channel must not become eligible again the instant it settles.
    const nextBackoffMs = exponentialBackoffMs(
      st.attempts - 1,
      this.config.recoveryBaseBackoffMs,
      this.config.recoveryMaxBackoffMs,
    );
    st.nextAttemptAt = Date.now() + nextBackoffMs;

    let ok = false;
    let error: string | undefined;
    try {
      await handler(id, status);
      ok = true;
      st.lastError = undefined;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      st.lastError = error;
    } finally {
      st.inFlight = false;
    }

    this.emitRecovery({
      channelId: id,
      attempt: st.attempts,
      ok,
      error,
      nextBackoffMs,
      exhausted: this.isExhausted(st),
    });
  }

  private isExhausted(st: MutableRecoveryState): boolean {
    const max = this.config.maxRecoveryAttempts;
    return max > 0 && st.attempts >= max;
  }

  /**
   * Clear the backoff for a channel that is healthy again, so a future outage
   * starts retrying promptly instead of inheriting an old backoff.
   */
  private resetRecovery(id: ChannelName): void {
    const st = this.recovery.get(id);
    if (!st || st.inFlight) return;
    st.attempts = 0;
    st.nextAttemptAt = 0;
    st.lastError = undefined;
  }

  private emitRecovery(event: RecoveryEvent): void {
    for (const listener of [...this.recoveryListeners]) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors
      }
    }
  }

  /** Get a snapshot of all circuit breaker states */
  getSnapshot(): ReadonlyMap<ChannelName, CircuitBreakerState> {
    const snapshot = new Map<ChannelName, CircuitBreakerState>();
    for (const [id, breaker] of this.breakers) {
      snapshot.set(id, breaker.state);
    }
    return snapshot;
  }
}
