import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isUntrustedTool, newToolUseSummary, observeSdkMessage, skillNameForPath, usedUntrustedTool } from "./tool-observer.js";

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
    const acc = newToolUseSummary();
    acc.tools = { Bash: 1, "mcp__kirie-tools__memory_store": 1 };
    expect(usedUntrustedTool(acc, patterns)).toBe(false);
    acc.tools.WebFetch = 1;
    expect(usedUntrustedTool(acc, patterns)).toBe(true);
  });
});
