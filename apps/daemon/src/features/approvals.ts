import { homedir } from "node:os";
import {
  ApprovalEngine,
  ApprovalPrompter,
  ApprovalStats,
  approvalSandboxInfoFrom,
  createApprovalsCommands,
  createApprovalsGate,
  createApprovalsStatusApp,
  originOf,
  scrubSecrets,
} from "@kirie/core";
import type { ChannelName, SdkCallContext } from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

/** One owner notice per hour when the evaluator itself fails (C.9 failure policy). */
const ENGINE_ERROR_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** Three lines in the system prompt (C.9 "Files to touch"). */
export const APPROVALS_PROMPT_ADDENDUM = [
  "<approval_gate>",
  "Some actions may need the owner's approval through Kirie's approval gate; the mode can change at any time (the approval_status tool shows it).",
  "While an action waits, the owner gets a card in their DM, and nothing runs until they approve. No answer means deny.",
  "A denial by the approval gate is final: do not retry the action and do not try an equivalent command. Continue with other work, or explain what you needed and why.",
  "</approval_gate>",
].join("\n");

const engines = new WeakMap<DaemonContext, ApprovalEngine>();

/**
 * The approval engine of a running daemon, for features set up after this one
 * (W3-SBX calls `setSandboxInfo` on it). Undefined before setup ran.
 */
export function approvalEngineFor(ctx: DaemonContext): ApprovalEngine | undefined {
  return engines.get(ctx);
}

/** The current turn of a session, for the per-turn denial limit. */
function turnKeyFor(ctx: DaemonContext, c: SdkCallContext): string {
  if (c.kind === "chat") return `chat|${c.sessionKey ?? ""}|${ctx.turnContext.get(c.sessionKey)?.startedAt ?? 0}`;
  return `${c.kind}|${c.taskId ?? c.goalId ?? c.sessionKey ?? c.label}`;
}

/** Approval gates (item 9, PLAN C.9). */
export const setupApprovals: FeatureSetup = (ctx) => {
  const cfg = ctx.config.approvals;
  let lastErrorNotice = 0;

  const engine = new ApprovalEngine({
    config: cfg,
    settings: ctx.settings,
    homeDir: homedir(),
    dataDir: ctx.dataDir,
    gatewayPort: ctx.config.gateway.port,
    isOwnerChat: (channel, chatId) => ctx.owners.isOwner(channel as ChannelName, chatId),
    originOf: (c) => originOf(c, ctx.turnContext),
    sandboxInfo: () => approvalSandboxInfoFrom(ctx.settings, ctx.config.sandbox),
    onError: () => {
      const now = Date.now();
      if (now - lastErrorNotice < ENGINE_ERROR_NOTICE_INTERVAL_MS) return;
      lastErrorNotice = now;
      void ctx.notifyOwner("Approvals: the approval engine hit an internal error. In yolo mode the call was allowed; in ask mode it waits for you. Details are in the daemon log.");
    },
  });
  engines.set(ctx, engine);

  const prompter = new ApprovalPrompter({
    prompts: ctx.ownerPrompts,
    policy: () => engine.policy(),
    audit: ctx.audit,
    scrub: (t) => scrubSecrets(t, { sink: "prompt-card" }),
    originOf: (c) => originOf(c, ctx.turnContext),
    turnKey: (c) => turnKeyFor(ctx, c),
    notifyOwner: (text) => { void ctx.notifyOwner(text); },
  });
  const stats = new ApprovalStats();

  // approvals.enabled: false means no gate at all (C.9 kill switch); the command still reports it.
  if (cfg.enabled) {
    ctx.sdkOptions.registerGate(createApprovalsGate(engine, prompter, { audit: ctx.audit, stats }));
    ctx.promptAddenda.register("approvals", () => APPROVALS_PROMPT_ADDENDUM);
  }

  ctx.commands.registerAll(createApprovalsCommands({
    engine,
    settings: ctx.settings,
    audit: ctx.audit,
    prompter,
    stats,
    enabled: cfg.enabled,
  }));

  ctx.internalApi.mount("approvals", createApprovalsStatusApp({
    enabled: cfg.enabled,
    mode: () => engine.policy().mode,
    askScope: () => engine.policy().askScope,
    pending: () => prompter.pendingCount(),
  }));

  return { name: "approvals" };
};
