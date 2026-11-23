/**
 * Skill write guard: `ToolGate` "skill-write-guard", order 100 (PLAN B.1, C.3, DECISIONS 18).
 *
 * File-tool writes to a skill under `<agentCwd>/.claude/skills`, or to
 * `<dataDir>/SOUL.md`, `TOOLS.md`, `USER.md`, are allowed only in a turn the
 * owner authored (`originOf(ctx) === "owner_message"`). Scheduled, loop,
 * webhook, goal, background and other users' turns must file a proposal.
 *
 * Modes (`learning.skillWriteGuard`): `enforce` (default) denies, `audit`
 * records what it would have denied, `off` does nothing. An allowed
 * owner-origin write is recorded as `guard.direct_write` (the curator uses it
 * to tell approved drift from unexplained drift). Bash is not covered: that is
 * the approval gate's job; the curator's drift detection reports what slips by.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
  /** `~/.kirie` */
  dataDir: string;
  turns: TurnContextRegistry;
  mode: () => SkillWriteGuardMode;
  audit?: LearningAuditSink;
}

const IDENTITY_FILES = ["SOUL.md", "TOOLS.md", "USER.md"] as const;

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

/** The protected target a path resolves to, or null. */
export function protectedTargetOf(filePath: string, cwd: string, skillsRoot: string, dataDir: string): ProtectedTarget | null {
  const abs = canonical(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  const roots = new Set([resolve(skillsRoot), canonical(skillsRoot)]);
  for (const root of roots) {
    if (within(abs, root) || abs.toLowerCase() === root.toLowerCase()) {
      const rel = relative(root.toLowerCase(), abs.toLowerCase());
      const skill = rel.split(sep)[0] ?? "";
      return { kind: "skill", skill: skill || "(root)", file: basename(abs) };
    }
  }
  const dataDirs = new Set([resolve(dataDir), canonical(dataDir)]);
  for (const dir of dataDirs) {
    for (const name of IDENTITY_FILES) {
      if (abs.toLowerCase() === resolve(dir, name).toLowerCase()) return { kind: "identity", file: name };
    }
  }
  return null;
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
      const target = protectedTargetOf(path, call.cwd || call.ctx.cwd, deps.skillsRoot, deps.dataDir);
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
