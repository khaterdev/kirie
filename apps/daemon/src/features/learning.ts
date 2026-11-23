import { join } from "node:path";
import { homedir } from "node:os";
import {
  createLearningSystem,
  effectiveSettingFlag,
  isWithinActiveHours,
  LEARNING_ENABLED_SETTING,
  LEARNING_TOOLS_ENV,
  MemoryStore,
  PROPOSAL_ACTION_NS,
  type HeartbeatTickEvent,
  type LearningMemoryTarget,
  type LearningSystem,
  type MemoryManagerLike,
} from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

/**
 * Self-learning proposals (item 3) (PLAN B.10, C.3). Owned by W2-LEARN.
 *
 * Always on (they only record and file): the proposals store, `/proposals`,
 * `/learn`, the `prop` card buttons, the turn log with skill usage counting,
 * and the skill write guard (`learning.skillWriteGuard`, default `enforce`).
 * Off by default: post-turn reflection (`learning.enabled`, runtime override
 * via `/learn on`). Nothing self-initiated is written without the owner's
 * approval; the applier is reachable only from the owner command and button
 * handlers, never from an MCP tool or an HTTP route.
 */

const systems = new WeakMap<DaemonContext, LearningSystem>();

/**
 * The learning system of a running daemon, for wave-3 features (curator, user
 * model) that register proposal kinds on `applier` or use `skillState`,
 * `store`, `intake`, `notifier`. Null before setup or after stop. Feature order
 * (B.10) runs learning before curator and usermodel.
 */
export function getLearningSystem(ctx: DaemonContext): LearningSystem | null {
  return systems.get(ctx) ?? null;
}

/** Ticks are 10 s apart: reflection idle check and digest once a minute, expiry hourly. */
const MINUTE_TICKS = 6;
const HOUR_TICKS = 360;

type MemoryManagerWithDelete = MemoryManagerLike & { delete?(key: string): boolean; list?(tag?: string, limit?: number): Array<{ key: string }> };

/** The memory system as the proposal kinds see it: the live manager (keeps embeddings in step), else memory.db directly. */
export function createLearningMemoryTarget(dataDir: string, manager: MemoryManagerLike | null): {
  target: LearningMemoryTarget;
  keys: () => string[];
  close: () => void;
} {
  let fallback: MemoryStore | null = null;
  const store = (): MemoryStore => (fallback ??= new MemoryStore(join(dataDir, "memory.db")));
  const mm = manager as MemoryManagerWithDelete | null;
  return {
    target: {
      recall: (key) => {
        const e = mm ? mm.recall(key) : store().recall(key);
        return e ? { content: e.content, tags: e.tags } : null;
      },
      store: async (key, content, tags) => {
        if (mm) await mm.store(key, content, tags);
        else store().store(key, content, tags);
      },
      delete: (key) => (mm?.delete ? mm.delete(key) : store().delete(key)),
    },
    keys: () => {
      try {
        const entries = mm?.list ? mm.list(undefined, 400) : store().list(undefined, 400);
        return entries.map((e) => e.key);
      } catch {
        return [];
      }
    },
    close: () => fallback?.close(),
  };
}

export const setupLearning: FeatureSetup = (ctx) => {
  const cfg = ctx.config.learning;
  const memory = createLearningMemoryTarget(ctx.dataDir, ctx.memoryManager);
  const enabled = (): boolean => effectiveSettingFlag(ctx.settings, LEARNING_ENABLED_SETTING, cfg.enabled);

  const system = createLearningSystem({
    dataDir: ctx.dataDir,
    agentCwd: ctx.agentCwd,
    userSkillsRoot: join(homedir(), ".claude", "skills"),
    homeDir: homedir(),
    config: () => cfg,
    enabled,
    configEnabled: () => cfg.enabled,
    model: () => cfg.model ?? ctx.config.proactive.tier2Model,
    isActiveHours: () => isWithinActiveHours(ctx.config.proactive.activeHours),
    owners: ctx.owners,
    prompts: ctx.ownerPrompts,
    settings: ctx.settings,
    audit: ctx.audit,
    turns: ctx.turnContext,
    sdkOptions: ctx.sdkOptions,
    memory: memory.target,
    history: { recent: (key, limit) => ctx.chatHistoryStore.recent(key, limit) },
    memoryKeys: memory.keys,
  });
  systems.set(ctx, system);

  ctx.sdkOptions.registerGate(system.guard);
  ctx.sdkOptions.registerStreamObserver("learning", system.streamObserver);
  const unsubscribeTurns = ctx.pipeline.onTurnComplete(system.onTurnComplete);
  ctx.ownerPrompts.onAction(PROPOSAL_ACTION_NS, system.actionHandler);
  ctx.commands.registerAll(system.commands);
  // learning.memoryPolicy "propose" is applied by the prompt builder (lifecycle passes it in PromptConfig).
  // The stdio subprocess's learning_propose reads these (no secrets in either).
  ctx.kirieToolsEnv[LEARNING_TOOLS_ENV.config] = JSON.stringify(cfg);
  ctx.kirieToolsEnv[LEARNING_TOOLS_ENV.skillsRoot] = system.skillsRoot;

  const onTick = (ev: HeartbeatTickEvent): void => {
    if (ev.tickNumber % HOUR_TICKS === 0) system.applier.expireDue(new Date());
    if (ev.tickNumber % MINUTE_TICKS !== 0) return;
    system.reflection.onTick();
    void system.notifier.maybeSendDigest();
  };

  return {
    name: "learning",
    start() {
      system.applier.expireDue(new Date());
      ctx.heartbeat.on("tick", onTick);
    },
    stop() {
      ctx.heartbeat.off("tick", onTick);
      unsubscribeTurns();
      ctx.sdkOptions.unregisterGate(system.guard.name);
      systems.delete(ctx);
      system.close();
      memory.close();
    },
  };
};
