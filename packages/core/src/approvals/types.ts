/**
 * Approval gate types (PLAN C.9, R2 section 4).
 */

import type { SdkCallContext } from "../engine/sdk-options.js";
import type { ShellUncertainty } from "./shell-parse.js";

export type ApprovalMode = "yolo" | "ask";
export type ApprovalAskScope = "dangerous" | "all";
export type ApprovalDecision = "allow" | "ask" | "deny";
export type ApprovalInlineCodePolicy = "ask" | "heuristic" | "allow";

/**
 * hardline: deny in every mode. deny: an owner deny pattern matched.
 * dangerous / sensitive: ask in `ask` mode, allow (and audit) in `yolo`.
 */
export type ApprovalFindingSeverity = "hardline" | "deny" | "dangerous" | "sensitive";

export interface ApprovalFinding {
  ruleId: string;
  severity: ApprovalFindingSeverity;
  reason: string;
  /** The simple command (or tool input) that matched, for the card and `/approvals test`. */
  segment?: string;
}

/** One tool call as the gate sees it. */
export interface ApprovalToolCall {
  /** "Bash", "Write", "mcp__kirie-tools__send_message", ... */
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  ctx: SdkCallContext;
  agentId?: string;
  agentType?: string;
}

export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  /** Mode the call was judged in (webhook work is always judged as `ask`). */
  mode: ApprovalMode;
  scope: ApprovalAskScope;
  findings: ApprovalFinding[];
  /** Uncertainties that count (after `approvals.inlineCode`). */
  uncertain: ShellUncertainty[];
  /** Every segment matched an owner allow pattern. */
  allowlisted: boolean;
  /** One line for the owner and the hook's decision reason. */
  summary: string;
  /** What the model sees when the call is denied by this evaluation. */
  messageForAgent: string;
  /** sha256 of the tool name and its canonical input. */
  hash: string;
  /** The evaluator failed and the failure policy decided. */
  engineError?: boolean;
}

/** What the engine knows about the sandbox (W3-SBX sets it with `setSandboxInfo`). */
export interface ApprovalSandboxInfo {
  mode: "off" | "native" | "docker";
  /** Docker network; "none" means no network at all. */
  network?: "none" | "bridge";
}

/** The effective approval settings (config plus runtime overrides). */
export interface ApprovalPolicy {
  enabled: boolean;
  mode: ApprovalMode;
  askScope: ApprovalAskScope;
  hardline: boolean;
  allow: readonly string[];
  deny: readonly string[];
  inlineCode: ApprovalInlineCodePolicy;
  mcpAsk: readonly string[];
  protectedWritePaths: readonly string[];
  protectedReadPaths: readonly string[];
  disabledRules: readonly string[];
  timeoutSeconds: number;
  unattended: "ask" | "deny";
  maxPending: number;
  redenyWindowSeconds: number;
  maxDenialsPerTurn: number;
}
