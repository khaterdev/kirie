/**
 * Turn log, skill usage and trust finalization (PLAN C.3, R4 sections 0.4, 0.6, item 4 "Usage tracking").
 *
 * `LearningTurnTracker` is the glue: a stream observer accumulates tool and
 * skill names per turn (names only, never inputs), `pipeline.onTurnComplete`
 * supplies origin and chat-history ids for chat turns, and background, goal and
 * webhook turns are recorded on their `turn_end`. `TurnRecorder` writes
 * `turn_log` and `skill_usage`, bumps `skill_state`, and finalizes the trust of
 * agent-filed proposals from the turn's provenance. Trust is computed by code,
 * never by a model.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createModuleLogger } from "../logging/logger.js";
import type { SdkStreamEvent } from "../engine/sdk-options.js";
import { originOf, type TurnContextRegistry, type TurnOrigin } from "../engine/turn-context.js";
import {
  newToolUseSummary,
  observeSdkMessage,
  usedUntrustedTool,
  type ToolUseSummary,
} from "../engine/tool-observer.js";
import type { TurnCompleteEvent, TurnInputs } from "../routing/pipeline.js";
import { parseSessionKey } from "../routing/session-key.js";
import type { LearningAuditSink } from "./intake.js";
import type { LearningDb } from "./learning-db.js";
import type { ProposalStore } from "./proposal-store.js";
import { isSkillContentKind, type ProposalTrust } from "./proposal-types.js";
import type { SkillRoot, SkillStateStore } from "./skill-state-store.js";

const log = createModuleLogger("learning-turns");

export type TurnSource = "main" | "background" | "proactive";

export interface TurnRecordInput {
  sessionKey: string;
  sdkSessionId?: string | null;
  source: TurnSource;
  origin: TurnOrigin;
  senderId?: string;
  senderRole?: string;
  userMsgId?: number;
  assistantMsgId?: number;
  startedAt: number;
  endedAt: number;
  numTurns: number;
  costUsd: number;
  isError: boolean;
  wasAborted: boolean;
  toolUse: ToolUseSummary;
  /**
   * What the pipeline put in the prompt besides the sender's own text. Chat
   * turns always carry it (the tracker fails closed when it is missing);
   * absent means nothing beyond the session key's chat type is known.
   */
  inputs?: TurnInputs;
  /** Set by the tracker when a chat turn arrived without its inputs */
  inputsMissing?: boolean;
}

/**
 * Why a turn's prompt held content the owner did not write (LEARN-B4):
 * - `group`: not the owner's DM (other people's messages are in the context);
 * - `forwarded`: the message itself is someone else's text;
 * - `reply`: replied-to or reaction-target text;
 * - `task_results`: background task results;
 * - `attachment`: files, photos, video (not voice notes or stickers);
 * - `unknown_inputs`: a chat turn whose inputs were not reported;
 * - `earlier_turn`: an earlier turn still in the model's context was not owner-only.
 */
export type TurnContextReason = "group" | "forwarded" | "reply" | "task_results" | "attachment" | "unknown_inputs" | "earlier_turn";

/** Reasons that make a turn untrusted outright: the owner's own words are not what the model acted on. */
const UNTRUSTED_REASONS: ReadonlySet<string> = new Set(["group", "forwarded"]);

/**
 * "Recent context" of a turn, for trust: every earlier turn of the same SDK
 * session (the resumed session holds all of them), and the last
 * RECENT_CONTEXT_TURNS turns of the same session key whatever their SDK
 * session (the pipeline puts the 20 newest chat-history rows in every prompt,
 * and every turn adds at least one row).
 */
export const RECENT_CONTEXT_TURNS = 20;
/** More earlier turns than this in one SDK session is treated as unknown (mixed). */
const MAX_SESSION_TURNS_CHECKED = 2000;

export interface TurnLogRecord {
  id: number;
  sessionKey: string;
  source: TurnSource;
  origin: TurnOrigin;
  senderId: string | null;
  senderRole: string | null;
  userMsgId: number | null;
  assistantMsgId: number | null;
  startedAt: string;
  endedAt: string;
  numTurns: number;
  costUsd: number;
  isError: boolean;
  wasAborted: boolean;
  tools: Record<string, number>;
  skills: string[];
  untrustedInput: boolean;
  sdkSessionId: string | null;
  /** Null for rows recorded before provenance existed (unknown) */
  chatType: string | null;
  /** TurnContextReason values */
  context: string[];
}

interface TurnLogRow {
  id: number;
  session_key: string;
  source: string;
  origin: string;
  sender_id: string | null;
  sender_role: string | null;
  user_msg_id: number | null;
  assistant_msg_id: number | null;
  started_at: string;
  ended_at: string;
  num_turns: number;
  cost_usd: number;
  is_error: number;
  was_aborted: number;
  tools: string;
  skills: string;
  untrusted_input: number;
  sdk_session_id: string | null;
  chat_type: string | null;
  context: string | null;
}

function toRecord(r: TurnLogRow): TurnLogRecord {
  const parse = <T>(t: string, f: T): T => { try { return JSON.parse(t) as T; } catch { return f; } };
  return {
    id: r.id,
    sessionKey: r.session_key,
    source: r.source as TurnSource,
    origin: r.origin as TurnOrigin,
    senderId: r.sender_id,
    senderRole: r.sender_role,
    userMsgId: r.user_msg_id,
    assistantMsgId: r.assistant_msg_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    numTurns: r.num_turns,
    costUsd: r.cost_usd,
    isError: r.is_error === 1,
    wasAborted: r.was_aborted === 1,
    tools: parse<Record<string, number>>(r.tools, {}),
    skills: parse<string[]>(r.skills, []),
    untrustedInput: r.untrusted_input === 1,
    sdkSessionId: r.sdk_session_id,
    chatType: r.chat_type,
    context: parse<string[]>(r.context ?? "[]", []),
  };
}

// ---------------------------------------------------------------------------
// Trust (R4 0.6)
// ---------------------------------------------------------------------------

type TrustFields = Pick<TurnLogRecord, "origin" | "untrustedInput" | "chatType" | "context"> & Partial<Pick<TurnLogRecord, "source">>;

/**
 * The trust of one turn, from what was in its prompt (LEARN-B4):
 * - `owner` only for the owner's own DM message whose prompt held nothing
 *   else: no non-trusted tool, no forwarded, replied-to, attachment or
 *   background text, and no earlier turn in its context that was not owner;
 * - `untrusted` for any other origin, a background turn, a group turn or a
 *   forwarded message;
 * - `mixed` otherwise, and whenever provenance is unknown (rows recorded
 *   before it existed).
 */
export function trustOfTurn(t: TrustFields): ProposalTrust {
  if (t.source !== undefined && t.source !== "main") return "untrusted";
  if (t.origin !== "owner_message") return "untrusted";
  if (t.chatType !== null && t.chatType !== "dm") return "untrusted";
  if (t.context.some((r) => UNTRUSTED_REASONS.has(r))) return "untrusted";
  if (t.chatType === null || t.untrustedInput || t.context.length > 0) return "mixed";
  return "owner";
}

/** The trust of a turn from its own inputs only, ignoring what earlier turns left in its context. */
function ownTrustOfTurn(t: TrustFields): ProposalTrust {
  return trustOfTurn({ ...t, context: t.context.filter((r) => r !== "earlier_turn") });
}

function chatTypeOf(sessionKey: string, inputs: TurnInputs | undefined): string | null {
  return inputs?.chatType ?? parseSessionKey(sessionKey)?.chatType ?? null;
}

function contextReasons(input: TurnRecordInput, chatType: string | null): TurnContextReason[] {
  const out: TurnContextReason[] = [];
  if (chatType !== null && chatType !== "dm") out.push("group");
  if (input.inputsMissing) out.push("unknown_inputs");
  const i = input.inputs;
  if (i?.forwarded) out.push("forwarded");
  if (i?.replyContext) out.push("reply");
  if (i?.taskResults) out.push("task_results");
  if (i?.attachments) out.push("attachment");
  return out;
}

/** The trust of a window of turns: the weakest turn wins. An empty window is untrusted. */
export function trustOfWindow(turns: ReadonlyArray<TrustFields>): ProposalTrust {
  if (turns.length === 0) return "untrusted";
  let trust: ProposalTrust = "owner";
  for (const t of turns) {
    const tt = trustOfTurn(t);
    if (tt === "untrusted") return "untrusted";
    if (tt === "mixed") trust = "mixed";
  }
  return trust;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface TurnRecorderDeps {
  db: LearningDb;
  store: ProposalStore;
  skillState: SkillStateStore;
  untrustedTools: () => readonly string[];
  /** Tools that bring no outside content; any other tool makes the turn mixed. Default: none (fails closed). */
  trustedTools?: () => readonly string[];
  allowUntrustedSkillProposals: () => boolean;
  /** Project skills root, then the user root (`~/.claude/skills`). Used to place a first-seen skill. */
  skillRoots: { project: string; user?: string };
  audit?: LearningAuditSink;
  /** Called after a turn is recorded. Never awaited; a throw is logged. */
  onRecorded?: (turn: TurnLogRecord) => void;
}

export class TurnRecorder {
  constructor(private readonly deps: TurnRecorderDeps) {}

  private rootFor(skill: string): SkillRoot | null {
    const existing = this.deps.skillState.findByName(skill);
    if (existing) return existing.root;
    if (existsSync(join(this.deps.skillRoots.project, skill))) return "project";
    if (this.deps.skillRoots.user && existsSync(join(this.deps.skillRoots.user, skill))) return "user";
    return null;
  }

  /**
   * True when an earlier turn still in this turn's context (see
   * RECENT_CONTEXT_TURNS) was not owner-only by its own inputs. Unsure means true.
   */
  private earlierContextTainted(sessionKey: string, sdkSessionId: string | null): boolean {
    const recent = this.deps.db
      .prepare("SELECT * FROM turn_log WHERE session_key = ? ORDER BY id DESC LIMIT ?")
      .all(sessionKey, RECENT_CONTEXT_TURNS) as TurnLogRow[];
    if (recent.some((r) => ownTrustOfTurn(toRecord(r)) !== "owner")) return true;
    if (!sdkSessionId) return false;
    const sameSession = this.deps.db
      .prepare("SELECT * FROM turn_log WHERE session_key = ? AND sdk_session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionKey, sdkSessionId, MAX_SESSION_TURNS_CHECKED + 1) as TurnLogRow[];
    if (sameSession.length > MAX_SESSION_TURNS_CHECKED) return true;
    return sameSession.some((r) => ownTrustOfTurn(toRecord(r)) !== "owner");
  }

  record(input: TurnRecordInput): TurnLogRecord {
    const startedIso = new Date(input.startedAt).toISOString();
    const endedIso = new Date(input.endedAt).toISOString();
    const untrusted = usedUntrustedTool(input.toolUse, this.deps.untrustedTools(), this.deps.trustedTools?.() ?? []);
    const chatType = chatTypeOf(input.sessionKey, input.inputs);
    const sdkSessionId = input.sdkSessionId ?? null;
    const tx = this.deps.db.transaction(() => {
      const context: string[] = contextReasons(input, chatType);
      // Only an owner-clean turn can be lowered by its context; anything else already is.
      const own = trustOfTurn({ source: input.source, origin: input.origin, untrustedInput: untrusted, chatType, context });
      if (own === "owner" && this.earlierContextTainted(input.sessionKey, sdkSessionId)) context.push("earlier_turn");
      const res = this.deps.db
        .prepare(
          `INSERT INTO turn_log (session_key, sdk_session_id, source, origin, sender_id, sender_role, user_msg_id, assistant_msg_id,
             started_at, ended_at, num_turns, cost_usd, is_error, was_aborted, tools, skills, untrusted_input, chat_type, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionKey, sdkSessionId, input.source, input.origin, input.senderId ?? null,
          input.senderRole ?? null, input.userMsgId ?? null, input.assistantMsgId ?? null, startedIso, endedIso,
          Math.max(0, Math.trunc(input.numTurns || 0)), Number.isFinite(input.costUsd) ? input.costUsd : 0,
          input.isError ? 1 : 0, input.wasAborted ? 1 : 0, JSON.stringify(input.toolUse.tools),
          JSON.stringify(input.toolUse.skills), untrusted ? 1 : 0, chatType, JSON.stringify(context),
        );
      const id = Number(res.lastInsertRowid);
      for (const ev of input.toolUse.skillEvents) {
        this.deps.skillState.recordUsage({
          skill: ev.skill, ts: endedIso, sessionKey: input.sessionKey, source: input.source, via: ev.via, turnLogId: id,
        });
        const root = this.rootFor(ev.skill);
        if (root) {
          this.deps.skillState.insert({ name: ev.skill, root, source: root === "user" ? "user" : "local", firstSeenAt: endedIso });
          this.deps.skillState.bumpUse(root, ev.skill, endedIso);
        }
      }
      return id;
    });
    const id = tx();
    const turn = this.get(id)!;
    this.finalizeTrust(turn, input.toolUse.proposalIds);
    if (this.deps.onRecorded) {
      try {
        this.deps.onRecorded(turn);
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "turn listener threw");
      }
    }
    return turn;
  }

  /**
   * Agent-filed proposals take the trust of the turn whose own stream filed
   * them (ids from the learning_propose results), including what its context
   * held (trustOfTurn). A background, goal or webhook turn is always
   * untrusted. Proposals no turn claims stay unverified.
   */
  private finalizeTrust(turn: TurnLogRecord, proposalIds: readonly number[]): void {
    const at = new Date().toISOString();
    const trust: ProposalTrust = trustOfTurn(turn);
    const changed = this.deps.store.finalizeByIds(proposalIds, trust, turn.id);
    if (changed.length === 0) return;
    const allowUntrusted = this.deps.allowUntrustedSkillProposals();
    for (const id of changed) {
      const rec = this.deps.store.get(id);
      if (!rec) continue;
      this.deps.audit?.record({ feature: "learning", action: "proposal.trust_finalized", actor: "system", detail: { id, trust: rec.trust, turnId: turn.id } });
      if (!allowUntrusted && rec.status === "pending" && rec.trust === "untrusted" && isSkillContentKind(rec.kind)) {
        if (this.deps.store.markDroppedBySystem(id, "untrusted source", at)) {
          this.deps.audit?.record({ feature: "learning", action: "proposal.dropped", actor: "system", detail: { id, kind: rec.kind, reason: "untrusted_skill_proposal" } });
        }
      }
    }
  }

  get(id: number): TurnLogRecord | null {
    const row = this.deps.db.prepare("SELECT * FROM turn_log WHERE id = ?").get(id) as TurnLogRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Turns of a session with id greater than `afterId`, oldest first. */
  turnsAfter(sessionKey: string, afterId = 0, limit = 500): TurnLogRecord[] {
    return (this.deps.db
      .prepare("SELECT * FROM turn_log WHERE session_key = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(sessionKey, afterId, limit) as TurnLogRow[]).map(toRecord);
  }

  /** Owner-authored chat turns whose user message id is above `afterMsgId`. */
  ownerTurnsAfterMessage(sessionKey: string, afterMsgId: number): TurnLogRecord[] {
    return (this.deps.db
      .prepare(
        `SELECT * FROM turn_log WHERE session_key = ? AND source = 'main' AND origin = 'owner_message'
           AND user_msg_id > ? ORDER BY id ASC LIMIT 1000`,
      )
      .all(sessionKey, afterMsgId) as TurnLogRow[]).map(toRecord);
  }

  /** Chat turns whose user or assistant message id lies in [fromMsgId, toMsgId]. */
  turnsForMessages(sessionKey: string, fromMsgId: number, toMsgId: number): TurnLogRecord[] {
    return (this.deps.db
      .prepare(
        `SELECT * FROM turn_log WHERE session_key = ?
           AND ((user_msg_id BETWEEN ? AND ?) OR (assistant_msg_id BETWEEN ? AND ?)) ORDER BY id ASC`,
      )
      .all(sessionKey, fromMsgId, toMsgId, fromMsgId, toMsgId) as TurnLogRow[]).map(toRecord);
  }

  lastTurn(sessionKey: string): TurnLogRecord | null {
    const row = this.deps.db.prepare("SELECT * FROM turn_log WHERE session_key = ? ORDER BY id DESC LIMIT 1").get(sessionKey) as TurnLogRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Distinct session keys with a turn since `sinceIso`. */
  sessionsSince(sinceIso: string): string[] {
    return (this.deps.db.prepare("SELECT DISTINCT session_key FROM turn_log WHERE ended_at >= ?").all(sinceIso) as { session_key: string }[])
      .map((r) => r.session_key);
  }
}

// ---------------------------------------------------------------------------
// Stream glue
// ---------------------------------------------------------------------------

interface PendingTurn {
  summary: ToolUseSummary;
  startedAt: number;
  sdkSessionId?: string;
}

const MAX_TRACKED = 500;

export interface LearningTurnTrackerDeps {
  recorder: TurnRecorder;
  turns: TurnContextRegistry;
  /** Skill roots for `Read` detection */
  skillRoots: () => readonly string[];
  now?: () => number;
}

/**
 * Register `observe` as the "learning" stream observer and `onTurnComplete`
 * on the pipeline. Both are synchronous and never throw.
 */
export class LearningTurnTracker {
  private readonly active = new Map<string, PendingTurn>();
  /** Chat turns whose turn_end arrived, waiting for the pipeline's onTurnComplete. */
  private readonly endedChat = new Map<string, PendingTurn>();

  constructor(private readonly deps: LearningTurnTrackerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private static keyOf(ev: SdkStreamEvent): string | null {
    const { ctx } = ev;
    switch (ctx.kind) {
      case "chat":
        return ctx.sessionKey ? `chat:${ctx.sessionKey}` : null;
      case "background":
      case "goal":
      case "webhook":
        return `task:${ctx.taskId ?? ctx.goalId ?? ctx.sessionKey ?? "unknown"}`;
      default:
        return null;
    }
  }

  private static cap(map: Map<string, PendingTurn>): void {
    while (map.size > MAX_TRACKED) {
      const first = map.keys().next().value;
      if (first === undefined) break;
      map.delete(first);
    }
  }

  observe = (ev: SdkStreamEvent): void => {
    try {
      const key = LearningTurnTracker.keyOf(ev);
      if (!key) return;
      if (ev.type === "turn_start") {
        this.active.set(key, { summary: newToolUseSummary(), startedAt: this.now(), ...(ev.sdkSessionId ? { sdkSessionId: ev.sdkSessionId } : {}) });
        LearningTurnTracker.cap(this.active);
        return;
      }
      if (ev.type === "message") {
        let pending = this.active.get(key);
        if (!pending) {
          pending = { summary: newToolUseSummary(), startedAt: this.now() };
          this.active.set(key, pending);
          LearningTurnTracker.cap(this.active);
        }
        observeSdkMessage(ev.message, pending.summary, this.deps.skillRoots(), ev.ctx.cwd);
        const sid = (ev.message as { session_id?: unknown }).session_id;
        if (typeof sid === "string") pending.sdkSessionId = sid;
        return;
      }
      // turn_end
      const pending = this.active.get(key) ?? { summary: newToolUseSummary(), startedAt: this.now() };
      this.active.delete(key);
      if (ev.ctx.kind === "chat") {
        this.endedChat.set(ev.ctx.sessionKey!, pending);
        LearningTurnTracker.cap(this.endedChat);
        return;
      }
      this.deps.recorder.record({
        sessionKey: ev.ctx.sessionKey ?? key,
        sdkSessionId: ev.sdkSessionId ?? pending.sdkSessionId ?? null,
        source: "background",
        origin: originOf(ev.ctx, this.deps.turns),
        startedAt: pending.startedAt,
        endedAt: this.now(),
        numTurns: ev.result.numTurns,
        costUsd: ev.result.costUsd,
        isError: ev.result.isError,
        wasAborted: ev.result.wasAborted,
        toolUse: pending.summary,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), event: ev.type }, "learning stream observer failed");
    }
  };

  onTurnComplete = (ev: TurnCompleteEvent): void => {
    try {
      const pending = this.endedChat.get(ev.sessionKey) ?? this.active.get(`chat:${ev.sessionKey}`);
      this.endedChat.delete(ev.sessionKey);
      this.active.delete(`chat:${ev.sessionKey}`);
      // A chat turn's inputs are required; without them the turn is of unknown provenance (mixed).
      const inputs = (ev as Partial<TurnCompleteEvent>).inputs;
      this.deps.recorder.record({
        sessionKey: ev.sessionKey,
        sdkSessionId: pending?.sdkSessionId ?? ev.result.sessionId ?? null,
        source: "main",
        origin: ev.origin,
        ...(inputs ? { inputs } : { inputsMissing: true }),
        senderId: ev.senderId,
        senderRole: ev.senderRole,
        ...(ev.userMsgId !== undefined ? { userMsgId: ev.userMsgId } : {}),
        ...(ev.assistantMsgId !== undefined ? { assistantMsgId: ev.assistantMsgId } : {}),
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        numTurns: ev.result.numTurns,
        costUsd: ev.result.costUsd,
        isError: ev.result.isError,
        wasAborted: ev.result.wasAborted === true,
        toolUse: pending?.summary ?? newToolUseSummary(),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "learning turn record failed");
    }
  };
}
