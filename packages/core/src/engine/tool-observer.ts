/**
 * Tool-use observer (PLAN C.3, R4 section 0.4).
 *
 * Reads assistant `tool_use` blocks from the SDK stream and keeps only tool
 * names, counts and skill names. Tool inputs are never retained beyond the two
 * fields needed to recognise a skill (`Skill.skill`, `Read.file_path`).
 *
 * Only type imports from the SDK (engine tests mock the module).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface SkillEvent {
  skill: string;
  via: "tool" | "read";
}

export interface ToolUseSummary {
  /** Tool name -> number of calls this turn */
  tools: Record<string, number>;
  /** Unique skill names used this turn, in first-use order */
  skills: string[];
  skillEvents: SkillEvent[];
}

/** Skill names as they appear in a skills directory, or `plugin:skill` from the Skill tool. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_DISTINCT_TOOLS = 200;

export function newToolUseSummary(): ToolUseSummary {
  return { tools: {}, skills: [], skillEvents: [] };
}

function addSkill(acc: ToolUseSummary, skill: string, via: SkillEvent["via"]): void {
  if (!SKILL_NAME_RE.test(skill)) return;
  acc.skillEvents.push({ skill, via });
  if (!acc.skills.includes(skill)) acc.skills.push(skill);
}

/** The skill directory a path points into, or null. `<root>/<name>/...` with at least one segment after the name. */
export function skillNameForPath(filePath: string, skillRoots: readonly string[], cwd?: string): string | null {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd ?? process.cwd(), filePath);
  for (const root of skillRoots) {
    const rel = relative(resolve(root), abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const parts = rel.split(sep);
    if (parts.length < 2) continue;
    const name = parts[0];
    if (name && SKILL_NAME_RE.test(name)) return name;
  }
  return null;
}

interface ToolUseBlockLike {
  type: "tool_use";
  name: string;
  input?: unknown;
}

function isToolUseBlock(block: unknown): block is ToolUseBlockLike {
  return (
    typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "tool_use" &&
    typeof (block as { name?: unknown }).name === "string"
  );
}

/** Call for every SDKMessage; only assistant tool_use blocks are read. */
export function observeSdkMessage(
  msg: SDKMessage,
  acc: ToolUseSummary,
  skillRoots: readonly string[],
  cwd?: string,
): void {
  if (msg.type !== "assistant") return;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isToolUseBlock(block)) continue;
    const name = block.name.slice(0, MAX_TOOL_NAME_LENGTH);
    if (name in acc.tools || Object.keys(acc.tools).length < MAX_DISTINCT_TOOLS) {
      acc.tools[name] = (acc.tools[name] ?? 0) + 1;
    }
    const input = (typeof block.input === "object" && block.input !== null ? block.input : {}) as Record<string, unknown>;
    if (name === "Skill" && typeof input.skill === "string") {
      addSkill(acc, input.skill.trim(), "tool");
    } else if (name === "Read" && typeof input.file_path === "string") {
      const skill = skillNameForPath(input.file_path, skillRoots, cwd);
      if (skill) addSkill(acc, skill, "read");
    }
  }
}

/**
 * True when `tool` matches one of `patterns` (exact name or `prefix*`).
 * A wildcard pattern never matches a `mcp__kirie-tools__*` tool: those are
 * untrusted only when listed by exact name (R4 section 0.6).
 */
export function isUntrustedTool(tool: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      if (!tool.startsWith(prefix)) continue;
      if (tool.startsWith("mcp__kirie-tools__") && !prefix.startsWith("mcp__kirie-tools__")) continue;
      return true;
    }
    if (p === tool) return true;
  }
  return false;
}

export function usedUntrustedTool(summary: ToolUseSummary, patterns: readonly string[]): boolean {
  return Object.keys(summary.tools).some((t) => isUntrustedTool(t, patterns));
}
