/**
 * ChannelRegistry - manages adapter registration, lifecycle, and discovery.
 * Each adapter is started/stopped independently with its own AbortController.
 */

import type { ChannelAdapter } from "./adapter.js";
import type { ChannelName } from "./normalizer.js";
import { scrubSecrets, SCRUB_WITHHELD } from "../security/secret-scrubber.js";

/** Rewrites outbound text before it reaches a platform. Must not throw (a throw withholds the text). */
export type ChannelOutboundFilter = (text: string) => string;

const defaultOutboundFilter: ChannelOutboundFilter = (text) => scrubSecrets(text, { sink: "channel" });

/** Events emitted by the registry */
export interface ChannelRegistryEvents {
  registered: (id: ChannelName) => void;
  unregistered: (id: ChannelName) => void;
  started: (id: ChannelName) => void;
  stopped: (id: ChannelName) => void;
  error: (id: ChannelName, error: Error) => void;
}

type RegistryListener<K extends keyof ChannelRegistryEvents> = ChannelRegistryEvents[K];

interface ManagedChannel {
  /** The adapter as registered. Used for lifecycle calls. */
  adapter: ChannelAdapter;
  /** What getById/getAll hand out: outbound text passes through the filter. */
  proxy: ChannelAdapter;
  abortController: AbortController | null;
  running: boolean;
}

/**
 * Methods whose text arguments are filtered. Every other property is forwarded unchanged
 * (code such as telegram-actions.ts reaches into `adapter.bot`).
 */
type ParamRewriter = (params: Record<string, unknown>, filter: ChannelOutboundFilter) => Record<string, unknown>;

function filterText(value: unknown, filter: ChannelOutboundFilter): unknown {
  if (typeof value !== "string") return value;
  try {
    return filter(value);
  } catch {
    return SCRUB_WITHHELD;
  }
}

function rewriteCaption(media: unknown, filter: ChannelOutboundFilter): unknown {
  if (!media || typeof media !== "object" || !("caption" in media)) return media;
  return { ...(media as Record<string, unknown>), caption: filterText((media as { caption?: unknown }).caption, filter) };
}

/** Button rows: filter the visible label fields and link urls, never the callback data. */
function rewriteButtons(rows: unknown, filter: ChannelOutboundFilter): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row: unknown) =>
    Array.isArray(row)
      ? row.map((button: unknown) => {
          if (!button || typeof button !== "object") return button;
          const out: Record<string, unknown> = { ...(button as Record<string, unknown>) };
          if (typeof out.label === "string") out.label = filterText(out.label, filter);
          if (typeof out.text === "string") out.text = filterText(out.text, filter);
          if (typeof out.url === "string") out.url = filterText(out.url, filter);
          return out;
        })
      : row,
  );
}

const withText: ParamRewriter = (p, f) => ("text" in p ? { ...p, text: filterText(p.text, f) } : p);

const OUTBOUND_REWRITERS: Readonly<Record<string, ParamRewriter>> = {
  sendText: withText,
  editMessage: withText,
  sendMedia: (p, f) => ({ ...p, media: rewriteCaption(p.media, f) }),
  sendMediaBatch: (p, f) => ({
    ...p,
    media: Array.isArray(p.media) ? p.media.map((m: unknown) => rewriteCaption(m, f)) : p.media,
  }),
  sendInteractive: (p, f) => ({ ...withText(p, f), ...("buttons" in p ? { buttons: rewriteButtons(p.buttons, f) } : {}) }),
  updateInteractive: (p, f) => ({ ...withText(p, f), ...("buttons" in p ? { buttons: rewriteButtons(p.buttons, f) } : {}) }),
  ackInteraction: withText,
};

/**
 * Central registry for all channel adapters.
 *
 * Usage:
 *   const registry = new ChannelRegistry();
 *   registry.register(telegramAdapter);
 *   await registry.startAll();
 *   // ... later ...
 *   await registry.stopAll();
 */
export class ChannelRegistry {
  private readonly channels = new Map<ChannelName, ManagedChannel>();
  private readonly listeners = new Map<keyof ChannelRegistryEvents, Set<RegistryListener<keyof ChannelRegistryEvents>>>();
  private outboundFilter: ChannelOutboundFilter = defaultOutboundFilter;

  /**
   * Replace the filter applied to outbound text (sendText, editMessage, media captions,
   * sendInteractive and updateInteractive text and button labels, ackInteraction text). The default is the secret scrubber with sink
   * "channel". Applies to already registered adapters too: the filter is read per call.
   */
  setOutboundFilter(filter: ChannelOutboundFilter): void {
    this.outboundFilter = filter;
  }

  private createProxy(adapter: ChannelAdapter): ChannelAdapter {
    const bound = new Map<PropertyKey, unknown>();
    return new Proxy(adapter, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        // Proxy invariant: a frozen own property must be returned as is.
        const own = Object.getOwnPropertyDescriptor(target, prop);
        if (own && !own.configurable && !own.writable) return value;
        const cached = bound.get(prop);
        if (cached && (cached as { original?: unknown }).original === value) return cached;
        const rewriter = typeof prop === "string" ? OUTBOUND_REWRITERS[prop] : undefined;
        const fn = value as (...args: unknown[]) => unknown;
        const wrapped = rewriter
          ? (...args: unknown[]) => {
              const [params, ...rest] = args;
              const next = params && typeof params === "object"
                ? rewriter(params as Record<string, unknown>, this.outboundFilter)
                : params;
              return fn.call(target, next, ...rest);
            }
          : (...args: unknown[]) => fn.apply(target, args);
        Object.defineProperty(wrapped, "original", { value });
        bound.set(prop, wrapped);
        return wrapped;
      },
      // Writes go to the real adapter, so setters that use #private fields keep working.
      set: (target, prop, value) => Reflect.set(target, prop, value, target),
    });
  }

  /**
   * Register a channel adapter.
   * @throws If an adapter with the same id is already registered.
   */
  register(adapter: ChannelAdapter): void {
    if (this.channels.has(adapter.id)) {
      throw new Error(`Channel "${adapter.id}" is already registered`);
    }
    this.channels.set(adapter.id, {
      adapter,
      proxy: this.createProxy(adapter),
      abortController: null,
      running: false,
    });
    this.emit("registered", adapter.id);
  }

  /**
   * Unregister a channel adapter. Stops it first if running.
   * @returns true if the adapter was found and removed
   */
  async unregister(id: ChannelName): Promise<boolean> {
    const managed = this.channels.get(id);
    if (!managed) return false;

    if (managed.running) {
      await this.stop(id);
    }
    this.channels.delete(id);
    this.emit("unregistered", id);
    return true;
  }

  /**
   * Start a specific channel adapter.
   * Creates a new AbortController for cooperative cancellation.
   */
  async start(id: ChannelName): Promise<void> {
    const managed = this.channels.get(id);
    if (!managed) {
      throw new Error(`Channel "${id}" is not registered`);
    }
    if (managed.running) {
      return; // already running
    }

    const ac = new AbortController();
    managed.abortController = ac;

    try {
      await managed.adapter.start(ac.signal);
      managed.running = true;
      this.emit("started", id);
    } catch (err) {
      managed.abortController = null;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", id, error);
      throw error;
    }
  }

  /**
   * Stop a specific channel adapter.
   * Aborts the signal and calls adapter.stop().
   */
  async stop(id: ChannelName): Promise<void> {
    const managed = this.channels.get(id);
    if (!managed) {
      throw new Error(`Channel "${id}" is not registered`);
    }
    if (!managed.running) {
      return; // already stopped
    }

    managed.abortController?.abort();
    try {
      await managed.adapter.stop();
    } finally {
      managed.running = false;
      managed.abortController = null;
      this.emit("stopped", id);
    }
  }

  /**
   * Start all registered adapters.
   * Failures in individual adapters are collected, not thrown immediately,
   * so that other adapters can still start.
   */
  async startAll(): Promise<Map<ChannelName, Error>> {
    const errors = new Map<ChannelName, Error>();

    const entries = [...this.channels.entries()];
    await Promise.all(
      entries.map(async ([id]) => {
        try {
          await this.start(id);
        } catch (err) {
          errors.set(id, err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );

    return errors;
  }

  /**
   * Stop all running adapters.
   * Errors during shutdown are collected, not thrown.
   */
  async stopAll(): Promise<Map<ChannelName, Error>> {
    const errors = new Map<ChannelName, Error>();

    const entries = [...this.channels.entries()].filter(([, m]) => m.running);
    await Promise.all(
      entries.map(async ([id]) => {
        try {
          await this.stop(id);
        } catch (err) {
          errors.set(id, err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );

    return errors;
  }

  /** Get an adapter by its ID. Outbound text sent through it passes the outbound filter. */
  getById(id: ChannelName): ChannelAdapter | undefined {
    return this.channels.get(id)?.proxy;
  }

  /** Get all registered adapters (filtered, as getById). */
  getAll(): ReadonlyMap<ChannelName, ChannelAdapter> {
    const result = new Map<ChannelName, ChannelAdapter>();
    for (const [id, managed] of this.channels) {
      result.set(id, managed.proxy);
    }
    return result;
  }

  /** Get all adapter IDs that are currently running. */
  getRunning(): ChannelName[] {
    return [...this.channels.entries()]
      .filter(([, m]) => m.running)
      .map(([id]) => id);
  }

  /** Check if a specific adapter is currently running. */
  isRunning(id: ChannelName): boolean {
    return this.channels.get(id)?.running ?? false;
  }

  /** Total number of registered adapters. */
  get size(): number {
    return this.channels.size;
  }

  // ---------------------------------------------------------------------------
  // Event emitter (minimal, no external deps)
  // ---------------------------------------------------------------------------

  on<K extends keyof ChannelRegistryEvents>(event: K, listener: ChannelRegistryEvents[K]): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as RegistryListener<keyof ChannelRegistryEvents>);
  }

  off<K extends keyof ChannelRegistryEvents>(event: K, listener: ChannelRegistryEvents[K]): void {
    this.listeners.get(event)?.delete(listener as RegistryListener<keyof ChannelRegistryEvents>);
  }

  private emit<K extends keyof ChannelRegistryEvents>(
    event: K,
    ...args: Parameters<ChannelRegistryEvents[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot listeners before iterating to prevent mutation during emit
    const snapshot = [...set];
    for (const listener of snapshot) {
      try {
        (listener as (...a: Parameters<ChannelRegistryEvents[K]>) => void)(...args);
      } catch {
        // Swallow listener errors to protect registry stability
      }
    }
  }
}
