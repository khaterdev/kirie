// Skill curator (PLAN C.4, R4 item 4): snapshots, detectors, similarity, runs.
export {
  SkillCurator,
  CURATOR_MERGE_SCHEMA,
  CURATOR_MERGE_SYSTEM_PROMPT,
  buildCuratorMergePrompt,
  buildFixedSkillMd,
  deriveSkillDescription,
  parseCuratorMergeAdvice,
} from "./curator.js";
export type { CuratorMergeAdvice, CuratorMergeRunner, CuratorRunResult, InventoryResult, SkillCuratorDeps } from "./curator.js";
export {
  detectBroken,
  detectDrift,
  detectDuplicates,
  detectStale,
  mentionsSkill,
  missingRequirements,
  referencedFiles,
} from "./detectors.js";
export type {
  DetectorEnv,
  DriftCandidate,
  DriftOptions,
  DriftResult,
  DuplicateOptions,
  DuplicateResult,
  DuplicateVectors,
  ExactDuplicate,
  StaleCandidate,
  StaleOptions,
  StaleResult,
} from "./detectors.js";
export { clusterPairs, jaccard, nameTokens, termCosine, vectorCosine, wordTokens } from "./similarity.js";
export type { ScoredPair } from "./similarity.js";
export { frontmatterDescription, frontmatterName, listSkillDirNames, sha256Text, snapshotSkill } from "./snapshot.js";
export type { CuratorSkillRoot, CuratorSkillSource, SkillMdStatus, SkillSnapshot, SnapshotOptions } from "./snapshot.js";
export { curatorReportHasNews, finalizeCuratorReport, newCuratorReport } from "./report.js";
