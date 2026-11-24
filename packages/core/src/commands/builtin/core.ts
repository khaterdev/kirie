/**
 * Built-in core commands (PLAN B.4, B.12), migrated from auto-reply/commands.ts.
 *
 * Flags follow B.12: /help, /stop, /clear, /context are public (they act on the
 * caller's own chat); /status, /sessions, /channels, /usage, /stopall,
 * /restart are owner-only in the DM; /pending, /approve, /deny, /answer are the
 * owner's text fallback for prompts. The owner check is done by the registry,
 * never here. Reply texts are unchanged from the old auto-reply commands.
 */

import type { ChannelRegistry } from "../../channels/registry.js";
import type { SessionStore } from "../../engine/session-store.js";
import type { UsageDashboard } from "../../logging/usage-dashboard.js";
import type { AnswerByCodeResult, OwnerPrompts } from "../../interaction/owner-prompts.js";
import type { CommandContext, CommandDefinition } from "../types.js";

export interface CoreCommandDeps {
  /** Renders /help */
  help: { renderHelp(opts: { isOwner: boolean; topic?: string }): string };
  channelRegistry: Pick<ChannelRegistry, "getRunning" | "getAll" | "isRunning">;
  sessionStore: Pick<SessionStore, "count" | "listAll" | "getRow">;
  pipeline?: {
    abortSession(sessionKey: string): boolean;
    abortAll(): number;
    clearSession(sessionKey: string): void;
  };
  backgroundTaskManager?: { cancelAll(): number | Promise<number> };
  onRestart?: () => void;
  chatHistoryStore?: { messageCount(sessionKey: string): number };
  usageDashboard?: Pick<UsageDashboard, "getSummary" | "getTopSessions">;
  prompts?: Pick<OwnerPrompts, "pending" | "answerByCode">;
}

function uptime(): { hours: number; mins: number; secs: number } {
  const uptimeSecs = Math.floor(process.uptime());
  return {
    hours: Math.floor(uptimeSecs / 3600),
    mins: Math.floor((uptimeSecs % 3600) / 60),
    secs: uptimeSecs % 60,
  };
}

function answerText(result: AnswerByCodeResult, code: string, verb: string): string {
  switch (result.status) {
    case "ok":
      return `${verb} ${code} (${result.optionLabel}): ${result.summary}`;
    case "resent":
      return `${code} is: ${result.summary}\nIts card has buttons, so a typed code does not answer it. I sent the real card again just above; check it and use its buttons.`;
    case "resend-failed":
      return `${code} is: ${result.summary}\nIts card has buttons, so a typed code does not answer it, and sending the card again failed. Nothing was answered.`;
    case "not-ready":
      return `${code} is: ${result.summary}\nIts card is still being sent. Nothing was answered; try again in a moment.`;
    case "closed":
      return `${code} is already over (answered, timed out or cancelled): ${result.summary}. Nothing was changed.`;
    case "bad-option":
      return `${code} has no such option. It is: ${result.summary}\nOptions: ${result.options.map((o) => `${o.id} (${o.label})`).join(", ")}. Reply /answer ${code} <option>.`;
    case "wrong-chat":
      return `${code} was sent to your ${result.channel} DM. Answer it there.`;
    case "not-found":
      return `No pending request with code ${code}. Send /pending for the list.`;
    case "not-owner":
      return "Only the owner can answer.";
  }
}

function answerer(ctx: CommandContext): { channel: CommandContext["message"]["channel"]; senderId: string; chatId: string } {
  return { channel: ctx.message.channel, senderId: ctx.message.senderId, chatId: ctx.message.chatId };
}

function codeArg(ctx: CommandContext): string | null {
  const code = ctx.argv[0]?.trim().toUpperCase();
  return code && /^[A-Z0-9]{2,8}$/.test(code) ? code : null;
}

export function createCoreCommands(deps: CoreCommandDeps): CommandDefinition[] {
  const commands: CommandDefinition[] = [
    {
      name: "help",
      description: "List commands, or show details for one command",
      category: "core",
      ownerOnly: false,
      scope: "any",
      args: "[command]",
      handler(ctx) {
        return deps.help.renderHelp({ isOwner: ctx.isOwner, topic: ctx.argv[0] });
      },
    },
    {
      name: "status",
      description: "Show system status (channels, sessions, uptime)",
      category: "core",
      ownerOnly: true,
      handler() {
        const running = deps.channelRegistry.getRunning();
        const sessionCount = deps.sessionStore.count();
        const { hours, mins, secs } = uptime();
        return [
          "System Status",
          `  Uptime: ${hours}h ${mins}m ${secs}s`,
          `  Active sessions: ${sessionCount}`,
          `  Running channels: ${running.length > 0 ? running.join(", ") : "none"}`,
        ].join("\n");
      },
    },
    {
      name: "sessions",
      description: "List active sessions",
      category: "core",
      ownerOnly: true,
      handler() {
        const keys = deps.sessionStore.listAll();
        if (keys.length === 0) return "No active sessions.";
        const lines = [`Active sessions (${keys.length}):`];
        for (const key of keys.slice(0, 20)) lines.push(`  ${key}`);
        if (keys.length > 20) lines.push(`  ... and ${keys.length - 20} more`);
        return lines.join("\n");
      },
    },
    {
      name: "channels",
      description: "List channel statuses",
      category: "core",
      ownerOnly: true,
      handler() {
        const all = deps.channelRegistry.getAll();
        if (all.size === 0) return "No channels registered.";
        const lines = ["Channels:"];
        for (const [id, adapter] of all) {
          const running = deps.channelRegistry.isRunning(id);
          const status = adapter.getStatus();
          lines.push(`  ${id}: ${status.state} (${running ? "running" : "stopped"})`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "stop",
      description: "Stop the agent currently working on this chat",
      category: "core",
      ownerOnly: false,
      scope: "any",
      handler(ctx) {
        if (!deps.pipeline) return "Pipeline not available.";
        return deps.pipeline.abortSession(ctx.sessionKey)
          ? "Stopped the running agent for this chat."
          : "No agent is currently running for this chat.";
      },
    },
    {
      name: "stopall",
      description: "Stop all running agents and background tasks",
      category: "core",
      ownerOnly: true,
      async handler() {
        const lines: string[] = [];
        if (deps.pipeline) {
          const aborted = deps.pipeline.abortAll();
          lines.push(`Stopped ${aborted} running agent${aborted !== 1 ? "s" : ""}.`);
        }
        if (deps.backgroundTaskManager) {
          const cancelled = await deps.backgroundTaskManager.cancelAll();
          lines.push(`Cancelled ${cancelled} background task${cancelled !== 1 ? "s" : ""}.`);
        }
        return lines.length > 0 ? lines.join("\n") : "Nothing to stop.";
      },
    },
    {
      name: "clear",
      description: "Clear chat context and start a fresh conversation",
      category: "core",
      ownerOnly: false,
      scope: "any",
      handler(ctx) {
        if (!deps.pipeline) return "Pipeline not available.";
        deps.pipeline.clearSession(ctx.sessionKey);
        return "Chat context cleared. Next message starts a fresh conversation.";
      },
    },
    {
      name: "restart",
      description: "Restart the daemon (reload config, channels, and all subsystems)",
      category: "core",
      ownerOnly: true,
      async handler(ctx) {
        if (!deps.onRestart) return "Restart not available.";
        // Send the reply first, then restart on the next tick.
        await ctx.reply("Restarting Kirie daemon... I'll be back in a moment.");
        const restart = deps.onRestart;
        setImmediate(() => restart());
        return undefined;
      },
    },
    {
      name: "context",
      description: "Show current chat session context",
      category: "core",
      ownerOnly: false,
      scope: "any",
      handler(ctx) {
        const sessionKey = ctx.sessionKey;
        const row = deps.sessionStore.getRow(sessionKey);
        const lines = ["Chat Context", `  Session: ${sessionKey}`];
        if (row) {
          lines.push(`  Started: ${row.created_at}`);
          lines.push(`  Last active: ${row.updated_at}`);
          const hasSession = !row.sdk_session_id.startsWith("pending:");
          lines.push(`  SDK session: ${hasSession ? "active" : "pending"}`);
        } else {
          lines.push(`  Status: no session (new conversation)`);
        }
        if (deps.chatHistoryStore) {
          lines.push(`  Messages: ${deps.chatHistoryStore.messageCount(sessionKey)}`);
        }
        const { hours, mins } = uptime();
        lines.push(`  Daemon uptime: ${hours}h ${mins}m`);
        return lines.join("\n");
      },
    },
    {
      name: "usage",
      description: "Show API usage stats (costs, requests, models)",
      category: "core",
      ownerOnly: true,
      handler(ctx) {
        if (!deps.usageDashboard) return "Usage tracking not configured.";
        const daily = deps.usageDashboard.getSummary("day");
        const weekly = deps.usageDashboard.getSummary("week");
        const lines = ["API Usage", "", "Today:"];
        lines.push(`  Requests: ${daily.totalRequests}`);
        lines.push(`  Cost: $${daily.totalCostUsd.toFixed(4)}`);
        lines.push("", "This week:");
        lines.push(`  Requests: ${weekly.totalRequests}`);
        lines.push(`  Cost: $${weekly.totalCostUsd.toFixed(4)}`);
        if (weekly.models.length > 0) {
          lines.push("", "Models (weekly):");
          for (const m of weekly.models) {
            lines.push(`  ${m.model}: ${m.requests} req, $${m.costUsd.toFixed(4)}`);
          }
        }
        const thisSession = deps.usageDashboard.getTopSessions(100, "week").find((s) => s.sessionKey === ctx.sessionKey);
        if (thisSession) {
          lines.push("", "This chat (weekly):");
          lines.push(`  Requests: ${thisSession.requests}`);
          lines.push(`  Cost: $${thisSession.totalCostUsd.toFixed(4)}`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "pending",
      description: "List questions waiting for your answer",
      category: "core",
      ownerOnly: true,
      handler() {
        const pending = deps.prompts?.pending() ?? [];
        if (pending.length === 0) return "Nothing is waiting for your answer.";
        const now = Date.now();
        const lines = [`Waiting for your answer (${pending.length}):`];
        for (const p of pending) {
          const mins = Math.max(0, Math.ceil((p.expiresAt - now) / 60_000));
          lines.push(`  ${p.code}  ${p.summary}  (${p.kind}, ${mins} min left)`);
          lines.push(`    options: ${p.options.map((o) => `${o.id} (${o.label})`).join(", ")}`);
        }
        lines.push("", "Use the buttons on each card. Without buttons, reply /approve <code>, /deny <code> or /answer <code> <option>.");
        return lines.join("\n");
      },
    },
    {
      name: "approve",
      description: "Approve a pending request by its code",
      category: "core",
      ownerOnly: true,
      args: "<code>",
      auditArgs: false,
      async handler(ctx) {
        const code = codeArg(ctx);
        if (!code) return "Usage: /approve <code>. Send /pending for the list.";
        if (!deps.prompts) return "Prompts are not available.";
        return answerText(await deps.prompts.answerByCode(code, "approve", answerer(ctx)), code, "Approved");
      },
    },
    {
      name: "deny",
      description: "Deny a pending request by its code",
      category: "core",
      ownerOnly: true,
      args: "<code>",
      auditArgs: false,
      async handler(ctx) {
        const code = codeArg(ctx);
        if (!code) return "Usage: /deny <code>. Send /pending for the list.";
        if (!deps.prompts) return "Prompts are not available.";
        return answerText(await deps.prompts.answerByCode(code, "deny", answerer(ctx)), code, "Denied");
      },
    },
    {
      name: "answer",
      description: "Answer a pending question by code when buttons are not available",
      category: "core",
      ownerOnly: true,
      args: "<code> <option>",
      auditArgs: false,
      async handler(ctx) {
        const code = codeArg(ctx);
        const option = ctx.argv[1]?.trim().toLowerCase();
        if (!code || !option) return "Usage: /answer <code> <option>. Send /pending for the list.";
        if (!deps.prompts) return "Prompts are not available.";
        return answerText(await deps.prompts.answerByCode(code, option, answerer(ctx)), code, "Answered");
      },
    },
  ];
  return commands;
}
