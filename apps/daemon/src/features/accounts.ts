import { join } from "node:path";
import {
  AccountManager,
  AccountStore,
  ACCOUNTS_AGENT_TOOLS_ENV,
  ACCOUNTS_DB_FILE,
  ACCOUNTS_ROTATION_SETTING,
  AccountsBooleanSetting,
  FALLBACK_ENABLED_SETTING,
  FALLBACK_MODELS_SETTING,
  FallbackControl,
  FallbackModelsSetting,
  TurnResilience,
  accountsAuthErrorNotice,
  accountsExhaustedNotice,
  accountsRotationNotice,
  createAccountVerifier,
  createAccountsCommands,
  createAccountsInternalApi,
  createModuleLogger,
  defaultOneShotCwd,
  effectiveSettingFlag,
  ensureOneShotCwd,
  fallbackNotice,
  scrubSecrets,
  setTriageAccountGate,
  type FallbackConfig,
  type PromptAddendumContext,
  type SdkCallKind,
} from "@kirie/core";
import type { FeatureSetup } from "./types.js";

const log = createModuleLogger("accounts-feature");

/** The account-env contributor serves only calls that do not take a lease themselves. */
const ENV_CONTRIBUTOR_KINDS: ReadonlySet<SdkCallKind> = new Set<SdkCallKind>(["judge", "triage", "oneshot", "utility"]);
/** Layer A (SDK in-turn fallback) applies to agent turns, never to no-tools calls. */
const FALLBACK_CONTRIBUTOR_KINDS: ReadonlySet<SdkCallKind> = new Set<SdkCallKind>(["chat", "background", "goal", "webhook"]);
/** The import route waits for the owner's tap; stay under the HTTP server's request timeout. */
const MAX_IMPORT_APPROVAL_MS = 240_000;

/** Lets the agent know the accounts commands and tools exist (owner DM chat only). */
export function renderAccountsAddendum(agentTools: "off" | "read" | "manage", ctx: PromptAddendumContext): string | null {
  if (ctx.kind !== "chat" || !ctx.ownerDm) return null;
  const lines = [
    "<claude_accounts>",
    "Kirie can run on several Claude accounts (config dirs) and fall back to other models. The owner manages this with /accounts, /rotation and /fallback.",
  ];
  if (agentTools !== "off") {
    lines.push("accounts_list and accounts_discover show the accounts, limits and fallback state.");
  }
  if (agentTools === "manage") {
    lines.push(
      "accounts_use, accounts_set_enabled, accounts_reset and accounts_set_rotation change them (the owner is told); accounts_import asks the owner before importing a discovered dir. Pass your session_key.",
    );
  }
  lines.push("Never read, copy or print Claude credentials or tokens; the claude binary reads its own login.", "</claude_accounts>");
  return lines.join("\n");
}

/**
 * Claude accounts, rotation and model fallback (items 1, 2; PLAN C.1, C.2).
 *
 * With nothing imported and fallback off, every engine spawns exactly as
 * before: the loop yields the ambient account and the configured model, and
 * neither contributor changes an option.
 */
export const setupAccounts: FeatureSetup = (ctx) => {
  const config = ctx.config;
  const timezone = config.proactive?.activeHours?.timezone;
  const store = new AccountStore(join(ctx.dataDir, ACCOUNTS_DB_FILE));

  const rotationEnabled = (): boolean =>
    effectiveSettingFlag(ctx.settings, ACCOUNTS_ROTATION_SETTING, config.accounts.rotation.enabled);
  const fallbackConfig = (): FallbackConfig => ({
    ...config.agent.fallback,
    enabled: ctx.settings.effective(FALLBACK_ENABLED_SETTING, AccountsBooleanSetting, config.agent.fallback.enabled),
    models: ctx.settings.effective(FALLBACK_MODELS_SETTING, FallbackModelsSetting, config.agent.fallback.models),
  });
  const notify = (text: string, key: string): void => {
    void ctx.notifyOwner(text, { key }).catch(() => undefined);
  };

  const manager = new AccountManager({
    store,
    config: () => config.accounts,
    rotationEnabled,
    scrub: (text) => scrubSecrets(text, { sink: "audit" }),
    audit: ctx.audit,
    verify: createAccountVerifier({
      cwd: ensureOneShotCwd(defaultOneShotCwd(ctx.dataDir)),
      sdkOptions: ctx.sdkOptions,
    }),
  });
  const fallback = new FallbackControl({
    store,
    config: fallbackConfig,
    onEpisodeStart: (episode) => notify(fallbackNotice(episode), "accounts:fallback"),
  });

  manager.on("rotated", (ev) => {
    if (config.accounts.rotation.notify) notify(accountsRotationNotice(ev, timezone), `accounts:rotated:${ev.from ?? "-"}`);
  });
  manager.on("exhausted", (ev) => notify(accountsExhaustedNotice(ev, timezone), "accounts:exhausted"));
  manager.on("auth_error", (ev) =>
    notify(accountsAuthErrorNotice(ev, manager.get(ev.accountId)), `accounts:auth_error:${ev.accountId}`),
  );

  // The per-turn loop for the chat and task engines.
  const resilience = new TurnResilience({ accounts: manager, models: fallback });
  ctx.agentEngine.setResilience(resilience);
  ctx.v2Sessions?.setResilience(resilience);
  ctx.backgroundTaskManager.setResilience(resilience);

  // Triage acquires first and skips the cycle while every account is limited.
  setTriageAccountGate({
    beforeCall: () => {
      if (!manager.hasAccounts()) return { skip: false, accountId: null };
      const lease = manager.acquire();
      return {
        skip: lease.exhausted,
        accountId: lease.accountId,
        ...(lease.earliestResetAt !== undefined ? { untilMs: lease.earliestResetAt } : {}),
      };
    },
    reportFailure: (accountId, failure) => {
      if (accountId === null) return false;
      manager.reportFailure(accountId, failure);
      const next = manager.acquire();
      return !next.exhausted && next.accountId !== accountId;
    },
  });

  // Contributor 20: the active account's env for calls that take no lease
  // themselves (judge, triage, oneshot, utility), only when env is not set.
  ctx.sdkOptions.registerContributor(
    "account-env",
    (options, call) => {
      if (!ENV_CONTRIBUTOR_KINDS.has(call.kind) || options.env || !manager.hasAccounts()) return;
      const lease = manager.acquire();
      // Fail closed: with every imported account signed out (or its login
      // changed) the call must not run on whatever login the daemon has.
      if (lease.blocked) throw new Error("no usable Claude account: every imported account is signed out or its login changed");
      if (lease.env) options.env = lease.env;
    },
    20,
  );
  // Contributor 30: Layer A, the SDK's own in-turn fallback for overloads.
  ctx.sdkOptions.registerContributor(
    "fallback-model",
    (options, call) => {
      if (!FALLBACK_CONTRIBUTOR_KINDS.has(call.kind) || options.fallbackModel || typeof options.model !== "string") return;
      const arg = fallback.sdkFallbackFor(options.model);
      if (arg) options.fallbackModel = arg;
    },
    30,
  );

  ctx.commands.registerAll(
    createAccountsCommands({
      manager,
      fallback,
      settings: ctx.settings,
      audit: ctx.audit,
      rotationEnabled,
      primaryModel: () => config.agent.model,
      fallbackConfig,
      ...(timezone ? { timezone } : {}),
    }),
  );

  const agentTools = config.accounts.agentTools;
  ctx.internalApi.mount(
    "accounts",
    createAccountsInternalApi({
      manager,
      fallback,
      settings: ctx.settings,
      agentTools: () => agentTools,
      rotationEnabled,
      fallbackConfig,
      primaryModel: () => config.agent.model,
      requestApproval: (req) => ctx.ownerPrompts.requestApproval(req),
      approvalTimeoutMs: Math.min(config.commands.promptTimeoutSeconds * 1000, MAX_IMPORT_APPROVAL_MS),
      notifyOwner: (text, opts) => ctx.notifyOwner(text, opts),
    }),
  );
  if (agentTools !== "off") ctx.kirieToolsEnv[ACCOUNTS_AGENT_TOOLS_ENV] = agentTools;

  ctx.promptAddenda.register("accounts", (p) => renderAccountsAddendum(agentTools, p));

  log.info(
    { accounts: manager.enabledCount(), rotation: rotationEnabled(), fallback: fallbackConfig().enabled, agentTools },
    "accounts feature ready",
  );

  return {
    name: "accounts",
    stop() {
      setTriageAccountGate(null);
      ctx.agentEngine.setResilience(null);
      ctx.v2Sessions?.setResilience(null);
      ctx.backgroundTaskManager.setResilience(null);
      store.close();
    },
  };
};
