// Undo file changes (PLAN B.10 seam 5, item 11). Owned by W3-UNDO.
// Every exported symbol carries the feature's name (B.10). No MCP tool, by design.
export {
  UndoCheckpointStore,
  UNDO_DB_FILE,
  UNDO_MAX_PATHS_PER_ROW,
  UNDO_MAX_BASH_SAMPLES,
  type UndoCheckpoint,
  type NewUndoCheckpoint,
  type UndoTurnActivity,
  type UndoTurnSource,
} from "./checkpoint-store.js";
export {
  UndoRecorder,
  UNDO_CONTRIBUTOR_NAME,
  UNDO_CONTRIBUTOR_ORDER,
  UNDO_OBSERVER_NAME,
  UNDO_FILE_TOOLS,
  UNDO_TASK_KINDS,
  undoConfigDirOf,
  undoSourceOf,
  type UndoLiveBinding,
  type UndoRecorderDeps,
} from "./recorder.js";
export {
  UndoService,
  UNDO_REWIND_TIMEOUT_MS,
  UNDO_CLOSE_TIMEOUT_MS,
  UNDO_BUSY_TEXT,
  UNDO_NEEDS_V2_TEXT,
  undoRewindEnv,
  formatUndoTime,
  type UndoScope,
  type UndoPlan,
  type UndoRewindOutcome,
  type UndoPreviewOutcome,
  type UndoApplyOutcome,
  type UndoServiceDeps,
} from "./undo-service.js";
export {
  createUndoCommands,
  renderUndoPreview,
  renderUndoApplied,
  undoPreviewTitle,
  displayUndoPath,
  UNDO_ENABLED_SETTING,
  UNDO_HELP_TEXT,
  type UndoCommandDeps,
} from "./commands.js";
