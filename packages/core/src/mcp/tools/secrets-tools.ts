import { join } from "node:path";
import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { getScrubber } from "../../security/secret-scrubber.js";
import {
  SECRETS_HEARTBEAT_DB_ENV,
  SECRETS_TOOL_ENV,
  SecretsAuditor,
  type SecretsScanSummary,
} from "../../security/secrets-scan.js";

export interface SecretsScanToolResult extends SecretsScanSummary {
  hint: string;
}

/**
 * Secret scan tool (PLAN B.13, W2-SEC): `secrets_scan`.
 *
 * Read-only and counts only: it runs a quick scan (databases, Markdown files,
 * config) with read-only handles and returns totals by store and by rule. It
 * returns no locations, no fingerprints and no values, writes no report, and
 * cannot redact. Redaction is the owner's /secrets redact.
 *
 * The factory is pure: the auditor is built when the tool is called.
 */
export const createSecretsTools: FeatureToolFactory = (ctx) => {
  if (ctx.env[SECRETS_TOOL_ENV] !== "1") return {};
  const tools: Record<string, McpToolDefinition> = {
    secrets_scan: {
      description:
        "Count plaintext secrets (API keys, tokens, passwords) already stored in Kirie's memory, chat history, " +
        "background tasks, heartbeat logs, workspace Markdown files and config. Read-only. Returns counts by store " +
        "and by rule only, never values or locations. If anything is found, tell the owner to run /secrets scan and " +
        "/secrets redact, and to rotate the keys.",
      parameters: { type: "object", properties: {} },
      handler(): SecretsScanToolResult {
        const heartbeatLogDbPath = ctx.env[SECRETS_HEARTBEAT_DB_ENV];
        const auditor = new SecretsAuditor({
          dataDir: ctx.dbDir,
          scrubber: getScrubber(),
          ...(heartbeatLogDbPath ? { heartbeatLogDbPath } : {}),
          configPath: join(ctx.dbDir, "config.yaml"),
        });
        const summary = auditor.summarize("quick");
        return {
          ...summary,
          hint: summary.counts.total > 0
            ? "Ask the owner to send /secrets scan for the details and /secrets redact to clean them; rotating the keys is the real fix."
            : "Nothing found by the pattern rules.",
        };
      },
    },
  };
  return tools;
};
