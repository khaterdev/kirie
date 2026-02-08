import type { AutoReplyEngine } from "./auto-reply.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SessionStore } from "../engine/session-store.js";
import type { MessagePipeline } from "../routing/pipeline.js";
import type { BackgroundTaskManager } from "../engine/background-task-manager.js";
import type { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import type { UsageDashboard } from "../logging/usage-dashboard.js";

/**
 * Register the built-in auto-reply commands.
 * These provide quick system info without invoking the AI agent.
 */
export function registerBuiltinCommands(
  engine: AutoReplyEngine,
  deps: {
    channelRegistry: ChannelRegistry;
    sessionStore: SessionStore;
    pipeline?: MessagePipeline;
    backgroundTaskManager?: BackgroundTaskManager;
    onRestart?: () => void;
    chatHistoryStore?: ChatHistoryStore;
    usageDashboard?: UsageDashboard;
  },
): void {
  // /help - list available commands
  engine.register({
    name: "/help",
    pattern: /^\/help\b/i,
    description: "List available auto-reply commands",
    handler(_args, _ctx) {
      const cmds = engine.listCommands();
      const lines = ["Available commands:"];
      for (const cmd of cmds) {
        lines.push(`  ${cmd.name} - ${cmd.description}`);
      }
      return lines.join("\n");
    },
  });

  // /status - system status
  engine.register({
    name: "/status",
    pattern: /^\/status\b/i,
    description: "Show system status (channels, sessions, uptime)",
    handler() {
      const running = deps.channelRegistry.getRunning();
      const sessionCount = deps.sessionStore.count();
      const uptimeSecs = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSecs / 3600);
      const mins = Math.floor((uptimeSecs % 3600) / 60);
      const secs = uptimeSecs % 60;

      const lines = [
        "System Status",
        `  Uptime: ${hours}h ${mins}m ${secs}s`,
        `  Active sessions: ${sessionCount}`,
        `  Running channels: ${running.length > 0 ? running.join(", ") : "none"}`,
      ];
      return lines.join("\n");
    },
  });

  // /sessions - list active sessions
  engine.register({
    name: "/sessions",
    pattern: /^\/sessions\b/i,
    description: "List active sessions",
    handler() {
      const keys = deps.sessionStore.listAll();
      if (keys.length === 0) return "No active sessions.";

      const lines = [`Active sessions (${keys.length}):`];
      for (const key of keys.slice(0, 20)) {
        lines.push(`  ${key}`);
      }
      if (keys.length > 20) {
        lines.push(`  ... and ${keys.length - 20} more`);
      }
      return lines.join("\n");
    },
  });

  // /channels - list channel statuses
  engine.register({
    name: "/channels",
    pattern: /^\/channels\b/i,
    description: "List channel statuses",
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
  });

  // /stop - interrupt the running agent for this chat
  engine.register({
    name: "/stop",
    pattern: /^\/stop\b/i,
    description: "Stop the agent currently working on this chat",
    handler(_args, ctx) {
      if (!deps.pipeline) return "Pipeline not available.";

      const sessionKey = `${ctx.channel}:${ctx.chatType}:${ctx.chatId}`;
      const aborted = deps.pipeline.abortSession(sessionKey);
      return aborted
        ? "Stopped the running agent for this chat."
        : "No agent is currently running for this chat.";
    },
  });

  // /stopall - stop all running agents and background tasks
  engine.register({
    name: "/stopall",
    pattern: /^\/stopall\b/i,
    description: "Stop all running agents and background tasks",
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
  });

  // /clear - clear current chat session context (start fresh)
  engine.register({
    name: "/clear",
    pattern: /^\/clear\b/i,
    description: "Clear chat context and start a fresh conversation",
    handler(_args, ctx) {
      if (!deps.pipeline) return "Pipeline not available.";

      const sessionKey = `${ctx.channel}:${ctx.chatType}:${ctx.chatId}`;
      deps.pipeline.clearSession(sessionKey);
      return "Chat context cleared. Next message starts a fresh conversation.";
    },
  });

  // /restart - restart the daemon (graceful stop + start without process exit)
  engine.register({
    name: "/restart",
    pattern: /^\/restart\b/i,
    description: "Restart the daemon (reload config, channels, and all subsystems)",
    handler() {
      if (!deps.onRestart) return "Restart not available.";
      // Schedule restart on next tick so the response message is sent first
      setImmediate(() => deps.onRestart!());
      return "Restarting Kirie daemon... I'll be back in a moment.";
    },
  });

  // /context - show current chat context info
  engine.register({
    name: "/context",
    pattern: /^\/context\b/i,
    description: "Show current chat session context",
    handler(_args, ctx) {
      const sessionKey = `${ctx.channel}:${ctx.chatType}:${ctx.chatId}`;
      const row = deps.sessionStore.getRow(sessionKey);

      const lines = ["Chat Context"];
      lines.push(`  Session: ${sessionKey}`);

      if (row) {
        lines.push(`  Started: ${row.created_at}`);
        lines.push(`  Last active: ${row.updated_at}`);
        const hasSession = !row.sdk_session_id.startsWith("pending:");
        lines.push(`  SDK session: ${hasSession ? "active" : "pending"}`);
      } else {
        lines.push(`  Status: no session (new conversation)`);
      }

      if (deps.chatHistoryStore) {
        const count = deps.chatHistoryStore.messageCount(sessionKey);
        lines.push(`  Messages: ${count}`);
      }

      const uptimeSecs = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSecs / 3600);
      const mins = Math.floor((uptimeSecs % 3600) / 60);
      lines.push(`  Daemon uptime: ${hours}h ${mins}m`);

      return lines.join("\n");
    },
  });

  // /usage - show API usage stats
  engine.register({
    name: "/usage",
    pattern: /^\/usage\b/i,
    description: "Show API usage stats (costs, requests, models)",
    handler(_args, ctx) {
      if (!deps.usageDashboard) return "Usage tracking not configured.";

      const daily = deps.usageDashboard.getSummary("day");
      const weekly = deps.usageDashboard.getSummary("week");
      const sessionKey = `${ctx.channel}:${ctx.chatType}:${ctx.chatId}`;

      const lines = ["API Usage"];
      lines.push("");
      lines.push("Today:");
      lines.push(`  Requests: ${daily.totalRequests}`);
      lines.push(`  Cost: $${daily.totalCostUsd.toFixed(4)}`);
      lines.push("");
      lines.push("This week:");
      lines.push(`  Requests: ${weekly.totalRequests}`);
      lines.push(`  Cost: $${weekly.totalCostUsd.toFixed(4)}`);

      if (weekly.models.length > 0) {
        lines.push("");
        lines.push("Models (weekly):");
        for (const m of weekly.models) {
          lines.push(`  ${m.model}: ${m.requests} req, $${m.costUsd.toFixed(4)}`);
        }
      }

      // Show this session's usage
      const topSessions = deps.usageDashboard.getTopSessions(100, "week");
      const thisSession = topSessions.find((s) => s.sessionKey === sessionKey);
      if (thisSession) {
        lines.push("");
        lines.push("This chat (weekly):");
        lines.push(`  Requests: ${thisSession.requests}`);
        lines.push(`  Cost: $${thisSession.totalCostUsd.toFixed(4)}`);
      }

      return lines.join("\n");
    },
  });
}
