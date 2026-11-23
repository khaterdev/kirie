/**
 * Phone number helpers. Kirie stores and compares numbers in E.164 with a
 * leading "+". Caller ID is never authentication (PLAN C.14); these helpers
 * only normalise formatting.
 */

const E164_RE = /^\+[1-9]\d{6,14}$/;
const WITHHELD_RE = /^(anonymous|restricted|unknown|private|unavailable|withheld|blocked)$/i;

export function isE164(value: string | null | undefined): value is string {
  return typeof value === "string" && E164_RE.test(value);
}

/**
 * Normalise a number to E.164 with "+".
 * Strips spaces, dashes, dots and parentheses, turns a leading "00" into "+".
 * With `assumePlus` (Plivo sends numbers without "+"), a bare digit string is
 * read as international. Returns null for withheld caller ids, SIP URIs,
 * empty input and anything that is not a plausible E.164 number.
 */
export function normalizeE164(raw: string | null | undefined, opts: { assumePlus?: boolean } = {}): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || WITHHELD_RE.test(trimmed) || /[a-z@:]/i.test(trimmed)) return null;
  let s = trimmed.replace(/[\s\-.()]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!s.startsWith("+")) {
    if (!opts.assumePlus) return null;
    s = `+${s}`;
  }
  return E164_RE.test(s) ? s : null;
}

/** "+201001234567" -> "…4567". Used everywhere a number is shown or logged. */
export function maskNumber(e164: string | null | undefined): string {
  if (!e164) return "withheld";
  const digits = e164.replace(/\D/g, "");
  return digits.length <= 4 ? "…" : `…${digits.slice(-4)}`;
}

/** The last four digits, for approval prompts. */
export function lastFour(e164: string): string {
  return e164.replace(/\D/g, "").slice(-4);
}

/** E.164 without the "+", the form Plivo's examples use on the wire. */
export function withoutPlus(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}
