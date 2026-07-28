/**
 * Tests for content-hash deduplication across the memory system.
 *
 * Verifies that:
 *  - hashContent produces consistent SHA-256 output
 *  - MemoryManager.store() skips embedding when content is unchanged
 *  - MemoryManager.store() re-embeds when content changes for the same key
 *  - MemoryManager.reindex() skips entries whose hash hasn't changed
 *  - MemoryStore (SQLite) persists and checks content_hash to skip writes
 *  - VectorStore.getMetadata() returns stored metadata including contentHash
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { hashContent } from "./memory-manager.js";
import { MemoryManager } from "./memory-manager.js";
import { VectorStore } from "./vector-store.js";
import type { MemoryStore as IMemoryStore, MemoryEntry } from "./types.js";
import type { EmbeddingProvider } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kirie-test-"));
}

/** Fake MemoryStore backed by an in-memory Map. */
function fakeMemoryStore(): IMemoryStore {
  const map = new Map<string, MemoryEntry>();
  let nextId = 1;

  return {
    store(key: string, content: string, tags?: string[]): MemoryEntry {
      const existing = map.get(key);
      const now = new Date().toISOString();
      const entry: MemoryEntry = {
        id: existing?.id ?? nextId++,
        key,
        content,
        tags: tags ?? [],
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      map.set(key, entry);
      return entry;
    },
    recall(key: string): MemoryEntry | null {
      return map.get(key) ?? null;
    },
    search(_query: string, limit = 20): MemoryEntry[] {
      return [...map.values()].slice(0, limit);
    },
    list(_tag?: string, limit = 50): MemoryEntry[] {
      return [...map.values()].slice(0, limit);
    },
    delete(key: string): boolean {
      return map.delete(key);
    },
    close(): void {
      // no-op
    },
  };
}

/** Fake embedding provider that returns a deterministic vector. */
function fakeEmbeddingProvider(): EmbeddingProvider & { embedCallCount: number } {
  const provider = {
    dimensions: 4,
    model: "test",
    embedCallCount: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.embedCallCount += texts.length;
      // Return a simple deterministic embedding based on string length
      return texts.map((t) => [t.length, t.length * 2, t.length * 3, t.length * 4]);
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------
// Tests: hashContent utility
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("produces a consistent SHA-256 hex digest", () => {
    const hash1 = hashContent("hello world");
    const hash2 = hashContent("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it("produces different hashes for different content", () => {
    const h1 = hashContent("hello");
    const h2 = hashContent("world");
    expect(h1).not.toBe(h2);
  });

  it("matches a known SHA-256 value", () => {
    // echo -n "test" | sha256sum => 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    const hash = hashContent("test");
    expect(hash).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});

// ---------------------------------------------------------------------------
// Tests: VectorStore.getMetadata
// ---------------------------------------------------------------------------

describe("VectorStore.getMetadata", () => {
  let tmpDir: string;
  let vectorStore: VectorStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vectorStore = new VectorStore(join(tmpDir, "vectors.db"));
  });

  afterEach(() => {
    vectorStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-existent key", () => {
    expect(vectorStore.getMetadata("missing-key")).toBeNull();
  });

  it("returns stored metadata including contentHash", () => {
    vectorStore.upsert("k1", [1, 2, 3, 4], { tags: ["a"], contentHash: "abc123" });
    const meta = vectorStore.getMetadata("k1");
    expect(meta).toEqual({ tags: ["a"], contentHash: "abc123" });
  });

  it("returns updated metadata after upsert", () => {
    vectorStore.upsert("k1", [1, 2, 3, 4], { contentHash: "old" });
    vectorStore.upsert("k1", [5, 6, 7, 8], { contentHash: "new" });
    const meta = vectorStore.getMetadata("k1");
    expect(meta?.contentHash).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Tests: MemoryManager.store() deduplication
// ---------------------------------------------------------------------------

describe("MemoryManager.store() deduplication", () => {
  let tmpDir: string;
  let vectorStore: VectorStore;
  let memStore: IMemoryStore;
  let embedProvider: EmbeddingProvider & { embedCallCount: number };
  let manager: MemoryManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vectorStore = new VectorStore(join(tmpDir, "vectors.db"));
    memStore = fakeMemoryStore();
    embedProvider = fakeEmbeddingProvider();
    manager = new MemoryManager({
      memoryStore: memStore,
      vectorStore,
      embeddingProvider: embedProvider,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores content and computes embedding on first call", async () => {
    await manager.store("key1", "some content", ["tag1"]);

    expect(embedProvider.embedCallCount).toBe(1);
    const meta = vectorStore.getMetadata("key1");
    expect(meta?.contentHash).toBe(hashContent("some content"));
  });

  it("skips embedding when storing identical content a second time", async () => {
    await manager.store("key1", "some content");
    expect(embedProvider.embedCallCount).toBe(1);

    await manager.store("key1", "some content");
    expect(embedProvider.embedCallCount).toBe(1); // still 1 — no extra embed call
  });

  it("re-embeds when content changes for the same key", async () => {
    await manager.store("key1", "version 1");
    expect(embedProvider.embedCallCount).toBe(1);

    await manager.store("key1", "version 2 — different content");
    expect(embedProvider.embedCallCount).toBe(2);

    const meta = vectorStore.getMetadata("key1");
    expect(meta?.contentHash).toBe(hashContent("version 2 — different content"));
  });

  it("still updates FTS store even when embedding is skipped", async () => {
    await manager.store("key1", "content", ["tag-a"]);
    await manager.store("key1", "content", ["tag-b"]);

    // Embedding should only be called once
    expect(embedProvider.embedCallCount).toBe(1);
    // But the FTS store should reflect the latest tags
    const entry = memStore.recall("key1");
    expect(entry?.tags).toEqual(["tag-b"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: MemoryManager.reindex() deduplication
// ---------------------------------------------------------------------------

describe("MemoryManager.reindex() deduplication", () => {
  let tmpDir: string;
  let vectorStore: VectorStore;
  let memStore: IMemoryStore;
  let embedProvider: EmbeddingProvider & { embedCallCount: number };
  let manager: MemoryManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vectorStore = new VectorStore(join(tmpDir, "vectors.db"));
    memStore = fakeMemoryStore();
    embedProvider = fakeEmbeddingProvider();
    manager = new MemoryManager({
      memoryStore: memStore,
      vectorStore,
      embeddingProvider: embedProvider,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips entries whose content hash hasn't changed", async () => {
    // Store two entries
    await manager.store("k1", "hello");
    await manager.store("k2", "world");
    expect(embedProvider.embedCallCount).toBe(2);

    // Reindex — both already have correct hashes, so should be skipped
    const result = await manager.reindex();
    expect(result.skipped).toBe(2);
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(embedProvider.embedCallCount).toBe(2); // no extra calls
  });

  it("re-embeds entries whose content was updated outside the manager", async () => {
    // Store initial content through the manager
    await manager.store("k1", "original content");
    expect(embedProvider.embedCallCount).toBe(1);

    // Simulate content changing in the FTS store without going through the manager
    // (e.g., direct DB edit). The vector store still has old hash.
    memStore.store("k1", "updated content");

    const result = await manager.reindex();
    expect(result.skipped).toBe(0);
    expect(result.processed).toBe(1);
    // 1 initial + 1 reindex = 2
    expect(embedProvider.embedCallCount).toBe(2);

    // Verify the vector store now has the updated hash
    const meta = vectorStore.getMetadata("k1");
    expect(meta?.contentHash).toBe(hashContent("updated content"));
  });
});
