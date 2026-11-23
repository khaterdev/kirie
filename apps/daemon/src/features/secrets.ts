import { homedir } from "node:os";
import { join } from "node:path";
import {
  SECRETS_HEARTBEAT_DB_ENV,
  SECRETS_TOOL_ENV,
  SecretsAuditor,
  createSecretsCommands,
} from "@kirie/core";
import { daemonScrubbingConfig, freezeScrubbingConfig } from "./scrubbing.js";
import type { DaemonContext, FeatureSetup } from "./types.js";

/** The auditor for this daemon's data dir (exported for tests). */
export function createDaemonSecretsAuditor(ctx: DaemonContext, opts?: { homeDir?: string }): SecretsAuditor {
  const heartbeatLogDbPath = ctx.config.proactive?.heartbeatLogging?.dbPath;
  const memoryManager = ctx.memoryManager;
  return new SecretsAuditor({
    dataDir: ctx.dataDir,
    homeDir: opts?.homeDir ?? homedir(),
    configPath: join(ctx.dataDir, "config.yaml"),
    vectorDbPath: join(ctx.dataDir, "vectors.db"),
    ...(heartbeatLogDbPath ? { heartbeatLogDbPath } : {}),
    scrubber: ctx.scrubber,
    vault: ctx.credentialStore,
    ...(memoryManager ? { reembedMemory: (key: string, content: string, tags: string[]) => memoryManager.store(key, content, tags) } : {}),
    audit: ctx.audit,
  });
}

/**
 * /secrets scan and redact (item 12 part 3, PLAN C.12). Registers the owner
 * command and turns on the read-only `secrets_scan` tool in the kirie-tools
 * subprocess. No timers, no I/O at setup: a scan runs only when the owner
 * (or the agent's counts-only tool) asks.
 */
export const setupSecrets: FeatureSetup = (ctx) => {
  const auditor = createDaemonSecretsAuditor(ctx);
  ctx.commands.registerAll(createSecretsCommands({
    auditor,
    scrubber: ctx.scrubber,
    scrubbingConfig: freezeScrubbingConfig(daemonScrubbingConfig(ctx.config)),
  }));
  ctx.kirieToolsEnv[SECRETS_TOOL_ENV] = "1";
  const heartbeatLogDbPath = ctx.config.proactive?.heartbeatLogging?.dbPath;
  if (heartbeatLogDbPath) ctx.kirieToolsEnv[SECRETS_HEARTBEAT_DB_ENV] = heartbeatLogDbPath;
  return { name: "secrets" };
};
