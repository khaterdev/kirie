// Self-learning: proposals store, turn log, reflection (PLAN B.7, B.10 seam 5).
// Owned by W2-LEARN. The curator (W3-CUR) and user model (W3-UM) export through
// their own files below, so neither edits this one.
//
// ProposalApplier, OwnerApproval and the approval minting function are not part
// of the runtime surface of the package root (PLAN B.7): the applier class is a
// type-only export, and modules inside packages/core/src/learning/ import
// applier.ts directly. The daemon gets the applier instance from
// createLearningSystem().
export * from "./curator-index.js";
export * from "./usermodel/index.js";

export { createLearningSystem, learningSkillsRoot } from "./system.js";
export type { LearningSystem, LearningSystemDeps } from "./system.js";
export type { LearningMemoryTarget, LearningKindHandlerDeps } from "./kind-handlers.js";
export type {
  ApplyFailureCode,
  ApplyOutcome,
  OwnerApproval,
  ProposalApplier,
  ProposalKindHandler,
} from "./applier.js";
export { ProposalApplyError } from "./applier.js";
export { LEARNING_DB_FILE, LearningKv, USAGE_TRACKING_STARTED_KEY, learningDbPath, openLearningDb } from "./learning-db.js";
export type { LearningDb } from "./learning-db.js";
export { ProposalStore } from "./proposal-store.js";
export type { NewProposal, ProposalRecord } from "./proposal-store.js";
export { PROPOSAL_KINDS, proposalPayloadHash } from "./proposal-types.js";
export type { ProposalKind, ProposalOrigin, ProposalStatus, ProposalTrust, RiskFlag } from "./proposal-types.js";
export { LearningIntake } from "./intake.js";
export type { LearningIntakeConfig, ProposalIntake, ProposalSubmission, ProposalSubmitResult } from "./intake.js";
export { SkillStateStore } from "./skill-state-store.js";
export type { SkillLifecycleState, SkillRoot, SkillSource, SkillStateRecord, SkillUsageRecord } from "./skill-state-store.js";
export type { TurnLogRecord } from "./turn-recorder.js";
export { LEARNING_ENABLED_SETTING } from "./commands.js";
export { PROPOSAL_ACTION_NS } from "./notifier.js";
export { SKILL_WRITE_GUARD_NAME, SKILL_WRITE_GUARD_REASON } from "./skill-guard.js";
export type { SkillWriteGuardMode } from "./skill-guard.js";
export { REFLECTION_SYSTEM_PROMPT } from "./reflection.js";
export type { ReflectionRunResult } from "./reflection.js";
export { LEARNING_TOOLS_ENV } from "../mcp/tools/learning-tools.js";
export type { ToolUseSummary, SkillEvent } from "../engine/tool-observer.js";
