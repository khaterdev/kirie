import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import {
  TaskHealthDetector,
  ChannelHealthDetector,
  SystemHealthDetector,
  TimeAwarenessDetector,
  type DetectorContext,
  type Signal,
  type RunningTaskInfo,
} from "./signals.js";
import { NotificationManager, type NotificationManagerConfig } from "./notifications.js";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
import { TriageRunner } from "./triage.js";
import { ProactiveEngine, type ProactiveEngineDeps } from "./proactive.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelAdapter } from "../channels/adapter.js";
import type { SessionStore } from "./session-store.js";
import type { ProactiveConfig } from "../config/schema.js";
import type { HeartbeatTickEvent } from "./heartbeat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ProactiveConfig for tests */
function createTestConfig(overrides?: Partial<ProactiveConfig>): ProactiveConfig {
  return {
    enabled: true,
    tier2IntervalMinutes: 15,
    tier2Model: "claude-haiku-4-5-20241022",
    tier3Model: "claude-opus-4-6",
    activeHours: {
      start: "08:00",
      end: "02:00",
      timezone: "UTC",
    },
    dailyDigestTime: "09:00",
    heartbeatFile: "/tmp/kirie-test-heartbeat.md",
    ...overrides,
  };
}

/** Create a mock ChannelAdapter */
function createMockAdapter(
  id: string,
  state: "connected" | "disconnected" | "error" | "reconnecting" = "connected",
  failureCount = 0,
  lastError?: string,
): ChannelAdapter {
  return {
    id,
    capabilities: { text: true, markdown: true, typing: true, reactions: false, threads: false, media: false, edit: false },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ state, failureCount, lastError }),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue([{ id: "sent-1", timestamp: Date.now() }]),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChannelAdapter;
}

/** Create a mock ChannelRegistry */
function createMockRegistry(adapters: Map<string, ChannelAdapter> = new Map()): ChannelRegistry {
  return {
    getAll: vi.fn().mockReturnValue(adapters),
    getById: vi.fn().mockImplementation((id: string) => adapters.get(id)),
    register: vi.fn(),
    unregister: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    getRunning: vi.fn().mockReturnValue([]),
    isRunning: vi.fn().mockReturnValue(false),
    size: adapters.size,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as ChannelRegistry;
}

/** Create a mock SessionStore */
function createMockSessionStore(): SessionStore {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    count: vi.fn().mockReturnValue(0),
    listAll: vi.fn().mockReturnValue([]),
    listByChannel: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    transaction: vi.fn((fn: () => unknown) => fn()),
    clear: vi.fn(),
    getRow: vi.fn().mockReturnValue(null),
    createSession: vi.fn(),
    resolveByLabel: vi.fn().mockReturnValue(null),
    setLabel: vi.fn(),
    listByPrefix: vi.fn().mockReturnValue([]),
  } as unknown as SessionStore;
}

/** Create a DetectorContext for tests */
function createDetectorContext(overrides?: Partial<DetectorContext>): DetectorContext {
  return {
    channelRegistry: createMockRegistry(),
    sessionStore: createMockSessionStore(),
    now: Date.now(),
    tickNumber: 1,
    ...overrides,
  };
}

/** Create a HeartbeatTickEvent for tests */
function createTickEvent(overrides?: Partial<HeartbeatTickEvent>): HeartbeatTickEvent {
  return {
    tickNumber: 1,
    timestamp: Date.now(),
    pendingRetries: 0,
    scheduleFires: 0,
    sessionsPruned: 0,
    ...overrides,
  };
}

/** Create ProactiveEngine deps for tests */
function createEngineDeps(overrides?: Partial<ProactiveEngineDeps>): ProactiveEngineDeps {
  return {
    config: createTestConfig(),
    channelRegistry: createMockRegistry(),
    sessionStore: createMockSessionStore(),
    defaultChannel: "telegram",
    defaultChatId: "test-chat-123",
    ...overrides,
  };
}

// ============================================================================
// 1. Signal Detectors Tests
// ============================================================================

describe("Signal Detectors", () => {
  // ---------- TaskHealthDetector ----------
  describe("TaskHealthDetector", () => {
    let detector: TaskHealthDetector;

    beforeEach(() => {
      detector = new TaskHealthDetector();
    });

    it("should detect stuck tasks running > 10 minutes", () => {
      const now = Date.now();
      const stuckTask: RunningTaskInfo = {
        id: "task-1",
        description: "Long-running analysis",
        startedAt: now - 15 * 60 * 1000, // 15 minutes ago
        status: "running",
      };

      const context = createDetectorContext({
        now,
        getRunningTasks: () => [stuckTask],
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("task-stuck");
      expect(signals[0]!.severity).toBe("warning");
      expect(signals[0]!.title).toContain("15min");
      expect(signals[0]!.details).toContain("Long-running analysis");
    });

    it("should not signal for recently started tasks", () => {
      const now = Date.now();
      const recentTask: RunningTaskInfo = {
        id: "task-2",
        description: "Quick task",
        startedAt: now - 2 * 60 * 1000, // 2 minutes ago
        status: "running",
      };

      const context = createDetectorContext({
        now,
        getRunningTasks: () => [recentTask],
      });

      const signals = detector.detect(context);
      expect(signals).toHaveLength(0);
    });

    it("should return empty array when no tasks", () => {
      const context = createDetectorContext({
        getRunningTasks: () => [],
      });

      const signals = detector.detect(context);
      expect(signals).toHaveLength(0);
    });

    it("should return empty array when getRunningTasks is not provided", () => {
      const context = createDetectorContext();
      // getRunningTasks is undefined by default

      const signals = detector.detect(context);
      expect(signals).toHaveLength(0);
    });
  });

  // ---------- ChannelHealthDetector ----------
  describe("ChannelHealthDetector", () => {
    let detector: ChannelHealthDetector;

    beforeEach(() => {
      detector = new ChannelHealthDetector();
    });

    it("should detect channels in error state", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("telegram", createMockAdapter("telegram", "error", 5, "Connection refused"));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("channel-down");
      expect(signals[0]!.severity).toBe("critical");
      expect(signals[0]!.title).toContain("telegram");
      expect(signals[0]!.details).toContain("Connection refused");
    });

    it("should detect disconnected channels", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("discord", createMockAdapter("discord", "disconnected", 2));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("channel-degraded");
      expect(signals[0]!.severity).toBe("warning");
      expect(signals[0]!.title).toContain("disconnected");
    });

    it("should detect reconnecting channels", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("slack", createMockAdapter("slack", "reconnecting", 1));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("channel-degraded");
      expect(signals[0]!.severity).toBe("warning");
    });

    it("should not signal for healthy channels", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("telegram", createMockAdapter("telegram", "connected"));
      adapters.set("discord", createMockAdapter("discord", "connected"));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
      });

      const signals = detector.detect(context);
      expect(signals).toHaveLength(0);
    });

    it("should detect failed deliveries as warning", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("telegram", createMockAdapter("telegram", "connected"));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
        getFailedDeliveryCount: () => 3,
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("delivery-failures");
      expect(signals[0]!.severity).toBe("warning");
    });

    it("should detect high failed deliveries as critical", () => {
      const adapters = new Map<string, ChannelAdapter>();
      adapters.set("telegram", createMockAdapter("telegram", "connected"));

      const context = createDetectorContext({
        channelRegistry: createMockRegistry(adapters),
        getFailedDeliveryCount: () => 10,
      });

      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("delivery-failures");
      expect(signals[0]!.severity).toBe("critical");
    });
  });

  // ---------- SystemHealthDetector ----------
  describe("SystemHealthDetector", () => {
    let detector: SystemHealthDetector;
    let originalMemoryUsage: typeof process.memoryUsage;

    beforeEach(() => {
      detector = new SystemHealthDetector(512);
      originalMemoryUsage = process.memoryUsage;
    });

    afterEach(() => {
      process.memoryUsage = originalMemoryUsage;
    });

    it("should warn when memory usage is high", () => {
      // Mock process.memoryUsage to return high RSS
      process.memoryUsage = vi.fn().mockReturnValue({
        rss: 600 * 1024 * 1024, // 600MB
        heapTotal: 200 * 1024 * 1024,
        heapUsed: 150 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      }) as unknown as typeof process.memoryUsage;

      const context = createDetectorContext();
      const signals = detector.detect(context);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.type).toBe("high-memory");
      expect(signals[0]!.severity).toBe("warning");
      expect(signals[0]!.title).toContain("600MB");
    });

    it("should not signal under normal memory usage", () => {
      process.memoryUsage = vi.fn().mockReturnValue({
        rss: 200 * 1024 * 1024, // 200MB
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 80 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      }) as unknown as typeof process.memoryUsage;

      const context = createDetectorContext();
      const signals = detector.detect(context);

      expect(signals).toHaveLength(0);
    });
  });

  // ---------- TimeAwarenessDetector ----------
  describe("TimeAwarenessDetector", () => {
    let detector: TimeAwarenessDetector;

    it("should trigger daily digest at configured time", () => {
      const config = createTestConfig({
        dailyDigestTime: "09:00",
        activeHours: { start: "08:00", end: "02:00", timezone: "UTC" },
      });
      detector = new TimeAwarenessDetector(config);

      // Set "now" to exactly 09:00 UTC
      const date = new Date("2026-02-08T09:00:00.000Z");

      const context = createDetectorContext({
        now: date.getTime(),
        tickNumber: 100, // well past any cooldown
      });

      const signals = detector.detect(context);

      expect(signals.some((s) => s.type === "daily-digest-time")).toBe(true);
      const digestSignal = signals.find((s) => s.type === "daily-digest-time")!;
      expect(digestSignal.severity).toBe("info");
      expect(digestSignal.title).toBe("Daily digest time");
    });

    it("should trigger late night reminder at active hours end", () => {
      const config = createTestConfig({
        activeHours: { start: "08:00", end: "02:00", timezone: "UTC" },
      });
      detector = new TimeAwarenessDetector(config);

      // Set "now" to 02:05 UTC (within the late-night window)
      const date = new Date("2026-02-08T02:05:00.000Z");

      const context = createDetectorContext({
        now: date.getTime(),
        tickNumber: 500, // well past any cooldown
      });

      const signals = detector.detect(context);

      expect(signals.some((s) => s.type === "late-night")).toBe(true);
      const lateSignal = signals.find((s) => s.type === "late-night")!;
      expect(lateSignal.severity).toBe("info");
      expect(lateSignal.details).toContain("02:00");
    });

    it("should not trigger outside configured times", () => {
      const config = createTestConfig({
        dailyDigestTime: "09:00",
        activeHours: { start: "08:00", end: "02:00", timezone: "UTC" },
      });
      detector = new TimeAwarenessDetector(config);

      // Set "now" to 14:00 UTC — not digest time, not late night
      const date = new Date("2026-02-08T14:00:00.000Z");

      const context = createDetectorContext({
        now: date.getTime(),
        tickNumber: 100,
      });

      const signals = detector.detect(context);
      expect(signals).toHaveLength(0);
    });

    it("should respect cooldown for digest trigger", () => {
      const config = createTestConfig({
        dailyDigestTime: "09:00",
        activeHours: { start: "08:00", end: "02:00", timezone: "UTC" },
      });
      detector = new TimeAwarenessDetector(config);

      const date = new Date("2026-02-08T09:00:00.000Z");

      // First call at tick 100
      const context1 = createDetectorContext({
        now: date.getTime(),
        tickNumber: 100,
      });
      const signals1 = detector.detect(context1);
      expect(signals1.some((s) => s.type === "daily-digest-time")).toBe(true);

      // Second call at tick 105 (within 12-tick cooldown)
      const context2 = createDetectorContext({
        now: date.getTime(),
        tickNumber: 105,
      });
      const signals2 = detector.detect(context2);
      expect(signals2.some((s) => s.type === "daily-digest-time")).toBe(false);
    });
  });
});

// ============================================================================
// 2. Notification Manager Tests
// ============================================================================

describe("NotificationManager", () => {
  let manager: NotificationManager;
  let registry: ChannelRegistry;
  let mockAdapter: ChannelAdapter;

  beforeEach(() => {
    mockAdapter = createMockAdapter("telegram", "connected");
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", mockAdapter);
    registry = createMockRegistry(adapters);

    const config: NotificationManagerConfig = {
      defaultChannel: "telegram",
      defaultChatId: "chat-123",
    };

    manager = new NotificationManager(registry, config);
  });

  it("should send immediate notification via channel adapter", async () => {
    const result = await manager.notifyNow("Hello world!");

    expect(result).toBe(true);
    expect(mockAdapter.sendText).toHaveBeenCalledTimes(1);
    expect(mockAdapter.sendText).toHaveBeenCalledWith({
      ctx: { chatId: "chat-123" },
      text: "Hello world!",
    });
  });

  it("should queue signals for digest", () => {
    const signal: Signal = {
      id: "sig-1",
      type: "test-signal",
      severity: "info",
      title: "Test Signal",
      details: "Details here",
      timestamp: Date.now(),
      source: "test",
    };

    manager.queueForDigest(signal);

    expect(manager.digestQueueSize).toBe(1);
    expect(manager.getDigestQueue()[0]).toBe(signal);
  });

  it("should compile digest into formatted message", async () => {
    const signals: Signal[] = [
      {
        id: "sig-1",
        type: "channel-down",
        severity: "critical",
        title: "Channel telegram is down",
        details: "Connection refused",
        timestamp: Date.now(),
        source: "channel-health",
      },
      {
        id: "sig-2",
        type: "task-stuck",
        severity: "warning",
        title: "Background task stuck (15min)",
        details: "Task doing stuff",
        timestamp: Date.now(),
        source: "task-health",
      },
      {
        id: "sig-3",
        type: "daily-digest-time",
        severity: "info",
        title: "Daily digest time",
        details: "It's 9 AM",
        timestamp: Date.now(),
        source: "time-awareness",
      },
    ];

    for (const sig of signals) {
      manager.queueForDigest(sig);
    }

    const result = await manager.sendDigest();
    expect(result).toBe(true);

    // Check that sendText was called with the formatted digest
    const sendTextCall = (mockAdapter.sendText as Mock).mock.calls[0]![0];
    expect(sendTextCall.text).toContain("Proactive Digest");
    expect(sendTextCall.text).toContain("Critical");
    expect(sendTextCall.text).toContain("Channel telegram is down");
    expect(sendTextCall.text).toContain("Warnings");
    expect(sendTextCall.text).toContain("Background task stuck");
    expect(sendTextCall.text).toContain("Info");
    expect(sendTextCall.text).toContain("3 signals total");
  });

  it("should clear digest queue after sending", async () => {
    const signal: Signal = {
      id: "sig-1",
      type: "test",
      severity: "info",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    manager.queueForDigest(signal);
    expect(manager.digestQueueSize).toBe(1);

    await manager.sendDigest();
    expect(manager.digestQueueSize).toBe(0);
  });

  it("should handle missing channel gracefully", async () => {
    // Create a registry with no adapters
    const emptyRegistry = createMockRegistry(new Map());
    const config: NotificationManagerConfig = {
      defaultChannel: "telegram",
      defaultChatId: "chat-123",
    };

    const emptyManager = new NotificationManager(emptyRegistry, config);
    const result = await emptyManager.notifyNow("Hello");

    expect(result).toBe(false);
  });

  it("should handle sendText errors gracefully", async () => {
    (mockAdapter.sendText as Mock).mockRejectedValueOnce(new Error("Network error"));

    const result = await manager.notifyNow("Hello");
    expect(result).toBe(false);
  });

  it("should not send digest when queue is empty", async () => {
    const result = await manager.sendDigest();

    expect(result).toBe(true);
    expect(mockAdapter.sendText).not.toHaveBeenCalled();
  });

  it("should not clear digest queue when send fails", async () => {
    // Make the adapter's sendText fail
    (mockAdapter.sendText as Mock).mockRejectedValue(new Error("Send failed"));

    const signal: Signal = {
      id: "sig-1",
      type: "test",
      severity: "info",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    manager.queueForDigest(signal);
    const result = await manager.sendDigest();

    expect(result).toBe(false);
    // Queue should still have the signal since send failed
    expect(manager.digestQueueSize).toBe(1);
  });
});

// ============================================================================
// 3. ProactiveEngine Tests
// ============================================================================

describe("ProactiveEngine", () => {
  let engine: ProactiveEngine;
  let mockRegistry: ChannelRegistry;
  let mockAdapter: ChannelAdapter;
  let deps: ProactiveEngineDeps;

  beforeEach(() => {
    mockAdapter = createMockAdapter("telegram", "connected");
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", mockAdapter);
    mockRegistry = createMockRegistry(adapters);

    deps = createEngineDeps({
      channelRegistry: mockRegistry,
    });
    engine = new ProactiveEngine(deps);
  });

  it("should run signal detectors on tick when enabled", () => {
    engine.start();
    expect(engine.isRunning).toBe(true);

    // Create a tick that won't trigger any signals (normal state)
    const event = createTickEvent({ tickNumber: 1, timestamp: Date.now() });
    engine.onTick(event);

    // Engine ran without error (no signals expected with default mocks)
    expect(engine.signalQueueSize).toBe(0);
  });

  it("should not run when disabled (not started)", () => {
    expect(engine.isRunning).toBe(false);

    const signalHandler = vi.fn();
    engine.on("signalDetected", signalHandler);

    const event = createTickEvent();
    engine.onTick(event);

    expect(signalHandler).not.toHaveBeenCalled();
  });

  it("should not run when stopped", () => {
    engine.start();
    engine.stop();
    expect(engine.isRunning).toBe(false);

    const signalHandler = vi.fn();
    engine.on("signalDetected", signalHandler);

    const event = createTickEvent();
    engine.onTick(event);

    expect(signalHandler).not.toHaveBeenCalled();
  });

  it("should queue detected signals and emit signalDetected event", () => {
    // Set up an adapter in disconnected state (warning, not critical)
    const warnAdapter = createMockAdapter("telegram", "disconnected", 2);
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", warnAdapter);
    const warnRegistry = createMockRegistry(adapters);

    const config = createTestConfig({ tier2IntervalMinutes: 999 });
    const warnDeps = createEngineDeps({ config, channelRegistry: warnRegistry });
    const warnEngine = new ProactiveEngine(warnDeps);
    warnEngine.start();

    // Track signals via event since triage may drain the queue async
    const detectedSignals: Signal[] = [];
    warnEngine.on("signalDetected", (signal) => {
      detectedSignals.push(signal);
    });

    const event = createTickEvent({ tickNumber: 1, timestamp: Date.now() });
    warnEngine.onTick(event);

    // Should have detected at least one signal
    expect(detectedSignals.length).toBeGreaterThan(0);
    expect(detectedSignals[0]!.type).toBe("channel-degraded");
  });

  it("should deduplicate identical signals within window", () => {
    // Set up an adapter in disconnected state (warning, not critical)
    const warnAdapter = createMockAdapter("telegram", "disconnected", 2);
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", warnAdapter);
    const warnRegistry = createMockRegistry(adapters);

    const config = createTestConfig({ tier2IntervalMinutes: 999 });
    const warnDeps = createEngineDeps({ config, channelRegistry: warnRegistry });
    const warnEngine = new ProactiveEngine(warnDeps);
    warnEngine.start();

    // Track signals via events (queue may be drained by async triage)
    const detectedSignals: Signal[] = [];
    warnEngine.on("signalDetected", (signal) => {
      detectedSignals.push(signal);
    });

    const now = Date.now();

    // First tick: should detect signal(s)
    warnEngine.onTick(createTickEvent({ tickNumber: 1, timestamp: now }));
    const firstDetectedCount = detectedSignals.length;
    expect(firstDetectedCount).toBeGreaterThan(0);

    // Second tick within dedup window: same condition, should be deduped
    warnEngine.onTick(createTickEvent({ tickNumber: 2, timestamp: now + 10000 }));
    expect(detectedSignals.length).toBe(firstDetectedCount); // no new signals
  });

  it("should allow same signal after dedup window expires", () => {
    // Set up an adapter in error state
    const errorAdapter = createMockAdapter("telegram", "error", 5, "Connection lost");
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", errorAdapter);
    const errorRegistry = createMockRegistry(adapters);

    const errorDeps = createEngineDeps({ channelRegistry: errorRegistry });
    const errorEngine = new ProactiveEngine(errorDeps);
    errorEngine.start();

    const now = Date.now();

    // First tick
    errorEngine.onTick(createTickEvent({ tickNumber: 1, timestamp: now }));
    const firstQueueSize = errorEngine.signalQueueSize;

    // Tick after dedup window expires (5 minutes + 1 second)
    const afterDedup = now + 5 * 60 * 1000 + 1000;
    errorEngine.onTick(createTickEvent({ tickNumber: 50, timestamp: afterDedup }));
    expect(errorEngine.signalQueueSize).toBeGreaterThan(firstQueueSize);
  });

  it("should trigger triage when interval elapsed", async () => {
    engine.start();

    // Set a very short tier2 interval via config
    const shortConfig = createTestConfig({ tier2IntervalMinutes: 0 }); // 0 minutes = immediate
    const shortDeps = createEngineDeps({
      config: shortConfig,
      channelRegistry: mockRegistry,
    });
    const shortEngine = new ProactiveEngine(shortDeps);
    shortEngine.start();

    const triageHandler = vi.fn();
    shortEngine.on("triageCompleted", triageHandler);

    // Tick — should trigger triage because interval is 0
    shortEngine.onTick(createTickEvent({ tickNumber: 1, timestamp: Date.now() }));

    // Give triage a moment to complete (it's async)
    await vi.waitFor(() => {
      expect(triageHandler).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  it("should trigger immediate triage on critical signals", async () => {
    // Set up an adapter in error state (triggers critical signal)
    const errorAdapter = createMockAdapter("telegram", "error", 5, "Connection lost");
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", errorAdapter);
    const errorRegistry = createMockRegistry(adapters);

    // Use large tier2 interval so only the critical signal triggers triage
    const config = createTestConfig({ tier2IntervalMinutes: 999 });
    const critDeps = createEngineDeps({
      config,
      channelRegistry: errorRegistry,
    });
    const critEngine = new ProactiveEngine(critDeps);
    critEngine.start();

    const triageHandler = vi.fn();
    critEngine.on("triageCompleted", triageHandler);

    critEngine.onTick(createTickEvent({ tickNumber: 1, timestamp: Date.now() }));

    // Triage should fire because of critical signal
    await vi.waitFor(() => {
      expect(triageHandler).toHaveBeenCalled();
    }, { timeout: 5000 });
  });

  it("should emit events on signal detection", () => {
    const errorAdapter = createMockAdapter("telegram", "error", 5);
    const adapters = new Map<string, ChannelAdapter>();
    adapters.set("telegram", errorAdapter);
    const errorRegistry = createMockRegistry(adapters);

    const errorDeps = createEngineDeps({ channelRegistry: errorRegistry });
    const errorEngine = new ProactiveEngine(errorDeps);
    errorEngine.start();

    const signalHandler = vi.fn();
    errorEngine.on("signalDetected", signalHandler);

    errorEngine.onTick(createTickEvent({ tickNumber: 1, timestamp: Date.now() }));

    expect(signalHandler).toHaveBeenCalled();
    const emittedSignal: Signal = signalHandler.mock.calls[0]![0];
    expect(emittedSignal).toHaveProperty("type");
    expect(emittedSignal).toHaveProperty("severity");
    expect(emittedSignal).toHaveProperty("title");
  });

  it("should process triage decisions correctly via runTriage", async () => {
    // This test calls runTriage directly
    // Without ANTHROPIC_API_KEY, it should return without calling LLM
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await engine.runTriage();
      expect(result).toHaveProperty("signalsProcessed");
      expect(result).toHaveProperty("decisions");
      expect(result.decisions).toEqual([]);
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("should expose accessors for engine state", () => {
    expect(engine.isRunning).toBe(false);
    expect(engine.signalQueueSize).toBe(0);
    expect(engine.lastTriageTimestamp).toBe(0);
    expect(engine.dedupCacheSize).toBe(0);
    expect(engine.notifications).toBeInstanceOf(NotificationManager);
    expect(typeof engine.nextTriageAt).toBe("number");
  });
});

// ============================================================================
// 4. Triage Runner Tests
// ============================================================================

/** Create a mock async generator that yields SDKMessage objects for the given text */
function mockQueryStream(text: string) {
  return async function* () {
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    };
    yield {
      type: "result",
      subtype: "success",
      result: text,
    };
  };
}

describe("TriageRunner", () => {
  let runner: TriageRunner;
  const mockedQuery = mockQueryFn as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new TriageRunner(createTestConfig());
  });

  it("should skip LLM call when no signals and no checklist", async () => {
    const result = await runner.triage([]);

    expect(result.llmCalled).toBe(false);
    expect(result.signalsProcessed).toBe(0);
    expect(result.decisions).toEqual([]);
  });

  it("should skip LLM call when query() throws (e.g. no auth)", async () => {
    mockedQuery.mockReturnValue(
      (async function* () {
        throw new Error("No API key or Claude Code session");
      })(),
    );

    const signal: Signal = {
      id: "sig-1",
      type: "test",
      severity: "warning",
      title: "Test Signal",
      details: "Details",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(false);
    expect(result.signalsProcessed).toBe(1);
  });

  it("should skip LLM call when HEARTBEAT.md does not exist and no signals", async () => {
    const config = createTestConfig({
      heartbeatFile: "/tmp/kirie-test-nonexistent-heartbeat.md",
    });
    const noFileRunner = new TriageRunner(config);

    const result = await noFileRunner.triage([]);

    expect(result.llmCalled).toBe(false);
    expect(result.decisions).toEqual([]);
  });

  it("should call LLM with proper prompt when signals exist", async () => {
    const responseJson = JSON.stringify([
      { action: "notify-now", message: "Alert: Test signal detected", signalId: "sig-1" },
    ]);
    mockedQuery.mockReturnValue(mockQueryStream(responseJson)());

    const signal: Signal = {
      id: "sig-1",
      type: "test-alert",
      severity: "critical",
      title: "Critical Test Signal",
      details: "Something is critically wrong",
      timestamp: Date.now(),
      source: "test-detector",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(true);
    expect(result.signalsProcessed).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe("notify-now");
    expect(result.decisions[0]!.message).toBe("Alert: Test signal detected");

    // Verify query was called with correct model
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const queryArgs = mockedQuery.mock.calls[0]![0];
    expect(queryArgs.options.model).toBe("claude-haiku-4-5-20241022");
    expect(queryArgs.prompt).toContain("Critical Test Signal");
    expect(queryArgs.prompt).toContain("CRITICAL");
  });

  it("should parse valid JSON triage response", async () => {
    const responseJson = JSON.stringify([
      { action: "notify-now", message: "Urgent!", signalId: "s1" },
      { action: "queue-digest", message: "FYI", signalId: "s2" },
      { action: "silent" },
    ]);
    mockedQuery.mockReturnValue(mockQueryStream(responseJson)());

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "test",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.decisions).toHaveLength(3);
    expect(result.decisions[0]!.action).toBe("notify-now");
    expect(result.decisions[1]!.action).toBe("queue-digest");
    expect(result.decisions[2]!.action).toBe("silent");
  });

  it("should handle markdown-wrapped JSON in LLM response", async () => {
    mockedQuery.mockReturnValue(
      mockQueryStream('```json\n[{"action": "notify-now", "message": "Alert!"}]\n```')(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe("notify-now");
  });

  it("should handle malformed LLM response gracefully", async () => {
    mockedQuery.mockReturnValue(
      mockQueryStream("This is not valid JSON at all!")(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(true);
    expect(result.decisions).toEqual([]);
  });

  it("should handle non-array JSON response gracefully", async () => {
    mockedQuery.mockReturnValue(
      mockQueryStream('{"action": "notify-now", "message": "not an array"}')(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.decisions).toEqual([]);
  });

  it("should handle LLM errors gracefully", async () => {
    mockedQuery.mockReturnValue(
      (async function* () {
        throw new Error("SDK connection failed");
      })(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(false);
    expect(result.decisions).toEqual([]);
  });

  it("should handle SDK network errors gracefully", async () => {
    mockedQuery.mockReturnValue(
      (async function* () {
        throw new Error("Network unreachable");
      })(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(false);
    expect(result.decisions).toEqual([]);
  });

  it("should filter out invalid actions from LLM response", async () => {
    const responseJson = JSON.stringify([
      { action: "notify-now", message: "Valid" },
      { action: "invalid-action", message: "Invalid" },
      { action: "queue-digest", message: "Also valid" },
    ]);
    mockedQuery.mockReturnValue(mockQueryStream(responseJson)());

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]!.action).toBe("notify-now");
    expect(result.decisions[1]!.action).toBe("queue-digest");
  });

  it("should handle LLM response with no text content", async () => {
    // Yield only a result with empty text
    mockedQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          message: { content: [{ type: "image", source: {} }] },
        };
        yield { type: "result", subtype: "success", result: "" };
      })(),
    );

    const signal: Signal = {
      id: "s1",
      type: "test",
      severity: "warning",
      title: "Test",
      details: "",
      timestamp: Date.now(),
      source: "test",
    };

    const result = await runner.triage([signal]);

    expect(result.llmCalled).toBe(true);
    expect(result.decisions).toEqual([]);
  });
});
