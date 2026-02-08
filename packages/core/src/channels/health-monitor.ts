/**
 * HealthMonitor - periodic health checks and circuit breaker for channel adapters.
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
    const attempt = Math.max(0, this._failureCount - 1);
    const exponential = this.config.baseBackoffMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.config.maxBackoffMs);
    // Full jitter: random value between 0 and capped
    return Math.random() * capped;
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
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 15_000,
  circuitBreaker: DEFAULT_CIRCUIT_CONFIG,
};

type HealthListener = (results: ReadonlyMap<ChannelName, HealthCheckResult>) => void;

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
  private readonly checking = new Set<ChannelName>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_MONITOR_CONFIG, ...config };
  }

  /** Register an adapter for health monitoring */
  addAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.breakers.set(adapter.id, new CircuitBreaker(this.config.circuitBreaker));
  }

  /** Remove an adapter from monitoring */
  removeAdapter(id: ChannelName): void {
    this.adapters.delete(id);
    this.breakers.delete(id);
  }

  /** Get the circuit breaker for a specific channel */
  getBreaker(id: ChannelName): CircuitBreaker | undefined {
    return this.breakers.get(id);
  }

  /** Start periodic health checks */
  start(): void {
    if (this.timer) return;
    // Run an initial check immediately
    void this.check();
    this.timer = setInterval(() => void this.check(), this.config.checkIntervalMs);
  }

  /** Stop periodic health checks */
  stop(): void {
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
          } else if (status.state === "error" || status.failureCount > 0) {
            breaker.recordFailure();
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
          results.set(id, {
            channelId: id,
            status: { state: "error", failureCount: breaker.state.failureCount },
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

    return results;
  }

  /** Subscribe to health check results */
  onCheck(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
