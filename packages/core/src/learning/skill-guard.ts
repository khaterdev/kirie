/**
 * Skill write guard: `ToolGate` "skill-write-guard", order 100 (PLAN B.1, C.3, DECISIONS 18).
 *
 * File-tool writes to a skill under `<agentCwd>/.claude/skills` or
 * `~/.claude/skills`, or to `<dataDir>/SOUL.md`, `TOOLS.md`, `USER.md`,
 * `config.yaml`, or a `.claude/settings*.json` of the agent cwd or home, are allowed only in a turn the
 * owner authored (`originOf(ctx) === "owner_message"`). Scheduled, loop,
 * webhook, goal, background and other users' turns must file a proposal.
 *
 * Modes (`learning.skillWriteGuard`): `enforce` (default) denies, `audit`
 * records what it would have denied, `off` does nothing. An allowed
 * owner-origin write is recorded as `guard.direct_write` (the curator uses it
 * to tell approved drift from unexplained drift). Bash is not covered: that is
 * the approval gate's job; the curator's drift detection reports what slips by.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolGate, ToolGateCall, ToolGateVerdict } from "../engine/sdk-options.js";
import { originOf, type TurnContextRegistry } from "../engine/turn-context.js";
import type { LearningAuditSink } from "./intake.js";

export const SKILL_WRITE_GUARD_NAME = "skill-write-guard";
export const SKILL_WRITE_GUARD_ORDER = 100;
export const SKILL_WRITE_GUARD_MATCHER = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
export const SKILL_WRITE_GUARD_REASON =
  "Skill and identity files can only be changed on the owner's direct request. File a proposal with learning_propose instead.";

export type SkillWriteGuardMode = "enforce" | "audit" | "off";

export interface SkillWriteGuardDeps {
  /** `<agentCwd>/.claude/skills` */
  skillsRoot: string;
  /** `~/.claude/skills`: the SDK loads it too (settingSources "user") */
  userSkillsRoot?: string;
  /** `~/.kirie` */
  dataDir: string;
  /** config.agent.workspace || dataDir: its `.claude/settings*.json` are protected */
  agentCwd?: string;
  /** Home directory: `~/.claude/settings*.json` are protected */
  homeDir?: string;
  turns: TurnContextRegistry;
  mode: () => SkillWriteGuardMode;
  audit?: LearningAuditSink;
}

/** Identity files under the data dir, plus the daemon config (it holds the guard's own mode). */
const DATA_DIR_FILES = ["SOUL.md", "TOOLS.md", "USER.md", "config.yaml"] as const;
const CLAUDE_SETTINGS_FILES = ["settings.json", "settings.local.json"] as const;

export interface ProtectedPaths {
  /** Directories whose whole subtree is protected: skill roots, and targets of symlinked skill dirs (with their skill name) */
  roots: Array<{ path: string; skill?: string }>;
  /** Exact files */
  files: string[];
}

export function skillGuardProtectedPaths(deps: Pick<SkillWriteGuardDeps, "skillsRoot" | "userSkillsRoot" | "dataDir" | "agentCwd" | "homeDir">): ProtectedPaths {
  const roots: ProtectedPaths["roots"] = [deps.skillsRoot, ...(deps.userSkillsRoot ? [deps.userSkillsRoot] : [])].map((path) => ({ path }));
  // A skill directory that is a symlink: its target tree is protected too.
  for (const { path: root } of [...roots]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        try {
          roots.push({ path: realpathSync.native(join(root, entry.name)), skill: entry.name });
        } catch {
          // dangling link: nothing to protect behind it
        }
      }
    } catch {
      // root missing
    }
  }
  const files: string[] = DATA_DIR_FILES.map((f) => resolve(deps.dataDir, f));
  for (const base of [deps.agentCwd, deps.homeDir]) {
    if (base) for (const f of CLAUDE_SETTINGS_FILES) files.push(resolve(base, ".claude", f));
  }
  return { roots, files };
}

/** Resolve symlinks of the longest existing ancestor, so a symlinked path cannot dodge the check. */
function canonical(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return resolve(realpathSync.native(current), ...tail);
      } catch {
        return resolve(current, ...tail);
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.unshift(basename(current));
    current = parent;
  }
}

/** macOS file systems are case-insensitive by default: compare lower-cased (errs toward protecting). */
function within(child: string, parent: string): boolean {
  const rel = relative(parent.toLowerCase(), child.toLowerCase());
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type ProtectedTarget = { kind: "skill"; skill: string; file: string } | { kind: "identity"; file: string };

function matchTarget(abs: string, paths: ProtectedPaths): ProtectedTarget | null {
  const lower = abs.toLowerCase();
  for (const { path: rootPath, skill: linked } of paths.roots) {
    for (const root of new Set([resolve(rootPath), canonical(rootPath)])) {
      if (within(abs, root) || lower === root.toLowerCase()) {
        const skill = linked ?? relative(root.toLowerCase(), lower).split(sep)[0] ?? "";
        return { kind: "skill", skill: skill || "(root)", file: basename(abs) };
      }
    }
  }
  for (const filePath of paths.files) {
    for (const file of new Set([resolve(filePath), canonical(filePath)])) {
      if (lower === file.toLowerCase()) return { kind: "identity", file: basename(filePath) };
    }
  }
  return null;
}

/**
 * The protected target a path resolves to, or null. Both the path as written
 * and its symlink-resolved form are checked, so a link pointing into a
 * protected tree and a protected entry that is itself a link (a skill dir or
 * SOUL.md symlinked to a dotfiles repo) are both caught.
 */
export function protectedTargetOf(filePath: string, cwd: string, paths: ProtectedPaths): ProtectedTarget | null {
  const lexical = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return matchTarget(lexical, paths) ?? matchTarget(canonical(lexical), paths);
}

function targetPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function createSkillWriteGuard(deps: SkillWriteGuardDeps): ToolGate {
  return {
    name: SKILL_WRITE_GUARD_NAME,
    order: SKILL_WRITE_GUARD_ORDER,
    matcher: SKILL_WRITE_GUARD_MATCHER,
    check(call: ToolGateCall): ToolGateVerdict {
      const mode = deps.mode();
      if (mode === "off") return { decision: "pass" };
      const path = targetPath(call.input);
      if (!path) return { decision: "pass" };
      const target = protectedTargetOf(path, call.cwd || call.ctx.cwd, skillGuardProtectedPaths(deps));
      if (!target) return { decision: "pass" };

      const origin = originOf(call.ctx, deps.turns);
      const detail = {
        tool: call.tool,
        target: target.kind === "skill" ? `skill:${target.skill}/${target.file}` : target.file,
        origin,
        kind: call.ctx.kind,
        ...(call.agentType ? { agentType: call.agentType } : {}),
      };
      const actor = call.ctx.sessionKey ? `agent:${call.ctx.sessionKey}` : "system";
      if (origin === "owner_message") {
        deps.audit?.record({ feature: "learning", action: "guard.direct_write", actor, detail });
        return { decision: "pass" };
      }
      if (mode === "audit") {
        deps.audit?.record({ feature: "learning", action: "guard.would_deny", actor, detail });
        return { decision: "pass" };
      }
      deps.audit?.record({ feature: "learning", action: "guard.denied", actor, detail });
      return { decision: "deny", reason: SKILL_WRITE_GUARD_REASON };
    },
  };
}
