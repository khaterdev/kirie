/**
 * Docker CLI helpers for docker mode (PLAN C.10, R2 section 5).
 *
 * - The binary is resolved from config or known absolute paths, never `PATH`
 *   (launchd's PATH may not contain /usr/local/bin).
 * - The docker client runs with a minimal environment: no secret the daemon
 *   holds can reach it, and `docker exec` never forwards variables.
 * - Images are inspected, never pulled.
 * - Container create arguments always carry the hardening flags.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SandboxConfig, SandboxDockerExec, SandboxDockerResult } from "./types.js";

/** Tried in this order when `sandbox.docker.binary` is not set. */
export const SANDBOX_DOCKER_BINARY_CANDIDATES: readonly string[] = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
];

/** The one shared container (scope `shared`). */
export const SANDBOX_SHARED_CONTAINER_NAME = "kirie-sandbox-shared";
/** Label on every container Kirie creates; orphans are found by it. */
export const SANDBOX_CONTAINER_LABEL = "kirie.sandbox=1";
export const SANDBOX_FINGERPRINT_LABEL = "kirie.sandbox.fingerprint";
/** Container references `sandbox_bash` accepts from its environment: the pinned container id (or a Kirie container name). */
export const SANDBOX_CONTAINER_NAME_PATTERN = /^(?:[a-f0-9]{12,64}|kirie-sandbox-[a-z0-9-]{1,40})$/;

/** A plain image reference. A leading `-` would be read by docker as a flag. */
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;

/** Why an image reference is refused, or null. */
export function sandboxImageRefusal(image: string): string | null {
  return IMAGE_PATTERN.test(image) ? null : `sandbox.docker.image "${image.slice(0, 80)}" is not a plain image reference`;
}

/** Default docker CLI timeout for management calls (info, inspect, create, rm). */
export const SANDBOX_DOCKER_CALL_TIMEOUT_MS = 30_000;

/** Environment variables passed through to the docker client, and nothing else. */
const DOCKER_CLIENT_ENV_KEYS = ["HOME", "USER", "LOGNAME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];
const DOCKER_CLIENT_PATH = "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The docker client's environment: a fixed PATH plus the few variables the CLI needs to find its context. */
export function sandboxDockerClientEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: DOCKER_CLIENT_PATH };
  for (const key of DOCKER_CLIENT_ENV_KEYS) {
    const v = source[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }
  return env;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The docker binary: `configured` when given (must be absolute and
 * executable), else the first existing known location. Never looks at PATH.
 */
export function resolveSandboxDockerBinary(
  configured: string | undefined,
  isExecutable: (p: string) => boolean = isExecutableFile,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (configured !== undefined && configured.trim() !== "") {
    const p = configured.trim();
    if (!isAbsolute(p)) return { ok: false, reason: `sandbox.docker.binary must be an absolute path (got "${p}")` };
    if (!isExecutable(p)) return { ok: false, reason: `sandbox.docker.binary ${p} is not an executable file` };
    return { ok: true, path: p };
  }
  for (const candidate of SANDBOX_DOCKER_BINARY_CANDIDATES) {
    if (isExecutable(candidate)) return { ok: true, path: candidate };
  }
  return { ok: false, reason: `no docker binary found (looked in ${SANDBOX_DOCKER_BINARY_CANDIDATES.join(", ")}); install Docker Desktop or set sandbox.docker.binary` };
}

/** A docker CLI runner bound to one binary. Never throws; a failure is a non-zero code. */
export function createSandboxDockerExec(binary: string, opts: { env?: Record<string, string>; maxBuffer?: number } = {}): SandboxDockerExec {
  const env = opts.env ?? sandboxDockerClientEnv();
  return (args, callOpts) =>
    new Promise<SandboxDockerResult>((resolveResult) => {
      execFile(
        binary,
        args,
        { env, timeout: callOpts?.timeoutMs ?? SANDBOX_DOCKER_CALL_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          if (!err) {
            resolveResult({ stdout: String(stdout), stderr: String(stderr), code: 0 });
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          const code: number = typeof e.code === "number" && e.code !== 0 ? e.code : e.killed ? 124 : 1;
          resolveResult({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || e.message, code });
        },
      );
    });
}

/** `docker info`: is the daemon reachable. */
export async function sandboxDockerAvailable(exec: SandboxDockerExec): Promise<{ ok: boolean; serverVersion?: string; reason?: string }> {
  const r = await exec(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
  if (r.code !== 0) return { ok: false, reason: sandboxFirstLine(r.stderr) || "the Docker daemon is not reachable (is Docker Desktop running?)" };
  const version = r.stdout.trim();
  return version ? { ok: true, serverVersion: version } : { ok: true };
}

/** `docker image inspect`: is the image present locally. Never pulls. */
export async function sandboxDockerImagePresent(exec: SandboxDockerExec, image: string): Promise<boolean> {
  const r = await exec(["image", "inspect", "--format", "{{.Id}}", image]);
  return r.code === 0;
}

export function sandboxFirstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 300);
}

export interface SandboxCreateParams {
  name: string;
  config: SandboxConfig;
  /** Absolute, validated workspace directory; mounted at the identical path. */
  workspaceDir: string;
  uid: number;
  gid: number;
}

/** Only these two network modes are ever passed (schema rejects `host`; this is the second check). */
function networkFlag(network: string): "none" | "bridge" {
  return network === "bridge" ? "bridge" : "none";
}

/** The hardening and resource flags, without name, labels and image. Input to the fingerprint. */
function coreCreateArgs(p: SandboxCreateParams): string[] {
  const d = p.config.docker;
  return [
    "--user", `${p.uid}:${p.gid}`,
    "--init",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(d.pidsLimit),
    "--memory", d.memory,
    "--cpus", String(d.cpus),
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${d.tmpfsSizeMb}m`,
    "--network", networkFlag(d.network),
    "--hostname", "kirie-sandbox",
    "--env", "HOME=/tmp",
    "--workdir", p.workspaceDir,
    "--mount", `type=bind,source=${p.workspaceDir},target=${p.workspaceDir}`,
  ];
}

/** Hash of everything that decides how strong the container is. A changed config never reuses a weaker container. */
export function sandboxContainerFingerprint(p: SandboxCreateParams): string {
  return createHash("sha256").update(JSON.stringify([p.config.docker.image, ...coreCreateArgs(p)])).digest("hex").slice(0, 16);
}

/**
 * `docker create` arguments. Always: a non-root user, `--init`, a read-only
 * root, every capability dropped, no-new-privileges, pid, memory and CPU
 * limits, a size-capped `/tmp`, `--network none|bridge`, and exactly one bind
 * mount (the workspace, at the same absolute path). Never the docker socket,
 * the home directory or `~/.kirie`; the caller validates the workspace with
 * `sandboxMountRefusal`. `--pull never`: the image is never fetched, even if
 * it vanished after the presence check. `readOnlyRoot: false` and a narrower `capDrop` in
 * config are ignored: the hardening is not configurable downwards.
 */
export function buildSandboxCreateArgs(p: SandboxCreateParams): string[] {
  const refusal = sandboxImageRefusal(p.config.docker.image);
  if (refusal) throw new Error(refusal);
  return [
    "create",
    "--pull", "never",
    "--name", p.name,
    "--label", SANDBOX_CONTAINER_LABEL,
    "--label", `${SANDBOX_FINGERPRINT_LABEL}=${sandboxContainerFingerprint(p)}`,
    ...coreCreateArgs(p),
    p.config.docker.image,
    "sleep", "infinity",
  ];
}

/** Bounds for one `sandbox_bash` call (PLAN C.10). */
export const SANDBOX_EXEC_DEFAULT_SECONDS = 120;
export const SANDBOX_EXEC_MAX_SECONDS = 600;
/** Grace period for `timeout -k` inside the container. */
export const SANDBOX_EXEC_KILL_AFTER_SECONDS = 5;

/**
 * `docker exec` arguments for one shell command. The command is one argv
 * element (no host shell ever sees it); the in-container `timeout` is what
 * actually stops the process, because killing the docker client does not.
 */
export function buildSandboxExecArgs(p: { container: string; workdir: string; command: string; timeoutSeconds: number }): string[] {
  const secs = Math.min(SANDBOX_EXEC_MAX_SECONDS, Math.max(1, Math.ceil(p.timeoutSeconds)));
  return [
    "exec", "-i", "-w", p.workdir, p.container,
    "timeout", "-k", String(SANDBOX_EXEC_KILL_AFTER_SECONDS), String(secs),
    "bash", "-lc", p.command,
  ];
}

/** `docker inspect` state of a container by name. */
export async function sandboxContainerState(
  exec: SandboxDockerExec,
  name: string,
): Promise<{ exists: boolean; running: boolean; fingerprint?: string; id?: string }> {
  const r = await exec(["inspect", "--type", "container", "--format", `{{.Id}}|{{.State.Running}}|{{index .Config.Labels "${SANDBOX_FINGERPRINT_LABEL}"}}`, name]);
  if (r.code !== 0) return { exists: false, running: false };
  const [id, running, fingerprint] = r.stdout.trim().split("|");
  return {
    exists: true,
    running: running === "true",
    ...(fingerprint && fingerprint !== "<no value>" ? { fingerprint } : {}),
    ...(id ? { id } : {}),
  };
}
