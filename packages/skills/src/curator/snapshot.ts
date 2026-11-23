/**
 * Read-only snapshots of skill directories for the curator (R4 item 4).
 *
 * A snapshot never throws: a directory without SKILL.md, a file with no
 * frontmatter or with bad YAML becomes a snapshot the detectors report as
 * broken. Symlinks are listed, never followed when walking, and flagged so
 * nothing ever moves them.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SkillStateRecord } from "@kirie/core";
import { parseFrontmatter } from "../loader.js";
import type { SkillDefinition } from "../types.js";

export type CuratorSkillRoot = "project" | "user";
export type CuratorSkillSource = "bundled" | "learned" | "local" | "user";
export type SkillMdStatus = "ok" | "missing" | "symlink" | "not_file" | "too_large" | "unreadable";

export interface SkillSnapshot {
  name: string;
  root: CuratorSkillRoot;
  dir: string;
  source: CuratorSkillSource;
  /** The skill directory itself is a symlink */
  isSymlink: boolean;
  skillMdPath: string | null;
  /**
   * `missing`: no SKILL.md at all (B1). `symlink`, `not_file`, `too_large`,
   * `unreadable`: there is something, but the curator does not read it; these
   * are reported and never proposed for any change.
   */
  skillMdStatus: SkillMdStatus;
  raw: string | null;
  contentHash: string | null;
  frontmatter: Record<string, unknown> | null;
  frontmatterError?: string;
  body: string;
  /** Relative paths of the other entries in the directory (files, `dir/`, `link@`), capped */
  files: string[];
  /** Relative directories below this one that contain their own SKILL.md */
  nestedSkills: string[];
  /** SKILL.md mtime */
  mtimeMs: number | null;
  /** The repo copy, for bundled skills (carries `requires` and `os`) */
  bundledOriginal?: SkillDefinition;
  state: SkillStateRecord | null;
}

const MAX_FILES = 500;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
/** A SKILL.md larger than this is not read (it is reported by its size only). */
const MAX_READ_BYTES = 1_000_000;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Skill directory names under a root: directories and symlinks, no dot entries. */
export function listSkillDirNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function walk(dir: string): { files: string[]; nested: string[] } {
  const files: string[] = [];
  const nested: string[] = [];
  const visit = (d: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const full = join(d, e.name);
      const rel = relative(dir, full);
      if (e.isSymbolicLink()) { files.push(`${rel}@`); continue; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { files.push(`${rel}/`); continue; }
        files.push(`${rel}/`);
        try {
          if (lstatSync(join(full, "SKILL.md")).isFile()) nested.push(rel);
        } catch {
          // no nested SKILL.md
        }
        if (depth < MAX_DEPTH) visit(full, depth + 1);
        continue;
      }
      if (rel !== "SKILL.md") files.push(rel);
    }
  };
  visit(dir, 0);
  return { files: files.sort(), nested: nested.sort() };
}

export interface SnapshotOptions {
  root: CuratorSkillRoot;
  source: CuratorSkillSource;
  bundledOriginal?: SkillDefinition;
  state: SkillStateRecord | null;
}

/** Snapshot one skill directory. Never throws. */
export function snapshotSkill(dir: string, name: string, opts: SnapshotOptions): SkillSnapshot {
  const link = isSymlink(dir);
  const base: SkillSnapshot = {
    name,
    root: opts.root,
    dir,
    source: opts.source,
    isSymlink: link,
    skillMdPath: null,
    skillMdStatus: "missing",
    raw: null,
    contentHash: null,
    frontmatter: null,
    body: "",
    files: [],
    nestedSkills: [],
    mtimeMs: null,
    state: opts.state,
    ...(opts.bundledOriginal ? { bundledOriginal: opts.bundledOriginal } : {}),
  };
  const skillMd = join(dir, "SKILL.md");
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(skillMd);
  } catch {
    st = null; // no SKILL.md: B1
  }
  if (st?.isSymbolicLink()) {
    base.skillMdStatus = "symlink";
  } else if (st && !st.isFile()) {
    base.skillMdStatus = "not_file";
  } else if (st && st.size > MAX_READ_BYTES) {
    base.skillMdStatus = "too_large";
    base.frontmatterError = `SKILL.md is ${st.size} bytes; not read`;
  } else if (st) {
    base.skillMdPath = skillMd;
    base.mtimeMs = st.mtimeMs;
    try {
      const raw = readFileSync(skillMd, "utf8");
      base.skillMdStatus = "ok";
      base.raw = raw;
      base.contentHash = sha256Text(raw);
      const parsed = parseFrontmatter(raw);
      base.frontmatter = parsed.frontmatter;
      base.body = parsed.body;
      if (parsed.error) base.frontmatterError = parsed.error;
    } catch {
      base.skillMdStatus = "unreadable";
    }
  }
  if (!link) {
    const w = walk(dir);
    base.files = w.files;
    base.nestedSkills = w.nested;
  }
  return base;
}

/** Frontmatter `name` when it is a non-empty string. */
export function frontmatterName(s: SkillSnapshot): string | null {
  const v = s.frontmatter?.name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Frontmatter `description` when it is a non-empty string. */
export function frontmatterDescription(s: SkillSnapshot): string | null {
  const v = s.frontmatter?.description;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
