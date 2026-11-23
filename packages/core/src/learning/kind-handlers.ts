/**
 * Kind handlers registered by W2-LEARN (PLAN B.7): memory.upsert,
 * memory_md.append, skill.create, skill.patch, skill.fix.
 *
 * Each apply first copies what it will touch into the proposal's backup dir and
 * records it in apply_result; undo restores from there and refuses when the
 * target changed since the apply. All paths are resolved and prefix-checked;
 * symlinked skill dirs and files are refused.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ProposalApplyError, type ProposalApplier, type ProposalKindHandler } from "./applier.js";
import {
  MemoryMdAppendPayloadSchema,
  MemoryUpsertPayloadSchema,
  SKILL_NAME_RE,
  SkillCreatePayloadSchema,
  SkillFixPayloadSchema,
  SkillPatchPayloadSchema,
  sha256Hex,
  type MemoryMdAppendPayload,
} from "./proposal-types.js";
import type { SkillStateStore } from "./skill-state-store.js";
import { diffStats, unifiedLineDiff } from "./text-diff.js";

/** What the memory kinds need from the memory system. */
export interface LearningMemoryTarget {
  recall(key: string): { content: string; tags: string[] } | null;
  store(key: string, content: string, tags: string[]): Promise<void> | void;
  delete(key: string): Promise<boolean> | boolean;
}

export interface LearningKindHandlerDeps {
  /** Null when the memory system is unavailable: memory kinds then fail to apply. */
  memory: LearningMemoryTarget | null;
  /** `<dataDir>/MEMORY.md` */
  memoryMdPath: string;
  memoryMdMaxBytes: () => number;
  /** Project skills root, `<agentCwd>/.claude/skills` */
  skillsRoot: string;
  skillState: SkillStateStore;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function writeFileAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** True for any entry, including a dangling symlink. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** `<root>/<name>` after validating the name and checking the resolved path stays inside root. */
export function resolveSkillDir(skillsRoot: string, name: string): string {
  if (!SKILL_NAME_RE.test(name)) throw new ProposalApplyError("invalid", `invalid skill name "${name}"`);
  const root = resolve(skillsRoot);
  const dir = resolve(root, name);
  if (!dir.startsWith(root + sep) || dirname(dir) !== root) {
    throw new ProposalApplyError("invalid", "skill path escapes the skills root");
  }
  return dir;
}

function assertNotSymlink(path: string, what: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new ProposalApplyError("invalid", `${what} is a symlink; refusing to write through it`);
  }
}

/** Move a directory, copying when rename crosses devices. */
function moveDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true });
  }
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// MEMORY.md append
// ---------------------------------------------------------------------------

/** Append `- line` under `## section`, creating the section at the end when missing. */
export function appendUnderSection(text: string, section: string, line: string): string {
  const heading = `## ${oneLine(section)}`;
  const entry = `- ${oneLine(line)}`;
  const lines = text.length > 0 ? text.replace(/\r\n/g, "\n").split("\n") : [];
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (idx < 0) {
    const base = text.length === 0 ? "" : text.endsWith("\n") ? text : `${text}\n`;
    return `${base}${base ? "\n" : ""}${heading}\n${entry}\n`;
  }
  let end = idx + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  // Idempotent: a retry after a crash does not add the line twice.
  if (lines.slice(idx + 1, end).some((l) => l.trim() === entry)) return text;
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, entry);
  const out = lines.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

interface MemoryMdApplyResult {
  file: string;
  existed: boolean;
  backupFile: string | null;
  newHash: string;
}

function applyMemoryMdAppend(deps: LearningKindHandlerDeps, p: MemoryMdAppendPayload, backupDir: string): MemoryMdApplyResult {
  const file = resolve(deps.memoryMdPath);
  assertNotSymlink(file, "MEMORY.md");
  const current = readIfExists(file);
  const next = appendUnderSection(current ?? "", p.section, p.line);
  const max = deps.memoryMdMaxBytes();
  if (Buffer.byteLength(next, "utf8") > max) {
    throw new ProposalApplyError("invalid", `MEMORY.md would exceed ${max} bytes`);
  }
  let backupFile: string | null = null;
  if (current !== null) {
    backupFile = join(backupDir, "MEMORY.md");
    copyFileSync(file, backupFile);
  }
  writeFileAtomic(file, next);
  return { file, existed: current !== null, backupFile, newHash: sha256Hex(next) };
}

function undoMemoryMd(r: MemoryMdApplyResult): void {
  const current = readIfExists(r.file);
  const backup = r.backupFile ? readIfExists(r.backupFile) : null;
  // Already restored (a retried undo): nothing to do.
  if (r.backupFile ? current !== null && backup !== null && current === backup : current === null) return;
  if (current === null || sha256Hex(current) !== r.newHash) {
    throw new ProposalApplyError("conflict", "MEMORY.md changed after the proposal was applied; not restoring it");
  }
  if (r.backupFile) {
    writeFileAtomic(r.file, readFileSync(r.backupFile, "utf8"));
  } else {
    renameSync(r.file, `${r.file}.undone-${Date.now()}`);
  }
}

function isMemoryMdResult(v: unknown): v is MemoryMdApplyResult {
  return !!v && typeof v === "object" && typeof (v as MemoryMdApplyResult).file === "string" && typeof (v as MemoryMdApplyResult).newHash === "string";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createMemoryUpsertHandler(deps: LearningKindHandlerDeps): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = MemoryUpsertPayloadSchema.parse(raw);
      const memory = deps.memory;
      if (!memory) throw new ProposalApplyError("invalid", "the memory store is not available");
      const current = memory.recall(p.key);
      if (current && (p.baseHash === undefined || sha256Hex(current.content) !== p.baseHash)) {
        throw new ProposalApplyError("stale", `memory "${p.key}" changed since the proposal was made`);
      }
      if (!current && p.baseHash !== undefined) {
        throw new ProposalApplyError("stale", `memory "${p.key}" no longer exists`);
      }
      const backupFile = join(ctx.backupDir, "memory.json");
      writeFileSync(
        backupFile,
        JSON.stringify({ key: p.key, existed: current !== null, content: current?.content ?? null, tags: current?.tags ?? [] }),
        { mode: 0o600 },
      );
      const tags = [...new Set([...p.tags, "learned"])];
      // MEMORY.md first: it is the step that can refuse (size cap). Roll it back if the store fails.
      const memoryMd = p.pointer ? applyMemoryMdAppend(deps, p.pointer, ctx.backupDir) : undefined;
      try {
        await memory.store(p.key, p.content, tags);
      } catch (err) {
        if (memoryMd) {
          try {
            undoMemoryMd(memoryMd);
          } catch {
            // the store error below is the one to report; MEMORY.md keeps its backup in the backup dir
          }
        }
        throw err;
      }
      return {
        memoryKeys: [p.key],
        backupFile,
        existed: current !== null,
        newHash: sha256Hex(p.content),
        ...(memoryMd ? { memoryMd } : {}),
      };
    },
    async undo(r) {
      const memory = deps.memory;
      if (!memory) throw new ProposalApplyError("invalid", "the memory store is not available");
      const backup = JSON.parse(readFileSync(String(r.backupFile), "utf8")) as { key: string; existed: boolean; content: string | null; tags: string[] };
      const current = memory.recall(backup.key);
      const alreadyRestored = backup.existed ? current?.content === backup.content : current === null;
      if (current && !alreadyRestored && sha256Hex(current.content) !== r.newHash) {
        throw new ProposalApplyError("conflict", `memory "${backup.key}" changed after the proposal was applied`);
      }
      // Memory first, then MEMORY.md: a retry after a partial undo finds the memory restored and finishes.
      if (backup.existed && backup.content !== null) await memory.store(backup.key, backup.content, backup.tags);
      else await memory.delete(backup.key);
      if (isMemoryMdResult(r.memoryMd)) undoMemoryMd(r.memoryMd);
    },
    preview(raw) {
      const p = MemoryUpsertPayloadSchema.parse(raw);
      const lines = [`Memory key: ${p.key}`];
      if (p.tags.length > 0) lines.push(`Tags: ${p.tags.join(", ")}`);
      if (p.baseHash) lines.push("Replaces the current content of this key.");
      if (p.pointer) lines.push(`MEMORY.md "## ${p.pointer.section}": - ${p.pointer.line}`);
      lines.push("", p.content);
      return lines.join("\n");
    },
  };
}

export function createMemoryMdAppendHandler(deps: LearningKindHandlerDeps): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = MemoryMdAppendPayloadSchema.parse(raw);
      return { memoryMd: applyMemoryMdAppend(deps, p, ctx.backupDir) };
    },
    async undo(r) {
      if (!isMemoryMdResult(r.memoryMd)) throw new ProposalApplyError("invalid", "apply result has no MEMORY.md record");
      undoMemoryMd(r.memoryMd);
    },
    preview(raw) {
      const p = MemoryMdAppendPayloadSchema.parse(raw);
      return `MEMORY.md, section "## ${oneLine(p.section)}":\n- ${oneLine(p.line)}`;
    },
  };
}

export function createSkillCreateHandler(deps: LearningKindHandlerDeps): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = SkillCreatePayloadSchema.parse(raw);
      const dir = resolveSkillDir(deps.skillsRoot, p.name);
      if (pathExists(dir)) {
        throw new ProposalApplyError("conflict", `skill "${p.name}" already exists`);
      }
      mkdirSync(resolve(deps.skillsRoot), { recursive: true });
      assertNotSymlink(resolve(deps.skillsRoot), "the skills root");
      mkdirSync(dir);
      const file = join(dir, "SKILL.md");
      writeFileSync(file, p.skillMd, { encoding: "utf8", flag: "wx" });
      const hash = sha256Hex(p.skillMd);
      const at = (deps.now?.() ?? new Date()).toISOString();
      deps.skillState.upsertApproved({ name: p.name, root: "project", source: "learned", approvedHash: hash, at });
      return { skill: p.name, dir, file, hash, created: true, files: [file], proposalId: ctx.proposalId };
    },
    async undo(r) {
      const dir = String(r.dir);
      const name = String(r.skill);
      if (resolveSkillDir(deps.skillsRoot, name) !== dir) throw new ProposalApplyError("invalid", "apply result does not match the skills root");
      if (!existsSync(dir)) throw new ProposalApplyError("conflict", `skill "${name}" is no longer there`);
      assertNotSymlink(dir, "the skill directory");
      const current = readIfExists(join(dir, "SKILL.md"));
      if (current === null || sha256Hex(current) !== r.hash) {
        throw new ProposalApplyError("conflict", `skill "${name}" changed after it was created; not removing it`);
      }
      moveDir(dir, join(String(r.backupDir), "undone", name));
      const row = deps.skillState.get("project", name);
      if (row && row.source === "learned") deps.skillState.delete("project", name);
    },
    preview(raw) {
      const p = SkillCreatePayloadSchema.parse(raw);
      const lineCount = p.skillMd.split("\n").length;
      return [`New skill: ${p.name}`, `Description: ${p.description}`, `SKILL.md: ${lineCount} lines`, "", p.skillMd].join("\n");
    },
  };
}

function createSkillPatchLikeHandler(deps: LearningKindHandlerDeps, schema: typeof SkillPatchPayloadSchema | typeof SkillFixPayloadSchema): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = schema.parse(raw);
      const dir = resolveSkillDir(deps.skillsRoot, p.name);
      assertNotSymlink(dir, "the skill directory");
      const file = join(dir, "SKILL.md");
      assertNotSymlink(file, "SKILL.md");
      const current = readIfExists(file);
      if (current === null) throw new ProposalApplyError("stale", `skill "${p.name}" no longer exists`);
      if (sha256Hex(current) !== p.baseHash) throw new ProposalApplyError("stale", `skill "${p.name}" changed since the proposal was made`);
      const backupFile = join(ctx.backupDir, "SKILL.md");
      copyFileSync(file, backupFile);
      writeFileAtomic(file, p.newSkillMd);
      const hash = sha256Hex(p.newSkillMd);
      const at = (deps.now?.() ?? new Date()).toISOString();
      const row = deps.skillState.get("project", p.name);
      let overrideSet = false;
      if (row) {
        deps.skillState.setApprovedHash("project", p.name, hash, at);
        if (row.source === "bundled" && !row.override) {
          deps.skillState.setOverride("project", p.name, true);
          overrideSet = true;
        }
      } else {
        deps.skillState.insert({ name: p.name, root: "project", source: "local", approvedHash: hash, approvedAt: at });
      }
      return {
        skill: p.name, file, backupFile, previousHash: p.baseHash, hash, overrideSet,
        previousApprovedHash: row?.approvedHash ?? null, files: [file],
      };
    },
    async undo(r) {
      const name = String(r.skill);
      const file = join(resolveSkillDir(deps.skillsRoot, name), "SKILL.md");
      if (file !== r.file) throw new ProposalApplyError("invalid", "apply result does not match the skills root");
      assertNotSymlink(file, "SKILL.md");
      const current = readIfExists(file);
      if (current === null || sha256Hex(current) !== r.hash) {
        throw new ProposalApplyError("conflict", `skill "${name}" changed after the patch was applied; not restoring it`);
      }
      writeFileAtomic(file, readFileSync(String(r.backupFile), "utf8"));
      const at = (deps.now?.() ?? new Date()).toISOString();
      const prev = typeof r.previousApprovedHash === "string" ? r.previousApprovedHash : null;
      deps.skillState.setApprovedHash("project", name, prev, at);
      if (r.overrideSet === true) deps.skillState.setOverride("project", name, false);
    },
    preview(raw) {
      const p = schema.parse(raw);
      const lines = [`Skill update: ${p.name}`];
      if ("issue" in p && typeof p.issue === "string") lines.push(`Issue: ${p.issue}`);
      let current: string | null = null;
      try {
        current = readIfExists(join(resolveSkillDir(deps.skillsRoot, p.name), "SKILL.md"));
      } catch {
        current = null;
      }
      if (current === null) {
        lines.push("(the skill no longer exists)", "", p.newSkillMd);
      } else {
        if (sha256Hex(current) !== p.baseHash) lines.push("Warning: the skill changed since this was proposed; applying will fail as stale.");
        const st = diffStats(current, p.newSkillMd);
        lines.push(`Diff: +${st.added} -${st.removed} lines`, "", unifiedLineDiff(current, p.newSkillMd));
      }
      return lines.join("\n");
    },
  };
}

export function createSkillPatchHandler(deps: LearningKindHandlerDeps): ProposalKindHandler {
  return createSkillPatchLikeHandler(deps, SkillPatchPayloadSchema);
}

export function createSkillFixHandler(deps: LearningKindHandlerDeps): ProposalKindHandler {
  return createSkillPatchLikeHandler(deps, SkillFixPayloadSchema);
}

/** Register the five W2-LEARN kinds on an applier. */
export function registerLearningKindHandlers(applier: ProposalApplier, deps: LearningKindHandlerDeps): void {
  applier.registerKind("memory.upsert", createMemoryUpsertHandler(deps));
  applier.registerKind("memory_md.append", createMemoryMdAppendHandler(deps));
  applier.registerKind("skill.create", createSkillCreateHandler(deps));
  applier.registerKind("skill.patch", createSkillPatchHandler(deps));
  applier.registerKind("skill.fix", createSkillFixHandler(deps));
}
