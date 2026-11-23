import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGoalCheck, runGoalChecks, GOAL_CHECK_OUTPUT_TAIL_CHARS, type GoalCheckRunOptions } from "./goal-checks.js";

/**
 * The runner is exercised for real (spawn, process group, timeout, kill), but
 * with Node as the "shell": each command is a Node script, so nothing here runs
 * a real shell or touches anything outside a temp directory.
 */
let cwd: string;
let opts: GoalCheckRunOptions;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "kirie-goal-checks-"));
  opts = { cwd, shell: process.execPath, shellArgs: (script) => ["-e", script] };
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runGoalCheck", () => {
  it("passes on exit 0 and keeps the output", async () => {
    const r = await runGoalCheck({ command: "console.log('all good')", timeoutSec: 10 }, opts);
    expect(r).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(r.output).toContain("all good");
  });

  it("fails on a non-zero exit and captures stdout and stderr", async () => {
    const r = await runGoalCheck({ command: "console.log('out'); console.error('2 tests failed'); process.exit(3)", timeoutSec: 10 }, opts);
    expect(r).toMatchObject({ passed: false, exitCode: 3, timedOut: false });
    expect(r.output).toContain("out");
    expect(r.output).toContain("2 tests failed");
  });

  it("runs in the given working directory", async () => {
    const r = await runGoalCheck({ command: "console.log(process.cwd())", timeoutSec: 10 }, opts);
    expect(r.output).toContain(cwd.split("/").pop());
  });

  it("keeps only the last 2000 characters", async () => {
    const r = await runGoalCheck({ command: "process.stdout.write('a'.repeat(50000) + 'THE-END')", timeoutSec: 10 }, opts);
    expect(r.output.length).toBe(GOAL_CHECK_OUTPUT_TAIL_CHARS);
    expect(r.output.endsWith("THE-END")).toBe(true);
  });

  it("kills the whole process group at the timeout and fails", async () => {
    // The check starts a grandchild in the same group, prints its pid, then hangs.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "console.log('child=' + c.pid);",
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    const started = Date.now();
    const r = await runGoalCheck({ command: script, timeoutSec: 1 }, opts);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r).toMatchObject({ passed: false, timedOut: true });
    expect(r.output).toContain("timed out after 1s");
    const pid = Number(/child=(\d+)/.exec(r.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    const p = runGoalCheck({ command: "setTimeout(() => {}, 60000)", timeoutSec: 60 }, { ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.passed).toBe(false);
    expect(r.output).toContain("check cancelled");
  });

  it("fails without running when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runGoalCheck({ command: "console.log('x')", timeoutSec: 10 }, { ...opts, signal: ac.signal });
    expect(r).toMatchObject({ passed: false, exitCode: null });
  });

  it("fails when the shell cannot start", async () => {
    const r = await runGoalCheck({ command: "x", timeoutSec: 5 }, { ...opts, shell: join(cwd, "no-such-shell") });
    expect(r.passed).toBe(false);
    expect(r.output).toContain("could not start the check");
  });

  it("uses /bin/zsh -lc by default (argument shape only)", async () => {
    const seen: string[][] = [];
    await runGoalCheck(
      { command: "pnpm test", timeoutSec: 5 },
      { cwd, shell: process.execPath, shellArgs: (c) => { seen.push(["-lc", c]); return ["-e", "process.exit(0)"]; } },
    );
    expect(seen).toEqual([["-lc", "pnpm test"]]);
  });
});

describe("runGoalChecks", () => {
  it("runs in order and stops at the first failure", async () => {
    const results = await runGoalChecks(
      [
        { command: "console.log('one')", timeoutSec: 10 },
        { command: "process.exit(1)", timeoutSec: 10 },
        { command: "console.log('three')", timeoutSec: 10 },
      ],
      opts,
    );
    expect(results.map((r) => r.passed)).toEqual([true, false]);
  });

  it("returns every result when all pass", async () => {
    const results = await runGoalChecks(
      [{ command: "process.exit(0)", timeoutSec: 10 }, { command: "process.exit(0)", timeoutSec: 10 }],
      opts,
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
