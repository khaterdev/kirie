/**
 * Model fallback settings and benches (PLAN C.2), the model side of the
 * per-turn loop. Off by default; with it off nothing is passed to the SDK and
 * the loop never changes model.
 *
 * A benched (account, model) pair is skipped until its reset time or
 * `cooldownMinutes`; the next turn after that tries the primary again. Benches
 * live in accounts.db so they survive a restart.
 */

import type { FallbackConfig } from "../config/sections/fallback.js";
import type { FailureClass } from "../engine/failure.js";
import { resolveFallbackChain, sdkFallbackArg } from "../engine/model-chain.js";
import type { ResilienceModelSource } from "../engine/resilience.js";
import type { SdkCallKind } from "../engine/sdk-options.js";
import type { AccountModelLimit, AccountStore } from "./account-store.js";

/** Account key for the ambient account (nothing imported). */
const AMBIENT = "";

export interface FallbackEpisode {
  model: string;
  primary: string;
  since: number;
  reason: string | null;
}

export interface FallbackControlOptions {
  store: AccountStore;
  /** Effective config: runtime overrides for `enabled` and `models` already applied */
  config: () => FallbackConfig;
  now?: () => number;
  /** Called once when a fallback model starts answering (one notice per episode) */
  onEpisodeStart?: (episode: FallbackEpisode) => void;
}

export class FallbackControl implements ResilienceModelSource {
  private readonly opts: FallbackControlOptions;
  private readonly now: () => number;
  private episode: FallbackEpisode | null = null;

  constructor(opts: FallbackControlOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  private cfg(): FallbackConfig {
    return this.opts.config();
  }

  enabled(): boolean {
    const cfg = this.cfg();
    return cfg.enabled && cfg.models.length > 0;
  }

  chain(primary: string): readonly string[] {
    return resolveFallbackChain(primary, this.cfg().models);
  }

  advancesOn(cls: FailureClass): boolean {
    return (this.cfg().on as readonly string[]).includes(cls);
  }

  isBenched(accountId: string | null, model: string): boolean {
    const limit = this.opts.store.getModelLimit(accountId ?? AMBIENT, model);
    return !!limit && limit.limitedUntil > this.now();
  }

  bench(accountId: string | null, model: string, untilMs: number | undefined, reason: FailureClass): void {
    const until = untilMs !== undefined && untilMs > this.now() ? untilMs : this.now() + this.cfg().cooldownMinutes * 60_000;
    this.opts.store.setModelLimit(accountId ?? AMBIENT, model, until, reason);
  }

  maxAttemptsPerTurn(): number {
    return this.cfg().maxAttemptsPerTurn;
  }

  answered(info: { kind: SdkCallKind; accountId: string | null; model: string; primary: string }): string | undefined {
    if (info.model === info.primary) {
      this.episode = null;
      return undefined;
    }
    if (this.episode?.model === info.model) return undefined;
    const reason = this.opts.store.getModelLimit(info.accountId ?? AMBIENT, info.primary)?.reason ?? null;
    this.episode = { model: info.model, primary: info.primary, since: this.now(), reason };
    if (this.cfg().notify) {
      try {
        this.opts.onEpisodeStart?.(this.episode);
      } catch {
        // a notice must never break the turn
      }
    }
    return fallbackNotice(this.episode);
  }

  /** Layer A: the SDK's in-turn `fallbackModel` for a spawn on `primary`, or undefined. */
  sdkFallbackFor(primary: string): string | undefined {
    const cfg = this.cfg();
    if (!cfg.enabled || !cfg.sdkNative) return undefined;
    return sdkFallbackArg(primary, cfg.models);
  }

  /** Benches still in force. accountId null = ambient. */
  benched(): Array<Omit<AccountModelLimit, "accountId"> & { accountId: string | null }> {
    const now = this.now();
    return this.opts.store
      .modelLimits()
      .filter((l) => l.limitedUntil > now)
      .map((l) => ({ ...l, accountId: l.accountId === AMBIENT ? null : l.accountId }));
  }

  clearBenches(): number {
    this.episode = null;
    return this.opts.store.clearModelLimits();
  }

  currentEpisode(): FallbackEpisode | null {
    return this.episode;
  }
}

function reasonText(reason: string | null): string {
  switch (reason) {
    case "overloaded": return "overloaded";
    case "usage_limit_model": return "at its usage limit";
    default: return "unavailable";
  }
}

/** The one line for the owner when a fallback model starts answering. */
export function fallbackNotice(ep: FallbackEpisode): string {
  return `${ep.primary} is ${reasonText(ep.reason)}. Answering with ${ep.model} until it recovers.`;
}
