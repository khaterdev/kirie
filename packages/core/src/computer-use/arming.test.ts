import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ComputerUseArming, clampComputerUseMinutes } from "./arming.js";

describe("ComputerUseArming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("a fresh instance (every daemon start) is disarmed", () => {
    const arming = new ComputerUseArming();
    expect(arming.state()).toEqual({ armed: false });
    expect(arming.isArmed()).toBe(false);
    expect(arming.grants().size).toBe(0);
  });

  it("arms for a window and disarms itself at expiry, clearing grants and calling onDisarm once", () => {
    const onDisarm = vi.fn();
    const arming = new ComputerUseArming({ onDisarm });
    const s = arming.arm({ minutes: 10, apps: ["Notes"], by: "owner:telegram:1" });
    expect(s).toMatchObject({ armed: true, apps: ["Notes"], armedBy: "owner:telegram:1" });
    expect(arming.minutesLeft()).toBe(10);
    expect(arming.grant("computer:act:com.apple.Notes", arming.epoch())).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(arming.isArmed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(arming.isArmed()).toBe(false);
    expect(arming.grants().size).toBe(0);
    expect(onDisarm).toHaveBeenCalledTimes(1);
    expect(onDisarm.mock.calls[0]![0]).toBe("timeout");
  });

  it("closes lazily when the time is over even if the timer did not fire", () => {
    let now = 1_000_000;
    const timers: Array<() => void> = [];
    const arming = new ComputerUseArming({ now: () => now, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    arming.arm({ minutes: 1, by: "owner" });
    now += 60_000;
    expect(arming.isArmed()).toBe(false);
  });

  it("re-arming replaces the window and drops the old grants and the old timer", () => {
    const onDisarm = vi.fn();
    const arming = new ComputerUseArming({ onDisarm });
    arming.arm({ minutes: 5, by: "owner" });
    arming.grant("computer:act:com.apple.Notes", arming.epoch());
    arming.arm({ minutes: 20, apps: ["Finder"], by: "owner" });
    expect(arming.grants().size).toBe(0);
    expect(arming.state().apps).toEqual(["Finder"]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(arming.isArmed()).toBe(true);
    expect(onDisarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15 * 60_000);
    expect(arming.isArmed()).toBe(false);
  });

  it("disarm clears grants, reports whether a window was open, and calls onDisarm only for an open window", () => {
    const onDisarm = vi.fn();
    const arming = new ComputerUseArming({ onDisarm });
    expect(arming.disarm("owner")).toBe(false);
    expect(onDisarm).not.toHaveBeenCalled();
    arming.arm({ minutes: 5, by: "owner" });
    arming.grant("k", arming.epoch());
    expect(arming.disarm("owner")).toBe(true);
    expect(arming.grants().size).toBe(0);
    expect(onDisarm).toHaveBeenCalledWith("owner", expect.objectContaining({ armed: true }));
  });

  it("a grant from an older window (epoch) is not stored", () => {
    const arming = new ComputerUseArming();
    arming.arm({ minutes: 5, by: "owner" });
    const epoch = arming.epoch();
    arming.disarm("owner");
    arming.arm({ minutes: 5, by: "owner" });
    expect(arming.grant("k", epoch)).toBe(false);
    expect(arming.grants().size).toBe(0);
    expect(arming.grant("k", arming.epoch())).toBe(true);
  });

  it("no grant while disarmed", () => {
    const arming = new ComputerUseArming();
    expect(arming.grant("k", arming.epoch())).toBe(false);
  });

  it("a throwing onDisarm still leaves the window closed", () => {
    const arming = new ComputerUseArming({ onDisarm: () => { throw new Error("boom"); } });
    arming.arm({ minutes: 5, by: "owner" });
    expect(arming.disarm("owner")).toBe(true);
    expect(arming.isArmed()).toBe(false);
  });
});

describe("clampComputerUseMinutes", () => {
  it("clamps to [1, max] and uses the default for non-numbers", () => {
    expect(clampComputerUseMinutes(999, 15, 60)).toBe(60);
    expect(clampComputerUseMinutes(0, 15, 60)).toBe(1);
    expect(clampComputerUseMinutes(-5, 15, 60)).toBe(1);
    expect(clampComputerUseMinutes(Number.NaN, 15, 60)).toBe(15);
    expect(clampComputerUseMinutes(10.7, 15, 60)).toBe(10);
  });
});
