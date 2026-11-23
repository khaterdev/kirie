/**
 * Proposal delivery (PLAN C.3 "Delivery", B.5 durable cards, R4 section 0.10).
 *
 * - Reflection, curator and user-model proposals go to the owner's DM in a
 *   digest: at most every `learning.digestIntervalMinutes`, inside
 *   `proactive.activeHours`, 5 cards max plus "N more: /proposals list".
 *   Agent-tool and owner-command proposals are not pushed.
 * - Cards use `OwnerPrompts.sendCard`, namespace `prop`, action
 *   `<a|r|s>:<id>:<h8>` (h8 = first 8 hex chars of payload_hash). A press is
 *   refused when h8 does not match the stored hash.
 * - One-tap Approve only for trust `owner` or `mixed` without `scanner_block`.
 *   `mixed` cards carry a warning line. `untrusted` and `unverified` cards have
 *   only Show and Reject; they are approved with the typed command after show.
 * - Other features add lines to the next digest with `queueLine(text)`.
 */

import { createModuleLogger } from "../logging/logger.js";
import type { OwnerCard, OwnerPrompts } from "../interaction/owner-prompts.js";
import type { OwnerActionEvent, OwnerActionHandler, OwnerActionReply } from "../interaction/router.js";
import type { ChannelName } from "../channels/normalizer.js";
import { mintOwnerApproval, type ProposalApplier } from "./applier.js";
import type { LearningAuditSink } from "./intake.js";
import type { LearningKv } from "./learning-db.js";
import type { ProposalRecord, ProposalStore } from "./proposal-store.js";
import { payloadHash8, type ProposalOrigin } from "./proposal-types.js";

const log = createModuleLogger("learning-notifier");

export const PROPOSAL_ACTION_NS = "prop";
export const DIGEST_MAX_CARDS = 5;
const CARD_PREVIEW_CHARS = 600;
const SHOW_PREVIEW_CHARS = 3200;
const MAX_QUEUED_LINES = 20;
const DIGEST_ORIGINS: readonly ProposalOrigin[] = ["reflection", "curator", "user_model"];
const LAST_DIGEST_KEY = "notify:last_digest_at";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Flags that rule out one-tap approval. */
const ONE_TAP_BLOCKING_FLAGS = new Set(["scanner_block", "injection_pattern", "untrusted_source"]);

/**
 * One-tap Approve (and typed approve without a prior show): owner trust and no
 * blocking flag. `mixed`, `untrusted` and `unverified` need /proposals show,
 * then a typed /proposals approve.
 */
export function proposalAllowsOneTap(rec: Pick<ProposalRecord, "trust" | "riskFlags">): boolean {
  return rec.trust === "owner" && !rec.riskFlags.some((f) => ONE_TAP_BLOCKING_FLAGS.has(f));
}

/** Bulk approve: owner trust and no risk flags at all. */
export function proposalAllowsBulk(rec: Pick<ProposalRecord, "trust" | "riskFlags">): boolean {
  return rec.trust === "owner" && rec.riskFlags.length === 0;
}

/** How long a show counts for a later typed approve. */
export const SHOW_BEFORE_APPROVE_MS = 30 * 60_000;

/**
 * Which proposals the owner has looked at in full (/proposals show or the Show
 * button), keyed by id and payload hash, so a typed approve applies exactly
 * the content that was shown. In memory: a restart needs a new show.
 */
export class ProposalReviewLog {
  private readonly shown = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private static key(rec: Pick<ProposalRecord, "id" | "payloadHash">): string {
    return `${rec.id}:${rec.payloadHash}`;
  }

  markShown(rec: Pick<ProposalRecord, "id" | "payloadHash">): void {
    this.shown.set(ProposalReviewLog.key(rec), this.now());
    if (this.shown.size > 500) {
      const first = this.shown.keys().next().value;
      if (first !== undefined) this.shown.delete(first);
    }
  }

  wasShown(rec: Pick<ProposalRecord, "id" | "payloadHash">): boolean {
    const at = this.shown.get(ProposalReviewLog.key(rec));
    return at !== undefined && this.now() - at <= SHOW_BEFORE_APPROVE_MS;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function trustLine(rec: ProposalRecord): string {
  if (rec.trust === "owner") return "Trust: owner (from your own messages)";
  if (rec.trust === "mixed") return "Trust: mixed. Warning: the turn also read content not written by you (web, files, shell, tools). Read it in full before approving.";
  return `Trust: ${rec.trust}. Derived from content not written by you; it cannot be approved with one tap.`;
}

function hintLine(rec: ProposalRecord): string {
  return proposalAllowsOneTap(rec)
    ? `Reply /proposals approve ${rec.id} or /proposals reject ${rec.id}.`
    : `Review with Show or /proposals show ${rec.id}, then /proposals approve ${rec.id}${rec.riskFlags.includes("scanner_block") ? " force" : ""}, or /proposals reject ${rec.id}.`;
}

export function renderProposalCardText(rec: ProposalRecord, preview: string): string {
  const lines = [
    `Proposal #${rec.id} · ${rec.kind}`,
    rec.title,
    `Source: ${rec.origin}`,
    trustLine(rec),
  ];
  if (rec.riskFlags.length > 0) lines.push(`Flags: ${rec.riskFlags.join(", ")}`);
  lines.push("", truncate(preview, CARD_PREVIEW_CHARS), "", hintLine(rec));
  return lines.join("\n");
}

export function proposalCardButtons(rec: ProposalRecord): NonNullable<OwnerCard["buttons"]> {
  const h8 = payloadHash8(rec.payloadHash);
  const show = { label: "Show", ns: PROPOSAL_ACTION_NS, action: `s:${rec.id}:${h8}` };
  const reject = { label: "Reject", ns: PROPOSAL_ACTION_NS, action: `r:${rec.id}:${h8}` };
  if (!proposalAllowsOneTap(rec)) return [[show, reject]];
  return [[{ label: "Approve", ns: PROPOSAL_ACTION_NS, action: `a:${rec.id}:${h8}` }, reject, show]];
}

export function renderProposalCard(rec: ProposalRecord, preview: string): OwnerCard {
  return { text: renderProposalCardText(rec, preview), buttons: proposalCardButtons(rec), plain: true };
}

/** Full detail for /proposals show and the Show button. */
export function renderProposalDetail(rec: ProposalRecord, preview: string, maxPreview = SHOW_PREVIEW_CHARS): string {
  const lines = [
    `Proposal #${rec.id} · ${rec.kind} · ${rec.status}`,
    rec.title,
    `Source: ${rec.origin}${rec.sourceSessionKey ? ` (${rec.sourceSessionKey})` : ""}`,
    trustLine(rec),
  ];
  if (rec.riskFlags.length > 0) lines.push(`Flags: ${rec.riskFlags.join(", ")}`);
  if (rec.redactions > 0) lines.push(`Secrets redacted: ${rec.redactions}`);
  if (rec.sourceMsgFrom !== null && rec.sourceMsgTo !== null) lines.push(`Evidence: chat messages m:${rec.sourceMsgFrom} to m:${rec.sourceMsgTo}`);
  if (rec.sourceTurnIds.length > 0) lines.push(`Turns: ${rec.sourceTurnIds.slice(0, 20).join(", ")}`);
  lines.push(`Created ${rec.createdAt.slice(0, 16).replace("T", " ")} UTC, expires ${rec.expiresAt.slice(0, 10)}`);
  if (rec.decidedBy) lines.push(`Decided by ${rec.decidedBy}${rec.decidedVia ? ` via ${rec.decidedVia}` : ""}`);
  if (rec.rejectReason) lines.push(`Reason: ${rec.rejectReason}`);
  if (rec.error) lines.push(`Error: ${rec.error}`);
  if (rec.rationale) lines.push("", `Why: ${truncate(rec.rationale, 600)}`);
  lines.push("", truncate(preview, maxPreview));
  if (rec.status === "pending" || rec.status === "failed") lines.push("", hintLine(rec));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface ProposalNotifierDeps {
  store: ProposalStore;
  prompts: Pick<OwnerPrompts, "sendCard">;
  preview: (rec: ProposalRecord) => string;
  config: () => { digestIntervalMinutes: number };
  isActiveHours: () => boolean;
  kv: LearningKv;
  now?: () => Date;
}

export class ProposalNotifier {
  private readonly lines: string[] = [];
  private sending = false;

  constructor(private readonly deps: ProposalNotifierDeps) {}

  /** Add one line to the next digest (other features' summaries). */
  queueLine(text: string): void {
    const line = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!line) return;
    this.lines.push(line);
    while (this.lines.length > MAX_QUEUED_LINES) this.lines.shift();
  }

  queuedLines(): readonly string[] {
    return [...this.lines];
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Send a digest when one is due. `force` ignores the interval, never the active hours. */
  async maybeSendDigest(opts: { force?: boolean } = {}): Promise<{ sent: number }> {
    if (this.sending) return { sent: 0 };
    if (!this.deps.isActiveHours()) return { sent: 0 };
    const now = this.now();
    if (!opts.force) {
      const last = Date.parse(this.deps.kv.get(LAST_DIGEST_KEY) ?? "");
      if (Number.isFinite(last) && now.getTime() - last < this.deps.config().digestIntervalMinutes * 60_000) return { sent: 0 };
    }
    const pending = this.deps.store.listUnnotified(DIGEST_ORIGINS, 200);
    if (pending.length === 0 && this.lines.length === 0) return { sent: 0 };

    this.sending = true;
    try {
      const cards = pending.slice(0, DIGEST_MAX_CARDS);
      const more = pending.length - cards.length;
      const header = [
        pending.length > 0 ? `Learning digest: ${pending.length} new proposal${pending.length === 1 ? "" : "s"} to review.` : "Learning digest.",
        ...this.lines.map((l) => `- ${l}`),
        ...(more > 0 ? [`${more} more: /proposals list`] : []),
      ].join("\n");
      const headerSent = await this.deps.prompts.sendCard({ text: header, plain: true });
      if (!headerSent) return { sent: 0 };
      this.lines.length = 0;
      let sent = 0;
      for (const rec of cards) {
        const target = await this.deps.prompts.sendCard(renderProposalCard(rec, this.deps.preview(rec)));
        if (!target) break;
        this.deps.store.markNotified(rec.id, this.now().toISOString(), target.messageId);
        sent++;
      }
      this.deps.kv.set(LAST_DIGEST_KEY, now.toISOString());
      return { sent };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "proposal digest failed");
      return { sent: 0 };
    } finally {
      this.sending = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Button handler (namespace "prop")
// ---------------------------------------------------------------------------

const ACTION_RE = /^([ars]):(\d{1,12}):([0-9a-f]{8})$/;

export interface ProposalActionDeps {
  store: ProposalStore;
  applier: ProposalApplier;
  reviews: ProposalReviewLog;
  owners: { isOwner(channel: ChannelName, senderId: string): boolean };
  audit?: LearningAuditSink;
  now?: () => Date;
}

function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

/**
 * The `prop` namespace handler. The router has already checked that the press
 * came from an owner in their own DM; the approval is minted again here.
 */
export function createProposalActionHandler(deps: ProposalActionDeps): OwnerActionHandler {
  return async (ev: OwnerActionEvent): Promise<OwnerActionReply> => {
    const m = ACTION_RE.exec(ev.action);
    if (!m) return { toast: "Expired." };
    const [, op, idText, h8] = m;
    const id = Number(idText);
    const rec = deps.store.get(id);
    if (!rec || payloadHash8(rec.payloadHash) !== h8) {
      deps.audit?.record({ feature: "learning", action: "proposal.card_mismatch", actor: `owner:${ev.channel}:${ev.senderId}`, detail: { id, op } });
      return { toast: "This card no longer matches the proposal. Use /proposals show.", alert: true };
    }
    const approval = mintOwnerApproval(deps.owners, { channel: ev.channel, senderId: ev.senderId, via: "button" });
    if (!approval) return { toast: "Only the owner can do that.", alert: true };
    const now = deps.now?.() ?? new Date();

    if (op === "s") {
      deps.reviews.markShown(rec);
      return { replaceText: renderProposalDetail(rec, deps.applier.preview(rec)) };
    }
    if (op === "r") {
      const ok = deps.applier.reject(id, approval, "rejected from card");
      return ok
        ? { replaceText: `Proposal #${id} · ${rec.title}\nRejected ${hhmm(now)}`, removeButtons: true, toast: "Rejected" }
        : { toast: `Proposal #${id} is already ${rec.status}.`, removeButtons: true };
    }
    if (!proposalAllowsOneTap(rec)) {
      return { toast: `Proposal #${id} needs /proposals show ${id}, then /proposals approve ${id}.`, alert: true };
    }
    const outcome = await deps.applier.approve(id, approval);
    if (outcome.ok) {
      return { replaceText: `Proposal #${id} · ${rec.title}\n${outcome.message} (${hhmm(now)})`, removeButtons: true, toast: "Applied" };
    }
    const terminal = outcome.code === "already_decided";
    return { toast: truncate(outcome.message, 180), alert: true, ...(terminal ? { removeButtons: true } : {}) };
  };
}
