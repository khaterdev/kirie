import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "chat-history.db");

export interface ChatHistoryEntry {
  id: number;
  session_key: string;
  role: "user" | "assistant";
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  channel: string;
  created_at: string;
}

interface ChatHistoryRow {
  id: number;
  session_key: string;
  role: string;
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  channel: string;
  created_at: string;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dimensions: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class ChatHistoryStore {
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(dbPath?: string, embeddingProvider?: EmbeddingProvider | null) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.embeddingProvider = embeddingProvider ?? null;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT    NOT NULL,
        role        TEXT    NOT NULL,
        sender_name TEXT,
        sender_id   TEXT,
        content     TEXT    NOT NULL,
        channel     TEXT    NOT NULL DEFAULT 'unknown',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_key ON messages(session_key, created_at);
    `);

    // FTS virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(content, content=messages, content_rowid=id);
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content)
        VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content)
        VALUES (new.id, new.content);
      END;
    `);

    // Vector embeddings table for semantic search
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_vectors (
        message_id  INTEGER PRIMARY KEY,
        embedding   BLOB NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private rowToEntry(row: ChatHistoryRow): ChatHistoryEntry {
    return {
      ...row,
      role: row.role as "user" | "assistant",
    };
  }

  append(
    sessionKey: string,
    role: "user" | "assistant",
    content: string,
    opts?: {
      senderName?: string;
      senderId?: string;
      channel?: string;
    },
  ): void {
    const result = this.db
      .prepare(
        `INSERT INTO messages (session_key, role, sender_name, sender_id, content, channel)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionKey,
        role,
        opts?.senderName ?? null,
        opts?.senderId ?? null,
        content,
        opts?.channel ?? "unknown",
      );

    // Fire-and-forget: embed the message asynchronously for semantic search
    if (this.embeddingProvider && this.embeddingProvider.model !== "noop") {
      const msgId = Number(result.lastInsertRowid);
      void this.embedMessage(msgId, content);
    }
  }

  private async embedMessage(messageId: number, content: string): Promise<void> {
    try {
      const [embedding] = await this.embeddingProvider!.embed([content]);
      if (embedding) {
        const buf = Buffer.from(new Float32Array(embedding).buffer);
        this.db.prepare(
          "INSERT OR IGNORE INTO message_vectors (message_id, embedding) VALUES (?, ?)"
        ).run(messageId, buf);
      }
    } catch { /* non-fatal */ }
  }

  recent(sessionKey?: string, limit: number = 50): ChatHistoryEntry[] {
    const sql = sessionKey
      ? `SELECT * FROM (
           SELECT * FROM messages
           WHERE session_key = ?
           ORDER BY id DESC
           LIMIT ?
         ) sub ORDER BY id ASC`
      : `SELECT * FROM (
           SELECT * FROM messages
           ORDER BY id DESC
           LIMIT ?
         ) sub ORDER BY id ASC`;

    const rows = sessionKey
      ? this.db.prepare(sql).all(sessionKey, limit) as ChatHistoryRow[]
      : this.db.prepare(sql).all(limit) as ChatHistoryRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  search(
    query: string,
    opts?: {
      sessionKey?: string;
      limit?: number;
    },
  ): ChatHistoryEntry[] {
    const limit = opts?.limit ?? 20;

    if (opts?.sessionKey) {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM messages m
           JOIN messages_fts fts ON m.id = fts.rowid
           WHERE messages_fts MATCH ?
             AND m.session_key = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, opts.sessionKey, limit) as ChatHistoryRow[];

      return rows.map((row) => this.rowToEntry(row));
    }

    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN messages_fts fts ON m.id = fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as ChatHistoryRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  async semanticSearch(
    query: string,
    opts?: { limit?: number; minScore?: number },
  ): Promise<ChatHistoryEntry[]> {
    if (!this.embeddingProvider || this.embeddingProvider.model === "noop") {
      // fallback to FTS5
      return this.search(query, opts);
    }
    const limit = opts?.limit ?? 20;
    const minScore = opts?.minScore ?? 0.3;

    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    if (!queryEmbedding) return [];

    const queryVec = new Float32Array(queryEmbedding);

    // Load all message vectors
    const rows = this.db.prepare(
      `SELECT mv.message_id, mv.embedding, m.session_key, m.role, m.sender_name,
              m.sender_id, m.content, m.channel, m.created_at
       FROM message_vectors mv
       JOIN messages m ON m.id = mv.message_id`
    ).all() as Array<{
      message_id: number;
      embedding: Buffer;
      session_key: string;
      role: string;
      sender_name: string | null;
      sender_id: string | null;
      content: string;
      channel: string;
      created_at: string;
    }>;

    // Score and rank
    const scored = rows.map(row => {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(queryVec, stored);
      return { ...row, score };
    }).filter(r => r.score >= minScore);

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(r => ({
      id: r.message_id,
      session_key: r.session_key,
      role: r.role as "user" | "assistant",
      sender_name: r.sender_name,
      sender_id: r.sender_id,
      content: r.content,
      channel: r.channel,
      created_at: r.created_at,
    }));
  }

  /**
   * Backfill embeddings for all messages that don't have vectors yet.
   * Processes in batches to avoid memory issues with large histories.
   */
  async reindex(batchSize = 50): Promise<{ processed: number; errors: number; skipped: number }> {
    if (!this.embeddingProvider || this.embeddingProvider.model === "noop") {
      return { processed: 0, errors: 0, skipped: 0 };
    }

    const rows = this.db.prepare(
      `SELECT m.id, m.content FROM messages m
       LEFT JOIN message_vectors mv ON m.id = mv.message_id
       WHERE mv.message_id IS NULL`
    ).all() as Array<{ id: number; content: string }>;

    let processed = 0;
    let errors = 0;
    const skipped = 0;

    const insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO message_vectors (message_id, embedding) VALUES (?, ?)"
    );

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const texts = batch.map(r => r.content);

      try {
        const embeddings = await this.embeddingProvider.embed(texts);
        for (let j = 0; j < batch.length; j++) {
          const embedding = embeddings[j];
          if (embedding) {
            const buf = Buffer.from(new Float32Array(embedding).buffer);
            insertStmt.run(batch[j]!.id, buf);
            processed++;
          }
        }
      } catch {
        errors += batch.length;
      }
    }

    return { processed, errors, skipped };
  }

  /**
   * Count the total number of messages for a session.
   */
  messageCount(sessionKey: string): number {
    const row = this.db.prepare<[string], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages WHERE session_key = ?",
    ).get(sessionKey);
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── MCP tool definitions ────────────────────────────────────────────────────

export function createChatHistoryToolHandlers(store: ChatHistoryStore) {
  return {
    chat_history_recent: {
      description:
        "Retrieve recent chat messages. If sessionKey is provided, returns messages for that session only. Otherwise returns recent messages across all sessions. Messages are in chronological order (oldest first).",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "Optional session key to filter by (e.g., 'telegram:dm:12345'). Omit to get recent messages across all sessions.",
          },
          limit: {
            type: "number" as const,
            description: "Maximum number of messages to return (default 50)",
          },
        },
        required: [] as const,
      },
      handler(params: { sessionKey?: string; limit?: number }): ChatHistoryEntry[] {
        return store.recent(params.sessionKey, params.limit);
      },
    },

    chat_history_search: {
      description:
        "Full-text search across all chat history messages. Optionally filter by session key.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Search query (full-text search)",
          },
          sessionKey: {
            type: "string" as const,
            description: "Optional session key to narrow search to a specific session",
          },
          limit: {
            type: "number" as const,
            description: "Maximum number of results (default 20)",
          },
        },
        required: ["query"] as const,
      },
      handler(params: {
        query: string;
        sessionKey?: string;
        limit?: number;
      }): ChatHistoryEntry[] {
        return store.search(params.query, {
          sessionKey: params.sessionKey,
          limit: params.limit,
        });
      },
    },

    chat_history_semantic_search: {
      description:
        "Search chat history by meaning using semantic similarity. Finds past conversations even with different wording.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "What to search for",
          },
          limit: {
            type: "number" as const,
            description: "Max results (default 20)",
          },
        },
        required: ["query"] as const,
      },
      async handler(params: Record<string, unknown>) {
        return store.semanticSearch(params.query as string, {
          limit: params.limit as number,
        });
      },
    },

    chat_history_reindex: {
      description:
        "Backfill vector embeddings for all chat history messages that don't have them yet. Run this after switching embedding providers or to enable semantic search on old messages.",
      parameters: {
        type: "object" as const,
        properties: {
          batchSize: {
            type: "number" as const,
            description: "Number of messages to embed per batch (default 50)",
          },
        },
        required: [] as const,
      },
      async handler(params: Record<string, unknown>) {
        return store.reindex(params.batchSize as number | undefined);
      },
    },
  };
}
