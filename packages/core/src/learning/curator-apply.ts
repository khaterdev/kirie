/**
 * Curator proposal kinds (PLAN B.7, C.4, R4 item 4 "Apply = move, never delete"):
 * `skill.archive`, `skill.merge`, `skill.adopt`, `skill.revert`, plus the
 * owner-command restore.
 *
 * These handlers run only through `ProposalApplier.approve`, which needs an
 * owner approval minted by the `/proposals` command or the `prop` button
 * handler. Nothing here is reachable from an MCP tool or an HTTP route.
 *
 * - Archive moves `<skillsRoot>/<name>` to `<archiveRoot>/<name>@<stamp>` and
 *   writes `ARCHIVE.json` into it. Nothing is ever deleted: when a rename
 *   crosses devices the tree is copied, the copy is verified (file list and
 *   sizes), and only then is the source removed.
 * - Names are validated, paths are resolved and prefix-checked, and symlinked
 *   skill directories are never moved or written through.
 * - Every apply re-checks the state the proposal was made from (content hash,
 *   approved hash, pin) and refuses as `stale` when it changed.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v3";
import { ProposalApplyError, type ProposalApplier, type ProposalKindHandler } from "./applier.js";
import type { LearningAuditSink } from "./intake.js";
import { resolveSkillDir, writeFileAtomic } from "./kind-handlers.js";
import type { LearningDb } from "./learning-db.js";
import {
  SHA256_HEX_RE,
  SKILL_NAME_RE,
  SkillAdoptPayloadSchema,
  SkillArchivePayloadSchema,
  SkillMergePayloadSchema,
  SkillRevertPayloadSchema,
  sha256Hex,
} from "./proposal-types.js";
import type { SkillSource, SkillStateStore } from "./skill-state-store.js";
import { diffStats, unifiedLineDiff } from "./text-diff.js";

export const CURATOR_ARCHIVE_DIR = "skills-archive";
export const CURATOR_ARCHIVE_MANIFEST = "ARCHIVE.json";
const APPROVED_DIR = ".approved";
const RESTORED_DIR = ".restored";

/** `<dataDir>/skills-archive`: outside `.claude/skills`, so the SDK stops loading what is moved there. */
export function curatorArchiveRoot(dataDir: string): string {
  return join(dataDir, CURATOR_ARCHIVE_DIR);
}

/** Minimal fs surface the move uses, so tests can force the cross-device path. */
export interface CuratorFs {
  renameSync(from: string, to: string): void;
}

export interface CuratorApplyDeps {
  /** Project skills root, `<agentCwd>/.claude/skills` */
  skillsRoot: string;
  /** `<dataDir>/skills-archive` */
  archiveRoot: string;
  skillState: SkillStateStore;
  /** learning.db, for the one column the state store has no setter for (last_used_at on restore) */
  db: LearningDb;
  audit?: LearningAuditSink;
  now?: () => Date;
  fs?: CuratorFs;
  /**
   * Roots the curator must never change, whatever path aliases lead there
   * (`~/.claude/skills`). Compared by real path: a skills root equal to,
   * inside or containing one of these is refused.
   */
  forbiddenRoots?: readonly string[];
}

export interface CuratorArchiveManifest {
  name: string;
  source: string;
  reason: string;
  detector: string | null;
  proposalId: number | null;
  archivedAt: string;
  originalPath: string;
  absorbedInto: string | null;
}

export interface ArchivedSkillEntry {
  name: string;
  dir: string;
  manifest: CuratorArchiveManifest | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowOf(deps: Pick<CuratorApplyDeps, "now">): Date {
  return deps.now?.() ?? new Date();
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

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readIfFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function skillMdHash(dir: string): string | null {
  const text = readIfFile(join(dir, "SKILL.md"));
  return text === null ? null : sha256Hex(text);
}

function archiveStamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** `<root>/<child>` after checking the resolved path is a direct child of root. */
function childOf(root: string, child: string): string {
  const r = resolve(root);
  const p = resolve(r, child);
  if (!p.startsWith(r + sep) || dirname(p) !== r) throw new ProposalApplyError("invalid", "path escapes its root");
  return p;
}

/** Relative file list with sizes, symlinks listed as links (never followed). */
function treeListing(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      const rel = relative(dir, full);
      if (entry.isSymbolicLink()) out.set(`${rel}@link`, 0);
      else if (entry.isDirectory()) { out.set(`${rel}/`, 0); walk(full); }
      else out.set(rel, lstatSync(full).size);
    }
  };
  walk(dir);
  return out;
}

function sameListing(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Move a directory. A cross-device rename is a copy, a verification of the
 * copy's file list and sizes, then removal of the source. A failed
 * verification leaves the source untouched.
 */
export function moveSkillDir(from: string, to: string, fs: CuratorFs = { renameSync }): void {
  if (pathExists(to)) throw new ProposalApplyError("conflict", `${to} already exists`);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (!sameListing(treeListing(from), treeListing(to))) {
    throw new ProposalApplyError("conflict", `copy of ${from} does not match the original; the original was left in place`);
  }
  rmSync(from, { recursive: true });
}

function uniqueArchiveTarget(archiveRoot: string, name: string, at: Date): string {
  const base = `${name}@${archiveStamp(at)}`;
  for (let i = 1; i < 1000; i++) {
    const candidate = childOf(archiveRoot, i === 1 ? base : `${base}-${i}`);
    if (!pathExists(candidate)) return candidate;
  }
  throw new ProposalApplyError("conflict", `no free archive name for "${name}"`);
}

function ensureArchiveRoot(archiveRoot: string): string {
  const root = resolve(archiveRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (isSymlink(root)) throw new ProposalApplyError("invalid", "the skills archive is a symlink");
  return root;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

function skillDirFor(deps: Pick<CuratorApplyDeps, "skillsRoot" | "forbiddenRoots">, name: string): string {
  const dir = resolveSkillDir(deps.skillsRoot, name);
  if (isSymlink(resolve(deps.skillsRoot))) throw new ProposalApplyError("invalid", "the skills root is a symlink");
  const realRoot = realOrSelf(deps.skillsRoot);
  for (const forbidden of deps.forbiddenRoots ?? []) {
    if (overlaps(realRoot, realOrSelf(forbidden))) {
      throw new ProposalApplyError("invalid", "the skills root is (or overlaps) a root the curator never changes");
    }
  }
  // A parent directory that is a symlink must not lead the skill path elsewhere.
  if (pathExists(dir) && dirname(realOrSelf(dir)) !== realRoot && !isSymlink(dir)) {
    throw new ProposalApplyError("invalid", "the skill path resolves outside the skills root");
  }
  return dir;
}

function setLastUsed(db: LearningDb, name: string, at: string): void {
  db.prepare("UPDATE skill_state SET last_used_at = ? WHERE root = 'project' AND name = ?").run(at, name);
}

function ensureStateRow(deps: CuratorApplyDeps, name: string, source: SkillSource = "local"): void {
  deps.skillState.insert({ name, root: "project", source, firstSeenAt: nowOf(deps).toISOString() });
}

// ---------------------------------------------------------------------------
// Approved copies (for skill.revert)
// ---------------------------------------------------------------------------

/** `<archiveRoot>/.approved/<name>/<hash>.md`: the content a skill had when it was last approved or adopted. */
export function skillApprovedCopyPath(archiveRoot: string, name: string, hash: string): string {
  if (!SKILL_NAME_RE.test(name)) throw new ProposalApplyError("invalid", `invalid skill name "${name}"`);
  if (!SHA256_HEX_RE.test(hash)) throw new ProposalApplyError("invalid", "invalid content hash");
  return join(resolve(archiveRoot), APPROVED_DIR, name, `${hash}.md`);
}

/** Keep a copy of approved content. Idempotent; returns false when the content does not match its name. */
export function saveSkillApprovedCopy(archiveRoot: string, name: string, content: string): boolean {
  const hash = sha256Hex(content);
  const file = skillApprovedCopyPath(archiveRoot, name, hash);
  const root = ensureArchiveRoot(archiveRoot);
  // Every directory on the way must be a real directory, never a symlink.
  for (const d of [join(root, APPROVED_DIR), dirname(file)]) {
    if (isSymlink(d)) throw new ProposalApplyError("invalid", "the approved-copy directory is a symlink");
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  if (pathExists(file)) return !isSymlink(file) && readSkillApprovedCopy(archiveRoot, name, hash) !== null;
  // "wx" fails on any existing entry, including a symlink planted in between.
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return true;
}

/** The approved copy, only when it exists and still hashes to its name. */
export function readSkillApprovedCopy(archiveRoot: string, name: string, hash: string): string | null {
  let file: string;
  try {
    file = skillApprovedCopyPath(archiveRoot, name, hash);
  } catch {
    return null;
  }
  const text = readIfFile(file);
  return text !== null && sha256Hex(text) === hash ? text : null;
}

// ---------------------------------------------------------------------------
// Archive and restore
// ---------------------------------------------------------------------------

function readManifest(dir: string): CuratorArchiveManifest | null {
  const text = readIfFile(join(dir, CURATOR_ARCHIVE_MANIFEST));
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<CuratorArchiveManifest>;
    return typeof v.name === "string" && typeof v.archivedAt === "string" ? (v as CuratorArchiveManifest) : null;
  } catch {
    return null;
  }
}

/** Archived skill directories, newest first. Only `<name>@<stamp>` directories (not symlinks) count. */
export function listArchivedSkills(archiveRoot: string, name?: string): ArchivedSkillEntry[] {
  const root = resolve(archiveRoot);
  if (!existsSync(root) || isSymlink(root)) return [];
  const out: ArchivedSkillEntry[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const at = entry.name.indexOf("@");
    if (at <= 0) continue;
    const skill = entry.name.slice(0, at);
    if (!SKILL_NAME_RE.test(skill) || (name !== undefined && skill !== name)) continue;
    const dir = join(root, entry.name);
    const manifest = readManifest(dir);
    if (manifest && manifest.name !== skill) continue;
    out.push({ name: skill, dir, manifest });
  }
  return out.sort((a, b) => {
    const ta = a.manifest?.archivedAt ?? "";
    const tb = b.manifest?.archivedAt ?? "";
    return ta === tb ? b.dir.localeCompare(a.dir) : tb.localeCompare(ta);
  });
}

interface ArchiveInput {
  name: string;
  reason: string;
  detector: string | null;
  proposalId: number | null;
  absorbedInto: string | null;
}

interface ArchivedRecord {
  name: string;
  from: string;
  to: string;
  archivedAt: string;
}

function archiveOne(deps: CuratorApplyDeps, input: ArchiveInput): ArchivedRecord {
  const from = skillDirFor(deps, input.name);
  if (!pathExists(from)) throw new ProposalApplyError("stale", `skill "${input.name}" no longer exists`);
  if (isSymlink(from)) throw new ProposalApplyError("invalid", `skill "${input.name}" is a symlink; the curator never moves symlinks`);
  if (!lstatSync(from).isDirectory()) throw new ProposalApplyError("invalid", `skill "${input.name}" is not a directory`);
  if (pathExists(join(from, CURATOR_ARCHIVE_MANIFEST))) {
    throw new ProposalApplyError("invalid", `skill "${input.name}" contains its own ${CURATOR_ARCHIVE_MANIFEST}; archive it by hand`);
  }
  const root = ensureArchiveRoot(deps.archiveRoot);
  const at = nowOf(deps);
  const to = uniqueArchiveTarget(root, input.name, at);
  const row = deps.skillState.get("project", input.name);
  moveSkillDir(from, to, deps.fs);
  try {
    return finishArchive(deps, input, { from, to, at, source: row?.source ?? "local", hadRow: row !== null });
  } catch (err) {
    // Put everything back: the manifest we wrote goes to .restored, the directory to its place.
    try {
      const manifestFile = join(to, CURATOR_ARCHIVE_MANIFEST);
      if (pathExists(manifestFile) && !isSymlink(manifestFile)) {
        const keep = join(root, RESTORED_DIR);
        mkdirSync(keep, { recursive: true, mode: 0o700 });
        renameSync(manifestFile, join(keep, `${to.slice(root.length + 1)}.failed.json`));
      }
      moveSkillDir(to, from, deps.fs);
    } catch (rollbackErr) {
      const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new ProposalApplyError("conflict", `archiving "${input.name}" failed and moving it back failed too (${msg}); it is at ${to}`);
    }
    throw err;
  }
}

function finishArchive(
  deps: CuratorApplyDeps,
  input: ArchiveInput,
  m: { from: string; to: string; at: Date; source: string; hadRow: boolean },
): ArchivedRecord {
  const { from, to, at } = m;
  const manifest: CuratorArchiveManifest = {
    name: input.name,
    source: m.source,
    reason: input.reason,
    detector: input.detector,
    proposalId: input.proposalId,
    archivedAt: at.toISOString(),
    originalPath: from,
    absorbedInto: input.absorbedInto,
  };
  // "wx": never through a symlink, never over an existing file.
  writeFileSync(join(to, CURATOR_ARCHIVE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (!m.hadRow) ensureStateRow(deps, input.name);
  deps.skillState.markArchived("project", input.name, { archivedAt: manifest.archivedAt, archivePath: to, absorbedInto: input.absorbedInto });
  return { name: input.name, from, to, archivedAt: manifest.archivedAt };
}

/** Move an archived dir back to `from`. The manifest goes to `<archiveRoot>/.restored/`, never deleted. */
function unarchiveOne(deps: CuratorApplyDeps, rec: { name: string; from: string; to: string }): void {
  const from = skillDirFor(deps, rec.name);
  if (from !== rec.from) throw new ProposalApplyError("invalid", "archive record does not match the skills root");
  const root = resolve(deps.archiveRoot);
  const archived = resolve(rec.to);
  if (!archived.startsWith(root + sep) || dirname(archived) !== root) throw new ProposalApplyError("invalid", "archive record is outside the archive");
  if (!pathExists(archived)) throw new ProposalApplyError("conflict", `the archived copy of "${rec.name}" is gone`);
  if (isSymlink(archived)) throw new ProposalApplyError("invalid", "the archived copy is a symlink");
  if (pathExists(from)) throw new ProposalApplyError("conflict", `a skill named "${rec.name}" exists again; not overwriting it`);
  const manifestFile = join(archived, CURATOR_ARCHIVE_MANIFEST);
  let movedManifest: string | null = null;
  if (pathExists(manifestFile) && !isSymlink(manifestFile)) {
    const keep = join(root, RESTORED_DIR);
    mkdirSync(keep, { recursive: true, mode: 0o700 });
    movedManifest = join(keep, `${archived.slice(root.length + 1)}.${archiveStamp(nowOf(deps))}.json`);
    renameSync(manifestFile, movedManifest);
  }
  try {
    moveSkillDir(archived, from, deps.fs);
  } catch (err) {
    if (movedManifest) renameSync(movedManifest, manifestFile);
    throw err;
  }
  ensureStateRow(deps, rec.name);
  deps.skillState.markRestored("project", rec.name);
}

export type RestoreOutcome =
  | { ok: true; name: string; from: string; to: string }
  | { ok: false; code: "invalid" | "not_found" | "exists" | "failed"; message: string };

/**
 * `/curator restore <name>`: move the newest archive of a skill back. Refuses
 * when the name exists again. Marks the skill used now so it is not flagged
 * stale straight away. An owner command, not a proposal.
 */
export function restoreArchivedSkill(deps: CuratorApplyDeps, name: string, actor = "system"): RestoreOutcome {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, code: "invalid", message: `"${name}" is not a valid skill name.` };
  let target: string;
  try {
    target = skillDirFor(deps, name);
  } catch (err) {
    return { ok: false, code: "invalid", message: err instanceof Error ? err.message : String(err) };
  }
  if (pathExists(target)) return { ok: false, code: "exists", message: `A skill named "${name}" already exists; not overwriting it.` };
  const newest = listArchivedSkills(deps.archiveRoot, name)[0];
  if (!newest) return { ok: false, code: "not_found", message: `No archived copy of "${name}".` };
  try {
    unarchiveOne(deps, { name, from: target, to: newest.dir });
  } catch (err) {
    return { ok: false, code: "failed", message: err instanceof Error ? err.message : String(err) };
  }
  const at = nowOf(deps).toISOString();
  setLastUsed(deps.db, name, at);
  deps.audit?.record({ feature: "curator", action: "skill.restored", actor, detail: { skill: name, from: newest.dir } });
  return { ok: true, name, from: newest.dir, to: target };
}

// ---------------------------------------------------------------------------
// Kind handlers
// ---------------------------------------------------------------------------

/** Curator fields carried in the passthrough part of the archive payload. */
const ArchiveExtras = z.object({
  /** sha256 of SKILL.md when proposed; null when the skill had no SKILL.md (B1) */
  contentHash: z.string().regex(SHA256_HEX_RE).nullable().optional(),
  absorbedInto: z.string().regex(SKILL_NAME_RE).nullable().optional(),
}).passthrough();

function isArchivedRecord(v: unknown): v is ArchivedRecord {
  const r = v as ArchivedRecord;
  return !!r && typeof r.name === "string" && typeof r.from === "string" && typeof r.to === "string";
}

export function createSkillArchiveHandler(deps: CuratorApplyDeps): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = SkillArchivePayloadSchema.parse(raw);
      const extra = ArchiveExtras.parse(raw);
      const dir = skillDirFor(deps, p.name);
      if (!pathExists(dir)) throw new ProposalApplyError("stale", `skill "${p.name}" no longer exists`);
      if (extra.contentHash !== undefined && skillMdHash(dir) !== extra.contentHash) {
        throw new ProposalApplyError("stale", `skill "${p.name}" changed since the proposal was made`);
      }
      if (extra.contentHash === null && pathExists(join(dir, "SKILL.md"))) {
        throw new ProposalApplyError("stale", `skill "${p.name}" has a SKILL.md now`);
      }
      const keeperOf = deps.skillState.list({ root: "project", state: "archived" }).filter((r) => r.absorbedInto === p.name).map((r) => r.name);
      if (keeperOf.length > 0) {
        throw new ProposalApplyError("conflict", `skill "${p.name}" is the copy kept for ${keeperOf.join(", ")}; restore those first if you want to archive it`);
      }
      if (deps.skillState.get("project", p.name)?.pinned) {
        throw new ProposalApplyError("stale", `skill "${p.name}" is pinned`);
      }
      if (extra.absorbedInto && !pathExists(skillDirFor(deps, extra.absorbedInto))) {
        throw new ProposalApplyError("stale", `skill "${extra.absorbedInto}" it duplicates no longer exists`);
      }
      const rec = archiveOne(deps, {
        name: p.name,
        reason: p.reason,
        detector: p.evidence.detector,
        proposalId: ctx.proposalId,
        absorbedInto: extra.absorbedInto ?? null,
      });
      deps.audit?.record({ feature: "curator", action: "skill.archived", actor: "system", detail: { skill: p.name, proposalId: ctx.proposalId, to: rec.to } });
      return { skill: p.name, archived: [rec], from: rec.from, to: rec.to };
    },
    async undo(r) {
      const recs = Array.isArray(r.archived) ? r.archived.filter(isArchivedRecord) : [];
      if (recs.length !== 1) throw new ProposalApplyError("invalid", "apply result has no archive record");
      const rec = recs[0]!;
      if (pathExists(rec.from) && !pathExists(rec.to)) return; // already restored (a retried undo)
      unarchiveOne(deps, rec);
    },
    preview(raw) {
      const p = SkillArchivePayloadSchema.parse(raw);
      const extra = ArchiveExtras.parse(raw);
      const lines = [
        `Archive skill: ${p.name}`,
        `Reason: ${p.reason}`,
        `Last used: ${p.evidence.lastUsedAt ? p.evidence.lastUsedAt.slice(0, 10) : "never recorded"} · uses recorded: ${p.evidence.useCount}`,
      ];
      if (extra.absorbedInto) lines.push(`Duplicate of: ${extra.absorbedInto} (that skill stays)`);
      lines.push(
        "The directory is moved to ~/.kirie/skills-archive with a manifest; nothing is deleted.",
        `Bring it back any time with /curator restore ${p.name}.`,
      );
      return lines.join("\n");
    },
  };
}

interface MergeApplyResult {
  into: string;
  file: string;
  backupFile: string;
  hash: string;
  previousApprovedHash: string | null;
  archived: ArchivedRecord[];
}

function isMergeResult(v: Record<string, unknown>): v is Record<string, unknown> & MergeApplyResult {
  return typeof v.into === "string" && typeof v.file === "string" && typeof v.backupFile === "string" && typeof v.hash === "string" && Array.isArray(v.archived);
}

export function createSkillMergeHandler(deps: CuratorApplyDeps): ProposalKindHandler {
  const refuseBundled = (name: string): void => {
    if (deps.skillState.get("project", name)?.source === "bundled") {
      throw new ProposalApplyError("invalid", `"${name}" is a bundled skill; the curator never merges bundled skills`);
    }
  };
  return {
    async apply(raw, ctx) {
      const p = SkillMergePayloadSchema.parse(raw);
      const from = [...new Set(p.from)];
      if (from.includes(p.into)) throw new ProposalApplyError("invalid", "a skill cannot be merged into itself");
      for (const name of [p.into, ...from]) {
        refuseBundled(name);
        const dir = skillDirFor(deps, name);
        if (!pathExists(dir)) throw new ProposalApplyError("stale", `skill "${name}" no longer exists`);
        if (isSymlink(dir)) throw new ProposalApplyError("invalid", `skill "${name}" is a symlink`);
        const expected = p.baseHashes[name];
        if (!expected) throw new ProposalApplyError("invalid", `no base hash for "${name}"`);
        if (skillMdHash(dir) !== expected) throw new ProposalApplyError("stale", `skill "${name}" changed since the proposal was made`);
        const row = deps.skillState.get("project", name);
        if (row?.pinned && name !== p.into) throw new ProposalApplyError("stale", `skill "${name}" is pinned`);
        // A merge records the result as approved: only approved content may go into it (LEARN-B1).
        if (row?.approvedHash !== expected) throw new ProposalApplyError("stale", `skill "${name}" has content you have not approved; approve or revert that change first`);
      }
      const archivedRows = deps.skillState.list({ root: "project", state: "archived" });
      for (const name of from) {
        const kept = archivedRows.filter((r) => r.absorbedInto === name).map((r) => r.name);
        if (kept.length > 0) throw new ProposalApplyError("conflict", `skill "${name}" is the copy kept for ${kept.join(", ")}`);
      }

      const file = join(skillDirFor(deps, p.into), "SKILL.md");
      if (isSymlink(file)) throw new ProposalApplyError("invalid", "SKILL.md is a symlink");
      const backupFile = join(ctx.backupDir, `${p.into}.SKILL.md`);
      writeFileSync(backupFile, readFileSync(file, "utf8"), { encoding: "utf8", mode: 0o600 });
      const previousApprovedHash = deps.skillState.get("project", p.into)?.approvedHash ?? null;

      // All or nothing: undo every step taken so far when a later one fails.
      const archived: ArchivedRecord[] = [];
      writeFileAtomic(file, p.mergedSkillMd);
      try {
        for (const name of from) {
          archived.push(archiveOne(deps, {
            name,
            reason: `merged into ${p.into}`,
            detector: "merge",
            proposalId: ctx.proposalId,
            absorbedInto: p.into,
          }));
        }
      } catch (err) {
        const stuck: string[] = [];
        for (const rec of archived.reverse()) {
          try { unarchiveOne(deps, rec); } catch { stuck.push(`${rec.name} (at ${rec.to})`); }
        }
        writeFileAtomic(file, readFileSync(backupFile, "utf8"));
        if (stuck.length > 0) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new ProposalApplyError("conflict", `merge failed (${msg}) and these stayed archived: ${stuck.join(", ")}; restore them with /curator restore`);
        }
        throw err;
      }
      const hash = sha256Hex(p.mergedSkillMd);
      const at = nowOf(deps).toISOString();
      ensureStateRow(deps, p.into);
      deps.skillState.setApprovedHash("project", p.into, hash, at);
      saveSkillApprovedCopy(deps.archiveRoot, p.into, p.mergedSkillMd);
      deps.audit?.record({ feature: "curator", action: "skill.merged", actor: "system", detail: { into: p.into, from, proposalId: ctx.proposalId } });
      const result: MergeApplyResult = { into: p.into, file, backupFile, hash, previousApprovedHash, archived };
      return { ...result, files: [file] };
    },
    async undo(r) {
      if (!isMergeResult(r)) throw new ProposalApplyError("invalid", "apply result has no merge record");
      const file = join(skillDirFor(deps, r.into), "SKILL.md");
      if (file !== r.file) throw new ProposalApplyError("invalid", "apply result does not match the skills root");
      const current = readIfFile(file);
      const backup = readFileSync(r.backupFile, "utf8");
      const intoRestored = current === backup;
      if (!intoRestored && (current === null || sha256Hex(current) !== r.hash)) {
        throw new ProposalApplyError("conflict", `skill "${r.into}" changed after the merge; not undoing it`);
      }
      for (const rec of r.archived.filter(isArchivedRecord)) {
        if (pathExists(rec.from) && !pathExists(rec.to)) continue;
        unarchiveOne(deps, rec);
      }
      if (!intoRestored) writeFileAtomic(file, backup);
      deps.skillState.setApprovedHash("project", r.into, r.previousApprovedHash, nowOf(deps).toISOString());
    },
    preview(raw) {
      const p = SkillMergePayloadSchema.parse(raw);
      const lines = [`Merge skills into ${p.into}: ${p.from.join(", ")}`, `The merged skills are archived (restorable with /curator restore <name>).`];
      const current = readIfFile(join(skillDirFor(deps, p.into), "SKILL.md"));
      if (current === null) {
        lines.push("", p.mergedSkillMd);
      } else {
        const st = diffStats(current, p.mergedSkillMd);
        lines.push(`Diff for ${p.into}: +${st.added} -${st.removed} lines`, "", unifiedLineDiff(current, p.mergedSkillMd));
      }
      return lines.join("\n");
    },
  };
}

function checkDriftState(deps: CuratorApplyDeps, name: string, currentHash: string, approvedHash: string | null): { dir: string; text: string } {
  const dir = skillDirFor(deps, name);
  if (isSymlink(dir)) throw new ProposalApplyError("invalid", `skill "${name}" is a symlink`);
  const file = join(dir, "SKILL.md");
  if (isSymlink(file)) throw new ProposalApplyError("invalid", "SKILL.md is a symlink");
  const text = readIfFile(file);
  if (text === null) throw new ProposalApplyError("stale", `skill "${name}" no longer has a SKILL.md`);
  if (sha256Hex(text) !== currentHash) throw new ProposalApplyError("stale", `skill "${name}" changed again since the proposal was made`);
  const row = deps.skillState.get("project", name);
  if ((row?.approvedHash ?? null) !== approvedHash) throw new ProposalApplyError("stale", `the approved version of "${name}" changed since the proposal was made`);
  return { dir, text };
}

export function createSkillAdoptHandler(deps: CuratorApplyDeps): ProposalKindHandler {
  return {
    async apply(raw) {
      const p = SkillAdoptPayloadSchema.parse(raw);
      const { text } = checkDriftState(deps, p.name, p.currentHash, p.approvedHash);
      const at = nowOf(deps).toISOString();
      ensureStateRow(deps, p.name);
      deps.skillState.setApprovedHash("project", p.name, p.currentHash, at);
      saveSkillApprovedCopy(deps.archiveRoot, p.name, text);
      deps.audit?.record({ feature: "curator", action: "skill.adopted", actor: "system", detail: { skill: p.name, hash8: p.currentHash.slice(0, 8) } });
      return { skill: p.name, hash: p.currentHash, previousApprovedHash: p.approvedHash };
    },
    async undo(r) {
      const name = String(r.skill);
      if (!SKILL_NAME_RE.test(name)) throw new ProposalApplyError("invalid", "apply result has no skill name");
      const row = deps.skillState.get("project", name);
      if (row?.approvedHash !== r.hash) throw new ProposalApplyError("conflict", `the approved version of "${name}" changed after the adoption`);
      const prev = typeof r.previousApprovedHash === "string" ? r.previousApprovedHash : null;
      deps.skillState.setApprovedHash("project", name, prev, nowOf(deps).toISOString());
    },
    preview(raw) {
      const p = SkillAdoptPayloadSchema.parse(raw);
      const lines = [
        `Keep the current version of skill ${p.name}`,
        p.approvedHash
          ? "Its SKILL.md changed outside an approved change. Approving records the current content as approved."
          : "This skill appeared without an approved change. Approving records its current content as approved.",
      ];
      const current = readIfFile(join(skillDirFor(deps, p.name), "SKILL.md"));
      const approved = p.approvedHash ? readSkillApprovedCopy(deps.archiveRoot, p.name, p.approvedHash) : null;
      if (current !== null && approved !== null) {
        const st = diffStats(approved, current);
        lines.push(`Changes since approval: +${st.added} -${st.removed} lines`, "", unifiedLineDiff(approved, current));
      } else if (current !== null) {
        lines.push("", current);
      }
      return lines.join("\n");
    },
  };
}

export function createSkillRevertHandler(deps: CuratorApplyDeps): ProposalKindHandler {
  return {
    async apply(raw, ctx) {
      const p = SkillRevertPayloadSchema.parse(raw);
      if (!p.approvedHash) throw new ProposalApplyError("invalid", "there is no approved version to revert to");
      const { dir } = checkDriftState(deps, p.name, p.currentHash, p.approvedHash);
      const approved = readSkillApprovedCopy(deps.archiveRoot, p.name, p.approvedHash);
      if (approved === null) throw new ProposalApplyError("invalid", `no saved copy of the approved version of "${p.name}"`);
      const file = join(dir, "SKILL.md");
      const backupFile = join(ctx.backupDir, "SKILL.md");
      writeFileSync(backupFile, readFileSync(file, "utf8"), { encoding: "utf8", mode: 0o600 });
      writeFileAtomic(file, approved);
      deps.audit?.record({ feature: "curator", action: "skill.reverted", actor: "system", detail: { skill: p.name, hash8: p.approvedHash.slice(0, 8) } });
      return { skill: p.name, file, backupFile, hash: p.approvedHash, previousHash: p.currentHash, files: [file] };
    },
    async undo(r) {
      const name = String(r.skill);
      const file = join(skillDirFor(deps, name), "SKILL.md");
      if (file !== r.file) throw new ProposalApplyError("invalid", "apply result does not match the skills root");
      const current = readIfFile(file);
      const backup = readFileSync(String(r.backupFile), "utf8");
      if (current === backup) return;
      if (current === null || sha256Hex(current) !== r.hash) throw new ProposalApplyError("conflict", `skill "${name}" changed after the revert`);
      writeFileAtomic(file, backup);
    },
    preview(raw) {
      const p = SkillRevertPayloadSchema.parse(raw);
      const lines = [`Revert skill ${p.name} to its last approved version`, "Its SKILL.md changed outside an approved change."];
      const current = readIfFile(join(skillDirFor(deps, p.name), "SKILL.md"));
      const approved = p.approvedHash ? readSkillApprovedCopy(deps.archiveRoot, p.name, p.approvedHash) : null;
      if (approved === null) lines.push("(no saved copy of the approved version; this cannot be applied)");
      else if (current !== null) {
        const st = diffStats(current, approved);
        lines.push(`Diff: +${st.added} -${st.removed} lines`, "", unifiedLineDiff(current, approved));
      }
      return lines.join("\n");
    },
  };
}

/** Register the four curator kinds on the learning applier (PLAN B.7). */
export function registerCuratorKindHandlers(applier: ProposalApplier, deps: CuratorApplyDeps): void {
  applier.registerKind("skill.archive", createSkillArchiveHandler(deps));
  applier.registerKind("skill.merge", createSkillMergeHandler(deps));
  applier.registerKind("skill.adopt", createSkillAdoptHandler(deps));
  applier.registerKind("skill.revert", createSkillRevertHandler(deps));
}
