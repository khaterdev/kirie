import { join } from "node:path";
import {
  LoopStore,
  applyHeartbeatOverrides,
  createHeartbeatCommands,
  createModuleLogger,
  resolveHeartbeatChecklistPath,
} from "@kirie/core";
import type { FeatureSetup } from "./types.js";

const log = createModuleLogger("feature-heartbeat-control");

/**
 * /heartbeat control of the proactive layer (item 8, PLAN C.8, DECISIONS 3).
 *
 * Setup applies the persisted interval and snooze overrides to the engine
 * (lifecycle already applied `proactive.enabled` when it decided whether to
 * start it) and registers `/heartbeat` (alias `/hb`).
 *
 * The agent's proactive_status and proactive_trigger tools and the gateway's
 * /api/proactive routes hold the same engine (lifecycle.ts), so `/heartbeat on`
 * reaches them at once.
 */
export const setupHeartbeatControl: FeatureSetup = (ctx) => {
  const proactive = ctx.proactive;
  if (proactive) {
    try {
      applyHeartbeatOverrides(proactive, ctx.settings);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat overrides not applied");
    }
  }

  // A read connection for the loop count in /heartbeat status, opened on first use.
  let loopStore: LoopStore | null = null;
  const countActiveLoops = (): number => {
    loopStore ??= new LoopStore(join(ctx.dataDir, "loops.db"));
    return loopStore.count("active");
  };

  ctx.commands.registerAll(createHeartbeatCommands({
    proactive,
    settings: ctx.settings,
    config: ctx.config.proactive,
    checklistPath: resolveHeartbeatChecklistPath(ctx.config.proactive.heartbeatFile),
    logs: ctx.heartbeatLogStore,
    countActiveLoops,
    countSchedules: () => ctx.scheduleStore.list().length,
    timezone: ctx.config.proactive.activeHours.timezone,
  }));

  return {
    name: "heartbeat-control",
    stop() {
      loopStore?.close();
      loopStore = null;
    },
  };
};
