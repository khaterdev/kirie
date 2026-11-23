/**
 * The agent's proactive tools and the gateway routes hold the engine even when
 * it was off at boot, so `/heartbeat on` reaches them without a restart. While
 * the engine is stopped both trigger paths refuse.
 */
import { describe, it, expect, vi } from "vitest";
import { createProactiveToolHandlers } from "./proactive-tools.js";
import { createRoutes } from "../../gateway/routes.js";
import { ChannelRegistry } from "../../channels/registry.js";
import type { ProactiveEngine } from "../../engine/proactive.js";
import type { SessionStore } from "../../engine/session-store.js";

function fakeEngine() {
  const state = { running: false };
  const engine = {
    get isRunning() { return state.running; },
    signalQueueSize: 0,
    lastTriageTimestamp: 0,
    nextTriageAt: 0,
    notifications: { digestQueueSize: 0 },
    dedupCacheSize: 0,
    notifiedTypesCacheSize: 0,
    start: () => { state.running = true; },
    stop: () => { state.running = false; },
    runTriage: vi.fn(async () => ({ signalsProcessed: 2, decisions: [{}] })),
  };
  return engine;
}

describe("proactive tools see an engine started after boot", () => {
  it("in-process tools: refused while stopped, live once started, no new registry needed", async () => {
    const engine = fakeEngine();
    const tools = createProactiveToolHandlers(engine as unknown as ProactiveEngine);
    expect(tools.proactive_status.handler()).toMatchObject({ enabled: false, running: false });
    expect(await tools.proactive_trigger.handler()).toEqual({ triggered: false, error: "Proactive engine is not running" });
    expect(engine.runTriage).not.toHaveBeenCalled();

    engine.start(); // what /heartbeat on does
    expect(tools.proactive_status.handler()).toMatchObject({ enabled: true, running: true });
    expect(await tools.proactive_trigger.handler()).toEqual({ triggered: true, signalsProcessed: 2, decisions: 1 });

    engine.stop(); // /heartbeat off
    expect(await tools.proactive_trigger.handler()).toMatchObject({ triggered: false });
  });

  it("gateway routes (used by the stdio tools): the same", async () => {
    const engine = fakeEngine();
    const app = createRoutes({
      channelRegistry: new ChannelRegistry(),
      sessionStore: {} as SessionStore,
      onConfigReload: vi.fn(async () => {}),
      onShutdown: vi.fn(),
      onRestart: vi.fn(),
      proactiveEngine: engine as unknown as ProactiveEngine,
    });
    const status = async () => (await app.request("/api/proactive/status")).json() as Promise<Record<string, unknown>>;
    const trigger = async () => (await app.request("/api/proactive/trigger", { method: "POST" })).json() as Promise<Record<string, unknown>>;
    expect(await status()).toMatchObject({ enabled: false, running: false });
    expect(await trigger()).toEqual({ triggered: false, error: "Proactive engine is not running" });
    engine.start();
    expect(await status()).toMatchObject({ enabled: true, running: true });
    expect(await trigger()).toMatchObject({ triggered: true, signalsProcessed: 2 });
  });

  it("with no engine at all (no owner configured) both still report not enabled", async () => {
    const tools = createProactiveToolHandlers(null);
    expect(tools.proactive_status.handler()).toMatchObject({ enabled: false });
    expect(await tools.proactive_trigger.handler()).toEqual({ triggered: false, error: "Proactive engine is not enabled" });
  });
});
