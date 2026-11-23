import { describe, it, expect } from "vitest";
import {
  parseResetTime,
  formatResetTime,
  zonedWallTimeToEpoch,
  RESET_MARGIN_MS,
  RESET_MAX_AHEAD_MS,
} from "./reset-time.js";

const MIN = 60_000;
const utc = (iso: string): number => new Date(iso).getTime();

// 2026-11-23 10:00 UTC = 12:00 in Cairo (EET, UTC+2, no DST in November).
const NOW = utc("2026-11-23T10:00:00Z");

describe("parseResetTime: the five shapes seen in the daemon log", () => {
  it("time with minutes: 'resets 2:30am (Africa/Cairo)' is the next 2:30am, tomorrow", () => {
    const at = parseResetTime("You've hit your session limit · resets 2:30am (Africa/Cairo)", NOW);
    expect(at).toBe(utc("2026-11-24T00:30:00Z") + RESET_MARGIN_MS);
  });

  it("hour only: 'resets 4am (Africa/Cairo)'", () => {
    const at = parseResetTime("You've hit your session limit · resets 4am (Africa/Cairo)", NOW);
    expect(at).toBe(utc("2026-11-24T02:00:00Z") + RESET_MARGIN_MS);
  });

  it("later today: 'resets 5pm (Africa/Cairo)'", () => {
    const at = parseResetTime("You've hit your weekly limit · resets 5pm (Africa/Cairo)", NOW);
    expect(at).toBe(utc("2026-11-23T15:00:00Z") + RESET_MARGIN_MS);
  });

  it("month and day: 'resets Nov 25 at 5pm (Africa/Cairo)'", () => {
    const at = parseResetTime("You've hit your weekly limit · resets Nov 25 at 5pm (Africa/Cairo)", NOW);
    expect(at).toBe(utc("2026-11-25T15:00:00Z") + RESET_MARGIN_MS);
  });

  it("the logged 'Aug 11 at 5pm' and 'Oct 13 at 5pm' shapes parse", () => {
    const aug = parseResetTime(
      "You've hit your weekly limit · resets Aug 11 at 5pm (Africa/Cairo)",
      utc("2026-08-10T09:00:00Z"),
    );
    // 5pm in Cairo is 14:00 or 15:00 UTC depending on DST rules in the ICU data.
    expect(aug).toBeGreaterThanOrEqual(utc("2026-08-11T14:00:00Z"));
    expect(aug).toBeLessThanOrEqual(utc("2026-08-11T15:00:00Z") + RESET_MARGIN_MS);

    const oct = parseResetTime(
      "You've hit your weekly limit · resets Oct 13 at 5pm (Africa/Cairo)",
      utc("2026-10-10T09:00:00Z"),
    );
    expect(oct).toBeGreaterThanOrEqual(utc("2026-10-13T14:00:00Z"));
    expect(oct).toBeLessThanOrEqual(utc("2026-10-13T15:00:00Z") + RESET_MARGIN_MS);
  });

  it("works on the thrown SDK error text", () => {
    const at = parseResetTime(
      "Claude Code returned an error result: You've hit your session limit · resets 4am (Africa/Cairo)",
      NOW,
    );
    expect(at).toBe(utc("2026-11-24T02:00:00Z") + RESET_MARGIN_MS);
  });

  it("a fixed-offset zone with month and day", () => {
    const at = parseResetTime("resets Aug 11 at 5pm (Asia/Tokyo)", utc("2026-08-05T00:00:00Z"));
    expect(at).toBe(utc("2026-08-11T08:00:00Z") + RESET_MARGIN_MS);
  });

  it("24-hour time and the docs' 'your session limit resets 3:45pm' wording", () => {
    expect(parseResetTime("resets 17:00 (UTC)", NOW)).toBe(utc("2026-11-23T17:00:00Z") + RESET_MARGIN_MS);
    expect(parseResetTime("· your session limit resets 3:45pm", NOW, "UTC")).toBe(
      utc("2026-11-23T15:45:00Z") + RESET_MARGIN_MS,
    );
  });
});

describe("parseResetTime: rollover, DST, clamp, fallbacks", () => {
  it("rolls a month/day that already passed into next year", () => {
    const at = parseResetTime("resets Jan 2 at 9am (UTC)", utc("2026-12-30T12:00:00Z"));
    expect(at).toBe(utc("2027-01-02T09:00:00Z") + RESET_MARGIN_MS);
  });

  it("rolls a time-only reset that already passed today into tomorrow", () => {
    const at = parseResetTime("resets 9am (UTC)", NOW);
    expect(at).toBe(utc("2026-11-24T09:00:00Z") + RESET_MARGIN_MS);
  });

  it("DST gap (spring forward): a wall time that does not exist resolves to the later instant", () => {
    // New York skips 2:00-3:00 on 2026-03-08. 2:30am does not exist; 3:30am EDT is 07:30Z.
    const at = parseResetTime("resets 2:30am (America/New_York)", utc("2026-03-07T12:00:00Z"));
    expect(at).toBe(utc("2026-03-08T07:30:00Z") + RESET_MARGIN_MS);
  });

  it("DST overlap (fall back): an ambiguous wall time resolves to the later instant", () => {
    // 1:30am happens twice on 2026-11-01 in New York: 05:30Z (EDT) and 06:30Z (EST).
    const at = parseResetTime("resets 1:30am (America/New_York)", utc("2026-10-31T12:00:00Z"));
    expect(at).toBe(utc("2026-11-01T06:30:00Z") + RESET_MARGIN_MS);
  });

  it("a normal summer time in a DST zone uses the summer offset", () => {
    expect(zonedWallTimeToEpoch({ year: 2026, month: 6, day: 1, hour: 12, minute: 0 }, "America/New_York")).toBe(
      utc("2026-07-01T16:00:00Z"),
    );
  });

  it("clamps a far-away reset to now + 8 days", () => {
    const at = parseResetTime("resets Dec 25 at 5pm (UTC)", NOW);
    expect(at).toBe(NOW + RESET_MAX_AHEAD_MS);
  });

  it("clamps a reset that is effectively now to at least now + 60 s", () => {
    const at = parseResetTime("resets Nov 23 at 9:58am (UTC)", NOW);
    expect(at).toBe(NOW + RESET_MARGIN_MS);
  });

  it("uses the default zone when the text names none, and when the named zone is invalid", () => {
    expect(parseResetTime("resets 4am", NOW, "Africa/Cairo")).toBe(utc("2026-11-24T02:00:00Z") + RESET_MARGIN_MS);
    expect(parseResetTime("resets 4am (Not/AZone)", NOW, "Africa/Cairo")).toBe(
      utc("2026-11-24T02:00:00Z") + RESET_MARGIN_MS,
    );
  });

  it("returns undefined when nothing parses", () => {
    expect(parseResetTime("You've hit your monthly spend limit · raise it at the console", NOW)).toBeUndefined();
    expect(parseResetTime("resets 5", NOW)).toBeUndefined();
    expect(parseResetTime("resets 13pm (UTC)", NOW)).toBeUndefined();
    expect(parseResetTime("resets Foo 3 at 5pm (UTC)", NOW)).toBeUndefined();
    expect(parseResetTime("", NOW)).toBeUndefined();
  });

  it("every result lies within [now + 60 s, now + 8 d]", () => {
    for (const text of ["resets 10:01am (UTC)", "resets 9:59am (UTC)", "resets Mar 1 at 1am (UTC)"]) {
      const at = parseResetTime(text, NOW)!;
      expect(at).toBeGreaterThanOrEqual(NOW + MIN);
      expect(at).toBeLessThanOrEqual(NOW + RESET_MAX_AHEAD_MS);
    }
  });
});

describe("formatResetTime", () => {
  it("renders a display hint in the given zone", () => {
    expect(formatResetTime(utc("2026-11-24T02:00:00Z"), "Africa/Cairo")).toBe("Nov 24 at 4:00am (Africa/Cairo)");
    expect(formatResetTime(utc("2026-11-23T12:05:00Z"), "UTC")).toBe("Nov 23 at 12:05pm (UTC)");
  });
});
