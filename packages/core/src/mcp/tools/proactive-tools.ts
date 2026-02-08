/**
 * MCP tool handlers for the Proactive Intelligence Layer.
 *
 * Provides status introspection and manual triage triggering
 * through the standard Kirie MCP tool interface.
 */

import type { ProactiveEngine } from "../../engine/proactive.js";

/**
 * Create MCP tool handlers for the proactive engine.
 *
 * @param engine - The ProactiveEngine instance (or null if proactive is disabled)
 */
export function createProactiveToolHandlers(engine: ProactiveEngine | null) {
  return {
    proactive_status: {
      description:
        "Get the status of the Proactive Intelligence Layer, including whether it's running, " +
        "signal queue size, last triage time, next triage time, digest queue size, and dedup cache size.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler() {
        if (!engine) {
          return {
            enabled: false,
            running: false,
            signalQueueSize: 0,
            lastTriageAt: 0,
            nextTriageAt: 0,
            digestQueueSize: 0,
            dedupCacheSize: 0,
            notifiedTypesCacheSize: 0,
          };
        }

        return {
          enabled: true,
          running: engine.isRunning,
          signalQueueSize: engine.signalQueueSize,
          lastTriageAt: engine.lastTriageTimestamp,
          nextTriageAt: engine.nextTriageAt,
          digestQueueSize: engine.notifications.digestQueueSize,
          dedupCacheSize: engine.dedupCacheSize,
          notifiedTypesCacheSize: engine.notifiedTypesCacheSize,
        };
      },
    },

    proactive_trigger: {
      description:
        "Force an immediate triage cycle. Runs all signal detectors and the triage LLM immediately, " +
        "regardless of the normal schedule. Returns the number of signals processed and decisions made.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      async handler() {
        if (!engine) {
          return { triggered: false, error: "Proactive engine is not enabled" };
        }

        if (!engine.isRunning) {
          return { triggered: false, error: "Proactive engine is not running" };
        }

        const result = await engine.runTriage();
        return {
          triggered: true,
          signalsProcessed: result.signalsProcessed,
          decisions: result.decisions.length,
        };
      },
    },
  };
}
