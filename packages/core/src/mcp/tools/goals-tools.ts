import { join } from "node:path";
import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { parseSessionKey } from "../../routing/session-key.js";
import {
  GOAL_ID_RE,
  GOAL_KV_AGENT_CAPS,
  GOAL_KV_AGENT_CREATE,
  GOAL_KV_ENABLED,
  GoalStore,
  type GoalAgentCaps,
  type GoalRecord,
} from "../../goals/goal-store.js";

/**
 * Goal tools (PLAN B.13, W2-GOAL): goal_create, goal_list, goal_status, goal_stop.
 *
 * They open `<dbDir>/goals.db` themselves on first use (the factory stays
 * pure). The daemon writes the effective switches into the goals.db kv table,
 * so the tools follow `/goal on|off` and `goals.agentCreate` without a restart.
 *
 * - goal_create only files a request: a `pending_approval` row (or `pending`
 *   when goals.agentCreate is "allow"). The daemon asks the owner to Start or
 *   Decline. It takes no check commands, no working directory and no caps
 *   above the configured defaults: check commands come only from the owner.
 * - goal_stop files a stop command; stopping is always allowed.
 * - No tool resumes a goal, raises a cap, edits checks or approves anything.
 */

const AGENT_GOAL_MAX_CHARS = 2000;
const DEFAULT_CAPS: GoalAgentCaps = { maxRounds: 10, maxMinutes: 120, maxCostUsd: 10 };

function readCaps(store: GoalStore): GoalAgentCaps {
  const raw = store.getKv(GOAL_KV_AGENT_CAPS);
  if (!raw) return DEFAULT_CAPS;
  try {
    const v = JSON.parse(raw) as Partial<GoalAgentCaps>;
    return {
      maxRounds: typeof v.maxRounds === "number" && v.maxRounds >= 1 ? v.maxRounds : DEFAULT_CAPS.maxRounds,
      maxMinutes: typeof v.maxMinutes === "number" && v.maxMinutes >= 1 ? v.maxMinutes : DEFAULT_CAPS.maxMinutes,
      maxCostUsd: typeof v.maxCostUsd === "number" && v.maxCostUsd > 0 ? v.maxCostUsd : DEFAULT_CAPS.maxCostUsd,
    };
  } catch {
    return DEFAULT_CAPS;
  }
}

/** Clamp an optional number into [min, max]; fall back to `max` (the configured default). */
function clampCap(value: unknown, min: number, max: number, integer: boolean): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return max;
  const v = integer ? Math.floor(n) : n;
  return Math.min(max, Math.max(min, v));
}

/** What the agent may see of a goal: no check output, no worker report. */
function view(goal: GoalRecord): Record<string, unknown> {
  return {
    id: goal.id,
    status: goal.status,
    goal: goal.goal,
    sessionKey: goal.sessionKey,
    createdBy: goal.createdBy,
    roundsUsed: goal.roundsUsed,
    roundLimit: goal.roundLimit,
    costUsd: Number(goal.costUsd.toFixed(4)),
    costLimitUsd: goal.costLimitUsd,
    maxMinutes: goal.maxMinutes,
    checks: goal.checks.map((c) => c.command),
    lastVerdict: goal.lastVerdict ? { verdict: goal.lastVerdict.verdict, reason: goal.lastVerdict.reason } : null,
    stopReason: goal.stopReason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export const createGoalsTools: FeatureToolFactory = (ctx) => {
  let store: GoalStore | null = null;
  const open = (): GoalStore => (store ??= new GoalStore(join(ctx.dbDir, "goals.db")));

  const tools: Record<string, McpToolDefinition> = {
    goal_create: {
      description:
        "Ask the owner to start a background goal: a worker keeps going in rounds until a judge confirms it is done, or a round, time or cost cap is hit. The goal does not start until the owner taps Start. Use the exact session_key from the <session_context> tag. Check commands cannot be set here; only the owner can add them with /goal.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "The session key from <session_context> (e.g. 'telegram:dm:12345')" },
          goal: { type: "string", description: "What must be true when the goal is done, stated so it can be verified" },
          maxRounds: { type: "number", description: "Optional round cap, at most the configured default" },
          maxMinutes: { type: "number", description: "Optional time cap in minutes, at most the configured default" },
          maxCostUsd: { type: "number", description: "Optional estimated-cost cap in USD, at most the configured default" },
        },
        required: ["sessionKey", "goal"],
      },
      handler(params) {
        const s = open();
        if (s.getKv(GOAL_KV_ENABLED) !== "true") {
          throw new Error("Goals are off. The owner can turn them on with /goal on.");
        }
        const mode = s.getKv(GOAL_KV_AGENT_CREATE) ?? "ask";
        if (mode === "deny") throw new Error("Goals requested by the agent are not allowed (goals.agentCreate is deny).");
        const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        if (!parseSessionKey(sessionKey)) throw new Error("sessionKey must be the exact key from <session_context>.");
        const text = typeof params.goal === "string" ? params.goal.trim() : "";
        if (!text) throw new Error("goal is required.");
        if (text.length > AGENT_GOAL_MAX_CHARS) throw new Error(`goal may be at most ${AGENT_GOAL_MAX_CHARS} characters.`);
        const caps = readCaps(s);
        const goal = s.create({
          sessionKey,
          goal: text,
          // Always a request: the daemon applies goals.agentCreate ("allow" included), never this process.
          status: "pending_approval",
          checks: [],
          checkReview: [],
          cwd: null,
          maxRounds: clampCap(params.maxRounds, 1, caps.maxRounds, true),
          maxMinutes: clampCap(params.maxMinutes, 1, caps.maxMinutes, true),
          maxCostUsd: clampCap(params.maxCostUsd, 0.1, caps.maxCostUsd, false),
          createdBy: "agent",
        });
        return {
          ...view(goal),
          note: mode === "allow"
            ? "Queued; it starts shortly. Progress will be posted in this chat."
            : "Waiting for the owner to tap Start. Progress will be posted in this chat.",
        };
      },
    },

    goal_list: {
      description: "List recent goals of this chat and their status. Use the exact session_key from <session_context>.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "The session key from <session_context>" },
        },
        required: ["sessionKey"],
      },
      handler(params) {
        const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        if (!parseSessionKey(sessionKey)) throw new Error("sessionKey must be the exact key from <session_context>.");
        return open().listRecent({ sessionKey, limit: 20 }).map(view);
      },
    },

    goal_status: {
      description: "Show one goal: status, rounds, estimated cost, last verdict.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Goal id, like g-ab12cd" } },
        required: ["id"],
      },
      handler(params) {
        const id = typeof params.id === "string" ? params.id.trim().toLowerCase() : "";
        if (!GOAL_ID_RE.test(id)) throw new Error("id must look like g-ab12cd.");
        const goal = open().get(id);
        if (!goal) throw new Error(`No goal ${id}.`);
        return view(goal);
      },
    },

    goal_stop: {
      description: "Stop a goal and its background worker. Stopping is always allowed.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Goal id, like g-ab12cd" } },
        required: ["id"],
      },
      handler(params) {
        const id = typeof params.id === "string" ? params.id.trim().toLowerCase() : "";
        if (!GOAL_ID_RE.test(id)) throw new Error("id must look like g-ab12cd.");
        const s = open();
        const goal = s.get(id);
        if (!goal) throw new Error(`No goal ${id}.`);
        if (["done", "failed", "cancelled"].includes(goal.status)) return { id, status: goal.status, note: "Already finished." };
        s.addCommand(id, "stop");
        return { id, status: goal.status, note: "Stop requested; the daemon ends the goal within a few seconds." };
      },
    },
  };
  return tools;
};
