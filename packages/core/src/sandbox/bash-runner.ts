/**
 * The `sandbox_bash` runner (PLAN C.10): one command, inside the container,
 * through `docker exec`. Never on the host: a missing container, a stopped
 * one or an unreachable Docker daemon is an error, with no fallback.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  SANDBOX_CONTAINER_NAME_PATTERN,
  SANDBOX_EXEC_DEFAULT_SECONDS,
  SANDBOX_EXEC_MAX_SECONDS,
  buildSandboxExecArgs,
  sandboxDockerClientEnv,
} from "./docker.js";

/** Output kept per call (head and tail), like the built-in Bash tool. */
export const SANDBOX_OUTPUT_MAX_CHARS = 30_000;
/** The docker client is killed this long after the in-container timeout should have fired. */
const CLIENT_GRACE_MS = 15_000;

export type SandboxSpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SandboxBashTarget {
  binary: string;
  container: string;
  workdir: string;
}

export interface SandboxBashResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Errors meaning the container or Docker is not there: reported as such, never retried on the host. */
const INFRA_ERROR = /no such container|is not running|cannot connect to the docker daemon|error response from daemon|is the docker daemon running|container .* is paused/i;

export class SandboxUnavailableError extends Error {}

/** Keeps the first and the last part of a stream in bounded memory. */
class OutputCapture {
  private head = "";
  private tail = "";
  total = 0;
  constructor(private readonly half = SANDBOX_OUTPUT_MAX_CHARS) {}
  push(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.half) {
      const take = rest.slice(0, this.half - this.head.length);
      this.head += take;
      rest = rest.slice(take.length);
    }
    if (rest) this.tail = (this.tail + rest).slice(-this.half);
  }
  get omitted(): number {
    return this.total - this.head.length - this.tail.length;
  }
  text(): string {
    return this.omitted > 0 ? `${this.head}\n\n[... ${this.omitted} characters omitted ...]\n\n${this.tail}` : this.head + this.tail;
  }
}

/** Keep the first and last part of long output. */
export function truncateSandboxOutput(text: string, max = SANDBOX_OUTPUT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const hidden = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n\n[... ${hidden} characters omitted ...]\n\n${text.slice(text.length - tail)}`, truncated: true };
}

/** Validate the target the kirie-tools server got from the daemon. */
export function sandboxBashTargetFromEnv(env: Record<string, string | undefined>): SandboxBashTarget | { error: string } {
  const binary = env.KIRIE_DOCKER_BIN;
  const container = env.KIRIE_SANDBOX_CONTAINER;
  const workdir = env.KIRIE_SANDBOX_WORKDIR;
  if (!binary || !isAbsolute(binary)) return { error: "the docker binary was not found when this session started" };
  if (!container || !SANDBOX_CONTAINER_NAME_PATTERN.test(container)) return { error: "no sandbox container is configured for this session" };
  if (!workdir || !isAbsolute(workdir) || /[\0\n\r]/.test(workdir)) return { error: "no sandbox workspace is configured for this session" };
  return { binary, container, workdir };
}

/** Seconds for one call: Bash's `timeout` is milliseconds; default from config, max 600 s. */
export function sandboxBashTimeoutSeconds(timeoutMs: unknown, defaultSeconds: number): number {
  const fallback = Number.isFinite(defaultSeconds) && defaultSeconds > 0 ? defaultSeconds : SANDBOX_EXEC_DEFAULT_SECONDS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return Math.min(SANDBOX_EXEC_MAX_SECONDS, fallback);
  return Math.min(SANDBOX_EXEC_MAX_SECONDS, Math.max(1, Math.ceil(timeoutMs / 1000)));
}

/**
 * Run one command in the container. Resolves with exit code and capped
 * output; rejects with `SandboxUnavailableError` when the container or Docker
 * is not there. The command is a single argv element; no host shell is used.
 */
export function runSandboxBash(
  target: SandboxBashTarget,
  command: string,
  timeoutSeconds: number,
  opts: { spawn?: SandboxSpawnFn; env?: Record<string, string> } = {},
): Promise<SandboxBashResult> {
  const spawn = opts.spawn ?? (nodeSpawn as SandboxSpawnFn);
  const args = buildSandboxExecArgs({ container: target.container, workdir: target.workdir, command, timeoutSeconds });
  return new Promise<SandboxBashResult>((resolveRun, rejectRun) => {
    let child: ChildProcess;
    try {
      child = spawn(target.binary, args, { env: opts.env ?? sandboxDockerClientEnv(), stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (err) {
      rejectRun(new SandboxUnavailableError(`could not start the docker client: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const out = new OutputCapture();
    const err = new OutputCapture();
    child.stdout?.on("data", (c: Buffer) => out.push(c.toString()));
    child.stderr?.on("data", (c: Buffer) => err.push(c.toString()));
    child.stdin?.end();

    let clientKilled = false;
    const killer = setTimeout(() => {
      clientKilled = true;
      child.kill("SIGKILL");
    }, Math.ceil(timeoutSeconds) * 1000 + CLIENT_GRACE_MS);

    child.on("error", (e) => {
      clearTimeout(killer);
      rejectRun(new SandboxUnavailableError(`could not run the docker client: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      const stdout = out.text();
      const stderr = err.text();
      if (code !== 0 && code !== null && out.total === 0 && INFRA_ERROR.test(stderr)) {
        rejectRun(new SandboxUnavailableError(`the sandbox container is not available: ${stderr.split("\n")[0]!.trim().slice(0, 200)}`));
        return;
      }
      const combined = stderr ? (stdout ? `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}` : stderr) : stdout;
      const { text, truncated } = truncateSandboxOutput(combined);
      resolveRun({
        exitCode: code,
        output: text,
        truncated: truncated || out.omitted > 0 || err.omitted > 0,
        timedOut: clientKilled || code === 124 || code === 137,
      });
    });
  });
}
