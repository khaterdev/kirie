/**
 * The shared sandbox container (PLAN C.10, R2 section 5 "SandboxManager rewrite").
 * One container for all sessions; orphans from earlier runs are found by label.
 * Every docker call goes through an injected runner, so tests never touch Docker.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createModuleLogger } from "../logging/logger.js";
import {
  SANDBOX_CONTAINER_LABEL,
  SANDBOX_CONTAINER_NAME_PATTERN,
  SANDBOX_SHARED_CONTAINER_NAME,
  buildSandboxCreateArgs,
  sandboxFirstLine,
  sandboxContainerFingerprint,
  sandboxContainerState,
  sandboxDockerAvailable,
  sandboxDockerImagePresent,
  sandboxImageRefusal,
  type SandboxCreateParams,
} from "./docker.js";
import { sandboxMountRefusal, type SandboxPathEnv } from "./paths.js";
import type { SandboxConfig, SandboxContainerHealth, SandboxDockerExec, SandboxInstance } from "./types.js";

const log = createModuleLogger("sandbox");

export interface SandboxManagerDeps {
  exec: SandboxDockerExec;
  /** Absolute workspace directory (already `~`-expanded). */
  workspaceDir: string;
  pathEnv: SandboxPathEnv;
  uid?: number;
  gid?: number;
  now?: () => Date;
  /** Create the workspace directory (0700). Injected for tests. */
  ensureDir?: (dir: string) => void;
}

export interface SandboxSelfTestResult {
  ok: boolean;
  reason?: string;
}

export class SandboxManager {
  private instance: SandboxInstance | null = null;
  private readonly uid: number;
  private readonly gid: number;

  constructor(private readonly config: SandboxConfig, private readonly deps: SandboxManagerDeps) {
    this.uid = deps.uid ?? process.getuid?.() ?? 1000;
    this.gid = deps.gid ?? process.getgid?.() ?? 1000;
    if (config.scope !== "shared") {
      log.warn({ scope: config.scope }, "sandbox.scope other than \"shared\" is not implemented; using one shared container");
    }
  }

  get workspaceDir(): string {
    return this.deps.workspaceDir;
  }

  get containerName(): string {
    return SANDBOX_SHARED_CONTAINER_NAME;
  }

  current(): SandboxInstance | null {
    return this.instance;
  }

  /** Is the Docker daemon reachable. */
  available(): Promise<{ ok: boolean; reason?: string; serverVersion?: string }> {
    return sandboxDockerAvailable(this.deps.exec);
  }

  /** Is the image present locally. Inspect only; never pulls. */
  imagePresent(): Promise<boolean> {
    return sandboxDockerImagePresent(this.deps.exec, this.config.docker.image);
  }

  /** Why the workspace may not be mounted, or null. */
  workspaceRefusal(): string | null {
    return sandboxMountRefusal(this.deps.workspaceDir, this.deps.pathEnv);
  }

  private createParams(): SandboxCreateParams {
    return { name: SANDBOX_SHARED_CONTAINER_NAME, config: this.config, workspaceDir: this.deps.workspaceDir, uid: this.uid, gid: this.gid };
  }

  fingerprint(): string {
    return sandboxContainerFingerprint(this.createParams());
  }

  /**
   * Bring the shared container up. The first call in this process always
   * removes whatever carries the name and creates a fresh container (a
   * container found by name or label could have been planted with weaker
   * settings), then pins it by id. Later calls reuse the pinned container
   * while it runs with the same fingerprint, start it when stopped, and
   * otherwise create a new one. Reaps labelled orphans. Throws with a reason.
   */
  async ensureShared(): Promise<SandboxInstance> {
    const imageRefusal = sandboxImageRefusal(this.config.docker.image);
    if (imageRefusal) throw new Error(imageRefusal);
    const refusal = this.workspaceRefusal();
    if (refusal) throw new Error(`the sandbox workspace ${this.deps.workspaceDir} cannot be mounted: ${refusal}`);
    if (!(await this.imagePresent())) {
      throw new Error(`the image ${this.config.docker.image} is not present locally; build it with scripts/sandbox-setup.sh (Kirie never pulls it)`);
    }
    (this.deps.ensureDir ?? defaultEnsureDir)(this.deps.workspaceDir);
    // The mount source must still be acceptable once the directory exists (a symlink planted there is caught here).
    const after = this.workspaceRefusal();
    if (after) throw new Error(`the sandbox workspace ${this.deps.workspaceDir} cannot be mounted: ${after}`);

    await this.reapOrphans();
    const fingerprint = this.fingerprint();
    const name = SANDBOX_SHARED_CONTAINER_NAME;
    const pinned = this.instance;

    if (pinned) {
      const state = await sandboxContainerState(this.deps.exec, pinned.containerId);
      if (state.exists && state.fingerprint === fingerprint) {
        if (state.running) return pinned;
        const started = await this.deps.exec(["start", pinned.containerId]);
        if (started.code === 0) return this.remember(pinned.containerId, fingerprint, "running");
        log.warn({ container: name, err: sandboxFirstLine(started.stderr) }, "could not start the stopped sandbox container; recreating");
      } else if (state.exists) {
        log.info({ container: name }, "sandbox container has a different configuration; recreating");
      }
    }
    await this.removeContainer(name);
    if (pinned) await this.removeContainer(pinned.containerId);
    this.instance = null;

    const created = await this.deps.exec(buildSandboxCreateArgs(this.createParams()));
    if (created.code !== 0) throw new Error(`docker create failed: ${sandboxFirstLine(created.stderr) || `exit ${created.code}`}`);
    const id = created.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!SANDBOX_CONTAINER_NAME_PATTERN.test(id)) {
      await this.removeContainer(name);
      throw new Error("docker create did not return a container id");
    }
    const started = await this.deps.exec(["start", id]);
    if (started.code !== 0) {
      await this.removeContainer(id);
      throw new Error(`docker start failed: ${sandboxFirstLine(started.stderr) || `exit ${started.code}`}`);
    }
    log.info({ container: name }, "sandbox container created and started");
    return this.remember(id, fingerprint, "running");
  }

  private remember(containerId: string, fingerprint: string, status: SandboxInstance["status"]): SandboxInstance {
    this.instance = {
      containerId,
      name: SANDBOX_SHARED_CONTAINER_NAME,
      image: this.config.docker.image,
      workspaceDir: this.deps.workspaceDir,
      fingerprint,
      scope: "shared",
      createdAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      status,
    };
    return this.instance;
  }

  private async removeContainer(name: string): Promise<boolean> {
    const r = await this.deps.exec(["rm", "-f", name]);
    return r.code === 0;
  }

  /** State of the pinned container (never one found by name). `unknown` when Docker itself cannot be asked. */
  async health(): Promise<SandboxContainerHealth> {
    if (!this.instance) return "missing";
    const r = await this.deps.exec(["inspect", "--type", "container", "--format", "{{.State.Running}}", this.instance.containerId], { timeoutMs: 10_000 });
    if (r.code !== 0) {
      if (/no such (object|container)/i.test(r.stderr)) return "missing";
      return "unknown";
    }
    return r.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Remove every container labelled `kirie.sandbox=1` except the shared one. Returns how many were removed. */
  async reapOrphans(): Promise<number> {
    const list = await this.deps.exec(["ps", "-a", "--filter", `label=${SANDBOX_CONTAINER_LABEL}`, "--format", "{{.Names}}"]);
    if (list.code !== 0) return 0;
    let removed = 0;
    for (const raw of list.stdout.split("\n")) {
      const name = raw.trim();
      if (!name || name === SANDBOX_SHARED_CONTAINER_NAME) continue;
      if (this.instance && name === this.instance.containerId) continue;
      if (await this.removeContainer(name)) removed++;
    }
    if (removed > 0) log.info({ removed }, "removed orphaned sandbox containers");
    return removed;
  }

  /** Remove the shared container and any orphans. */
  async destroyAll(): Promise<void> {
    await this.reapOrphans();
    if (this.instance) await this.removeContainer(this.instance.containerId);
    await this.removeContainer(SANDBOX_SHARED_CONTAINER_NAME);
    this.instance = null;
  }

  /** Destroy and create again. */
  async recreate(): Promise<SandboxInstance> {
    if (this.instance) await this.removeContainer(this.instance.containerId);
    await this.removeContainer(SANDBOX_SHARED_CONTAINER_NAME);
    this.instance = null;
    return this.ensureShared();
  }

  /**
   * Check the running container really is what docker mode promises: not
   * root, the workspace writable and visible on the host, the root
   * filesystem read-only, and (with `network: none`) no interface but `lo`.
   * Runs a fixed script; no model and no user content involved.
   */
  async selfTest(): Promise<SandboxSelfTestResult> {
    const ws = this.deps.workspaceDir;
    const marker = `.kirie-sandbox-probe-${process.pid}-${Date.now()}`;
    const script = [
      "echo \"UID=$(id -u)\"",
      "touch \"$1/$2\" && echo WS_OK",
      "touch /kirie-sandbox-probe 2>/dev/null && echo ROOT_WRITABLE",
      "echo \"NET=$(ls /sys/class/net 2>/dev/null | tr '\\n' ' ')\"",
    ].join("; ");
    if (!this.instance) return { ok: false, reason: "No such container: the sandbox container was not created" };
    const r = await this.deps.exec(["exec", "-w", ws, this.instance.containerId, "sh", "-c", script, "sh", ws, marker], { timeoutMs: 20_000 });
    const hostMarker = join(ws, marker);
    const visibleOnHost = existsSync(hostMarker);
    rmSync(hostMarker, { force: true });
    if (r.code !== 0) return { ok: false, reason: `the probe command failed in the container: ${sandboxFirstLine(r.stderr) || `exit ${r.code}`}` };
    const lines = r.stdout.split("\n").map((l) => l.trim());
    const value = (key: string): string | undefined => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim();
    const uid = value("UID");
    if (!uid || uid === "0") return { ok: false, reason: "the container runs as root" };
    if (!lines.includes("WS_OK")) return { ok: false, reason: "the workspace is not writable inside the container" };
    if (lines.includes("ROOT_WRITABLE")) return { ok: false, reason: "the container's root filesystem is writable" };
    if (!visibleOnHost) return { ok: false, reason: `a file written in the container did not appear in ${ws} on this Mac (is the folder shared with Docker Desktop?)` };
    if (this.config.docker.network === "none") {
      const names = (value("NET") ?? "").split(/\s+/).filter(Boolean);
      if (names.some((n) => n !== "lo")) return { ok: false, reason: `the container has a network interface (${names.join(", ")}) although sandbox.docker.network is none` };
    }
    return { ok: true };
  }
}

function defaultEnsureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
