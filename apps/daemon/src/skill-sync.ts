/**
 * Boot-time skill sync: writes Kirie's eligible skills as Claude Code skills
 * under `<agentCwd>/.claude/skills/<name>/SKILL.md`, where the SDK's Skill tool
 * discovers them. Extracted from lifecycle.ts so the curator (W3-CUR) can pass
 * `shouldSkip` (for example archived skills) without editing lifecycle.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillDefinition } from "@kirie/skills";

export type SkillSyncInput = Pick<SkillDefinition, "name" | "description" | "invocation" | "content">;

export interface SkillSyncOptions {
  skills: readonly SkillSyncInput[];
  /** <agentCwd>/.claude/skills */
  sdkSkillsDir: string;
  /** Return true to leave a skill out. Default: skip nothing. */
  shouldSkip?: (skill: SkillSyncInput) => boolean;
  /** ~/.kirie, for a default skip rule that reads Kirie state (the curator's archived skills) */
  dataDir?: string;
}

export interface SkillSyncResult {
  written: string[];
  skipped: string[];
}

/** Claude Code frontmatter for one skill, followed by its content. */
export function renderSdkSkillFile(skill: SkillSyncInput): string {
  const fm: string[] = ["---"];
  fm.push(`name: ${skill.name}`);
  fm.push(`description: ${skill.description}`);
  if (skill.invocation?.userInvocable === false) fm.push("user-invocable: false");
  if (skill.invocation?.disableModelInvocation === true) fm.push("disable-model-invocation: true");
  fm.push("---");
  return fm.join("\n") + "\n\n" + skill.content;
}

export function syncBundledSkills(opts: SkillSyncOptions): SkillSyncResult {
  const dir = resolve(opts.sdkSkillsDir);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const skill of opts.skills) {
    if (opts.shouldSkip?.(skill)) {
      skipped.push(skill.name);
      continue;
    }
    const skillDir = join(dir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), renderSdkSkillFile(skill), "utf-8");
    written.push(skill.name);
  }
  return { written, skipped };
}
