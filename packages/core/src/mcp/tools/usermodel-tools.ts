import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import { LocalEmbeddings, isModelDownloaded, type EmbeddingProvider } from "@kirie/memory";
import type { FeatureToolContext, FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { UserModelConfigSchema, type UserModelConfig } from "../../config/sections/usermodel.js";
import { createModuleLogger } from "../../logging/logger.js";
import { learningDbPath, openLearningDb, type LearningDb } from "../../learning/learning-db.js";
import { USER_FACT_CARD_MIN_CONFIDENCE, USER_FACT_CATEGORIES, UserFactStore, isUserFactCategory } from "../../learning/usermodel/fact-store.js";

/**
 * User model tool (PLAN B.13, C.5, W3-UM): `user_model_query`.
 *
 * Retrieval only. It opens `learning.db` read-only, never writes, never calls
 * a model and never sends anything off the machine: hybrid search is FTS5
 * plus cosine over the local ONNX embeddings, and the query is embedded only
 * when the local model is already on disk (no download, no remote provider).
 * The main agent does the reasoning over what it returns.
 *
 * Returns `{ enabled: false }` while the user model is off (config, or the
 * `userModel.enabled` runtime override the daemon writes).
 *
 * Who may call it is enforced by the daemon, not here (the stdio subprocess
 * cannot know the session): the feature claims `USER_MODEL_QUERY_TOOL` on the
 * built-in `reserved-mcp` gate, which denies the call in every session except
 * the owner's own DM chat (groups, other senders, background, webhook and goal
 * tasks, voice calls).
 *
 * The factory is pure: handlers open what they need on first use.
 */

const log = createModuleLogger("usermodel-tools");

/** The tool's full SDK name. The daemon claims it on the reserved-mcp gate for the owner's DM chat only. */
export const USER_MODEL_QUERY_TOOL = "mcp__kirie-tools__user_model_query";

/** kirie-tools env keys the user model feature sets in the daemon. */
export const USER_MODEL_TOOLS_ENV = {
  /** JSON of the `userModel` config section (no secrets in it). Absent: the feature is not running. */
  config: "KIRIE_USERMODEL_CONFIG",
} as const;

const BOOL = z.boolean();
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const EMBED_TIMEOUT_MS = 8_000;

export interface UserModelToolDeps {
  /** The query embedder. Default: the local ONNX model when it is on disk, else none. Never remote. */
  queryEmbedder?: () => EmbeddingProvider | null;
}

function readConfig(env: FeatureToolContext["env"]): UserModelConfig | null {
  const raw = env[USER_MODEL_TOOLS_ENV.config];
  if (!raw) return null;
  try {
    const parsed = UserModelConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  log.warn("KIRIE_USERMODEL_CONFIG is invalid; the user model tool reports disabled");
  return null;
}

function band(c: number): "high" | "medium" | "low" {
  return c >= 0.8 ? "high" : c >= USER_FACT_CARD_MIN_CONFIDENCE ? "medium" : "low";
}

async function embedQuery(provider: EmbeddingProvider | null, text: string): Promise<number[] | null> {
  if (!provider) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EMBED_TIMEOUT_MS); });
    const vectors = await Promise.race([provider.embed([text]), timeout]);
    const v = vectors?.[0];
    return Array.isArray(v) && v.some((x) => x !== 0) ? v : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createUserModelToolsWith(ctx: FeatureToolContext, deps: UserModelToolDeps = {}): Record<string, McpToolDefinition> {
  let settings: RuntimeSettings | null = null;
  let db: LearningDb | null = null;
  let store: UserFactStore | null = null;
  let localEmbedder: EmbeddingProvider | null | undefined;

  const enabled = (cfg: UserModelConfig): boolean => {
    settings ??= new RuntimeSettings(join(ctx.dbDir, "state", "runtime-settings.json"), { readonly: true });
    return settings.effective("userModel.enabled", BOOL, cfg.enabled);
  };
  const factStore = (): UserFactStore | null => {
    if (store) return store;
    const path = learningDbPath(ctx.dbDir);
    if (!existsSync(path)) return null;
    db = openLearningDb(path, { readonly: true });
    store = new UserFactStore(db);
    return store;
  };
  const queryEmbedder = (): EmbeddingProvider | null => {
    if (deps.queryEmbedder) return deps.queryEmbedder();
    if (localEmbedder === undefined) localEmbedder = isModelDownloaded() ? new LocalEmbeddings() : null;
    return localEmbedder;
  };

  return {
    user_model_query: {
      description:
        "Look up what is known about the owner (preferences, working style, projects, people they work with, schedule, tools, goals). " +
        "Returns derived facts with category, kind (explicit = the owner said it, inferred = from behaviour), a confidence band, " +
        "when it was last confirmed, and evidence message ids (open them with the chat history tools). Read-only. " +
        "Owner-private: use it only when serving the owner in their own direct chat, never in a group or for anyone else.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "What you want to know, in plain words" },
          category: { type: "string", description: `Optional: one of ${USER_FACT_CATEGORIES.join(", ")}` },
          limit: { type: "number", description: `Max facts (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
          includeLowConfidence: { type: "boolean", description: "Also return unconfirmed inferences (default false)" },
        },
        required: ["question"],
      },
      handler: async (params) => {
        const cfg = readConfig(ctx.env);
        if (!cfg || !enabled(cfg)) return { enabled: false };
        const question = typeof params.question === "string" ? params.question.trim().slice(0, 500) : "";
        if (!question) return { enabled: true, error: "question is required" };
        const category = typeof params.category === "string" && params.category ? params.category.toLowerCase() : undefined;
        if (category !== undefined && !isUserFactCategory(category)) {
          return { enabled: true, error: `category must be one of: ${USER_FACT_CATEGORIES.join(", ")}` };
        }
        const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : DEFAULT_LIMIT;
        const limit = Math.max(1, Math.min(MAX_LIMIT, rawLimit));
        const includeLow = params.includeLowConfidence === true;

        let s: UserFactStore | null;
        try {
          s = factStore();
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "user model store unavailable");
          return { enabled: true, facts: [], note: "The user model store is not available." };
        }
        if (!s) return { enabled: true, facts: [], note: "No facts yet." };

        const hasVectors = s.list({ status: "active", limit: 5000 }).some((f) => f.embedding !== null);
        const queryEmbedding = hasVectors ? await embedQuery(queryEmbedder(), question) : null;
        const result = s.search({
          text: question,
          limit,
          includeLowConfidence: includeLow,
          ...(category ? { category: category as (typeof USER_FACT_CATEGORIES)[number] } : {}),
          queryEmbedding,
        });
        return {
          enabled: true,
          match: result.mode,
          facts: result.facts.map((f) => ({
            id: f.id,
            category: f.category,
            statement: f.statement,
            kind: f.kind,
            confidence: band(f.confidence),
            pinned: f.pinned,
            lastConfirmed: f.lastConfirmedAt.slice(0, 10),
            evidence: f.evidence.map((e) => (e.t === "chat" ? { chatMessageId: e.id, ...(e.ts ? { date: e.ts } : {}) } : { addedByOwner: e.at.slice(0, 10) })),
          })),
          ...(result.mode === "top" ? { note: "No fact matched the question; these are the strongest facts." } : {}),
        };
      },
    },
  };
}

export const createUserModelTools: FeatureToolFactory = (ctx) => createUserModelToolsWith(ctx);
