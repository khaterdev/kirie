import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "usage.db");

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  sessionKey: string;
  timestamp: string;
}

export class UsageTracker {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        model        TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd     REAL NOT NULL DEFAULT 0,
        session_key  TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_key);
      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage(created_at);
    `);
  }

  /** Record token usage from an agent execution */
  record(record: UsageRecord): void {
    this.db.prepare(`
      INSERT INTO usage (model, input_tokens, output_tokens, cache_tokens, cost_usd, session_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheTokens,
      record.costUsd,
      record.sessionKey,
      record.timestamp,
    );
  }

  /** Get aggregated usage by model */
  byModel(since?: string): Array<{
    model: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    requestCount: number;
  }> {
    const where = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];

    return this.db.prepare(`
      SELECT
        model,
        SUM(input_tokens) as totalInputTokens,
        SUM(output_tokens) as totalOutputTokens,
        SUM(cost_usd) as totalCostUsd,
        COUNT(*) as requestCount
      FROM usage ${where}
      GROUP BY model
      ORDER BY totalCostUsd DESC
    `).all(...params) as Array<{
      model: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      requestCount: number;
    }>;
  }

  /** Get total cost for a time period */
  totalCost(since?: string): number {
    const where = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage ${where}`
    ).get(...params) as { total: number };
    return row.total;
  }

  /** Expose the underlying database for UsageDashboard queries */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
