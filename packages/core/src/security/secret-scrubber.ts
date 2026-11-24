/**
 * SecretScrubber: one module, used by the daemon and the stdio MCP subprocess (PLAN B.8, C.12).
 *
 * Two passes per call, both computed on the original text:
 *   1. Known values (registered with addKnownSecret), longest first, in raw, URL-encoded,
 *      base64 (standard and url-safe) and JSON-escaped forms.
 *   2. The ordered pattern rules in secret-patterns.ts.
 * Each finding claims a span; a later finding that overlaps a claimed span is dropped. The
 * output replaces each span with `«redacted:<rule>»`. Markers match no rule, so scrubbing is
 * idempotent, and text without findings is returned unchanged (the same string).
 *
 * The scrubber never throws. If the pattern pass fails the known-value result is used; if
 * both fail the whole text is replaced by SCRUB_WITHHELD (fail closed).
 *
 * `enabled` is fixed when the scrubber is constructed. configureScrubber() honours only its
 * first call, so a config hot-reload or a runtime setting can never turn scrubbing off.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { createModuleLogger } from "../logging/logger.js";
import {
  DEFAULT_SECRET_RULES,
  customSecretRule,
  isPlausibleSecretValue,
  isSecretAssignmentName,
  validateScrubPattern,
  type SecretPatternRule,
  type SecretScanInput,
} from "./secret-patterns.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScrubSink =
  | "channel" | "log" | "memory" | "chat-history" | "task-result" | "heartbeat-log"
  | "http" | "audit" | "prompt-card" | "webhook-payload" | "plugin-event" | "proposal" | "model-input";

export interface ScrubOptions {
  sink?: ScrubSink;
  /** Exact values allowed through for this call (a deliberate reveal to the owner). */
  allow?: ReadonlySet<string>;
}

/** A finding never carries the value, only where it is and a keyed fingerprint of it. */
export interface ScrubFinding {
  rule: string;
  start: number;
  end: number;
  fingerprint: string;
}

/** Sink switches, named as in the `security.scrubbing.sinks` config section (R3 item 12). */
export interface ScrubbingSinksConfig {
  channels?: boolean;
  logs?: boolean;
  memory?: boolean;
  chatHistory?: boolean;
  taskResults?: boolean;
  heartbeatLogs?: boolean;
  http?: boolean;
  webhookPayloads?: boolean;
  pluginEvents?: boolean;
  toolOutputToModel?: boolean;
}

/**
 * Input shape of `security.scrubbing` (every key optional, defaults applied here).
 * The Zod schema lives in the config section W1B adds; its output type is assignable to this.
 */
export interface ScrubbingConfig {
  enabled?: boolean;
  sinks?: ScrubbingSinksConfig;
  knownSecrets?: {
    credentialStore?: boolean;
    config?: boolean;
    env?: boolean;
    secretsDir?: boolean;
    minLength?: number;
  };
  disabledRules?: readonly string[];
  customPatterns?: ReadonlyArray<{ name: string; pattern: string; flags?: string }>;
  allowPatterns?: readonly string[];
  mask?: "label" | "partial";
}

/** Internal knobs, for tests and for callers that need extra rules. Not part of the config. */
export interface ScrubberInternals {
  /** Replaces the default rule table. */
  rules?: readonly SecretPatternRule[];
}

/** What a sink receives when both passes fail. Never the raw text. */
export const SCRUB_WITHHELD = "«message withheld: scrubber error»";

/** Rule name used for known-secret findings. */
export const KNOWN_SECRET_RULE = "known-secret";
/** `mask: "partial"` shows the first and last 4 characters only of values at least this long. */
export const PARTIAL_MASK_MIN_CHARS = 32;

export function redactionMarker(rule: string): string {
  return `«redacted:${rule}»`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Which config switch governs each sink. Sinks not listed are always scrubbed. */
const SINK_SWITCH: Partial<Record<ScrubSink, keyof ScrubbingSinksConfig>> = {
  channel: "channels",
  log: "logs",
  memory: "memory",
  "chat-history": "chatHistory",
  "task-result": "taskResults",
  "heartbeat-log": "heartbeatLogs",
  http: "http",
  "webhook-payload": "webhookPayloads",
  "plugin-event": "pluginEvents",
};

interface KnownForm {
  form: string;
  raw: string;
}

interface Span {
  start: number;
  end: number;
  rule: string;
  /** Union-find parent: overlapping findings are merged into the earliest claimed span. */
  parent: number;
}

/** Owner value for characters inside a marker that was already in the text. */
const OWNER_MARKER = -1;

const DEEP_MAX_DEPTH = 10;
const DEEP_MAX_NODES = 10_000;
const TRUNCATED = "[Truncated]";
const CIRCULAR = "[Circular]";

let diagLog: Logger | undefined;
function diag(): Logger {
  // Lazy: logger.ts imports this module, so the logger cannot be created at module load.
  diagLog ??= createModuleLogger("secret-scrubber");
  return diagLog;
}

/**
 * Log after the current call stack. Used where the process-wide scrubber may still be under
 * construction: logging synchronously there would re-enter getScrubber() from the log sink.
 */
function deferredWarn(obj: Record<string, unknown>, msg: string): void {
  queueMicrotask(() => {
    try {
      diag().warn(obj, msg);
    } catch {
      // diagnostics only
    }
  });
}

/** Existing markers are claimed up front so no rule can match inside or across one. */
const EXISTING_MARKER_RE = /«(?:redacted|message withheld)[^«»\n]{0,200}»/g;

function isMixedLettersAndDigits(v: string): boolean {
  return /[A-Za-z]/.test(v) && /\d/.test(v);
}

function base64Url(v: string): string {
  return Buffer.from(v, "utf8").toString("base64url");
}

export class SecretScrubber {
  private readonly enabled: boolean;
  private readonly sinks: Required<ScrubbingSinksConfig>;
  private readonly minKnownLength: number;
  private readonly rules: readonly SecretPatternRule[];
  private readonly assignmentRuleActive: boolean;
  private readonly allowPatterns: readonly RegExp[];
  private readonly mask: "label" | "partial";
  private readonly known = new Map<string, { label: string; forms: string[] }>();
  private knownForms: KnownForm[] = [];
  private readonly bySink: Record<string, number> = {};
  private readonly byRule: Record<string, number> = {};
  private readonly fingerprintKey = randomBytes(32);

  constructor(cfg?: ScrubbingConfig, internals?: ScrubberInternals) {
    this.enabled = cfg?.enabled ?? true;
    const s = cfg?.sinks ?? {};
    this.sinks = {
      channels: s.channels ?? true,
      logs: s.logs ?? true,
      memory: s.memory ?? true,
      chatHistory: s.chatHistory ?? true,
      taskResults: s.taskResults ?? true,
      heartbeatLogs: s.heartbeatLogs ?? true,
      http: s.http ?? true,
      webhookPayloads: s.webhookPayloads ?? true,
      pluginEvents: s.pluginEvents ?? true,
      toolOutputToModel: s.toolOutputToModel ?? false,
    };
    this.minKnownLength = cfg?.knownSecrets?.minLength ?? 12;
    this.mask = cfg?.mask ?? "label";

    const disabled = new Set(cfg?.disabledRules ?? []);
    const rules: SecretPatternRule[] = (internals?.rules ?? DEFAULT_SECRET_RULES).filter((r) => !disabled.has(r.name));
    this.assignmentRuleActive = rules.some((r) => r.name === "secret-assignment");
    for (const cp of cfg?.customPatterns ?? []) {
      const error = validateScrubPattern(cp.pattern, cp.flags ?? "", { requirePrefix: true });
      if (error) {
        deferredWarn({ rule: cp.name, error }, "custom scrub pattern rejected");
        continue;
      }
      if (!disabled.has(cp.name)) rules.push(customSecretRule(cp.name, cp.pattern, cp.flags ?? ""));
    }
    this.rules = rules;

    const allow: RegExp[] = [];
    for (const ap of cfg?.allowPatterns ?? []) {
      const error = validateScrubPattern(ap);
      if (error) {
        deferredWarn({ error }, "scrub allow pattern rejected");
        continue;
      }
      allow.push(new RegExp(`^(?:${ap})$`));
    }
    this.allowPatterns = allow;
  }

  /** True when scrubbing is on. Fixed for the life of this instance. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether a sink is scrubbed under this configuration. */
  isSinkEnabled(sink?: ScrubSink): boolean {
    if (!this.enabled) return false;
    if (!sink) return true;
    const key = SINK_SWITCH[sink];
    return key ? this.sinks[key] : true;
  }

  // -- Known secrets ---------------------------------------------------------

  /**
   * Register a value the process holds (credential, config secret, env value). It is matched
   * by exact substring in raw, URL-encoded, base64 and JSON-escaped form. Values shorter than
   * `knownSecrets.minLength` (default 12) are skipped unless they are 8+ characters and mix
   * letters and digits; the label of a skipped value is logged, never the value.
   */
  addKnownSecret(value: string, label: string): void {
    try {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      const accepted = trimmed.length >= this.minKnownLength ||
        (trimmed.length >= 8 && isMixedLettersAndDigits(trimmed));
      if (!accepted) {
        diag().info({ label }, "known secret too short to match safely; not registered");
        return;
      }
      const forms = new Set<string>([value, trimmed]);
      forms.add(encodeURIComponent(trimmed));
      forms.add(Buffer.from(trimmed, "utf8").toString("base64"));
      forms.add(Buffer.from(trimmed, "utf8").toString("base64").replace(/=+$/, ""));
      forms.add(base64Url(trimmed));
      forms.add(JSON.stringify(trimmed).slice(1, -1));
      const list = [...forms].filter((f) => f.length >= 8);
      this.known.set(value, { label, forms: list });
      this.rebuildKnownForms();
    } catch (err) {
      diag().error({ label, err: errorSummary(err) }, "failed to register known secret");
    }
  }

  removeKnownSecret(value: string): void {
    if (this.known.delete(value)) this.rebuildKnownForms();
  }

  /** Labels of the registered known secrets (never values), for `/secrets status`. */
  knownSecretLabels(): string[] {
    return [...this.known.values()].map((k) => k.label);
  }

  private rebuildKnownForms(): void {
    const forms: KnownForm[] = [];
    const seen = new Set<string>();
    for (const [raw, entry] of this.known) {
      for (const form of entry.forms) {
        if (seen.has(form)) continue;
        seen.add(form);
        forms.push({ form, raw });
      }
    }
    forms.sort((a, b) => b.form.length - a.form.length);
    this.knownForms = forms;
  }

  // -- Scrubbing -------------------------------------------------------------

  scrub(text: string, opts?: ScrubOptions): string {
    return this.scrubWithCount(text, opts).text;
  }

  scrubWithCount(text: string, opts?: ScrubOptions): { text: string; count: number; rules: Record<string, number> } {
    if (typeof text !== "string" || text.length === 0 || !this.isSinkEnabled(opts?.sink)) {
      return { text, count: 0, rules: {} };
    }
    try {
      const spans = this.findSpans(text, opts?.allow, opts?.sink === "log", opts?.sink);
      if (spans === null) return this.withheld();
      if (spans.length === 0) return { text, count: 0, rules: {} };
      const out = this.render(text, spans);
      const rules: Record<string, number> = {};
      for (const s of spans) rules[s.rule] = (rules[s.rule] ?? 0) + 1;
      this.record(opts?.sink, rules, spans.length);
      return { text: out, count: spans.length, rules };
    } catch (err) {
      this.reportFailure(err, opts?.sink);
      return this.withheld();
    }
  }

  /**
   * Scrub every string in a value: objects, arrays, Map, Set and Error (message, stack, cause
   * and own properties). Returns a copy; the input is never mutated. Depth is capped at 10 and
   * the number of visited nodes at 10 000; cycles become "[Circular]".
   */
  scrubDeep<T>(value: T, opts?: ScrubOptions): T {
    if (!this.isSinkEnabled(opts?.sink)) return value;
    try {
      const state = { nodes: 0, seen: new WeakMap<object, unknown>() };
      return this.deep(value, opts, 0, state) as T;
    } catch (err) {
      this.reportFailure(err, opts?.sink);
      return SCRUB_WITHHELD as unknown as T;
    }
  }

  /**
   * Report what would be redacted, without changing anything. Ignores `enabled` and sink
   * switches (used by `/secrets scan`), honours `disabledRules` and `allowPatterns`.
   * The fingerprint is the first 16 hex chars of an HMAC-SHA256 under `fingerprintKey`
   * (default: a random per-process key), so equal secrets share a fingerprint.
   */
  detect(text: string, opts?: { fingerprintKey?: string | Buffer }): ScrubFinding[] {
    if (typeof text !== "string" || text.length === 0) return [];
    try {
      const spans = this.findSpans(text, undefined, false) ?? [];
      const key = opts?.fingerprintKey ?? this.fingerprintKey;
      return spans.map((s) => ({
        rule: s.rule,
        start: s.start,
        end: s.end,
        fingerprint: createHmac("sha256", key).update(text.slice(s.start, s.end)).digest("hex").slice(0, 16),
      }));
    } catch (err) {
      this.reportFailure(err, undefined);
      return [];
    }
  }

  /** Register this scrubber's known secrets on another one (values never leave the two scrubbers). */
  transferKnownSecretsTo(target: SecretScrubber): void {
    for (const [value, { label }] of this.known) target.addKnownSecret(value, label);
  }

  stats(): { bySink: Record<string, number>; byRule: Record<string, number>; knownSecrets: number } {
    return { bySink: { ...this.bySink }, byRule: { ...this.byRule }, knownSecrets: this.known.size };
  }

  // -- Internals -------------------------------------------------------------

  /**
   * Returns the claimed spans sorted by start, or null when both passes failed.
   * `quiet` suppresses diagnostics: the log sink must never log from inside a log write.
   */
  private findSpans(text: string, allow: ReadonlySet<string> | undefined, quiet: boolean, sink?: ScrubSink): Span[] | null {
    const spans: Span[] = [];
    // owner[i]: 0 = free, OWNER_MARKER = inside an existing marker, k + 1 = claimed by span k.
    let owner: Int32Array | null = null;
    const find = (k: number): number => {
      while (spans[k]!.parent !== k) {
        const grand = spans[spans[k]!.parent]!.parent;
        spans[k]!.parent = grand;
        k = grand;
      }
      return k;
    };
    const claim = (start: number, end: number, rule: string): void => {
      if (end <= start) return;
      const value = text.slice(start, end);
      if (allow?.has(value)) return;
      for (const re of this.allowPatterns) if (re.test(value)) return;
      owner ??= new Int32Array(text.length);
      // Overlap with an earlier finding: merge into the union, so no part of either leaks and
      // a second pass finds nothing new. The union keeps the earliest finding's rule.
      const roots = new Set<number>();
      let last = 0;
      for (let i = start; i < end; i++) {
        const o = owner[i]!;
        if (o === OWNER_MARKER) return;
        if (o > 0 && o !== last) {
          roots.add(find(o - 1));
          last = o;
        }
      }
      if (roots.size === 0) {
        const id = spans.length;
        spans.push({ start, end, rule, parent: id });
        owner.fill(id + 1, start, end);
        return;
      }
      const root = Math.min(...roots);
      const target = spans[root]!;
      for (const r of roots) {
        if (r === root) continue;
        const other = spans[r]!;
        other.parent = root;
        target.start = Math.min(target.start, other.start);
        target.end = Math.max(target.end, other.end);
      }
      target.start = Math.min(target.start, start);
      target.end = Math.max(target.end, end);
      for (let i = start; i < end; i++) if (owner[i] === 0) owner[i] = root + 1;
    };

    if (text.includes("«")) {
      EXISTING_MARKER_RE.lastIndex = 0;
      let mm: RegExpExecArray | null;
      while ((mm = EXISTING_MARKER_RE.exec(text)) !== null) {
        owner ??= new Int32Array(text.length);
        owner.fill(OWNER_MARKER, mm.index, mm.index + mm[0].length);
      }
    }

    let knownFailed = false;
    try {
      for (const { form, raw } of this.knownForms) {
        if (allow?.has(raw)) continue;
        let idx = text.indexOf(form);
        while (idx !== -1) {
          claim(idx, idx + form.length, KNOWN_SECRET_RULE);
          idx = text.indexOf(form, idx + form.length);
        }
      }
    } catch (err) {
      knownFailed = true;
      if (!quiet) diag().error({ err: errorSummary(err) }, "scrubber known-secret pass failed");
    }

    let patternFailed = false;
    const lowerCache: { v?: string } = {};
    const input: SecretScanInput = {
      text,
      lower: () => (lowerCache.v ??= text.toLowerCase()),
      ...(sink !== undefined ? { sink } : {}),
    };
    for (const rule of this.rules) {
      try {
        if (rule.gate && rule.gate.length > 0) {
          const hay = rule.gateLower ? input.lower() : text;
          if (!rule.gate.some((g) => hay.includes(g))) continue;
        }
        rule.scan(input, (start, end) => claim(start, end, rule.name));
      } catch (err) {
        patternFailed = true;
        if (!quiet) diag().error({ rule: rule.name, err: errorSummary(err) }, "scrubber rule failed");
      }
    }

    if (knownFailed && patternFailed) return null;
    const roots = spans.filter((sp, i) => sp.parent === i);
    roots.sort((a, b) => a.start - b.start);
    return roots;
  }

  private render(text: string, spans: readonly Span[]): string {
    let out = "";
    let pos = 0;
    for (const s of spans) {
      out += text.slice(pos, s.start);
      out += this.markerFor(s.rule, text.slice(s.start, s.end));
      pos = s.end;
    }
    return out + text.slice(pos);
  }

  private markerFor(rule: string, value: string): string {
    // SCRUB-N9: 8 revealed characters are only acceptable on long, random pattern matches;
    // a known value (a password from the credential store) is never partly shown.
    if (this.mask === "partial" && rule !== KNOWN_SECRET_RULE && value.length >= PARTIAL_MASK_MIN_CHARS && !/[\s«»]/.test(value)) {
      return `«redacted:${rule}:${value.slice(0, 4)}…${value.slice(-4)}»`;
    }
    return redactionMarker(rule);
  }

  private record(sink: ScrubSink | undefined, rules: Record<string, number>, count: number): void {
    const sinkKey = sink ?? "unspecified";
    this.bySink[sinkKey] = (this.bySink[sinkKey] ?? 0) + count;
    for (const [rule, n] of Object.entries(rules)) this.byRule[rule] = (this.byRule[rule] ?? 0) + n;
    // The log sink must not log about itself (the line is being written right now).
    if (sink !== "log") diag().info({ sink: sinkKey, count, rules }, "secrets redacted");
  }

  private withheld(): { text: string; count: number; rules: Record<string, number> } {
    return { text: SCRUB_WITHHELD, count: 1, rules: { "scrubber-error": 1 } };
  }

  private reportFailure(err: unknown, sink: ScrubSink | undefined): void {
    if (sink === "log") return;
    try {
      diag().error({ sink, err: errorSummary(err) }, "scrubber failed; output withheld");
    } catch {
      // Logging must never turn a scrubber failure into a throw.
    }
  }

  private deep(value: unknown, opts: ScrubOptions | undefined, depth: number, state: { nodes: number; seen: WeakMap<object, unknown> }): unknown {
    if (typeof value === "string") return this.scrub(value, opts);
    if (value === null || typeof value !== "object") return value;
    if (state.seen.has(value)) return CIRCULAR;
    if (depth >= DEEP_MAX_DEPTH || ++state.nodes > DEEP_MAX_NODES) return TRUNCATED;

    if (value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      state.seen.set(value, out);
      for (const item of value) out.push(this.deep(item, opts, depth + 1, state));
      return out;
    }
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      state.seen.set(value, out);
      for (const [k, v] of value) {
        const field = typeof k === "string" ? this.deepField(k, v, opts, depth, state) : this.deep(v, opts, depth + 1, state);
        out.set(this.deep(k, opts, depth + 1, state), field);
      }
      return out;
    }
    if (value instanceof Set) {
      const out = new Set<unknown>();
      state.seen.set(value, out);
      for (const v of value) out.add(this.deep(v, opts, depth + 1, state));
      return out;
    }
    if (value instanceof Error) {
      const out = Object.create(Object.getPrototypeOf(value) as object) as Record<string, unknown>;
      state.seen.set(value, out);
      const define = (key: string, v: unknown): void => {
        Object.defineProperty(out, key, { value: v, writable: true, configurable: true, enumerable: false });
      };
      define("name", value.name);
      define("message", this.scrub(value.message, opts));
      if (value.stack !== undefined) define("stack", this.scrub(value.stack, opts));
      if ("cause" in value && value.cause !== undefined) define("cause", this.deep(value.cause, opts, depth + 1, state));
      for (const key of Object.keys(value)) {
        out[this.scrub(key, opts)] = this.deepField(key, (value as unknown as Record<string, unknown>)[key], opts, depth, state);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    state.seen.set(value, out);
    for (const key of Object.keys(value)) {
      out[this.scrub(key, opts)] = this.deepField(key, (value as Record<string, unknown>)[key], opts, depth, state);
    }
    return out;
  }

  /**
   * A field value. A string under a secret-looking key (`apiKey`, `DB_PASSWORD`) is judged
   * with its key, as the `secret-assignment` rule would judge `key: "value"` in text.
   */
  private deepField(key: string, v: unknown, opts: ScrubOptions | undefined, depth: number, state: { nodes: number; seen: WeakMap<object, unknown> }): unknown {
    if (typeof v === "string" && this.assignmentRuleActive && isSecretAssignmentName(key) && isPlausibleSecretValue(v)
      && !opts?.allow?.has(v) && !this.allowPatterns.some((re) => re.test(v))) {
      this.record(opts?.sink, { "secret-assignment": 1 }, 1);
      return this.markerFor("secret-assignment", v);
    }
    return this.deep(v, opts, depth + 1, state);
  }
}

/** A loggable summary of an error that cannot itself leak (message is scrubbed by the log sink). */
function errorSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let instance: SecretScrubber | null = null;
let configured = false;

function configFromEnv(): ScrubbingConfig | undefined {
  const raw = process.env.KIRIE_SCRUB_CONFIG;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ScrubbingConfig;
  } catch {
    // fall through to defaults
  }
  deferredWarn({}, "KIRIE_SCRUB_CONFIG is not a JSON object; using default scrubbing config");
  return undefined;
}

/**
 * Configure the process-wide scrubber. Call once at startup. Later calls are ignored (and
 * logged), which is what freezes `enabled` against config hot-reloads. Known secrets added
 * to an earlier unconfigured instance are carried over.
 */
export function configureScrubber(cfg: ScrubbingConfig): SecretScrubber {
  if (configured && instance) {
    diag().warn("configureScrubber called again; scrubbing settings are fixed at startup, ignoring");
    return instance;
  }
  const next = new SecretScrubber(cfg);
  instance?.transferKnownSecretsTo(next);
  instance = next;
  configured = true;
  if (!next.isEnabled()) {
    diag().warn("secret scrubbing is DISABLED by config (security.scrubbing.enabled: false)");
  }
  return next;
}

/**
 * The process-wide scrubber. Works with no configuration: default rules, every sink on.
 * In a subprocess started with KIRIE_SCRUB_CONFIG (non-secret JSON of security.scrubbing),
 * that config is used until configureScrubber is called.
 */
export function getScrubber(): SecretScrubber {
  instance ??= new SecretScrubber(configFromEnv());
  return instance;
}

export function scrubSecrets(text: string, opts?: ScrubOptions): string {
  try {
    return getScrubber().scrub(text, opts);
  } catch {
    return SCRUB_WITHHELD;
  }
}

export function scrubSecretsWithCount(text: string, opts?: ScrubOptions): { text: string; count: number } {
  try {
    const r = getScrubber().scrubWithCount(text, opts);
    return { text: r.text, count: r.count };
  } catch {
    return { text: SCRUB_WITHHELD, count: 1 };
  }
}

/** Test helper: drop the singleton so the next getScrubber/configureScrubber starts fresh. */
export function resetScrubberForTesting(): void {
  instance = null;
  configured = false;
}
