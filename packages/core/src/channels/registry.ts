/**
 * ChannelRegistry - manages adapter registration, lifecycle, and discovery.
 * Each adapter is started/stopped independently with its own AbortController.
 */

import type { ChannelAdapter } from "./adapter.js";
import type { ChannelName } from "./normalizer.js";

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
  adapter: ChannelAdapter;
  abortController: AbortController | null;
  running: boolean;
}

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

  /** Get an adapter by its ID. */
  getById(id: ChannelName): ChannelAdapter | undefined {
    return this.channels.get(id)?.adapter;
  }

  /** Get all registered adapters. */
  getAll(): ReadonlyMap<ChannelName, ChannelAdapter> {
    const result = new Map<ChannelName, ChannelAdapter>();
    for (const [id, managed] of this.channels) {
      result.set(id, managed.adapter);
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
