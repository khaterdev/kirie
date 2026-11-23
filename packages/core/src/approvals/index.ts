// Approval gates (PLAN B.10 seam 5, C.9). Owned by W2-APR.
// Every exported symbol carries the feature's name (B.10), except the names the
// plan itself gives (`isDangerousText`, `parseShell`).
export {
  ApprovalEngine,
  evaluateApprovalCall,
  defaultApprovalPolicy,
  approvalCallHash,
  analyzeApprovalShellText,
  isDangerousText,
  isHardlineText,
  approvalSandboxInfoFrom,
  APPROVAL_SETTING_KEYS,
  APPROVAL_SANDBOX_SHELL_TOOL,
  type ApprovalEngineDeps,
  type ApprovalEnvironment,
  type ApprovalTextAnalysis,
} from "./engine.js";
export {
  ApprovalPrompter,
  approvalDeniedMessage,
  renderApprovalDisplay,
  truncateApprovalDisplay,
  approvalCallDisplay,
  APPROVAL_STOP_OPTION,
  APPROVAL_DISPLAY_MAX_CHARS,
  type ApprovalPrompterDeps,
  type ApprovalRequestResult,
} from "./prompter.js";
export { createApprovalsGate, ApprovalStats, APPROVALS_GATE_NAME, APPROVALS_GATE_ORDER, type ApprovalsGateOptions } from "./gate.js";
export { createApprovalsCommands, type ApprovalsCommandDeps } from "./commands.js";
export { createApprovalsStatusApp, type ApprovalsStatusSource } from "./status-api.js";
export {
  APPROVALS_PROTECTED_WRITE_PATHS,
  APPROVALS_PROTECTED_READ_PATHS,
  APPROVALS_SHELL_HISTORY_PATHS,
  normalizeApprovalPath,
  expandApprovalHome,
  expandApprovalPattern,
  compileApprovalPathList,
  approvalPathMatches,
  approvalPathIsAncestorOf,
  isApprovalRootTarget,
  isApprovalSystemPath,
  isApprovalRawDevice,
  type ApprovalPathEnv,
  type ApprovalPathList,
  type NormalizedApprovalPath,
} from "./paths.js";
export { matchApprovalGlob, matchApprovalPathGlob } from "./glob.js";
export {
  parseApprovalPattern,
  isOverBroadAllowPattern,
  APPROVAL_PATTERN_MAX_LENGTH,
  APPROVAL_PATTERN_MAX_COUNT,
  type ApprovalPattern,
} from "./patterns.js";
export { APPROVAL_RULES, APPROVAL_COMMAND_RULES, approvalRuleCatalog, type ApprovalRule, type ApprovalCommandRule } from "./rules.js";
export {
  parseShell,
  countHiddenShellChars,
  isHiddenShellChar,
  SHELL_MAX_CERTAIN_LENGTH,
  type ShellSegment,
  type ShellArg,
  type ShellRedirect,
  type ShellUncertainty,
  type ParsedShell,
  type ParseShellOptions,
} from "./shell-parse.js";
export type {
  ApprovalMode,
  ApprovalAskScope,
  ApprovalDecision,
  ApprovalInlineCodePolicy,
  ApprovalFinding,
  ApprovalFindingSeverity,
  ApprovalToolCall,
  ApprovalEvaluation,
  ApprovalSandboxInfo,
  ApprovalPolicy,
} from "./types.js";
