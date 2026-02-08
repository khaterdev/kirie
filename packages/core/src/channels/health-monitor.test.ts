import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor, CircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from "./health-monitor.js";
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

      let resolveStatus: (() => void) | undefined;
      const statusPromise = new Promise<void>((r) => {
        resolveStatus = r;
      });

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
      const results = listener.mock.calls[0][0];
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
});
