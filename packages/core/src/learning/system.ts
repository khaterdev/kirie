/**
 * `createLearningSystem`: builds the learning pieces from their dependencies
 * (PLAN C.3). The daemon feature module (`apps/daemon/src/features/learning.ts`)
 * calls it once per start and registers what it returns: the skill write
 * guard gate, the stream observer, the turn listener, the `prop` button
 * handler and the `/learn`, `/proposals` commands.
 *
 * `applier` is returned to the daemon so wave-3 workstreams (curator, user
 * model) can call `registerKind`. It is never handed to an MCP tool factory or
 * an `InternalApi` route.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelName } from "../channels/normalizer.js";
import type { CommandDefinition } from "../commands/types.js";
import type { LearningConfig } from "../config/sections/learning.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { SdkOptionsPipeline, SdkStreamObserver, ToolGate } from "../engine/sdk-options.js";
import type { TurnContextRegistry } from "../engine/turn-context.js";
import type { OwnerPrompts } from "../interaction/owner-prompts.js";
import type { OwnerActionHandler } from "../interaction/router.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { TurnCompleteEvent } from "../routing/pipeline.js";
import { ProposalApplier } from "./applier.js";
import { createLearningCommands } from "./commands.js";
import { LearningIntake, parseSkillFrontmatter } from "./intake.js";
import { registerLearningKindHandlers, type LearningMemoryTarget } from "./kind-handlers.js";
import { LearningKv, USAGE_TRACKING_STARTED_KEY, learningDbPath, openLearningDb, type LearningDb } from "./learning-db.js";
import { ProposalNotifier, createProposalActionHandler } from "./notifier.js";
import { ProposalStore } from "./proposal-store.js";
import { ReflectionEngine, type OneShotRunner, type ReflectionHistoryEntry } from "./reflection.js";
import { createSkillWriteGuard } from "./skill-guard.js";
import { SkillStateStore } from "./skill-state-store.js";
import { LearningTurnTracker, TurnRecorder } from "./turn-recorder.js";

export interface LearningSystemDeps {
  /** ~/.kirie */
  dataDir: string;
  /** config.agent.workspace || dataDir */
  agentCwd: string;
  /** ~/.claude/skills (report-only root; usage counting only) */
  userSkillsRoot?: string;
  /** Default `<dataDir>/learning.db` */
  dbPath?: string;
  /** Live learning config */
  config: () => LearningConfig;
  /** Effective learning.enabled */
  enabled: () => boolean;
  configEnabled: () => boolean;
  /** Reflection model: learning.model ?? proactive.tier2Model */
  model: () => string;
  isActiveHours: () => boolean;
  owners: { isOwner(channel: ChannelName, senderId: string): boolean };
  prompts: Pick<OwnerPrompts, "sendCard">;
  settings: Pick<RuntimeSettings, "set" | "delete">;
  audit: Pick<AuditTrail, "record" | "recent">;
  turns: TurnContextRegistry;
  sdkOptions?: SdkOptionsPipeline;
  memory: LearningMemoryTarget | null;
  history: { recent(sessionKey: string, limit: number): ReflectionHistoryEntry[] };
  memoryKeys: () => string[];
  /** Test seam for the no-tools model call */
  runner?: OneShotRunner;
  now?: () => Date;
}

export interface LearningSystem {
  readonly db: LearningDb;
  readonly kv: LearningKv;
  readonly store: ProposalStore;
  readonly intake: LearningIntake;
  readonly applier: ProposalApplier;
  readonly skillState: SkillStateStore;
  readonly recorder: TurnRecorder;
  readonly tracker: LearningTurnTracker;
  readonly reflection: ReflectionEngine;
  readonly notifier: ProposalNotifier;
  readonly guard: ToolGate;
  readonly streamObserver: SdkStreamObserver;
  readonly onTurnComplete: (ev: TurnCompleteEvent) => void;
  readonly actionHandler: OwnerActionHandler;
  readonly commands: CommandDefinition[];
  /** `<agentCwd>/.claude/skills` */
  readonly skillsRoot: string;
  close(): void;
}

export function learningSkillsRoot(agentCwd: string): string {
  return join(agentCwd, ".claude", "skills");
}

function listSkills(root: string): Array<{ name: string; description: string }> {
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "SKILL.md");
    try {
      const fm = existsSync(file) ? parseSkillFrontmatter(readFileSync(file, "utf8")) : null;
      out.push({ name: entry.name, description: fm?.description ?? "" });
    } catch {
      out.push({ name: entry.name, description: "" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function createLearningSystem(deps: LearningSystemDeps): LearningSystem {
  const db = openLearningDb(deps.dbPath ?? learningDbPath(deps.dataDir));
  const kv = new LearningKv(db);
  kv.setIfAbsent(USAGE_TRACKING_STARTED_KEY, (deps.now?.() ?? new Date()).toISOString());
  const store = new ProposalStore(db);
  for (const id of store.recoverInterrupted()) {
    deps.audit.record({ feature: "learning", action: "proposal.apply_interrupted", actor: "system", detail: { id } });
  }
  const skillState = new SkillStateStore(db);
  const skillsRoot = learningSkillsRoot(deps.agentCwd);
  const memoryMdPath = join(deps.dataDir, "MEMORY.md");

  const intake = new LearningIntake({
    store,
    config: deps.config,
    audit: deps.audit,
    skillsRoot,
    skillState,
    memoryRecall: (key) => deps.memory?.recall(key) ?? null,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const applier = new ProposalApplier({
    store,
    backupRoot: join(deps.dataDir, "backups", "learning"),
    audit: deps.audit,
    config: deps.config,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerLearningKindHandlers(applier, {
    memory: deps.memory,
    memoryMdPath,
    memoryMdMaxBytes: () => deps.config().memoryMdMaxBytes,
    skillsRoot,
    skillState,
    ...(deps.now ? { now: deps.now } : {}),
  });

  // The reflection engine is created after the recorder; the recorder calls it through this slot.
  let reflection: ReflectionEngine | null = null;
  const recorder = new TurnRecorder({
    db,
    store,
    skillState,
    untrustedTools: () => deps.config().untrustedTools,
    allowUntrustedSkillProposals: () => deps.config().allowUntrustedSkillProposals,
    skillRoots: { project: skillsRoot, ...(deps.userSkillsRoot ? { user: deps.userSkillsRoot } : {}) },
    audit: deps.audit,
    onRecorded: (turn) => reflection?.onTurnRecorded(turn),
  });
  const skillRoots = [skillsRoot, ...(deps.userSkillsRoot ? [deps.userSkillsRoot] : [])];
  const tracker = new LearningTurnTracker({ recorder, turns: deps.turns, skillRoots: () => skillRoots });

  reflection = new ReflectionEngine({
    config: deps.config,
    enabled: deps.enabled,
    model: deps.model,
    kv,
    store,
    intake,
    recorder,
    history: deps.history,
    context: {
      skills: () => listSkills(skillsRoot),
      memoryKeys: deps.memoryKeys,
      memoryMdHeadings: () => (readText(memoryMdPath) ?? "").split("\n").filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, "").trim()),
      readSkill: (name) => (/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? readText(join(skillsRoot, name, "SKILL.md")) : null),
    },
    cwd: join(deps.dataDir, "tmp", "oneshot"),
    ...(deps.sdkOptions ? { sdkOptions: deps.sdkOptions } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
    audit: deps.audit,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const notifier = new ProposalNotifier({
    store,
    prompts: deps.prompts,
    preview: (rec) => applier.preview(rec),
    config: deps.config,
    isActiveHours: deps.isActiveHours,
    kv,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const guard = createSkillWriteGuard({
    skillsRoot,
    dataDir: deps.dataDir,
    turns: deps.turns,
    mode: () => deps.config().skillWriteGuard,
    audit: deps.audit,
  });

  const actionHandler = createProposalActionHandler({ store, applier, owners: deps.owners, audit: deps.audit });
  const commands = createLearningCommands({
    store,
    applier,
    reflection,
    owners: deps.owners,
    settings: deps.settings,
    audit: deps.audit,
    enabled: deps.enabled,
    configEnabled: deps.configEnabled,
    config: deps.config,
  });

  return {
    db, kv, store, intake, applier, skillState, recorder, tracker, reflection, notifier, guard,
    streamObserver: tracker.observe,
    onTurnComplete: tracker.onTurnComplete,
    actionHandler,
    commands,
    skillsRoot,
    close: () => db.close(),
  };
}
