import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1 (string prompt, one process per attempt) with account rotation and model
 * fallback. The mock answers by account (options.env.CLAUDE_CONFIG_DIR) and
 * model: LIMIT on a limited dir gives the one-shot limit shape (an error
 * result, then a throw); MODEL on an unavailable model gives a model refusal.
 */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  limited: new Set<string>(),
  unavailable: new Set<string>(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: Record<string, unknown> & { env?: Record<string, string>; resume?: string; model?: string } }) => {
    sdk.calls.push({ prompt, options });
    const dir = options.env?.CLAUDE_CONFIG_DIR ?? "ambient";
    const sid = options.resume ?? "11111111-1111-4111-8111-111111111111";
    const LIMIT = "You've hit your session limit · resets 4am (Africa/Cairo)";
    return (async function* () {
      if (prompt.includes("LIMIT") && sdk.limited.has(dir)) {
        yield { type: "result", subtype: "success", is_error: true, result: LIMIT, session_id: sid, total_cost_usd: 0, num_turns: 0 };
        throw new Error(`Claude Code returned an error result: ${LIMIT}`);
      }
      if (prompt.includes("MODEL") && sdk.unavailable.has(String(options.model))) {
        yield { type: "result", subtype: "success", is_error: true, result: "API Error: 400 Claude Code does not support this model", session_id: sid, total_cost_usd: 0, num_turns: 0 };
        return;
      }
      yield { type: "assistant", session_id: sid, message: { model: String(options.model), content: [{ type: "text", text: `ok ${dir}` }] } };
      yield { type: "result", subtype: "success", is_error: false, result: `ok ${dir}`, session_id: sid, total_cost_usd: 0.01, num_turns: 1 };
    })();
  }),
}));

import { AgentEngine, type IncomingMessage } from "./agent-engine.js";
import { TurnResilience, ACCOUNT_SWITCH_NOTE, type AccountAcquireResult, type ResilienceAccountSource, type ResilienceModelSource } from "./resilience.js";
import type { FailureInfo } from "./failure.js";

class Accounts implements ResilienceAccountSource {
  active = "a";
  readonly benched = new Set<string>();
  constructor(readonly ids: string[]) {}
  hasAccounts() { return this.ids.length > 0; }
  enabledCount() { return this.ids.length; }
  acquire(opts: { exclude?: ReadonlySet<string> } = {}): AccountAcquireResult {
    const ok = (id: string) => !this.benched.has(id) && !(opts.exclude?.has(id) ?? false);
    const next = ok(this.active) ? this.active : this.ids.find(ok);
    if (!next) return { accountId: this.active, env: { CLAUDE_CONFIG_DIR: `/${this.active}` }, exhausted: true };
    this.active = next;
    return { accountId: next, env: { CLAUDE_CONFIG_DIR: `/${next}` }, exhausted: false };
  }
  reportFailure(id: string, _f: FailureInfo) { this.benched.add(id); }
  reportSuccess() {}
  rotationEnabled() { return true; }
  maxRotationsPerTurn() { return 3; }
  carrySession() { return true; }
  carryTranscript(): "same" { return "same"; }
}

function models(chain: string[]): ResilienceModelSource {
  const benched = new Set<string>();
  return {
    enabled: () => chain.length > 0,
    chain: () => chain,
    advancesOn: () => true,
    isBenched: (a, m) => benched.has(`${a}|${m}`),
    bench: (a, m) => { benched.add(`${a}|${m}`); },
    maxAttemptsPerTurn: () => 4,
    answered: () => undefined,
  };
}

const msg = (text: string): IncomingMessage => ({ id: "m", channel: "telegram", senderName: "O", senderId: "1", text, chatType: "dm", chatId: "1" });
const owner = { name: "O", platformId: "1", role: "owner" as const };

describe("AgentEngine (v1) with account rotation and model fallback", () => {
  beforeEach(() => {
    sdk.calls.length = 0;
    sdk.limited.clear();
    sdk.unavailable.clear();
  });

  function engine(resilience: TurnResilience | null): AgentEngine {
    const e = new AgentEngine({ prompt: { model: "opus", maxTurns: 10 }, cwd: "/tmp" });
    e.setResilience(resilience);
    return e;
  }

  it("zero accounts leaves options.env undefined", async () => {
    const result = await engine(new TurnResilience({ accounts: new Accounts([]) })).execute(msg("hi"), owner, "11111111-1111-4111-8111-111111111111");
    expect(result.response).toBe("ok ambient");
    expect(sdk.calls[0]!.options.env).toBeUndefined();
    expect(sdk.calls[0]!.options.model).toBe("opus");
  });

  it("a thrown limit moves to the next account and resumes the same session", async () => {
    sdk.limited.add("/a");
    const sid = "22222222-2222-4222-8222-222222222222";
    const result = await engine(new TurnResilience({ accounts: new Accounts(["a", "b"]) })).execute(msg("LIMIT"), owner, sid);
    expect(result.response).toBe("ok /b");
    expect(result.accountId).toBe("b");
    expect(sdk.calls).toHaveLength(2);
    expect((sdk.calls[1]!.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/b");
    expect(sdk.calls[1]!.options.resume).toBe(sid);
    expect(sdk.calls[1]!.prompt.startsWith(ACCOUNT_SWITCH_NOTE)).toBe(true);
  });

  it("no fresh-session retries on a limit with nowhere to go", async () => {
    sdk.limited.add("/a");
    const err = await engine(new TurnResilience({ accounts: new Accounts(["a"]) }))
      .execute(msg("LIMIT"), owner, "33333333-3333-4333-8333-333333333333")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(sdk.calls).toHaveLength(1);
  });

  it("the second attempt uses options.model = next with the same resume", async () => {
    sdk.unavailable.add("opus");
    const sid = "44444444-4444-4444-8444-444444444444";
    const result = await engine(new TurnResilience({ models: models(["sonnet"]) })).execute(msg("MODEL"), owner, sid);
    expect(result.isError).toBe(false);
    expect(sdk.calls.map((c) => [c.options.model, c.options.resume])).toEqual([["opus", sid], ["sonnet", sid]]);
    expect(result.model).toBe("sonnet");
  });

  it("without resilience nothing changes", async () => {
    await engine(null).execute(msg("hi"), owner);
    expect(sdk.calls[0]!.options.env).toBeUndefined();
  });
});
