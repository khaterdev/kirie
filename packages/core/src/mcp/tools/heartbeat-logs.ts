import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { EmbeddingProvider } from "./chat-history.js";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "heartbeat-logs.db");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatLogTier = "tier1" | "tier2" | "tier3" | "heartbeat";
export type HeartbeatLogLevel = "debug" | "info" | "warn" | "error";

export interface HeartbeatLogEntry {
  id: number;
  tick_number: number;
  tier: HeartbeatLogTier;
  category: string;
  level: HeartbeatLogLevel;
  title: string;
  content: string;
  metadata: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface HeartbeatLogInput {
  tick_number: number;
  tier: HeartbeatLogTier;
  category: string;
  level: HeartbeatLogLevel;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  duration_ms?: number;
}

export interface HeartbeatLogMinLevels {
  tier1: HeartbeatLogLevel;
  tier2: HeartbeatLogLevel;
  tier3: HeartbeatLogLevel;
  heartbeat: HeartbeatLogLevel;
}

interface HeartbeatLogRow {
  id: number;
  tick_number: number;
  tier: string;
  category: string;
  level: string;
  title: string;
  content: string;
  metadata: string | null;
  duration_ms: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<HeartbeatLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function levelMeetsMin(level: HeartbeatLogLevel, min: HeartbeatLogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
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

// ---------------------------------------------------------------------------
// HeartbeatLogStore
// ---------------------------------------------------------------------------

export class HeartbeatLogStore {
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider | null;
  private minLevels: HeartbeatLogMinLevels;

  constructor(
    dbPath?: string,
    embeddingProvider?: EmbeddingProvider | null,
    minLevels?: Partial<HeartbeatLogMinLevels>,
  ) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.embeddingProvider = embeddingProvider ?? null;
    this.minLevels = {
      tier1: minLevels?.tier1 ?? "info",
      tier2: minLevels?.tier2 ?? "info",
      tier3: minLevels?.tier3 ?? "debug",
      heartbeat: minLevels?.heartbeat ?? "info",
    };
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tick_number   INTEGER NOT NULL,
        tier          TEXT NOT NULL,
        category      TEXT NOT NULL,
        level         TEXT NOT NULL,
        title         TEXT NOT NULL,
        content       TEXT NOT NULL,
        metadata      TEXT,
        duration_ms   INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_hbl_tick ON heartbeat_logs(tick_number);
      CREATE INDEX IF NOT EXISTS idx_hbl_tier ON heartbeat_logs(tier);
      CREATE INDEX IF NOT EXISTS idx_hbl_category ON heartbeat_logs(category);
      CREATE INDEX IF NOT EXISTS idx_hbl_level ON heartbeat_logs(level);
      CREATE INDEX IF NOT EXISTS idx_hbl_created_at ON heartbeat_logs(created_at);
    `);

    // FTS5 on title + content
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS heartbeat_logs_fts
        USING fts5(title, content, content=heartbeat_logs, content_rowid=id);
    `);

    // Sync triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS hbl_ai AFTER INSERT ON heartbeat_logs BEGIN
        INSERT INTO heartbeat_logs_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hbl_ad AFTER DELETE ON heartbeat_logs BEGIN
        INSERT INTO heartbeat_logs_fts(heartbeat_logs_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hbl_au AFTER UPDATE ON heartbeat_logs BEGIN
        INSERT INTO heartbeat_logs_fts(heartbeat_logs_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO heartbeat_logs_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END;
    `);

    // Vector embeddings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeat_log_vectors (
        log_id      INTEGER PRIMARY KEY,
        embedding   BLOB NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private rowToEntry(row: HeartbeatLogRow): HeartbeatLogEntry {
    return {
      ...row,
      tier: row.tier as HeartbeatLogTier,
      level: row.level as HeartbeatLogLevel,
    };
  }

  /**
   * Insert a log entry if it meets the minimum level for its tier.
   * Fire-and-forget embedding on title + content.
   */
  log(entry: HeartbeatLogInput): void {
    const minLevel = this.minLevels[entry.tier];
    if (!levelMeetsMin(entry.level, minLevel)) return;

    const metadataStr = entry.metadata ? JSON.stringify(entry.metadata) : null;

    const result = this.db
      .prepare(
        `INSERT INTO heartbeat_logs (tick_number, tier, category, level, title, content, metadata, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tick_number,
        entry.tier,
        entry.category,
        entry.level,
        entry.title,
        entry.content,
        metadataStr,
        entry.duration_ms ?? null,
      );

    // Fire-and-forget embedding
    if (this.embeddingProvider && this.embeddingProvider.model !== "noop") {
      const logId = Number(result.lastInsertRowid);
      const text = entry.title + " " + entry.content;
      void this.embedEntry(logId, text);
    }
  }

  private async embedEntry(logId: number, text: string): Promise<void> {
    try {
      const [embedding] = await this.embeddingProvider!.embed([text]);
      if (embedding) {
        const buf = Buffer.from(new Float32Array(embedding).buffer);
        this.db.prepare(
          "INSERT OR IGNORE INTO heartbeat_log_vectors (log_id, embedding) VALUES (?, ?)",
        ).run(logId, buf);
      }
    } catch { /* non-fatal */ }
  }

  /**
   * FTS5 keyword search.
   */
  search(
    query: string,
    opts?: { limit?: number; tier?: HeartbeatLogTier; category?: string; level?: HeartbeatLogLevel },
  ): HeartbeatLogEntry[] {
    const limit = opts?.limit ?? 20;
    const conditions: string[] = ["heartbeat_logs_fts MATCH ?"];
    const params: unknown[] = [query];

    if (opts?.tier) {
      conditions.push("h.tier = ?");
      params.push(opts.tier);
    }
    if (opts?.category) {
      conditions.push("h.category = ?");
      params.push(opts.category);
    }
    if (opts?.level) {
      conditions.push("h.level = ?");
      params.push(opts.level);
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT h.* FROM heartbeat_logs h
         JOIN heartbeat_logs_fts fts ON h.id = fts.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as HeartbeatLogRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Semantic vector search with FTS5 fallback.
   */
  async semanticSearch(
    query: string,
    opts?: { limit?: number; minScore?: number },
  ): Promise<HeartbeatLogEntry[]> {
    if (!this.embeddingProvider || this.embeddingProvider.model === "noop") {
      return this.search(query, opts);
    }
    const limit = opts?.limit ?? 20;
    const minScore = opts?.minScore ?? 0.3;

    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    if (!queryEmbedding) return [];

    const queryVec = new Float32Array(queryEmbedding);

    const rows = this.db
      .prepare(
        `SELECT v.log_id, v.embedding, h.tick_number, h.tier, h.category, h.level,
                h.title, h.content, h.metadata, h.duration_ms, h.created_at
         FROM heartbeat_log_vectors v
         JOIN heartbeat_logs h ON h.id = v.log_id`,
      )
      .all() as Array<{
      log_id: number;
      embedding: Buffer;
      tick_number: number;
      tier: string;
      category: string;
      level: string;
      title: string;
      content: string;
      metadata: string | null;
      duration_ms: number | null;
      created_at: string;
    }>;

    const scored = rows
      .map((row) => {
        const stored = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        const score = cosineSimilarity(queryVec, stored);
        return { ...row, score };
      })
      .filter((r) => r.score >= minScore);

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((r) => ({
      id: r.log_id,
      tick_number: r.tick_number,
      tier: r.tier as HeartbeatLogTier,
      category: r.category,
      level: r.level as HeartbeatLogLevel,
      title: r.title,
      content: r.content,
      metadata: r.metadata,
      duration_ms: r.duration_ms,
      created_at: r.created_at,
    }));
  }

  /**
   * Search by time range with optional filters.
   */
  searchByTimeRange(
    start: string,
    end: string,
    opts?: { tier?: HeartbeatLogTier; category?: string; level?: HeartbeatLogLevel; limit?: number },
  ): HeartbeatLogEntry[] {
    const limit = opts?.limit ?? 50;
    const conditions: string[] = ["created_at >= ?", "created_at <= ?"];
    const params: unknown[] = [start, end];

    if (opts?.tier) {
      conditions.push("tier = ?");
      params.push(opts.tier);
    }
    if (opts?.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts?.level) {
      conditions.push("level = ?");
      params.push(opts.level);
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM heartbeat_logs
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as HeartbeatLogRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Get the latest N entries, optionally filtered by tier/level.
   */
  recent(limit: number = 20, opts?: { tier?: HeartbeatLogTier; level?: HeartbeatLogLevel }): HeartbeatLogEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.tier) {
      conditions.push("tier = ?");
      params.push(opts.tier);
    }
    if (opts?.level) {
      conditions.push("level = ?");
      params.push(opts.level);
    }

    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT * FROM heartbeat_logs
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as HeartbeatLogRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Compact aggregated summary string for triage context injection.
   * Groups by category, counts events, includes avg duration_ms for timed ops.
   */
  recentSummary(hours: number = 24): string {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    const rows = this.db
      .prepare(
        `SELECT category, level, COUNT(*) as cnt,
                AVG(duration_ms) as avg_duration,
                SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as error_count
         FROM heartbeat_logs
         WHERE created_at >= ?
         GROUP BY category`,
      )
      .all(cutoff) as Array<{
      category: string;
      level: string;
      cnt: number;
      avg_duration: number | null;
      error_count: number;
    }>;

    if (rows.length === 0) {
      return `Last ${hours}h: no heartbeat activity logged.`;
    }

    const parts: string[] = [`Last ${hours}h:`];

    for (const row of rows) {
      let part = `${row.cnt} ${row.category.replace(/_/g, " ")}`;
      if (row.avg_duration != null) {
        part += ` (avg ${(row.avg_duration / 1000).toFixed(1)}s)`;
      }
      if (row.error_count > 0) {
        part += ` (${row.error_count} errors)`;
      }
      parts.push(part);
    }

    return parts.join(", ");
  }

  /**
   * Delete logs older than the configured retention per tier.
   * retention is in days. 0 = keep forever.
   */
  pruneOldLogs(retentionDays: { tier1: number; tier2: number; tier3: number; heartbeat: number }): number {
    let totalDeleted = 0;

    for (const [tier, days] of Object.entries(retentionDays)) {
      if (days <= 0) continue; // 0 = keep forever
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);

      // Delete vectors first (foreign key-like cleanup)
      this.db
        .prepare(
          `DELETE FROM heartbeat_log_vectors WHERE log_id IN (
            SELECT id FROM heartbeat_logs WHERE tier = ? AND created_at < ?
          )`,
        )
        .run(tier, cutoff);

      const result = this.db
        .prepare("DELETE FROM heartbeat_logs WHERE tier = ? AND created_at < ?")
        .run(tier, cutoff);

      totalDeleted += result.changes;
    }

    return totalDeleted;
  }

  /**
   * Backfill embeddings for logs that don't have vectors yet.
   */
  async reindex(batchSize = 50): Promise<{ processed: number; errors: number; skipped: number }> {
    if (!this.embeddingProvider || this.embeddingProvider.model === "noop") {
      return { processed: 0, errors: 0, skipped: 0 };
    }

    const rows = this.db
      .prepare(
        `SELECT h.id, h.title, h.content FROM heartbeat_logs h
         LEFT JOIN heartbeat_log_vectors v ON h.id = v.log_id
         WHERE v.log_id IS NULL`,
      )
      .all() as Array<{ id: number; title: string; content: string }>;

    let processed = 0;
    let errors = 0;
    const skipped = 0;

    const insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO heartbeat_log_vectors (log_id, embedding) VALUES (?, ?)",
    );

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const texts = batch.map((r) => r.title + " " + r.content);

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

  close(): void {
    this.db.close();
  }
}

// ── MCP tool definitions ────────────────────────────────────────────────────

export function createHeartbeatLogToolHandlers(store: HeartbeatLogStore) {
  return {
    heartbeat_log_search: {
      description:
        "Keyword search across heartbeat and proactive intelligence system logs. Use for finding specific events, errors, or signals.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Search query (FTS5 full-text search)",
          },
          limit: {
            type: "number" as const,
            description: "Maximum number of results (default 20)",
          },
        },
        required: ["query"] as const,
      },
      handler(params: { query: string; limit?: number }): HeartbeatLogEntry[] {
        return store.search(params.query, { limit: params.limit });
      },
    },

    heartbeat_log_semantic_search: {
      description:
        "Semantic search across heartbeat logs by meaning. Finds relevant events even with different wording (e.g., 'background task failures', 'delivery problems').",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "What to search for (semantic similarity)",
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

    heartbeat_log_time_range: {
      description:
        "Search heartbeat logs within a time range. Supports optional tier, category, and level filters.",
      parameters: {
        type: "object" as const,
        properties: {
          start: {
            type: "string" as const,
            description: "Start time (ISO 8601 or 'YYYY-MM-DD HH:MM:SS')",
          },
          end: {
            type: "string" as const,
            description: "End time (ISO 8601 or 'YYYY-MM-DD HH:MM:SS')",
          },
          tier: {
            type: "string" as const,
            description: "Filter by tier: 'tier1', 'tier2', 'tier3', 'heartbeat'",
          },
          category: {
            type: "string" as const,
            description: "Filter by category (e.g., 'signal_detected', 'triage_decision', 'schedule_fired')",
          },
          level: {
            type: "string" as const,
            description: "Filter by level: 'debug', 'info', 'warn', 'error'",
          },
          limit: {
            type: "number" as const,
            description: "Max results (default 50)",
          },
        },
        required: ["start", "end"] as const,
      },
      handler(params: {
        start: string;
        end: string;
        tier?: string;
        category?: string;
        level?: string;
        limit?: number;
      }): HeartbeatLogEntry[] {
        return store.searchByTimeRange(params.start, params.end, {
          tier: params.tier as HeartbeatLogTier | undefined,
          category: params.category,
          level: params.level as HeartbeatLogLevel | undefined,
          limit: params.limit,
        });
      },
    },

    heartbeat_log_by_tier: {
      description:
        "Get heartbeat logs filtered by tier. tier1=signal detectors, tier2=triage decisions, tier3=escalation tasks, heartbeat=retries/schedules/pruning.",
      parameters: {
        type: "object" as const,
        properties: {
          tier: {
            type: "string" as const,
            description: "Tier to filter: 'tier1', 'tier2', 'tier3', 'heartbeat'",
          },
          limit: {
            type: "number" as const,
            description: "Max results (default 20)",
          },
        },
        required: ["tier"] as const,
      },
      handler(params: { tier: string; limit?: number }): HeartbeatLogEntry[] {
        return store.recent(params.limit ?? 20, {
          tier: params.tier as HeartbeatLogTier,
        });
      },
    },

    heartbeat_log_recent: {
      description:
        "Get the latest N heartbeat log entries. Optionally filter by tier and/or level.",
      parameters: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number" as const,
            description: "Number of entries to return (default 20)",
          },
          tier: {
            type: "string" as const,
            description: "Optional tier filter: 'tier1', 'tier2', 'tier3', 'heartbeat'",
          },
          level: {
            type: "string" as const,
            description: "Optional level filter: 'debug', 'info', 'warn', 'error'",
          },
        },
        required: [] as const,
      },
      handler(params: { limit?: number; tier?: string; level?: string }): HeartbeatLogEntry[] {
        return store.recent(params.limit ?? 20, {
          tier: params.tier as HeartbeatLogTier | undefined,
          level: params.level as HeartbeatLogLevel | undefined,
        });
      },
    },
  };
}
