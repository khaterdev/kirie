// @kirie/core - Engine, security, routing, config
export * from "./platform.js";
export * from "./engine/agent-engine.js";
export * from "./engine/session-store.js";
export * from "./engine/lane-queue.js";
export * from "./engine/heartbeat.js";
export * from "./engine/network-errors.js";
export * from "./engine/v2-session-manager.js";
export * from "./engine/workspace-manager.js";
export * from "./engine/background-task-store.js";
export * from "./engine/background-task-manager.js";
// prompt-builder: ChannelContext renamed to PromptChannelContext to avoid collision with adapter.ts
export {
  type ChannelContext as PromptChannelContext,
  type SenderIdentity,
  type PromptConfig,
  type BuildPromptOptions,
  type BuiltPrompt,
  buildPrompt,
  buildBackgroundTaskSystemPrompt,
  BACKGROUND_TASK_AGENT_INSTRUCTIONS,
  DEFAULT_SYSTEM_PROMPT,
} from "./engine/prompt-builder.js";
export * from "./channels/adapter.js";
export * from "./channels/registry.js";
export * from "./channels/normalizer.js";
export * from "./channels/health-monitor.js";
export * from "./security/auth.js";
export * from "./security/authz.js";
export * from "./security/rate-limiter.js";
export * from "./security/input-guard.js";
export * from "./security/credential-store.js";
export * from "./security/transport.js";
export * from "./security/audit.js";
export * from "./security/ssrf-guard.js";
export * from "./security/pairing.js";
export * from "./security/code-scanner.js";
export * from "./config/loader.js";
export * from "./config/schema.js";
export * from "./config/watcher.js";
export * from "./config/includes.js";
export * from "./config/env-substitution.js";
export * from "./config/migration.js";
export * from "./config/backup.js";
export * from "./security/gate.js";
export * from "./routing/resolve-route.js";
export * from "./routing/pipeline.js";
// session-key: ChatType re-exported from normalizer already
export {
  type SessionKeyParts,
  makeSessionKey,
  parseSessionKey,
  channelFromKey,
  makeTopicSessionKey,
} from "./routing/session-key.js";
export * from "./gateway/server.js";
export * from "./gateway/routes.js";
export * from "./mcp/server.js";
export { MemoryStore, type MemoryManagerLike } from "./mcp/tools/memory.js";
export * from "./auto-reply/auto-reply.js";
export { registerBuiltinCommands } from "./auto-reply/commands.js";
export * from "./hooks/types.js";
export * from "./hooks/registry.js";
export * from "./plugins/types.js";
export * from "./plugins/loader.js";
export * from "./engine/agent-registry.js";
export * from "./engine/media-output-parser.js";
export * from "./engine/a2a-policy.js";
export * from "./routing/agent-router.js";
export * from "./logging/logger.js";
export * from "./logging/usage-tracker.js";
export * from "./logging/telemetry.js";
export * from "./logging/usage-dashboard.js";

// Auto-reply enhancements
export * from "./auto-reply/template.js";
export * from "./auto-reply/reply-tags.js";

// Routing enhancements
export * from "./routing/broadcast.js";
export * from "./routing/labels.js";

// Config doctor
export * from "./config/doctor.js";

// Sandbox
export * from "./sandbox/types.js";
export * from "./sandbox/docker.js";
export * from "./sandbox/manager.js";

// Memory file watcher
export { MemoryFileWatcher, type FileWatcherOptions } from "./memory/file-watcher.js";

// Proactive Intelligence Layer
export * from "./engine/proactive.js";
export * from "./engine/signals.js";
export * from "./engine/triage.js";
export * from "./engine/notifications.js";
export { checkPlaywrightStatus, ensurePlaywrightInstalled } from "./mcp/tools/browser-tool.js";
export { createProactiveToolHandlers } from "./mcp/tools/proactive-tools.js";
export { HeartbeatLogStore, createHeartbeatLogToolHandlers } from "./mcp/tools/heartbeat-logs.js";
export type { HeartbeatLogEntry, HeartbeatLogInput, HeartbeatLogTier, HeartbeatLogLevel, HeartbeatLogMinLevels } from "./mcp/tools/heartbeat-logs.js";
