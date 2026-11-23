/**
 * Must-pass checks of a goal (PLAN C.7).
 *
 * The daemon runs each check itself: `/bin/zsh -lc <command>` in the goal's
 * working directory, in its own process group, killed as a group at the
 * timeout or on abort. Pass means exit code 0. The last 2000 characters of
 * combined output are kept, scrubbed. Commands are the owner's text, fixed at
 * creation; nothing here composes or edits them.
 */

import { spawn } from "node:child_process";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { GoalCheck, GoalCheckResult } from "./goal-store.js";

export const GOAL_CHECK_OUTPUT_TAIL_CHARS = 2000;
/** After the process exits, wait this long for its pipes to close before giving up on them. */
const PIPE_GRACE_MS = 2000;

export interface GoalCheckRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Shell executable. Default /bin/zsh */
  shell?: string;
  /** Arguments for the shell. Default ["-lc", command] */
  shellArgs?: (command: string) => string[];
  env?: NodeJS.ProcessEnv;
}

/** Keeps only the tail of a stream without holding all of it. */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    if (this.size > this.limit * 4) this.compact();
  }

  private compact(): void {
    const joined = this.chunks.join("");
    const tail = joined.slice(-this.limit);
    this.chunks = [tail];
    this.size = tail.length;
  }

  toString(): string {
    return this.chunks.join("").slice(-this.limit);
  }
}

/** Kill the check's process group. `groupOnly` after the leader exited, so a reused pid is never hit. */
function killGroup(pid: number | undefined, groupOnly = false): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (groupOnly) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Run one check. Never rejects. */
export function runGoalCheck(check: GoalCheck, opts: GoalCheckRunOptions): Promise<GoalCheckResult> {
  const started = Date.now();
  const tail = new TailBuffer(GOAL_CHECK_OUTPUT_TAIL_CHARS);
  const finish = (r: Omit<GoalCheckResult, "command" | "durationMs" | "output">, extra?: string): GoalCheckResult => {
    let output = tail.toString();
    if (extra) output = `${output}${output ? "\n" : ""}${extra}`.slice(-GOAL_CHECK_OUTPUT_TAIL_CHARS);
    return {
      command: check.command,
      ...r,
      output: scrubSecrets(output, { sink: "model-input" }),
      durationMs: Date.now() - started,
    };
  };

  if (opts.signal?.aborted) {
    return Promise.resolve(finish({ passed: false, exitCode: null, signal: null, timedOut: false }, "check cancelled"));
  }

  return new Promise<GoalCheckResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const shell = opts.shell ?? "/bin/zsh";
    const args = opts.shellArgs ? opts.shellArgs(check.command) : ["-lc", check.command];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve(finish({ passed: false, exitCode: null, signal: null, timedOut: false }, `could not start the check: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const done = (extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const note = extra ?? (timedOut ? `check timed out after ${check.timeoutSec}s` : aborted ? "check cancelled" : undefined);
      resolve(finish({ passed: !timedOut && !aborted && exitCode === 0, exitCode, signal: exitSignal, timedOut }, note));
    };

    const onAbort = (): void => {
      aborted = true;
      killGroup(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, Math.max(1, check.timeoutSec) * 1000);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => tail.push(d));
    child.stderr?.on("data", (d: string) => tail.push(d));

    child.on("error", (err) => {
      killGroup(child.pid);
      done(`could not start the check: ${err.message}`);
    });
    child.on("exit", (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      // A process left in the group could keep the pipes open: stop waiting for them.
      killGroup(child.pid, true);
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done();
      }, PIPE_GRACE_MS);
    });
    child.on("close", () => done());
  });
}

/** Run checks in order; the first failure stops the list. */
export async function runGoalChecks(checks: readonly GoalCheck[], opts: GoalCheckRunOptions): Promise<GoalCheckResult[]> {
  const results: GoalCheckResult[] = [];
  for (const check of checks) {
    const result = await runGoalCheck(check, opts);
    results.push(result);
    if (!result.passed) break;
  }
  return results;
}
