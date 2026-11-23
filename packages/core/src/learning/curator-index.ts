// Skill curator (PLAN B.10 seam 5, C.4). Owned by W3-CUR. Every exported
// symbol carries the feature's name (B.10). The kind handlers are registered
// on the learning applier by the daemon feature module; nothing here can
// approve or apply a proposal.
export {
  CURATOR_ARCHIVE_DIR,
  CURATOR_ARCHIVE_MANIFEST,
  curatorArchiveRoot,
  listArchivedSkills,
  moveSkillDir,
  readSkillApprovedCopy,
  registerCuratorKindHandlers,
  restoreArchivedSkill,
  saveSkillApprovedCopy,
  skillApprovedCopyPath,
} from "./curator-apply.js";
export type { ArchivedSkillEntry, CuratorApplyDeps, CuratorArchiveManifest, CuratorFs, RestoreOutcome } from "./curator-apply.js";
export {
  CURATOR_CHECK_TICKS,
  CURATOR_ENABLED_SETTING,
  CURATOR_INVENTORY_INITIALIZED_KEY,
  CURATOR_LAST_RUN_KEY,
  CuratorRunStore,
  CuratorScheduler,
  curatorLocalHour,
} from "./curator-scheduler.js";
export type {
  CuratorCategory,
  CuratorCheckResult,
  CuratorFinding,
  CuratorProposalRef,
  CuratorReport,
  CuratorRunRecord,
  CuratorSchedulerDeps,
  CuratorTrigger,
} from "./curator-scheduler.js";
export { createCuratorCommands, renderCuratorRunSummary } from "./curator-commands.js";
export type { CuratorCommandDeps, CuratorCommandRunResult } from "./curator-commands.js";
