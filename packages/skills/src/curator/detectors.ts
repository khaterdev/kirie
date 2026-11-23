/**
 * Curator detectors (PLAN C.4, R4 item 4 "Detectors"). Pure functions over
 * `SkillSnapshot[]`: no model, no network, no file access. Anything that
 * depends on the machine (bins on PATH, eligibility) comes in through
 * `DetectorEnv`.
 *
 * Broken: B1 to B10 (plus symlinked and nested skill dirs, reported as warn).
 * Duplicate: D1 exact content, D2 same name in both roots, D3 name and
 * description similarity, D4 body similarity (confirming).
 * Stale: no recorded use for `staleAfterDays` (state change) or
 * `archiveAfterDays` (archive proposal), with grace rules.
 * Drift: content hash differs from the approved hash.
 */

import type { CuratorFinding } from "@kirie/core";
import { clusterPairs, jaccard, nameTokens, termCosine, vectorCosine, type ScoredPair } from "./similarity.js";
import { frontmatterDescription, frontmatterName, type SkillSnapshot } from "./snapshot.js";
import type { SkillDefinition } from "../types.js";

export interface DetectorEnv {
  binExists(bin: string): boolean;
  /** Platform, for `os` requirements */
  platform: string;
  /** Environment variable names that are set (values are never read by detectors) */
  hasEnv(name: string): boolean;
  /** Code scanner over fenced blocks */
  scanCode(code: string): Array<{ severity: "block" | "warn" | "info"; description: string }>;
}

export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_BODY_CHARS = 24_000;

function finding(s: SkillSnapshot, detector: string, category: CuratorFinding["category"], severity: CuratorFinding["severity"], message: string, data?: Record<string, unknown>): CuratorFinding {
  return { skill: s.name, root: s.root, detector, category, severity, message, ...(data ? { data } : {}) };
}

// ---------------------------------------------------------------------------
// Broken
// ---------------------------------------------------------------------------

/** Requirements of a skill definition that this machine does not meet. Env names only, never values. */
export function missingRequirements(def: Pick<SkillDefinition, "os" | "requires">, env: DetectorEnv): string[] {
  const out: string[] = [];
  if (Array.isArray(def.os) && def.os.length > 0 && !def.os.includes(env.platform as "darwin")) {
    out.push(`os ${def.os.join("/")}`);
  }
  const req = def.requires;
  if (req && typeof req === "object") {
    for (const bin of Array.isArray(req.bins) ? req.bins : []) if (typeof bin === "string" && !env.binExists(bin)) out.push(`bin ${bin}`);
    const any = Array.isArray(req.anyBins) ? req.anyBins.filter((b): b is string => typeof b === "string") : [];
    if (any.length > 0 && !any.some((b) => env.binExists(b))) out.push(`one of ${any.join(", ")}`);
    for (const name of Array.isArray(req.env) ? req.env : []) if (typeof name === "string" && !env.hasEnv(name)) out.push(`env ${name}`);
  }
  return out;
}

const REF_PREFIXES = ["scripts/", "references/", "assets/", "./"];

/** Relative files a SKILL.md body points at: markdown links and backticked paths (B6). */
export function referencedFiles(body: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string): void => {
    let p = raw.trim().replace(/^<|>$/g, "");
    p = p.split(/[?#]/)[0] ?? "";
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("/") || p.startsWith("~") || p.startsWith("../") || /\s/.test(p)) return;
    if (p.includes("*") || p.includes("$") || p.includes("{") || p.includes("<")) return;
    p = p.replace(/^\.\//, "");
    if (p && p !== "." && p !== "SKILL.md") refs.add(p.replace(/\/$/, ""));
  };
  // Code fences contain commands, not references.
  const prose = body.replace(/```[\s\S]*?```/g, "");
  for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) add(m[1] ?? "");
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const t = (m[1] ?? "").trim();
    if (REF_PREFIXES.some((pre) => t.startsWith(pre))) add(t);
  }
  return [...refs].sort();
}

function fencedBlocks(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(m[1] ?? "");
  return out;
}

/** Declared requirements of a non-bundled skill: top-level `requires` or `metadata.requires`. */
function declaredRequires(fm: Record<string, unknown> | null): SkillDefinition["requires"] | undefined {
  if (!fm) return undefined;
  const top = fm.requires;
  if (top && typeof top === "object" && !Array.isArray(top)) return top as SkillDefinition["requires"];
  const meta = fm.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const r = (meta as Record<string, unknown>).requires;
    if (r && typeof r === "object" && !Array.isArray(r)) return r as SkillDefinition["requires"];
  }
  return undefined;
}

export function detectBroken(snapshots: readonly SkillSnapshot[], env: DetectorEnv): CuratorFinding[] {
  const out: CuratorFinding[] = [];
  for (const s of snapshots) {
    if (s.state?.state === "archived") continue;
    if (s.isSymlink) out.push(finding(s, "symlink", "broken", "warn", "The skill directory is a symlink; the curator never moves symlinks."));
    if (s.nestedSkills.length > 0) {
      out.push(finding(s, "nested", "broken", "warn", `Contains nested skills: ${s.nestedSkills.slice(0, 5).join(", ")}.`, { nested: s.nestedSkills.slice(0, 20) }));
    }
    if (s.raw === null) {
      out.push(finding(s, "B1", "broken", "error", s.frontmatterError ?? "The directory has no SKILL.md."));
      continue;
    }
    if (s.frontmatter === null) {
      out.push(finding(s, "B2", "broken", "error", `No valid frontmatter (${s.frontmatterError ?? "invalid"}); the skill may not load.`));
    } else {
      const name = frontmatterName(s);
      const description = frontmatterDescription(s);
      const missing = [name ? null : "name", description ? null : "description"].filter((x): x is string => x !== null);
      if (missing.length > 0) {
        out.push(finding(s, "B3", "broken", "error", `Frontmatter is missing ${missing.join(" and ")}.`, { missing }));
      }
      if (name && name !== s.name) {
        out.push(finding(s, "B4", "broken", "warn", `Frontmatter name "${name.slice(0, 64)}" differs from the directory name.`));
      }
      if (description && (description.length > MAX_DESCRIPTION_CHARS || /[<>]/.test(description))) {
        out.push(finding(s, "B5", "broken", "warn", description.length > MAX_DESCRIPTION_CHARS
          ? `Description is ${description.length} characters (max ${MAX_DESCRIPTION_CHARS}).`
          : "Description contains < or >."));
      }
    }

    const present = new Set(s.files.map((f) => f.replace(/[/@]$/, "")));
    const missingRefs = referencedFiles(s.body).filter((r) => !present.has(r));
    if (missingRefs.length > 0) {
      out.push(finding(s, "B6", "broken", "warn", `References missing files: ${missingRefs.slice(0, 5).join(", ")}.`, { missing: missingRefs.slice(0, 20) }));
    }

    if (s.source === "bundled" && s.bundledOriginal) {
      const unmet = missingRequirements(s.bundledOriginal, env);
      if (unmet.length > 0) {
        out.push(finding(s, "B7", "broken", "error", `Bundled skill is no longer eligible here (missing ${unmet.join(", ")}) but its synced copy is still loaded.`, { missing: unmet }));
      }
    } else if (s.source !== "bundled") {
      const req = declaredRequires(s.frontmatter);
      if (req) {
        const unmetBins = missingRequirements({ requires: { ...(req.bins ? { bins: req.bins } : {}), ...(req.anyBins ? { anyBins: req.anyBins } : {}) } }, env);
        if (unmetBins.length > 0) {
          out.push(finding(s, "B8", "broken", "warn", `Declares requirements that are missing: ${unmetBins.join(", ")}.`, { missing: unmetBins }));
        }
      }
    }

    if (s.body.length > MAX_BODY_CHARS) {
      out.push(finding(s, "B9", "broken", "info", `Body is ${s.body.length} characters (over ${MAX_BODY_CHARS}).`));
    }
    const blocks = fencedBlocks(s.body).flatMap((b) => env.scanCode(b)).filter((r) => r.severity === "block");
    if (blocks.length > 0) {
      out.push(finding(s, "B10", "broken", "warn", `Code scanner: ${[...new Set(blocks.map((b) => b.description))].slice(0, 3).join("; ")}.`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface DuplicateVectors {
  /** Embedding of `name + ": " + description`, by skill name (project root) */
  nameDescription: ReadonlyMap<string, readonly number[]>;
  /** Embedding of the first 2000 body characters, by skill name */
  body: ReadonlyMap<string, readonly number[]>;
}

export interface DuplicateOptions {
  /** curator.duplicateThreshold (D3 embedding cosine) */
  threshold: number;
  /** Null when no embedder is available: D3 runs only its name-Jaccard half, lexically */
  vectors: DuplicateVectors | null;
  maxClusterSize?: number;
}

export interface ExactDuplicate {
  /** The skill to archive */
  archive: string;
  /** The skill that stays */
  keep: string;
}

export interface DuplicateResult {
  findings: CuratorFinding[];
  /** D1 pairs, already resolved to which one to archive */
  exact: ExactDuplicate[];
  /** D3 clusters (members are project skills); `likely` when D4 holds for a pair inside */
  clusters: Array<{ members: string[]; likely: boolean }>;
}

const NAME_JACCARD = 0.6;
const DESCRIPTION_COSINE = 0.8;
const BODY_COSINE = 0.92;
const BODY_CHARS = 2000;

/** D1 tie-break: archive the one with fewer uses, then the newer one; never prefer archiving a bundled skill. */
function pickArchive(a: SkillSnapshot, b: SkillSnapshot): ExactDuplicate {
  const bundledA = a.source === "bundled", bundledB = b.source === "bundled";
  if (bundledA !== bundledB) return bundledA ? { archive: b.name, keep: a.name } : { archive: a.name, keep: b.name };
  const ua = a.state?.useCount ?? 0, ub = b.state?.useCount ?? 0;
  if (ua !== ub) return ua < ub ? { archive: a.name, keep: b.name } : { archive: b.name, keep: a.name };
  const fa = a.state?.firstSeenAt ?? "", fb = b.state?.firstSeenAt ?? "";
  if (fa !== fb) return fa > fb ? { archive: a.name, keep: b.name } : { archive: b.name, keep: a.name };
  return a.name > b.name ? { archive: a.name, keep: b.name } : { archive: b.name, keep: a.name };
}

export function detectDuplicates(snapshots: readonly SkillSnapshot[], opts: DuplicateOptions): DuplicateResult {
  const findings: CuratorFinding[] = [];
  const exact: ExactDuplicate[] = [];
  const live = snapshots.filter((s) => s.raw !== null && s.state?.state !== "archived");
  const project = live.filter((s) => s.root === "project" && !s.isSymlink);

  // D2: same name in both roots (the project copy shadows or is shadowed by the user copy).
  const userNames = new Set(live.filter((s) => s.root === "user").map((s) => s.name));
  for (const s of project) {
    if (userNames.has(s.name)) {
      findings.push(finding(s, "D2", "duplicate", "info", "A skill with the same name also exists in ~/.claude/skills (report only)."));
    }
  }

  // D1: identical SKILL.md content.
  const byHash = new Map<string, SkillSnapshot[]>();
  for (const s of project) byHash.set(s.contentHash!, [...(byHash.get(s.contentHash!) ?? []), s]);
  const exactNames = new Set<string>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => x.name.localeCompare(y.name));
    let keep = sorted[0]!;
    for (const other of sorted.slice(1)) keep = byName(sorted, pickArchive(keep, other).keep);
    for (const s of sorted) {
      if (s.name === keep.name) continue;
      exact.push({ archive: s.name, keep: keep.name });
      exactNames.add(s.name);
      findings.push(finding(s, "D1", "duplicate", "warn", `Identical to skill "${keep.name}".`, { other: keep.name, score: 1 }));
    }
  }

  // D3/D4: similar name and description; body similarity confirms.
  const pairs: ScoredPair[] = [];
  const likelyPairs = new Set<string>();
  const v = opts.vectors;
  const candidates = project.filter((s) => !exactNames.has(s.name));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!, b = candidates[j]!;
      const descA = frontmatterDescription(a) ?? "", descB = frontmatterDescription(b) ?? "";
      const nameJ = jaccard(nameTokens(a.name), nameTokens(b.name));
      let score = 0;
      let hit = false;
      if (v) {
        const va = v.nameDescription.get(a.name), vb = v.nameDescription.get(b.name);
        const cos = va && vb ? vectorCosine(va, vb) : 0;
        score = cos;
        hit = cos >= opts.threshold || (nameJ >= NAME_JACCARD && cos >= DESCRIPTION_COSINE);
      } else {
        const lex = termCosine(descA, descB);
        score = Math.max(nameJ, lex);
        hit = nameJ >= NAME_JACCARD && lex >= DESCRIPTION_COSINE;
      }
      if (!hit) continue;
      const ba = v?.body.get(a.name), bb = v?.body.get(b.name);
      const bodySim = ba && bb ? vectorCosine(ba, bb) : termCosine(a.body.slice(0, BODY_CHARS), b.body.slice(0, BODY_CHARS));
      const likely = bodySim >= BODY_COSINE;
      if (likely) likelyPairs.add(`${a.name}\n${b.name}`);
      pairs.push({ a: a.name, b: b.name, score });
      findings.push(finding(a, likely ? "D4" : "D3", "duplicate", likely ? "warn" : "info",
        `${likely ? "Likely duplicate" : "Possible duplicate"} of "${b.name}".`, { other: b.name, score: Math.round(score * 100) / 100, body: Math.round(bodySim * 100) / 100 }));
    }
  }
  const clusters = clusterPairs(pairs, opts.maxClusterSize ?? 4).map((members) => ({
    members,
    likely: members.some((x, i) => members.slice(i + 1).some((y) => likelyPairs.has(`${x}\n${y}`) || likelyPairs.has(`${y}\n${x}`))),
  }));
  return { findings, exact, clusters };
}

function byName(list: readonly SkillSnapshot[], name: string): SkillSnapshot {
  return list.find((s) => s.name === name)!;
}

// ---------------------------------------------------------------------------
// Stale
// ---------------------------------------------------------------------------

export interface StaleOptions {
  now: Date;
  staleAfterDays: number;
  archiveAfterDays: number;
  pruneBundled: boolean;
  /** kv usage:tracking_started_at; nothing is judged stale before it plus staleAfterDays */
  trackingStartedAt: string | null;
  /** Skills named in config.agents[].skills */
  protectedNames: ReadonlySet<string>;
  /** Messages of scheduled tasks; a skill they mention is never stale */
  scheduleTexts: readonly string[];
}

export interface StaleCandidate {
  name: string;
  /** ISO time idleness is counted from: last recorded use, else first sight (never before tracking start) */
  since: string;
  lastUsedAt: string | null;
  useCount: number;
  idleDays: number;
}

export interface StaleResult {
  findings: CuratorFinding[];
  /** Active skills to mark `stale` (bookkeeping only) */
  markStale: string[];
  /** Past archiveAfterDays: archive proposals */
  archive: StaleCandidate[];
}

const DAY_MS = 86_400_000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A schedule message mentions the skill as a whole word or as `/name`. */
export function mentionsSkill(text: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])/?${escapeRe(name)}($|[^a-z0-9_-])`, "i").test(text);
}

export function detectStale(snapshots: readonly SkillSnapshot[], opts: StaleOptions): StaleResult {
  const findings: CuratorFinding[] = [];
  const markStale: string[] = [];
  const archive: StaleCandidate[] = [];
  const nowMs = opts.now.getTime();
  const trackingMs = Date.parse(opts.trackingStartedAt ?? "");
  // With no tracking start there is no usage history at all: nothing can be judged.
  if (!Number.isFinite(trackingMs)) return { findings, markStale, archive };

  for (const s of snapshots) {
    const st = s.state;
    if (s.root !== "project" || s.isSymlink || !st || st.state === "archived") continue;
    if (s.source === "bundled" && !opts.pruneBundled) continue;
    if (st.pinned || opts.protectedNames.has(s.name)) continue;
    if (opts.scheduleTexts.some((t) => mentionsSkill(t, s.name))) continue;
    const firstSeenMs = Date.parse(st.firstSeenAt);
    const anchorMs = Math.max(Number.isFinite(firstSeenMs) ? firstSeenMs : nowMs, trackingMs);
    if (nowMs - anchorMs < opts.staleAfterDays * DAY_MS) continue;
    const lastUsedMs = Date.parse(st.lastUsedAt ?? "");
    const sinceMs = Number.isFinite(lastUsedMs) ? Math.max(lastUsedMs, anchorMs) : anchorMs;
    const idleDays = Math.floor((nowMs - sinceMs) / DAY_MS);
    if (idleDays < opts.staleAfterDays) continue;
    const cand: StaleCandidate = { name: s.name, since: new Date(sinceMs).toISOString(), lastUsedAt: st.lastUsedAt, useCount: st.useCount, idleDays };
    const usedText = st.lastUsedAt ? `last used ${st.lastUsedAt.slice(0, 10)}` : `no recorded use since ${cand.since.slice(0, 10)}`;
    if (idleDays >= opts.archiveAfterDays) {
      archive.push(cand);
      findings.push(finding(s, "archive", "stale", "warn", `Unused for ${idleDays} days (${usedText}); proposed for archiving.`, { idleDays }));
    } else {
      findings.push(finding(s, "stale", "stale", "info", `Unused for ${idleDays} days (${usedText}).`, { idleDays }));
    }
    if (st.state === "active") markStale.push(s.name);
  }
  return { findings, markStale, archive };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export interface DriftOptions {
  /** Owner-turn file-tool writes the skill write guard allowed (audit guard.direct_write) */
  directWrites: ReadonlyArray<{ skill: string; atMs: number }>;
  /** A drift whose SKILL.md mtime is this close to such a write is adopted automatically. Default 2 min. */
  windowMs?: number;
}

export interface DriftCandidate {
  name: string;
  currentHash: string;
  approvedHash: string | null;
}

export interface DriftResult {
  findings: CuratorFinding[];
  /** Drifts the owner must decide on (skill.adopt, and skill.revert when an approved copy exists) */
  propose: DriftCandidate[];
  /** Drifts explained by a recorded owner-turn direct write */
  autoAdopt: DriftCandidate[];
}

export function detectDrift(snapshots: readonly SkillSnapshot[], opts: DriftOptions): DriftResult {
  const findings: CuratorFinding[] = [];
  const propose: DriftCandidate[] = [];
  const autoAdopt: DriftCandidate[] = [];
  const windowMs = opts.windowMs ?? 120_000;
  for (const s of snapshots) {
    const st = s.state;
    if (s.root !== "project" || s.isSymlink || !st || st.state === "archived" || s.contentHash === null) continue;
    if (s.source === "bundled" && !st.override) continue;
    if (s.contentHash === st.approvedHash) continue;
    const cand: DriftCandidate = { name: s.name, currentHash: s.contentHash, approvedHash: st.approvedHash };
    const explained = s.mtimeMs !== null && opts.directWrites.some((w) => w.skill === s.name && Math.abs(w.atMs - s.mtimeMs!) <= windowMs);
    if (explained) {
      autoAdopt.push(cand);
      findings.push(finding(s, "drift", "drift", "info", "SKILL.md changed by an owner-requested edit; recorded as approved."));
    } else {
      propose.push(cand);
      findings.push(finding(s, "drift", "drift", "warn", st.approvedHash
        ? "SKILL.md changed outside an approved change."
        : "This skill appeared without an approved change."));
    }
  }
  return { findings, propose, autoAdopt };
}
