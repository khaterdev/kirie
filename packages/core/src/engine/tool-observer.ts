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
  /** Proposal ids returned by learning_propose calls seen in this turn's own stream */
  proposalIds: number[];
  /** More distinct tool names than tracked: provenance is unknown (counts as untrusted) */
  overflow: boolean;
  /** tool_use ids of learning_propose calls still waiting for their result (internal) */
  pendingProposeCalls: string[];
}

/** The agent's proposal tool, as the SDK names it. */
export const LEARNING_PROPOSE_TOOL = "mcp__kirie-tools__learning_propose";

/** Skill names as they appear in a skills directory, or `plugin:skill` from the Skill tool. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_DISTINCT_TOOLS = 200;

export function newToolUseSummary(): ToolUseSummary {
  return { tools: {}, skills: [], skillEvents: [], proposalIds: [], overflow: false, pendingProposeCalls: [] };
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
  id?: string;
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

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/** A learning_propose result that filed a proposal: its id. */
function proposalIdOf(content: unknown): number | null {
  try {
    const v = JSON.parse(toolResultText(content)) as { id?: unknown; status?: unknown };
    return typeof v.id === "number" && Number.isInteger(v.id) && v.status === "pending" ? v.id : null;
  } catch {
    return null;
  }
}

function observeToolResults(msg: SDKMessage, acc: ToolUseSummary): void {
  if (acc.pendingProposeCalls.length === 0) return;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_result") continue;
    const useId = (block as { tool_use_id?: unknown }).tool_use_id;
    const idx = typeof useId === "string" ? acc.pendingProposeCalls.indexOf(useId) : -1;
    if (idx < 0) continue;
    acc.pendingProposeCalls.splice(idx, 1);
    const id = proposalIdOf((block as { content?: unknown }).content);
    if (id !== null && !acc.proposalIds.includes(id)) acc.proposalIds.push(id);
  }
}

/** Call for every SDKMessage: assistant tool_use blocks, and the results of learning_propose calls. */
export function observeSdkMessage(
  msg: SDKMessage,
  acc: ToolUseSummary,
  skillRoots: readonly string[],
  cwd?: string,
): void {
  if (msg.type === "user") {
    observeToolResults(msg, acc);
    return;
  }
  if (msg.type !== "assistant") return;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isToolUseBlock(block)) continue;
    const name = block.name.slice(0, MAX_TOOL_NAME_LENGTH);
    if (name in acc.tools || Object.keys(acc.tools).length < MAX_DISTINCT_TOOLS) {
      acc.tools[name] = (acc.tools[name] ?? 0) + 1;
    } else {
      acc.overflow = true;
    }
    if (name === LEARNING_PROPOSE_TOOL && typeof block.id === "string" && acc.pendingProposeCalls.length < 100) {
      acc.pendingProposeCalls.push(block.id);
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

/** True when `tool` matches one of `patterns` (exact name or `prefix*`). */
export function matchesToolPattern(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? tool.startsWith(p.slice(0, -1)) : p === tool));
}

/**
 * Did the turn read content the owner did not write? Fails closed: any tool
 * not on the trusted list, any tool on the untrusted list, or an overflowing
 * tool map counts.
 */
export function usedUntrustedTool(
  summary: ToolUseSummary,
  untrustedPatterns: readonly string[],
  trustedPatterns: readonly string[] = [],
): boolean {
  if (summary.overflow) return true;
  return Object.keys(summary.tools).some((t) => isUntrustedTool(t, untrustedPatterns) || !matchesToolPattern(t, trustedPatterns));
}
