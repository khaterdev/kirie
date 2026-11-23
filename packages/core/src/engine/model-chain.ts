/**
 * Model fallback chain helpers (PLAN C.2).
 *
 * Layer A hands the chain to the SDK's own in-turn fallback (`fallbackModel`,
 * overload inside a running turn). Layer B, in resilience.ts, moves to the next
 * model between attempts of a turn when a failure is about the model itself.
 */

import type { FailureClass } from "./failure.js";

/** Model ids accepted anywhere a model reaches a spawn argument. */
export const MODEL_ID_RE = /^[A-Za-z0-9._\-[\]:]{1,64}$/;

/** At most this many fallback models. */
export const MAX_FALLBACK_MODELS = 4;

export function isValidModelId(model: string): boolean {
  return MODEL_ID_RE.test(model);
}

/** The fallback chain for a primary: valid ids, de-duplicated, primary removed, capped. */
export function resolveFallbackChain(primary: string, models: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || model === primary || !isValidModelId(model) || out.includes(model)) continue;
    out.push(model);
    if (out.length >= MAX_FALLBACK_MODELS) break;
  }
  return out;
}

/**
 * The SDK's `fallbackModel` value: the chain joined with commas, or undefined
 * when empty. Never contains the primary (the SDK throws when they are equal).
 */
export function sdkFallbackArg(primary: string, chain: readonly string[]): string | undefined {
  const resolved = resolveFallbackChain(primary, chain);
  return resolved.length > 0 ? resolved.join(",") : undefined;
}

/** Parse "m1, m2 m3" into model ids. Returns the invalid entries separately. */
export function parseModelList(text: string): { models: string[]; invalid: string[] } {
  const models: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    if (isValidModelId(part)) {
      if (!models.includes(part)) models.push(part);
    } else {
      invalid.push(part);
    }
  }
  return { models, invalid };
}

/** Which pointer a failure moves (R1 item 2 table, DECISIONS 11). */
export type FailureRemedy = "next_account" | "next_account_then_model" | "next_model" | "stop";

export function remedyFor(cls: FailureClass): FailureRemedy {
  switch (cls) {
    case "usage_limit_account":
    case "auth":
      return "next_account";
    case "usage_limit_model":
      return "next_account_then_model";
    case "model_unavailable":
    case "overloaded":
      return "next_model";
    default:
      return "stop";
  }
}
