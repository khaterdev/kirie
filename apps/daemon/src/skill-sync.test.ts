import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncBundledSkills, renderSdkSkillFile } from "./skill-sync.js";

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
