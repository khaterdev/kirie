import { describe, it, expect } from "vitest";
import { WebhookRateLimiter, WebhookWorkQueue } from "./limits.js";

describe("WebhookRateLimiter", () => {
  it("allows a burst up to the limit, then refills over the window", () => {
    const l = new WebhookRateLimiter({ limit: 3, windowMs: 60_000 });
    expect([l.take("a", 0), l.take("a", 0), l.take("a", 0), l.take("a", 0)]).toEqual([true, true, true, false]);
    expect(l.take("a", 19_999)).toBe(false);
    expect(l.take("a", 20_000)).toBe(true);
    expect(l.take("a", 20_000)).toBe(false);
  });

  it("keeps keys independent", () => {
    const l = new WebhookRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(l.take("a", 0)).toBe(true);
    expect(l.take("b", 0)).toBe(true);
    expect(l.take("a", 0)).toBe(false);
  });

  it("caps tracked keys", () => {
    const l = new WebhookRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    l.take("a", 0); l.take("b", 0); l.take("c", 0);
    expect(l.trackedKeys).toBe(2);
  });
});

describe("WebhookWorkQueue", () => {
  it("runs at most maxConcurrent, queues up to maxQueued, refuses beyond", async () => {
    const q = new WebhookWorkQueue(() => ({ maxConcurrent: 1, maxQueued: 1 }));
    const releases: Array<() => void> = [];
    const job = () => new Promise<void>((r) => { releases.push(r); });
    expect(q.offer(job)).toBe(true);
    expect(q.offer(job)).toBe(true);
    expect(q.offer(job)).toBe(false);
    expect([q.active, q.queued]).toEqual([1, 1]);
    releases[0]!();
    await new Promise((r) => setImmediate(r));
    expect([q.active, q.queued]).toEqual([1, 0]);
    releases[1]!();
    await new Promise((r) => setImmediate(r));
    expect([q.active, q.queued]).toEqual([0, 0]);
  });
});
