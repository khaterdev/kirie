/**
 * SQLite-backed embedding cache that sits between MemoryManager and EmbeddingProvider.
 *
 * On cache hit, returns the stored embedding without calling the underlying API.
 * On cache miss, delegates to the real provider and caches the result.
 *
 * Uses LRU eviction (based on a monotonic sequence counter) when the cache exceeds maxEntries.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbeddingProvider } from "./embeddings.js";

export interface EmbeddingCacheOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Maximum number of cached entries (LRU eviction when exceeded). Default: 50000 */
  maxEntries?: number;
  /** The underlying embedding provider to delegate to on cache miss */
  provider: EmbeddingProvider;
}

export interface EmbeddingCacheStats {
  total: number;
  hits: number;
  misses: number;
}

/**
 * Compute a SHA-256 hex digest of a string, used as part of the cache key.
 */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private db: Database.Database;
  private provider: EmbeddingProvider;
  private maxEntries: number;
  private _hits = 0;
  private _misses = 0;
  /** Monotonically increasing counter for precise LRU ordering. */
  private _accessCounter = 0;

  get dimensions(): number {
    return this.provider.dimensions;
  }

  get model(): string {
    return this.provider.model;
  }

  constructor(opts: EmbeddingCacheOptions) {
    this.provider = opts.provider;
    this.maxEntries = opts.maxEntries ?? 50_000;

    const dir = dirname(opts.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        content_hash  TEXT PRIMARY KEY,
        model         TEXT    NOT NULL,
        embedding     BLOB    NOT NULL,
        dimensions    INTEGER NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        last_used_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cache_last_used ON embedding_cache(last_used_seq);
    `);

    // Initialize the access counter from the DB so it survives restarts
    const row = this.db
      .prepare("SELECT MAX(last_used_seq) as max_seq FROM embedding_cache")
      .get() as { max_seq: number | null };
    this._accessCounter = (row.max_seq ?? 0) + 1;
  }

  /**
   * Build a composite cache key: `${model}:${contentHash}`.
   * This ensures different models never share cache entries.
   */
  private cacheKey(text: string): string {
    return `${this.model}:${hashText(text)}`;
  }

  /**
   * Look up a single cached embedding. Returns null on miss.
   * On hit, updates last_used_seq for LRU tracking.
   */
  private getCached(text: string): number[] | null {
    const key = this.cacheKey(text);
    const row = this.db
      .prepare("SELECT embedding FROM embedding_cache WHERE content_hash = ?")
      .get(key) as { embedding: Buffer } | undefined;

    if (!row) return null;

    // Update last_used_seq for LRU (monotonically increasing)
    this.db
      .prepare("UPDATE embedding_cache SET last_used_seq = ? WHERE content_hash = ?")
      .run(this._accessCounter++, key);

    return JSON.parse(row.embedding.toString("utf-8")) as number[];
  }

  /**
   * Store an embedding in the cache.
   */
  private putCached(text: string, embedding: number[]): void {
    const key = this.cacheKey(text);
    const blob = Buffer.from(JSON.stringify(embedding), "utf-8");
    const seq = this._accessCounter++;

    this.db
      .prepare(
        `INSERT INTO embedding_cache (content_hash, model, embedding, dimensions, created_at, last_used_seq)
         VALUES (?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           embedding     = excluded.embedding,
           dimensions    = excluded.dimensions,
           last_used_seq = excluded.last_used_seq`,
      )
      .run(key, this.model, blob, embedding.length, seq);

    this.evictLRU();
  }

  /**
   * Embed an array of texts, returning cached embeddings where available
   * and delegating to the underlying provider for misses.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = texts.map((t) => this.getCached(t));

    // Identify which texts need to be sent to the provider
    const missIndices: number[] = [];
    const missTexts: string[] = [];

    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        missIndices.push(i);
        missTexts.push(texts[i]!);
        this._misses++;
      } else {
        this._hits++;
      }
    }

    // Fetch missing embeddings from the real provider
    if (missTexts.length > 0) {
      const providerResults = await this.provider.embed(missTexts);

      for (let j = 0; j < missIndices.length; j++) {
        const idx = missIndices[j]!;
        const embedding = providerResults[j]!;
        results[idx] = embedding;

        // Cache the newly fetched embedding
        this.putCached(texts[idx]!, embedding);
      }
    }

    return results as number[][];
  }

  /**
   * Batch embed with caching. Delegates to the underlying provider's
   * batchEmbed for misses, caching each individual result.
   */
  async batchEmbed(
    requests: Array<{ id: string; text: string }>,
  ): Promise<Map<string, number[]>> {
    const resultMap = new Map<string, number[]>();
    const missRequests: Array<{ id: string; text: string }> = [];

    // Check cache for each request
    for (const req of requests) {
      const cached = this.getCached(req.text);
      if (cached) {
        resultMap.set(req.id, cached);
        this._hits++;
      } else {
        missRequests.push(req);
        this._misses++;
      }
    }

    // Delegate misses to the underlying provider
    if (missRequests.length > 0) {
      if (this.provider.batchEmbed) {
        const providerResults = await this.provider.batchEmbed(missRequests);
        for (const req of missRequests) {
          const embedding = providerResults.get(req.id);
          if (embedding) {
            resultMap.set(req.id, embedding);
            this.putCached(req.text, embedding);
          }
        }
      } else {
        // Fallback: use embed() for each miss
        const texts = missRequests.map((r) => r.text);
        const embeddings = await this.provider.embed(texts);
        for (let i = 0; i < missRequests.length; i++) {
          const req = missRequests[i]!;
          const embedding = embeddings[i];
          if (embedding) {
            resultMap.set(req.id, embedding);
            this.putCached(req.text, embedding);
          }
        }
      }
    }

    return resultMap;
  }

  /**
   * Get cache statistics: total entries in the DB, and session hit/miss counts.
   */
  stats(): EmbeddingCacheStats {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM embedding_cache")
      .get() as { cnt: number };

    return {
      total: row.cnt,
      hits: this._hits,
      misses: this._misses,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.db.exec("DELETE FROM embedding_cache");
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Evict least recently used entries to stay under maxEntries.
   */
  private evictLRU(): void {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM embedding_cache")
      .get() as { cnt: number };

    if (row.cnt > this.maxEntries) {
      const excess = row.cnt - this.maxEntries;
      this.db
        .prepare(
          `DELETE FROM embedding_cache WHERE content_hash IN (
            SELECT content_hash FROM embedding_cache
            ORDER BY last_used_seq ASC
            LIMIT ?
          )`,
        )
        .run(excess);
    }
  }

  /**
   * Close the underlying SQLite database.
   */
  close(): void {
    this.db.close();
  }
}
