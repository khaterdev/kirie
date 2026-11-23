import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCuratorTools } from "./curator-tools.js";
import { openLearningDb } from "../../learning/learning-db.js";
import { SkillStateStore } from "../../learning/skill-state-store.js";
import { CuratorRunStore, type CuratorReport } from "../../learning/curator-scheduler.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-curator-tools-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const HERE = dirname(fileURLToPath(import.meta.url));

function seed(): void {
  const db = openLearningDb(join(dir, "learning.db"));
  const state = new SkillStateStore(db);
  state.insert({ name: "weather", root: "project", source: "bundled" });
  state.bumpUse("project", "weather", "2026-11-20T10:00:00.000Z");
  state.bumpUse("project", "weather", "2026-11-21T10:00:00.000Z");
  state.insert({ name: "notes", root: "project", source: "local" });
  state.setPinned("project", "notes", true);
  const runs = new CuratorRunStore(db);
  const id = runs.start("schedule", "2026-11-23T02:00:00.000Z");
  const report: CuratorReport = {
    version: 1, trigger: "schedule", startedAt: "2026-11-23T02:00:00.000Z", finishedAt: "2026-11-23T02:00:03.000Z", merge: false,
    counts: { skills: 2, broken: 1, duplicates: 0, stale: 0, drift: 0, proposals: 1 },
    findings: [{ skill: "notes", root: "project", detector: "B6", category: "broken", severity: "warn", message: "References missing files: scripts/x.sh.", data: { missing: ["scripts/x.sh"] } }],
    proposals: [{ id: 3, kind: "skill.archive", skill: "old", title: "Archive skill old" }],
    dropped: [], staleMarked: [], possibleDuplicates: [], llm: { calls: 0, costUsd: 0, errors: 0 }, errors: [],
  };
  runs.finish(id, report);
  db.close();
}

describe("curator tools", () => {
  it("are exactly the two read-only tools of PLAN B.13", () => {
    const names = Object.keys(createCuratorTools({ dbDir: dir, env: {} }));
    expect(names.sort()).toEqual(["curator_report", "skill_usage_stats"]);
    expect(names.filter((n) => /run|archive|restore|pin|merge|approve|apply|reject|undo|adopt|revert/i.test(n))).toEqual([]);
  });

  it("the factory is pure and a missing learning.db is not created", async () => {
    const t = createCuratorTools({ dbDir: dir, env: {} });
    expect(existsSync(join(dir, "learning.db"))).toBe(false);
    expect(await t.skill_usage_stats!.handler({})).toEqual({ skills: [], note: "no usage recorded yet" });
    expect(await t.curator_report!.handler({})).toMatchObject({ report: null });
    expect(existsSync(join(dir, "learning.db"))).toBe(false);
  });

  it("skill_usage_stats returns counters, most used first, or one skill", async () => {
    seed();
    const t = createCuratorTools({ dbDir: dir, env: {} });
    const all = await t.skill_usage_stats!.handler({}) as { skills: Array<{ name: string; use_count: number; pinned: boolean }> };
    expect(all.skills.map((s) => [s.name, s.use_count])).toEqual([["weather", 2], ["notes", 0]]);
    const one = await t.skill_usage_stats!.handler({ name: "notes" }) as { skills: Array<{ name: string; pinned: boolean }> };
    expect(one.skills).toEqual([expect.objectContaining({ name: "notes", pinned: true })]);
    expect(await t.skill_usage_stats!.handler({ name: "../x" })).toEqual({ error: "invalid skill name" });
  });

  it("curator_report returns the last report without file bodies and cannot write", async () => {
    seed();
    const before = statSync(join(dir, "learning.db")).mtimeMs;
    const t = createCuratorTools({ dbDir: dir, env: {} });
    const r = await t.curator_report!.handler({}) as Record<string, unknown>;
    expect(r).toMatchObject({ trigger: "schedule", proposals: [{ id: 3, kind: "skill.archive", skill: "old" }] });
    expect((r.findings as Array<Record<string, unknown>>)[0]).toEqual({
      skill: "notes", root: "project", detector: "B6", category: "broken", severity: "warn", message: "References missing files: scripts/x.sh.",
    });
    expect(statSync(join(dir, "learning.db")).mtimeMs).toBe(before);
  });

  it("the tools file imports nothing that can apply, approve or restore", () => {
    const src = readFileSync(join(HERE, "curator-tools.ts"), "utf8");
    expect(src).not.toMatch(/curator-apply|curator-commands|learning\/(applier|system|commands|notifier|kind-handlers|intake)\.js|mintOwnerApproval|ProposalApplier/);
  });
});
