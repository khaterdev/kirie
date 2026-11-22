/**
 * Parsing helpers for commands. Handlers use these instead of ad hoc
 * parsing; nothing here evaluates or shells out.
 */

/** "/name", "/name@bot args...". Name 1..32 chars of [A-Za-z0-9_]. */
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/;

export interface ParsedCommandText {
  /** Lowercased */
  name: string;
  /** The "@bot" part without the "@", when present */
  mention?: string;
  /** Text after the command token, trimmed */
  args: string;
}

/** Parse a message text as a command. Null when it is not one. */
export function parseCommandText(text: string): ParsedCommandText | null {
  if (typeof text !== "string") return null;
  const m = COMMAND_RE.exec(text.trim());
  if (!m) return null;
  const out: ParsedCommandText = { name: m[1]!.toLowerCase(), args: (m[3] ?? "").trim() };
  if (m[2]) out.mention = m[2];
  return out;
}

/**
 * Quote-aware split of an argument string.
 * Double and single quotes group words; a backslash escapes the next
 * character outside single quotes. An unterminated quote runs to the end.
 */
export function splitCommandArgs(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < args.length) {
        cur += args[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < args.length) {
      cur += args[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        out.push(cur);
        cur = "";
        inToken = false;
      }
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

const DURATION_RE = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
const UNIT_MS = [7 * 86_400_000, 86_400_000, 3_600_000, 60_000, 1000] as const;

/**
 * Parse "90s", "5m", "1h30m", "2d", "1w" into milliseconds.
 * Null for garbage, zero, negatives, or a value outside [minMs, maxMs].
 */
export function parseDuration(text: string, opts: { minMs?: number; maxMs?: number } = {}): number | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  const m = DURATION_RE.exec(s);
  if (!m) return null;
  let total = 0;
  let any = false;
  for (let i = 0; i < UNIT_MS.length; i++) {
    const part = m[i + 1];
    if (part === undefined) continue;
    any = true;
    total += Number(part) * UNIT_MS[i]!;
  }
  if (!any || !Number.isSafeInteger(total) || total <= 0) return null;
  if (opts.minMs !== undefined && total < opts.minMs) return null;
  if (opts.maxMs !== undefined && total > opts.maxMs) return null;
  return total;
}

/** Format milliseconds as "1h30m", "45s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const labels = ["w", "d", "h", "m", "s"];
  let rest = Math.round(ms / 1000) * 1000;
  let out = "";
  for (let i = 0; i < UNIT_MS.length; i++) {
    const n = Math.floor(rest / UNIT_MS[i]!);
    if (n > 0) {
      out += `${n}${labels[i]}`;
      rest -= n * UNIT_MS[i]!;
    }
  }
  return out || "0s";
}

/** Strict integer in [min, max]. Null otherwise. */
export function parseIntInRange(text: string, min: number, max: number): number | null {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (!/^[+-]?\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

/** on/off, true/false, yes/no, enable/disable, 1/0. Null otherwise. */
export function parseOnOff(text: string): boolean | null {
  if (typeof text !== "string") return null;
  switch (text.trim().toLowerCase()) {
    case "on": case "true": case "yes": case "enable": case "enabled": case "1":
      return true;
    case "off": case "false": case "no": case "disable": case "disabled": case "0":
      return false;
    default:
      return null;
  }
}
