import { describe, it, expect } from "vitest";
import { isOverBroadAllowPattern, parseApprovalPattern, shellPatternMatchesSegment } from "./patterns.js";
import { parseShell } from "./shell-parse.js";

describe("parseApprovalPattern", () => {
  it("parses the three shapes", () => {
    expect(parseApprovalPattern("git push --force*")).toMatchObject({ kind: "shell", glob: "git push --force*" });
    expect(parseApprovalPattern("Write(~/.ssh/**)")).toMatchObject({ kind: "tool", tool: "Write", glob: "~/.ssh/**" });
    expect(parseApprovalPattern("Bash(pnpm *)")).toMatchObject({ kind: "shell", glob: "pnpm *" });
    expect(parseApprovalPattern("mcp__github__delete_*")).toMatchObject({ kind: "mcp" });
  });

  it("refuses bad patterns", () => {
    expect(parseApprovalPattern("")).toHaveProperty("error");
    expect(parseApprovalPattern("x".repeat(201))).toHaveProperty("error");
    expect(parseApprovalPattern("Write(~/.ssh/**")).toHaveProperty("error");
    expect(parseApprovalPattern("Read()")).toHaveProperty("error");
    expect(parseApprovalPattern("ls​*")).toHaveProperty("error");
  });
});

describe("isOverBroadAllowPattern", () => {
  it.each(["*", "**", "bash *", "sh -c *", "sudo *", "python3 -c *", "python* -c *", "env *", "eval *", "xargs *", "Write(**)", "Read(~/**)", "Edit(/*)", "mcp__*", "mcp__github__*", "r*"])("%s is broad", (p) => {
    expect(isOverBroadAllowPattern(p)).toBe(true);
  });
  it.each(["pnpm *", "git status*", "kubectl get *", "Read(~/dev/**)", "mcp__github__list_*", "npm test"])("%s is fine", (p) => {
    expect(isOverBroadAllowPattern(p)).toBe(false);
  });
});

describe("shellPatternMatchesSegment", () => {
  const seg = (cmd: string, i = 0) => parseShell(cmd, { cwd: "/tmp", home: "/Users/tester" }).segments[i]!;

  it("matches the normalized command (no wrappers, basename)", () => {
    const p = parseApprovalPattern("rm -rf *") as Exclude<ReturnType<typeof parseApprovalPattern>, { error: string }>;
    expect(shellPatternMatchesSegment(p, seg("/bin/rm -rf x"), "deny")).toBe(true);
    expect(shellPatternMatchesSegment(p, seg("sudo rm -rf x"), "deny")).toBe(true);
  });

  it("an allow pattern does not cover a sudo-wrapped command", () => {
    const p = parseApprovalPattern("pnpm *") as Exclude<ReturnType<typeof parseApprovalPattern>, { error: string }>;
    expect(shellPatternMatchesSegment(p, seg("pnpm install"), "allow")).toBe(true);
    expect(shellPatternMatchesSegment(p, seg("sudo pnpm install"), "allow")).toBe(false);
    expect(shellPatternMatchesSegment(p, seg("timeout 60 pnpm test"), "allow")).toBe(true);
  });

  it("a deny pattern over the wrapper also fires", () => {
    const p = parseApprovalPattern("sudo *") as Exclude<ReturnType<typeof parseApprovalPattern>, { error: string }>;
    expect(shellPatternMatchesSegment(p, seg("sudo ls"), "deny")).toBe(true);
  });
});
