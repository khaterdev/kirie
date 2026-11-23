import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandReply, DispatchOutcome } from "../commands/types.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { CuratorConfigSchema } from "../config/sections/curator.js";
import { effectiveSettingFlag } from "../config/sections/effective.js";
import { createCuratorCommands, renderCuratorRunSummary, type CuratorCommandRunResult } from "./curator-commands.js";
import { curatorArchiveRoot, listArchivedSkills, restoreArchivedSkill, type CuratorApplyDeps } from "./curator-apply.js";
import { CURATOR_ENABLED_SETTING, CuratorRunStore, type CuratorReport } from "./curator-scheduler.js";
import { LearningKv } from "./learning-db.js";
import { SkillStateStore } from "./skill-state-store.js";
import { OWNER_ID, STRANGER_ID, fakeAudit, skillMd, tempLearningEnv, type FakeAudit, type TempLearningEnv } from "./learning.test-util.js";

const BOOL = z.boolean();

let env: TempLearningEnv;
let registry: CommandRegistry;
let settings: RuntimeSettings;
let audit: FakeAudit;
let skillState: SkillStateStore;
let runs: CuratorRunStore;
let skillsRoot: string;
let applyDeps: CuratorApplyDeps;
let runImpl: ReturnType<typeof vi.fn>;
let resetSchedule: ReturnType<typeof vi.fn>;
let sent: CommandReply[];

function report(over: Partial<CuratorReport> = {}): CuratorReport {
  return {
    version: 1, trigger: "command", startedAt: "2026-11-23T10:00:00.000Z", finishedAt: "2026-11-23T10:00:02.000Z", merge: false,
    counts: { skills: 3, broken: 1, duplicates: 2, stale: 1, drift: 0, proposals: 1 },
    findings: [
      { skill: "remotion", root: "project", detector: "B2", category: "broken", severity: "error", message: "No valid frontmatter (no frontmatter block); the skill may not load." },
      { skill: "deploy-a", root: "project", detector: "D3", category: "duplicate", severity: "info", message: "Possible duplicate of \"deploy-b\"." },
    ],
    proposals: [{ id: 7, kind: "skill.fix", skill: "remotion", title: "Fix skill remotion: add valid frontmatter" }],
    dropped: [], staleMarked: ["old-tool"], possibleDuplicates: [["deploy-a", "deploy-b"]],
    llm: { calls: 0, costUsd: 0, errors: 0 }, errors: [],
    ...over,
  };
}

beforeEach(() => {
  env = tempLearningEnv("kirie-curator-cmd-");
  sent = [];
  audit = fakeAudit();
  skillsRoot = join(env.dir, ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  settings = new RuntimeSettings(join(env.dir, "state", "runtime-settings.json"));
  skillState = new SkillStateStore(env.db);
  runs = new CuratorRunStore(env.db);
  applyDeps = { skillsRoot, archiveRoot: curatorArchiveRoot(env.dir), skillState, db: env.db, audit };
  const cfg = CuratorConfigSchema.parse({});
  resetSchedule = vi.fn();
  runImpl = vi.fn(async (): Promise<CuratorCommandRunResult> => {
    const r = report();
    const id = runs.start("command", r.startedAt);
    runs.finish(id, r);
    return { status: "ok", runId: id, report: r };
  });
  const owners = new OwnerDirectory({ telegram: [OWNER_ID] });
  registry = new CommandRegistry({ owners });
  registry.registerAll(createCuratorCommands({
    skillState,
    runs,
    kv: new LearningKv(env.db),
    settings,
    audit,
    enabled: () => effectiveSettingFlag(settings, CURATOR_ENABLED_SETTING, cfg.enabled),
    configEnabled: () => cfg.enabled,
    config: () => cfg,
    run: runImpl as unknown as (o: { trigger: "command"; merge: boolean }) => Promise<CuratorCommandRunResult>,
    restore: (name, actor) => restoreArchivedSkill(applyDeps, name, actor),
    archived: () => listArchivedSkills(applyDeps.archiveRoot),
    skillExists: (name) => existsSync(join(skillsRoot, name)),
    nextRunAt: () => null,
    pendingCount: () => 1,
    llmAvailable: () => false,
    resetSchedule,
  }));
});
afterEach(() => {
  env.cleanup();
});

function msg(text: string, senderId = OWNER_ID): UnifiedMessage {
  return { id: `m${Math.random()}`, channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null };
}

async function run(text: string, senderId = OWNER_ID, source: "channel" | "synthetic" = "channel"): Promise<{ outcome: DispatchOutcome; reply: string }> {
  const m = msg(text, senderId);
  const identity: ResolvedIdentity = { role: "owner", canonicalId: `telegram:${senderId}`, channel: "telegram", senderId };
  const before = sent.length;
  const outcome = await registry.dispatch({ message: m, identity, source, send: async (r) => { sent.push(r); } });
  return { outcome, reply: sent.slice(before).map((r) => r.text).join("\n") };
}

function archivedCopy(name: string): string {
  const d = join(applyDeps.archiveRoot, `${name}@20261101-000000`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), skillMd(name));
  writeFileSync(join(d, "ARCHIVE.json"), JSON.stringify({ name, archivedAt: "2026-11-01T00:00:00.000Z", reason: "unused" }));
  skillState.insert({ name, root: "project", source: "local" });
  skillState.markArchived("project", name, { archivedAt: "2026-11-01T00:00:00.000Z", archivePath: d });
  return d;
}

describe("/curator", () => {
  it("is owner-only, DM-only, and synthetic text never runs it", async () => {
    expect((await run("/curator run", STRANGER_ID)).outcome.kind).toBe("denied");
    expect((await run("/curator on", STRANGER_ID)).outcome.kind).toBe("denied");
    archivedCopy("old-tool");
    expect((await run("/curator restore old-tool", STRANGER_ID)).outcome.kind).toBe("denied");
    expect(existsSync(join(skillsRoot, "old-tool"))).toBe(false);
    expect((await run("/curator run", OWNER_ID, "synthetic")).outcome.kind).toBe("not-command");
    expect(runImpl).not.toHaveBeenCalled();
    expect(settings.get(CURATOR_ENABLED_SETTING, BOOL)).toBeUndefined();
  });

  it("status says the weekly run is off by default and that it only proposes", async () => {
    const r = await run("/curator status");
    expect(r.reply).toContain("weekly run: off (config)");
    expect(r.reply).toContain("only reports and proposes");
    expect(r.reply).toContain("Pending curator proposals: 1");
  });

  it("run reports findings and proposal ids", async () => {
    const r = await run("/curator run");
    expect(runImpl).toHaveBeenCalledWith({ trigger: "command", merge: false });
    expect(r.reply).toContain("Filed 1 proposal: #7 fix remotion");
    expect(r.reply).toContain("Nothing changes until you approve");
    expect(r.reply).toContain("deploy-a + deploy-b");
    expect((await run("/curator run merge")).reply).toContain("not available");
    expect((await run("/curator run now")).reply).toContain("Usage");
  });

  it("on, off and reset write the runtime override; turning it on again restarts the weekly clock", async () => {
    await run("/curator on");
    expect(resetSchedule).toHaveBeenCalledTimes(1);
    await run("/curator on");
    expect(resetSchedule).toHaveBeenCalledTimes(1);
    expect(settings.get(CURATOR_ENABLED_SETTING, BOOL)).toBe(true);
    expect((await run("/curator status")).reply).toContain("weekly run: on (runtime override)");
    await run("/curator off");
    expect(settings.get(CURATOR_ENABLED_SETTING, BOOL)).toBe(false);
    await run("/curator reset");
    expect(settings.get(CURATOR_ENABLED_SETTING, BOOL)).toBeUndefined();
    expect(audit.actions()).toEqual(expect.arrayContaining(["curator.enabled", "curator.disabled"]));
  });

  it("list shows the last report and the archived and stale skills", async () => {
    expect((await run("/curator list")).reply).toContain("No curator run yet");
    await run("/curator run");
    expect((await run("/curator list broken")).reply).toContain("remotion · B2");
    expect((await run("/curator list dupes")).reply).toContain("possible group: deploy-a + deploy-b");
    archivedCopy("old-tool");
    expect((await run("/curator list archived")).reply).toContain("old-tool · archived 2026-11-01 · unused");
    skillState.insert({ name: "rare", root: "project", source: "local" });
    skillState.setState("project", "rare", "stale");
    expect((await run("/curator list stale")).reply).toContain("rare · local · stale");
    expect((await run("/curator list everything")).reply).toContain("Usage");
  });

  it("restore moves the archive back and refuses when the name exists", async () => {
    archivedCopy("old-tool");
    mkdirSync(join(skillsRoot, "old-tool"));
    expect((await run("/curator restore old-tool")).reply).toContain("already exists");
    rmSync(join(skillsRoot, "old-tool"), { recursive: true });
    expect((await run("/curator restore old-tool")).reply).toContain("Restored old-tool");
    expect(readFileSync(join(skillsRoot, "old-tool", "SKILL.md"), "utf8")).toBe(skillMd("old-tool"));
    expect(skillState.get("project", "old-tool")!.state).toBe("active");
    expect((await run("/curator restore old-tool")).reply).toContain("already exists");
    expect((await run("/curator restore")).reply).toContain("Usage");
  });

  it("pin persists and unpin clears it; unknown skills are refused", async () => {
    mkdirSync(join(skillsRoot, "handy"));
    expect((await run("/curator pin handy")).reply).toContain("Pinned handy");
    expect(skillState.get("project", "handy")!.pinned).toBe(true);
    expect((await run("/curator unpin handy")).reply).toContain("Unpinned");
    expect(skillState.get("project", "handy")!.pinned).toBe(false);
    expect((await run("/curator pin ghost")).reply).toContain("No skill named");
    expect((await run("/curator pin ../x")).reply).toContain("Usage");
  });

  it("usage lists the most used skills and one skill's history", async () => {
    skillState.insert({ name: "weather", root: "project", source: "bundled" });
    skillState.bumpUse("project", "weather", "2026-11-20T10:00:00.000Z");
    skillState.recordUsage({ skill: "weather", ts: "2026-11-20T10:00:00.000Z", source: "main", via: "tool" });
    expect((await run("/curator usage")).reply).toContain("weather · bundled · active · 1 uses");
    expect((await run("/curator usage weather")).reply).toContain("main · tool");
    expect((await run("/curator usage nothing-here")).reply).toContain("No usage recorded");
  });
});

describe("renderCuratorRunSummary", () => {
  it("is plain counts and ids, never file bodies", () => {
    const text = renderCuratorRunSummary(report({ proposals: [], possibleDuplicates: [] }));
    expect(text).toContain("Skill check: 3 skills, 1 broken");
    expect(text).toContain("No new proposals.");
  });
});
