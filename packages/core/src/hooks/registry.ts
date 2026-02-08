import { randomUUID } from "node:crypto";
import type {
  HookEventType,
  HookEventPayload,
  HookHandler,
  HookRegistration,
} from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export interface HookRegistryOptions {
  timeoutMs?: number;
}

/**
 * HookRegistry manages lifecycle hooks for the Kirie system.
 * Hooks are dispatched in priority order (lower number = higher priority).
 * "before*" hooks run as a pipeline where each handler may transform the event.
 * All other hooks run as fire-and-forget notifications.
 */
export class HookRegistry {
  private hooks: Map<HookEventType, HookRegistration[]> = new Map();
  private timeoutMs: number;

  constructor(options: HookRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  }

  /**
   * Register a hook handler for a specific event type.
   * Returns a disposer function to unregister the hook.
   */
  register<T extends HookEventType>(
    eventType: T,
    handler: HookHandler<T>,
    options: { priority?: number; pluginName?: string } = {},
  ): () => void {
    const id = randomUUID();
    const registration: HookRegistration<T> = {
      id,
      eventType,
      handler,
      priority: options.priority ?? 100,
      pluginName: options.pluginName,
    };

    const list = this.hooks.get(eventType) ?? [];
    list.push(registration as unknown as HookRegistration);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(eventType, list);

    return () => this.unregister(id);
  }

  /**
   * Unregister a hook by its ID.
   */
  unregister(id: string): boolean {
    for (const [eventType, list] of this.hooks) {
      const idx = list.findIndex((h) => h.id === id);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) {
          this.hooks.delete(eventType);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Unregister all hooks belonging to a specific plugin.
   */
  unregisterPlugin(pluginName: string): number {
    let removed = 0;
    for (const [eventType, list] of this.hooks) {
      const before = list.length;
      const filtered = list.filter((h) => h.pluginName !== pluginName);
      removed += before - filtered.length;
      if (filtered.length === 0) {
        this.hooks.delete(eventType);
      } else {
        this.hooks.set(eventType, filtered);
      }
    }
    return removed;
  }

  /**
   * Dispatch an event to all registered handlers.
   * For "before*" events, handlers form a pipeline and may transform the event.
   * Returns the (possibly transformed) event.
   */
  async dispatch<T extends HookEventType>(
    event: HookEventPayload<T>,
  ): Promise<HookEventPayload<T>> {
    const list = this.hooks.get(event.type) as HookRegistration<T>[] | undefined;
    if (!list || list.length === 0) {
      return event;
    }

    const isPipeline = event.type.startsWith("before");
    let current = event;

    for (const registration of list) {
      try {
        const result = await this.runWithTimeout(
          registration.handler(current),
          this.timeoutMs,
          `Hook ${registration.id} (${registration.pluginName ?? "anonymous"}) timed out after ${this.timeoutMs}ms`,
        );

        if (isPipeline && result != null && typeof result === "object" && "type" in result) {
          current = result as HookEventPayload<T>;
        }
      } catch (error) {
        // Log but don't throw - a failing hook should not break the pipeline
        console.error(
          `[HookRegistry] Error in hook ${registration.id} (${registration.pluginName ?? "anonymous"}) for ${event.type}:`,
          error,
        );
      }
    }

    return current;
  }

  /**
   * Get the number of registered hooks for a given event type.
   */
  count(eventType?: HookEventType): number {
    if (eventType) {
      return this.hooks.get(eventType)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.hooks.values()) {
      total += list.length;
    }
    return total;
  }

  /**
   * Remove all registered hooks.
   */
  clear(): void {
    this.hooks.clear();
  }

  private runWithTimeout<T>(
    maybePromise: T | Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    const promise = Promise.resolve(maybePromise);

    if (timeoutMs <= 0) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }
}
