import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, type SdkCallContext, type SdkCallKind, type ToolGateCall } from "../engine/sdk-options.js";
import { TurnContextRegistry, type TurnOrigin } from "../engine/turn-context.js";
import { SKILL_WRITE_GUARD_REASON, createSkillWriteGuard, protectedTargetOf, type SkillWriteGuardMode } from "./skill-guard.js";
import { OWNER_DM_KEY, fakeAudit, type FakeAudit } from "./learning.test-util.js";

let dir: string;
let dataDir: string;
let skillsRoot: string;
let turns: TurnContextRegistry;
let audit: FakeAudit;
let mode: SkillWriteGuardMode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-guard-"));
  dataDir = join(dir, "kirie");
  skillsRoot = join(dataDir, ".claude", "skills");
  mkdirSync(join(skillsRoot, "tmux"), { recursive: true });
  turns = new TurnContextRegistry();
  audit = fakeAudit();
  mode = "enforce";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function guard() {
  return createSkillWriteGuard({ skillsRoot, dataDir, turns, mode: () => mode, audit });
}

function ctx(kind: SdkCallKind = "chat"): SdkCallContext {
  return { kind, sessionKey: OWNER_DM_KEY, ownerDm: kind === "chat", interactive: kind === "chat", label: "test", cwd: dataDir };
}

function call(tool: string, path: string, kind: SdkCallKind = "chat"): ToolGateCall {
  return { tool, input: { file_path: path, content: "x" }, toolUseId: "tu", cwd: dataDir, ctx: ctx(kind) };
}

function withOrigin(origin: TurnOrigin): void {
  turns.begin(OWNER_DM_KEY, { origin, startedAt: Date.now() });
}

describe("skill write guard", () => {
  const skillFile = () => join(skillsRoot, "tmux", "SKILL.md");

  it.each(["schedule", "loop", "webhook", "goal", "other_user", "system"] as const)("denies a chat turn with origin %s in enforce mode", async (origin) => {
    withOrigin(origin);
    expect(await guard().check(call("Write", skillFile()))).toEqual({ decision: "deny", reason: SKILL_WRITE_GUARD_REASON });
    expect(audit.actions()).toEqual(["guard.denied"]);
  });

  it.each(["background", "goal", "webhook"] as const)("denies %s tasks whatever the registry says", async (kind) => {
    withOrigin("owner_message");
    expect((await guard().check(call("Edit", skillFile(), kind))).decision).toBe("deny");
  });

  it("allows an owner-origin write and records direct_write", async () => {
    withOrigin("owner_message");
    expect(await guard().check(call("Write", skillFile()))).toEqual({ decision: "pass" });
    expect(audit.records[0]).toMatchObject({ action: "guard.direct_write", detail: { target: "skill:tmux/SKILL.md", origin: "owner_message" } });
  });

  it("allows writes outside the protected paths without auditing", async () => {
    withOrigin("schedule");
    expect((await guard().check(call("Write", join(dataDir, "notes.md")))).decision).toBe("pass");
    expect((await guard().check(call("Write", join(dataDir, "MEMORY.md")))).decision).toBe("pass");
    expect(audit.records).toHaveLength(0);
  });

  it("protects SOUL.md, TOOLS.md and USER.md, relative paths and odd casing", async () => {
    withOrigin("schedule");
    for (const name of ["SOUL.md", "TOOLS.md", "USER.md"]) {
      expect((await guard().check(call("Write", join(dataDir, name)))).decision).toBe("deny");
    }
    expect((await guard().check(call("Edit", ".claude/skills/new-one/SKILL.md"))).decision).toBe("deny");
    expect((await guard().check(call("Write", join(dataDir, ".Claude", "Skills", "tmux", "SKILL.md")))).decision).toBe("deny");
    expect((await guard().check({ ...call("NotebookEdit", ""), input: { notebook_path: join(skillsRoot, "tmux", "n.ipynb") } })).decision).toBe("deny");
  });

  it("sees through a symlink into the skills root", async () => {
    withOrigin("schedule");
    const link = join(dir, "sneaky");
    symlinkSync(skillsRoot, link);
    expect((await guard().check(call("Write", join(link, "tmux", "SKILL.md")))).decision).toBe("deny");
    expect(protectedTargetOf(join(link, "x", "SKILL.md"), dataDir, skillsRoot, dataDir)).toMatchObject({ kind: "skill" });
  });

  it("audit mode never denies; off does nothing", async () => {
    withOrigin("schedule");
    mode = "audit";
    expect((await guard().check(call("Write", skillFile()))).decision).toBe("pass");
    expect(audit.actions()).toEqual(["guard.would_deny"]);
    mode = "off";
    expect((await guard().check(call("Write", skillFile()))).decision).toBe("pass");
    expect(audit.records).toHaveLength(1);
  });

  it("the deny reaches the model through the pipeline's single PreToolUse hook", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(guard());
    withOrigin("schedule");
    const options: Options = { model: "m", permissionMode: "bypassPermissions", cwd: dataDir };
    pipeline.apply(options, ctx("chat"));
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const input = {
      hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: skillFile(), content: "x" },
      tool_use_id: "tu-9", session_id: "s", transcript_path: "/tmp/t", cwd: dataDir,
    } as HookInput;
    const out = await hook(input, "tu-9", { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: SKILL_WRITE_GUARD_REASON } });
    // Read is not matched by the gate.
    const read = await hook({ ...input, tool_name: "Read", tool_input: { file_path: skillFile() } } as HookInput, "tu-10", { signal: new AbortController().signal });
    expect(read).toEqual({});
  });
});
