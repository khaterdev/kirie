/**
 * TaskHooks - the daemon's one registry of background-task extensions (PLAN B.14).
 *
 * Features register functions keyed by a task's `meta.profile` (for example
 * "goal" or "webhook"). `lifecycle.ts` hands the dispatchers below to the
 * BackgroundTaskManager once, so no feature edits the manager or lifecycle.
 * A task with no profile, or a profile nobody registered, behaves exactly as
 * before: no controller, no profile, the default completion and failure pushes.
 */

import type { BackgroundTask, TaskProfile, TaskTurnController } from "@kirie/core";

export type TaskControllerFactory = (task: BackgroundTask) => TaskTurnController | undefined;
export type TaskProfileFactory = (task: BackgroundTask) => TaskProfile | undefined;
export type TaskOutcomeHandler = (task: BackgroundTask) => Promise<void>;

const PROFILE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class TaskHooks {
  private readonly controllers = new Map<string, TaskControllerFactory>();
  private readonly profiles = new Map<string, TaskProfileFactory>();
  private readonly completions = new Map<string, TaskOutcomeHandler>();
  private readonly failures = new Map<string, TaskOutcomeHandler>();

  /** The turn controller for tasks whose meta.profile is `profile`. Throws on a duplicate. */
  registerController(profile: string, fn: TaskControllerFactory): void {
    put(this.controllers, profile, fn, "controller");
  }

  /** The options profile (tool allowlist, prompt, kind) for tasks whose meta.profile is `profile`. Throws on a duplicate. */
  registerProfile(profile: string, fn: TaskProfileFactory): void {
    put(this.profiles, profile, fn, "profile");
  }

  /** Replaces the default "Background task completed" push for this profile. Throws on a duplicate. */
  registerCompletionHandler(profile: string, fn: TaskOutcomeHandler): void {
    put(this.completions, profile, fn, "completion handler");
  }

  /** Replaces the default "Background task failed" push for this profile. Throws on a duplicate. */
  registerFailureHandler(profile: string, fn: TaskOutcomeHandler): void {
    put(this.failures, profile, fn, "failure handler");
  }

  controllerFor(task: BackgroundTask): TaskTurnController | undefined {
    const profile = task.meta?.profile;
    return profile ? this.controllers.get(profile)?.(task) : undefined;
  }

  profileFor(task: BackgroundTask): TaskProfile | undefined {
    const profile = task.meta?.profile;
    return profile ? this.profiles.get(profile)?.(task) : undefined;
  }

  /** The handler registered for this task's profile, if any. */
  completionHandlerFor(task: BackgroundTask): TaskOutcomeHandler | undefined {
    const profile = task.meta?.profile;
    return profile ? this.completions.get(profile) : undefined;
  }

  failureHandlerFor(task: BackgroundTask): TaskOutcomeHandler | undefined {
    const profile = task.meta?.profile;
    return profile ? this.failures.get(profile) : undefined;
  }
}

function put<T>(map: Map<string, T>, profile: string, fn: T, what: string): void {
  if (!PROFILE_RE.test(profile)) throw new Error(`Invalid task profile name "${profile}"`);
  if (map.has(profile)) throw new Error(`A task ${what} for profile "${profile}" is already registered`);
  map.set(profile, fn);
}
