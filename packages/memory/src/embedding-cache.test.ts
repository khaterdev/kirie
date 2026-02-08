import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CachedEmbeddingProvider } from "./embedding-cache.js";
import type { EmbeddingProvider } from "./embeddings.js";

const TEST_DIR = `/tmp/kirie-cache-test-${process.pid}`;
const CACHE_DB = join(TEST_DIR, "cache.db");

/**
 * Create a mock EmbeddingProvider that returns deterministic embeddings.
 * Tracks calls for spy assertions.
 */
function createMockProvider(opts?: {
  model?: string;
  dimensions?: number;
  withBatch?: boolean;
}): EmbeddingProvider {
  const model = opts?.model ?? "mock-embed";
  const dimensions = opts?.dimensions ?? 4;

  const provider: EmbeddingProvider = {
    dimensions,
    model,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const hash = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return [
          (hash % 100) / 100,
          ((hash * 2) % 100) / 100,
          ((hash * 3) % 100) / 100,
          ((hash * 4) % 100) / 100,
        ];
      });
    },
  };

  if (opts?.withBatch) {
    provider.batchEmbed = async (requests) => {
      const result = new Map<string, number[]>();
      for (const req of requests) {
        const hash = Array.from(req.text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        result.set(req.id, [
          (hash % 100) / 100,
          ((hash * 2) % 100) / 100,
          ((hash * 3) % 100) / 100,
          ((hash * 4) % 100) / 100,
        ]);
      }
      return result;
    };
  }

  return provider;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CachedEmbeddingProvider", () => {
  it("delegates to the underlying provider on cache miss and stores result", async () => {
    const provider = createMockProvider();
    const embedSpy = vi.spyOn(provider, "embed");

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    const results = await cached.embed(["Hello world"]);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(4);
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(embedSpy).toHaveBeenCalledWith(["Hello world"]);

    // Verify it was stored in cache
    const stats = cached.stats();
    expect(stats.total).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);

    cached.close();
  });

  it("returns cached embedding on cache hit without calling provider", async () => {
    const provider = createMockProvider();
    const embedSpy = vi.spyOn(provider, "embed");

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    // First call: cache miss
    const first = await cached.embed(["Hello world"]);
    expect(embedSpy).toHaveBeenCalledOnce();

    // Second call: cache hit
    embedSpy.mockClear();
    const second = await cached.embed(["Hello world"]);
    expect(embedSpy).not.toHaveBeenCalled();

    // Results should be identical
    expect(second).toEqual(first);

    const stats = cached.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);

    cached.close();
  });

  it("handles mixed hits and misses in a single embed call", async () => {
    const provider = createMockProvider();
    const embedSpy = vi.spyOn(provider, "embed");

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    // Pre-populate cache with one text
    await cached.embed(["Hello world"]);
    embedSpy.mockClear();

    // Now embed a mix of cached and uncached texts
    const results = await cached.embed(["Hello world", "New text", "Hello world"]);

    expect(results).toHaveLength(3);
    // Provider should only be called for the miss ("New text")
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(embedSpy).toHaveBeenCalledWith(["New text"]);

    cached.close();
  });

  it("different models do not share cache entries", async () => {
    const providerA = createMockProvider({ model: "model-a" });
    const providerB = createMockProvider({ model: "model-b" });

    const embedSpyA = vi.spyOn(providerA, "embed");
    const embedSpyB = vi.spyOn(providerB, "embed");

    const cachedA = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider: providerA,
    });

    const cachedB = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider: providerB,
    });

    // Embed the same text with model A
    await cachedA.embed(["Same text"]);
    expect(embedSpyA).toHaveBeenCalledOnce();

    // Embed the same text with model B -- should still be a miss
    await cachedB.embed(["Same text"]);
    expect(embedSpyB).toHaveBeenCalledOnce();

    // Both should have 1 miss each
    expect(cachedA.stats().misses).toBe(1);
    expect(cachedB.stats().misses).toBe(1);

    // DB should have 2 entries total (one per model)
    expect(cachedA.stats().total).toBe(2);

    cachedA.close();
    cachedB.close();
  });

  it("evicts LRU entries when maxEntries is exceeded", async () => {
    const provider = createMockProvider();

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
      maxEntries: 3,
    });

    // Insert 3 entries
    await cached.embed(["text-1"]);
    await cached.embed(["text-2"]);
    await cached.embed(["text-3"]);
    expect(cached.stats().total).toBe(3);

    // Access text-1 to make it more recently used
    await cached.embed(["text-1"]);

    // Insert a 4th entry -- should evict the LRU (text-2)
    await cached.embed(["text-4"]);
    expect(cached.stats().total).toBe(3);

    // text-1 should still be cached (was recently accessed)
    const embedSpy = vi.spyOn(provider, "embed");
    await cached.embed(["text-1"]);
    expect(embedSpy).not.toHaveBeenCalled();

    cached.close();
  });

  it("stats() returns correct hit/miss counts", async () => {
    const provider = createMockProvider();

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    expect(cached.stats()).toEqual({ total: 0, hits: 0, misses: 0 });

    // 2 misses
    await cached.embed(["text-a", "text-b"]);
    expect(cached.stats()).toEqual({ total: 2, hits: 0, misses: 2 });

    // 1 hit + 1 miss
    await cached.embed(["text-a", "text-c"]);
    expect(cached.stats()).toEqual({ total: 3, hits: 1, misses: 3 });

    // 3 hits
    await cached.embed(["text-a", "text-b", "text-c"]);
    expect(cached.stats()).toEqual({ total: 3, hits: 4, misses: 3 });

    cached.close();
  });

  it("clear() removes all entries and resets stats", async () => {
    const provider = createMockProvider();

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    await cached.embed(["text-1", "text-2"]);
    expect(cached.stats().total).toBe(2);

    cached.clear();
    expect(cached.stats()).toEqual({ total: 0, hits: 0, misses: 0 });

    // After clear, should be cache misses again
    const embedSpy = vi.spyOn(provider, "embed");
    await cached.embed(["text-1"]);
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(cached.stats()).toEqual({ total: 1, hits: 0, misses: 1 });

    cached.close();
  });

  it("batchEmbed caches individual results", async () => {
    const provider = createMockProvider({ withBatch: true });
    const batchSpy = vi.spyOn(provider, "batchEmbed");

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    // First batch call -- all misses
    const result1 = await cached.batchEmbed([
      { id: "key-1", text: "Hello" },
      { id: "key-2", text: "World" },
    ]);

    expect(result1.size).toBe(2);
    expect(batchSpy).toHaveBeenCalledOnce();

    // Second batch call -- all hits (same texts, different IDs)
    batchSpy.mockClear();
    const result2 = await cached.batchEmbed([
      { id: "key-3", text: "Hello" },
      { id: "key-4", text: "World" },
    ]);

    expect(result2.size).toBe(2);
    expect(batchSpy).not.toHaveBeenCalled();

    // Results should be the same embeddings
    expect(result2.get("key-3")).toEqual(result1.get("key-1"));
    expect(result2.get("key-4")).toEqual(result1.get("key-2"));

    expect(cached.stats().hits).toBe(2);
    expect(cached.stats().misses).toBe(2);

    cached.close();
  });

  it("batchEmbed falls back to embed() when provider has no batchEmbed", async () => {
    const provider = createMockProvider({ withBatch: false });
    const embedSpy = vi.spyOn(provider, "embed");

    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    const result = await cached.batchEmbed([
      { id: "key-1", text: "Hello" },
      { id: "key-2", text: "World" },
    ]);

    expect(result.size).toBe(2);
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(cached.stats().misses).toBe(2);

    cached.close();
  });

  it("close() works without error", () => {
    const provider = createMockProvider();
    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    expect(() => cached.close()).not.toThrow();
  });

  it("exposes dimensions and model from the underlying provider", () => {
    const provider = createMockProvider({ model: "test-model", dimensions: 768 });
    const cached = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    expect(cached.dimensions).toBe(768);
    expect(cached.model).toBe("test-model");

    cached.close();
  });

  it("persists cache across instances with the same dbPath", async () => {
    const provider = createMockProvider();

    // First instance: populate cache
    const cached1 = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });
    await cached1.embed(["persistent text"]);
    cached1.close();

    // Second instance: should find cached entry
    const embedSpy = vi.spyOn(provider, "embed");
    const cached2 = new CachedEmbeddingProvider({
      dbPath: CACHE_DB,
      provider,
    });

    await cached2.embed(["persistent text"]);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(cached2.stats().hits).toBe(1);
    expect(cached2.stats().misses).toBe(0);

    cached2.close();
  });
});
