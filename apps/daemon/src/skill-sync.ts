/**
 * Boot-time skill sync: writes Kirie's eligible skills as Claude Code skills
 * under `<agentCwd>/.claude/skills/<name>/SKILL.md`, where the SDK's Skill tool
 * discovers them. Extracted from lifecycle.ts so the curator can change which
 * skills are written without editing lifecycle.ts.
 *
 * Curator rule (PLAN C.4): when `dataDir` is given, a bundled skill is not
 * rewritten when learning.db's `skill_state` says the project copy is
 * `archived` (the owner approved archiving it, so it must not reappear on
 * restart) or has `override = 1` (an approved patch replaced the bundled
 * text). learning.db is opened read-only; when it is missing or unreadable
 * nothing is skipped, which is the behaviour before the curator existed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createModuleLogger, learningDbPath, openLearningDb } from "@kirie/core";
import type { SkillDefinition } from "@kirie/skills";

const log = createModuleLogger("skill-sync");

export type SkillSyncInput = Pick<SkillDefinition, "name" | "description" | "invocation" | "content">;

export interface SkillSyncOptions {
  skills: readonly SkillSyncInput[];
  /** <agentCwd>/.claude/skills */
  sdkSkillsDir: string;
  /** Return true to leave a skill out. Default: skip nothing. */
  shouldSkip?: (skill: SkillSyncInput) => boolean;
  /** ~/.kirie: skip skills the curator archived or an approved patch overrides (learning.db `skill_state`) */
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

/**
 * Project skills the boot sync must leave alone: archived, or a bundled skill
 * with an approved local override. Empty when learning.db does not exist yet.
 */
export function curatorProtectedSkills(dataDir: string): Set<string> {
  const path = learningDbPath(dataDir);
  if (!existsSync(path)) return new Set();
  let db: ReturnType<typeof openLearningDb> | null = null;
  try {
    db = openLearningDb(path, { readonly: true });
    const rows = db
      .prepare("SELECT name FROM skill_state WHERE root = 'project' AND (state = 'archived' OR override = 1)")
      .all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not read skill state; syncing every skill");
    return new Set();
  } finally {
    db?.close();
  }
}

export function syncBundledSkills(opts: SkillSyncOptions): SkillSyncResult {
  const dir = resolve(opts.sdkSkillsDir);
  const written: string[] = [];
  const skipped: string[] = [];
  const keep = opts.dataDir ? curatorProtectedSkills(opts.dataDir) : new Set<string>();
  for (const skill of opts.skills) {
    if (keep.has(skill.name) || opts.shouldSkip?.(skill)) {
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
