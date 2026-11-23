/**
 * Computer use arming window (PLAN C.13): the third switch, after the macOS
 * grants and `computerUse.enabled`.
 *
 * In memory only. A new instance (every daemon start) is disarmed, so a
 * restart always comes up with computer use off. Only the `/computer` owner
 * command arms it; no MCP tool and no HTTP route can.
 */

import type { ComputerUseArmState } from "./policy.js";

export type ComputerUseDisarmReason = "owner" | "timeout" | "shutdown" | "error";

export interface ComputerUseArmingDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called once per disarm of an armed window, after grants are cleared. Must not throw (a throw is swallowed). */
  onDisarm?: (reason: ComputerUseDisarmReason, previous: ComputerUseArmState) => void;
}

/** Minutes clamped to [1, max]. Non-finite input uses `fallback`. */
export function clampComputerUseMinutes(minutes: number, fallback: number, max: number): number {
  const top = Math.max(1, Math.floor(max));
  const raw = Number.isFinite(minutes) ? Math.floor(minutes) : Math.floor(fallback);
  return Math.min(top, Math.max(1, raw));
}

export class ComputerUseArming {
  private current: ComputerUseArmState = { armed: false };
  private readonly grantMap = new Map<string, number>();
  private timer: unknown = undefined;
  private epochValue = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onDisarm?: ComputerUseArmingDeps["onDisarm"];

  constructor(deps: ComputerUseArmingDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onDisarm = deps.onDisarm;
  }

  /**
   * Open a window of `minutes` (already clamped by the caller with
   * clampComputerUseMinutes). Replaces any previous window and drops its grants.
   */
  arm(opts: { minutes: number; apps?: readonly string[]; by: string }): ComputerUseArmState {
    const minutes = Math.max(1, Math.floor(opts.minutes));
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.grantMap.clear();
    this.epochValue++;
    const now = this.now();
    const apps = (opts.apps ?? []).map((a) => a.trim()).filter(Boolean);
    this.current = {
      armed: true,
      until: now + minutes * 60_000,
      armedAt: now,
      armedBy: opts.by,
      ...(apps.length > 0 ? { apps } : {}),
    };
    const epoch = this.epochValue;
    this.timer = this.setTimer(() => {
      if (this.epochValue === epoch) this.disarm("timeout");
    }, minutes * 60_000);
    return this.state();
  }

  /** Close the window now. Returns true when a window was open. Clears every grant. */
  disarm(reason: ComputerUseDisarmReason): boolean {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.grantMap.clear();
    const previous = this.current;
    this.current = { armed: false };
    this.epochValue++;
    if (!previous.armed) return false;
    try {
      this.onDisarm?.(reason, previous);
    } catch {
      // The window is closed whatever the callback does.
    }
    return true;
  }

  /** The window, closed lazily when its time is over (in case the timer has not fired yet). */
  state(): ComputerUseArmState {
    if (this.current.armed && this.current.until !== undefined && this.now() >= this.current.until) {
      this.disarm("timeout");
    }
    return { ...this.current, ...(this.current.apps ? { apps: [...this.current.apps] } : {}) };
  }

  isArmed(): boolean {
    return this.state().armed;
  }

  /** Changes on every arm and disarm, so an approval answered after the window changed is not stored. */
  epoch(): number {
    return this.epochValue;
  }

  minutesLeft(): number {
    const s = this.state();
    if (!s.armed || s.until === undefined) return 0;
    return Math.max(0, Math.ceil((s.until - this.now()) / 60_000));
  }

  /** Store an approval grant until the window closes, only if `epoch` is still the current window. */
  grant(key: string, epoch: number): boolean {
    if (epoch !== this.epochValue || !this.isArmed()) return false;
    this.grantMap.set(key, this.current.until ?? Number.POSITIVE_INFINITY);
    return true;
  }

  grants(): ReadonlyMap<string, number> {
    return new Map(this.grantMap);
  }
}
