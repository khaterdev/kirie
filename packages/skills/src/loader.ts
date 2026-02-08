import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition, SkillSource } from "./types.js";

/** Parse SKILL.md file: YAML frontmatter between --- delimiters + markdown body */
export function parseSkillFile(
  content: string,
  filePath: string,
  source: SkillSource,
): SkillDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = parseYaml(match[1]!) as Record<string, unknown>;
  const body = match[2]!.trim();

  return {
    name: frontmatter.name as string,
    description: frontmatter.description as string,
    emoji: frontmatter.emoji as string | undefined,
    version: frontmatter.version as string | undefined,
    author: frontmatter.author as string | undefined,
    os: frontmatter.os as SkillDefinition["os"],
    requires: frontmatter.requires as SkillDefinition["requires"],
    install: frontmatter.install as SkillDefinition["install"],
    invocation: frontmatter.invocation as SkillDefinition["invocation"],
    content: body,
    source,
    filePath,
  };
}

/** Scan a directory for skill subdirectories containing SKILL.md */
export function scanSkillDirectory(
  dir: string,
  source: SkillSource,
): SkillDefinition[] {
  if (!existsSync(dir)) return [];
  const skills: SkillDefinition[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const content = readFileSync(skillFile, "utf-8");
      const skill = parseSkillFile(content, skillFile, source);
      if (skill) skills.push(skill);
    } catch {
      /* skip malformed skills */
    }
  }

  return skills;
}

/** Check if a binary exists on the system PATH */
function binExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a skill is eligible to run on the current system */
export function isEligible(skill: SkillDefinition): boolean {
  if (
    skill.os &&
    !skill.os.includes(process.platform as "darwin" | "linux" | "win32")
  ) {
    return false;
  }

  if (skill.requires?.bins) {
    for (const bin of skill.requires.bins) {
      if (!binExists(bin)) return false;
    }
  }

  if (skill.requires?.anyBins) {
    if (!skill.requires.anyBins.some((bin) => binExists(bin))) return false;
  }

  if (skill.requires?.env) {
    for (const envVar of skill.requires.env) {
      if (!process.env[envVar]) return false;
    }
  }

  return true;
}

/** Load all skills from standard directories with priority ordering */
export function loadAllSkills(opts?: {
  bundledDir?: string;
  managedDir?: string;
  workspaceDir?: string;
}): SkillDefinition[] {
  const bundledDefault = join(import.meta.dirname ?? ".", "../../skills");
  const managedDefault = join(homedir(), ".kirie", "skills");

  const bundled = scanSkillDirectory(
    opts?.bundledDir ?? bundledDefault,
    "bundled",
  );
  const managed = scanSkillDirectory(
    opts?.managedDir ?? managedDefault,
    "managed",
  );
  const workspace = opts?.workspaceDir
    ? scanSkillDirectory(opts.workspaceDir, "workspace")
    : [];

  // Priority: workspace > managed > bundled (later overrides earlier by name)
  const byName = new Map<string, SkillDefinition>();
  for (const skill of [...bundled, ...managed, ...workspace]) {
    byName.set(skill.name, skill);
  }

  return [...byName.values()];
}
