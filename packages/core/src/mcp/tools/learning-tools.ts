import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureToolContext, FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { LearningConfigSchema, type LearningConfig } from "../../config/sections/learning.js";
import { AuditTrail } from "../../security/audit-trail.js";
import { scrubSecrets } from "../../security/secret-scrubber.js";
import { scrubBeforeStore } from "../../security/remote-scrub.js";
import { createModuleLogger } from "../../logging/logger.js";
import { LearningIntake, type ProposalSubmission } from "../../learning/intake.js";
import { learningDbPath, openLearningDb, type LearningDb } from "../../learning/learning-db.js";
import { ProposalStore } from "../../learning/proposal-store.js";
import { SkillStateStore } from "../../learning/skill-state-store.js";
import { SKILL_NAME_RE, sha256Hex, type ProposalStatus } from "../../learning/proposal-types.js";

/**
 * Self-learning tools (PLAN B.13, C.3, W2-LEARN): `learning_propose` and
 * `proposals_list`.
 *
 * `learning_propose` only ever inserts a pending proposal through intake, with
 * trust `unverified` (the turn recorder finalizes it from the turn's
 * provenance). There is deliberately no approve, reject, apply or undo tool;
 * nothing in this file can reach the applier.
 *
 * The factory is pure: handlers open learning.db (read-write, WAL) and
 * memory.db (read-only) on first use.
 */

const log = createModuleLogger("learning-tools");

/** kirie-tools env keys the learning feature sets in the daemon. */
export const LEARNING_TOOLS_ENV = {
  /** JSON of the effective `learning` config section (no secrets in it) */
  config: "KIRIE_LEARNING_CONFIG",
  /** `<agentCwd>/.claude/skills` */
  skillsRoot: "KIRIE_LEARNING_SKILLS_ROOT",
} as const;

const PROPOSE_KINDS = ["memory", "memory_md", "skill_new", "skill_update"] as const;
type ProposeKind = (typeof PROPOSE_KINDS)[number];
const LIST_STATUSES: readonly ProposalStatus[] = ["pending", "applied", "rejected", "expired", "failed", "undone", "superseded"];

function readConfig(env: FeatureToolContext["env"]): LearningConfig {
  const raw = env[LEARNING_TOOLS_ENV.config];
  if (raw) {
    try {
      const parsed = LearningConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to defaults
    }
    log.warn("KIRIE_LEARNING_CONFIG is invalid; using learning defaults");
  }
  return LearningConfigSchema.parse({});
}

interface LearningToolState {
  db: LearningDb;
  store: ProposalStore;
  intake: LearningIntake;
  skillsRoot: string;
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

export const createLearningTools: FeatureToolFactory = (ctx) => {
  let state: LearningToolState | null = null;
  let memoryDb: Database.Database | null | undefined;

  const memoryRecall = (key: string): { content: string } | null => {
    if (memoryDb === undefined) {
      const path = join(ctx.dbDir, "memory.db");
      try {
        memoryDb = existsSync(path) ? new Database(path, { readonly: true, fileMustExist: true }) : null;
      } catch {
        memoryDb = null;
      }
    }
    if (!memoryDb) return null;
    try {
      const row = memoryDb.prepare("SELECT content FROM memories WHERE key = ?").get(key) as { content: string } | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  };

  const open = (): LearningToolState => {
    if (state) return state;
    const db = openLearningDb(learningDbPath(ctx.dbDir));
    const store = new ProposalStore(db);
    const skillsRoot = ctx.env[LEARNING_TOOLS_ENV.skillsRoot] || join(ctx.dbDir, ".claude", "skills");
    const audit = new AuditTrail(join(ctx.dbDir, "logs", "audit.jsonl"), { scrub: (t) => scrubSecrets(t, { sink: "audit" }) });
    const intake = new LearningIntake({
      store,
      config: () => readConfig(ctx.env),
      audit,
      skillsRoot,
      skillState: new SkillStateStore(db),
      memoryRecall,
    });
    state = { db, store, intake, skillsRoot };
    return state;
  };

  const tools: Record<string, McpToolDefinition> = {
    learning_propose: {
      description:
        "File a proposal for the owner to review: a memory, a MEMORY.md line, a new skill or a skill update. " +
        "Use this when you want to save a skill or a lasting instruction on your own initiative. " +
        "If the owner explicitly asked you to save it in this conversation, write it directly instead. " +
        "This only files a pending proposal; the owner approves or rejects it with /proposals. You cannot approve it. " +
        "payload is a JSON string: memory {key, content, tags}; memory_md {section, line}; " +
        "skill_new {name, description, skillMd}; skill_update {name, skillMd} (skillMd is the full new SKILL.md).",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: `One of: ${PROPOSE_KINDS.join(", ")}` },
          title: { type: "string", description: "One line, at most 120 characters" },
          rationale: { type: "string", description: "Why this is worth keeping" },
          payload: { type: "string", description: "JSON string, shape depends on kind (see the tool description)" },
          sessionKey: { type: "string", description: "Your session_key from the <session_context> tag (for display; trust is decided by code from the turn that files the proposal)" },
        },
        required: ["kind", "title", "payload", "sessionKey"],
      },
      handler: async (rawParams) => {
        // Known values (the daemon's scrubber, SCRUB-N1) before anything is stored.
        const params: Record<string, unknown> = { ...rawParams };
        for (const field of ["title", "rationale", "payload"] as const) {
          const v = str(rawParams, field);
          if (v !== undefined) params[field] = (await scrubBeforeStore(v, "proposal")).text;
        }
        const kind = str(params, "kind") as ProposeKind | undefined;
        if (!kind || !(PROPOSE_KINDS as readonly string[]).includes(kind)) {
          return { error: `kind must be one of: ${PROPOSE_KINDS.join(", ")}` };
        }
        let payload: Record<string, unknown>;
        try {
          const parsed = JSON.parse(str(params, "payload") ?? "") as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "payload must be a JSON object" };
          payload = parsed as Record<string, unknown>;
        } catch {
          return { error: "payload is not valid JSON" };
        }
        let s: ReturnType<typeof open>;
        try {
          s = open();
        } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err) }, "learning.db unavailable");
          return { error: "the proposals store is not available" };
        }

        const base = {
          title: str(params, "title") ?? "",
          rationale: str(params, "rationale") ?? "",
          origin: "agent_tool" as const,
          trust: "unverified" as const,
          ...(str(params, "sessionKey") ? { sourceSessionKey: str(params, "sessionKey")! } : {}),
        };
        let submission: ProposalSubmission;
        switch (kind) {
          case "memory":
            submission = { ...base, kind: "memory.upsert", payload: { key: payload.key, content: payload.content, tags: payload.tags ?? [] } };
            break;
          case "memory_md":
            submission = { ...base, kind: "memory_md.append", payload: { section: payload.section, line: payload.line } };
            break;
          case "skill_new":
            submission = { ...base, kind: "skill.create", payload: { name: payload.name, description: payload.description, skillMd: payload.skillMd } };
            break;
          case "skill_update": {
            const name = typeof payload.name === "string" ? payload.name : "";
            if (!SKILL_NAME_RE.test(name)) return { error: "skill_update needs a valid skill name" };
            const file = join(s.skillsRoot, name, "SKILL.md");
            if (!existsSync(file)) return { error: `skill "${name}" does not exist; use skill_new` };
            const newSkillMd = payload.skillMd ?? payload.newSkillMd;
            submission = { ...base, kind: "skill.patch", payload: { name, baseHash: sha256Hex(readFileSync(file, "utf8")), newSkillMd } };
            break;
          }
        }
        const result = s.intake.submit(submission);
        if ("dropped" in result) return { status: "dropped", reason: result.dropped };
        return {
          id: result.id,
          status: "pending",
          note: `Filed as proposal #${result.id}. The owner must approve it with /proposals approve ${result.id}. You cannot approve it.`,
        };
      },
    },

    proposals_list: {
      description: "List learning proposals (read-only): id, kind, title, status, trust, created_at. Default: pending.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: `One of: ${LIST_STATUSES.join(", ")}, or all` },
          limit: { type: "number", description: "Max rows (default 20, max 100)" },
        },
      },
      handler: (params) => {
        const status = str(params, "status") ?? "pending";
        if (status !== "all" && !(LIST_STATUSES as readonly string[]).includes(status)) {
          return { error: `status must be one of: ${LIST_STATUSES.join(", ")}, all` };
        }
        const limitRaw = typeof params.limit === "number" ? params.limit : 20;
        const limit = Math.max(1, Math.min(100, Math.trunc(limitRaw)));
        let s: ReturnType<typeof open>;
        try {
          s = open();
        } catch {
          return { error: "the proposals store is not available" };
        }
        const rows = s.store.list({ ...(status === "all" ? {} : { status: status as ProposalStatus }), limit });
        return {
          proposals: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, trust: r.trust, created_at: r.createdAt })),
        };
      },
    },
  };
  return tools;
};
