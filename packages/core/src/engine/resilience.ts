/**
 * The per-turn candidate loop over accounts and models (PLAN C.1, C.2).
 *
 * A turn starts on the active account (sticky, fill-first) and the first model
 * of `[primary, ...fallback chain]` that is not benched for that account. When
 * an attempt fails, the failure class decides which pointer moves
 * (DECISIONS 11): an account-wide limit or an auth failure moves to the next
 * **account**; a model-scoped limit moves to the next account and only when
 * none is left to the next **model**; an unavailable or overloaded model moves
 * to the next **model** on the same account. Everything else is not this
 * loop's business and the engines keep today's behaviour for it.
 *
 * The engines only call `begin`, `next` and `succeeded`; which account and
 * model are usable is decided by the two sources (the accounts feature
 * implements both). With no source, or zero imported accounts and fallback
 * off, `begin` returns the ambient account and the configured model and
 * `next` always returns null, so every call site behaves exactly as before.
 *
 * Rotation happens only at turn boundaries: `begin` runs before a turn, and
 * `next` runs after an attempt has already ended. Nothing here closes a
 * process; the engines do that, and only for an idle session.
 */

import { formatResetTime } from "./reset-time.js";
import type { FailureClass, FailureInfo } from "./failure.js";
import { remedyFor } from "./model-chain.js";
import type { SdkCallKind } from "./sdk-options.js";

/** An account to spawn a Claude process with. accountId null = ambient (nothing imported). */
export interface AccountLease {
  readonly accountId: string | null;
  /** Full child env for the account, or undefined to spawn with the daemon's env as today */
  readonly env: Record<string, string> | undefined;
}

export interface AccountAcquireResult extends AccountLease {
  /** No usable account: the lease is the active one anyway, so the caller can decide */
  readonly exhausted: boolean;
  /** Earliest time an unusable account becomes usable again */
  readonly earliestResetAt?: number;
}

export type TranscriptCarry = "same" | "copied" | "failed";

/** What the loop needs from the account manager. */
export interface ResilienceAccountSource {
  hasAccounts(): boolean;
  /** Turn start: the account to use. May rotate away from an unusable active account when rotation is on. */
  acquire(opts?: { exclude?: ReadonlySet<string> }): AccountAcquireResult;
  /** Record an account-wide limit or an auth failure against the account that ran the attempt. */
  reportFailure(accountId: string, failure: FailureInfo): void;
  reportSuccess(accountId: string): void;
  rotationEnabled(): boolean;
  maxRotationsPerTurn(): number;
  /** Resume the same SDK session on the next account (accounts.rotation.carrySession) */
  carrySession(): boolean;
  /** Make a transcript written under `from` resumable under `to`. Call after the old process exited. */
  carryTranscript(from: string | null, to: string | null, sdkSessionId: string): TranscriptCarry;
  /** Number of imported, enabled accounts */
  enabledCount(): number;
}

/** What the loop needs from the fallback-model settings. */
export interface ResilienceModelSource {
  enabled(): boolean;
  /** Fallback models after the primary: de-duplicated, primary removed */
  chain(primary: string): readonly string[];
  /** Whether this failure class may advance to the next model (agent.fallback.on) */
  advancesOn(cls: FailureClass): boolean;
  isBenched(accountId: string | null, model: string): boolean;
  /** Skip (account, model) until `untilMs`, or for the configured cooldown when undefined */
  bench(accountId: string | null, model: string, untilMs: number | undefined, reason: FailureClass): void;
  maxAttemptsPerTurn(): number;
  /** A turn finished on `model`. Returns the owner notice when a fallback episode starts. */
  answered(info: { kind: SdkCallKind; accountId: string | null; model: string; primary: string }): string | undefined;
}

export interface TurnCandidate {
  readonly accountId: string | null;
  readonly env: Record<string, string> | undefined;
  readonly model: string;
}

export interface TurnAdvance extends TurnCandidate {
  readonly previous: TurnCandidate;
  readonly changedAccount: boolean;
  readonly changedModel: boolean;
  readonly reason: FailureClass;
  /** One `<system_note>` line to put in front of the re-sent message */
  readonly note: string;
}

/** Extra fields an exhausted-accounts failure carries (read by agentErrorUserMessage). */
export interface AccountsExhaustedFields {
  /** Number of enabled accounts, all of which are limited or signed out */
  accountsExhausted?: number;
}

export const DEFAULT_MAX_ATTEMPTS_PER_TURN = 4;

export const ACCOUNT_SWITCH_NOTE =
  "<system_note>The previous attempt at this message failed because the Claude account reached its usage limit. Kirie switched accounts. If work on this message already appears above, continue from where it stopped instead of starting over.</system_note>";

export const ACCOUNT_AUTH_SWITCH_NOTE =
  "<system_note>The previous attempt at this message failed because the Claude account is signed out. Kirie switched accounts. If work on this message already appears above, continue from where it stopped instead of starting over.</system_note>";

export function modelSwitchNote(from: string, to: string, reason: FailureClass): string {
  const why = reason === "overloaded" ? "was overloaded" : reason === "usage_limit_model" ? "reached its usage limit" : "was unavailable";
  return `<system_note>The previous attempt at this message failed because the model ${from} ${why}. Kirie switched to ${to}. If work on this message already appears above, continue from where it stopped instead of starting over.</system_note>`;
}

export class TurnPlan {
  private cur: TurnCandidate;
  private attempts = 1;
  private rotations = 0;
  private readonly triedAccounts = new Set<string>();
  private readonly triedPairs = new Set<string>();
  private exhausted: boolean;
  private earliestResetAt: number | undefined;

  constructor(
    private readonly accounts: ResilienceAccountSource | null,
    private readonly models: ResilienceModelSource | null,
    private readonly kind: SdkCallKind,
    readonly primaryModel: string,
  ) {
    const lease: AccountAcquireResult = accounts?.hasAccounts()
      ? accounts.acquire()
      : { accountId: null, env: undefined, exhausted: false };
    this.exhausted = lease.exhausted;
    this.earliestResetAt = lease.earliestResetAt;
    this.cur = { accountId: lease.accountId, env: lease.env, model: this.modelFor(lease.accountId) };
    if (lease.accountId !== null) this.triedAccounts.add(lease.accountId);
    this.triedPairs.add(pairKey(this.cur.accountId, this.cur.model));
  }

  /** The candidate for the current attempt. */
  get current(): TurnCandidate {
    return this.cur;
  }

  /** Number of attempts so far, including the current one. */
  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * The current attempt failed with `failure`. Records it (bench the account
   * or the account-model pair) and returns the next candidate, or null when
   * nothing else may be tried this turn.
   */
  next(failure: FailureInfo): TurnAdvance | null {
    const prev = this.cur;
    const cls = failure.class;

    if ((cls === "usage_limit_account" || cls === "auth") && prev.accountId !== null) {
      this.accounts?.reportFailure(prev.accountId, failure);
    }
    if (cls === "usage_limit_model" || cls === "model_unavailable" || cls === "overloaded") {
      this.models?.bench(prev.accountId, prev.model, cls === "usage_limit_model" ? failure.resetAtMs : undefined, cls);
    }

    const remedy = remedyFor(cls);
    if (remedy === "stop") return null;
    if (this.attempts >= (this.models?.maxAttemptsPerTurn() ?? DEFAULT_MAX_ATTEMPTS_PER_TURN)) return null;

    let candidate: TurnCandidate | null = null;
    if (remedy === "next_account") candidate = this.nextAccount();
    else if (remedy === "next_account_then_model") candidate = this.nextAccount(prev.model) ?? this.nextModel(prev, cls);
    else candidate = this.nextModel(prev, cls);
    if (!candidate) return null;

    this.attempts += 1;
    this.cur = candidate;
    this.triedPairs.add(pairKey(candidate.accountId, candidate.model));
    const changedAccount = candidate.accountId !== prev.accountId;
    const changedModel = candidate.model !== prev.model;
    const note = changedAccount
      ? cls === "auth" ? ACCOUNT_AUTH_SWITCH_NOTE : ACCOUNT_SWITCH_NOTE
      : modelSwitchNote(prev.model, candidate.model, cls);
    return { ...candidate, previous: prev, changedAccount, changedModel, reason: cls, note };
  }

  /** The current attempt succeeded. Returns notices for the result (a fallback episode start). */
  succeeded(): string[] {
    if (this.cur.accountId !== null) this.accounts?.reportSuccess(this.cur.accountId);
    const notice = this.models?.answered({
      kind: this.kind,
      accountId: this.cur.accountId,
      model: this.cur.model,
      primary: this.primaryModel,
    });
    return notice ? [notice] : [];
  }

  /**
   * The failure to report when the loop gave up. When every account is
   * limited, it carries the earliest reset across accounts and the number of
   * accounts, so the user sees "all accounts limited, earliest reset ...".
   */
  finalFailure(failure: FailureInfo, defaultTz?: string): FailureInfo & AccountsExhaustedFields {
    const n = this.accounts?.enabledCount() ?? 0;
    const cls = failure.class;
    const accountWide = cls === "usage_limit_account" || cls === "usage_limit_model" || cls === "auth";
    if (!this.exhausted || n < 2 || !accountWide) return failure;
    const out: FailureInfo & AccountsExhaustedFields = { ...failure, accountsExhausted: n };
    if (this.earliestResetAt !== undefined) {
      out.resetAtMs = this.earliestResetAt;
      out.resetHint = formatResetTime(this.earliestResetAt, defaultTz);
      if (out.class === "auth") out.class = "usage_limit_account";
    }
    return out;
  }

  private modelFor(accountId: string | null, preferred?: string): string {
    const models = this.models;
    if (!models || !models.enabled()) return preferred ?? this.primaryModel;
    if (preferred && !models.isBenched(accountId, preferred)) return preferred;
    for (const model of [this.primaryModel, ...models.chain(this.primaryModel)]) {
      if (!models.isBenched(accountId, model)) return model;
    }
    return preferred ?? this.primaryModel;
  }

  private nextAccount(requireModel?: string): TurnCandidate | null {
    const accounts = this.accounts;
    if (!accounts || !accounts.hasAccounts() || !accounts.rotationEnabled()) return null;
    while (this.rotations < accounts.maxRotationsPerTurn()) {
      const lease = accounts.acquire({ exclude: this.triedAccounts });
      if (lease.exhausted || lease.accountId === null || this.triedAccounts.has(lease.accountId)) {
        this.exhausted = true;
        this.earliestResetAt = lease.earliestResetAt;
        return null;
      }
      this.rotations += 1;
      this.triedAccounts.add(lease.accountId);
      // A model-scoped limit keeps the model while some account can still serve it.
      if (requireModel && this.models?.isBenched(lease.accountId, requireModel)) continue;
      return { accountId: lease.accountId, env: lease.env, model: requireModel ?? this.modelFor(lease.accountId) };
    }
    return null;
  }

  private nextModel(prev: TurnCandidate, cls: FailureClass): TurnCandidate | null {
    const models = this.models;
    if (!models || !models.enabled() || !models.advancesOn(cls)) return null;
    const order = [this.primaryModel, ...models.chain(this.primaryModel)];
    const start = order.indexOf(prev.model) + 1;
    for (const model of order.slice(start)) {
      if (this.triedPairs.has(pairKey(prev.accountId, model))) continue;
      if (models.isBenched(prev.accountId, model)) continue;
      return { accountId: prev.accountId, env: prev.env, model };
    }
    return null;
  }
}

function pairKey(accountId: string | null, model: string): string {
  return `${accountId ?? ""}\u0000${model}`;
}

/** The loop's entry point, shared by the v2, v1 and background engines. */
export class TurnResilience {
  constructor(
    private readonly deps: { accounts?: ResilienceAccountSource | null; models?: ResilienceModelSource | null },
  ) {}

  /** Plan one turn. Call right before the first attempt. */
  begin(input: { kind: SdkCallKind; primaryModel: string }): TurnPlan {
    return new TurnPlan(this.deps.accounts ?? null, this.deps.models ?? null, input.kind, input.primaryModel);
  }

  /** Upper bound on attempts per turn across accounts and models (also caps task re-queues). */
  maxAttemptsPerTurn(): number {
    return this.deps.models?.maxAttemptsPerTurn() ?? DEFAULT_MAX_ATTEMPTS_PER_TURN;
  }

  /** True when an SDK session may be resumed on another account. */
  carrySession(): boolean {
    return this.deps.accounts?.carrySession() ?? true;
  }

  /** See ResilienceAccountSource.carryTranscript. Without accounts there is nothing to carry. */
  carryTranscript(from: string | null, to: string | null, sdkSessionId: string): TranscriptCarry {
    if (from === to) return "same";
    return this.deps.accounts?.carryTranscript(from, to, sdkSessionId) ?? "same";
  }

  /**
   * Whether a session last bound to `from` may be resumed under `to`: same
   * account, or carrySession on and the transcript carried.
   */
  resumableAcross(from: string | null, to: string | null, sdkSessionId: string): boolean {
    if (from === to) return true;
    if (!this.carrySession()) return false;
    return this.carryTranscript(from, to, sdkSessionId) !== "failed";
  }
}
