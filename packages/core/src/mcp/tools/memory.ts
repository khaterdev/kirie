import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Compute a SHA-256 hex digest of the given content string.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "memory.db");

/**
 * Sanitize a user query for FTS5 MATCH by wrapping each whitespace-separated
 * token in double quotes. This prevents FTS5 logic injection (OR, NOT, *, etc.).
 * Any embedded double quotes are escaped by doubling them.
 */
export function sanitizeFTS5Query(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export interface MemoryEntry {
  id: number;
  key: string;
  content: string;
  contentHash?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  id: number;
  key: string;
  content: string;
  content_hash: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        key          TEXT    NOT NULL UNIQUE,
        content      TEXT    NOT NULL,
        content_hash TEXT,
        tags         TEXT    NOT NULL DEFAULT '[]',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    `);

    // Migration: add content_hash column if it doesn't exist (for existing databases)
    const columns = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    const hasContentHash = columns.some((c) => c.name === "content_hash");
    if (!hasContentHash) {
      this.db.exec("ALTER TABLE memories ADD COLUMN content_hash TEXT");
    }

    // FTS virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
        USING fts5(key, content, content=memories, content_rowid=id);
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;
    `);
  }

  private rowToEntry(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      key: row.key,
      content: row.content,
      contentHash: row.content_hash ?? undefined,
      tags: JSON.parse(row.tags) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  store(key: string, content: string, tags?: string[]): MemoryEntry {
    const tagsJson = JSON.stringify(tags ?? []);
    const now = new Date().toISOString();
    const newHash = hashContent(content);

    // Check if existing entry has the same content hash — skip update if unchanged
    const existing = this.db
      .prepare("SELECT content_hash FROM memories WHERE key = ?")
      .get(key) as { content_hash: string | null } | undefined;

    if (existing?.content_hash === newHash) {
      // Content unchanged — return existing entry without modifying updated_at
      const row = this.db
        .prepare("SELECT * FROM memories WHERE key = ?")
        .get(key) as MemoryRow;
      return this.rowToEntry(row);
    }

    const stmt = this.db.prepare(`
      INSERT INTO memories (key, content, content_hash, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        content      = excluded.content,
        content_hash = excluded.content_hash,
        tags         = excluded.tags,
        updated_at   = excluded.updated_at
    `);

    const result = stmt.run(key, content, newHash, tagsJson, now, now);

    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? OR key = ? ORDER BY id DESC LIMIT 1")
      .get(result.lastInsertRowid, key) as MemoryRow;

    return this.rowToEntry(row);
  }

  recall(key: string): MemoryEntry | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE key = ?")
      .get(key) as MemoryRow | undefined;

    return row ? this.rowToEntry(row) : null;
  }

  search(query: string, limit: number = 20): MemoryEntry[] {
    const sanitized = sanitizeFTS5Query(query);
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.id = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as MemoryRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  list(tag?: string, limit: number = 50): MemoryEntry[] {
    if (tag) {
      const rows = this.db
        .prepare(
          `SELECT * FROM memories
           WHERE EXISTS (
             SELECT 1 FROM json_each(tags) WHERE json_each.value = ?
           )
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(tag, limit) as MemoryRow[];

      return rows.map((row) => this.rowToEntry(row));
    }

    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as MemoryRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  delete(key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memories WHERE key = ?")
      .run(key);

    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── MCP tool definitions ────────────────────────────────────────────────────

export interface MemoryToolDefs {
  memory_store: {
    params: { key: string; content: string; tags?: string[] };
    result: MemoryEntry;
  };
  memory_store_document: {
    params: { key: string; content: string; chunkTokens?: number; chunkOverlap?: number; tags?: string[] };
    result: { chunks: number; skipped: number };
  };
  memory_recall: {
    params: { key: string };
    result: MemoryEntry | null;
  };
  memory_search: {
    params: { query: string; limit?: number };
    result: MemoryEntry[];
  };
  memory_list: {
    params: { tag?: string; limit?: number };
    result: MemoryEntry[];
  };
  memory_delete: {
    params: { key: string };
    result: { deleted: boolean };
  };
  memory_semantic_search: {
    params: { query: string; topK?: number; minScore?: number };
    result: MemoryEntry[];
  };
  memory_reindex: {
    params: Record<string, never>;
    result: { status: string; message: string };
  };
}

/** Optional MemoryManager for hybrid FTS5 + vector search */
export interface MemoryManagerLike {
  store(key: string, content: string, tags?: string[]): Promise<void>;
  storeDocument(key: string, content: string, opts?: {
    chunking?: { tokens: number; overlap: number };
    tags?: string[];
  }): Promise<{ chunks: number; skipped: number }>;
  search(query: string, topK?: number): Promise<Array<{ key: string; content: string }>>;
  semanticSearch(query: string, topK?: number, minScore?: number): Promise<Array<{ key: string; score: number }>>;
  recall(key: string): MemoryEntry | null;
  reindex(): Promise<{ processed: number; errors: number }>;
}

export function createMemoryToolHandlers(store: MemoryStore, memoryManager?: MemoryManagerLike) {
  return {
    memory_store: {
      description: "Store a memory by key. Overwrites if key already exists.",
      parameters: {
        type: "object" as const,
        properties: {
          key: { type: "string" as const, description: "Unique key for this memory" },
          content: { type: "string" as const, description: "Content to store" },
          tags: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Optional tags for categorization",
          },
        },
        required: ["key", "content"] as const,
      },
      handler(params: { key: string; content: string; tags?: string[] }): MemoryEntry | Promise<MemoryEntry> {
        if (memoryManager) {
          return memoryManager.store(params.key, params.content, params.tags).then(() => store.recall(params.key)!);
        }
        return store.store(params.key, params.content, params.tags);
      },
    },

    memory_store_document: {
      description: "Store a large document as chunked memory entries with overlap for better search.",
      parameters: {
        type: "object" as const,
        properties: {
          key: { type: "string" as const, description: "Base key for the document chunks" },
          content: { type: "string" as const, description: "Full document content to chunk and store" },
          chunkTokens: { type: "number" as const, description: "Approximate max tokens per chunk (default 512)" },
          chunkOverlap: { type: "number" as const, description: "Approximate overlap tokens between chunks (default 64)" },
          tags: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "Optional tags for categorization",
          },
        },
        required: ["key", "content"] as const,
      },
      handler(params: { key: string; content: string; chunkTokens?: number; chunkOverlap?: number; tags?: string[] }): Promise<{ chunks: number; skipped: number }> | { chunks: number; skipped: number } {
        if (memoryManager) {
          return memoryManager.storeDocument(params.key, params.content, {
            chunking: {
              tokens: params.chunkTokens ?? 512,
              overlap: params.chunkOverlap ?? 64,
            },
            tags: params.tags,
          });
        }
        // Fallback: store as a single entry when no memory manager is available
        store.store(params.key, params.content, params.tags);
        return { chunks: 1, skipped: 0 };
      },
    },

    memory_recall: {
      description: "Recall a memory by its exact key.",
      parameters: {
        type: "object" as const,
        properties: {
          key: { type: "string" as const, description: "Key of the memory to recall" },
        },
        required: ["key"] as const,
      },
      handler(params: { key: string }): MemoryEntry | null {
        return store.recall(params.key);
      },
    },

    memory_search: {
      description: "Full-text search across all memories.",
      parameters: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "Search query" },
          limit: { type: "number" as const, description: "Max results (default 20)" },
        },
        required: ["query"] as const,
      },
      handler(params: { query: string; limit?: number }): MemoryEntry[] | Promise<MemoryEntry[]> {
        if (memoryManager) {
          return memoryManager.search(params.query, params.limit ?? 20).then((results) =>
            results
              .map((r) => store.recall(r.key))
              .filter((e): e is MemoryEntry => e !== null),
          );
        }
        return store.search(params.query, params.limit);
      },
    },

    memory_list: {
      description: "List memories, optionally filtered by tag.",
      parameters: {
        type: "object" as const,
        properties: {
          tag: { type: "string" as const, description: "Filter by this tag" },
          limit: { type: "number" as const, description: "Max results (default 50)" },
        },
        required: [] as const,
      },
      handler(params: { tag?: string; limit?: number }): MemoryEntry[] {
        return store.list(params.tag, params.limit);
      },
    },

    memory_delete: {
      description: "Delete a memory by its key.",
      parameters: {
        type: "object" as const,
        properties: {
          key: { type: "string" as const, description: "Key of the memory to delete" },
        },
        required: ["key"] as const,
      },
      handler(params: { key: string }): { deleted: boolean } {
        return { deleted: store.delete(params.key) };
      },
    },

    memory_semantic_search: {
      description:
        "Semantic search across memories using vector similarity. Falls back to keyword search if embeddings unavailable.",
      parameters: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "Search query" },
          topK: { type: "number" as const, description: "Max results (default 10)" },
          minScore: {
            type: "number" as const,
            description: "Minimum similarity score 0-1 (default 0.5)",
          },
        },
        required: ["query"] as const,
      },
      handler(params: { query: string; topK?: number; minScore?: number }): MemoryEntry[] | Promise<Array<{ key: string; score: number }>> {
        if (memoryManager) {
          return memoryManager.semanticSearch(params.query, params.topK ?? 10, params.minScore ?? 0.5);
        }
        // Fallback to FTS5 when vector store not available
        return store.search(params.query, params.topK ?? 10);
      },
    },

    memory_reindex: {
      description:
        "Recompute vector embeddings for all stored memories. Run after changing embedding provider.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler(): { status: string; message: string; processed?: number; errors?: number } | Promise<{ status: string; message: string; processed?: number; errors?: number }> {
        if (memoryManager) {
          return memoryManager.reindex().then((result) => ({
            status: "reindex_complete",
            message: `Reindexed ${result.processed} memories with ${result.errors} errors.`,
            processed: result.processed,
            errors: result.errors,
          }));
        }
        return {
          status: "reindex_unavailable",
          message:
            "Vector reindexing requires the daemon process. Use gateway API to trigger reindex.",
        };
      },
    },
  };
}
