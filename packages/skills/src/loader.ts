import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { binExists } from "@kirie/core";
import type { SkillDefinition, SkillSource } from "./types.js";

export interface ParsedFrontmatter {
  /** The YAML mapping, or null when there is no frontmatter block or it does not parse to a mapping */
  frontmatter: Record<string, unknown> | null;
  /** Markdown after the frontmatter block (the whole text when there is no block), trimmed */
  body: string;
  /** Set when the block is missing or invalid */
  error?: string;
}

/**
 * Tolerant frontmatter parser for SKILL.md (curator, R4 item 4 B2). Accepts
 * CRLF line endings, a UTF-8 BOM and a closing `---` with no trailing newline.
 * Never throws: a missing block or bad YAML is reported in `error`.
 * `parseSkillFile` keeps its stricter behaviour so the boot sync is unchanged.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: null, body: text.trim(), error: "no frontmatter block" };
  const body = (m[2] ?? "").trim();
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? "");
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    return { frontmatter: null, body, error: `frontmatter YAML does not parse: ${msg.slice(0, 160)}` };
  }
  if (data === null || data === undefined) return { frontmatter: {}, body };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { frontmatter: null, body, error: "frontmatter is not a YAML mapping" };
  }
  return { frontmatter: data as Record<string, unknown>, body };
}

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
