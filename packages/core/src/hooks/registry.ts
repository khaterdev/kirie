import { randomUUID } from "node:crypto";
import type {
  BeforeMessageEvent,
  HookEvent,
  HookEventType,
  HookHandler,
  HookMode,
  HookRegistration,
} from "./types.js";
import { createModuleLogger } from "../logging/logger.js";
import { getScrubber, scrubSecrets } from "../security/secret-scrubber.js";

const log = createModuleLogger("hook-registry");

export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
export const DEFAULT_MAX_QUEUED_EVENTS = 100;
/** A transform may not grow the message beyond this many characters. */
export const MAX_TRANSFORMED_TEXT_CHARS = 200_000;

/** Bounds on the copy of an event handed to a plugin. */
export interface HookPayloadLimits {
  maxStringChars: number;
  maxArrayItems: number;
  maxKeys: number;
  maxDepth: number;
  /** Total values copied; anything past this becomes "[size limit]" */
  maxNodes: number;
}

export const DEFAULT_HOOK_PAYLOAD_LIMITS: HookPayloadLimits = {
  maxStringChars: 8_000,
  maxArrayItems: 100,
  maxKeys: 100,
  maxDepth: 6,
  maxNodes: 2_000,
};

export interface HookRegistryOptions {
  /** Per-handler timeout, and the total budget of one awaited transform. Default 2000 */
  hookTimeoutMs?: number;
  /** Errors or timeouts in a row that suspend a plugin's hooks. Default 5 */
  maxConsecutiveFailures?: number;
  /** Depth of each plugin's observer queue; the oldest event is dropped when full. Default 100 */
  maxQueuedEventsPerPlugin?: number;
  /** Secret scrubbing of every payload. Default true */
  scrubPayloads?: boolean;
  payloadLimits?: Partial<HookPayloadLimits>;
  /** Called once when a plugin is suspended by the circuit breaker. */
  onSuspend?: (pluginName: string, info: { consecutiveFailures: number; lastError: string }) => void;
}

export interface HookHealth {
  consecutiveFailures: number;
  totalFailures: number;
  /** Observer events dropped because the plugin's queue was full */
  dropped: number;
  suspended: boolean;
  lastError?: string;
  queued: number;
}

interface Lane {
  queue: Array<() => Promise<void>>;
  running: Promise<void> | null;
}

interface MutableHealth {
  consecutiveFailures: number;
  totalFailures: number;
  dropped: number;
  suspended: boolean;
  lastError?: string;
}

class HookTimeoutError extends Error {
  constructor(ms: number) {
    super(`hook timed out after ${ms}ms`);
    this.name = "HookTimeoutError";
  }
}

/**
 * HookRegistry: the hardened dispatcher for plugin hooks (PLAN C.15).
 *
 * - Every handler gets its own deep-frozen copy of a scrubbed, size-capped
 *   payload, so a handler can neither mutate what the host or another plugin
 *   sees nor receive a secret the scrubber knows.
 * - Observer events (`emit`) return at once. Handlers run later, one at a time
 *   per plugin, on a bounded queue (the oldest event is dropped when full).
 * - The one awaited event is the `beforeMessage` transform. Each handler has a
 *   timeout and the whole chain has a total budget; when either runs out the
 *   remaining handlers are skipped and the text so far continues. A transform
 *   can only change `text`, and it receives the raw message text (it was
 *   approved to rewrite it); its other fields are scrubbed like any payload.
 * - A throw, a rejection or a timeout counts as a failure. After
 *   `maxConsecutiveFailures` in a row the plugin is suspended until `resume`.
 * - A timed-out handler keeps running in the background: in-process code cannot
 *   be stopped, and a synchronous infinite loop freezes the daemon.
 */
export class HookRegistry {
  private hooks = new Map<HookEventType, HookRegistration[]>();
  private readonly lanes = new Map<string, Lane>();
  private readonly health = new Map<string, MutableHealth>();
  private readonly timeoutMs: number;
  private readonly maxFailures: number;
  private readonly maxQueued: number;
  private readonly scrubPayloads: boolean;
  private readonly limits: HookPayloadLimits;
  private readonly onSuspend?: HookRegistryOptions["onSuspend"];

  constructor(options: HookRegistryOptions = {}) {
    this.timeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    this.maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.maxQueued = options.maxQueuedEventsPerPlugin ?? DEFAULT_MAX_QUEUED_EVENTS;
    this.scrubPayloads = options.scrubPayloads ?? true;
    this.limits = { ...DEFAULT_HOOK_PAYLOAD_LIMITS, ...options.payloadLimits };
    this.onSuspend = options.onSuspend;
  }

  /**
   * Register a handler. `mode: "transform"` is accepted only for `beforeMessage`.
   * Returns a disposer.
   */
  register<T extends HookEventType>(
    eventType: T,
    handler: HookHandler<T>,
    options: { priority?: number; pluginName?: string; mode?: HookMode } = {},
  ): () => void {
    if (typeof handler !== "function") throw new Error(`hook handler for ${eventType} must be a function`);
    const mode = options.mode ?? "observe";
    if (mode === "transform" && eventType !== "beforeMessage") {
      throw new Error(`only beforeMessage hooks may transform (got ${eventType})`);
    }
    const registration: HookRegistration<T> = {
      id: randomUUID(),
      eventType,
      handler,
      priority: options.priority ?? 100,
      mode,
      ...(options.pluginName ? { pluginName: options.pluginName } : {}),
    };
    // Replace the list so a dispatch already iterating keeps its own snapshot.
    const list = [...(this.hooks.get(eventType) ?? []), registration as unknown as HookRegistration];
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(eventType, list);
    return () => { this.unregister(registration.id); };
  }

  unregister(id: string): boolean {
    for (const [eventType, list] of this.hooks) {
      const reg = list.find((h) => h.id === id);
      if (!reg) continue;
      const rest = list.filter((h) => h.id !== id);
      if (rest.length === 0) this.hooks.delete(eventType);
      else this.hooks.set(eventType, rest);
      if (!reg.pluginName) this.forgetLane(laneKey(reg));
      return true;
    }
    return false;
  }

  /** Remove every hook of a plugin, its queued events and its failure record. */
  unregisterPlugin(pluginName: string): number {
    let removed = 0;
    for (const [eventType, list] of this.hooks) {
      const rest = list.filter((h) => h.pluginName !== pluginName);
      removed += list.length - rest.length;
      if (rest.length === 0) this.hooks.delete(eventType);
      else this.hooks.set(eventType, rest);
    }
    this.forgetLane(`plugin:${pluginName}`);
    return removed;
  }

  /** Lift a suspension and reset the failure counters. */
  resume(pluginName: string): void {
    this.health.delete(`plugin:${pluginName}`);
  }

  isSuspended(pluginName: string): boolean {
    return this.health.get(`plugin:${pluginName}`)?.suspended ?? false;
  }

  stats(pluginName: string): HookHealth {
    const key = `plugin:${pluginName}`;
    const h = this.health.get(key);
    return {
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      totalFailures: h?.totalFailures ?? 0,
      dropped: h?.dropped ?? 0,
      suspended: h?.suspended ?? false,
      ...(h?.lastError ? { lastError: h.lastError } : {}),
      queued: this.lanes.get(key)?.queue.length ?? 0,
    };
  }

  /** Registered hooks for an event (or all), counting suspended plugins too. */
  count(eventType?: HookEventType): number {
    if (eventType) return this.hooks.get(eventType)?.length ?? 0;
    let total = 0;
    for (const list of this.hooks.values()) total += list.length;
    return total;
  }

  /** True when at least one non-suspended handler would receive this event. */
  hasSubscribers(eventType: HookEventType, mode?: HookMode): boolean {
    return (this.hooks.get(eventType) ?? []).some(
      (r) => (mode === undefined || r.mode === mode) && !this.isLaneSuspended(laneKey(r)),
    );
  }

  /** Remove everything, including queued events and failure records. */
  clear(): void {
    this.hooks.clear();
    for (const lane of this.lanes.values()) lane.queue.length = 0;
    this.lanes.clear();
    this.health.clear();
  }

  /**
   * Hand an event to its observers and return at once. Nothing a handler does
   * can delay, change or fail the caller.
   */
  emit(event: HookEvent): void {
    const list = (this.hooks.get(event.type) ?? []).filter((r) => r.mode === "observe");
    if (list.length === 0) return;
    const payload = this.preparePayload(event);
    if (payload === null) return;
    for (const reg of list) {
      const key = laneKey(reg);
      if (this.isLaneSuspended(key)) continue;
      this.enqueue(key, async () => {
        await this.invoke(reg, frozenCopy(payload));
      });
    }
  }

  /**
   * Run the `beforeMessage` transforms in priority order under the budget and
   * return the event with the resulting text. Identity fields always come from
   * the original event. Never throws.
   */
  async transformMessage(event: BeforeMessageEvent): Promise<BeforeMessageEvent> {
    const list = (this.hooks.get("beforeMessage") ?? []).filter((r) => r.mode === "transform");
    if (list.length === 0) return event;
    const deadline = Date.now() + this.timeoutMs;
    let text = event.text;
    for (const reg of list) {
      const key = laneKey(reg);
      if (this.isLaneSuspended(key)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn({ plugin: reg.pluginName ?? "anonymous" }, "transform budget spent; remaining beforeMessage hooks skipped");
        break;
      }
      // A transform plugin was approved to rewrite the message, so it gets the
      // message text as is (not truncated, not scrubbed: a scrubbed or cut text
      // would be handed back to the agent). Every other field is prepared as usual.
      const payload = this.preparePayload({ ...event, text: "" });
      if (payload === null) break;
      const input = deepFreeze({ ...structuredClone(payload), text }) as unknown as BeforeMessageEvent;
      const result = await this.invoke(reg, input, Math.min(remaining, this.timeoutMs));
      if (!result.ok) continue;
      const replacement = readTransformText(result.value);
      if (replacement !== null) text = replacement.slice(0, MAX_TRANSFORMED_TEXT_CHARS);
    }
    return { ...event, text };
  }

  /** Convenience: transform (for beforeMessage), then emit to observers. Returns the final event. */
  async dispatch<E extends HookEvent>(event: E): Promise<E> {
    if (event.type === "beforeMessage") {
      const out = (await this.transformMessage(event)) as E;
      this.emit(out);
      return out;
    }
    this.emit(event);
    return event;
  }

  /** Resolves when every observer queue is empty and idle. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const running = [...this.lanes.values()].map((l) => l.running).filter((p): p is Promise<void> => p !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private preparePayload(event: HookEvent): Record<string, unknown> | null {
    try {
      const bounded = boundPayload(event, this.limits);
      const scrubbed = this.scrubPayloads ? getScrubber().scrubDeep(bounded, { sink: "plugin-event" }) : bounded;
      if (scrubbed === null || typeof scrubbed !== "object" || Array.isArray(scrubbed)) return null;
      return scrubbed as Record<string, unknown>;
    } catch (err) {
      log.warn({ event: event.type, err: errorText(err) }, "hook payload could not be prepared; event not delivered");
      return null;
    }
  }

  private enqueue(key: string, task: () => Promise<void>): void {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { queue: [], running: null };
      this.lanes.set(key, lane);
    }
    if (lane.queue.length >= this.maxQueued) {
      lane.queue.shift();
      this.healthOf(key).dropped += 1;
    }
    lane.queue.push(task);
    if (!lane.running) lane.running = this.drain(key, lane);
  }

  private async drain(key: string, lane: Lane): Promise<void> {
    // Start on a later turn of the event loop, so no handler code runs inside emit().
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      const task = lane.queue.shift();
      if (!task) break;
      if (this.isLaneSuspended(key)) {
        lane.queue.length = 0;
        break;
      }
      await task();
    }
    lane.running = null;
  }

  private async invoke(
    reg: HookRegistration,
    payload: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const key = laneKey(reg);
    try {
      const value = await withTimeout(() => (reg.handler as (e: unknown) => unknown)(payload), timeoutMs);
      this.recordSuccess(key);
      return { ok: true, value };
    } catch (err) {
      this.recordFailure(key, reg, err);
      return { ok: false };
    }
  }

  private recordSuccess(key: string): void {
    const h = this.health.get(key);
    if (h) h.consecutiveFailures = 0;
  }

  private recordFailure(key: string, reg: HookRegistration, err: unknown): void {
    const h = this.healthOf(key);
    h.consecutiveFailures += 1;
    h.totalFailures += 1;
    h.lastError = scrubSecrets(errorText(err), { sink: "log" }).slice(0, 200);
    const plugin = reg.pluginName ?? "anonymous";
    // One warning per failure streak start, then debug, so a broken hook cannot flood the log.
    if (h.consecutiveFailures === 1) {
      log.warn({ plugin, event: reg.eventType, err: h.lastError }, "plugin hook failed");
    } else {
      log.debug({ plugin, event: reg.eventType, err: h.lastError, streak: h.consecutiveFailures }, "plugin hook failed again");
    }
    if (!h.suspended && h.consecutiveFailures >= this.maxFailures) {
      h.suspended = true;
      const lane = this.lanes.get(key);
      if (lane) lane.queue.length = 0;
      log.warn({ plugin, failures: h.consecutiveFailures }, "plugin hooks suspended after repeated failures");
      if (reg.pluginName && this.onSuspend) {
        try {
          this.onSuspend(reg.pluginName, { consecutiveFailures: h.consecutiveFailures, lastError: h.lastError });
        } catch (cbErr) {
          log.warn({ plugin, err: errorText(cbErr) }, "onSuspend callback failed (ignored)");
        }
      }
    }
  }

  private healthOf(key: string): MutableHealth {
    let h = this.health.get(key);
    if (!h) {
      h = { consecutiveFailures: 0, totalFailures: 0, dropped: 0, suspended: false };
      this.health.set(key, h);
    }
    return h;
  }

  private isLaneSuspended(key: string): boolean {
    return this.health.get(key)?.suspended ?? false;
  }

  private forgetLane(key: string): void {
    const lane = this.lanes.get(key);
    if (lane) lane.queue.length = 0;
    this.lanes.delete(key);
    this.health.delete(key);
  }
}

function laneKey(reg: HookRegistration): string {
  return reg.pluginName ? `plugin:${reg.pluginName}` : `hook:${reg.id}`;
}

function readTransformText(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/** Run fn (sync throws become rejections) and reject after ms. The handler itself keeps running. */
function withTimeout(fn: () => unknown, ms: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HookTimeoutError(ms));
    }, ms);
    timer.unref?.();
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * A plain-data copy of `value`: strings truncated, arrays and objects capped,
 * depth capped, cycles cut, functions and symbols dropped, anything exotic
 * turned into a string. The result is always structured-cloneable.
 */
export function boundPayload(value: unknown, limits: HookPayloadLimits = DEFAULT_HOOK_PAYLOAD_LIMITS): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) return "[size limit]";
    if (v === null || v === undefined) return v ?? null;
    switch (typeof v) {
      case "string":
        return v.length > limits.maxStringChars ? `${v.slice(0, limits.maxStringChars)}…[truncated]` : v;
      case "number":
        return Number.isFinite(v) ? v : String(v);
      case "boolean":
        return v;
      case "bigint":
        return v.toString();
      case "function":
      case "symbol":
        return undefined;
      default:
        break;
    }
    const obj = v as object;
    if (depth >= limits.maxDepth) return "[depth limit]";
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const out = obj.slice(0, limits.maxArrayItems).map((item) => {
          const w = walk(item, depth + 1);
          return w === undefined ? null : w;
        });
        if (obj.length > limits.maxArrayItems) out.push(`[${obj.length - limits.maxArrayItems} more]`);
        return out;
      }
      if (obj instanceof Date) return obj.toISOString();
      if (obj instanceof Error) return { name: obj.name, message: walk(obj.message, depth + 1) };
      if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[binary ${(obj as ArrayBuffer).byteLength} bytes]`;
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, item] of Object.entries(obj)) {
        if (n >= limits.maxKeys) {
          out["…"] = "[more keys]";
          break;
        }
        const w = walk(item, depth + 1);
        if (w !== undefined) {
          out[k] = w;
          n += 1;
        }
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value, 0);
}

/** A structured clone, deep-frozen. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
