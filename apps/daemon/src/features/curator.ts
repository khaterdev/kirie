import { createRequire } from "node:module";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CURATOR_ENABLED_SETTING,
  CURATOR_LAST_RUN_KEY,
  CuratorRunStore,
  CuratorScheduler,
  createCuratorCommands,
  createModuleLogger,
  curatorArchiveRoot,
  effectiveSettingFlag,
  listArchivedSkills,
  registerCuratorKindHandlers,
  renderCuratorRunSummary,
  restoreArchivedSkill,
  runOneShot,
  type CuratorApplyDeps,
  type CuratorReport,
  type TurnCompleteEvent,
} from "@kirie/core";
import { SkillCurator, scanSkillDirectory, type CuratorMergeRunner, type SkillDefinition } from "@kirie/skills";
import { getLearningSystem } from "./learning.js";
import type { DaemonContext, FeatureSetup } from "./types.js";

/**
 * Skill curator (item 4) (PLAN B.10, C.4). Owned by W3-CUR.
 *
 * Always available: `/curator` (status, run on demand, list, restore, pin,
 * usage), the boot inventory sync and the four proposal kinds
 * (`skill.archive|merge|adopt|revert`) on the learning applier. Off by
 * default: the weekly automatic run (`curator.enabled`, runtime override via
 * `/curator on`), driven by the heartbeat tick, never by a `schedules` row.
 *
 * The curator only proposes. Every change goes through the learning
 * proposals store and is applied only after the owner approves it with
 * `/proposals` or a card button. No MCP tool and no HTTP route can run,
 * approve, archive or restore anything.
 */

const log = createModuleLogger("curator-feature");

const require = createRequire(import.meta.url);

/** The repo `skills/` directory the boot sync reads (same resolution as lifecycle.ts). */
export function defaultBundledSkillsDir(): string | null {
  try {
    return resolve(join(dirname(require.resolve("@kirie/core")), "../../../skills"));
  } catch {
    return null;
  }
}

export interface CuratorFeatureOptions {
  /** Repo skills dir; default `defaultBundledSkillsDir()` */
  bundledDir?: string | null;
  /** Default `~/.claude/skills` (read only when curator.includeUserSkills is on) */
  userSkillsRoot?: string;
  /** Test seam for the no-tools merge call */
  llm?: CuratorMergeRunner | null;
  now?: () => Date;
}

/** Lines of the scheduled-run notice (the digest takes one line each). */
function digestLine(report: CuratorReport): string {
  const c = report.counts;
  const filed = report.proposals.length > 0 ? ` Filed ${report.proposals.length} proposal${report.proposals.length === 1 ? "" : "s"}; nothing changes until you approve.` : "";
  return `Weekly skill check: ${c.broken} broken, ${c.duplicates} duplicate, ${c.stale} stale, ${c.drift} changed outside approval.${filed} Details: /curator list`;
}

/** Skill names from `guard.direct_write` audit records (owner-turn file-tool writes the guard allowed). */
function directWritesFrom(ctx: DaemonContext, sinceMs: number): Array<{ skill: string; atMs: number }> {
  const out: Array<{ skill: string; atMs: number }> = [];
  for (const rec of ctx.audit.recent({ feature: "learning", action: "guard.direct_write", sinceMs, limit: 500 })) {
    const target = rec.detail?.target;
    const m = typeof target === "string" ? /^skill:([a-z0-9][a-z0-9-]{0,63})\//.exec(target) : null;
    const atMs = Date.parse(rec.ts);
    if (m && Number.isFinite(atMs)) out.push({ skill: m[1]!, atMs });
  }
  return out;
}

export function createCuratorSetup(opts: CuratorFeatureOptions = {}): FeatureSetup {
  return (ctx) => {
    const system = getLearningSystem(ctx);
    if (!system) {
      log.warn("learning system unavailable; the skill curator is disabled");
      return { name: "curator" };
    }
    const cfg = ctx.config.curator;
    const enabled = (): boolean => effectiveSettingFlag(ctx.settings, CURATOR_ENABLED_SETTING, cfg.enabled);
    const archiveRoot = curatorArchiveRoot(ctx.dataDir);
    const userSkillsRoot = opts.userSkillsRoot ?? join(homedir(), ".claude", "skills");
    const applyDeps: CuratorApplyDeps = {
      skillsRoot: system.skillsRoot,
      archiveRoot,
      skillState: system.skillState,
      db: system.db,
      audit: ctx.audit,
      // ~/.claude/skills belongs to the owner's interactive Claude Code: never changed, whatever path leads there.
      forbiddenRoots: [userSkillsRoot],
      ...(opts.now ? { now: opts.now } : {}),
    };
    registerCuratorKindHandlers(system.applier, applyDeps);
    const runs = new CuratorRunStore(system.db);

    const bundledDir = opts.bundledDir === undefined ? defaultBundledSkillsDir() : opts.bundledDir;
    let bundledCache: SkillDefinition[] | null = null;
    const bundled = (): SkillDefinition[] => (bundledCache ??= bundledDir && existsSync(bundledDir) ? scanSkillDirectory(bundledDir, "bundled") : []);

    const model = cfg.model ?? ctx.config.proactive.tier2Model;
    const llm: CuratorMergeRunner | null = opts.llm !== undefined
      ? opts.llm
      : async ({ system: sys, prompt, schema }) => {
        const res = await runOneShot({
          kind: "oneshot",
          model,
          system: sys,
          prompt,
          schema,
          parse: (v) => v,
          maxBudgetUsd: 0.5,
          timeoutMs: 120_000,
          label: "curator merge",
          sdkOptions: ctx.sdkOptions,
          cwd: join(ctx.dataDir, "tmp", "oneshot"),
        });
        return { value: res.value, costUsd: res.costUsd };
      };
    // Embeddings only from the local model: skill text is never sent to a remote embedder.
    const embedder = ctx.config.memory.embeddings.provider === "local" ? ctx.embeddingProvider : null;

    const curator = new SkillCurator({
      skillState: system.skillState,
      kv: system.kv,
      store: system.store,
      intake: system.intake,
      runs,
      skillsRoot: system.skillsRoot,
      userSkillsRoot,
      archiveRoot,
      bundled,
      config: () => cfg,
      protectedSkills: () => ctx.config.agents.flatMap((a) => a.skills ?? []),
      scheduleTexts: () => ctx.scheduleStore.list().map((s) => s.message),
      directWrites: (sinceMs) => directWritesFrom(ctx, sinceMs),
      embedder,
      llm,
      audit: ctx.audit,
      ...(opts.now ? { now: opts.now } : {}),
    });

    let lastTurnAt: number | null = null;
    const unsubscribeTurns = ctx.pipeline.onTurnComplete((ev: TurnCompleteEvent) => {
      lastTurnAt = Math.max(lastTurnAt ?? 0, ev.endedAt);
    });

    const runAndNotify = async (trigger: "schedule" | "command", merge: boolean) => {
      const res = await curator.run({ trigger, merge });
      if (res.status === "ok") {
        if (trigger === "schedule" && res.hasNews) system.notifier.queueLine(digestLine(res.report));
        // Cards for new proposals go out with the learning digest (owner DM, active hours).
        if (res.report.proposals.length > 0 || (trigger === "schedule" && res.hasNews)) void system.notifier.maybeSendDigest({ force: true });
      }
      return res;
    };

    const scheduler = new CuratorScheduler({
      kv: system.kv,
      enabled,
      config: () => cfg,
      timeZone: () => ctx.config.proactive.activeHours.timezone,
      lastActivityAt: () => lastTurnAt,
      isRunning: () => curator.isRunning(),
      run: () => runAndNotify("schedule", false),
      ...(opts.now ? { now: opts.now } : {}),
    });

    ctx.commands.registerAll(createCuratorCommands({
      skillState: system.skillState,
      runs,
      kv: system.kv,
      settings: ctx.settings,
      audit: ctx.audit,
      enabled,
      configEnabled: () => cfg.enabled,
      config: () => cfg,
      run: async ({ merge }) => {
        const res = await runAndNotify("command", merge);
        return res.status === "ok" ? { status: "ok", runId: res.runId, report: res.report } : res;
      },
      restore: (name, actor) => restoreArchivedSkill(applyDeps, name, actor),
      archived: () => listArchivedSkills(archiveRoot),
      skillExists: (name) => {
        try {
          return lstatSync(join(system.skillsRoot, name)).isDirectory();
        } catch {
          return false;
        }
      },
      nextRunAt: () => scheduler.nextEligibleAt(),
      pendingCount: () => system.store.list({ status: "pending", limit: 1000 }).filter((p) => p.origin === "curator").length,
      llmAvailable: () => llm !== null,
      resetSchedule: () => system.kv.delete(CURATOR_LAST_RUN_KEY),
    }));

    return {
      name: "curator",
      start() {
        try {
          const inv = curator.syncInventory();
          if (inv.inserted.length > 0 || inv.vanished.length > 0) {
            log.info({ inserted: inv.inserted.length, vanished: inv.vanished.length, initial: inv.initial }, "skill inventory synced");
          }
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err) }, "skill inventory sync failed");
        }
        ctx.heartbeat.on("tick", scheduler.onTick);
      },
      stop() {
        ctx.heartbeat.off("tick", scheduler.onTick);
        unsubscribeTurns();
      },
    };
  };
}

export const setupCurator: FeatureSetup = createCuratorSetup();

export { renderCuratorRunSummary };
