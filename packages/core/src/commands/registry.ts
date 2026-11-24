/**
 * CommandRegistry - every slash command, with one central owner check.
 *
 * Dispatch, in this order, every step fail-closed:
 *   1. source !== "channel"            -> not-command (injected text is never a command)
 *   2. parse                           -> not-command when it is not "/name ..."
 *   3. "/name@OtherBot"                -> ignored (other-bot)
 *   4. lookup                          -> unknown (continues to the agent unless configured to reply)
 *   5. edited message                  -> ignored (edited)
 *   6. owner-only and not the owner    -> denied (owner-only). No owner configured = denied for everyone
 *   7. dm scope outside the DM         -> denied (dm-only). Telegram DM also needs chatId === senderId
 *   8. run the handler                 -> handled, or failed on a throw
 *   9. audit owner-only dispatches
 *
 * Denied and failed commands are answered with a fixed text and are never
 * forwarded to the agent. All replies are sent plain.
 */

import { createModuleLogger } from "../logging/logger.js";
import type { ChannelName, UnifiedMessage } from "../channels/normalizer.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { makeSessionKey } from "../routing/session-key.js";
import type { OwnerDirectory } from "../interaction/owners.js";
import type { OwnerPrompts } from "../interaction/owner-prompts.js";
import { parseCommandText, splitCommandArgs, type ParsedCommandText } from "./parse.js";
import {
  buildCommandMenu,
  COMMAND_MENU_WARN_AT,
  isOwnerOnlyCommand,
  renderCommandHelp,
} from "./help.js";
import {
  COMMAND_CATEGORIES,
  type CommandContext,
  type CommandDefinition,
  type CommandReply,
  type CommandResult,
  type DispatchInput,
  type DispatchOutcome,
} from "./types.js";

const log = createModuleLogger("commands");

export interface CommandRegistryDeps {
  owners: OwnerDirectory;
  /** The bot's own username on a channel, for "/name@bot" addressing */
  selfUsername?(channel: ChannelName): string | undefined;
  /** Implements ctx.confirm. Without it, confirm() resolves false */
  prompts?: Pick<OwnerPrompts, "requestApproval">;
  audit?: AuditTrail;
  /** Applied to command error replies. Default identity (W1B passes scrubSecrets) */
  scrub?: (text: string) => string;
  /** "agent" (default) lets unknown "/name" continue to the agent; "reply" answers it */
  unknownCommand?: "agent" | "reply";
  /** Timeout for ctx.confirm. Default 120 s */
  confirmTimeoutMs?: number;
}

export const COMMAND_OWNER_ONLY_TEXT = "This command is owner-only.";
export const COMMAND_DM_ONLY_TEXT = "Use this command in a direct message with me.";
export const COMMAND_FORWARDED_TEXT = "Forwarded commands are not run. Type the command yourself if you meant it.";
export const COMMAND_CONFIRM_TIMEOUT_MS = 120_000;

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Categories whose arguments are never written to the audit trail. */
const SENSITIVE_CATEGORIES = new Set(["security", "accounts"]);
const AUDIT_ARGS_MAX_CHARS = 200;
const ERROR_MAX_CHARS = 500;

export class CommandRegistry {
  private readonly defs: CommandDefinition[] = [];
  private readonly byName = new Map<string, CommandDefinition>();
  private readonly scrub: (text: string) => string;

  constructor(private readonly deps: CommandRegistryDeps) {
    this.scrub = deps.scrub ?? ((t) => t);
  }

  /** Throws on a bad or duplicate name or alias. */
  register(def: CommandDefinition): void {
    validateDefinition(def);
    const names = [def.name, ...(def.aliases ?? [])];
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) throw new Error(`Command /${def.name} lists "${n}" twice`);
      seen.add(n);
      if (this.byName.has(n)) throw new Error(`Command name or alias "/${n}" is already registered`);
    }
    for (const n of names) this.byName.set(n, def);
    this.defs.push(def);
  }

  registerAll(defs: readonly CommandDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  get(nameOrAlias: string): CommandDefinition | undefined {
    return this.byName.get(nameOrAlias.replace(/^\//, "").toLowerCase());
  }

  /** All registered commands in registration order. */
  list(): readonly CommandDefinition[] {
    return [...this.defs];
  }

  parse(text: string): ParsedCommandText | null {
    return parseCommandText(text);
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    // 1. Only real channel messages can be commands.
    if (input.source !== "channel") return { kind: "not-command" };
    const { message } = input;

    // 2. Parse.
    const parsed = parseCommandText(message.text);
    if (!parsed) return { kind: "not-command" };

    // 3. Addressed to another bot.
    if (parsed.mention !== undefined) {
      const self = this.deps.selfUsername?.(message.channel);
      if (!self || self.toLowerCase() !== parsed.mention.toLowerCase()) {
        return { kind: "ignored", reason: "other-bot" };
      }
    }

    // 4. Lookup.
    const def = this.byName.get(parsed.name);
    if (!def) {
      if (this.deps.unknownCommand === "reply") {
        await this.safeSend(input, { text: `Unknown command /${parsed.name}. Send /help for the list.`, plain: true });
        return { kind: "unknown", name: parsed.name, replied: true };
      }
      return { kind: "unknown", name: parsed.name, replied: false };
    }

    // 5. Editing an old command message never runs it again.
    if (message.isEdited) return { kind: "ignored", reason: "edited" };

    // 5b. A forwarded message is someone else's words, never the owner's command (CORE-N1).
    if (message.isForwarded) {
      const reply: CommandReply = { text: COMMAND_FORWARDED_TEXT, plain: true };
      this.finish(def, message, parsed, this.deps.owners.isOwner(message.channel, message.senderId), "ignored:forwarded");
      await this.safeSend(input, reply);
      return { kind: "ignored", reason: "forwarded" };
    }

    const ownerOnly = isOwnerOnlyCommand(def);
    const isOwner = this.deps.owners.isOwner(message.channel, message.senderId);

    // 6. Central owner check.
    if (ownerOnly && !isOwner) {
      const reply: CommandReply = { text: COMMAND_OWNER_ONLY_TEXT, plain: true };
      this.finish(def, message, parsed, isOwner, "denied:owner-only");
      await this.safeSend(input, reply);
      return { kind: "denied", reason: "owner-only", reply };
    }

    // 7. Scope.
    const scope = def.scope ?? (ownerOnly ? "dm" : "any");
    if (scope === "dm" && !isDirectMessage(message)) {
      const reply: CommandReply = { text: COMMAND_DM_ONLY_TEXT, plain: true };
      this.finish(def, message, parsed, isOwner, "denied:dm-only");
      await this.safeSend(input, reply);
      return { kind: "denied", reason: "dm-only", reply };
    }

    // 8. Run.
    const ctx = this.buildContext(def, parsed, input, isOwner);
    let result: CommandResult;
    try {
      result = await def.handler(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reply: CommandReply = { text: `Command failed: ${truncate(this.scrub(msg), ERROR_MAX_CHARS)}`, plain: true };
      this.finish(def, message, parsed, isOwner, "failed");
      await this.safeSend(input, reply);
      return { kind: "failed", reply };
    }

    const reply = normalizeResult(result);
    this.finish(def, message, parsed, isOwner, "handled");
    if (reply) await this.safeSend(input, reply);
    return reply ? { kind: "handled", reply } : { kind: "handled" };
  }

  renderHelp(opts: { isOwner: boolean; topic?: string }): string {
    return renderCommandHelp(this.defs, opts);
  }

  menu(opts: { forOwner: boolean }): Array<{ command: string; description: string }> {
    const menu = buildCommandMenu(this.defs, opts);
    if (menu.length >= COMMAND_MENU_WARN_AT) {
      log.warn({ entries: menu.length, forOwner: opts.forOwner }, "command menu is close to Telegram's 100-entry limit");
    }
    return menu;
  }

  // -------------------------------------------------------------------------

  private buildContext(
    def: CommandDefinition,
    parsed: ParsedCommandText,
    input: DispatchInput,
    isOwner: boolean,
  ): CommandContext {
    const { message } = input;
    const prompts = this.deps.prompts;
    const timeoutMs = this.deps.confirmTimeoutMs ?? COMMAND_CONFIRM_TIMEOUT_MS;
    return {
      name: def.name,
      args: parsed.args,
      argv: splitCommandArgs(parsed.args),
      message,
      identity: input.identity,
      isOwner,
      sessionKey: makeSessionKey({ channel: message.channel, chatType: message.chatType, chatId: message.chatId }),
      reply: async (r) => {
        const reply = normalizeResult(r);
        if (reply) await input.send(reply);
      },
      confirm: async (title, body) => {
        if (!prompts) return false;
        try {
          const res = await prompts.requestApproval({
            kind: "confirm",
            title,
            body,
            timeoutMs,
            labels: { approve: "Confirm", deny: "Cancel" },
          });
          return res.outcome === "approved";
        } catch {
          return false;
        }
      },
    };
  }

  private async safeSend(input: DispatchInput, reply: CommandReply): Promise<void> {
    try {
      await input.send({ ...reply, plain: true });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "command reply failed");
    }
  }

  /** Log every dispatch; audit owner-only ones. */
  private finish(
    def: CommandDefinition,
    message: UnifiedMessage,
    parsed: ParsedCommandText,
    isOwner: boolean,
    outcome: string,
  ): void {
    log.info(
      { command: def.name, channel: message.channel, senderId: message.senderId, chatId: message.chatId, outcome },
      "command dispatched",
    );
    if (!isOwnerOnlyCommand(def) || !this.deps.audit) return;
    const detail: Record<string, unknown> = { outcome, channel: message.channel, chatType: message.chatType };
    if (!SENSITIVE_CATEGORIES.has(def.category) && def.auditArgs !== false && parsed.args) {
      detail.args = truncate(parsed.args, AUDIT_ARGS_MAX_CHARS);
    }
    this.deps.audit.record({
      feature: "commands",
      action: def.name,
      actor: `${isOwner ? "owner" : "user"}:${message.channel}:${message.senderId}`,
      detail,
    });
  }
}

/** A DM with the sender. For Telegram the chat must be the sender's own (chatId === senderId). */
export function isDirectMessage(message: Pick<UnifiedMessage, "channel" | "chatType" | "chatId" | "senderId">): boolean {
  if (message.chatType !== "dm") return false;
  if (message.channel === "telegram" && message.chatId !== message.senderId) return false;
  return true;
}

/**
 * Whether the pipeline should pass the message on to the agent after dispatch.
 * Only plain text and unanswered unknown commands continue.
 */
export function commandContinuesToAgent(outcome: DispatchOutcome): boolean {
  if (outcome.kind === "not-command") return true;
  if (outcome.kind === "unknown") return !outcome.replied;
  return false;
}

function normalizeResult(result: CommandResult | string | CommandReply): CommandReply | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result ? { text: result, plain: true } : undefined;
  if (typeof result === "object" && typeof result.text === "string") return { ...result, plain: true };
  return undefined;
}

function validateDefinition(def: CommandDefinition): void {
  if (!def || typeof def !== "object") throw new Error("Command definition must be an object");
  if (typeof def.name !== "string" || !NAME_RE.test(def.name)) {
    throw new Error(`Invalid command name "${String(def?.name)}"`);
  }
  for (const a of def.aliases ?? []) {
    if (typeof a !== "string" || !NAME_RE.test(a)) throw new Error(`Invalid alias "${String(a)}" for /${def.name}`);
  }
  if (typeof def.description !== "string" || def.description.length < 1 || def.description.length > 256) {
    throw new Error(`Command /${def.name} needs a description of 1 to 256 chars`);
  }
  if (!COMMAND_CATEGORIES.includes(def.category)) {
    throw new Error(`Command /${def.name} has unknown category "${String(def.category)}"`);
  }
  if (def.scope !== undefined && def.scope !== "dm" && def.scope !== "any") {
    throw new Error(`Command /${def.name} has invalid scope "${String(def.scope)}"`);
  }
  if (typeof def.handler !== "function") throw new Error(`Command /${def.name} has no handler`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
