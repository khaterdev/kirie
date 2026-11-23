import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { LEARNING_PROPOSE_TOOL, isUntrustedTool, newToolUseSummary, observeSdkMessage, skillNameForPath, usedUntrustedTool } from "./tool-observer.js";

const ROOT = "/data/kirie/.claude/skills";

function assistant(blocks: unknown[]): SDKMessage {
  return { type: "assistant", message: { content: blocks } } as unknown as SDKMessage;
}

describe("tool observer", () => {
  it("counts tools per name and ignores non-assistant messages", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant([
      { type: "text", text: "hi" },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", name: "Bash", input: { command: "pwd" } },
      { type: "tool_use", name: "WebFetch", input: { url: "https://example.com" } },
    ]), acc, [ROOT]);
    observeSdkMessage({ type: "user", message: { content: [{ type: "tool_use", name: "Bash" }] } } as unknown as SDKMessage, acc, [ROOT]);
    expect(acc.tools).toEqual({ Bash: 2, WebFetch: 1 });
    expect(acc.skills).toEqual([]);
  });

  it("extracts the Skill tool's skill name", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant([{ type: "tool_use", name: "Skill", input: { skill: "tmux" } }]), acc, [ROOT]);
    observeSdkMessage(assistant([{ type: "tool_use", name: "Skill", input: { skill: "tmux" } }]), acc, [ROOT]);
    expect(acc.skills).toEqual(["tmux"]);
    expect(acc.skillEvents).toEqual([{ skill: "tmux", via: "tool" }, { skill: "tmux", via: "tool" }]);
  });

  it("a Read inside a skill directory counts as a read; outside it does not", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant([
      { type: "tool_use", name: "Read", input: { file_path: `${ROOT}/deploy/SKILL.md` } },
      { type: "tool_use", name: "Read", input: { file_path: "/data/kirie/MEMORY.md" } },
      { type: "tool_use", name: "Read", input: { file_path: `${ROOT}/../secrets.txt` } },
      { type: "tool_use", name: "Read", input: { file_path: ".claude/skills/notes/ref.md" } },
    ]), acc, [ROOT], "/data/kirie");
    expect(acc.skillEvents).toEqual([{ skill: "deploy", via: "read" }, { skill: "notes", via: "read" }]);
  });

  it("never retains tool inputs", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant([
      { type: "tool_use", name: "Bash", input: { command: "echo very-private-value" } },
      { type: "tool_use", name: "Skill", input: { skill: "tmux", args: "very-private-value" } },
    ]), acc, [ROOT]);
    expect(JSON.stringify(acc)).not.toContain("very-private-value");
  });

  it("skillNameForPath needs a file inside the skill directory", () => {
    expect(skillNameForPath(`${ROOT}/deploy`, [ROOT])).toBeNull();
    expect(skillNameForPath(`${ROOT}/deploy/a/b.md`, [ROOT])).toBe("deploy");
  });

  it("untrusted tool patterns: exact and prefix, kirie-tools only by exact name", () => {
    const patterns = ["WebFetch", "mcp__kirie-tools__web_fetch", "mcp__*"];
    expect(isUntrustedTool("WebFetch", patterns)).toBe(true);
    expect(isUntrustedTool("mcp__playwright__browser_navigate", patterns)).toBe(true);
    expect(isUntrustedTool("mcp__kirie-tools__web_fetch", patterns)).toBe(true);
    expect(isUntrustedTool("mcp__kirie-tools__memory_search", patterns)).toBe(false);
    expect(isUntrustedTool("Bash", patterns)).toBe(false);
  });

  it("usedUntrustedTool fails closed: only listed trusted tools keep a turn clean", () => {
    const trusted = ["Skill", "Write", "mcp__kirie-tools__memory_store"];
    const acc = newToolUseSummary();
    acc.tools = { Skill: 1, "mcp__kirie-tools__memory_store": 1 };
    expect(usedUntrustedTool(acc, ["WebFetch"], trusted)).toBe(false);
    acc.tools.Bash = 1;
    expect(usedUntrustedTool(acc, ["WebFetch"], trusted)).toBe(true);
    expect(usedUntrustedTool({ ...newToolUseSummary(), tools: { Skill: 1 } }, ["Skill"], trusted)).toBe(true);
    expect(usedUntrustedTool({ ...newToolUseSummary(), tools: { Skill: 1 } }, [], [])).toBe(true);
    expect(usedUntrustedTool({ ...newToolUseSummary(), overflow: true }, [], trusted)).toBe(true);
  });

  it("more than 200 distinct tools sets overflow", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant(Array.from({ length: 205 }, (_, i) => ({ type: "tool_use", name: `t${i}` }))), acc, [ROOT]);
    expect(acc.overflow).toBe(true);
  });

  it("collects proposal ids only from learning_propose results in its own stream", () => {
    const acc = newToolUseSummary();
    observeSdkMessage(assistant([{ type: "tool_use", id: "tu-1", name: LEARNING_PROPOSE_TOOL, input: { sessionKey: "telegram:dm:1" } }]), acc, [ROOT]);
    const result = (id: string, text: string): SDKMessage =>
      ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } } as unknown as SDKMessage);
    observeSdkMessage(result("tu-other", JSON.stringify({ id: 99, status: "pending" })), acc, [ROOT]);
    observeSdkMessage(result("tu-1", JSON.stringify({ id: 7, status: "pending" }, null, 2)), acc, [ROOT]);
    expect(acc.proposalIds).toEqual([7]);
    observeSdkMessage(assistant([{ type: "tool_use", id: "tu-2", name: LEARNING_PROPOSE_TOOL, input: {} }]), acc, [ROOT]);
    observeSdkMessage(result("tu-2", JSON.stringify({ status: "dropped", reason: "daily_cap" })), acc, [ROOT]);
    expect(acc.proposalIds).toEqual([7]);
  });
});
