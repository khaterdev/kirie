/**
 * A queued task waiting to be executed.
 */
interface QueuedItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Internal state for a single session lane.
 */
interface Lane<T> {
  /** Pending tasks waiting to execute */
  queue: QueuedItem<T>[];
  /** Whether a task is currently running */
  running: boolean;
  /** Active debounce timer, if any */
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Default debounce window in milliseconds.
 * When messages arrive in rapid succession for the same session,
 * the queue waits this long before starting execution, allowing
 * messages to be coalesced by the caller.
 */
const DEFAULT_DEBOUNCE_MS = 1500;

/**
 * LaneQueue provides per-session FIFO message serialization.
 *
 * Each session key gets its own independent "lane" with concurrency=1,
 * meaning messages to the same session are processed one at a time in order.
 * Different sessions run in parallel without blocking each other.
 *
 * An optional debounce window (default 1500ms) delays execution of new
 * tasks, allowing rapid-fire messages to the same session to be coalesced
 * by the caller before the agent processes them.
 *
 * Lanes are automatically cleaned up when they drain to avoid memory leaks.
 *
 * @typeParam T - The return type of queued tasks
 */
export class LaneQueue<T = unknown> {
  private readonly lanes = new Map<string, Lane<T>>();
  private readonly debounceMs: number;

  /**
   * @param debounceMs - Debounce window in ms before starting task execution.
   *                     Set to 0 to disable debouncing.
   */
  constructor(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  /**
   * Enqueue a task for a given session key.
   *
   * The returned promise resolves when the task completes (after any
   * previously queued tasks for the same session key have finished).
   *
   * @param sessionKey - The session key identifying the lane
   * @param task - An async function to execute
   * @returns A promise that resolves with the task's return value
   */
  enqueue(sessionKey: string, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(sessionKey);

    if (!lane) {
      lane = {
        queue: [],
        running: false,
        debounceTimer: null,
      };
      this.lanes.set(sessionKey, lane);
    }

    return new Promise<T>((resolve, reject) => {
      lane.queue.push({ task, resolve, reject });
      this.scheduleProcessing(sessionKey, lane);
    });
  }

  /**
   * Get the number of pending (not yet started) tasks for a session key.
   *
   * @param sessionKey - The session key to query
   * @returns Number of queued tasks (including the currently running one)
   */
  getQueueLength(sessionKey: string): number {
    const lane = this.lanes.get(sessionKey);
    if (!lane) return 0;
    return lane.queue.length + (lane.running ? 1 : 0);
  }

  /**
   * Clear all pending tasks for a session key.
   * The currently running task (if any) will still complete.
   * Pending tasks are rejected with an Error.
   *
   * @param sessionKey - The session key to clear
   */
  clear(sessionKey: string): void {
    const lane = this.lanes.get(sessionKey);
    if (!lane) return;

    if (lane.debounceTimer !== null) {
      clearTimeout(lane.debounceTimer);
      lane.debounceTimer = null;
    }

    // Reject all pending (not yet running) tasks
    const pending = lane.queue.splice(0);
    for (const item of pending) {
      item.reject(new Error(`Lane cleared for session: ${sessionKey}`));
    }

    // If nothing is running, remove the lane entirely
    if (!lane.running) {
      this.lanes.delete(sessionKey);
    }
  }

  /**
   * Clear all lanes and reject all pending tasks.
   * Unlike clear(key), this also forcefully removes lanes that have
   * running tasks to prevent orphaned entries.
   */
  clearAll(): void {
    for (const [key, lane] of this.lanes) {
      if (lane.debounceTimer !== null) {
        clearTimeout(lane.debounceTimer);
        lane.debounceTimer = null;
      }

      // Reject all pending tasks
      const pending = lane.queue.splice(0);
      for (const item of pending) {
        item.reject(new Error(`Lane cleared for session: ${key}`));
      }

      // Force-clear running state to prevent orphaned lanes
      lane.running = false;
    }
    this.lanes.clear();
  }

  /**
   * Get the set of active session keys (lanes with queued or running tasks).
   */
  activeKeys(): string[] {
    return [...this.lanes.keys()];
  }

  /**
   * Schedule lane processing, applying the debounce window.
   * If a debounce timer is already active, it gets reset (latest-wins).
   */
  private scheduleProcessing(sessionKey: string, lane: Lane<T>): void {
    // If already running, the drain loop will pick up new items
    if (lane.running) return;

    // Reset debounce timer
    if (lane.debounceTimer !== null) {
      clearTimeout(lane.debounceTimer);
    }

    if (this.debounceMs <= 0) {
      // No debounce: start immediately
      void this.processLane(sessionKey, lane);
    } else {
      lane.debounceTimer = setTimeout(() => {
        lane.debounceTimer = null;
        void this.processLane(sessionKey, lane);
      }, this.debounceMs);
    }
  }

  /**
   * Process tasks in a lane sequentially until the queue drains.
   */
  private async processLane(sessionKey: string, lane: Lane<T>): Promise<void> {
    if (lane.running) return;
    lane.running = true;

    try {
      while (lane.queue.length > 0) {
        const item = lane.queue.shift()!;

        try {
          const result = await item.task();
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      lane.running = false;

      // Clean up empty lanes to prevent memory leaks
      if (lane.queue.length === 0 && lane.debounceTimer === null) {
        this.lanes.delete(sessionKey);
      }
    }
  }
}
