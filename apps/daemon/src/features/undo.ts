import { join } from "node:path";
import {
  UndoCheckpointStore,
  UndoRecorder,
  UndoService,
  UNDO_CONTRIBUTOR_NAME,
  UNDO_CONTRIBUTOR_ORDER,
  UNDO_DB_FILE,
  UNDO_ENABLED_SETTING,
  UNDO_OBSERVER_NAME,
  createModuleLogger,
  createUndoCommands,
  effectiveSettingFlag,
  type HeartbeatTickEvent,
  type PromptAddendumContext,
} from "@kirie/core";
import type { FeatureSetup } from "./types.js";

const log = createModuleLogger("feature-undo");

/** Ledger pruning runs at start and then once a day from the heartbeat. */
export const UNDO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Tells the agent that the owner can revert its file edits (owner DM chat only, while undo is on). */
export function renderUndoAddendum(enabled: boolean, p: PromptAddendumContext): string | null {
  if (!enabled || p.kind !== "chat" || !p.ownerDm) return null;
  return [
    "<undo>",
    "The owner can revert the file edits you make with Write, Edit and NotebookEdit in recent turns with /undo. Changes made through Bash (deletes, moves, sed -i, redirects, git, installs) are not covered and cannot be undone that way.",
    "If a system note says the owner ran /undo, your earlier edits to those files no longer exist: re-read a file before editing it again.",
    "</undo>",
  ].join("\n");
}

/**
 * Undo file changes (item 11, PLAN C.11).
 *
 * Setup: opens `~/.kirie/checkpoints.db`, registers the `checkpointing`
 * contributor (40) and the ledger stream observer, the `/undo` command and
 * the `undo` prompt addendum. Start: prunes the ledger, then once a day.
 * Undo ships off (`undo.enabled: false`): with it off no SDK option changes
 * and nothing is recorded. v1 mode (no V2SessionManager) registers only the
 * command, which answers "needs v2".
 */
export const setupUndo: FeatureSetup = (ctx) => {
  const isEnabled = (): boolean => effectiveSettingFlag(ctx.settings, UNDO_ENABLED_SETTING, ctx.config.undo.enabled);
  const audit = (action: string, actor: string, detail?: Record<string, unknown>): void => {
    ctx.audit.record({ feature: "undo", action, actor, ...(detail ? { detail } : {}) });
  };
  const setEnabled = (on: boolean | null, by: string): void => {
    if (on === null) ctx.settings.delete(UNDO_ENABLED_SETTING, by);
    else ctx.settings.set(UNDO_ENABLED_SETTING, on, by);
  };
  const timezone = ctx.config.proactive?.activeHours?.timezone;
  const v2 = ctx.v2Sessions;

  if (!v2) {
    ctx.commands.registerAll(
      createUndoCommands({ service: null, config: () => ctx.config.undo, isEnabled, setEnabled, closeIdleSessions: () => undefined }),
    );
    log.info("undo needs agent.sessionMode v2; only the command is registered");
    return { name: "undo" };
  }

  const store = new UndoCheckpointStore(join(ctx.dataDir, UNDO_DB_FILE));
  const recorder = new UndoRecorder({
    store,
    isEnabled,
    backgroundTasks: () => ctx.config.undo.backgroundTasks,
    chatPreview: (sessionKey) => {
      const turn = ctx.turnContext.get(sessionKey);
      if (!turn) return undefined;
      return turn.textPreview ?? `(${turn.origin.replace("_", " ")})`;
    },
    taskPreview: (taskId) => ctx.backgroundTaskStore.get(taskId)?.description,
  });
  ctx.sdkOptions.registerContributor(UNDO_CONTRIBUTOR_NAME, recorder.contributor, UNDO_CONTRIBUTOR_ORDER);
  ctx.sdkOptions.registerStreamObserver(UNDO_OBSERVER_NAME, recorder.observer);

  const service = new UndoService({
    store,
    recorder,
    config: () => ctx.config.undo,
    isEnabled,
    isChatBusy: (sessionKey) => ctx.pipeline.isBusy(sessionKey) || v2.isBusy(sessionKey),
    v2,
    taskStatus: (taskId) => ctx.backgroundTaskStore.get(taskId)?.status ?? null,
    runningTaskCount: (sessionKey) =>
      ctx.backgroundTaskStore.list(sessionKey, "running").length + ctx.backgroundTaskStore.list(sessionKey, "pending").length,
    currentSdkSessionId: (sessionKey) => ctx.sessionStore.get(sessionKey),
    sdkOptions: ctx.sdkOptions,
    addNextTurnNote: (sessionKey, note) => ctx.pipeline.addNextTurnNote(sessionKey, note),
    appendHistory: (sessionKey, text) => {
      ctx.chatHistoryStore.append(sessionKey, "assistant", text);
    },
    ...(timezone ? { timezone } : {}),
  });

  ctx.commands.registerAll(
    createUndoCommands({
      service,
      config: () => ctx.config.undo,
      isEnabled,
      setEnabled,
      closeIdleSessions: () => {
        v2.closeIdleSessions(0);
      },
      confirm: async (title, body) => {
        const res = await ctx.ownerPrompts.requestApproval({
          kind: "confirm",
          title,
          body,
          timeoutMs: ctx.config.undo.confirmTimeoutSeconds * 1000,
          labels: { approve: "Confirm", deny: "Cancel" },
        });
        return res.outcome === "approved";
      },
      audit,
      ...(timezone ? { timezone } : {}),
    }),
  );

  ctx.promptAddenda.register("undo", (p) => renderUndoAddendum(isEnabled(), p));

  let lastPrune = 0;
  const prune = (now: number): void => {
    lastPrune = now;
    try {
      const cfg = ctx.config.undo;
      const removed = store.prune({ maxPerSession: cfg.maxTurnsPerSession, olderThanMs: now - cfg.retentionDays * 24 * 60 * 60 * 1000 });
      if (removed > 0) log.info({ removed }, "undo ledger pruned");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "undo ledger prune failed");
    }
  };
  const onTick = (event: HeartbeatTickEvent): void => {
    if (event.timestamp - lastPrune >= UNDO_PRUNE_INTERVAL_MS) prune(event.timestamp);
  };

  log.info({ enabled: isEnabled(), rows: store.count() }, "undo feature ready");

  return {
    name: "undo",
    start() {
      prune(Date.now());
      ctx.heartbeat.on("tick", onTick);
    },
    stop() {
      ctx.heartbeat.off("tick", onTick);
      recorder.stop();
      store.close();
    },
  };
};
