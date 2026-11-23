/**
 * MCP tool seam (PLAN B.10 seam 4, B.13).
 *
 * Every feature fills one `mcp/tools/<name>-tools.ts` factory. Both tool
 * registries call `registerFeatureTools`: the stdio server the agent uses
 * (`mcp/stdio-server.ts`) and the daemon's in-process registry
 * (`mcp/server.ts`), so a feature never edits either file. `lifecycle.ts`
 * extends `allowedTools` with `featureToolNames(ctx)`.
 *
 * Rules for factories: pure (no file, DB or network access when called);
 * parameters only `string`, `number`, `boolean`, `string[]` (structured input
 * is a JSON string); a tool that must exist only when its feature is on checks
 * `ctx.env` (the feature sets that key in `DaemonContext.kirieToolsEnv`).
 * No tool may approve, apply, confirm, arm, reveal a secret or change a
 * security mode (PLAN B.13, E.4).
 */

import type { McpToolDefinition } from "./server.js";
import { createModuleLogger } from "../logging/logger.js";
import { createAccountsTools } from "./tools/accounts-tools.js";
import { createLearningTools } from "./tools/learning-tools.js";
import { createCuratorTools } from "./tools/curator-tools.js";
import { createUserModelTools } from "./tools/usermodel-tools.js";
import { createGoalsTools } from "./tools/goals-tools.js";
import { createLoopsTools } from "./tools/loops-tools.js";
import { createWebhooksTools } from "./tools/webhooks-tools.js";
import { createApprovalsTools } from "./tools/approvals-tools.js";
import { createSecretsTools } from "./tools/secrets-tools.js";
import { createSandboxTools } from "./tools/sandbox-tools.js";
import { createPluginsTools } from "./tools/plugins-tools.js";
import { createComputerUseTools } from "./tools/computer-use-tools.js";
import { createVoiceTools } from "./tools/voice-tools.js";

const log = createModuleLogger("feature-tools");

export interface FeatureToolContext {
  /** ~/.kirie (KIRIE_DB_DIR in the stdio subprocess) */
  dbDir: string;
  /** http://127.0.0.1:<port>; set in the stdio subprocess and in the daemon */
  gatewayUrl?: string;
  /** The kirie-tools server env (KIRIE_* flags) */
  env: Record<string, string | undefined>;
}

/** Must be pure: no file, DB or network access when called. Handlers open what they need on first use. */
export type FeatureToolFactory = (ctx: FeatureToolContext) => Record<string, McpToolDefinition>;

export const FEATURE_TOOL_FACTORIES: readonly FeatureToolFactory[] = [
  createAccountsTools,
  createLearningTools,
  createCuratorTools,
  createUserModelTools,
  createGoalsTools,
  createLoopsTools,
  createWebhooksTools,
  createApprovalsTools,
  createSecretsTools,
  createSandboxTools,
  createPluginsTools,
  createComputerUseTools,
  createVoiceTools,
];

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The feature tools for this context. A factory that throws is skipped (its
 * feature's tools are absent); a name defined twice keeps the first definition.
 */
export function collectFeatureTools(
  ctx: FeatureToolContext,
  factories: readonly FeatureToolFactory[] = FEATURE_TOOL_FACTORIES,
): Record<string, McpToolDefinition> {
  const out: Record<string, McpToolDefinition> = {};
  for (const factory of factories) {
    let handlers: Record<string, McpToolDefinition>;
    try {
      handlers = factory(ctx);
    } catch (err) {
      log.error({ factory: factory.name, err: err instanceof Error ? err.message : String(err) }, "feature tool factory failed (its tools are skipped)");
      continue;
    }
    for (const [name, def] of Object.entries(handlers ?? {})) {
      if (!TOOL_NAME_RE.test(name)) {
        log.error({ factory: factory.name, tool: name }, "invalid feature tool name (skipped)");
        continue;
      }
      if (out[name]) {
        log.error({ factory: factory.name, tool: name }, "duplicate feature tool name (second definition skipped)");
        continue;
      }
      out[name] = def;
    }
  }
  return out;
}

/** Called by both tool registries. */
export function registerFeatureTools(
  register: (handlers: Record<string, McpToolDefinition>) => void,
  ctx: FeatureToolContext,
  factories: readonly FeatureToolFactory[] = FEATURE_TOOL_FACTORIES,
): void {
  const handlers = collectFeatureTools(ctx, factories);
  if (Object.keys(handlers).length > 0) register(handlers);
}

/** Tool names for `allowedTools` (lifecycle.ts prefixes them with "mcp__kirie-tools__"). */
export function featureToolNames(
  ctx: FeatureToolContext,
  factories: readonly FeatureToolFactory[] = FEATURE_TOOL_FACTORIES,
): string[] {
  return Object.keys(collectFeatureTools(ctx, factories));
}
