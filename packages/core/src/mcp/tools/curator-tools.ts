import { existsSync } from "node:fs";
import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { createModuleLogger } from "../../logging/logger.js";
import { learningDbPath, openLearningDb, type LearningDb } from "../../learning/learning-db.js";
import { CuratorRunStore } from "../../learning/curator-scheduler.js";
import { SkillStateStore } from "../../learning/skill-state-store.js";
import { SKILL_NAME_RE } from "../../learning/proposal-types.js";

/**
 * Skill curator tools (PLAN B.13, C.4, W3-CUR): `skill_usage_stats` and
 * `curator_report`. Both are read-only: learning.db is opened read-only on
 * first use. There is deliberately no run, archive, restore, pin or approve
 * tool; the curator's changes happen only through owner-approved proposals.
 *
 * The factory is pure (no file or DB access when called).
 */

const log = createModuleLogger("curator-tools");

interface CuratorToolState {
  db: LearningDb;
  skillState: SkillStateStore;
  runs: CuratorRunStore;
}

export const createCuratorTools: FeatureToolFactory = (ctx) => {
  let state: CuratorToolState | null = null;

  const open = (): CuratorToolState | null => {
    if (state) return state;
    const path = learningDbPath(ctx.dbDir);
    if (!existsSync(path)) return null;
    try {
      const db = openLearningDb(path, { readonly: true });
      state = { db, skillState: new SkillStateStore(db), runs: new CuratorRunStore(db) };
      return state;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "learning.db unavailable");
      return null;
    }
  };

  const tools: Record<string, McpToolDefinition> = {
    skill_usage_stats: {
      description:
        "Read-only skill usage counters kept by Kirie: name, source (bundled, learned, local, user), state (active, stale, archived), " +
        "use count, last use and whether the owner pinned it. Pass name for one skill. Uses are counted from Skill tool calls and reads of a skill's files.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "One skill name (optional)" },
          limit: { type: "number", description: "Max rows, most used first (default 20, max 200)" },
        },
      },
      handler: (params) => {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (name && !SKILL_NAME_RE.test(name)) return { error: "invalid skill name" };
        const limitRaw = typeof params.limit === "number" ? params.limit : 20;
        const limit = Math.max(1, Math.min(200, Math.trunc(limitRaw)));
        const s = open();
        if (!s) return { skills: [], note: "no usage recorded yet" };
        try {
          const rows = name
            ? [s.skillState.get("project", name), s.skillState.get("user", name)].filter((r) => r !== null)
            : s.skillState.list().sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name)).slice(0, limit);
          return {
            skills: rows.map((r) => ({
              name: r.name, root: r.root, source: r.source, state: r.state, use_count: r.useCount,
              last_used_at: r.lastUsedAt, first_seen_at: r.firstSeenAt, pinned: r.pinned,
            })),
          };
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "skill_usage_stats failed");
          return { error: "skill usage is not available" };
        }
      },
    },

    curator_report: {
      description:
        "Read-only: the last skill curator report (counts, findings per skill and the ids of the proposals it filed). " +
        "The curator only proposes; the owner approves with /proposals. No file contents are included.",
      parameters: { type: "object", properties: {} },
      handler: () => {
        const s = open();
        if (!s) return { report: null, note: "the curator has not run yet" };
        try {
          const last = s.runs.last();
          if (!last?.report) return { report: null, note: "the curator has not run yet" };
          const r = last.report;
          return {
            run_id: last.id,
            trigger: r.trigger,
            started_at: r.startedAt,
            finished_at: r.finishedAt,
            counts: r.counts,
            findings: r.findings.slice(0, 100).map((f) => ({ skill: f.skill, root: f.root, detector: f.detector, category: f.category, severity: f.severity, message: f.message })),
            proposals: r.proposals,
            possible_duplicates: r.possibleDuplicates,
            stale_marked: r.staleMarked,
          };
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "curator_report failed");
          return { error: "the curator report is not available" };
        }
      },
    },
  };
  return tools;
};
