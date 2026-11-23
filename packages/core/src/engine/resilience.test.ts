import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FallbackConfigSchema, type FallbackConfig } from "../config/sections/fallback.js";
import { AccountStore } from "../accounts/account-store.js";
import { FallbackControl } from "../accounts/fallback-control.js";
import {
  ACCOUNT_SWITCH_NOTE,
  TurnResilience,
  type AccountAcquireResult,
  type ResilienceAccountSource,
} from "./resilience.js";
import type { FailureClass, FailureInfo } from "./failure.js";
import { agentErrorUserMessage } from "./agent-errors.js";

const fail = (cls: FailureClass, over: Partial<FailureInfo> = {}): FailureInfo => ({ class: cls, message: cls, ...over });

/** In-memory account source: fill-first over `ids`, sticky active, benched set. */
class FakeAccounts implements ResilienceAccountSource {
  readonly limited = new Map<string, number>();
  readonly reports: Array<[string, FailureClass]> = [];
  rotation = true;
  active: string;
  constructor(readonly ids: string[]) {
    this.active = ids[0]!;
  }
  hasAccounts(): boolean {
    return this.ids.length > 0;
  }
  enabledCount(): number {
    return this.ids.length;
  }
  acquire(opts: { exclude?: ReadonlySet<string> } = {}): AccountAcquireResult {
    const usable = (id: string): boolean => !this.limited.has(id) && !(opts.exclude?.has(id) ?? false);
    const lease = (id: string, exhausted = false): AccountAcquireResult => ({
      accountId: id,
      env: { CLAUDE_CONFIG_DIR: `/home/test/.${id}` },
      exhausted,
      ...(exhausted ? { earliestResetAt: Math.min(...this.limited.values()) } : {}),
    });
    if (usable(this.active)) return lease(this.active);
    if (this.rotation || opts.exclude) {
      const next = this.ids.find(usable);
      if (next) {
        this.active = next;
        return lease(next);
      }
    }
    return lease(this.active, true);
  }
  reportFailure(accountId: string, failure: FailureInfo): void {
    this.reports.push([accountId, failure.class]);
    this.limited.set(accountId, failure.resetAtMs ?? 1_000_000);
  }
  reportSuccess(): void {}
  rotationEnabled(): boolean {
    return this.rotation;
  }
  maxRotationsPerTurn(): number {
    return 3;
  }
  carrySession(): boolean {
    return true;
  }
  carryTranscript(): "same" {
    return "same";
  }
}

describe("TurnResilience", () => {
  let dir: string;
  let store: AccountStore;
  let clock: number;
  let fbCfg: FallbackConfig;
  let fallback: FallbackControl;
  let episode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-resilience-"));
    clock = 1_000_000;
    store = new AccountStore(join(dir, "accounts.db"), { now: () => clock });
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet", "haiku"] });
    episode = vi.fn();
    fallback = new FallbackControl({ store, config: () => fbCfg, now: () => clock, onEpisodeStart: episode });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no sources the plan is the ambient account and the primary, and never advances", () => {
    const plan = new TurnResilience({}).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.current).toEqual({ accountId: null, env: undefined, model: "opus" });
    for (const cls of ["usage_limit_account", "usage_limit_model", "auth", "model_unavailable", "overloaded"] as const) {
      expect(plan.next(fail(cls))).toBeNull();
    }
  });

  it("zero accounts and fallback off behave like no sources", () => {
    fbCfg = FallbackConfigSchema.parse({});
    const plan = new TurnResilience({ accounts: new FakeAccounts([]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.current).toEqual({ accountId: null, env: undefined, model: "opus" });
    expect(plan.next(fail("model_unavailable"))).toBeNull();
  });

  it("an account-wide limit benches the account and moves to the next one with the same model", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    const next = plan.next(fail("usage_limit_account"))!;
    expect(next).toMatchObject({ accountId: "b", model: "opus", changedAccount: true, changedModel: false, note: ACCOUNT_SWITCH_NOTE });
    expect(next.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/test/.b" });
    expect(accounts.reports).toEqual([["a", "usage_limit_account"]]);
  });

  it("rotation off: the limit is still recorded, nothing else is tried", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    accounts.rotation = false;
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.next(fail("usage_limit_account"))).toBeNull();
    expect(accounts.reports).toEqual([["a", "usage_limit_account"]]);
  });

  it("an account-wide limit never moves to another model on the same account", () => {
    const plan = new TurnResilience({ accounts: new FakeAccounts(["a"]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.next(fail("usage_limit_account"))).toBeNull();
  });

  it("an unavailable model moves to the next model on the same account and benches the pair", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    const next = plan.next(fail("model_unavailable"))!;
    expect(next).toMatchObject({ accountId: "a", model: "sonnet", changedAccount: false, changedModel: true });
    expect(next.note).toContain("opus was unavailable");
    expect(fallback.isBenched("a", "opus")).toBe(true);
    expect(accounts.reports).toEqual([]);
  });

  it("fallback off: a model failure is benched but nothing else is tried", () => {
    fbCfg = FallbackConfigSchema.parse({ models: ["sonnet"] });
    const plan = new TurnResilience({ accounts: new FakeAccounts(["a"]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.next(fail("overloaded"))).toBeNull();
  });

  it("combined case: (A, opus) -> (B, opus) -> (B, sonnet)", () => {
    const accounts = new FakeAccounts(["A", "B"]);
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    const order = [[plan.current.accountId, plan.current.model]];
    const second = plan.next(fail("usage_limit_account"))!;
    order.push([second.accountId, second.model]);
    const third = plan.next(fail("model_unavailable"))!;
    order.push([third.accountId, third.model]);
    expect(order).toEqual([["A", "opus"], ["B", "opus"], ["B", "sonnet"]]);
  });

  it("a model-scoped limit keeps the model on the next account; with none left it moves to the next model", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    const onB = plan.next(fail("usage_limit_model", { resetAtMs: clock + 3_600_000 }))!;
    expect(onB).toMatchObject({ accountId: "b", model: "opus" });
    const sonnet = plan.next(fail("usage_limit_model"))!;
    expect(sonnet).toMatchObject({ accountId: "b", model: "sonnet" });
    expect(fallback.isBenched("a", "opus")).toBe(true);
    expect(store.getModelLimit("a", "opus")?.limitedUntil).toBe(clock + 3_600_000);
  });

  it("maxAttemptsPerTurn bounds the total across accounts and models", () => {
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet", "haiku"], maxAttemptsPerTurn: 2 });
    const plan = new TurnResilience({ accounts: new FakeAccounts(["a", "b", "c"]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    expect(plan.next(fail("usage_limit_account"))).not.toBeNull();
    expect(plan.next(fail("usage_limit_account"))).toBeNull();
  });

  it("a benched pair is skipped at turn start; the primary returns after the cooldown", () => {
    fallback.bench("a", "opus", undefined, "model_unavailable");
    const r = new TurnResilience({ accounts: new FakeAccounts(["a"]), models: fallback });
    expect(r.begin({ kind: "chat", primaryModel: "opus" }).current.model).toBe("sonnet");
    clock += fbCfg.cooldownMinutes * 60_000 + 1;
    expect(r.begin({ kind: "chat", primaryModel: "opus" }).current.model).toBe("opus");
  });

  it("prompt_too_long stops the chain", () => {
    const plan = new TurnResilience({ accounts: new FakeAccounts(["a", "b"]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    plan.next(fail("model_unavailable"));
    expect(plan.next(fail("prompt_too_long"))).toBeNull();
  });

  it("when every account is limited the final failure names the earliest reset", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    const plan = new TurnResilience({ accounts, models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    plan.next(fail("usage_limit_account", { resetAtMs: Date.UTC(2026, 10, 24, 2, 0) }));
    const last = fail("usage_limit_account", { resetAtMs: Date.UTC(2026, 10, 24, 9, 0), resetHint: "11am (Africa/Cairo)" });
    expect(plan.next(last)).toBeNull();
    const final = plan.finalFailure(last, "Africa/Cairo");
    expect(final).toMatchObject({ accountsExhausted: 2, resetAtMs: Date.UTC(2026, 10, 24, 2, 0) });
    expect(agentErrorUserMessage(final)).toBe(
      "All 2 Claude accounts have reached their usage limits. The earliest one resets Nov 24 at 4:00am (Africa/Cairo); message me after that.",
    );
  });

  it("a single account keeps the ordinary limit message", () => {
    const plan = new TurnResilience({ accounts: new FakeAccounts(["a"]), models: fallback }).begin({ kind: "chat", primaryModel: "opus" });
    const f = fail("usage_limit_account", { resetHint: "4am (Africa/Cairo)" });
    plan.next(f);
    expect(plan.finalFailure(f)).toBe(f);
  });

  it("one notice per fallback episode", () => {
    fallback.bench(null, "opus", undefined, "overloaded");
    const r = new TurnResilience({ models: fallback });
    const first = r.begin({ kind: "chat", primaryModel: "opus" });
    expect(first.current.model).toBe("sonnet");
    expect(first.succeeded()).toEqual(["opus is overloaded. Answering with sonnet until it recovers."]);
    expect(r.begin({ kind: "chat", primaryModel: "opus" }).succeeded()).toEqual([]);
    expect(episode).toHaveBeenCalledTimes(1);
    clock += fbCfg.cooldownMinutes * 60_000 + 1;
    expect(r.begin({ kind: "chat", primaryModel: "opus" }).succeeded()).toEqual([]);
    expect(fallback.currentEpisode()).toBeNull();
  });

  it("resumableAcross: same account always; another account only with carrySession and a carried transcript", () => {
    const accounts = new FakeAccounts(["a", "b"]);
    const r = new TurnResilience({ accounts });
    expect(r.resumableAcross("a", "a", "s")).toBe(true);
    expect(r.resumableAcross("a", "b", "s")).toBe(true);
    vi.spyOn(accounts, "carrySession").mockReturnValue(false);
    expect(r.resumableAcross("a", "b", "s")).toBe(false);
  });
});
