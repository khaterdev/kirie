/**
 * Small generic rate limiting for the webhook ingress (PLAN C.6).
 * `security/rate-limiter.ts` is hard-wired to user and group keys, so this
 * is a separate keyed token bucket. Keys can be attacker-chosen (client IPs
 * from a header), so the number of tracked keys is capped: when full, the
 * least recently used key is evicted.
 */

export interface WebhookRateLimiterOptions {
  /** Tokens per window, also the burst size */
  limit: number;
  windowMs: number;
  /** Maximum tracked keys (default 10 000) */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class WebhookRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(private readonly opts: WebhookRateLimiterOptions) {
    if (!(opts.limit > 0) || !(opts.windowMs > 0)) throw new Error("rate limit and window must be positive");
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Take one token for `key`. Returns false when the key is over its limit. */
  take(key: string, nowMs: number = Date.now()): boolean {
    const bucket = this.refill(key, nowMs);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Tokens left for `key`, without taking one. */
  remaining(key: string, nowMs: number = Date.now()): number {
    return Math.floor(this.refill(key, nowMs).tokens);
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }

  private refill(key: string, nowMs: number): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key);
      const elapsed = Math.max(0, nowMs - bucket.updatedAt);
      bucket.tokens = Math.min(this.opts.limit, bucket.tokens + (elapsed * this.opts.limit) / this.opts.windowMs);
      bucket.updatedAt = nowMs;
    } else {
      bucket = { tokens: this.opts.limit, updatedAt: nowMs };
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, bucket);
    return bucket;
  }
}

/**
 * Concurrency and queue caps for webhook work that calls a model. At most
 * `maxConcurrent` jobs run; up to `maxQueued` wait. `offer` returns false when
 * both are full (the caller answers 429 throttled).
 */
export class WebhookWorkQueue {
  private running = 0;
  private readonly waiting: Array<() => Promise<void>> = [];

  constructor(private readonly limits: () => { maxConcurrent: number; maxQueued: number }) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  hasRoom(): boolean {
    const { maxConcurrent, maxQueued } = this.limits();
    return this.running < maxConcurrent || this.waiting.length < maxQueued;
  }

  /**
   * Queue a job. The job's promise settles when its slot should be released
   * (for a background task: when the task finishes). Never rejects.
   */
  offer(job: () => Promise<void>): boolean {
    if (!this.hasRoom()) return false;
    this.waiting.push(job);
    this.pump();
    return true;
  }

  /** Drop jobs that have not started (daemon stop). Returns the count dropped. */
  clear(): number {
    const n = this.waiting.length;
    this.waiting.length = 0;
    return n;
  }

  private pump(): void {
    while (this.running < this.limits().maxConcurrent && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running += 1;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }
}
