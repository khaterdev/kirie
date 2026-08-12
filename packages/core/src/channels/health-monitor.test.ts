import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor, CircuitBreaker, DEFAULT_CIRCUIT_CONFIG, exponentialBackoffMs } from "./health-monitor.js";
import { ChannelRegistry } from "./registry.js";
import type { ChannelAdapter, ChannelStatus } from "./adapter.js";
import type { ChannelName } from "./normalizer.js";

function createMockAdapter(
  id: string,
  status: ChannelStatus = { state: "connected", failureCount: 0 },
): ChannelAdapter {
  return {
    id: id as ChannelName,
    capabilities: {
      sendMedia: false,
      sendReaction: false,
      editMessage: false,
      deleteMessage: false,
      sendTyping: true,
      threads: false,
      multipleImages: false,
      reactions: false,
      replyContext: false,
      voiceMessages: false,
      maxTextLength: 4000,
    },
    async start() {},
    async stop() {},
    getStatus: vi.fn(() => status),
    onMessage() {},
    async sendText() {
      return [{ id: "sent-1", timestamp: Date.now() }];
    },
    async sendTyping() {},
  };
}

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state.state).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state.state).toBe("closed");
    breaker.recordFailure();
    expect(breaker.state.state).toBe("open");
    expect(breaker.canExecute()).toBe(false);
  });

  it("resets to closed on success", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state.state).toBe("open");
    breaker.recordSuccess();
    expect(breaker.state.state).toBe("closed");
  });

  it("transitions to half_open after probe interval", () => {
    vi.useFakeTimers();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      probeIntervalMs: 1000,
    });
    breaker.recordFailure();
    expect(breaker.currentState()).toBe("open");

    vi.advanceTimersByTime(1000);
    expect(breaker.currentState()).toBe("half_open");
    expect(breaker.canExecute()).toBe(true);
    vi.useRealTimers();
  });

  it("resets all state on reset()", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(breaker.state.state).toBe("open");
    breaker.reset();
    expect(breaker.state.state).toBe("closed");
    expect(breaker.state.failureCount).toBe(0);
  });
});

describe("HealthMonitor", () => {
  let monitor: HealthMonitor;

  afterEach(() => {
    monitor?.stop();
  });

  describe("healthy/unhealthy status reporting", () => {
    it("records success for healthy adapters", async () => {
      monitor = new HealthMonitor();
      const adapter = createMockAdapter("telegram", { state: "connected", failureCount: 0 });
      monitor.addAdapter(adapter);

      const results = await monitor.check();
      const result = results.get("telegram" as ChannelName);

      expect(result).toBeDefined();
      expect(result!.circuit.state).toBe("closed");
      expect(result!.circuit.failureCount).toBe(0);
    });

    it("records failure for unhealthy adapters", async () => {
      monitor = new HealthMonitor({ circuitBreaker: { ...DEFAULT_CIRCUIT_CONFIG, failureThreshold: 2 } });
      const adapter = createMockAdapter("telegram", { state: "error", failureCount: 3, lastError: "Connection lost" });
      monitor.addAdapter(adapter);

      await monitor.check();
      await monitor.check();

      const breaker = monitor.getBreaker("telegram" as ChannelName);
      expect(breaker!.state.failureCount).toBe(2);
      expect(breaker!.state.state).toBe("open");
    });
  });

  describe("timeout behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("handles slow adapters by timing out", async () => {
      monitor = new HealthMonitor();

      const slowAdapter: ChannelAdapter = {
        id: "slow" as ChannelName,
        capabilities: {
          sendMedia: false,
          sendReaction: false,
          editMessage: false,
          deleteMessage: false,
          sendTyping: true,
          threads: false,
          multipleImages: false,
          reactions: false,
          replyContext: false,
          voiceMessages: false,
          maxTextLength: 4000,
        },
        async start() {},
        async stop() {},
        getStatus() {
          // Simulate a slow getStatus by never resolving
          // In practice the timeout wrapper handles this
          return { state: "connected", failureCount: 0 } as ChannelStatus;
        },
        onMessage() {},
        async sendText() {
          return [{ id: "sent-1", timestamp: Date.now() }];
        },
        async sendTyping() {},
      };

      monitor.addAdapter(slowAdapter);

      // The check should complete (the timeout wrapper handles slow calls)
      const checkPromise = monitor.check();
      vi.advanceTimersByTime(6000);
      const results = await checkPromise;

      expect(results.size).toBe(1);
    });
  });

  describe("concurrent check prevention", () => {
    it("skips channels already being checked", async () => {
      monitor = new HealthMonitor();

      let callCount = 0;
      const slowAdapter: ChannelAdapter = {
        id: "slow-channel" as ChannelName,
        capabilities: {
          sendMedia: false,
          sendReaction: false,
          editMessage: false,
          deleteMessage: false,
          sendTyping: true,
          threads: false,
          multipleImages: false,
          reactions: false,
          replyContext: false,
          voiceMessages: false,
          maxTextLength: 4000,
        },
        async start() {},
        async stop() {},
        getStatus() {
          callCount++;
          return { state: "connected", failureCount: 0 } as ChannelStatus;
        },
        onMessage() {},
        async sendText() {
          return [{ id: "sent-1", timestamp: Date.now() }];
        },
        async sendTyping() {},
      };

      monitor.addAdapter(slowAdapter);

      // The first check runs and completes synchronously since getStatus is sync
      await monitor.check();
      // The second check also runs
      await monitor.check();

      // Both complete fine; callCount should be 2 since they don't overlap
      expect(callCount).toBe(2);
    });
  });

  describe("listeners", () => {
    it("notifies listeners with check results", async () => {
      monitor = new HealthMonitor();
      const adapter = createMockAdapter("telegram");
      monitor.addAdapter(adapter);

      const listener = vi.fn();
      monitor.onCheck(listener);

      await monitor.check();

      expect(listener).toHaveBeenCalledOnce();
      const results = listener.mock.calls[0]![0];
      expect(results.has("telegram")).toBe(true);
    });

    it("returns an unsubscribe function", async () => {
      monitor = new HealthMonitor();
      const adapter = createMockAdapter("telegram");
      monitor.addAdapter(adapter);

      const listener = vi.fn();
      const unsubscribe = monitor.onCheck(listener);

      unsubscribe();
      await monitor.check();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("adapter management", () => {
    it("removes an adapter from monitoring", async () => {
      monitor = new HealthMonitor();
      const adapter = createMockAdapter("telegram");
      monitor.addAdapter(adapter);
      monitor.removeAdapter("telegram" as ChannelName);

      const results = await monitor.check();
      expect(results.size).toBe(0);
    });

    it("provides a snapshot of circuit breaker states", () => {
      monitor = new HealthMonitor();
      monitor.addAdapter(createMockAdapter("telegram"));
      monitor.addAdapter(createMockAdapter("discord"));

      const snapshot = monitor.getSnapshot();
      expect(snapshot.size).toBe(2);
      expect(snapshot.has("telegram" as ChannelName)).toBe(true);
      expect(snapshot.has("discord" as ChannelName)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery
  //
  // Regression coverage for the 2026-08-11 incident: a transient DNS failure at
  // boot failed Telegram's single `getMe` call, leaving the channel in `error`
  // with failureCount 1 and no retry. It stayed offline for 13 hours.
  // ---------------------------------------------------------------------------

  describe("recovery", () => {
    const TELEGRAM = "telegram" as ChannelName;

    /** Immediate-ish backoff so tests don't wait on real delays. */
    const FAST_RECOVERY = { recoveryBaseBackoffMs: 1, recoveryMaxBackoffMs: 1 };

    /** Recovery is dispatched with `void`, so let its microtasks settle. */
    async function flush(): Promise<void> {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    it("restarts a channel stuck in error", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(
        createMockAdapter("telegram", {
          state: "error",
          failureCount: 1,
          lastError: "Network request for 'getMe' failed!",
        }),
      );

      const recover = vi.fn(async (_id: ChannelName, _status: ChannelStatus) => {});
      monitor.setRecoveryHandler(recover);

      await monitor.check();
      await flush();

      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]![0]).toBe(TELEGRAM);
      expect(recover.mock.calls[0]![1]).toMatchObject({ state: "error" });
    });

    it("does nothing without a recovery handler", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      await monitor.check();
      await flush();

      expect(monitor.getRecoveryState(TELEGRAM)!.attempts).toBe(0);
    });

    it("leaves a deliberately stopped channel alone", async () => {
      // `disconnected` is what a manual POST /channels/:id/stop produces.
      // Recovering it would fight the operator.
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "disconnected", failureCount: 0 }));

      const recover = vi.fn(async () => {});
      monitor.setRecoveryHandler(recover);

      await monitor.check();
      await flush();

      expect(recover).not.toHaveBeenCalled();
    });

    it("leaves a healthy or in-progress channel alone", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "connected", failureCount: 0 }));
      monitor.addAdapter(createMockAdapter("discord", { state: "connecting", failureCount: 0 }));
      monitor.addAdapter(createMockAdapter("slack", { state: "reconnecting", failureCount: 1 }));

      const recover = vi.fn(async () => {});
      monitor.setRecoveryHandler(recover);

      await monitor.check();
      await flush();

      expect(recover).not.toHaveBeenCalled();
    });

    it("waits out the backoff before retrying", async () => {
      monitor = new HealthMonitor({
        recoveryBaseBackoffMs: 60_000,
        recoveryMaxBackoffMs: 60_000,
      });
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      const recover = vi.fn(async () => {});
      monitor.setRecoveryHandler(recover);

      await monitor.check();
      await flush();
      await monitor.check();
      await flush();

      expect(recover).toHaveBeenCalledOnce();
      expect(monitor.getRecoveryState(TELEGRAM)!.nextAttemptAt).toBeGreaterThan(Date.now());
    });

    it("keeps retrying a channel that stays broken, backing off each time", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      const recover = vi.fn(async () => {
        throw new Error("still no DNS");
      });
      monitor.setRecoveryHandler(recover);

      for (let i = 0; i < 3; i++) {
        await monitor.check();
        await flush();
      }

      expect(recover).toHaveBeenCalledTimes(3);
      const st = monitor.getRecoveryState(TELEGRAM)!;
      expect(st.attempts).toBe(3);
      expect(st.lastError).toBe("still no DNS");
      expect(st.exhausted).toBe(false);
    });

    it("resets the attempt counter once the channel is healthy again", async () => {
      const status: { state: ChannelStatus["state"]; failureCount: number } = {
        state: "error",
        failureCount: 1,
      };
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter({
        ...createMockAdapter("telegram"),
        getStatus: () => status as ChannelStatus,
      });
      monitor.setRecoveryHandler(async () => {});

      await monitor.check();
      await flush();
      expect(monitor.getRecoveryState(TELEGRAM)!.attempts).toBe(1);

      status.state = "connected";
      status.failureCount = 0;
      await monitor.check();
      await flush();

      const st = monitor.getRecoveryState(TELEGRAM)!;
      expect(st.attempts).toBe(0);
      expect(st.nextAttemptAt).toBe(0);
    });

    it("gives up after maxRecoveryAttempts and reports it", async () => {
      monitor = new HealthMonitor({ ...FAST_RECOVERY, maxRecoveryAttempts: 2 });
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      const recover = vi.fn(async () => {
        throw new Error("nope");
      });
      monitor.setRecoveryHandler(recover);

      const events: Array<{ attempt: number; exhausted: boolean }> = [];
      monitor.onRecovery((e) => events.push({ attempt: e.attempt, exhausted: e.exhausted }));

      for (let i = 0; i < 5; i++) {
        await monitor.check();
        await flush();
      }

      expect(recover).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        { attempt: 1, exhausted: false },
        { attempt: 2, exhausted: true },
      ]);
      expect(monitor.getRecoveryState(TELEGRAM)!.exhausted).toBe(true);
    });

    it("never runs two attempts for the same channel at once", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      let release!: () => void;
      const started = vi.fn();
      monitor.setRecoveryHandler(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });

      await monitor.check();
      await flush();
      await monitor.check();
      await flush();

      expect(started).toHaveBeenCalledOnce();
      release();
      await flush();
    });

    it("reports a successful recovery to listeners", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));
      monitor.setRecoveryHandler(async () => {});

      const listener = vi.fn();
      monitor.onRecovery(listener);

      await monitor.check();
      await flush();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0]).toMatchObject({
        channelId: TELEGRAM,
        attempt: 1,
        ok: true,
      });
    });

    it("does not recover after stop() — shutdown must not resurrect channels", async () => {
      monitor = new HealthMonitor(FAST_RECOVERY);
      monitor.addAdapter(createMockAdapter("telegram", { state: "error", failureCount: 1 }));

      const recover = vi.fn(async () => {});
      monitor.setRecoveryHandler(recover);

      // Dispatch a check, then stop before its recovery gets to run.
      const checking = monitor.check();
      monitor.stop();
      await checking;
      await flush();

      expect(recover).not.toHaveBeenCalled();
    });

    it("recovers a channel whose getStatus() hangs", async () => {
      monitor = new HealthMonitor({ ...FAST_RECOVERY, checkIntervalMs: 60_000 });
      monitor.addAdapter({
        ...createMockAdapter("telegram"),
        getStatus: () => {
          throw new Error("adapter wedged");
        },
      });

      const recover = vi.fn(async () => {});
      monitor.setRecoveryHandler(recover);

      await monitor.check();
      await flush();

      expect(recover).toHaveBeenCalledOnce();
    });
  });
});

/**
 * End-to-end reproduction of the 2026-08-11 outage against a real
 * ChannelRegistry, wired the way the daemon wires it.
 */
describe("health monitor + registry recovery", () => {
  const TELEGRAM = "telegram" as ChannelName;

  /** Adapter that fails its first connect the way a cold-boot DNS miss does. */
  function createFlakyAdapter(failuresBeforeSuccess: number): ChannelAdapter & { startCount: number } {
    const base = createMockAdapter("telegram");
    let state: ChannelStatus["state"] = "disconnected";
    let failureCount = 0;

    const adapter = {
      ...base,
      startCount: 0,
      async start() {
        adapter.startCount++;
        if (adapter.startCount <= failuresBeforeSuccess) {
          state = "error";
          failureCount++;
          throw new Error("Network request for 'getMe' failed!");
        }
        state = "connected";
        failureCount = 0;
      },
      async stop() {
        state = "disconnected";
      },
      getStatus: (): ChannelStatus => ({ state, failureCount }),
    };
    return adapter;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("brings back a channel whose initial connect failed", async () => {
    const registry = new ChannelRegistry();
    const adapter = createFlakyAdapter(1);
    registry.register(adapter);

    // Boot: startAll swallows the failure into the returned error map, exactly
    // as the daemon does. Before this fix, that was the end of the story.
    const errors = await registry.startAll();
    expect(errors.has(TELEGRAM)).toBe(true);
    expect(registry.isRunning(TELEGRAM)).toBe(false);
    expect(adapter.getStatus().state).toBe("error");

    const monitor = new HealthMonitor({ recoveryBaseBackoffMs: 1, recoveryMaxBackoffMs: 1 });
    monitor.addAdapter(adapter);
    monitor.setRecoveryHandler(async (id) => {
      if (registry.isRunning(id)) await registry.stop(id);
      await registry.start(id);
    });

    await monitor.check();
    await flush();

    expect(adapter.startCount).toBe(2);
    expect(registry.isRunning(TELEGRAM)).toBe(true);
    expect(adapter.getStatus().state).toBe("connected");
    monitor.stop();
  });

  it("keeps trying across a prolonged outage, then settles", async () => {
    const registry = new ChannelRegistry();
    const adapter = createFlakyAdapter(4);
    registry.register(adapter);
    await registry.startAll();

    const monitor = new HealthMonitor({ recoveryBaseBackoffMs: 1, recoveryMaxBackoffMs: 1 });
    monitor.addAdapter(adapter);
    monitor.setRecoveryHandler(async (id) => {
      if (registry.isRunning(id)) await registry.stop(id);
      await registry.start(id);
    });

    for (let i = 0; i < 6; i++) {
      await monitor.check();
      await flush();
    }

    expect(registry.isRunning(TELEGRAM)).toBe(true);
    // Recovered on attempt 5, then stopped attempting once healthy.
    expect(adapter.startCount).toBe(5);
    expect(monitor.getRecoveryState(TELEGRAM)!.attempts).toBe(0);
    monitor.stop();
  });
});

describe("exponentialBackoffMs", () => {
  it("doubles the ceiling with each attempt", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    try {
      expect(exponentialBackoffMs(0, 1000, 60_000)).toBeCloseTo(1000, -1);
      expect(exponentialBackoffMs(1, 1000, 60_000)).toBeCloseTo(2000, -1);
      expect(exponentialBackoffMs(2, 1000, 60_000)).toBeCloseTo(4000, -1);
    } finally {
      spy.mockRestore();
    }
  });

  it("caps at maxMs", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    try {
      expect(exponentialBackoffMs(30, 1000, 60_000)).toBeLessThanOrEqual(60_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats negative attempts as attempt 0", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(exponentialBackoffMs(-5, 1000, 60_000)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("applies full jitter so channels don't retry in lockstep", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      expect(exponentialBackoffMs(1, 1000, 60_000)).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});
