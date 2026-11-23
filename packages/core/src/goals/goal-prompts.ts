/**
 * Messages sent to a goal's worker session (PLAN C.7, R2 "Worker prompt").
 * Built only from the owner's goal text, the owner's check commands, the caps,
 * and the daemon's own check results and judge verdict.
 */

import type { GoalCheckResult, GoalRecord, GoalVerdictRecord } from "./goal-store.js";

const CHECK_OUTPUT_FOR_WORKER_CHARS = 2000;

export interface GoalAllowance {
  roundsLeft: number;
  minutesLeft: number | null;
  budgetLeftUsd: number;
}

export function goalAllowance(goal: GoalRecord, now: number): GoalAllowance {
  return {
    roundsLeft: Math.max(0, goal.roundLimit - goal.roundsUsed),
    minutesLeft: goal.deadlineAtMs === null ? null : Math.max(0, Math.round((goal.deadlineAtMs - now) / 60_000)),
    budgetLeftUsd: Math.max(0, goal.costLimitUsd - goal.costUsd),
  };
}

function capsLine(goal: GoalRecord, now: number): string {
  const a = goalAllowance(goal, now);
  const minutes = a.minutesLeft === null ? `${goal.maxMinutes} minutes` : `${a.minutesLeft} minutes`;
  return `Remaining: ${a.roundsLeft} round(s), about ${minutes}, about $${a.budgetLeftUsd.toFixed(2)} of estimated cost.`;
}

function checksBlock(goal: GoalRecord): string {
  if (goal.checks.length === 0) return "There are no must-pass checks; a judge decides from the evidence in your report.";
  return [
    "Must-pass checks. The daemon runs these itself after each round, in this order, and the goal cannot be done until every one exits 0:",
    ...goal.checks.map((c) => `- ${c.command}`),
  ].join("\n");
}

const REPORT_RULES = [
  "Rules:",
  "- Work autonomously. Nobody answers questions during a round.",
  "- Never claim completion without evidence. Run the commands that prove it and show their real output.",
  "- You cannot change the goal, its checks or its caps.",
  "- End every reply with a report in exactly this form:",
  "GOAL_REPORT",
  "status: done | in_progress | blocked",
  "evidence: <commands you ran and their real output, paths, URLs>",
  "remaining: <what is still missing, or none>",
  "- Say blocked only when only the owner can unblock you (a credential, a decision, a denied approval), and say exactly what is needed.",
].join("\n");

function header(goal: GoalRecord): string[] {
  return [
    `<goal id="${goal.id}">`,
    `<session_context session_key="${goal.sessionKey}" />`,
    "",
    goal.createdBy === "agent" ? "Goal (requested by the agent, approved by the owner):" : "Goal (from the owner):",
    goal.goal,
    "",
    ...(goal.cwd ? [`Project directory: ${goal.cwd} (the checks run there).`, ""] : []),
    checksBlock(goal),
    "",
  ];
}

/** The first message of a goal's first worker session. */
export function buildGoalInitialPrompt(goal: GoalRecord, now: number): string {
  return [
    ...header(goal),
    `You are working on this goal in the background, in rounds. Round 1 of at most ${goal.roundLimit}.`,
    capsLine(goal, now),
    "",
    REPORT_RULES,
    "</goal>",
  ].join("\n");
}

/** After a daemon restart. */
export function buildGoalRestartPrompt(goal: GoalRecord, now: number): string {
  return [
    ...header(goal),
    `The daemon restarted. You are on round ${goal.roundsUsed + 1} of at most ${goal.roundLimit} toward the goal above.`,
    "Re-check the current state before continuing; work done before the restart may be partial.",
    capsLine(goal, now),
    "",
    REPORT_RULES,
    "</goal>",
  ].join("\n");
}

/** After the owner resumed a paused, blocked or exhausted goal. */
export function buildGoalResumePrompt(goal: GoalRecord, now: number, note: string | null, freshSession: boolean): string {
  return [
    ...(freshSession ? header(goal) : [`<goal id="${goal.id}">`, ""]),
    `The owner resumed this goal. Round ${goal.roundsUsed + 1} of at most ${goal.roundLimit}.`,
    ...(goal.lastVerdict ? [`Last verdict: ${goal.lastVerdict.verdict}: ${goal.lastVerdict.reason}`] : []),
    ...(note ? ["", "Message from the owner:", note] : []),
    "Re-check the current state before continuing.",
    capsLine(goal, now),
    "",
    REPORT_RULES,
    "</goal>",
  ].join("\n");
}

/** The message that starts the next round. */
export function buildGoalContinuePrompt(
  goal: GoalRecord,
  verdict: GoalVerdictRecord,
  failedCheck: GoalCheckResult | undefined,
  now: number,
): string {
  const lines = [
    `<goal_continue goal="${goal.id}" round="${goal.roundsUsed + 1}" of="${goal.roundLimit}">`,
    "The goal is not done yet.",
  ];
  if (failedCheck) {
    lines.push(
      "",
      `A must-pass check failed: ${failedCheck.command} (${failedCheck.timedOut ? "timed out" : `exit ${failedCheck.exitCode ?? "none"}`}).`,
      "Last output:",
      failedCheck.output.slice(-CHECK_OUTPUT_FOR_WORKER_CHARS) || "(no output)",
      "",
      "Fix the underlying problem so this check passes. The goal cannot be done while any check fails.",
      "If the check itself is wrong or cannot pass, say blocked and explain why.",
    );
  } else if (verdict.source === "error") {
    lines.push("", `The last round ended with an error: ${verdict.reason}`, "Continue toward the goal.");
  } else if (verdict.source === "judge_failure") {
    lines.push("", "The judge could not evaluate the last round. Continue, and make the evidence in your report explicit.");
  } else {
    lines.push("", `Judge: ${verdict.reason}`);
    if (verdict.missing.length > 0) lines.push("Missing:", ...verdict.missing.map((m) => `- ${m}`));
  }
  lines.push("", capsLine(goal, now), "Take the next concrete step, then end with the GOAL_REPORT block.", "</goal_continue>");
  return lines.join("\n");
}
