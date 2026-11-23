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

/** Opening quote -> the characters that may close it. A straight or typographic quote of the other kind inside a value is literal. */
const QUOTE_CLOSERS: Record<string, string> = {
  '"': '"',
  "“": "”",
  "”": "”",
  "„": "“”",
  "'": "'",
  "‘": "’",
  "’": "’",
};
const DOUBLE_QUOTE_OPENERS = '"“”„';
/** "--name" anywhere; an en or em dash only for a known name (iOS turns "--" into "—"). */
const FLAG_AT_RE = /^(--|[–—])([A-Za-z][A-Za-z0-9_-]*)(?==|\s|$)/;

export interface TextAndFlags {
  /** The free text, verbatim (apostrophes, quotes and backslashes are literal) */
  text: string;
  /** Flags in the order given; names lowercased */
  flags: Array<{ name: string; value: string }>;
}

export interface TextAndFlagsOptions {
  /** Flag names (lowercase, without dashes) that take one value each */
  flags: readonly string[];
  /** Allow the free text after the flags (when none came before them). Default false */
  textAfterFlags?: boolean;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** Index of the quote closing the one at `open`: a closer followed by whitespace or the end. -1 when none. */
function closingQuote(s: string, open: number): number {
  const closers = QUOTE_CLOSERS[s[open]!];
  if (!closers) return -1;
  for (let i = open + 1; i < s.length; i++) {
    if (closers.includes(s[i]!) && (i + 1 === s.length || isSpace(s[i + 1]))) return i;
  }
  return -1;
}

/** A flag starting at `i` (which must follow whitespace or the start). */
function flagAt(s: string, i: number, known: ReadonlySet<string>): { name: string; end: number; dash: string } | null {
  if (i > 0 && !isSpace(s[i - 1])) return null;
  const m = FLAG_AT_RE.exec(s.slice(i));
  if (!m) return null;
  const name = m[2]!.toLowerCase();
  if (m[1] !== "--" && !known.has(name)) return null;
  return { name, end: i + m[0].length, dash: m[1]! };
}

/**
 * Split `text [--flag value]...` without shell quoting rules on the text.
 *
 * The free text is taken verbatim up to the first flag-looking word ("--x",
 * or "—x" / "–x" for a known x), so an apostrophe or a typographic quote in
 * prose never hides a flag. The text may also be given in double quotes
 * (straight or typographic) when it must contain "--". Each flag takes one
 * value: `--x=value`, `--x value`, or a quoted value (`"…"`, `'…'`, `“…”`,
 * `‘…’`) that ends at a matching quote followed by whitespace or the end, so
 * quotes inside the value are kept. Anything that cannot be read one way only
 * is an error: an unknown `--x`, a missing value, an unclosed quote, or more
 * text after a flag's value.
 */
export function parseTextAndFlags(raw: string, opts: TextAndFlagsOptions): TextAndFlags | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  const known = new Set(opts.flags);
  const out: TextAndFlags = { text: "", flags: [] };
  let i = 0;
  let quotedText = false;

  const firstFlagFrom = (from: number): number => {
    for (let j = from; j < s.length; j++) if (flagAt(s, j, known)) return j;
    return -1;
  };

  // Quoted text counts as such only when it is all the text before the flags;
  // otherwise its quotes are part of the prose.
  let firstFlag = -1;
  if (s.length > 0 && DOUBLE_QUOTE_OPENERS.includes(s[0]!)) {
    const close = closingQuote(s, 0);
    if (close > 0) {
      const next = firstFlagFrom(close + 1);
      if (!s.slice(close + 1, next === -1 ? s.length : next).trim()) {
        out.text = s.slice(1, close);
        quotedText = true;
        firstFlag = next;
      }
    }
  }
  if (!quotedText) {
    firstFlag = firstFlagFrom(0);
    out.text = s.slice(0, firstFlag === -1 ? s.length : firstFlag).trim();
  }
  if (firstFlag === -1) return out;

  i = firstFlag;
  while (i < s.length) {
    while (isSpace(s[i])) i++;
    if (i >= s.length) break;
    const flag = flagAt(s, i, known);
    if (!flag) {
      const rest = s.slice(i).trim();
      const last = out.flags[out.flags.length - 1]!;
      if (opts.textAfterFlags && !out.text && !quotedText) {
        for (let j = i; j < s.length; j++) {
          const f = flagAt(s, j, known);
          if (f) return { error: `--${f.name} must come before the text or right after the other options.` };
        }
        out.text = rest;
        break;
      }
      return {
        error: `Unexpected text after --${last.name} ${clipForError(last.value)}: "${clipForError(rest)}". Write the text first, then the options, and put a value with spaces in quotes.`,
      };
    }
    if (!known.has(flag.name)) return { error: `Unknown option ${flag.dash}${flag.name}.` };
    i = flag.end;
    let value: string;
    if (s[i] === "=") {
      i++;
    } else {
      while (isSpace(s[i])) i++;
    }
    if (i >= s.length || (s[i - 1] !== "=" && flagAt(s, i, known))) return { error: `--${flag.name} needs a value.` };
    if (QUOTE_CLOSERS[s[i]!]) {
      const close = closingQuote(s, i);
      if (close === -1) return { error: `The quote after --${flag.name} is not closed.` };
      value = s.slice(i + 1, close);
      i = close + 1;
    } else {
      const start = i;
      while (i < s.length && !isSpace(s[i])) i++;
      value = s.slice(start, i);
    }
    out.flags.push({ name: flag.name, value });
  }
  return out;
}

function clipForError(text: string): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

const DURATION_RE =/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
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
