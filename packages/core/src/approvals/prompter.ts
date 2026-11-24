/**
 * ApprovalPrompter: the human wait behind an `ask` verdict (PLAN C.9, R2
 * section 4 "The Telegram ask flow").
 *
 * Before bothering the owner it short-circuits:
 * - webhook work never asks (always denied);
 * - unattended work (background, goal, scheduled) with `approvals.unattended: "deny"`;
 * - the same call was denied by the owner in this session within `redenyWindowSeconds`;
 * - the same call is already waiting: share that prompt's outcome;
 * - more than `maxPending` approval prompts are open;
 * - `maxDenialsPerTurn` denials already happened in this turn (deny and stop the turn).
 *
 * Then it asks through `OwnerPrompts.requestApproval` (owner's DM only, Approve
 * / Deny / Deny + stop, default deny). No answer in `timeoutSeconds` is a deny.
 * Approve applies to this one call only.
 */

import { createModuleLogger } from "../logging/logger.js";
import type { OwnerPrompts, ApprovalOutcome } from "../interaction/owner-prompts.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { SdkCallContext } from "../engine/sdk-options.js";
import type { TurnOrigin } from "../engine/turn-context.js";
import { isApprovalShellCall } from "./engine.js";
import { isHiddenShellChar } from "./shell-parse.js";
import type { ApprovalEvaluation, ApprovalPolicy, ApprovalToolCall } from "./types.js";

const log = createModuleLogger("approvals");

export const APPROVAL_STOP_OPTION = { id: "stop", label: "Deny + stop" } as const;
/** Command text on the card: head plus tail beyond this many characters. */
export const APPROVAL_DISPLAY_MAX_CHARS = 1500;
const DISPLAY_HEAD = 1000;
const DISPLAY_TAIL = 400;
const WRITE_PREVIEW_CHARS = 400;
const JSON_PREVIEW_CHARS = 1200;
const MAX_SPACE_RUN = 20;

const UNATTENDED_ORIGINS: ReadonlySet<TurnOrigin> = new Set(["schedule", "loop", "webhook", "goal", "background", "system"]);

export interface ApprovalRequestResult {
  approved: boolean;
  /** End the turn (Deny + stop, or the per-turn denial limit). */
  stop: boolean;
  messageForAgent: string;
  outcome: ApprovalOutcome | "auto-denied";
  code?: string;
}

export interface ApprovalPrompterDeps {
  prompts: Pick<OwnerPrompts, "requestApproval" | "pending">;
  policy: () => ApprovalPolicy;
  audit?: Pick<AuditTrail, "record">;
  scrub?: (text: string) => string;
  originOf?: (ctx: SdkCallContext) => TurnOrigin;
  /** Identifies the current turn of a session (for the per-turn denial limit). */
  turnKey?: (ctx: SdkCallContext) => string;
  /** One plain line to the owner (used once per turn when the denial limit is hit). */
  notifyOwner?: (text: string) => void;
  now?: () => number;
}

/** What the model sees when the owner (or the gate on the owner's behalf) said no. */
export function approvalDeniedMessage(reason: string): string {
  return `The owner denied this action through the approval gate (reason: ${reason}). Do not retry it and do not try an equivalent command. Continue with other work, or explain what you needed and why.`;
}

/** Render text for the owner's card: hidden, control and bidi characters as visible escapes, long space runs collapsed. */
export function renderApprovalDisplay(text: string): { text: string; hidden: number } {
  let out = "";
  let hidden = 0;
  let spaces = 0;
  const flushSpaces = (): void => {
    if (spaces > MAX_SPACE_RUN) out += ` ⟨${spaces} spaces⟩ `;
    else out += " ".repeat(spaces);
    spaces = 0;
  };
  for (const ch of text) {
    if (ch === " ") { spaces++; continue; }
    flushSpaces();
    if (ch !== "\n" && ch !== "\t" && isHiddenShellChar(ch)) {
      hidden++;
      out += `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      continue;
    }
    out += ch;
  }
  flushSpaces();
  // Three or more blank lines in a row could push the rest off screen.
  out = out.replace(/\n{4,}/g, (m) => `\n⟨${m.length - 1} blank lines⟩\n`);
  return { text: out, hidden };
}

/** Head plus tail with an explicit marker; never a silent cut. */
export function truncateApprovalDisplay(text: string, max = APPROVAL_DISPLAY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.min(DISPLAY_HEAD, Math.floor(max * 0.66));
  const tail = Math.min(DISPLAY_TAIL, max - head);
  const hidden = text.length - head - tail;
  return `${text.slice(0, head)}\n…(${hidden} chars hidden)…\n${text.slice(text.length - tail)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The exact text shown for a call: the command, a file path plus content preview, or the JSON input. */
export function approvalCallDisplay(call: ApprovalToolCall, scrub: (t: string) => string): { label: string; text: string; hidden: number } {
  const input = call.input ?? {};
  let label: string;
  let raw: string;
  if (isApprovalShellCall(call.tool, input)) {
    label = "Command";
    raw = str(input.command);
  } else if (call.tool === "Write" || call.tool === "Edit" || call.tool === "MultiEdit" || call.tool === "NotebookEdit") {
    label = "File";
    const path = str(input.file_path) || str(input.notebook_path);
    const content = str(input.content) || str(input.new_string) || str(input.new_source) || (Array.isArray(input.edits) ? JSON.stringify(input.edits) : "");
    const preview = content.length > WRITE_PREVIEW_CHARS ? `${content.slice(0, WRITE_PREVIEW_CHARS)}\n…(${content.length - WRITE_PREVIEW_CHARS} more chars)` : content;
    raw = content ? `${path}\n---\n${preview}` : path;
  } else if (call.tool === "Read" || call.tool === "Grep") {
    label = "Path";
    raw = str(input.file_path) || str(input.path) || JSON.stringify(input);
  } else {
    label = "Input";
    let json: string;
    try {
      json = JSON.stringify(input, null, 1) ?? "{}";
    } catch {
      json = "{}";
    }
    raw = json.length > JSON_PREVIEW_CHARS ? `${json.slice(0, JSON_PREVIEW_CHARS)}\n…(${json.length - JSON_PREVIEW_CHARS} chars hidden)` : json;
  }
  let scrubbed: string;
  try {
    scrubbed = scrub(raw);
  } catch {
    scrubbed = "«message withheld: scrubber error»";
  }
  const rendered = renderApprovalDisplay(scrubbed);
  return { label, text: truncateApprovalDisplay(rendered.text), hidden: rendered.hidden };
}

/** One line for /pending and typed answers: "Bash: rm -rf ~/x". `displayText` is already scrubbed and escaped. */
export function approvalSummary(call: ApprovalToolCall, displayText: string): string {
  const oneLine = displayText.replace(/\s+/g, " ").trim();
  return clip(`${call.tool}: ${oneLine}`, 280);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatExpiry(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface SharedPrompt {
  promise: Promise<ApprovalRequestResult>;
}

export class ApprovalPrompter {
  private readonly scrub: (text: string) => string;
  private readonly now: () => number;
  /** sessionScope|hash -> time of the owner's denial */
  private readonly denied = new Map<string, number>();
  /** sessionScope|hash -> the prompt in flight */
  private readonly inflight = new Map<string, SharedPrompt>();
  /** turn key -> denials so far, and whether the owner was told */
  private readonly turnDenials = new Map<string, { count: number; notified: boolean; at: number }>();

  constructor(private readonly deps: ApprovalPrompterDeps) {
    this.scrub = deps.scrub ?? ((t) => scrubSecrets(t, { sink: "prompt-card" }));
    this.now = deps.now ?? Date.now;
  }

  /** Approval prompts currently waiting for the owner. */
  pendingCount(): number {
    try {
      return this.deps.prompts.pending().filter((p) => p.kind === "approval").length;
    } catch {
      return 0;
    }
  }

  private origin(ctx: SdkCallContext): TurnOrigin | undefined {
    try {
      return this.deps.originOf?.(ctx);
    } catch {
      return undefined;
    }
  }

  /** Who asked: chat turns from the owner are attended; everything else is unattended. */
  isUnattended(ctx: SdkCallContext): boolean {
    if (ctx.kind !== "chat" || !ctx.interactive) return true;
    const origin = this.origin(ctx);
    return origin !== undefined && UNATTENDED_ORIGINS.has(origin);
  }

  private isWebhook(ctx: SdkCallContext): boolean {
    return ctx.kind === "webhook" || this.origin(ctx) === "webhook";
  }

  private sessionScope(ctx: SdkCallContext): string {
    return `${ctx.kind}|${ctx.sessionKey ?? ""}|${ctx.taskId ?? ""}|${ctx.goalId ?? ""}`;
  }

  private turnKeyOf(ctx: SdkCallContext): string {
    try {
      return this.deps.turnKey?.(ctx) ?? this.sessionScope(ctx);
    } catch {
      return this.sessionScope(ctx);
    }
  }

  private audit(action: string, ev: ApprovalEvaluation, call: ApprovalToolCall, detail: Record<string, unknown> = {}): void {
    try {
      this.deps.audit?.record({
        feature: "approvals",
        action,
        actor: call.ctx.sessionKey ? `agent:${call.ctx.sessionKey}` : `agent:${call.ctx.label}`,
        detail: {
          tool: call.tool,
          hash: ev.hash.slice(0, 16),
          rules: ev.findings.map((f) => f.ruleId),
          uncertain: ev.uncertain.map((u) => u.code),
          mode: ev.mode,
          context: call.ctx.label,
          ...(call.agentType ? { subagent: call.agentType } : {}),
          ...detail,
        },
      });
    } catch (err) {
      log.warn({ err }, "approval audit record failed");
    }
  }

  private countDenial(turnKey: string): void {
    const entry = this.turnDenials.get(turnKey) ?? { count: 0, notified: false, at: this.now() };
    entry.count++;
    entry.at = this.now();
    this.turnDenials.set(turnKey, entry);
    if (this.turnDenials.size > 500) {
      const cutoff = this.now() - 6 * 3600_000;
      for (const [k, v] of this.turnDenials) if (v.at < cutoff) this.turnDenials.delete(k);
    }
  }

  private pruneDenied(windowMs: number): void {
    const cutoff = this.now() - windowMs;
    for (const [k, at] of this.denied) if (at < cutoff) this.denied.delete(k);
  }

  /** Waits for the owner. Never rejects. */
  async request(ev: ApprovalEvaluation, call: ApprovalToolCall, opts: { signal: AbortSignal; toolUseId: string }): Promise<ApprovalRequestResult> {
    try {
      return await this.requestInner(ev, call, opts);
    } catch (err) {
      log.error({ err, tool: call.tool }, "approval prompter failed; denying");
      this.audit("prompt.error", ev, call);
      return { approved: false, stop: false, messageForAgent: approvalDeniedMessage("approvals unavailable"), outcome: "unavailable" };
    }
  }

  private async requestInner(ev: ApprovalEvaluation, call: ApprovalToolCall, opts: { signal: AbortSignal; toolUseId: string }): Promise<ApprovalRequestResult> {
    const policy = this.deps.policy();
    const ctx = call.ctx;
    const autoDeny = (reason: string, action: string, stop = false): ApprovalRequestResult => {
      this.audit(action, ev, call, { reason });
      return { approved: false, stop, messageForAgent: approvalDeniedMessage(reason), outcome: "auto-denied" };
    };

    if (this.isWebhook(ctx)) return autoDeny("webhook-triggered work cannot ask for approval", "auto-denied.webhook");
    if (this.isUnattended(ctx) && policy.unattended === "deny") {
      return autoDeny("unattended work is not allowed to ask (approvals.unattended is deny)", "auto-denied.unattended");
    }

    const scope = this.sessionScope(ctx);
    const key = `${scope}|${ev.hash}`;
    const windowMs = policy.redenyWindowSeconds * 1000;
    this.pruneDenied(windowMs);
    const deniedAt = this.denied.get(key);
    if (deniedAt !== undefined && windowMs > 0 && this.now() - deniedAt <= windowMs) {
      return autoDeny(`already denied by the owner at ${hhmm(deniedAt)}`, "auto-denied.redeny");
    }

    const turnKey = this.turnKeyOf(ctx);
    const turn = this.turnDenials.get(turnKey);
    if (turn && turn.count >= policy.maxDenialsPerTurn) {
      if (!turn.notified) {
        turn.notified = true;
        try {
          this.deps.notifyOwner?.(`Approvals: ${turn.count} actions were denied in one turn (${ctx.label}); further requests in that turn are denied and the turn is stopped.`);
        } catch {
          // best effort
        }
      }
      return autoDeny(`${turn.count} actions were already denied in this turn`, "auto-denied.denial-limit", true);
    }

    const shared = this.inflight.get(key);
    if (shared) return shared.promise;

    if (this.pendingCount() >= policy.maxPending) {
      return autoDeny("too many approval requests are waiting", "auto-denied.max-pending");
    }

    const promise = this.ask(ev, call, policy, opts.signal, key, turnKey);
    this.inflight.set(key, { promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async ask(ev: ApprovalEvaluation, call: ApprovalToolCall, policy: ApprovalPolicy, signal: AbortSignal, key: string, turnKey: string): Promise<ApprovalRequestResult> {
    const display = approvalCallDisplay(call, this.scrub);
    const why = ev.findings.length > 0
      ? ev.findings.map((f) => `${f.ruleId}: ${f.reason}`)
      : ev.uncertain.length > 0
        ? ev.uncertain.slice(0, 4).map((u) => `uncertain (${u.code}): ${u.detail}`)
        : [ev.summary.replace(/^approval needed: /, "")];
    const from = call.agentType ? `${call.ctx.label} (subagent ${call.agentType})` : call.ctx.label;
    const lines = [
      `From: ${clip(from, 200)}`,
      `Tool: ${clip(call.tool, 120)}`,
      `Why: ${clip(why.slice(0, 6).join("; "), 600)}`,
      ...(display.hidden > 0 ? [`Warning: ${display.hidden} hidden or direction-changing character(s), shown as ⟨U+…⟩.`] : []),
      `${display.label}:`,
      display.text,
      `cwd: ${clip(call.cwd || call.ctx.cwd, 300)}`,
      `Expires in ${formatExpiry(policy.timeoutSeconds)}. No answer means deny.`,
    ];
    let body = lines.join("\n");
    try {
      body = this.scrub(body);
    } catch {
      body = "«message withheld: scrubber error»";
    }
    this.audit("asked", ev, call);
    const started = this.now();
    const res = await this.deps.prompts.requestApproval({
      kind: "approval",
      title: "Approval needed",
      body,
      summary: approvalSummary(call, display.text),
      timeoutMs: policy.timeoutSeconds * 1000,
      signal,
      extra: { ...APPROVAL_STOP_OPTION },
    });
    const waitedMs = this.now() - started;
    const detail = { ref: res.ref, waitedMs };

    if (res.outcome === "approved") {
      this.audit("approved", ev, call, detail);
      return { approved: true, stop: false, messageForAgent: "", outcome: "approved", code: res.code };
    }
    const stop = res.outcome === "denied" && res.optionId === APPROVAL_STOP_OPTION.id;
    switch (res.outcome) {
      case "denied":
        this.denied.set(key, this.now());
        this.countDenial(turnKey);
        this.audit(stop ? "denied.stop" : "denied", ev, call, detail);
        return { approved: false, stop, messageForAgent: approvalDeniedMessage(stop ? "denied, and the owner stopped this turn" : "denied"), outcome: "denied", code: res.code };
      case "timeout":
        this.countDenial(turnKey);
        this.audit("timeout", ev, call, detail);
        return { approved: false, stop: false, messageForAgent: approvalDeniedMessage(`timed out after ${policy.timeoutSeconds}s`), outcome: "timeout", code: res.code };
      case "cancelled":
        this.audit("cancelled", ev, call, detail);
        return { approved: false, stop: false, messageForAgent: approvalDeniedMessage("the request was cancelled"), outcome: "cancelled", code: res.code };
      default:
        this.audit("unavailable", ev, call, detail);
        return { approved: false, stop: false, messageForAgent: approvalDeniedMessage("approvals unavailable"), outcome: "unavailable", code: res.code };
    }
  }
}
