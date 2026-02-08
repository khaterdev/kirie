import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryManager, hashContent } from "./memory-manager.js";
import { VectorStore } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemoryStore, MemoryEntry } from "./types.js";

const TEST_DIR = `/tmp/kirie-mm-test-${process.pid}`;
const VECTOR_DB = join(TEST_DIR, "vectors.db");

/**
 * Minimal in-memory MemoryStore stub for testing MemoryManager
 * without requiring SQLite FTS5.
 */
function createMockMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();
  let nextId = 1;

  return {
    store(key: string, content: string, tags?: string[]): MemoryEntry {
      const now = new Date().toISOString();
      const entry: MemoryEntry = {
        id: nextId++,
        key,
        content,
        tags: tags ?? [],
        created_at: now,
        updated_at: now,
      };
      entries.set(key, entry);
      return entry;
    },
    recall(key: string): MemoryEntry | null {
      return entries.get(key) ?? null;
    },
    search(_query: string, _limit?: number): MemoryEntry[] {
      return [];
    },
    list(_tag?: string, _limit?: number): MemoryEntry[] {
      return Array.from(entries.values());
    },
    delete(key: string): boolean {
      return entries.delete(key);
    },
    close(): void { /* noop */ },
  };
}

/**
 * Create a mock EmbeddingProvider that returns deterministic embeddings.
 * Optionally supports batchEmbed.
 */
function createMockEmbeddingProvider(opts?: {
  withBatch?: boolean;
  batchShouldFail?: boolean;
}): EmbeddingProvider {
  const provider: EmbeddingProvider = {
    dimensions: 4,
    model: "mock-embed",
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        // Simple deterministic "embedding": use char codes
        const hash = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return [hash % 100 / 100, (hash * 2) % 100 / 100, (hash * 3) % 100 / 100, (hash * 4) % 100 / 100];
      });
    },
  };

  if (opts?.withBatch) {
    provider.batchEmbed = async (requests) => {
      if (opts.batchShouldFail) {
        throw new Error("Batch API unavailable");
      }
      const result = new Map<string, number[]>();
      for (const req of requests) {
        const hash = Array.from(req.text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        result.set(req.id, [hash % 100 / 100, (hash * 2) % 100 / 100, (hash * 3) % 100 / 100, (hash * 4) % 100 / 100]);
      }
      return result;
    };
  }

  return provider;
}

let vectorStore: VectorStore;
let memoryStore: MemoryStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  vectorStore = new VectorStore(VECTOR_DB);
  memoryStore = createMockMemoryStore();
});

afterEach(() => {
  vectorStore.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("MemoryManager.reindex", () => {
  it("reindexes all memories using individual embed() calls", async () => {
    const provider = createMockEmbeddingProvider();
    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");

    const result = await manager.reindex();

    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(vectorStore.count()).toBe(2);
  });

  it("uses batchEmbed() when available", async () => {
    const provider = createMockEmbeddingProvider({ withBatch: true });
    const embedSpy = vi.spyOn(provider, "embed");
    const batchSpy = vi.spyOn(provider, "batchEmbed");

    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");
    memoryStore.store("key-3", "Test content");

    const result = await manager.reindex();

    expect(result.processed).toBe(3);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(vectorStore.count()).toBe(3);

    // batchEmbed should have been called, NOT individual embed
    expect(batchSpy).toHaveBeenCalledOnce();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("falls back to individual embed() when batchEmbed() throws", async () => {
    const provider = createMockEmbeddingProvider({ withBatch: true, batchShouldFail: true });
    const embedSpy = vi.spyOn(provider, "embed");

    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");

    const result = await manager.reindex();

    // Fallback should have processed via individual embed()
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it("skips memories with unchanged content hash", async () => {
    const provider = createMockEmbeddingProvider();
    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");

    // First reindex
    await manager.reindex();
    expect(vectorStore.count()).toBe(2);

    // Second reindex — content unchanged, should skip
    const result = await manager.reindex();
    expect(result.skipped).toBe(2);
    expect(result.processed).toBe(0);
  });

  it("skips unchanged memories even with batchEmbed available", async () => {
    const provider = createMockEmbeddingProvider({ withBatch: true });
    const batchSpy = vi.spyOn(provider, "batchEmbed");

    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");

    // First reindex populates hashes
    await manager.reindex();

    // Second reindex — all skipped, batchEmbed should NOT be called
    batchSpy.mockClear();
    const result = await manager.reindex();
    expect(result.skipped).toBe(2);
    expect(result.processed).toBe(0);
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it("handles partial batch results by counting missing as errors", async () => {
    const provider = createMockEmbeddingProvider({ withBatch: true });
    // Override batchEmbed to return only some results
    provider.batchEmbed = async (requests) => {
      const result = new Map<string, number[]>();
      // Only return embedding for the first request
      if (requests.length > 0) {
        result.set(requests[0]!.id, [0.1, 0.2, 0.3, 0.4]);
      }
      return result;
    };

    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    memoryStore.store("key-1", "Hello world");
    memoryStore.store("key-2", "Goodbye world");
    memoryStore.store("key-3", "Third content");

    const result = await manager.reindex();

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("reindexes empty memory store without errors", async () => {
    const provider = createMockEmbeddingProvider({ withBatch: true });
    const manager = new MemoryManager({
      memoryStore,
      vectorStore,
      embeddingProvider: provider,
    });

    const result = await manager.reindex();
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("hashContent", () => {
  it("returns a SHA-256 hex string", () => {
    const hash = hashContent("Hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces identical hashes for identical content", () => {
    expect(hashContent("test")).toBe(hashContent("test"));
  });

  it("produces different hashes for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});
