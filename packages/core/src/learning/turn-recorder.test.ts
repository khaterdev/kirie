import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { newToolUseSummary, type ToolUseSummary } from "../engine/tool-observer.js";
import { TurnContextRegistry } from "../engine/turn-context.js";
import type { SdkCallContext } from "../engine/sdk-options.js";
import type { ExecutionResult } from "../engine/agent-engine.js";
import { LearningIntake } from "./intake.js";
import { ProposalStore } from "./proposal-store.js";
import { SkillStateStore } from "./skill-state-store.js";
import { LearningTurnTracker, TurnRecorder, trustOfTurn, trustOfWindow, type TurnRecordInput } from "./turn-recorder.js";
import { OWNER_DM_KEY, fakeAudit, intakeConfig, skillMd, tempLearningEnv, type TempLearningEnv } from "./learning.test-util.js";

let env: TempLearningEnv;
let store: ProposalStore;
let skillState: SkillStateStore;
let recorder: TurnRecorder;
let intake: LearningIntake;
let skillsRoot: string;
const UNTRUSTED = ["WebFetch", "mcp__*"];
const TRUSTED = ["Skill", "Write", "mcp__kirie-tools__learning_propose"];

beforeEach(() => {
  env = tempLearningEnv();
  store = new ProposalStore(env.db);
  skillState = new SkillStateStore(env.db);
  skillsRoot = join(env.dir, "skills");
  mkdirSync(join(skillsRoot, "tmux"), { recursive: true });
  recorder = new TurnRecorder({
    db: env.db, store, skillState, untrustedTools: () => UNTRUSTED, trustedTools: () => TRUSTED, allowUntrustedSkillProposals: () => false,
    skillRoots: { project: skillsRoot }, audit: fakeAudit(),
  });
  intake = new LearningIntake({ store, config: () => intakeConfig(), skillsRoot, skillState });
});
afterEach(() => env.cleanup());

function summary(tools: Record<string, number> = {}, skills: string[] = []): ToolUseSummary {
  const s = newToolUseSummary();
  s.tools = tools;
  s.skills = skills;
  s.skillEvents = skills.map((skill) => ({ skill, via: "tool" as const }));
  return s;
}

function turn(over: Partial<TurnRecordInput> = {}): TurnRecordInput {
  const now = Date.now();
  return {
    sessionKey: OWNER_DM_KEY, source: "main", origin: "owner_message", startedAt: now - 5000, endedAt: now + 5000,
    numTurns: 3, costUsd: 0.01, isError: false, wasAborted: false, toolUse: summary(), ...over,
  };
}

function agentProposal(kind: "memory" | "skill", key: string, sessionKey = OWNER_DM_KEY): number {
  const r = kind === "memory"
    ? intake.submit({ kind: "memory.upsert", title: "x", payload: { key, content: "c", tags: [] }, origin: "agent_tool", trust: "unverified", sourceSessionKey: sessionKey })
    : intake.submit({ kind: "skill.create", title: "x", payload: { name: key, description: `How to ${key}`, skillMd: skillMd(key) }, origin: "agent_tool", trust: "unverified", sourceSessionKey: sessionKey });
  if (!("id" in r)) throw new Error(r.dropped);
  return r.id;
}

describe("trust labels", () => {
  it("owner, mixed, untrusted from turn provenance", () => {
    expect(trustOfTurn({ origin: "owner_message", untrustedInput: false })).toBe("owner");
    expect(trustOfTurn({ origin: "owner_message", untrustedInput: true })).toBe("mixed");
    for (const origin of ["schedule", "webhook", "other_user", "background", "system", "loop", "goal"] as const) {
      expect(trustOfTurn({ origin, untrustedInput: false })).toBe("untrusted");
    }
    expect(trustOfWindow([{ origin: "owner_message", untrustedInput: false }, { origin: "owner_message", untrustedInput: true }])).toBe("mixed");
    expect(trustOfWindow([{ origin: "owner_message", untrustedInput: false }, { origin: "webhook", untrustedInput: false }])).toBe("untrusted");
    expect(trustOfWindow([])).toBe("untrusted");
  });
});

describe("TurnRecorder", () => {
  it("writes turn_log with tool names only and the untrusted flag", () => {
    const t = recorder.record(turn({ toolUse: summary({ Bash: 2, WebFetch: 1 }), userMsgId: 10, assistantMsgId: 11 }));
    expect(t).toMatchObject({ origin: "owner_message", tools: { Bash: 2, WebFetch: 1 }, untrustedInput: true, userMsgId: 10 });
    expect(recorder.turnsForMessages(OWNER_DM_KEY, 10, 11).map((r) => r.id)).toEqual([t.id]);
  });

  it("skill usage: rows written, skill_state bumped, stale becomes active", () => {
    skillState.insert({ name: "tmux", root: "project", source: "local" });
    skillState.setState("project", "tmux", "stale");
    recorder.record(turn({ toolUse: summary({ Skill: 1 }, ["tmux"]) }));
    recorder.record(turn({ toolUse: summary({ Skill: 1 }, ["tmux"]) }));
    expect(skillState.usage({ skill: "tmux" })).toHaveLength(2);
    expect(skillState.get("project", "tmux")).toMatchObject({ useCount: 2, state: "active" });
  });

  it("a first-seen skill in the project root gets a row; an unknown one only a usage row", () => {
    recorder.record(turn({ toolUse: summary({ Skill: 2 }, ["tmux", "plugin:thing"]) }));
    expect(skillState.get("project", "tmux")).toMatchObject({ useCount: 1, source: "local" });
    expect(skillState.findByName("plugin:thing")).toBeNull();
    expect(skillState.usageCounts()).toEqual({ tmux: 1, "plugin:thing": 1 });
  });

  function claiming(ids: number[], tools: Record<string, number> = {}): ToolUseSummary {
    const sum = summary({ "mcp__kirie-tools__learning_propose": ids.length, ...tools });
    sum.proposalIds = ids;
    return sum;
  }

  it("finalizes only the proposals the turn's own stream filed", () => {
    const mine = agentProposal("memory", "k:in");
    const other = agentProposal("memory", "k:other");
    const t = recorder.record(turn({ toolUse: claiming([mine]) }));
    expect(store.get(mine)!.trust).toBe("owner");
    expect(store.get(mine)!.sourceTurnIds).toEqual([t.id]);
    expect(store.get(other)!.trust).toBe("unverified");
  });

  it("a forged owner session key does not give owner trust: the filing turn's provenance wins", () => {
    // A group or webhook turn files with the owner's DM key while the owner's own DM turn is running.
    const forged = agentProposal("skill", "forged-skill", OWNER_DM_KEY);
    recorder.record(turn());
    expect(store.get(forged)!.trust).toBe("unverified");
    recorder.record(turn({ sessionKey: "telegram:group:-500", origin: "other_user", toolUse: claiming([forged]) }));
    expect(store.get(forged)).toMatchObject({ trust: "untrusted", status: "rejected", decidedBy: "system" });
  });

  it("a turn that read content from a non-trusted tool finalizes as mixed", () => {
    const id = agentProposal("memory", "k:mixed");
    recorder.record(turn({ toolUse: claiming([id], { WebFetch: 1 }) }));
    expect(store.get(id)!.trust).toBe("mixed");
    const viaBash = agentProposal("memory", "k:bash");
    recorder.record(turn({ toolUse: claiming([viaBash], { Bash: 1 }) }));
    expect(store.get(viaBash)!.trust).toBe("mixed");
  });

  it("a scheduled turn finalizes as untrusted and an agent skill proposal is dropped", () => {
    const mem = agentProposal("memory", "k:sched");
    const sk = agentProposal("skill", "sched-skill");
    recorder.record(turn({ origin: "schedule", toolUse: claiming([mem, sk]) }));
    expect(store.get(mem)).toMatchObject({ trust: "untrusted", status: "pending" });
    expect(store.get(sk)).toMatchObject({ trust: "untrusted", status: "rejected", decidedBy: "system" });
  });

  it("a background turn's proposals are untrusted, whatever session key they carry", () => {
    const id = agentProposal("memory", "k:bg");
    recorder.record(turn({ source: "background", origin: "background", toolUse: claiming([id]) }));
    expect(store.get(id)!.trust).toBe("untrusted");
  });

  it("an overflowing tool map counts as untrusted input", () => {
    const sum = summary({ Skill: 1 });
    sum.overflow = true;
    expect(recorder.record(turn({ toolUse: sum })).untrustedInput).toBe(true);
  });

  it("calls onRecorded and survives a throwing listener", () => {
    let seen = 0;
    const r = new TurnRecorder({
      db: env.db, store, skillState, untrustedTools: () => [], allowUntrustedSkillProposals: () => false,
      skillRoots: { project: skillsRoot }, onRecorded: () => { seen++; throw new Error("boom"); },
    });
    expect(() => r.record(turn())).not.toThrow();
    expect(seen).toBe(1);
  });
});

describe("LearningTurnTracker", () => {
  const chatCtx: SdkCallContext = { kind: "chat", sessionKey: OWNER_DM_KEY, ownerDm: true, interactive: true, label: "chat", cwd: "/" };
  const taskCtx: SdkCallContext = { kind: "background", sessionKey: OWNER_DM_KEY, taskId: "t1", ownerDm: false, interactive: false, label: "task", cwd: "/" };
  const result = { isError: false, wasAborted: false, costUsd: 0.02, numTurns: 4 };
  const toolMsg = (name: string, input: Record<string, unknown> = {}): SDKMessage =>
    ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } } as unknown as SDKMessage);

  it("joins the stream's tool names with the pipeline's turn completion", () => {
    const tracker = new LearningTurnTracker({ recorder, turns: new TurnContextRegistry(), skillRoots: () => [skillsRoot] });
    tracker.observe({ type: "turn_start", ctx: chatCtx, accountId: null });
    tracker.observe({ type: "message", ctx: chatCtx, message: toolMsg("Bash", { command: "secret-cmd" }) });
    tracker.observe({ type: "message", ctx: chatCtx, message: toolMsg("Skill", { skill: "tmux" }) });
    const filed = agentProposal("memory", "k:tracked");
    tracker.observe({ type: "message", ctx: chatCtx, message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-p", name: "mcp__kirie-tools__learning_propose", input: {} }] } } as unknown as SDKMessage });
    tracker.observe({ type: "message", ctx: chatCtx, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-p", content: [{ type: "text", text: JSON.stringify({ id: filed, status: "pending" }, null, 2) }] }] } } as unknown as SDKMessage });
    tracker.observe({ type: "turn_end", ctx: chatCtx, accountId: null, result });
    const now = Date.now();
    tracker.onTurnComplete({
      sessionKey: OWNER_DM_KEY, origin: "owner_message", channel: "telegram", senderId: "1001", senderRole: "owner",
      userMsgId: 5, assistantMsgId: 6, startedAt: now - 1000, endedAt: now, durationMs: 1000,
      result: { response: "ok", sessionId: "s", costUsd: 0.02, numTurns: 4, isError: false } as ExecutionResult,
    });
    const t = recorder.lastTurn(OWNER_DM_KEY)!;
    expect(t).toMatchObject({ source: "main", origin: "owner_message", userMsgId: 5, tools: { Bash: 1, Skill: 1 }, skills: ["tmux"] });
    expect(JSON.stringify(t)).not.toContain("secret-cmd");
    // Bash is not a trusted tool, so the proposal this turn filed is mixed.
    expect(store.get(filed)!.trust).toBe("mixed");
  });

  it("records a background turn on its turn_end with origin background", () => {
    const tracker = new LearningTurnTracker({ recorder, turns: new TurnContextRegistry(), skillRoots: () => [] });
    tracker.observe({ type: "turn_start", ctx: taskCtx, accountId: null });
    tracker.observe({ type: "message", ctx: taskCtx, message: toolMsg("WebFetch") });
    tracker.observe({ type: "turn_end", ctx: taskCtx, accountId: null, result });
    expect(recorder.lastTurn(OWNER_DM_KEY)).toMatchObject({ source: "background", origin: "background", untrustedInput: true });
  });

  it("ignores no-tools kinds and never throws", () => {
    const tracker = new LearningTurnTracker({ recorder, turns: new TurnContextRegistry(), skillRoots: () => [] });
    const oneshot: SdkCallContext = { kind: "oneshot", ownerDm: false, interactive: false, label: "x", cwd: "/" };
    tracker.observe({ type: "turn_end", ctx: oneshot, accountId: null, result });
    expect(recorder.lastTurn(OWNER_DM_KEY)).toBeNull();
    expect(() => tracker.observe({ type: "message", ctx: chatCtx, message: null as unknown as SDKMessage })).not.toThrow();
  });
});
