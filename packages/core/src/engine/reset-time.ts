/**
 * Parse the reset time out of a Claude usage-limit message.
 *
 * The CLI reports limits as text such as
 *   "You've hit your session limit · resets 2:30am (Africa/Cairo)"
 *   "You've hit your weekly limit · resets Aug 11 at 5pm (Africa/Cairo)"
 * A time with no date means the next occurrence of that wall-clock time in the
 * given zone. Zone offsets come from Intl, so no timezone library is needed.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Margin added to every parsed time so a retry never lands just before the reset. */
export const RESET_MARGIN_MS = 60_000;
/** No parsed reset is trusted further out than this. */
export const RESET_MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Groups: 1 month name, 2 day, 3 year, 4 hour, 5 minutes, 6 am/pm, 7 zone.
 * Accepts "resets 4am", "resets 2:30am (Zone)", "resets Aug 11 at 5pm (Zone)",
 * "resets at 17:00" and the docs' "your session limit resets 3:45pm".
 */
const RESET_RE =
  /\bresets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([^)]{1,64})\))?/i;

function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

function wallPartsAt(epochMs: number, tz: string): WallParts & { second: number } {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
function offsetAt(epochMs: number, tz: string): number {
  const p = wallPartsAt(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch ms of a wall-clock time in a zone. Date.UTC normalises overflow, so
 * `day + 1` on the last day of a month is fine.
 *
 * Around DST changes a wall time can be ambiguous (fall back) or missing
 * (spring forward). Either way the later candidate is used: for a reset time,
 * retrying late is harmless and retrying early is not.
 */
export function zonedWallTimeToEpoch(wall: WallParts, tz: string): number {
  const guess = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  // Offsets in force on either side of any transition near this wall time.
  const offsets = new Set([
    offsetAt(guess - 12 * 60 * 60 * 1000, tz),
    offsetAt(guess, tz),
    offsetAt(guess + 12 * 60 * 60 * 1000, tz),
  ]);
  const candidates = [...offsets].map((offset) => guess - offset);
  const valid = candidates.filter((t) => {
    const p = wallPartsAt(t, tz);
    return p.hour === wall.hour && p.minute === wall.minute;
  });
  return Math.max(...(valid.length > 0 ? valid : candidates));
}

function clampReset(epochMs: number, now: number): number {
  const withMargin = epochMs + RESET_MARGIN_MS;
  return Math.min(Math.max(withMargin, now + RESET_MARGIN_MS), now + RESET_MAX_AHEAD_MS);
}

/**
 * Parse a reset time from limit text.
 *
 * @param text      the limit message (anything containing "resets ...")
 * @param now       current epoch ms
 * @param defaultTz IANA zone used when the text names none (falls back to the system zone)
 * @returns epoch ms of the reset plus a 60 s margin, clamped to [now + 60 s, now + 8 d],
 *          or undefined when no reset time can be read
 */
export function parseResetTime(text: string, now: number = Date.now(), defaultTz?: string): number | undefined {
  const m = RESET_RE.exec(text);
  if (!m) return undefined;

  const [, monthName, dayStr, yearStr, hourStr, minuteStr, ampmRaw, zoneRaw] = m;
  const ampm = ampmRaw?.replace(/\./g, "").toLowerCase();

  // A bare number ("resets 5") is too ambiguous to act on.
  if (!ampm && minuteStr === undefined) return undefined;

  let hour = Number(hourStr);
  const minute = minuteStr === undefined ? 0 : Number(minuteStr);
  if (minute > 59) return undefined;
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    if (ampm === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return undefined;
  }

  const zone = zoneRaw?.trim();
  const tz = isValidTimeZone(zone)
    ? zone
    : isValidTimeZone(defaultTz)
      ? defaultTz
      : Intl.DateTimeFormat().resolvedOptions().timeZone;

  const today = wallPartsAt(now, tz);

  if (monthName !== undefined && dayStr !== undefined) {
    const month = MONTHS[monthName.toLowerCase()];
    const day = Number(dayStr);
    if (month === undefined || day < 1 || day > 31) return undefined;

    let year = yearStr ? Number(yearStr) : today.year;
    let at = zonedWallTimeToEpoch({ year, month, day, hour, minute }, tz);
    // "Jan 2" read on Dec 30 means next year.
    if (!yearStr && at < now - DAY_MS) {
      year += 1;
      at = zonedWallTimeToEpoch({ year, month, day, hour, minute }, tz);
    }
    return clampReset(at, now);
  }

  let at = zonedWallTimeToEpoch({ year: today.year, month: today.month, day: today.day, hour, minute }, tz);
  if (at <= now) {
    at = zonedWallTimeToEpoch({ year: today.year, month: today.month, day: today.day + 1, hour, minute }, tz);
  }
  return clampReset(at, now);
}

/**
 * Display text for a known reset instant, e.g. "Nov 23 at 4:00am (Africa/Cairo)".
 * Used when the reset came from a structured signal and there is no text hint.
 */
export function formatResetTime(epochMs: number, tz?: string): string {
  const zone = isValidTimeZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = wallPartsAt(epochMs, zone);
  const monthName = Object.keys(MONTHS).find((k) => k.length === 3 && MONTHS[k] === p.month) ?? "";
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const suffix = p.hour < 12 ? "am" : "pm";
  const mm = String(p.minute).padStart(2, "0");
  const month = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  return `${month} ${p.day} at ${h12}:${mm}${suffix} (${zone})`;
}
