/**
 * The only apply path for proposals (PLAN B.7, R4 section 0.8).
 *
 * Binding rules:
 * - Approve, reject and undo require an `OwnerApproval` minted by
 *   `mintOwnerApproval`, which re-checks the owner directory. A plain object
 *   with the same fields is refused. Only the `/proposals` command handler and
 *   the `prop` button handler mint approvals, after the command registry or the
 *   interaction router verified the owner.
 * - Nothing here is reachable from an MCP tool or an HTTP route. The class is
 *   exported from the package root as a type only.
 * - No config key auto-approves anything. Expiry never applies.
 * - The stored payload is scrubbed and validated again before it is applied.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChannelName } from "../channels/normalizer.js";
import { createModuleLogger } from "../logging/logger.js";
import { checkProposalContent, type LearningAuditSink } from "./intake.js";
import type { ProposalRecord, ProposalStore } from "./proposal-store.js";
import { isSkillContentKind, payloadHash8, proposalPayloadHash, type ProposalKind } from "./proposal-types.js";

const log = createModuleLogger("learning-applier");

// ---------------------------------------------------------------------------
// Owner approval
// ---------------------------------------------------------------------------

/** Constructed only by an owner command handler or an owner button handler, after the registry or router verified the owner. */
export interface OwnerApproval {
  readonly channel: string;
  readonly senderId: string;
  readonly via: "command" | "button";
  readonly at: string;
}

const MINTED = new WeakSet<object>();

/**
 * Mint an approval for an owner action. Re-checks the owner directory, so a
 * caller that skipped the registry or router still cannot mint one for a
 * non-owner. Returns null for a non-owner.
 */
export function mintOwnerApproval(
  owners: { isOwner(channel: ChannelName, senderId: string): boolean },
  input: { channel: string; senderId: string; via: "command" | "button" },
): OwnerApproval | null {
  if (!owners.isOwner(input.channel as ChannelName, input.senderId)) return null;
  const approval: OwnerApproval = Object.freeze({
    channel: input.channel,
    senderId: input.senderId,
    via: input.via,
    at: new Date().toISOString(),
  });
  MINTED.add(approval);
  return approval;
}

export function isMintedOwnerApproval(value: unknown): value is OwnerApproval {
  return typeof value === "object" && value !== null && MINTED.has(value);
}

function actorOf(a: OwnerApproval): string {
  return `owner:${a.channel}:${a.senderId}`;
}

// ---------------------------------------------------------------------------
// Kind handlers and outcomes
// ---------------------------------------------------------------------------

export interface ProposalKindHandler {
  /** Returns apply_result. The applier adds `backupDir` to it. */
  apply(payload: unknown, ctx: { proposalId: number; backupDir: string }): Promise<Record<string, unknown>>;
  undo?(applyResult: Record<string, unknown>): Promise<void>;
  /** Text for /proposals show and for cards. Diffs are computed by code. */
  preview(payload: unknown): string;
}

export type ApplyFailureCode =
  | "not_owner" | "not_found" | "already_decided" | "needs_force" | "unverified"
  | "no_handler" | "invalid" | "stale" | "conflict" | "failed" | "not_applied" | "no_undo";

export type ApplyOutcome =
  | { ok: true; id: number; kind: ProposalKind; status: "applied" | "undone"; message: string; result: Record<string, unknown> }
  | { ok: false; id: number; code: ApplyFailureCode; message: string };

/** Thrown by kind handlers for an expected refusal. */
export class ProposalApplyError extends Error {
  readonly code: "stale" | "invalid" | "conflict";
  constructor(code: "stale" | "invalid" | "conflict", message: string) {
    super(message);
    this.name = "ProposalApplyError";
    this.code = code;
  }
}

export interface ProposalApplierDeps {
  store: ProposalStore;
  /** `<dataDir>/backups/learning` */
  backupRoot: string;
  audit?: LearningAuditSink;
  config: () => { allowUntrustedSkillProposals: boolean };
  now?: () => Date;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export class ProposalApplier {
  private readonly kinds = new Map<ProposalKind, ProposalKindHandler>();

  constructor(private readonly deps: ProposalApplierDeps) {}

  registerKind(kind: ProposalKind, handler: ProposalKindHandler): void {
    if (this.kinds.has(kind)) throw new Error(`proposal kind "${kind}" already has a handler`);
    this.kinds.set(kind, handler);
  }

  hasKind(kind: ProposalKind): boolean {
    return this.kinds.has(kind);
  }

  /** Handler preview, or the JSON payload when the kind has no handler. */
  preview(rec: Pick<ProposalRecord, "kind" | "payload">): string {
    const handler = this.kinds.get(rec.kind);
    try {
      if (handler) return handler.preview(rec.payload);
    } catch (err) {
      log.warn({ kind: rec.kind, err: err instanceof Error ? err.message : String(err) }, "proposal preview failed");
    }
    return JSON.stringify(rec.payload, null, 2);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private refuse(id: number, code: ApplyFailureCode, message: string, actor: string, action = "proposal.refused"): ApplyOutcome {
    this.deps.audit?.record({ feature: "learning", action, actor, detail: { id, code } });
    return { ok: false, id, code, message };
  }

  async approve(id: number, approval: OwnerApproval, opts: { force?: boolean } = {}): Promise<ApplyOutcome> {
    if (!isMintedOwnerApproval(approval)) {
      return this.refuse(id, "not_owner", "Only the owner can approve proposals.", "system", "proposal.refused_not_owner");
    }
    const actor = actorOf(approval);
    const rec = this.deps.store.get(id);
    if (!rec) return { ok: false, id, code: "not_found", message: `Proposal #${id} not found.` };
    if (rec.status !== "pending" && rec.status !== "failed") {
      return { ok: false, id, code: "already_decided", message: `Proposal #${id} is already ${rec.status}.` };
    }
    if (rec.riskFlags.includes("scanner_block") && !opts.force) {
      return { ok: false, id, code: "needs_force", message: `Proposal #${id} was flagged by the code scanner. Review it with /proposals show ${id}, then use /proposals approve ${id} force.` };
    }
    if (isSkillContentKind(rec.kind) && (rec.trust === "unverified" || rec.trust === "untrusted") && !this.deps.config().allowUntrustedSkillProposals) {
      return this.refuse(id, "unverified", `Proposal #${id} changes a skill and its source is ${rec.trust}; it cannot be applied.`, actor);
    }
    const handler = this.kinds.get(rec.kind);
    if (!handler) return { ok: false, id, code: "no_handler", message: `No handler is registered for ${rec.kind}.` };

    const at = this.now();
    if (!this.deps.store.claimForApply(id, { by: `${approval.channel}:${approval.senderId}`, via: approval.via, at: at.toISOString() })) {
      return { ok: false, id, code: "already_decided", message: `Proposal #${id} was already decided.` };
    }

    // Defence in depth: scrub and validate the stored payload again.
    const recheck = checkProposalContent(rec.kind, rec.payload, { title: rec.title, rationale: rec.rationale });
    if (!recheck.ok) {
      this.deps.store.markFailed(id, `invalid: ${recheck.reason}`);
      return this.refuse(id, "invalid", `Proposal #${id} failed validation: ${recheck.reason}`, actor, "proposal.apply_failed");
    }
    if (recheck.flags.includes("scanner_block") && !opts.force) {
      this.deps.store.releaseClaim(id, rec.status === "failed" ? "failed" : "pending", null);
      return { ok: false, id, code: "needs_force", message: `Proposal #${id} was flagged by the code scanner. Use /proposals approve ${id} force after reviewing it.` };
    }
    const payload = recheck.payload;
    const newHash = proposalPayloadHash(rec.kind, payload);
    if (newHash !== rec.payloadHash) {
      this.deps.store.updateClaimedPayload(id, payload, newHash, rec.redactions + recheck.redactions);
    }

    const backupDir = join(this.deps.backupRoot, `${id}-${stamp(at)}`);
    let result: Record<string, unknown>;
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      result = { ...(await handler.apply(payload, { proposalId: id, backupDir })), backupDir };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: ApplyFailureCode = err instanceof ProposalApplyError ? err.code : "failed";
      this.deps.store.markFailed(id, code === "failed" ? message : `${code}: ${message}`);
      log.warn({ id, kind: rec.kind, code }, "proposal apply failed");
      this.deps.audit?.record({ feature: "learning", action: "proposal.apply_failed", actor, detail: { id, kind: rec.kind, code } });
      return { ok: false, id, code, message: `Proposal #${id} was not applied: ${message}` };
    }

    this.deps.store.markApplied(id, result, this.now().toISOString());
    this.deps.audit?.record({
      feature: "learning",
      action: "proposal.applied",
      actor,
      detail: { id, kind: rec.kind, via: approval.via, hash8: payloadHash8(newHash), force: opts.force === true },
    });
    const active = rec.kind.startsWith("skill.") ? " Active from the next session." : "";
    return { ok: true, id, kind: rec.kind, status: "applied", message: `Applied #${id} (${rec.kind}).${active}`, result };
  }

  /** pending or failed -> rejected. Returns false when nothing changed. */
  reject(id: number, approval: OwnerApproval, reason?: string): boolean {
    if (!isMintedOwnerApproval(approval)) {
      this.refuse(id, "not_owner", "Only the owner can reject proposals.", "system", "proposal.refused_not_owner");
      return false;
    }
    const ok = this.deps.store.markRejected(
      id,
      { by: `${approval.channel}:${approval.senderId}`, via: approval.via, at: this.now().toISOString() },
      reason ? reason.slice(0, 300) : null,
    );
    if (ok) {
      this.deps.audit?.record({ feature: "learning", action: "proposal.rejected", actor: actorOf(approval), detail: { id, via: approval.via } });
    }
    return ok;
  }

  async undo(id: number, approval: OwnerApproval): Promise<ApplyOutcome> {
    if (!isMintedOwnerApproval(approval)) {
      return this.refuse(id, "not_owner", "Only the owner can undo proposals.", "system", "proposal.refused_not_owner");
    }
    const actor = actorOf(approval);
    const rec = this.deps.store.get(id);
    if (!rec) return { ok: false, id, code: "not_found", message: `Proposal #${id} not found.` };
    if (rec.status !== "applied" || !rec.applyResult) {
      return { ok: false, id, code: "not_applied", message: `Proposal #${id} is ${rec.status}, not applied.` };
    }
    const handler = this.kinds.get(rec.kind);
    if (!handler?.undo) return { ok: false, id, code: "no_undo", message: `${rec.kind} cannot be undone.` };
    if (!this.deps.store.claimForUndo(id)) {
      return { ok: false, id, code: "already_decided", message: `Proposal #${id} is being changed already.` };
    }
    try {
      await handler.undo(rec.applyResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code: ApplyFailureCode = err instanceof ProposalApplyError ? err.code : "failed";
      this.deps.store.releaseUndo(id, `undo ${code}: ${message}`);
      this.deps.audit?.record({ feature: "learning", action: "proposal.undo_failed", actor, detail: { id, kind: rec.kind, code } });
      return { ok: false, id, code, message: `Undo of #${id} failed: ${message}` };
    }
    this.deps.store.markUndone(id, { by: `${approval.channel}:${approval.senderId}`, via: approval.via, at: this.now().toISOString() });
    this.deps.audit?.record({ feature: "learning", action: "proposal.undone", actor, detail: { id, kind: rec.kind } });
    return { ok: true, id, kind: rec.kind, status: "undone", message: `Undid #${id} (${rec.kind}).`, result: rec.applyResult };
  }

  /** pending past expires_at -> expired. Never applies on timeout. */
  expireDue(now: Date): number {
    const ids = this.deps.store.expireDue(now.toISOString());
    for (const id of ids) {
      this.deps.audit?.record({ feature: "learning", action: "proposal.expired", actor: "system", detail: { id } });
    }
    return ids.length;
  }
}
