/**
 * Runs the feature modules (PLAN B.10): setup in FEATURES order, start in the
 * same order once the core subsystems run, stop in reverse order. A feature
 * whose setup or start throws is logged, reported to the owner once, and
 * skipped; the daemon still starts. A security feature (approvals, scrubbing,
 * the skill write guard) that fails is logged as a security error and named
 * first in the owner notice, with the protection that is missing (CONF-N14).
 */

import { createModuleLogger } from "@kirie/core";
import type { DaemonContext, FeatureEntry, FeatureHandle } from "./types.js";

const log = createModuleLogger("daemon-features");

export interface FeatureFailure {
  name: string;
  phase: "setup" | "start" | "stop";
  message: string;
  /** The protection that is missing, for a security feature. */
  security?: string;
}

export interface FeatureRunHooks {
  /** Told once per failing feature (the daemon sends one owner notice). */
  onFailure?(failure: FeatureFailure): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function report(hooks: FeatureRunHooks, name: string, phase: "setup" | "start", err: unknown, security: string | undefined): void {
  if (security) {
    log.error({ feature: name, phase, security, err: message(err) }, `SECURITY: feature ${name} failed to ${phase}; Kirie is running WITHOUT ${security}`);
  } else {
    log.error({ feature: name, err: message(err) }, `feature ${phase} failed; feature skipped`);
  }
  hooks.onFailure?.({ name, phase, message: message(err), ...(security ? { security } : {}) });
}

/**
 * The owner notice for failed features, or null when none failed. Security
 * features come first, each with the protection that is missing. Error
 * messages stay in the log (they can hold paths or config values).
 */
export function featureFailureNotice(failures: readonly FeatureFailure[]): string | null {
  if (failures.length === 0) return null;
  const lines: string[] = [];
  const security = failures.filter((f) => f.security);
  const seen = new Set<string>();
  for (const f of security) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    lines.push(`Security warning: Kirie is running WITHOUT ${f.security} (${f.name}), because it failed to ${f.phase}. See the daemon log, fix it and restart Kirie.`);
  }
  const others = [...new Set(failures.filter((f) => !f.security).map((f) => f.name))];
  if (others.length > 0) lines.push(`Kirie started without these features because they failed to start: ${others.join(", ")}. See the daemon log.`);
  return lines.join("\n");
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
      handles.push({ ...handle, name: handle?.name || feature.name, ...(feature.security ? { security: feature.security } : {}) });
    } catch (err) {
      report(hooks, feature.name, "setup", err, feature.security);
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
      report(hooks, handle.name, "start", err, handle.security);
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
