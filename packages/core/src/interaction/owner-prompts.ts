/**
 * OwnerPrompts - the one way any feature asks the owner something.
 *
 * - `ask`: an ephemeral question with buttons and a timer. In memory only;
 *   never rejects; no answer means the default (which must be the safe one).
 * - `requestApproval`: `ask` with Approve / Deny (+ optional extra option),
 *   default deny.
 * - `sendCard` / `onAction`: a durable card with no timer. Its buttons are
 *   routed to a namespace handler registered at boot, so they survive restarts.
 *
 * Every title and body is scrubbed and has hidden, bidi and control
 * characters shown as `[U+XXXX]`. A body that does not fit is cut with an
 * explicit TRUNCATED marker. Text the owner approves for the agent to act on
 * goes in `content`: it is shown in full on the card, or the card says
 * TRUNCATED with the total length and offers only "Show full text" and the
 * safe option; the approving option is offered on a second card, after the
 * whole text was sent (`askWithContent`).
 *
 * Prompts and cards go only to the owner's primary DM (`owners.primary()`),
 * never to a group. A press is accepted only when the prompt exists, has not
 * expired, the chat and message ids match the ones recorded when it was sent,
 * and the option belongs to the prompt. First valid press wins.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";
import { createModuleLogger } from "../logging/logger.js";
import type { ChannelAdapter, InlineButton } from "../channels/adapter.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { OwnerDirectory } from "./owners.js";
import { revealHiddenChars } from "../learning/invisible-chars.js";
import { FULL_TEXT_PAGE_CHARS, splitPages } from "./text-pages.js";
import {
  InteractionRouter,
  INTERACTION_EXPIRED_TEXT,
  type InteractionChannelLookup,
  type OwnerActionEvent,
  type OwnerActionHandler,
  type OwnerActionReply,
} from "./router.js";

const log = createModuleLogger("owner-prompts");

export interface OwnerAskOption {
  /** /^[a-z0-9_]{1,16}$/ */
  id: string;
  label: string;
}

export interface OwnerAskRequest {
  /** "approval" | "confirm" | "goal" | "loop" | "voice" | "computer" | "accounts" | ... */
  kind: string;
  title: string;
  /** Plain text. Scrubbed, hidden characters made visible, cut at 3000 chars with a TRUNCATED marker */
  body?: string;
  /**
   * One line naming what is asked (e.g. "Bash: rm -rf ~/work/repo"). Shown by
   * /pending and in the reply to a typed /approve, /deny or /answer, so a typed
   * code always says what it answered. Default: the title plus the first line
   * of the body. Scrubbed and cut at 300 characters.
   */
  summary?: string;
  /**
   * The exact text the owner is asked to approve (an agent's goal or loop
   * prompt). Never cut silently: see `OwnerPrompts.askWithContent`.
   */
  content?: OwnerAskContent;
  /** 2 to 6 options */
  options: readonly OwnerAskOption[];
  /** Returned on timeout, cancel and unavailable. Must be the safe choice */
  defaultOptionId: string;
  /** Clamped to 5_000 .. 86_400_000 */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OwnerAskContent {
  /** What the text is, e.g. "Goal text", "Prompt" */
  label: string;
  text: string;
}

export type OwnerAskOutcome = "answered" | "timeout" | "cancelled" | "unavailable";

export interface OwnerAskResult {
  optionId: string;
  outcome: OwnerAskOutcome;
  /** Actor string of whoever answered ("owner:telegram:<id>") */
  answeredBy?: string;
  /** 4 chars, shown on the card, usable with /approve, /deny, /answer. Empty when the prompt was never shown */
  code: string;
  /**
   * Opaque reference for audit lines and logs (a hash of the prompt id). Never
   * write `code` to a log or audit line: the agent can read those, and a
   * typed code is how the owner answers on a channel without buttons.
   * Empty when the prompt was never shown.
   */
  ref?: string;
}

export type ApprovalOutcome = "approved" | "denied" | "timeout" | "cancelled" | "unavailable";

export interface OwnerApprovalRequest {
  kind: string;
  title: string;
  body?: string;
  /** See OwnerAskRequest.summary */
  summary?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** A third option; choosing it counts as denied (e.g. { id: "stop", label: "Deny + stop" }) */
  extra?: OwnerAskOption;
  /** Button labels. Default Approve / Deny (confirmations use Confirm / Cancel) */
  labels?: { approve?: string; deny?: string };
}

export interface OwnerCardButton {
  label: string;
  ns: string;
  action: string;
}

export interface OwnerCard {
  text: string;
  buttons?: Array<Array<OwnerCardButton>>;
  plain?: boolean;
}

/** What a typed /approve, /deny or /answer did. Every variant that found the request names it. */
export type AnswerByCodeResult =
  /** Answered. `summary` names the request, `optionLabel` the choice */
  | { status: "ok"; kind: string; summary: string; optionLabel: string }
  /**
   * The request's card has buttons, so a typed code may only pick the safe
   * (default) option. For any other option the real card was sent again,
   * with buttons; the owner answers there.
   */
  | { status: "resent"; kind: string; summary: string }
  /** As "resent", but sending the card again failed. Nothing was answered */
  | { status: "resend-failed"; kind: string; summary: string }
  /** The card is still being sent; try again in a moment */
  | { status: "not-ready"; kind: string; summary: string }
  /** The code belonged to a request that is already over (answered, timed out or cancelled) */
  | { status: "closed"; kind: string; summary: string }
  | { status: "bad-option"; kind: string; summary: string; options: readonly OwnerAskOption[] }
  /** The request was sent to another channel or chat; answer it there */
  | { status: "wrong-chat"; channel: ChannelName }
  | { status: "not-found" }
  | { status: "not-owner" };

export interface OwnerPromptsDeps {
  router: InteractionRouter;
  channelRegistry: InteractionChannelLookup;
  owners: OwnerDirectory;
  audit: AuditTrail;
  /** Maximum prompts pending at once; more resolve at once as unavailable */
  maxPending: number;
  /** Applied to every title, body and card text. Default identity (W1B passes scrubSecrets) */
  scrub?: (text: string) => string;
}

export const OWNER_PROMPT_NAMESPACE = "ask";
export const OWNER_PROMPT_MIN_TIMEOUT_MS = 5_000;
export const OWNER_PROMPT_MAX_TIMEOUT_MS = 86_400_000;
export const OWNER_PROMPT_BODY_MAX_CHARS = 3000;
/** Characters of `content` shown on a card that cannot show all of it. */
export const OWNER_PROMPT_CONTENT_PREVIEW_CHARS = 600;
/** Option id of the "Show full text" button on a card whose content is cut. */
export const OWNER_PROMPT_SHOW_FULL_ID = "show_full";
const TITLE_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 300;
/** A finished prompt's code is not handed out again for this long (CORE-N6), and a late /approve says it is over. */
const RECENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_CODE_MAX = 2000;
const OPTION_ID_RE = /^[a-z0-9_]{1,16}$/;
const PROMPT_ID_RE = /^[0-9a-f]{16}$/;
/** No 0/O, 1/I/L, so codes survive being typed back. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface PendingPrompt {
  readonly id: string;
  /** Audit and log reference (hash of id). The code never goes to the audit trail */
  readonly ref: string;
  readonly code: string;
  readonly kind: string;
  readonly title: string;
  /** One line naming the request (scrubbed). Used by /pending and typed answers */
  readonly summary: string;
  readonly text: string;
  readonly options: readonly OwnerAskOption[];
  readonly defaultOptionId: string;
  readonly expiresAt: number;
  readonly channel: ChannelName;
  /** The chat the card is in. Starts as the owner's configured id; the adapter may resolve it (Discord user id to DM channel) */
  chatId: string;
  /** The owner's configured chat id the prompt was addressed to */
  readonly targetChatId: string;
  /** Set once the card was sent. Presses before that are refused */
  messageId: string | null;
  /** Whether the card carries buttons (and can be updated with updateInteractive) */
  interactive: boolean;
  done: boolean;
  /** Line appended to the card once resolved */
  finalLine: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  removeAbort: (() => void) | null;
  resolve: (r: OwnerAskResult) => void;
}

export class OwnerPrompts {
  private readonly pendingById = new Map<string, PendingPrompt>();
  /** Codes of finished prompts: code -> what it was and until when it stays reserved. */
  private readonly recentCodes = new Map<string, { kind: string; summary: string; until: number }>();
  private readonly scrub: (text: string) => string;
  private closed = false;

  constructor(private readonly deps: OwnerPromptsDeps) {
    this.scrub = deps.scrub ?? ((t) => t);
    deps.router.registerNamespace(OWNER_PROMPT_NAMESPACE, (ev) => this.onPress(ev));
  }

  /** Ask the owner. Never rejects. */
  ask(req: OwnerAskRequest): Promise<OwnerAskResult> {
    if (req && typeof req === "object" && req.content) return this.askWithContent(req, req.content);
    return this.open(req, (body) => truncateMarked(body, OWNER_PROMPT_BODY_MAX_CHARS));
  }

  /**
   * The full-content rule for approvals of agent-written text (E.3): the card
   * shows all of the content, or says TRUNCATED with the total length and
   * offers only "Show full text" and the default (safe) option. "Show full
   * text" sends the whole content as plain messages, then a second card offers
   * the original options. An approving answer is therefore only possible
   * after the owner was sent every character.
   */
  private async askWithContent(req: OwnerAskRequest, content: OwnerAskContent): Promise<OwnerAskResult> {
    const base = req;
    const shown = revealHiddenChars(this.scrub(String(content.text ?? "")));
    const label = String(content.label || "Text");
    const total = shown.text.length.toLocaleString("en-US");
    const hiddenLine = shown.hidden > 0
      ? `\nWarning: it contains ${shown.hidden} hidden, bidi or control character${shown.hidden === 1 ? "" : "s"}, shown as [U+XXXX].`
      : "";
    const head = base.body ? `${this.prepareText(base.body)}\n\n` : "";

    const full = `${head}${label}: ${total} characters, shown in full.${hiddenLine}\n\n${shown.text}`;
    if (full.length <= OWNER_PROMPT_BODY_MAX_CHARS) return this.open(base, () => full);

    const pages = splitPages(shown.text, FULL_TEXT_PAGE_CHARS);
    const safe = base.options?.find((o) => o.id === base.defaultOptionId);
    const approving = (base.options ?? []).filter((o) => o.id !== base.defaultOptionId).map((o) => o.label).join(" or ");
    const first = await this.open(
      {
        ...base,
        options: safe ? [{ id: OWNER_PROMPT_SHOW_FULL_ID, label: "Show full text" }, safe] : base.options,
      },
      () =>
        `${head}${label}: ${total} characters. TRUNCATED: this card shows only the first ${OWNER_PROMPT_CONTENT_PREVIEW_CHARS}. ` +
        `Tap Show full text to receive all of it (${pages.length} message${pages.length === 1 ? "" : "s"}); ${approving || "approval"} is offered only after that.${hiddenLine}\n\n` +
        `${shown.text.slice(0, OWNER_PROMPT_CONTENT_PREVIEW_CHARS)}…`,
    );
    if (first.outcome !== "answered" || first.optionId !== OWNER_PROMPT_SHOW_FULL_ID) return first;

    const sent = await this.sendPages(label, pages);
    if (!sent) return { optionId: base.defaultOptionId, outcome: "unavailable", code: first.code, ref: first.ref };
    return this.open(
      base,
      () => `${head}${label}: ${total} characters, sent in full in the ${pages.length} message${pages.length === 1 ? "" : "s"} above (part 1 to ${pages.length}). Read ${pages.length === 1 ? "it" : "them"} before you answer.${hiddenLine}`,
    );
  }

  /** Send already prepared pages to the owner's primary DM. False when any send fails. */
  private async sendPages(label: string, pages: readonly string[]): Promise<boolean> {
    if (this.closed) return false;
    const target = this.deps.owners.primary();
    if (!target) return false;
    const adapter = this.runningAdapter(target.channel);
    if (!adapter) return false;
    const n = pages.length;
    try {
      for (let i = 0; i < n; i++) {
        const text = [`${label}, part ${i + 1} of ${n}`, "", pages[i]!, ...(i === n - 1 ? ["", `End of ${label.toLowerCase()}.`] : [])].join("\n");
        await adapter.sendText({ ctx: { chatId: target.chatId }, text, plain: true });
      }
      return true;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "owner prompt full text send failed");
      return false;
    }
  }

  /** Scrub, then make hidden, bidi and control characters visible. */
  private prepareText(text: string): string {
    return revealHiddenChars(this.scrub(text)).text;
  }

  /** Create and deliver one prompt. `renderBody` gets the prepared body (or "" when there is none). */
  private open(req: OwnerAskRequest, renderBody: (preparedBody: string) => string): Promise<OwnerAskResult> {
    return new Promise<OwnerAskResult>((resolve) => {
      const unavailable = (reason: string): void => {
        log.info({ kind: req?.kind, reason }, "owner prompt unavailable");
        resolve({ optionId: req?.defaultOptionId, outcome: "unavailable", code: "", ref: "" });
      };

      const invalid = validateRequest(req);
      if (invalid) {
        log.error({ kind: req?.kind, problem: invalid }, "invalid owner prompt request");
        unavailable("invalid");
        return;
      }
      if (req.signal?.aborted) {
        resolve({ optionId: req.defaultOptionId, outcome: "cancelled", code: "", ref: "" });
        return;
      }
      if (this.closed) return unavailable("closed");

      const target = this.deps.owners.primary();
      if (!target) return unavailable("no-owner");
      const adapter = this.runningAdapter(target.channel);
      if (!adapter) return unavailable("channel-down");
      if (this.pendingById.size >= this.deps.maxPending) return unavailable("max-pending");

      const timeoutMs = clamp(req.timeoutMs, OWNER_PROMPT_MIN_TIMEOUT_MS, OWNER_PROMPT_MAX_TIMEOUT_MS);
      const id = randomBytes(8).toString("hex");
      const code = this.newCode();
      const title = truncate(this.prepareText(req.title), TITLE_MAX_CHARS);
      const preparedBody = req.body ? this.prepareText(req.body) : "";
      const body = renderBody(preparedBody) || undefined;
      const summary = this.summarize(req, title, preparedBody);
      const interactive = canSendButtons(adapter);
      const text = renderPrompt(title, body, code, req.options, interactive);

      const entry: PendingPrompt = {
        id,
        ref: promptRef(id),
        code,
        kind: req.kind,
        title,
        summary,
        text,
        options: req.options.map((o) => ({ id: o.id, label: o.label })),
        defaultOptionId: req.defaultOptionId,
        expiresAt: Date.now() + timeoutMs,
        channel: target.channel,
        chatId: target.chatId,
        targetChatId: target.chatId,
        messageId: null,
        interactive,
        done: false,
        finalLine: null,
        timer: null,
        removeAbort: null,
        resolve,
      };
      this.pendingById.set(id, entry);

      entry.timer = setTimeout(() => this.finish(entry, "timeout", entry.defaultOptionId), timeoutMs);
      entry.timer.unref?.();
      if (req.signal) {
        const onAbort = (): void => this.finish(entry, "cancelled", entry.defaultOptionId);
        req.signal.addEventListener("abort", onAbort, { once: true });
        entry.removeAbort = () => req.signal?.removeEventListener("abort", onAbort);
      }

      void this.deliver(entry, adapter);
    });
  }

  /** ask() with Approve / Deny (+ optional extra), default deny. */
  async requestApproval(req: OwnerApprovalRequest): Promise<{ outcome: ApprovalOutcome; optionId: string; code: string; ref?: string }> {
    const options: OwnerAskOption[] = [
      { id: "approve", label: req.labels?.approve ?? "Approve" },
      { id: "deny", label: req.labels?.deny ?? "Deny" },
    ];
    if (req.extra && req.extra.id !== "approve" && req.extra.id !== "deny") options.push(req.extra);
    const res = await this.ask({
      kind: req.kind,
      title: req.title,
      body: req.body,
      ...(req.summary !== undefined ? { summary: req.summary } : {}),
      options,
      defaultOptionId: "deny",
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    let outcome: ApprovalOutcome;
    if (res.outcome === "answered") outcome = res.optionId === "approve" ? "approved" : "denied";
    else outcome = res.outcome;
    return { outcome, optionId: res.optionId, code: res.code, ref: res.ref };
  }

  /** Durable card with no timer. Null when no owner channel is up or the send fails. */
  async sendCard(card: OwnerCard): Promise<{ channel: ChannelName; chatId: string; messageId: string } | null> {
    if (this.closed) return null;
    const target = this.deps.owners.primary();
    if (!target) return null;
    const adapter = this.runningAdapter(target.channel);
    if (!adapter) return null;

    let rows: InlineButton[][] = [];
    try {
      rows = (card.buttons ?? []).map((row) =>
        row.map((b) => ({ label: b.label, data: InteractionRouter.encode(b.ns, b.action) })),
      );
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "owner card has invalid buttons");
      return null;
    }
    rows = rows.filter((r) => r.length > 0);
    const text = this.scrub(card.text);
    const plain = card.plain ?? true;
    const ctx = { chatId: target.chatId };

    try {
      if (rows.length > 0 && canSendButtons(adapter)) {
        const sent = await adapter.sendInteractive!({ ctx, text, buttons: rows, plain });
        return { channel: target.channel, chatId: sent.chatId ?? target.chatId, messageId: sent.id };
      }
      const sent = await adapter.sendText({ ctx, text, plain });
      const last = sent[sent.length - 1];
      if (!last) return null;
      return { channel: target.channel, chatId: last.chatId ?? target.chatId, messageId: last.id };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "owner card send failed");
      return null;
    }
  }

  /** Route a durable card's buttons in namespace `ns` to `handler`. Same as router.registerNamespace. */
  onAction(ns: string, handler: OwnerActionHandler): void {
    this.deps.router.registerNamespace(ns, handler);
  }

  /**
   * Text fallback for buttons: /approve, /deny, /answer (CORE-B1).
   *
   * - Only an owner, and only from the channel and chat the card was sent to.
   * - Every reply names the request, so the owner sees what a code answered.
   * - When the card has buttons, a typed code may only pick the safe (default)
   *   option, e.g. /deny. Any other option sends the real card again, with
   *   buttons, instead of answering: a look-alike text card posted by the
   *   agent therefore never gets a dangerous request approved by a typed code.
   * - A code of a finished prompt stays reserved for a day and answers "closed".
   */
  async answerByCode(
    code: string,
    optionId: string,
    by: { channel: ChannelName; senderId: string; chatId?: string },
  ): Promise<AnswerByCodeResult> {
    if (!this.deps.owners.isOwner(by.channel, by.senderId)) return { status: "not-owner" };
    const wanted = String(code ?? "").trim().toUpperCase();
    const entry = [...this.pendingById.values()].find((p) => p.code === wanted && !p.done);
    if (!entry) {
      this.pruneRecentCodes();
      const recent = this.recentCodes.get(wanted);
      return recent ? { status: "closed", kind: recent.kind, summary: recent.summary } : { status: "not-found" };
    }
    if (by.channel !== entry.channel || (by.chatId !== undefined && by.chatId !== entry.chatId && by.chatId !== entry.targetChatId)) {
      return { status: "wrong-chat", channel: entry.channel };
    }
    const named = { kind: entry.kind, summary: entry.summary };
    const opt = String(optionId ?? "").trim().toLowerCase();
    const option = entry.options.find((o) => o.id === opt);
    if (!option) return { status: "bad-option", ...named, options: entry.options };
    if (entry.interactive && opt !== entry.defaultOptionId) {
      if (entry.messageId === null) return { status: "not-ready", ...named };
      const resent = await this.resendCard(entry);
      return { status: resent ? "resent" : "resend-failed", ...named };
    }
    this.finish(entry, "answered", opt, `owner:${by.channel}:${by.senderId}`, undefined, "typed");
    return { status: "ok", ...named, optionLabel: option.label };
  }

  /**
   * Send a pending prompt's card again, with its buttons, and retire the old
   * card (its keyboard is removed; a press on it answers "Expired."). False
   * when the channel is down or the send fails; the old card then stays valid.
   */
  private async resendCard(entry: PendingPrompt): Promise<boolean> {
    const adapter = this.runningAdapter(entry.channel);
    if (!adapter || !canSendButtons(adapter) || entry.done) return false;
    const oldId = entry.messageId;
    try {
      const sent = await adapter.sendInteractive!({
        ctx: { chatId: entry.chatId },
        text: entry.text,
        buttons: this.buttonRows(entry),
        plain: true,
      });
      if (!sent?.id) throw new Error("no message id returned");
      entry.messageId = sent.id;
      if (entry.done) {
        // Answered (old card, timeout) while the new card was being sent: close the new one too.
        await this.markResolved(entry, adapter, entry.finalLine ?? this.resolvedLine(entry, "cancelled"));
        return true;
      }
    } catch (err) {
      log.warn({ kind: entry.kind, ref: entry.ref, err: err instanceof Error ? err.message : String(err) }, "owner prompt re-send failed");
      return false;
    }
    this.deps.audit.record({
      feature: "prompts",
      action: "prompt.resent",
      actor: "system",
      detail: { kind: entry.kind, ref: entry.ref, channel: entry.channel },
    });
    if (oldId !== null) {
      const ctx = { chatId: entry.chatId };
      const text = `${entry.text}\n\nSent again below. Use the buttons on the new card.`;
      try {
        if (adapter.updateInteractive) await adapter.updateInteractive({ ctx, messageId: oldId, text, buttons: null, plain: true });
        else if (adapter.editMessage) await adapter.editMessage({ ctx, messageId: oldId, text });
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message : String(err) }, "old owner prompt card update failed");
      }
    }
    return true;
  }

  /** Prompts waiting for an answer, oldest first. */
  pending(): ReadonlyArray<{ code: string; kind: string; title: string; summary: string; expiresAt: number; options: readonly OwnerAskOption[] }> {
    return [...this.pendingById.values()]
      .filter((p) => !p.done)
      .map((p) => ({ code: p.code, kind: p.kind, title: p.title, summary: p.summary, expiresAt: p.expiresAt, options: p.options }));
  }

  /**
   * Whether `messageId` is the card of a prompt that is still open. The
   * channel-action route refuses to edit or delete such a message, so the
   * agent cannot rewrite a real card into a look-alike.
   */
  isOpenPromptCard(channel: string, chatId: string, messageId: string): boolean {
    for (const p of this.pendingById.values()) {
      if (!p.done && p.channel === channel && p.chatId === chatId && p.messageId === messageId) return true;
    }
    return false;
  }

  /** Resolve every pending prompt with its default (daemon stop). Later asks resolve as unavailable. */
  cancelAll(reason: string): void {
    this.closed = true;
    for (const entry of [...this.pendingById.values()]) {
      this.finish(entry, "cancelled", entry.defaultOptionId, undefined, reason);
    }
  }

  // -------------------------------------------------------------------------

  private async deliver(entry: PendingPrompt, adapter: ChannelAdapter): Promise<void> {
    const ctx = { chatId: entry.chatId };
    try {
      let messageId: string | undefined;
      let landedIn: string | undefined;
      if (entry.interactive) {
        const sent = await adapter.sendInteractive!({ ctx, text: entry.text, buttons: this.buttonRows(entry), plain: true });
        messageId = sent.id;
        landedIn = sent.chatId;
      } else {
        const sent = await adapter.sendText({ ctx, text: entry.text, plain: true });
        messageId = sent[sent.length - 1]?.id;
        landedIn = sent[sent.length - 1]?.chatId;
      }
      if (!messageId) throw new Error("no message id returned");
      if (landedIn) entry.chatId = landedIn;
      entry.messageId = messageId;
      this.deps.audit.record({
        feature: "prompts",
        action: "prompt.sent",
        actor: "system",
        detail: { kind: entry.kind, ref: entry.ref, channel: entry.channel, timeoutMs: entry.expiresAt - Date.now() },
      });
      if (entry.done) {
        // Resolved (abort, timeout or shutdown) while the card was still being sent.
        await this.markResolved(entry, adapter, entry.finalLine ?? this.resolvedLine(entry, "cancelled"));
      }
    } catch (err) {
      log.warn({ kind: entry.kind, err: err instanceof Error ? err.message : String(err) }, "owner prompt send failed");
      if (!entry.done) this.finish(entry, "unavailable", entry.defaultOptionId);
    }
  }

  private onPress(ev: OwnerActionEvent): Promise<OwnerActionReply> {
    const sep = ev.action.indexOf(":");
    const id = sep === -1 ? "" : ev.action.slice(0, sep);
    const optionId = sep === -1 ? "" : ev.action.slice(sep + 1);
    const entry = PROMPT_ID_RE.test(id) ? this.pendingById.get(id) : undefined;
    if (!entry || entry.done || entry.messageId === null) {
      return Promise.resolve({ toast: INTERACTION_EXPIRED_TEXT });
    }
    if (ev.channel !== entry.channel || ev.chatId !== entry.chatId || ev.messageId !== entry.messageId) {
      this.deps.audit.record({
        feature: "prompts",
        action: "prompt.mismatch",
        actor: `owner:${ev.channel}:${ev.senderId}`,
        detail: { kind: entry.kind, ref: entry.ref },
      });
      return Promise.resolve({ toast: INTERACTION_EXPIRED_TEXT });
    }
    const option = entry.options.find((o) => o.id === optionId);
    if (!option) return Promise.resolve({ toast: INTERACTION_EXPIRED_TEXT });
    this.finish(entry, "answered", option.id, `owner:${ev.channel}:${ev.senderId}`);
    return Promise.resolve({ toast: option.label });
  }

  private finish(entry: PendingPrompt, outcome: OwnerAskOutcome, optionId: string, by?: string, reason?: string, via?: "typed"): void {
    if (entry.done) return;
    entry.done = true;
    this.pendingById.delete(entry.id);
    this.rememberCode(entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.removeAbort?.();
    entry.resolve({
      optionId,
      outcome,
      code: entry.code,
      ref: entry.ref,
      ...(by ? { answeredBy: by } : {}),
    });
    this.deps.audit.record({
      feature: "prompts",
      action: `prompt.${outcome}`,
      actor: by ?? "system",
      detail: { kind: entry.kind, ref: entry.ref, optionId, ...(via ? { via } : {}), ...(reason ? { reason } : {}) },
    });
    entry.finalLine = this.resolvedLine(entry, outcome, optionId, reason);
    if (entry.messageId !== null) {
      const adapter = this.deps.channelRegistry.getById(entry.channel);
      if (adapter) void this.markResolved(entry, adapter, entry.finalLine);
    }
  }

  private resolvedLine(entry: PendingPrompt, outcome: OwnerAskOutcome, optionId?: string, reason?: string): string {
    const label = (id: string | undefined): string => entry.options.find((o) => o.id === id)?.label ?? String(id);
    switch (outcome) {
      case "answered":
        return `${label(optionId)} ${clock()}`;
      case "timeout":
        return `Timed out, default: ${label(entry.defaultOptionId)}`;
      case "cancelled":
        return reason ? `Cancelled (${reason})` : "Cancelled";
      case "unavailable":
        return `Not delivered, default: ${label(entry.defaultOptionId)}`;
    }
  }

  /** Remove the keyboard and append the outcome line. */
  private async markResolved(entry: PendingPrompt, adapter: ChannelAdapter, line: string): Promise<void> {
    if (entry.messageId === null) return;
    const text = `${entry.text}\n\n${line}`;
    try {
      if (entry.interactive && adapter.updateInteractive) {
        await adapter.updateInteractive({ ctx: { chatId: entry.chatId }, messageId: entry.messageId, text, buttons: null, plain: true });
      } else if (adapter.editMessage) {
        await adapter.editMessage({ ctx: { chatId: entry.chatId }, messageId: entry.messageId, text });
      }
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "owner prompt update failed");
    }
  }

  private runningAdapter(channel: ChannelName): ChannelAdapter | null {
    const reg = this.deps.channelRegistry;
    if (!reg.isRunning(channel)) return null;
    return reg.getById(channel) ?? null;
  }

  private buttonRows(entry: PendingPrompt): InlineButton[][] {
    const row = entry.options.map((o) => ({
      label: o.label,
      data: InteractionRouter.encode(OWNER_PROMPT_NAMESPACE, `${entry.id}:${o.id}`),
    }));
    return row.length > 3 ? [row.slice(0, 3), row.slice(3)] : [row];
  }

  /** One line naming the request: the caller's summary, else the title plus the body's first line. */
  private summarize(req: OwnerAskRequest, title: string, preparedBody: string): string {
    let text: string;
    if (typeof req.summary === "string" && req.summary.trim()) {
      text = this.prepareText(req.summary);
    } else {
      const first = preparedBody.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      text = first ? `${title}: ${first}` : title;
    }
    return truncate(text.replace(/\s+/g, " ").trim(), SUMMARY_MAX_CHARS);
  }

  private rememberCode(entry: PendingPrompt): void {
    this.pruneRecentCodes();
    if (this.recentCodes.size >= RECENT_CODE_MAX) {
      const oldest = this.recentCodes.keys().next().value;
      if (oldest !== undefined) this.recentCodes.delete(oldest);
    }
    this.recentCodes.delete(entry.code);
    this.recentCodes.set(entry.code, { kind: entry.kind, summary: entry.summary, until: Date.now() + RECENT_CODE_TTL_MS });
  }

  private pruneRecentCodes(): void {
    const now = Date.now();
    for (const [code, r] of this.recentCodes) {
      if (r.until <= now) this.recentCodes.delete(code);
    }
  }

  private newCode(): string {
    this.pruneRecentCodes();
    const used = new Set([...this.pendingById.values()].map((p) => p.code));
    for (const code of this.recentCodes.keys()) used.add(code);
    for (;;) {
      let code = "";
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!used.has(code)) return code;
    }
  }
}

function validateRequest(req: OwnerAskRequest | undefined): string | null {
  if (!req || typeof req !== "object") return "missing request";
  if (typeof req.title !== "string" || !req.title.trim()) return "missing title";
  if (!Array.isArray(req.options) || req.options.length < 2 || req.options.length > 6) return "need 2 to 6 options";
  const ids = new Set<string>();
  for (const o of req.options) {
    if (!o || !OPTION_ID_RE.test(o.id)) return "bad option id";
    if (typeof o.label !== "string" || !o.label.trim()) return "bad option label";
    if (ids.has(o.id)) return "duplicate option id";
    ids.add(o.id);
  }
  if (!ids.has(req.defaultOptionId)) return "default option is not an option";
  if (typeof req.timeoutMs !== "number" || Number.isNaN(req.timeoutMs)) return "bad timeout";
  return null;
}

function canSendButtons(adapter: ChannelAdapter): boolean {
  return adapter.capabilities.interactiveButtons === true && typeof adapter.sendInteractive === "function";
}

function renderPrompt(
  title: string,
  body: string | undefined,
  code: string,
  options: readonly OwnerAskOption[],
  interactive: boolean,
): string {
  const parts = [title];
  if (body) parts.push(body);
  if (interactive) {
    parts.push(`Code ${code}`);
  } else {
    const ids = options.map((o) => o.id);
    if (ids.includes("approve") && ids.includes("deny") && ids.length === 2) {
      parts.push(`Reply /approve ${code} or /deny ${code}`);
    } else {
      parts.push(`Options: ${options.map((o) => `${o.id} (${o.label})`).join(", ")}\nReply /answer ${code} <option>`);
    }
  }
  return parts.join("\n\n");
}

/** Audit and log reference for a prompt: not the code, and not usable to answer it. */
function promptRef(id: string): string {
  return createHash("sha256").update(`owner-prompt:${id}`).digest("hex").slice(0, 12);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Never a silent cut: the marker says how much is missing. */
function truncateMarked(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = (n: number): string => `\n…[TRUNCATED: ${n.toLocaleString("en-US")} more characters not shown]`;
  const kept = max - marker(s.length).length;
  return s.slice(0, kept) + marker(s.length - kept);
}

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
