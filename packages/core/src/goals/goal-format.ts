/**
 * Plain-text formatting shared by goal progress messages and /goal replies.
 */

import type { GoalRecord } from "./goal-store.js";

export function formatGoalElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

export function formatGoalMinutes(minutes: number): string {
  return formatGoalElapsed(minutes * 60_000);
}

export function formatGoalCost(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}

/** First line of the goal text, shortened. */
export function goalTitle(goal: Pick<GoalRecord, "goal">, max = 60): string {
  const first = goal.goal.split("\n")[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export function goalElapsedMs(goal: GoalRecord, now: number): number {
  return goal.startedAtMs === null ? 0 : now - goal.startedAtMs;
}

/** "g-ab12cd running, round 3/10, 14m, about $1.20: fix the auth tests" */
export function formatGoalLine(goal: GoalRecord, now: number): string {
  const parts = [`${goal.id} ${goal.status.replace("_", " ")}`];
  if (goal.roundsUsed > 0 || goal.startedAtMs !== null) {
    parts.push(`round ${goal.roundsUsed}/${goal.roundLimit}`);
    parts.push(formatGoalElapsed(goalElapsedMs(goal, now)));
    parts.push(`about ${formatGoalCost(goal.costUsd)}`);
  }
  return `${parts.join(", ")}: ${goalTitle(goal)}`;
}

export function formatGoalCaps(goal: GoalRecord): string {
  return `${goal.roundLimit} rounds, ${formatGoalMinutes(goal.maxMinutes)}, ${formatGoalCost(goal.costLimitUsd)}`;
}
