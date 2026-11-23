// Computer use (PLAN B.10 seam 5, C.13). Owned by W3-CU.
// Every exported symbol carries the feature's name (B.10).
export {
  COMPUTER_USE_SERVER_NAME,
  COMPUTER_USE_ALT_SERVER_NAME,
  COMPUTER_USE_SERVER_NAMES,
  COMPUTER_USE_MCP_PREFIX,
  COMPUTER_USE_ALT_MCP_PREFIX,
  COMPUTER_USE_OBSERVE_TOOLS,
  COMPUTER_USE_CAPTURE_TOOLS,
  COMPUTER_USE_ACT_TOOLS,
  COMPUTER_USE_BLOCKED_TOOLS,
  COMPUTER_USE_TYPING_TOOLS,
  COMPUTER_USE_NO_TYPING_EXTRA_TOOLS,
  COMPUTER_USE_WINDOW_OBSERVE_TOOLS,
  classifyComputerUseTool,
  computerUseKnownToolNames,
  computerUseBareToolName,
  isComputerUseToolName,
  type ComputerUseToolClass,
} from "./tools.js";
export {
  decideComputerUse,
  computerUseInputPids,
  computerUseInputKeys,
  computerUseTypedChars,
  computerUseGrantKey,
  computerUseAppInScope,
  computerUseBundleIdFor,
  normalizeComputerUseHotkey,
  blockedComputerUseHotkey,
  COMPUTER_USE_KNOWN_APPS,
  COMPUTER_USE_OFF_REASON,
  COMPUTER_USE_NOT_OWNER_REASON,
  type ComputerUseAppInfo,
  type ComputerUseArmState,
  type ComputerUsePolicyContext,
  type ComputerUseDecision,
} from "./policy.js";
export { ComputerUseArming, clampComputerUseMinutes, type ComputerUseArmingDeps, type ComputerUseDisarmReason } from "./arming.js";
export {
  probeComputerUseDriver,
  stopComputerUseDriver,
  createComputerUseAppResolver,
  parseComputerUsePermissions,
  assertReadOnlyComputerUseDriverArgs,
  expandComputerUsePath,
  defaultComputerUseExec,
  defaultComputerUseIsExecutable,
  COMPUTER_USE_DRIVER_BUNDLE_ID,
  COMPUTER_USE_SETUP_DOC,
  type ComputerUseExecFn,
  type ComputerUseExecResult,
  type ComputerUseDriverDeps,
  type ComputerUseDriverStatus,
} from "./driver.js";
export {
  applyComputerUseSessionOptions,
  computerUseServerConfig,
  computerUseHiddenToolNames,
  computerUseOfferedToolNames,
  isComputerUseDriverServer,
  isComputerUseReservedServerName,
  removeComputerUseServers,
  COMPUTER_USE_DRIVER_ENV,
} from "./mcp-config.js";
export {
  ComputerUseService,
  type ComputerUseServiceDeps,
  type ComputerUseStatusSnapshot,
  type ComputerUseArmResult,
  type ComputerUseAuditSink,
  type ComputerUseApprovalPrompts,
} from "./service.js";
export {
  createComputerUseGate,
  checkComputerUseBash,
  COMPUTER_USE_GATE_NAME,
  COMPUTER_USE_GATE_ORDER,
  COMPUTER_USE_GATE_MATCHER,
} from "./gate.js";
export { createComputerUseCommands, COMPUTER_USE_LIMITS_TEXT, type ComputerUseCommandDeps } from "./commands.js";
export { createComputerUseStatusApp, type ComputerUseStatusSource } from "./status-api.js";
export { COMPUTER_USE_PROMPT_ADDENDUM, computerUsePromptAddendum } from "./prompt.js";
