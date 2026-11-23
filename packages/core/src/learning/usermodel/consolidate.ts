/**
 * Weekly consolidation (R4 item 5 "Consolidation"). Code only, no model call.
 *
 * - Merge: active facts of one category that are the same statement (hash) or
 *   near-duplicates (cosine 0.93 or more) keep the stronger fact (pinned
 *   first, then confidence, then the older one); the other is superseded and
 *   its evidence is merged into the keeper. Two pinned facts are never merged.
 * - Decay: an inferred, unpinned fact not confirmed for 60 days loses 0.05,
 *   at most once per 30 days, down to 0.20.
 * - Suppress: an inferred, unpinned fact below 0.25 is suppressed (hidden from
 *   the card and from queries unless low-confidence facts are asked for).
 * - Explicit facts never decay; `/profile show` marks them "unconfirmed since"
 *   after 180 days.
 */

import { USER_MODEL_MERGE_COSINE } from "./checks.js";
import { mergeUserFactEvidence, userModelCosine, type UserFact, type UserFactStore } from "./fact-store.js";

const DAY_MS = 86_400_000;
export const USER_MODEL_DECAY_AFTER_DAYS = 60;
export const USER_MODEL_DECAY_EVERY_DAYS = 30;
export const USER_MODEL_DECAY_STEP = 0.05;
export const USER_MODEL_DECAY_FLOOR = 0.2;
export const USER_MODEL_SUPPRESS_BELOW = 0.25;
export const USER_MODEL_EXPLICIT_STALE_DAYS = 180;
export const USER_MODEL_CONSOLIDATE_EVERY_DAYS = 7;

export interface UserModelConsolidation {
  merged: number;
  decayed: number;
  suppressed: number;
}

function stronger(a: UserFact, b: UserFact): UserFact {
  if (a.pinned !== b.pinned) return a.pinned ? a : b;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return a.id < b.id ? a : b;
}

export function consolidateUserModel(store: UserFactStore, now: Date): UserModelConsolidation {
  const result: UserModelConsolidation = { merged: 0, decayed: 0, suppressed: 0 };
  const nowMs = now.getTime();

  // Merge, per category.
  const active = store.list({ status: "active" });
  const gone = new Set<number>();
  for (let i = 0; i < active.length; i++) {
    const a = active[i]!;
    if (gone.has(a.id)) continue;
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j]!;
      if (gone.has(b.id) || b.category !== a.category) continue;
      if (a.pinned && b.pinned) continue;
      const same = a.statementHash === b.statementHash || userModelCosine(a.embedding, b.embedding) >= USER_MODEL_MERGE_COSINE;
      if (!same) continue;
      const keep = stronger(a, b);
      const drop = keep === a ? b : a;
      const current = store.get(keep.id) ?? keep;
      store.confirm(keep.id, {
        evidence: mergeUserFactEvidence(current.evidence, drop.evidence),
        evidenceDays: Math.max(current.evidenceDays, drop.evidenceDays),
        confidence: current.confidence,
        kind: current.kind === "explicit" || drop.kind === "explicit" ? "explicit" : "inferred",
        now: new Date(Math.max(Date.parse(current.lastConfirmedAt), Date.parse(drop.lastConfirmedAt)) || nowMs),
      });
      store.supersede(drop.id, keep.id, now);
      gone.add(drop.id);
      result.merged++;
      if (drop === a) break;
    }
  }

  // Decay and suppress.
  for (const f of store.list({ status: "active" })) {
    if (f.pinned || f.kind !== "inferred") continue;
    let confidence = f.confidence;
    const sinceConfirmed = nowMs - Date.parse(f.lastConfirmedAt);
    const sinceUpdated = nowMs - Date.parse(f.updatedAt);
    if (sinceConfirmed >= USER_MODEL_DECAY_AFTER_DAYS * DAY_MS && sinceUpdated >= USER_MODEL_DECAY_EVERY_DAYS * DAY_MS && confidence > USER_MODEL_DECAY_FLOOR) {
      confidence = Math.max(USER_MODEL_DECAY_FLOOR, Math.round((confidence - USER_MODEL_DECAY_STEP) * 1000) / 1000);
      store.setConfidence(f.id, confidence, now);
      result.decayed++;
    }
    if (confidence < USER_MODEL_SUPPRESS_BELOW) {
      store.setStatus(f.id, "suppressed", now);
      result.suppressed++;
    }
  }
  return result;
}

/** True for an explicit fact the owner has not confirmed for 180 days. */
export function isUserFactStale(f: Pick<UserFact, "kind" | "lastConfirmedAt">, now: Date): boolean {
  return f.kind === "explicit" && now.getTime() - Date.parse(f.lastConfirmedAt) >= USER_MODEL_EXPLICIT_STALE_DAYS * DAY_MS;
}
