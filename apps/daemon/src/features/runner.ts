/**
 * Runs the feature modules (PLAN B.10): setup in FEATURES order, start in the
 * same order once the core subsystems run, stop in reverse order. A feature
 * whose setup or start throws is logged, reported to the owner once, and
 * skipped; the daemon still starts.
 */

import { createModuleLogger } from "@kirie/core";
import type { DaemonContext, FeatureEntry, FeatureHandle } from "./types.js";

const log = createModuleLogger("daemon-features");

export interface FeatureFailure {
  name: string;
  phase: "setup" | "start" | "stop";
  message: string;
}

export interface FeatureRunHooks {
  /** Told once per failing feature (the daemon sends one owner notice). */
  onFailure?(failure: FeatureFailure): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Phase 1. Returns the handles of the features whose setup succeeded, in order. */
export async function runFeatureSetups(
  features: readonly FeatureEntry[],
  ctx: DaemonContext,
  hooks: FeatureRunHooks = {},
): Promise<FeatureHandle[]> {
  const handles: FeatureHandle[] = [];
  for (const feature of features) {
    try {
      const handle = await feature.setup(ctx);
      handles.push({ ...handle, name: handle?.name || feature.name });
    } catch (err) {
      log.error({ feature: feature.name, err: message(err) }, "feature setup failed; feature skipped");
      hooks.onFailure?.({ name: feature.name, phase: "setup", message: message(err) });
    }
  }
  log.info({ features: handles.map((h) => h.name) }, "features set up");
  return handles;
}

/** Phase 2, after channels, heartbeat and the task manager have started. Returns the handles that started. */
export async function startFeatures(handles: readonly FeatureHandle[], hooks: FeatureRunHooks = {}): Promise<FeatureHandle[]> {
  const started: FeatureHandle[] = [];
  for (const handle of handles) {
    try {
      await handle.start?.();
      started.push(handle);
    } catch (err) {
      log.error({ feature: handle.name, err: message(err) }, "feature start failed; feature skipped");
      hooks.onFailure?.({ name: handle.name, phase: "start", message: message(err) });
      // A feature that failed half-way may hold resources: give it a chance to release them.
      try {
        await handle.stop?.();
      } catch (stopErr) {
        log.warn({ feature: handle.name, err: message(stopErr) }, "feature stop after a failed start also failed");
      }
    }
  }
  return started;
}

/** stopDaemon, first thing: every started feature's stop, in reverse order. Never throws. */
export async function stopFeatures(handles: readonly FeatureHandle[]): Promise<void> {
  for (const handle of [...handles].reverse()) {
    try {
      await handle.stop?.();
    } catch (err) {
      log.warn({ feature: handle.name, err: message(err) }, "feature stop failed");
    }
  }
}
