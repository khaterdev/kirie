// Claude accounts, rotation and model fallback (PLAN B.10 seam 5, items 1 and 2). Owned by W2-ACC.
// Every exported symbol carries the feature's name (B.10). The engine-side loop
// (engine/resilience.ts, engine/model-chain.ts) is exported from here too,
// because packages/core/src/index.ts is not edited after wave 1.
export { ACCOUNT_AUTH_OVERRIDES, buildAccountEnv, type AccountEnvSource, type ClaudeAccountKind } from "./account-env.js";
export {
  AccountStore,
  ACCOUNTS_DB_FILE,
  ACCOUNT_ID_RE,
  type ClaudeAccount,
  type ClaudeAccountStatus,
  type AccountModelLimit,
} from "./account-store.js";
export {
  AccountManager,
  AccountImportError,
  type AccountManagerOptions,
  type AccountView,
  type AccountRotatedEvent,
  type AccountAuthErrorEvent,
  type AccountsExhaustedEvent,
  type AccountImportOutcome,
  type DiscoveredAccountDir,
} from "./account-manager.js";
export {
  createAccountVerifier,
  ACCOUNT_VERIFY_TIMEOUT_MS,
  type AccountVerifier,
  type AccountVerifyResult,
} from "./account-verify.js";
export { FallbackControl, fallbackNotice, type FallbackEpisode } from "./fallback-control.js";
export {
  createAccountsCommands,
  renderAccountList,
  ACCOUNTS_ROTATION_SETTING,
  FALLBACK_ENABLED_SETTING,
  FALLBACK_MODELS_SETTING,
  AccountsBooleanSetting,
  FallbackModelsSetting,
  type AccountsCommandDeps,
} from "./commands.js";
export { createAccountsInternalApi, type AccountsInternalApiDeps, type AccountsAgentToolsMode } from "./internal-api.js";
export {
  ACCOUNTS_MCP_NOTE,
  rotationNotice as accountsRotationNotice,
  exhaustedNotice as accountsExhaustedNotice,
  authErrorNotice as accountsAuthErrorNotice,
} from "./notices.js";
export { ACCOUNTS_AGENT_TOOLS_ENV } from "../mcp/tools/accounts-tools.js";
export {
  TurnResilience,
  TurnPlan,
  ACCOUNT_SWITCH_NOTE,
  type AccountLease,
  type AccountAcquireResult,
  type ResilienceAccountSource,
  type ResilienceModelSource,
  type TurnCandidate,
  type TurnAdvance,
} from "../engine/resilience.js";
export {
  resolveFallbackChain,
  sdkFallbackArg,
  parseModelList as parseFallbackModelList,
  isValidModelId,
} from "../engine/model-chain.js";
