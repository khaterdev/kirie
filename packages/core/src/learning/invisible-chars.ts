/**
 * Invisible and bidi characters, one list for every learning path (LEARN-N11).
 *
 * Proposal intake strips them (and flags the proposal), the user model strips
 * them from fact statements, and the review paths make them visible so the
 * owner never approves text that renders differently from what is stored.
 *
 * Covered: soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul
 * and Khmer fillers, Mongolian selectors, zero-width characters and marks
 * (U+200B to U+200F), bidi embeddings and overrides (U+202A to U+202E), word
 * joiner, invisible operators and bidi isolates (U+2060 to U+206F), variation
 * selectors (U+FE00 to U+FE0F and U+E0100 to U+E01EF), the BOM, the halfwidth
 * Hangul filler and Unicode tag characters (U+E0000 to U+E007F).
 */

const INVISIBLE_CLASS =
  "\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E" +
  "\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}";

/** Global regex over every invisible character (Unicode mode). */
export function invisibleCharsRegex(): RegExp {
  return new RegExp(`[${INVISIBLE_CLASS}]`, "gu");
}

const TEST_RE = new RegExp(`[${INVISIBLE_CLASS}]`, "u");

export function hasInvisibleChars(text: string): boolean {
  return TEST_RE.test(text);
}

export function stripInvisibleChars(text: string): string {
  return text.replace(invisibleCharsRegex(), "");
}

/** Replace each invisible character with a visible `[U+XXXX]` marker. */
export function revealInvisibleChars(text: string): string {
  return text.replace(invisibleCharsRegex(), (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}
