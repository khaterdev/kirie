/**
 * Token usage dashboard with aggregation queries.
 * Built on top of the existing UsageTracker SQLite database.
 */
import type Database from "better-sqlite3";

export interface UsageSummary {
  period: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCostUsd: number;
  models: Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export interface AgentUsage {
  agentId: string;
  totalRequests: number;
  totalCostUsd: number;
  sessions: number;
}

export interface SessionUsage {
  sessionKey: string;
  requests: number;
  totalCostUsd: number;
  lastActive: string;
}

export class UsageDashboard {
  constructor(private db: Database.Database) {}

  getSummary(period: "day" | "week" | "month"): UsageSummary {
    const since = this.periodToDate(period);

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) as totalRequests,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_tokens), 0) as totalCacheTokens,
        COALESCE(SUM(cost_usd), 0) as totalCostUsd
      FROM usage WHERE created_at >= ?
    `).get(since) as any;

    const models = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cost_usd), 0) as costUsd
      FROM usage WHERE created_at >= ?
      GROUP BY model ORDER BY costUsd DESC
    `).all(since) as any[];

    return {
      period,
      totalRequests: totals.totalRequests,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      totalCacheTokens: totals.totalCacheTokens,
      totalCostUsd: totals.totalCostUsd,
      models,
    };
  }

  getTopSessions(limit: number = 10, period: "day" | "week" | "month" = "month"): SessionUsage[] {
    const since = this.periodToDate(period);
    return this.db.prepare(`
      SELECT
        session_key as sessionKey,
        COUNT(*) as requests,
        COALESCE(SUM(cost_usd), 0) as totalCostUsd,
        MAX(created_at) as lastActive
      FROM usage WHERE created_at >= ?
      GROUP BY session_key
      ORDER BY totalCostUsd DESC
      LIMIT ?
    `).all(since, limit) as SessionUsage[];
  }

  exportCsv(period: "day" | "week" | "month"): string {
    const since = this.periodToDate(period);
    const rows = this.db.prepare(`
      SELECT model, input_tokens, output_tokens, cache_tokens, cost_usd, session_key, created_at
      FROM usage WHERE created_at >= ?
      ORDER BY created_at ASC
    `).all(since) as any[];

    const header = "model,input_tokens,output_tokens,cache_tokens,cost_usd,session_key,created_at";
    const lines = rows.map((r: any) =>
      `${r.model},${r.input_tokens},${r.output_tokens},${r.cache_tokens},${r.cost_usd},${r.session_key},${r.created_at}`
    );
    return [header, ...lines].join("\n");
  }

  private periodToDate(period: "day" | "week" | "month"): string {
    const now = new Date();
    switch (period) {
      case "day": now.setDate(now.getDate() - 1); break;
      case "week": now.setDate(now.getDate() - 7); break;
      case "month": now.setMonth(now.getMonth() - 1); break;
    }
    return now.toISOString();
  }
}
