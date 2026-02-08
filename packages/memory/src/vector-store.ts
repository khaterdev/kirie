/**
 * SQLite-based vector store for embedding persistence and similarity search.
 *
 * Uses pure JS cosine similarity (no native extensions needed).
 * Embeddings are stored as Float32Array buffers in BLOB columns.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "vectors.db");

export interface VectorSearchResult {
  key: string;
  score: number;
  metadata?: Record<string, unknown>;
}

interface VectorRow {
  id: number;
  key: string;
  embedding: Buffer;
  metadata: string;
  created_at: string;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * Convert a number[] embedding to a Buffer containing Float32Array bytes.
 */
function embeddingToBuffer(embedding: number[]): Buffer {
  const float32 = new Float32Array(embedding);
  return Buffer.from(float32.buffer);
}

/**
 * Convert a Buffer back to a Float32Array.
 */
function bufferToFloat32Array(buf: Buffer): Float32Array {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(arrayBuffer);
}

export class VectorStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT    NOT NULL UNIQUE,
        embedding  BLOB    NOT NULL,
        metadata   TEXT    NOT NULL DEFAULT '{}',
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memory_vectors_key ON memory_vectors(key);
    `);
  }

  /**
   * Insert or update an embedding for the given key.
   */
  upsert(key: string, embedding: number[], metadata?: Record<string, unknown>): void {
    const buf = embeddingToBuffer(embedding);
    const metaJson = JSON.stringify(metadata ?? {});
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_vectors (key, embedding, metadata, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           embedding  = excluded.embedding,
           metadata   = excluded.metadata,
           created_at = excluded.created_at`,
      )
      .run(key, buf, metaJson, now);
  }

  /**
   * Search for the top-K most similar vectors to the query embedding.
   *
   * Fetches all candidates from the database and computes cosine similarity
   * in JS. This is acceptable for MVP scale (thousands of memories).
   * For larger scale, consider sqlite-vss or a dedicated vector DB.
   */
  search(queryEmbedding: number[], topK = 10, minScore = 0.0): VectorSearchResult[] {
    const queryVec = new Float32Array(queryEmbedding);
    const rows = this.db
      .prepare("SELECT key, embedding, metadata FROM memory_vectors")
      .all() as VectorRow[];

    const scored: VectorSearchResult[] = [];

    for (const row of rows) {
      const storedVec = bufferToFloat32Array(row.embedding);
      const score = cosineSimilarity(queryVec, storedVec);

      if (score >= minScore) {
        scored.push({
          key: row.key,
          score,
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Retrieve the metadata object for a given key, or null if not found.
   */
  getMetadata(key: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT metadata FROM memory_vectors WHERE key = ?")
      .get(key) as { metadata: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.metadata) as Record<string, unknown>;
  }

  /**
   * Delete an embedding by key.
   */
  delete(key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memory_vectors WHERE key = ?")
      .run(key);
    return result.changes > 0;
  }

  /**
   * Return the number of stored vectors.
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM memory_vectors")
      .get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}
