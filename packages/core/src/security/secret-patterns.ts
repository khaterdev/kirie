/**
 * Secret pattern rules for the SecretScrubber (PLAN B.8, R3 item 12 "Pattern pass").
 *
 * Every rule must run in linear time on any input:
 *  - Token rules start with a literal prefix behind a left-boundary lookbehind, so a run of
 *    token characters can only be entered once (no O(n^2) rescans on "sk-sk-sk-...").
 *  - Quantifiers are never nested. Context rules (assignments, private keys) find an anchor
 *    with a plain regex and then scan bounded, memoised ranges by hand.
 *  - There is no generic entropy rule: git SHAs, UUIDs, hashes and base64 blobs pass untouched.
 *
 * A rule reports spans through `emit(start, end)`. The span is what gets replaced with the
 * marker; text outside it (header names, assignment names, URL users, bot ids) is kept.
 *
 * Text is often a serialized JSON log line, where a line break is the two characters `\n`.
 * Every left boundary therefore also accepts a position right after `\n`, `\r` or `\t` escapes.
 */

/** Characters that may appear inside an opaque API token. */
const TOKEN_CHARS = "A-Za-z0-9_\\-";
/** Right after a JSON/string escape such as `\n` (backslash + n). */
const AFTER_ESCAPE = "(?<=\\\\[ntr])";
/** Left boundary: a token cannot start in the middle of another token. */
const LB = `(?:(?<![${TOKEN_CHARS}])|${AFTER_ESCAPE})`;
/** Left boundary for rules whose body is alphanumeric only. */
const LB_ALNUM = `(?:(?<![A-Za-z0-9])|${AFTER_ESCAPE})`;

export type SecretScanEmit = (start: number, end: number) => void;

export interface SecretScanInput {
  readonly text: string;
  /** Lower-cased copy of `text`, computed once per call and shared by all rules. */
  lower(): string;
}

export interface SecretPatternRule {
  readonly name: string;
  /** Cheap pre-screen: the rule runs only if the text contains at least one of these. */
  readonly gate?: readonly string[];
  /** When true, `gate` entries are lower-case and checked against the lower-cased text. */
  readonly gateLower?: boolean;
  scan(input: SecretScanInput, emit: SecretScanEmit): void;
}

/** True when text[i-2..i-1] is an escape such as `\n`, so position i starts a new line. */
function afterEscape(text: string, i: number): boolean {
  return i >= 2 && text[i - 2] === "\\" && (text[i - 1] === "n" || text[i - 1] === "r" || text[i - 1] === "t");
}

// ---------------------------------------------------------------------------
// Value validators (false-positive guards for the context rules)
// ---------------------------------------------------------------------------

const LITERAL_VALUES = new Set([
  "true", "false", "null", "none", "nil", "undefined", "yes", "no", "on", "off",
  "required", "optional", "string", "number", "boolean", "empty", "unset", "redacted",
]);

const REFERENCE_PREFIXES = [
  "$", "%", "{{", "process.env", "os.environ", "os.getenv", "import.meta.env", "env.", "secrets.",
  "vars.", "config.", "settings.", "getenv", "@",
];

const PATH_PREFIXES = ["/", "~/", "./", "../", "file:"];

function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_RE = /^(?:<[^>]*>?|\[[^\]]*\]?|x{3,}|X{3,}|\*{3,}|\.{3,}|…|_{3,}|-{3,}|#{3,}|0{6,})/;
const PLACEHOLDER_WORD_RE = /(?:^(?:your|my|the|some)[-_ ]|example|placeholder|changeme|change[-_]me|dummy|sample|here$)/i;
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const SNAKE_IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const HAS_DIGIT_RE = /\d/;
const HAS_MIXED_CASE_RE = /[a-z].*[A-Z]|[A-Z].*[a-z]/;
const HAS_SYMBOL_RE = /[^A-Za-z0-9_.\-]/;

export interface SecretValueCheckOptions {
  minLength?: number;
  /** Apply the identifier and word guards to values without a digit (default true). */
  identifierCheck?: boolean;
  /**
   * For bare, unquoted values in running text: a value without a digit must also mix
   * upper and lower case or contain a symbol, so ordinary words are never redacted.
   */
  strictWords?: boolean;
}

/**
 * Decide whether a captured value plausibly is a secret. Used by the context rules
 * (`secret-assignment`, bare `Bearer`, URL passwords, query params), never by prefix rules.
 */
export function isPlausibleSecretValue(value: string, opts?: SecretValueCheckOptions): boolean {
  const minLength = opts?.minLength ?? 8;
  if (value.length < minLength) return false;
  if (value.startsWith("«")) return false; // already a marker
  if (PLACEHOLDER_RE.test(value) || PLACEHOLDER_WORD_RE.test(value)) return false;
  const lower = value.toLowerCase();
  if (LITERAL_VALUES.has(lower)) return false;
  for (const p of REFERENCE_PREFIXES) if (lower.startsWith(p)) return false;
  for (const p of PATH_PREFIXES) if (value.startsWith(p)) return false;
  if (/^[A-Za-z]:\\/.test(value)) return false;
  if (opts?.identifierCheck !== false && !HAS_DIGIT_RE.test(value)) {
    if (DOTTED_IDENTIFIER_RE.test(value) || SNAKE_IDENTIFIER_RE.test(value)) return false;
    if (shannonEntropy(value) < 3.0) return false;
    if (opts?.strictWords && !HAS_MIXED_CASE_RE.test(value) && !HAS_SYMBOL_RE.test(value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

interface RegexRuleOptions {
  /** Capture group whose span is redacted. Default: the whole match. */
  group?: number;
  /** Return false to skip a match. Receives the redacted value. */
  validate?: (value: string) => boolean;
  gate?: readonly string[];
  gateLower?: boolean;
}

function regexRule(name: string, source: string, flags: string, opts: RegexRuleOptions = {}): SecretPatternRule {
  const re = new RegExp(source, `${flags.replace(/[gdy]/g, "")}gd`);
  const group = opts.group ?? 0;
  return {
    name,
    gate: opts.gate,
    gateLower: opts.gateLower,
    scan(input, emit) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(input.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const span = m.indices?.[group];
        if (!span) continue;
        const value = input.text.slice(span[0], span[1]);
        if (opts.validate && !opts.validate(value)) continue;
        emit(span[0], span[1]);
      }
    },
  };
}

/** A prefixed opaque token: `<prefix><body>` behind the left boundary. */
function prefixRule(name: string, alternatives: readonly string[], gate: readonly string[], validate?: (v: string) => boolean): SecretPatternRule {
  return regexRule(name, `${LB}(?:${alternatives.join("|")})`, "", { gate, validate });
}

// ---------------------------------------------------------------------------
// Private key blocks (manual scan: BEGIN header, then a bounded body scan)
// ---------------------------------------------------------------------------

const PEM_BEGIN_RE = /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END_STICKY_RE = /-----END[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/y;
/** Body characters: base64, line breaks, and what encrypted-PEM headers use (Proc-Type: 4,ENCRYPTED). */
const PEM_BODY_CHAR_RE = /[A-Za-z0-9+/=\r\n:,.-]/;
const MAX_PEM_BODY = 16_384;
/**
 * Indentation skipped at the start of a body line, and trailing blanks before a
 * line break: YAML block scalars (`tls.key: |`), Markdown lists, tabs (SCRUB-B1).
 * Bounded, so the scan stays linear.
 */
const MAX_PEM_INDENT = 16;

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/** Index after at most MAX_PEM_INDENT spaces or tabs (raw, or JSON-escaped `\t`) starting at p. */
function skipPemBlanks(text: string, p: number, limit: number): number {
  let q = p;
  for (let n = 0; n < MAX_PEM_INDENT && q < limit; n++) {
    if (isBlank(text[q])) q++;
    else if (text[q] === "\\" && text[q + 1] === "t") q += 2;
    else break;
  }
  return q;
}

/** A real or JSON-escaped line break at q (or the end of the scanned range). */
function isPemLineBreak(text: string, q: number, limit: number): boolean {
  if (q >= limit) return true;
  const ch = text[q];
  return ch === "\n" || ch === "\r" || (ch === "\\" && (text[q + 1] === "n" || text[q + 1] === "r"));
}

const privateKeyRule: SecretPatternRule = {
  name: "private-key",
  gate: ["-----BEGIN"],
  scan(input, emit) {
    const text = input.text;
    PEM_BEGIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PEM_BEGIN_RE.exec(text)) !== null) {
      const start = m.index;
      let p = start + m[0].length;
      const limit = Math.min(text.length, p + MAX_PEM_BODY);
      // The body stops at the first character a key block cannot contain (a quote, prose
      // punctuation, a space not after ':'), at the next "-----", or after 16 KB. It never
      // runs to the end of the text, so an unterminated block cannot swallow a JSON line.
      // Up to MAX_PEM_INDENT blanks are skipped at the start of a line (indented keys) and
      // before a line break (trailing blanks).
      let lineStart = p;
      /** Start of a line that follows a line break (the header's own line is not one). */
      let brokeAt = -1;
      while (p < limit) {
        if (p === brokeAt && (isBlank(text[p]) || (text[p] === "\\" && text[p + 1] === "t"))) {
          const q = skipPemBlanks(text, p, limit);
          if (q < limit && !isBlank(text[q])) { p = q; continue; }
        }
        if (text.startsWith("-----", p)) break;
        const ch = text[p] as string;
        if (isBlank(ch)) {
          const q = skipPemBlanks(text, p, limit);
          if (isPemLineBreak(text, q, limit) && q < limit) { p = q; continue; }
        }
        if (ch === "\\" && (text[p + 1] === "n" || text[p + 1] === "r")) { p += 2; lineStart = p; brokeAt = p; continue; }
        if (ch === "\\" && text[p + 1] === "t") { p += 2; continue; }
        if (ch === "\n" || ch === "\r") { p++; lineStart = p; brokeAt = p; continue; }
        if (ch === " " && text[p - 1] === ":") { p++; continue; }
        if (PEM_BODY_CHAR_RE.test(ch)) { p++; continue; }
        // A space or tab mid-line means this line is prose, not key material: end before it.
        if ((ch === " " || ch === "\t") && lineStart > start + m[0].length) p = lineStart;
        break;
      }
      let end = p;
      PEM_END_STICKY_RE.lastIndex = p;
      const endHeader = PEM_END_STICKY_RE.exec(text);
      if (endHeader) {
        end = p + endHeader[0].length;
      } else {
        // Keep the line breaks that follow the redacted body.
        for (;;) {
          if (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
          else if (end - 2 > start && text[end - 2] === "\\" && (text[end - 1] === "n" || text[end - 1] === "r")) end -= 2;
          else break;
        }
      }
      emit(start, end);
      PEM_BEGIN_RE.lastIndex = Math.max(end, start + m[0].length);
    }
  },
};

// ---------------------------------------------------------------------------
// Secret assignment (manual scan: keyword, then bounded name/value ranges)
// ---------------------------------------------------------------------------

const ASSIGNMENT_KEYWORD_SOURCE =
  "client[ _-]?secret|private[ _-]?key|access[ _-]?key|api[ _-]?key|auth[ _-]?token|passphrase|passw(?:or)?d|credentials?|secret|token|pwd";
const ASSIGNMENT_KEYWORD_RE = new RegExp(ASSIGNMENT_KEYWORD_SOURCE, "gi");

/** Whole names that contain a keyword but never hold a secret value. */
const BENIGN_NAMES = new Set([
  "max_tokens", "input_tokens", "output_tokens", "token_count", "tokens_used", "max_token",
  "primary_key", "foreign_key", "sort_key", "key_name", "keyboard", "author", "authority",
  "token_type", "tokentype", "grant_type", "pwd", "oldpwd",
]);

/** A name segment after the keyword that marks metadata about a secret, not the secret. */
const BENIGN_SUFFIX_SEGMENTS = new Set([
  "count", "counts", "limit", "limits", "type", "types", "name", "names", "id", "ids", "arn", "url",
  "uri", "endpoint", "path", "file", "dir", "length", "len", "size", "ttl", "expiry", "expires",
  "expiration", "hint", "label", "field", "prefix", "header", "version", "policy", "provider", "usage",
  "used", "budget", "index", "env", "var", "ref", "location", "store", "rotation", "set", "required",
  "at", "date", "time", "timestamp", "created", "updated", "changed", "rotated", "since", "until",
  "age", "status", "state", "enabled", "configured", "present", "exists", "missing", "valid", "error",
  "errors", "source", "mode", "method", "scheme", "format", "kind", "scope", "scopes", "manager", "service",
]);

/** A name segment before the keyword that marks a count, flag or setting about a secret. */
const BENIGN_PREFIX_SEGMENTS = new Set([
  "max", "min", "num", "total", "last", "has", "is", "use", "uses", "should", "can", "needs", "require",
  "requires", "enable", "enabled", "show", "hide", "no", "count",
]);

const NAME_CHAR_RE = /[A-Za-z0-9_.-]/;
const isNameChar = (ch: string | undefined): boolean => ch !== undefined && NAME_CHAR_RE.test(ch);
const isLower = (ch: string | undefined): boolean => ch !== undefined && ch >= "a" && ch <= "z";
const isUpper = (ch: string | undefined): boolean => ch !== undefined && ch >= "A" && ch <= "Z";
const isQuote = (ch: string | undefined): boolean => ch === '"' || ch === "'" || ch === "`";

/** Unquoted value characters. Excludes quotes, backtick, backslash (JSON escapes), separators and `=`. */
const UNQUOTED_VALUE_RE = /[^\s"'\\`,;&|<>(){}[\]=]+={0,3}/y;
/** Quoted value characters (spaces allowed, stops at a quote, backtick, backslash or line break). */
const QUOTED_VALUE_RE = /[^"'`\\\r\n]+/y;
const MAX_NAME = 64;
const MAX_VALUE = 512;
const MAX_GAP = 8;

function splitNameSegments(rest: string): string[] {
  return rest
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[ _.-]+/)
    .filter(Boolean);
}

/** The keyword at [kwStart, kwEnd) is a delimited segment of a name (snake, kebab, dotted, camelCase). */
function keywordDelimited(text: string, kwStart: number, kwEnd: number): boolean {
  const before = text[kwStart - 1];
  const leftOk = !isNameChar(before) || before === "_" || before === "-" || before === "." ||
    (isLower(before) && isUpper(text[kwStart])) || afterEscape(text, kwStart);
  if (!leftOk) return false;
  const after = text[kwEnd];
  return !isNameChar(after) || after === "_" || after === "-" || after === "." ||
    (isLower(text[kwEnd - 1]) && isUpper(after));
}

/** Name checks after delimiting: benign whole names, benign segments before or after the keyword. */
function nameIsBenign(name: string, kwOffset: number, kwLength: number): boolean {
  if (BENIGN_NAMES.has(name.toLowerCase().replace(/^-+/, ""))) return true;
  if (splitNameSegments(name.slice(kwOffset + kwLength)).some((seg) => BENIGN_SUFFIX_SEGMENTS.has(seg))) return true;
  return splitNameSegments(name.slice(0, kwOffset)).some((seg) => BENIGN_PREFIX_SEGMENTS.has(seg));
}

/**
 * Whether a field name (object key, env var, flag) names a secret, by the same rules as the
 * `secret-assignment` rule. Used by `scrubDeep` so `{ apiKey: "..." }` is caught without text context.
 */
export function isSecretAssignmentName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME) return false;
  const re = new RegExp(ASSIGNMENT_KEYWORD_SOURCE, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    if (keywordDelimited(name, m.index, m.index + m[0].length) && !nameIsBenign(name, m.index, m[0].length)) return true;
  }
  return false;
}

function skipStars(text: string, p: number): number {
  let k = 0;
  while (k < 4 && (text[p] === "*" || text[p] === "_")) { p++; k++; }
  return p;
}

function skipGap(text: string, p: number): { p: number; gap: number } {
  let gap = 0;
  while (gap < MAX_GAP && (text[p] === " " || text[p] === "\t")) { p++; gap++; }
  return { p, gap };
}

/** Markdown table cell: the name is preceded (ignoring spaces and emphasis) by '|'. */
function inTableCell(text: string, nameStart: number): boolean {
  let q = nameStart - 1;
  let k = 0;
  while (q >= 0 && k < MAX_GAP && (text[q] === " " || text[q] === "*")) { q--; k++; }
  return text[q] === "|";
}

const secretAssignmentRule: SecretPatternRule = {
  name: "secret-assignment",
  gate: ["secret", "token", "passw", "pwd", "key", "credential", "passphrase"],
  gateLower: true,
  scan(input, emit) {
    const text = input.text;
    const n = text.length;
    // Memoised maximal name-char run, so each character is scanned at most once.
    let runStart = -1;
    let runEnd = -1;
    ASSIGNMENT_KEYWORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT_KEYWORD_RE.exec(text)) !== null) {
      const kwStart = m.index;
      const kwEnd = kwStart + m[0].length;
      if (!keywordDelimited(text, kwStart, kwEnd)) continue;

      // Name = maximal run of name characters around the keyword (memoised). A JSON escape
      // such as "\n" before the name ends the run, so "\nDB_PASSWORD" names DB_PASSWORD.
      if (!(kwStart >= runStart && kwStart < runEnd)) {
        let s = kwStart;
        while (s > 0 && isNameChar(text[s - 1]) && !afterEscape(text, s)) s--;
        let e = kwEnd;
        while (e < n && isNameChar(text[e])) e++;
        runStart = s;
        runEnd = e;
      }
      const nameStart = runStart;
      const nameEnd = runEnd;
      if (nameEnd - nameStart > MAX_NAME) continue;
      const name = text.slice(nameStart, nameEnd);
      if (nameIsBenign(name, kwStart - nameStart, kwEnd - kwStart)) continue;
      const isFlag = name.startsWith("-");

      // Separator: optional closing quote (maybe JSON-escaped), Markdown emphasis, gap, then
      // '=' ':' ':=' '=>' (a '|' in a Markdown table, a space for --flags), emphasis, gap.
      let p = nameEnd;
      if (text[p] === "\\" && isQuote(text[p + 1])) p += 2;
      else if (isQuote(text[p])) p += 1;
      p = skipStars(text, p);
      let g = skipGap(text, p);
      p = g.p;
      if (text.startsWith(":=", p) || text.startsWith("=>", p)) p += 2;
      else if (text[p] === "=" || text[p] === ":") p += 1;
      else if (text[p] === "|" && inTableCell(text, nameStart)) p += 1;
      else if (!(isFlag && g.gap > 0)) continue;
      // A URL ("token://...") or a path segment is not an assignment.
      if (text[p] === "/" && text[p + 1] === "/") continue;
      p = skipStars(text, p);
      g = skipGap(text, p);
      p = skipStars(text, g.p);
      let quoted = false;
      if (text[p] === "\\" && isQuote(text[p + 1])) { p += 2; quoted = true; }
      else if (isQuote(text[p])) { p += 1; quoted = true; }

      const valueRe = quoted ? QUOTED_VALUE_RE : UNQUOTED_VALUE_RE;
      valueRe.lastIndex = p;
      const vm = valueRe.exec(text);
      if (!vm) continue;
      let valueEnd = p + vm[0].length;
      // Skip keywords inside this value whatever the verdict: keeps the scan linear.
      ASSIGNMENT_KEYWORD_RE.lastIndex = Math.max(ASSIGNMENT_KEYWORD_RE.lastIndex, valueEnd);
      if (quoted) {
        while (valueEnd > p && text[valueEnd - 1] === " ") valueEnd--;
      } else {
        // A function call is code, not a value.
        if (text[valueEnd] === "(") continue;
        // Sentence punctuation and Markdown emphasis after an unquoted value are not part of it.
        while (valueEnd > p && ".!?:*".includes(text[valueEnd - 1] as string)) valueEnd--;
      }
      const value = text.slice(p, Math.min(valueEnd, p + MAX_VALUE));
      if (!isPlausibleSecretValue(value, { strictWords: !quoted })) continue;
      // Over-long values are redacted in full: the cap only bounds validation work.
      emit(p, valueEnd);
    }
  },
};

// ---------------------------------------------------------------------------
// The ordered rule table
// ---------------------------------------------------------------------------

const hasDigit = (v: string): boolean => HAS_DIGIT_RE.test(v);

/**
 * Default rules, in the order they run. Earlier rules claim spans first; an overlapping later
 * match is merged into the earlier span (the union is redacted under the earlier rule's name).
 */
export const DEFAULT_SECRET_RULES: readonly SecretPatternRule[] = [
  privateKeyRule,

  prefixRule("anthropic-key", [`sk-ant-[${TOKEN_CHARS}]{20,}`], ["sk-ant-"]),
  prefixRule("openai-key", [`sk-(?:proj-|svcacct-|admin-)?[${TOKEN_CHARS}]{20,}`], ["sk-"], hasDigit),
  prefixRule("github-token", ["gh[pousr]_[A-Za-z0-9]{36,}", "github_pat_[A-Za-z0-9_]{22,}"], ["gh", "github_pat_"]),
  prefixRule("gitlab-token", [`gl(?:pat|dt|rt|rtr|cbt|ptt|ft|imt|oas|soat|agent|ffct|wt)-[${TOKEN_CHARS}]{20,}`], ["gl"]),
  regexRule("aws-access-key-id", `${LB_ALNUM}(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`, "", { gate: ["AKIA", "ASIA"] }),
  prefixRule("slack-token", ["xox[abeprs]-[A-Za-z0-9-]{10,}", "xapp-\\d{1,3}-[A-Za-z0-9-]{10,}"], ["xox", "xapp-"]),
  regexRule("slack-token", "hooks\\.slack\\.com/services/([A-Za-z0-9/_-]{20,})", "", { group: 1, gate: ["hooks.slack.com"] }),
  regexRule("telegram-bot-token", "(?<!\\d)\\d{8,10}:([A-Za-z0-9_-]{30,})", "", { group: 1, gate: [":"] }),
  regexRule(
    "discord-token",
    `(?:(?<![${TOKEN_CHARS}.])|${AFTER_ESCAPE})[MNO][${TOKEN_CHARS}]{23,27}\\.[${TOKEN_CHARS}]{6,7}\\.[${TOKEN_CHARS}]{27,40}(?![${TOKEN_CHARS}])`,
    "",
    { gate: ["."] },
  ),
  regexRule(
    "discord-token",
    "discord(?:app)?\\.com/api/webhooks/\\d{5,30}/([A-Za-z0-9_-]{20,})",
    "",
    { group: 1, gate: ["discord"] },
  ),
  prefixRule(
    "google-api-key",
    [`AIza[${TOKEN_CHARS}]{35}`, `ya29\\.[${TOKEN_CHARS}]{20,}`, `GOCSPX-[${TOKEN_CHARS}]{20,}`],
    ["AIza", "ya29.", "GOCSPX-"],
  ),
  prefixRule("stripe-key", ["(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}", "whsec_[A-Za-z0-9+/=]{20,}"], ["_live_", "_test_", "whsec_"]),
  prefixRule("linear-key", ["lin_(?:api|oauth)_[A-Za-z0-9]{32,}"], ["lin_"]),
  prefixRule("sentry-token", ["sntry[sua]_[A-Za-z0-9_=+/-]{20,}"], ["sntry"]),
  prefixRule(
    "vendor-prefixed",
    [
      "npm_[A-Za-z0-9]{36,}",
      `pypi-AgEI[${TOKEN_CHARS}]{50,}`,
      "hf_[A-Za-z0-9]{30,}",
      `SG\\.[${TOKEN_CHARS}]{16,32}\\.[${TOKEN_CHARS}]{16,64}`,
      "xai-[A-Za-z0-9]{30,}",
      "gsk_[A-Za-z0-9]{30,}",
      "pplx-[A-Za-z0-9]{30,}",
      "r8_[A-Za-z0-9]{30,}",
      "ntn_[A-Za-z0-9]{30,}",
      "do[opr]_v1_[a-f0-9]{64}",
      "SK[0-9a-f]{32}(?![A-Za-z0-9])",
    ],
    ["npm_", "pypi-", "hf_", "SG.", "xai-", "gsk_", "pplx-", "r8_", "ntn_", "_v1_", "SK"],
  ),
  regexRule("twilio-account-sid", `${LB_ALNUM}AC[0-9a-f]{32}(?![A-Za-z0-9])`, "", { gate: ["AC"] }),
  prefixRule("jwt", [`eyJ[${TOKEN_CHARS}]{8,}\\.eyJ[${TOKEN_CHARS}]{8,}\\.[${TOKEN_CHARS}]{10,}`], ["eyJ"]),

  regexRule(
    "auth-header",
    "\\b(?:proxy-)?authorization\\\\?[\"']?[ \\t]{0,8}[:=][ \\t]{0,8}\\\\?[\"']?[ \\t]{0,8}(?:(?:bearer|basic|token|bot|digest)[ \\t]{1,8})?([A-Za-z0-9._~+/=:-]{16,})",
    "i",
    { group: 1, gate: ["authorization"], gateLower: true, validate: (v) => !v.startsWith("«") },
  ),
  regexRule(
    "auth-header",
    `(?:(?<![A-Za-z0-9_])|${AFTER_ESCAPE})bearer[ \\t]{1,8}([A-Za-z0-9._~+/=-]{20,})`,
    "i",
    { group: 1, gate: ["bearer"], gateLower: true, validate: (v) => isPlausibleSecretValue(v, { minLength: 20, strictWords: true }) },
  ),
  regexRule(
    "url-password",
    "\\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}://[^\\s:/?#@\"'<>\\\\]{0,128}:([^\\s/?#@\"'<>\\\\]{1,256})@",
    "",
    { group: 1, gate: ["://"], validate: (v) => isPlausibleSecretValue(v, { minLength: 1, identifierCheck: false }) },
  ),
  regexRule(
    "secret-query-param",
    "[?&](?:access_token|refresh_token|id_token|auth_token|api_key|apikey|client_secret|key|token|secret|signature|sig|password)=([^&\\s#\"'<>\\\\]{8,})",
    "i",
    { group: 1, gate: ["="], validate: (v) => isPlausibleSecretValue(v, { identifierCheck: false }) },
  ),
  secretAssignmentRule,
];

/** Names of every built-in rule, for `disabledRules` validation and `/secrets status`. */
export const DEFAULT_SECRET_RULE_NAMES: readonly string[] = [...new Set(DEFAULT_SECRET_RULES.map((r) => r.name))];

// ---------------------------------------------------------------------------
// Custom patterns from config (customPatterns, allowPatterns)
// ---------------------------------------------------------------------------

/** Largest upper bound a custom pattern may use in `{n,m}`. */
export const CUSTOM_PATTERN_MAX_REPEAT = 256;
const PROBE_BUDGET_MS = 50;

interface QuantifierScan {
  error?: string;
  variable: number;
  literalPrefix: number;
}

/**
 * Walk a pattern outside character classes and classify its quantifiers. JavaScript has no
 * linear-time regex engine and no atomic groups, so custom patterns are held to a grammar
 * that cannot backtrack badly: every quantifier bounded, no quantified groups, at most one
 * variable-length quantifier, no backreferences.
 */
function scanQuantifiers(pattern: string): QuantifierScan {
  let variable = 0;
  let literalPrefix = 0;
  let prefixOpen = true;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      if (/[1-9]/.test(next) || next === "k") return { error: "backreferences are not allowed", variable, literalPrefix };
      // An escaped literal such as "\." or "\-" still counts toward the literal prefix.
      if (!inClass && prefixOpen && /[^A-Za-z0-9]/.test(next)) literalPrefix++;
      else prefixOpen = false;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") { inClass = true; prefixOpen = false; continue; }
    if (ch === "(" || ch === "|" || ch === "^" || ch === "$" || ch === ".") { prefixOpen = false; continue; }
    if (ch === ")") {
      if (/^[*+?{]/.test(pattern.slice(i + 1))) return { error: "quantified groups are not allowed", variable, literalPrefix };
      continue;
    }
    if (ch === "*" || ch === "+") {
      return { error: `unbounded quantifier "${ch}" is not allowed; use {n,m} with m <= ${CUSTOM_PATTERN_MAX_REPEAT}`, variable, literalPrefix };
    }
    if (ch === "?") {
      if (pattern[i - 1] === "(") continue; // group modifier such as (?: or (?<=
      if (prefixOpen) literalPrefix = Math.max(0, literalPrefix - 1);
      prefixOpen = false;
      variable++;
      continue;
    }
    if (ch === "{") {
      const q = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (!q) { if (prefixOpen) literalPrefix++; continue; }
      if (prefixOpen) literalPrefix = Math.max(0, literalPrefix - 1);
      prefixOpen = false;
      if (q[2] !== undefined && q[3] === "") return { error: "unbounded quantifier {n,} is not allowed", variable, literalPrefix };
      const max = Number(q[3] ?? q[1]);
      if (max > CUSTOM_PATTERN_MAX_REPEAT) return { error: `repeat bound above ${CUSTOM_PATTERN_MAX_REPEAT}`, variable, literalPrefix };
      if (q[3] !== undefined && Number(q[3]) !== Number(q[1])) variable++;
      i += q[0].length - 1;
      continue;
    }
    if (prefixOpen) literalPrefix++;
  }
  return { variable, literalPrefix };
}

/**
 * Check a `customPatterns` (requirePrefix true) or `allowPatterns` entry. Returns an error
 * message, or null. Besides the grammar above, the compiled pattern is timed against
 * adversarial input and rejected if it is slow.
 * W1B's config schema should call this in a Zod refinement so a bad pattern fails validation.
 */
export function validateScrubPattern(pattern: string, flags = "", opts?: { requirePrefix?: boolean }): string | null {
  if (pattern.length === 0) return "pattern is empty";
  if (pattern.length > 500) return "pattern is longer than 500 characters";
  if (!/^[imsu]*$/.test(flags)) return "flags may only contain i, m, s, u";
  const scan = scanQuantifiers(pattern);
  if (scan.error) return scan.error;
  if (scan.variable > 1) return "at most one variable-length quantifier ({n,m} or ?) is allowed";
  if (opts?.requirePrefix && scan.literalPrefix < 2) return "a custom secret pattern must start with at least 2 literal characters";
  let re: RegExp;
  try {
    re = new RegExp(pattern, `${flags}g`);
  } catch (err) {
    return `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (new RegExp(pattern, flags).test("")) return "pattern matches the empty string";
  const prefix = pattern.replace(/\\(.)/g, "$1").slice(0, Math.max(1, scan.literalPrefix)) || "a";
  for (const unit of [prefix, "a", "0", "-", " ", `${prefix}a`]) {
    const probe = unit.repeat(Math.ceil(65_536 / unit.length));
    const t0 = performance.now();
    re.lastIndex = 0;
    while (re.exec(probe) !== null) {
      if (performance.now() - t0 > PROBE_BUDGET_MS) return "pattern is too slow on adversarial input";
    }
    if (performance.now() - t0 > PROBE_BUDGET_MS) return "pattern is too slow on adversarial input";
  }
  return null;
}

/** Build a rule from a validated custom pattern. The whole match is redacted. */
export function customSecretRule(name: string, pattern: string, flags = ""): SecretPatternRule {
  return regexRule(name, pattern, flags);
}
