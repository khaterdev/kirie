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
 * Prompts and cards go only to the owner's primary DM (`owners.primary()`),
 * never to a group. A press is accepted only when the prompt exists, has not
 * expired, the chat and message ids match the ones recorded when it was sent,
 * and the option belongs to the prompt. First valid press wins.
 */

import { randomBytes, randomInt } from "node:crypto";
import { createModuleLogger } from "../logging/logger.js";
import type { ChannelAdapter, InlineButton } from "../channels/adapter.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { OwnerDirectory } from "./owners.js";
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
  /** Plain text. Scrubbed and truncated to 3000 chars */
  body?: string;
  /** 2 to 6 options */
  options: readonly OwnerAskOption[];
  /** Returned on timeout, cancel and unavailable. Must be the safe choice */
  defaultOptionId: string;
  /** Clamped to 5_000 .. 86_400_000 */
  timeoutMs: number;
  signal?: AbortSignal;
}

export type OwnerAskOutcome = "answered" | "timeout" | "cancelled" | "unavailable";

export interface OwnerAskResult {
  optionId: string;
  outcome: OwnerAskOutcome;
  /** Actor string of whoever answered ("owner:telegram:<id>") */
  answeredBy?: string;
  /** 4 chars, shown on the card, usable with /approve, /deny, /answer. Empty when the prompt was never shown */
  code: string;
}

export type ApprovalOutcome = "approved" | "denied" | "timeout" | "cancelled" | "unavailable";

export interface OwnerApprovalRequest {
  kind: string;
  title: string;
  body?: string;
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

export type AnswerByCodeResult = "ok" | "not-found" | "not-owner" | "bad-option";

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
const TITLE_MAX_CHARS = 200;
const OPTION_ID_RE = /^[a-z0-9_]{1,16}$/;
const PROMPT_ID_RE = /^[0-9a-f]{16}$/;
/** No 0/O, 1/I/L, so codes survive being typed back. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface PendingPrompt {
  readonly id: string;
  readonly code: string;
  readonly kind: string;
  readonly title: string;
  readonly text: string;
  readonly options: readonly OwnerAskOption[];
  readonly defaultOptionId: string;
  readonly expiresAt: number;
  readonly channel: ChannelName;
  readonly chatId: string;
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
  private readonly scrub: (text: string) => string;
  private closed = false;

  constructor(private readonly deps: OwnerPromptsDeps) {
    this.scrub = deps.scrub ?? ((t) => t);
    deps.router.registerNamespace(OWNER_PROMPT_NAMESPACE, (ev) => this.onPress(ev));
  }

  /** Ask the owner. Never rejects. */
  ask(req: OwnerAskRequest): Promise<OwnerAskResult> {
    return new Promise<OwnerAskResult>((resolve) => {
      const unavailable = (reason: string): void => {
        log.info({ kind: req?.kind, reason }, "owner prompt unavailable");
        resolve({ optionId: req?.defaultOptionId, outcome: "unavailable", code: "" });
      };

      const invalid = validateRequest(req);
      if (invalid) {
        log.error({ kind: req?.kind, problem: invalid }, "invalid owner prompt request");
        unavailable("invalid");
        return;
      }
      if (req.signal?.aborted) {
        resolve({ optionId: req.defaultOptionId, outcome: "cancelled", code: "" });
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
      const title = truncate(this.scrub(req.title), TITLE_MAX_CHARS);
      const body = req.body ? truncate(this.scrub(req.body), OWNER_PROMPT_BODY_MAX_CHARS) : undefined;
      const interactive = canSendButtons(adapter);
      const text = renderPrompt(title, body, code, req.options, interactive);

      const entry: PendingPrompt = {
        id,
        code,
        kind: req.kind,
        title,
        text,
        options: req.options.map((o) => ({ id: o.id, label: o.label })),
        defaultOptionId: req.defaultOptionId,
        expiresAt: Date.now() + timeoutMs,
        channel: target.channel,
        chatId: target.chatId,
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
  async requestApproval(req: OwnerApprovalRequest): Promise<{ outcome: ApprovalOutcome; optionId: string; code: string }> {
    const options: OwnerAskOption[] = [
      { id: "approve", label: req.labels?.approve ?? "Approve" },
      { id: "deny", label: req.labels?.deny ?? "Deny" },
    ];
    if (req.extra && req.extra.id !== "approve" && req.extra.id !== "deny") options.push(req.extra);
    const res = await this.ask({
      kind: req.kind,
      title: req.title,
      body: req.body,
      options,
      defaultOptionId: "deny",
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    let outcome: ApprovalOutcome;
    if (res.outcome === "answered") outcome = res.optionId === "approve" ? "approved" : "denied";
    else outcome = res.outcome;
    return { outcome, optionId: res.optionId, code: res.code };
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
        return { channel: target.channel, chatId: target.chatId, messageId: sent.id };
      }
      const sent = await adapter.sendText({ ctx, text, plain });
      const last = sent[sent.length - 1];
      if (!last) return null;
      return { channel: target.channel, chatId: target.chatId, messageId: last.id };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "owner card send failed");
      return null;
    }
  }

  /** Route a durable card's buttons in namespace `ns` to `handler`. Same as router.registerNamespace. */
  onAction(ns: string, handler: OwnerActionHandler): void {
    this.deps.router.registerNamespace(ns, handler);
  }

  /** Text fallback for buttons: /approve, /deny, /answer. */
  answerByCode(code: string, optionId: string, by: { channel: ChannelName; senderId: string }): AnswerByCodeResult {
    if (!this.deps.owners.isOwner(by.channel, by.senderId)) return "not-owner";
    const wanted = String(code ?? "").trim().toUpperCase();
    const entry = [...this.pendingById.values()].find((p) => p.code === wanted && !p.done);
    if (!entry) return "not-found";
    const opt = String(optionId ?? "").trim().toLowerCase();
    if (!entry.options.some((o) => o.id === opt)) return "bad-option";
    this.finish(entry, "answered", opt, `owner:${by.channel}:${by.senderId}`);
    return "ok";
  }

  /** Prompts waiting for an answer, oldest first. */
  pending(): ReadonlyArray<{ code: string; kind: string; title: string; expiresAt: number; options: readonly OwnerAskOption[] }> {
    return [...this.pendingById.values()]
      .filter((p) => !p.done)
      .map((p) => ({ code: p.code, kind: p.kind, title: p.title, expiresAt: p.expiresAt, options: p.options }));
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
      if (entry.interactive) {
        const row = entry.options.map((o) => ({
          label: o.label,
          data: InteractionRouter.encode(OWNER_PROMPT_NAMESPACE, `${entry.id}:${o.id}`),
        }));
        const buttons = row.length > 3 ? [row.slice(0, 3), row.slice(3)] : [row];
        const sent = await adapter.sendInteractive!({ ctx, text: entry.text, buttons, plain: true });
        messageId = sent.id;
      } else {
        const sent = await adapter.sendText({ ctx, text: entry.text, plain: true });
        messageId = sent[sent.length - 1]?.id;
      }
      if (!messageId) throw new Error("no message id returned");
      entry.messageId = messageId;
      this.deps.audit.record({
        feature: "prompts",
        action: "prompt.sent",
        actor: "system",
        detail: { kind: entry.kind, code: entry.code, channel: entry.channel, timeoutMs: entry.expiresAt - Date.now() },
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
        detail: { kind: entry.kind, code: entry.code },
      });
      return Promise.resolve({ toast: INTERACTION_EXPIRED_TEXT });
    }
    const option = entry.options.find((o) => o.id === optionId);
    if (!option) return Promise.resolve({ toast: INTERACTION_EXPIRED_TEXT });
    this.finish(entry, "answered", option.id, `owner:${ev.channel}:${ev.senderId}`);
    return Promise.resolve({ toast: option.label });
  }

  private finish(entry: PendingPrompt, outcome: OwnerAskOutcome, optionId: string, by?: string, reason?: string): void {
    if (entry.done) return;
    entry.done = true;
    this.pendingById.delete(entry.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.removeAbort?.();
    entry.resolve({
      optionId,
      outcome,
      code: entry.code,
      ...(by ? { answeredBy: by } : {}),
    });
    this.deps.audit.record({
      feature: "prompts",
      action: `prompt.${outcome}`,
      actor: by ?? "system",
      detail: { kind: entry.kind, code: entry.code, optionId, ...(reason ? { reason } : {}) },
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

  private newCode(): string {
    const used = new Set([...this.pendingById.values()].map((p) => p.code));
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
