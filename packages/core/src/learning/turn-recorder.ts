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
import type { TurnCompleteEvent } from "../routing/pipeline.js";
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
}

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
  };
}

// ---------------------------------------------------------------------------
// Trust (R4 0.6)
// ---------------------------------------------------------------------------

/** owner: owner-authored and no untrusted tool; mixed: owner-authored with an untrusted tool; else untrusted. */
export function trustOfTurn(t: Pick<TurnLogRecord, "origin" | "untrustedInput">): ProposalTrust {
  if (t.origin !== "owner_message") return "untrusted";
  return t.untrustedInput ? "mixed" : "owner";
}

/** The trust of a window of turns: the weakest turn wins. An empty window is untrusted. */
export function trustOfWindow(turns: ReadonlyArray<Pick<TurnLogRecord, "origin" | "untrustedInput">>): ProposalTrust {
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

  record(input: TurnRecordInput): TurnLogRecord {
    const startedIso = new Date(input.startedAt).toISOString();
    const endedIso = new Date(input.endedAt).toISOString();
    const untrusted = usedUntrustedTool(input.toolUse, this.deps.untrustedTools(), this.deps.trustedTools?.() ?? []);
    const tx = this.deps.db.transaction(() => {
      const res = this.deps.db
        .prepare(
          `INSERT INTO turn_log (session_key, sdk_session_id, source, origin, sender_id, sender_role, user_msg_id, assistant_msg_id,
             started_at, ended_at, num_turns, cost_usd, is_error, was_aborted, tools, skills, untrusted_input)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionKey, input.sdkSessionId ?? null, input.source, input.origin, input.senderId ?? null,
          input.senderRole ?? null, input.userMsgId ?? null, input.assistantMsgId ?? null, startedIso, endedIso,
          Math.max(0, Math.trunc(input.numTurns || 0)), Number.isFinite(input.costUsd) ? input.costUsd : 0,
          input.isError ? 1 : 0, input.wasAborted ? 1 : 0, JSON.stringify(input.toolUse.tools),
          JSON.stringify(input.toolUse.skills), untrusted ? 1 : 0,
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
   * them (ids from the learning_propose results). A background, goal or
   * webhook turn is always untrusted. Proposals no turn claims stay unverified.
   */
  private finalizeTrust(turn: TurnLogRecord, proposalIds: readonly number[]): void {
    const at = new Date().toISOString();
    const trust: ProposalTrust = turn.source === "main" ? trustOfTurn(turn) : "untrusted";
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
      this.deps.recorder.record({
        sessionKey: ev.sessionKey,
        sdkSessionId: pending?.sdkSessionId ?? ev.result.sessionId ?? null,
        source: "main",
        origin: ev.origin,
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
