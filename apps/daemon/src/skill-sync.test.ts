import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { learningDbPath, openLearningDb } from "@kirie/core";
import { curatorProtectedSkills, syncBundledSkills, renderSdkSkillFile } from "./skill-sync.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("syncBundledSkills", () => {
  it("writes every skill as .claude/skills/<name>/SKILL.md with Claude Code frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "kirie-skills-"));
    dirs.push(dir);
    const res = syncBundledSkills({
      sdkSkillsDir: join(dir, ".claude", "skills"),
      skills: [
        { name: "weather", description: "Get the weather", content: "# Weather\nUse wttr.in" },
        { name: "hidden", description: "Internal", content: "x", invocation: { userInvocable: false, disableModelInvocation: true } },
      ],
    });
    expect(res).toEqual({ written: ["weather", "hidden"], skipped: [] });
    expect(readFileSync(join(dir, ".claude/skills/weather/SKILL.md"), "utf8")).toBe(
      "---\nname: weather\ndescription: Get the weather\n---\n\n# Weather\nUse wttr.in",
    );
    expect(readFileSync(join(dir, ".claude/skills/hidden/SKILL.md"), "utf8")).toContain("user-invocable: false\ndisable-model-invocation: true\n---");
  });

  it("skips what shouldSkip names", () => {
    const dir = mkdtempSync(join(tmpdir(), "kirie-skills-"));
    dirs.push(dir);
    const res = syncBundledSkills({
      sdkSkillsDir: dir,
      skills: [{ name: "a", description: "A", content: "a" }, { name: "b", description: "B", content: "b" }],
      shouldSkip: (s) => s.name === "b",
    });
    expect(res).toEqual({ written: ["a"], skipped: ["b"] });
    expect(existsSync(join(dir, "b"))).toBe(false);
  });

  it("renders exactly what the old inline code wrote", () => {
    expect(renderSdkSkillFile({ name: "n", description: "d", content: "c" })).toBe("---\nname: n\ndescription: d\n---\n\nc");
  });
});

describe("syncBundledSkills: curator state (PLAN C.4)", () => {
  function dataDirWithState(rows: Array<{ name: string; state?: string; override?: number }>): string {
    const dataDir = mkdtempSync(join(tmpdir(), "kirie-sync-state-"));
    dirs.push(dataDir);
    const db = openLearningDb(learningDbPath(dataDir));
    const insert = db.prepare("INSERT INTO skill_state (name, root, source, state, override, first_seen_at) VALUES (?, 'project', 'bundled', ?, ?, '2026-01-01T00:00:00.000Z')");
    for (const r of rows) insert.run(r.name, r.state ?? "active", r.override ?? 0);
    db.close();
    return dataDir;
  }

  it("does not rewrite archived skills or bundled skills with an approved override, so they survive a restart", () => {
    const dataDir = dataDirWithState([{ name: "archived-one", state: "archived" }, { name: "patched", override: 1 }, { name: "normal" }]);
    const skillsDir = join(dataDir, ".claude", "skills");
    mkdirSync(join(skillsDir, "patched"), { recursive: true });
    writeFileSync(join(skillsDir, "patched", "SKILL.md"), "approved local patch");
    const skills = ["archived-one", "patched", "normal"].map((name) => ({ name, description: name, content: "c" }));
    const res = syncBundledSkills({ skills, sdkSkillsDir: skillsDir, dataDir });
    expect(res).toEqual({ written: ["normal"], skipped: ["archived-one", "patched"] });
    expect(existsSync(join(skillsDir, "archived-one"))).toBe(false);
    expect(readFileSync(join(skillsDir, "patched", "SKILL.md"), "utf8")).toBe("approved local patch");
  });

  it("skips nothing when learning.db does not exist yet, and does not create it", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kirie-sync-nostate-"));
    dirs.push(dataDir);
    const res = syncBundledSkills({ skills: [{ name: "a", description: "A", content: "a" }], sdkSkillsDir: join(dataDir, "skills"), dataDir });
    expect(res.written).toEqual(["a"]);
    expect(existsSync(learningDbPath(dataDir))).toBe(false);
    expect(curatorProtectedSkills(dataDir)).toEqual(new Set());
  });
});
