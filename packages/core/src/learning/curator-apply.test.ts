import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningConfigSchema } from "../config/sections/learning.js";
import { TurnContextRegistry } from "../engine/turn-context.js";
import { mintOwnerApproval, type OwnerApproval } from "./applier.js";
import {
  CURATOR_ARCHIVE_MANIFEST,
  curatorArchiveRoot,
  listArchivedSkills,
  moveSkillDir,
  readSkillApprovedCopy,
  registerCuratorKindHandlers,
  restoreArchivedSkill,
  saveSkillApprovedCopy,
  type CuratorApplyDeps,
} from "./curator-apply.js";
import { openLearningDb } from "./learning-db.js";
import { sha256Hex } from "./proposal-types.js";
import { SkillStateStore } from "./skill-state-store.js";
import { createLearningSystem, type LearningSystem } from "./system.js";
import { OWNER_ID, STRANGER_ID, fakeAudit, fakeOwners, skillMd, type FakeAudit } from "./learning.test-util.js";

let dir: string;
let dataDir: string;
let skillsRoot: string;
let system: LearningSystem;
let deps: CuratorApplyDeps;
let audit: FakeAudit;
let owner: OwnerApproval;

function writeSkill(name: string, content = skillMd(name), extra: Record<string, string> = {}): string {
  const d = join(skillsRoot, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), content);
  for (const [f, text] of Object.entries(extra)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}

function file(kind: string, payload: Record<string, unknown>, trust: "owner" | "mixed" = "owner"): number {
  const r = system.intake.submit({ kind: kind as never, title: `${kind} test`, payload, origin: "curator", trust });
  if (!("id" in r)) throw new Error(r.dropped);
  return r.id;
}

function archivePayload(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const md = readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
  return { name, reason: "unused", evidence: { detector: "stale", useCount: 0 }, contentHash: sha256Hex(md), ...extra };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-curator-apply-"));
  dataDir = join(dir, "kirie");
  mkdirSync(dataDir);
  skillsRoot = join(dataDir, ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  audit = fakeAudit();
  const cfg = LearningConfigSchema.parse({});
  system = createLearningSystem({
    dataDir,
    agentCwd: dataDir,
    config: () => cfg,
    enabled: () => false,
    configEnabled: () => false,
    model: () => "m",
    isActiveHours: () => true,
    owners: fakeOwners,
    prompts: { sendCard: async () => null },
    settings: { set: () => {}, delete: () => {} },
    audit,
    turns: new TurnContextRegistry(),
    memory: null,
    history: { recent: () => [] },
    memoryKeys: () => [],
  });
  deps = { skillsRoot, archiveRoot: curatorArchiveRoot(dataDir), skillState: system.skillState, db: system.db, audit };
  registerCuratorKindHandlers(system.applier, deps);
  owner = mintOwnerApproval(fakeOwners, { channel: "telegram", senderId: OWNER_ID, via: "command" })!;
});

afterEach(() => {
  system.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("skill.archive", () => {
  it("is not applied without an owner approval and moves nothing", async () => {
    writeSkill("old-tool");
    const id = file("skill.archive", archivePayload("old-tool"));
    expect(mintOwnerApproval(fakeOwners, { channel: "telegram", senderId: STRANGER_ID, via: "command" })).toBeNull();
    const forged = Object.freeze({ channel: "telegram", senderId: OWNER_ID, via: "command" as const, at: new Date().toISOString() });
    const out = await system.applier.approve(id, forged);
    expect(out.ok).toBe(false);
    expect(existsSync(join(skillsRoot, "old-tool", "SKILL.md"))).toBe(true);
  });

  it("moves the directory into the archive with a manifest, keeps every file, and marks the state archived", async () => {
    writeSkill("old-tool", skillMd("old-tool"), { "scripts/run.sh": "echo hi\n" });
    const id = file("skill.archive", archivePayload("old-tool"));
    const out = await system.applier.approve(id, owner);
    expect(out.ok).toBe(true);
    expect(existsSync(join(skillsRoot, "old-tool"))).toBe(false);
    const [entry] = listArchivedSkills(deps.archiveRoot, "old-tool");
    expect(entry).toBeDefined();
    expect(entry!.dir).toMatch(/old-tool@\d{8}-\d{6}$/);
    expect(readFileSync(join(entry!.dir, "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    const manifest = JSON.parse(readFileSync(join(entry!.dir, CURATOR_ARCHIVE_MANIFEST), "utf8"));
    expect(manifest).toMatchObject({ name: "old-tool", reason: "unused", proposalId: id, detector: "stale", originalPath: join(skillsRoot, "old-tool") });
    const row = system.skillState.get("project", "old-tool")!;
    expect(row.state).toBe("archived");
    expect(row.archivePath).toBe(entry!.dir);
    expect(audit.actions()).toContain("skill.archived");
  });

  it("refuses as stale when the skill changed, was pinned, or vanished since the proposal", async () => {
    writeSkill("a");
    const changed = file("skill.archive", archivePayload("a"));
    writeFileSync(join(skillsRoot, "a", "SKILL.md"), skillMd("a", "Changed"));
    expect(await system.applier.approve(changed, owner)).toMatchObject({ ok: false, code: "stale" });

    writeSkill("b");
    const pinned = file("skill.archive", archivePayload("b"));
    system.skillState.insert({ name: "b", root: "project", source: "local" });
    system.skillState.setPinned("project", "b", true);
    expect(await system.applier.approve(pinned, owner)).toMatchObject({ ok: false, code: "stale" });

    writeSkill("c");
    const gone = file("skill.archive", archivePayload("c"));
    rmSync(join(skillsRoot, "c"), { recursive: true });
    expect(await system.applier.approve(gone, owner)).toMatchObject({ ok: false, code: "stale" });
    expect(listArchivedSkills(deps.archiveRoot)).toEqual([]);
  });

  it("never moves a symlinked skill directory", async () => {
    const real = join(dir, "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "SKILL.md"), skillMd("linked"));
    symlinkSync(real, join(skillsRoot, "linked"));
    const id = file("skill.archive", { name: "linked", reason: "x", evidence: { detector: "B1", useCount: 0 } });
    expect(await system.applier.approve(id, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(existsSync(join(real, "SKILL.md"))).toBe(true);
  });

  it("undo moves the skill back", async () => {
    writeSkill("old-tool");
    const id = file("skill.archive", archivePayload("old-tool"));
    expect((await system.applier.approve(id, owner)).ok).toBe(true);
    expect((await system.applier.undo(id, owner)).ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "old-tool", "SKILL.md"), "utf8")).toBe(skillMd("old-tool"));
    expect(existsSync(join(skillsRoot, "old-tool", CURATOR_ARCHIVE_MANIFEST))).toBe(false);
    expect(system.skillState.get("project", "old-tool")!.state).toBe("active");
  });
});

describe("restore", () => {
  it("moves the newest archive back, keeps the manifest outside the skill, marks it used now", async () => {
    writeSkill("old-tool");
    expect((await system.applier.approve(file("skill.archive", archivePayload("old-tool")), owner)).ok).toBe(true);
    const out = restoreArchivedSkill(deps, "old-tool", "owner:telegram:1001");
    expect(out.ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "old-tool", "SKILL.md"), "utf8")).toBe(skillMd("old-tool"));
    expect(existsSync(join(skillsRoot, "old-tool", CURATOR_ARCHIVE_MANIFEST))).toBe(false);
    expect(readdirSync(join(deps.archiveRoot, ".restored")).length).toBe(1);
    const row = system.skillState.get("project", "old-tool")!;
    expect(row.state).toBe("active");
    expect(row.lastUsedAt).toBeTruthy();
    expect(audit.records.find((r) => r.action === "skill.restored")?.actor).toBe("owner:telegram:1001");
  });

  it("refuses when the name exists again, when nothing is archived, and for bad names", async () => {
    writeSkill("old-tool");
    expect((await system.applier.approve(file("skill.archive", archivePayload("old-tool")), owner)).ok).toBe(true);
    writeSkill("old-tool", skillMd("old-tool", "a new one"));
    expect(restoreArchivedSkill(deps, "old-tool")).toMatchObject({ ok: false, code: "exists" });
    expect(listArchivedSkills(deps.archiveRoot, "old-tool")).toHaveLength(1);
    expect(restoreArchivedSkill(deps, "never-archived")).toMatchObject({ ok: false, code: "not_found" });
    expect(restoreArchivedSkill(deps, "../escape")).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("moveSkillDir across devices", () => {
  it("copies, verifies, then removes the source", () => {
    const from = writeSkill("x", skillMd("x"), { "references/a.md": "A", "assets/b.txt": "BB" });
    const to = join(dir, "moved", "x");
    moveSkillDir(from, to, { renameSync: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "references", "a.md"), "utf8")).toBe("A");
    expect(readFileSync(join(to, "assets", "b.txt"), "utf8")).toBe("BB");
  });

  it("leaves the source in place when the rename fails for another reason", () => {
    const from = writeSkill("y");
    expect(() => moveSkillDir(from, join(dir, "moved", "y"), { renameSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } })).toThrow();
    expect(existsSync(join(from, "SKILL.md"))).toBe(true);
  });
});

describe("skill.merge", () => {
  function mergePayload(into: string, from: string[], merged: string): Record<string, unknown> {
    const baseHashes: Record<string, string> = {};
    for (const n of [into, ...from]) baseHashes[n] = sha256Hex(readFileSync(join(skillsRoot, n, "SKILL.md"), "utf8"));
    return { into, from, mergedSkillMd: merged, baseHashes };
  }

  it("writes the merged skill and archives the others with absorbed_into", async () => {
    writeSkill("deploy-app");
    writeSkill("deploy-service");
    const merged = skillMd("deploy-app", "Deploy apps and services");
    const id = file("skill.merge", mergePayload("deploy-app", ["deploy-service"], merged), "mixed");
    const out = await system.applier.approve(id, owner);
    expect(out.ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "deploy-app", "SKILL.md"), "utf8")).toBe(merged);
    expect(existsSync(join(skillsRoot, "deploy-service"))).toBe(false);
    expect(system.skillState.get("project", "deploy-service")).toMatchObject({ state: "archived", absorbedInto: "deploy-app" });
    expect(system.skillState.get("project", "deploy-app")!.approvedHash).toBe(sha256Hex(merged));
    expect(readSkillApprovedCopy(deps.archiveRoot, "deploy-app", sha256Hex(merged))).toBe(merged);

    expect((await system.applier.undo(id, owner)).ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "deploy-app", "SKILL.md"), "utf8")).toBe(skillMd("deploy-app"));
    expect(existsSync(join(skillsRoot, "deploy-service", "SKILL.md"))).toBe(true);
  });

  it("is all or nothing: a failing archive rolls back the merged file and earlier archives", async () => {
    writeSkill("deploy-app");
    writeSkill("deploy-one");
    writeSkill("deploy-two");
    const merged = skillMd("deploy-app", "Deploy everything");
    const id = file("skill.merge", mergePayload("deploy-app", ["deploy-one", "deploy-two"], merged), "mixed");
    // The second archive move fails.
    let calls = 0;
    deps.fs = {
      renameSync: (from: string, to: string) => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("disk said no"), { code: "EIO" });
        renameSync(from, to);
      },
    };
    const out = await system.applier.approve(id, owner);
    expect(out).toMatchObject({ ok: false });
    expect(readFileSync(join(skillsRoot, "deploy-app", "SKILL.md"), "utf8")).toBe(skillMd("deploy-app"));
    expect(existsSync(join(skillsRoot, "deploy-one", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsRoot, "deploy-two", "SKILL.md"))).toBe(true);
    expect(system.skillState.get("project", "deploy-one")?.state ?? "active").toBe("active");
  });

  it("refuses bundled skills and changed inputs", async () => {
    writeSkill("weather");
    writeSkill("weather-two");
    system.skillState.insert({ name: "weather", root: "project", source: "bundled" });
    const bundled = file("skill.merge", mergePayload("weather", ["weather-two"], skillMd("weather", "merged")), "mixed");
    expect(await system.applier.approve(bundled, owner)).toMatchObject({ ok: false, code: "invalid" });

    writeSkill("x-one");
    writeSkill("x-two");
    const stale = file("skill.merge", mergePayload("x-one", ["x-two"], skillMd("x-one", "merged")), "mixed");
    writeFileSync(join(skillsRoot, "x-two", "SKILL.md"), skillMd("x-two", "edited"));
    expect(await system.applier.approve(stale, owner)).toMatchObject({ ok: false, code: "stale" });
    expect(existsSync(join(skillsRoot, "x-two"))).toBe(true);
  });
});

describe("skill.adopt and skill.revert", () => {
  function drifted(): { approved: string; current: string } {
    const approved = skillMd("notes");
    writeSkill("notes", approved);
    system.skillState.insert({ name: "notes", root: "project", source: "local", approvedHash: sha256Hex(approved), approvedAt: new Date().toISOString() });
    saveSkillApprovedCopy(deps.archiveRoot, "notes", approved);
    const current = skillMd("notes", "Edited by hand");
    writeFileSync(join(skillsRoot, "notes", "SKILL.md"), current);
    return { approved, current };
  }

  it("adopt records the current content as approved; revert is then stale", async () => {
    const { approved, current } = drifted();
    const payload = { name: "notes", currentHash: sha256Hex(current), approvedHash: sha256Hex(approved) };
    const adopt = file("skill.adopt", payload);
    const revert = file("skill.revert", payload);
    expect((await system.applier.approve(adopt, owner)).ok).toBe(true);
    expect(system.skillState.get("project", "notes")!.approvedHash).toBe(sha256Hex(current));
    expect(readSkillApprovedCopy(deps.archiveRoot, "notes", sha256Hex(current))).toBe(current);
    expect(await system.applier.approve(revert, owner)).toMatchObject({ ok: false, code: "stale" });
    expect(readFileSync(join(skillsRoot, "notes", "SKILL.md"), "utf8")).toBe(current);
  });

  it("revert restores the approved copy and keeps the drifted file in the backup", async () => {
    const { approved, current } = drifted();
    const payload = { name: "notes", currentHash: sha256Hex(current), approvedHash: sha256Hex(approved) };
    const revert = file("skill.revert", payload);
    const out = await system.applier.approve(revert, owner);
    expect(out.ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "notes", "SKILL.md"), "utf8")).toBe(approved);
    expect(readFileSync(String((out as { result: Record<string, unknown> }).result.backupFile), "utf8")).toBe(current);
    expect((await system.applier.undo(revert, owner)).ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "notes", "SKILL.md"), "utf8")).toBe(current);
  });

  it("revert refuses when no approved copy was saved", async () => {
    const approved = skillMd("raw");
    writeSkill("raw", approved);
    system.skillState.insert({ name: "raw", root: "project", source: "local", approvedHash: sha256Hex(approved) });
    const current = skillMd("raw", "changed");
    writeFileSync(join(skillsRoot, "raw", "SKILL.md"), current);
    const id = file("skill.revert", { name: "raw", currentHash: sha256Hex(current), approvedHash: sha256Hex(approved) });
    expect(await system.applier.approve(id, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(readFileSync(join(skillsRoot, "raw", "SKILL.md"), "utf8")).toBe(current);
  });
});

describe("persistence", () => {
  it("an approved archive survives reopening the DB (a daemon restart)", async () => {
    writeSkill("old-tool");
    expect((await system.applier.approve(file("skill.archive", archivePayload("old-tool")), owner)).ok).toBe(true);
    const db = openLearningDb(join(dataDir, "learning.db"), { readonly: true });
    try {
      expect(new SkillStateStore(db).get("project", "old-tool")!.state).toBe("archived");
    } finally {
      db.close();
    }
  });
});
