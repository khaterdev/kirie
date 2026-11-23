import { join } from "node:path";
import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { LoopsConfigSchema, type LoopsConfig } from "../../config/sections/loops.js";
import { effectiveSettingFlag } from "../../config/sections/effective.js";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { AuditTrail } from "../../security/audit-trail.js";
import { scrubSecrets } from "../../security/secret-scrubber.js";
import { parseSessionKey } from "../../routing/session-key.js";
import { LOOP_ENDED_STATUSES, LOOP_ID_RE, LoopStore, type LoopRecord } from "../../loops/loop-store.js";
import { LOOPS_TOOLS_CONFIG_ENV, LOOP_PROMPT_MAX_CHARS, checkLoopLimits } from "../../loops/loop-service.js";

/**
 * Loop tools (PLAN B.13, W2-LOOP): loop_create, loop_list, loop_stop.
 *
 * `loop_create` only writes a `pending_approval` row; the daemon applies
 * `loops.agentCreate` (by default it asks the owner with Start / Decline) and
 * re-checks every limit before a loop starts. Nothing here can start, approve
 * or resume a loop. `loop_stop` is always allowed.
 *
 * Pure factory: the DB, the settings file and the audit file are opened on
 * first use.
 */
export const createLoopsTools: FeatureToolFactory = (ctx) => {
  let store: LoopStore | null = null;
  let settings: RuntimeSettings | null = null;
  let audit: AuditTrail | null = null;

  const openStore = (): LoopStore => (store ??= new LoopStore(join(ctx.dbDir, "loops.db")));
  const config = (): LoopsConfig => {
    const raw = ctx.env[LOOPS_TOOLS_CONFIG_ENV];
    if (raw) {
      try {
        const parsed = LoopsConfigSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // Fall through to the defaults (loops off)
      }
    }
    return LoopsConfigSchema.parse(undefined);
  };
  const enabled = (cfg: LoopsConfig): boolean => {
    settings ??= new RuntimeSettings(join(ctx.dbDir, "state", "runtime-settings.json"), { readonly: true });
    return effectiveSettingFlag(settings, "loops.enabled", cfg.enabled);
  };
  const record = (action: string, actor: string, detail: Record<string, unknown>): void => {
    try {
      audit ??= new AuditTrail(join(ctx.dbDir, "logs", "audit.jsonl"), { scrub: (t) => scrubSecrets(t, { sink: "audit" }) });
      audit.record({ feature: "loops", action, actor, detail });
    } catch {
      // The audit trail never blocks a tool call
    }
  };

  const view = (l: LoopRecord) => ({
    id: l.id,
    status: l.status,
    sessionKey: l.sessionKey,
    prompt: l.prompt.length > 200 ? `${l.prompt.slice(0, 200)}…` : l.prompt,
    intervalSeconds: l.baseIntervalSec,
    currentIntervalSeconds: l.currentIntervalSec,
    backoff: l.backoff,
    runs: l.runs,
    maxRuns: l.maxRuns,
    nextRunAt: l.status === "active" ? new Date(l.nextRunAt).toISOString() : null,
    expiresAt: new Date(l.expiresAt).toISOString(),
    lastStatus: l.lastStatus,
    createdBy: l.createdBy,
    endedReason: l.endedReason,
  });

  const tools: Record<string, McpToolDefinition> = {
    loop_create: {
      description:
        "Propose a recurring check that re-runs a prompt in a chat on an interval (like the owner's /loop). " +
        "It does not start by itself: the owner is asked to Start or Decline it. Loops run only in the owner's DM, " +
        "stay quiet when nothing changed, and back off. Use loop_list to see whether it started.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key of the owner's DM conversation (from <session_context>)" },
          intervalSeconds: { type: "number", description: "Seconds between checks (at least the configured minimum, usually 60)" },
          prompt: { type: "string", description: "What to check each time, written as an instruction to yourself" },
          maxRuns: { type: "number", description: "Most runs before the loop ends (default and cap: the configured default)" },
          expiryHours: { type: "number", description: "Hours before the loop expires (default and cap: the configured default)" },
          backoff: { type: "boolean", description: "Check less often while nothing changes (default true)" },
        },
        required: ["sessionKey", "intervalSeconds", "prompt"],
      },
      handler(params) {
        const cfg = config();
        if (!enabled(cfg)) return { created: false, error: "Loops are off. The owner can turn them on with /loop on." };
        if (cfg.agentCreate === "deny") return { created: false, error: "Agent-created loops are disabled (loops.agentCreate: deny)." };
        const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        const parts = parseSessionKey(sessionKey);
        if (!parts) return { created: false, error: "sessionKey is not a valid session key (channel:chatType:chatId)." };
        if (parts.chatType !== "dm") return { created: false, error: "Loops run only in the owner's DM." };
        const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
        if (!prompt) return { created: false, error: "prompt is required." };
        if (prompt.length > LOOP_PROMPT_MAX_CHARS) return { created: false, error: `prompt can be at most ${LOOP_PROMPT_MAX_CHARS} characters.` };
        const intervalSec = Math.round(Number(params.intervalSeconds));
        const maxRuns = params.maxRuns === undefined ? cfg.defaultMaxRuns : Math.round(Number(params.maxRuns));
        const expiryHours = params.expiryHours === undefined ? cfg.defaultExpiryHours : Number(params.expiryHours);
        const expiryMs = Math.round(expiryHours * 3_600_000);
        const problem = checkLoopLimits(cfg, { intervalSec, maxRuns, expiryMs, createdBy: "agent" });
        if (problem) return { created: false, error: problem };
        const s = openStore();
        if (s.count("pending_approval") >= cfg.maxActive) {
          return { created: false, error: "Too many loops are already waiting for the owner. Wait for an answer first." };
        }
        const now = Date.now();
        const loop = s.create({
          sessionKey,
          channel: parts.channel,
          chatId: parts.chatId,
          chatType: parts.chatType,
          prompt,
          intervalSec,
          backoff: params.backoff !== false,
          maxRuns,
          expiresAt: now + expiryMs,
          createdBy: "agent",
          status: "pending_approval",
          now,
        });
        record("loop.proposed", `agent:${sessionKey}`, { id: loop.id, sessionKey, intervalSec, maxRuns, expiryMs });
        return {
          created: true,
          id: loop.id,
          status: loop.status,
          note: cfg.agentCreate === "allow"
            ? "The daemon starts it within a minute and tells the owner."
            : "The owner will be asked to Start or Decline it. It does nothing until then.",
        };
      },
    },

    loop_list: {
      description: "List loops (recurring checks): id, status, interval, runs, next run. Ended loops only with includeEnded.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Only loops in this conversation" },
          includeEnded: { type: "boolean", description: "Also list done, expired, cancelled and declined loops (default false)" },
        },
        required: [],
      },
      handler(params) {
        const sessionKey = typeof params.sessionKey === "string" && params.sessionKey.trim() ? params.sessionKey.trim() : undefined;
        const includeEnded = params.includeEnded === true;
        const loops = openStore().list({
          ...(sessionKey ? { sessionKey } : {}),
          ...(includeEnded ? {} : { statuses: ["active", "paused", "pending_approval"] as const }),
          limit: 50,
        });
        return { enabled: enabled(config()), loops: loops.map(view) };
      },
    },

    loop_stop: {
      description: "Stop a loop by id (always allowed). A stopped loop cannot be restarted.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Loop id, like l-ab2cd" } },
        required: ["id"],
      },
      handler(params) {
        const id = typeof params.id === "string" ? params.id.trim().toLowerCase() : "";
        if (!LOOP_ID_RE.test(id)) return { stopped: false, error: "id must look like l-ab2cd." };
        const s = openStore();
        const loop = s.get(id);
        if (!loop) return { stopped: false, error: `No loop ${id}.` };
        if (LOOP_ENDED_STATUSES.has(loop.status)) return { stopped: false, error: `Loop ${id} has already ended (${loop.status}).` };
        const ended = s.end(id, "cancelled", "agent");
        if (!ended) return { stopped: false, error: `Loop ${id} has already ended.` };
        record("loop.ended", "agent", { id, reason: "agent" });
        return { stopped: true, id, runs: ended.runs };
      },
    },
  };
  return tools;
};
