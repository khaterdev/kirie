// User model (PLAN B.10 seam 5, C.5). Owned by W3-UM. Every exported symbol
// carries the feature's name (B.10).
export {
  USER_FACT_CATEGORIES,
  USER_FACT_CARD_MIN_CONFIDENCE,
  USER_FACT_MAX_STATEMENT_CHARS,
  UserFactStore,
  normalizeUserFactStatement,
  userFactStatementHash,
  userFactFtsQuery,
  userModelCosine,
  isUserFactCategory,
  type UserFact,
  type UserFactCategory,
  type UserFactEvidenceRef,
  type UserFactKind,
  type UserFactStatus,
  type UserFactSearchOptions,
  type UserFactSearchResult,
} from "./fact-store.js";
export {
  USER_MODEL_SENSITIVE_CATEGORIES,
  USER_MODEL_ALWAYS_EXCLUDED,
  detectUserModelSensitive,
  isUserModelSensitive,
  userModelExcludedCategories,
  type UserModelSensitiveCategory,
} from "./sensitive.js";
export { USER_MODEL_CONFIDENCE, checkUserFactStatement, type UserFactCheckResult } from "./checks.js";
export {
  USER_MODEL_CARD_FILE,
  USER_MODEL_ADDENDUM_OPEN,
  renderUserModelCard,
  renderUserModelAddendum,
  userModelCardPath,
  writeUserModelCard,
} from "./card.js";
export {
  selectUserModelEmbedder,
  type UserModelEmbedderChoice,
  type UserModelEmbedderSource,
} from "./embedder.js";
export {
  USER_MODEL_SYNTHETIC_SENDER_NAMES,
  classifyUserModelRow,
  openUserModelHistorySource,
  type UserModelHistorySource,
  type UserModelHistoryRow,
} from "./source.js";
export {
  USER_MODEL_SYSTEM_PROMPT,
  UserModelDeriver,
  type UserModelRunResult,
} from "./deriver.js";
export { consolidateUserModel, type UserModelConsolidation } from "./consolidate.js";
export { USER_FACT_PROPOSAL_KIND, createUserFactApplyHandler } from "./apply.js";
export { USER_MODEL_ENABLED_SETTING, USER_MODEL_INJECT_SETTING, createUserModelCommands } from "./commands.js";
export { USER_MODEL_CHECK_TICKS, createUserModelSystem, type UserModelSystem, type UserModelSystemDeps } from "./system.js";
export { USER_MODEL_QUERY_TOOL, USER_MODEL_TOOLS_ENV } from "../../mcp/tools/usermodel-tools.js";
export { retireUserFactProposals } from "./proposals.js";
