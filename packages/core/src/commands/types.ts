/**
 * Command registry types (PLAN B.4).
 */

import type { InlineButton } from "../channels/adapter.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";

export type { InlineButton } from "../channels/adapter.js";

/**
 * Where the text came from. Only the adapter listener path passes "channel".
 * Scheduled, loop, goal, webhook and any other injected text is "synthetic"
 * and is never a command.
 */
export type CommandSource = "channel" | "synthetic";

export type CommandCategory =
  | "core" | "accounts" | "automation" | "learning" | "security" | "integrations" | "media";

/** Fixed order of categories in /help and the menu. */
export const COMMAND_CATEGORIES: readonly CommandCategory[] = [
  "core", "accounts", "automation", "learning", "security", "integrations", "media",
];

export interface CommandReply {
  text: string;
  buttons?: InlineButton[][];
  /** Command replies are always sent plain; the field exists for adapter parity */
  plain?: boolean;
}

export type CommandResult = string | CommandReply | void;

export interface CommandContext {
  /** Canonical name that matched (not the alias) */
  readonly name: string;
  /** Raw text after the command token, trimmed */
  readonly args: string;
  /** Quote-aware split of args */
  readonly argv: readonly string[];
  /** Always a real channel message */
  readonly message: UnifiedMessage;
  /** From SecurityGate; sender role is identity.role */
  readonly identity: ResolvedIdentity;
  readonly isOwner: boolean;
  /** makeSessionKey({ channel, chatType, chatId }) */
  readonly sessionKey: string;
  /** Send an extra message (long handlers). Always plain */
  reply(reply: string | CommandReply): Promise<void>;
  /** Confirm/Cancel buttons in the owner DM. Resolves false on Cancel, timeout (120 s), or when prompts are unavailable. */
  confirm(title: string, body?: string): Promise<boolean>;
}

export interface SubcommandSpec {
  args?: string;
  description: string;
}

export interface CommandDefinition {
  /** /^[a-z][a-z0-9_]{0,31}$/, no leading slash */
  name: string;
  aliases?: readonly string[];
  /** The /help line and the Telegram menu text, 1..256 chars */
  description: string;
  category: CommandCategory;
  /** Required. A missing value at runtime is treated as true */
  ownerOnly: boolean;
  /** Default "dm" when ownerOnly, else "any" */
  scope?: "dm" | "any";
  /** Short argument hint, e.g. "<text> | status | stop <id>" */
  args?: string;
  /** Shown by /help <name> */
  usage?: string;
  subcommands?: Readonly<Record<string, SubcommandSpec>>;
  /** Not in the Telegram menu; still in /help */
  hidden?: boolean;
  /** False: the audit line never records the arguments (e.g. prompt codes). Default true outside sensitive categories */
  auditArgs?: boolean;
  handler(ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

export type DispatchOutcome =
  /** Not a command (or synthetic source): continue to the agent */
  | { kind: "not-command" }
  /** "/name" that is not registered. Continue to the agent unless `replied` (commands.unknownCommand: "reply") */
  | { kind: "unknown"; name: string; replied: boolean }
  /** Stop, no reply */
  | { kind: "ignored"; reason: "other-bot" | "edited" }
  /** Stop. The refusal has been sent. Never forwarded to the agent */
  | { kind: "denied"; reason: "owner-only" | "dm-only"; reply: CommandReply }
  /** Stop. The reply, if any, has been sent */
  | { kind: "handled"; reply?: CommandReply }
  /** Stop. The error reply has been sent. Never forwarded to the agent */
  | { kind: "failed"; reply: CommandReply };

export interface DispatchInput {
  message: UnifiedMessage;
  identity: ResolvedIdentity;
  /** The pipeline passes "channel" only from the adapter listener path */
  source: CommandSource;
  /** Sends one reply to the message's chat */
  send(reply: CommandReply): Promise<void>;
}
