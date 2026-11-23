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
 * - The full-content rule (LEARN-B3): Approve is offered only for content the
 *   owner has been shown in full. A card carries Approve only when it shows the
 *   whole content, the trust is `owner`, no blocking flag is set and the
 *   proposal was not filed by the agent (LEARN-N4). Everything else needs
 *   `/proposals show <id>`, which sends the complete content over as many
 *   messages as needed, then a typed `/proposals approve <id>`.
 * - Every text shown for review is scrubbed and has hidden and bidi
 *   characters replaced by visible `[U+XXXX]` markers.
 * - Other features add lines to the next digest with `queueLine(text)`.
 */

import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { OwnerCard, OwnerPrompts } from "../interaction/owner-prompts.js";
import type { OwnerActionEvent, OwnerActionHandler, OwnerActionReply } from "../interaction/router.js";
import type { ChannelName } from "../channels/normalizer.js";
import { mintOwnerApproval, type ProposalApplier } from "./applier.js";
import type { LearningAuditSink } from "./intake.js";
import type { LearningKv } from "./learning-db.js";
import type { ProposalRecord, ProposalStore } from "./proposal-store.js";
import { payloadHash8, type ProposalOrigin } from "./proposal-types.js";
import { revealInvisibleChars } from "./invisible-chars.js";

const log = createModuleLogger("learning-notifier");

export const PROPOSAL_ACTION_NS = "prop";
export const DIGEST_MAX_CARDS = 5;
/** A card shows the whole content when it is at most this long; otherwise this much, marked truncated. */
export const CARD_FULL_CONTENT_CHARS = 2500;
const CARD_TRUNCATED_CHARS = 600;
/** Content characters per /proposals show message (each message stays under Telegram's 4096). */
export const SHOW_PAGE_CHARS = 3000;
const MAX_QUEUED_LINES = 20;
const DIGEST_ORIGINS: readonly ProposalOrigin[] = ["reflection", "curator", "user_model"];
const LAST_DIGEST_KEY = "notify:last_digest_at";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Flags that rule out one-tap approval. */
const ONE_TAP_BLOCKING_FLAGS = new Set(["scanner_block", "injection_pattern", "untrusted_source"]);

type PolicyFields = Pick<ProposalRecord, "trust" | "riskFlags" | "origin">;

/**
 * Trust and flags that allow one-tap Approve (and bulk with no flags at all):
 * `owner` trust, no blocking flag, and never a proposal the agent filed
 * itself (LEARN-N4: a rule on the origin, not a flag that might be cleared).
 * One-tap also needs a card that showed the whole content: see
 * `proposalOffersOneTap`.
 */
export function proposalAllowsOneTap(rec: PolicyFields): boolean {
  return rec.origin !== "agent_tool" && rec.trust === "owner" && !rec.riskFlags.some((f) => ONE_TAP_BLOCKING_FLAGS.has(f));
}

/** Bulk approve: one-tap trust, no risk flags at all, never agent-filed. Each one must still have been seen in full. */
export function proposalAllowsBulk(rec: PolicyFields): boolean {
  return proposalAllowsOneTap(rec) && rec.riskFlags.length === 0;
}

/** The text shown to the owner for review: scrubbed, hidden and bidi characters made visible. */
export function reviewText(preview: string): string {
  return revealInvisibleChars(scrubSecrets(preview, { sink: "channel" }));
}

/** True when a card can carry the whole review text. */
export function cardShowsFullContent(preview: string): boolean {
  return reviewText(preview).length <= CARD_FULL_CONTENT_CHARS;
}

/** One-tap Approve is offered: allowed trust and flags, and the card shows the whole content. */
export function proposalOffersOneTap(rec: PolicyFields, preview: string): boolean {
  return proposalAllowsOneTap(rec) && cardShowsFullContent(preview);
}

/** How long a show counts for a later typed approve. */
export const SHOW_BEFORE_APPROVE_MS = 30 * 60_000;

/**
 * Which proposals the owner has been shown in full (/proposals show, or the
 * Show button when the whole content fits in one message), keyed by id and
 * payload hash, so a typed approve applies exactly the content that was
 * shown. In memory: a restart needs a new show.
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

/**
 * The full-content rule for a typed approve: the owner ran a full show in
 * this session, or the proposal went out as a card that showed all of it
 * with one-tap Approve.
 */
export function proposalSeenInFull(
  rec: PolicyFields & Pick<ProposalRecord, "id" | "payloadHash" | "notifiedAt">,
  preview: string,
  reviews: ProposalReviewLog,
): boolean {
  return reviews.wasShown(rec) || (rec.notifiedAt !== null && proposalOffersOneTap(rec, preview));
}

/** Why a typed approve is refused under the full-content rule. */
export function notSeenInFullText(rec: Pick<ProposalRecord, "id">, preview: string): string {
  const len = reviewText(preview).length;
  if (len > CARD_FULL_CONTENT_CHARS) {
    const parts = Math.ceil(len / SHOW_PAGE_CHARS);
    return `Proposal #${rec.id} is ${len.toLocaleString("en-US")} characters long and you have not seen all of it. Read it with /proposals show ${rec.id} (${parts} message${parts === 1 ? "" : "s"}), then approve it.`;
  }
  return `Read proposal #${rec.id} first with /proposals show ${rec.id}, then approve it.`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** What the trust label means, without claiming more than the code checked (LEARN-N12). */
function trustLine(rec: ProposalRecord): string {
  if (rec.origin === "agent_tool") {
    return `Trust: ${rec.trust}. Filed by the assistant itself during a conversation; read it in full before approving. It is never approved with one tap or in bulk.`;
  }
  if (rec.trust === "owner") {
    if (rec.origin === "curator") return "Trust: owner. Built by code from your approved skill files and usage records.";
    return "Trust: owner. The turn log shows only your own direct messages as input for it: no web, file or tool output, forwarded, replied-to or group text, and no background results.";
  }
  if (rec.trust === "mixed") return "Trust: mixed. Warning: content not written by you was in the context (web, files, tool output, replied-to or earlier messages, background results). Read it in full before approving.";
  if (rec.origin === "curator") return `Trust: ${rec.trust}. It is about skill content you have not approved; it cannot be approved with one tap.`;
  return `Trust: ${rec.trust}. Derived from content not written by you; it cannot be approved with one tap.`;
}

function hintLine(rec: ProposalRecord, preview: string): string {
  return proposalOffersOneTap(rec, preview)
    ? `Reply /proposals approve ${rec.id} or /proposals reject ${rec.id}.`
    : `Read it all with Show or /proposals show ${rec.id}, then /proposals approve ${rec.id}${rec.riskFlags.includes("scanner_block") ? " force" : ""}, or /proposals reject ${rec.id}.`;
}

function headerLines(rec: ProposalRecord): string[] {
  const lines = [`Proposal #${rec.id} · ${rec.kind}`, rec.title, `Source: ${rec.origin}`, trustLine(rec)];
  if (rec.riskFlags.length > 0) lines.push(`Flags: ${rec.riskFlags.join(", ")}`);
  return lines;
}

export function renderProposalCardText(rec: ProposalRecord, preview: string): string {
  const body = reviewText(preview);
  const len = body.length.toLocaleString("en-US");
  const lines = headerLines(rec);
  if (body.length <= CARD_FULL_CONTENT_CHARS) {
    lines.push(`Content: ${len} characters, shown in full.`, "", body);
  } else {
    lines.push(
      `Content: ${len} characters. TRUNCATED: this card shows only the first ${CARD_TRUNCATED_CHARS.toLocaleString("en-US")}. Read all of it with /proposals show ${rec.id} before approving.`,
      "",
      truncate(body, CARD_TRUNCATED_CHARS),
    );
  }
  lines.push("", hintLine(rec, preview));
  return lines.join("\n");
}

export function proposalCardButtons(rec: ProposalRecord, preview: string): NonNullable<OwnerCard["buttons"]> {
  const h8 = payloadHash8(rec.payloadHash);
  const show = { label: "Show", ns: PROPOSAL_ACTION_NS, action: `s:${rec.id}:${h8}` };
  const reject = { label: "Reject", ns: PROPOSAL_ACTION_NS, action: `r:${rec.id}:${h8}` };
  if (!proposalOffersOneTap(rec, preview)) return [[show, reject]];
  return [[{ label: "Approve", ns: PROPOSAL_ACTION_NS, action: `a:${rec.id}:${h8}` }, reject, show]];
}

export function renderProposalCard(rec: ProposalRecord, preview: string): OwnerCard {
  return { text: renderProposalCardText(rec, preview), buttons: proposalCardButtons(rec, preview), plain: true };
}

/** Split text into chunks of at most `max` characters, at a line break when one is near. */
function splitPages(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}

/**
 * The complete detail for /proposals show: metadata, then the whole review
 * text split over as many messages as needed. Nothing is cut.
 */
export function renderProposalDetailPages(rec: ProposalRecord, preview: string): string[] {
  const meta = [
    `Proposal #${rec.id} · ${rec.kind} · ${rec.status}`,
    rec.title,
    `Source: ${rec.origin}${rec.sourceSessionKey ? ` (${rec.sourceSessionKey})` : ""}`,
    trustLine(rec),
  ];
  if (rec.riskFlags.length > 0) meta.push(`Flags: ${rec.riskFlags.join(", ")}`);
  if (rec.redactions > 0) meta.push(`Secrets redacted: ${rec.redactions}`);
  if (rec.sourceMsgFrom !== null && rec.sourceMsgTo !== null) meta.push(`Evidence: chat messages m:${rec.sourceMsgFrom} to m:${rec.sourceMsgTo}`);
  if (rec.sourceTurnIds.length > 0) meta.push(`Turns: ${rec.sourceTurnIds.slice(0, 20).join(", ")}`);
  meta.push(`Created ${rec.createdAt.slice(0, 16).replace("T", " ")} UTC, expires ${rec.expiresAt.slice(0, 10)}`);
  if (rec.decidedBy) meta.push(`Decided by ${rec.decidedBy}${rec.decidedVia ? ` via ${rec.decidedVia}` : ""}`);
  if (rec.rejectReason) meta.push(`Reason: ${rec.rejectReason}`);
  if (rec.error) meta.push(`Error: ${rec.error}`);
  if (rec.rationale) meta.push("", `Why: ${truncate(reviewText(rec.rationale), 600)}`);

  const body = reviewText(preview);
  const chunks = splitPages(body, SHOW_PAGE_CHARS);
  const n = chunks.length;
  meta.push("", `Content: ${body.length.toLocaleString("en-US")} characters${n > 1 ? `, in ${n} messages` : ""}.`);
  const tail = rec.status === "pending" || rec.status === "failed" ? ["", hintLine(rec, preview)] : [];
  if (n === 1) return [[...meta, "", chunks[0]!, ...tail].join("\n")];
  return chunks.map((chunk, i) => {
    const head = `Proposal #${rec.id}, part ${i + 1} of ${n}`;
    if (i === 0) return [head, ...meta, "", chunk].join("\n");
    if (i === n - 1) return [head, "", chunk, "", `End of proposal #${rec.id}.`, ...tail].join("\n");
    return [head, "", chunk].join("\n");
  });
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
      const preview = deps.applier.preview(rec);
      const pages = renderProposalDetailPages(rec, preview);
      if (pages.length === 1) {
        deps.reviews.markShown(rec);
        return { replaceText: pages[0]! };
      }
      // Too long for one message: never count this as a full show.
      return {
        replaceText: `${pages[0]!}\n\n(Part 1 of ${pages.length} only. Send /proposals show ${id} to read all of it; it cannot be approved before that.)`,
      };
    }
    if (op === "r") {
      const ok = deps.applier.reject(id, approval, "rejected from card");
      return ok
        ? { replaceText: `Proposal #${id} · ${rec.title}\nRejected ${hhmm(now)}`, removeButtons: true, toast: "Rejected" }
        : { toast: `Proposal #${id} is already ${rec.status}.`, removeButtons: true };
    }
    // One tap only for a card that went out and showed the whole content (LEARN-B3).
    if (rec.notifiedAt === null || !proposalOffersOneTap(rec, deps.applier.preview(rec))) {
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
