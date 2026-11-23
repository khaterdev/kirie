/**
 * The sandbox switch (PLAN C.10): the live mode, docker readiness and health,
 * the native self-test, restarting chat sessions after a change, status, and
 * the prompt addendum. Only owner command handlers call the mutating methods;
 * no MCP tool and no HTTP route reaches them.
 */

import { join, resolve } from "node:path";
import { z } from "zod/v3";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { PromptAddendumContext } from "../engine/prompt-addenda.js";
import { createModuleLogger } from "../logging/logger.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { expandApprovalHome } from "../approvals/paths.js";
import type { ApprovalSandboxInfo } from "../approvals/types.js";
import {
  SANDBOX_SHARED_CONTAINER_NAME,
  createSandboxDockerExec,
  resolveSandboxDockerBinary,
} from "./docker.js";
import { SandboxManager } from "./manager.js";
import { buildSandboxNativeSettings, sandboxNativeBaseWrite, type SandboxNativeSettings } from "./native.js";
import type { SandboxProbeResult } from "./native-probe.js";
import { checkSandboxAllowWritePath, type SandboxPathEnv } from "./paths.js";
import { SandboxGuardStats } from "./path-guard.js";
import {
  SANDBOX_BASH_TOOL,
  SandboxSpawnRegistry,
  type SandboxDockerReadiness,
  type SandboxPolicySource,
} from "./policy.js";
import type { SandboxConfig, SandboxContainerHealth, SandboxDockerExec, SandboxMode } from "./types.js";

const log = createModuleLogger("sandbox");

/** Runtime override keys (PLAN B.11). */
export const SANDBOX_SETTING_KEYS = { mode: "sandbox.mode", allowWrite: "sandbox.native.allowWrite" } as const;
export const SANDBOX_MODE_SCHEMA = z.enum(["off", "native", "docker"]);
export const SANDBOX_ALLOW_WRITE_SCHEMA = z.array(z.string().min(1).max(4096)).max(100);
export const SANDBOX_ALLOW_WRITE_MAX = 50;

/** Heartbeat ticks are 10 s: health every 5 minutes while healthy, every minute while down. */
export const SANDBOX_HEALTH_TICKS_HEALTHY = 30;
export const SANDBOX_HEALTH_TICKS_DOWN = 6;

export interface SandboxSessionControl {
  closeIdleSessions(olderThanMs?: number): number;
  closeAndWait(sessionKey: string, timeoutMs?: number): Promise<void>;
  isBusy(sessionKey: string): boolean;
}

export interface SandboxControllerDeps {
  config: SandboxConfig;
  settings: Pick<RuntimeSettings, "get" | "set" | "delete" | "effective">;
  dataDir: string;
  /** The agent's working directory (config.agent.workspace or the data directory). */
  agentCwd?: string;
  home: string;
  realpath?: (p: string) => string;
  readdir?: (dir: string) => string[];
  audit?: Pick<AuditTrail, "record">;
  notifyOwner?: (text: string) => void;
  /** Live v2 chat sessions (null when v2 is off). */
  sessions?: SandboxSessionControl | null;
  /** Native self-test runner; given the settings builder. */
  nativeProbe?: (buildSettings: (cwd: string, extraDenyWrite: readonly string[]) => SandboxNativeSettings) => Promise<SandboxProbeResult>;
  /** Tests: docker binary resolution and the docker CLI runner. */
  resolveBinary?: (configured: string | undefined) => { ok: true; path: string } | { ok: false; reason: string };
  dockerExec?: (binary: string) => SandboxDockerExec;
  ensureDir?: (dir: string) => void;
  uid?: number;
  gid?: number;
  now?: () => number;
}

interface DockerState {
  binary?: string;
  healthy: boolean;
  reason?: string;
  serverVersion?: string;
  container?: SandboxContainerHealth;
  checkedAt?: number;
  /** A container was created or adopted by this process (so stop removes it). */
  used: boolean;
}

export interface SandboxSwitchResult {
  ok: boolean;
  text: string;
}

const NOT_SANDBOXED_LINE =
  "Never sandboxed: Kirie's MCP tools (messaging, browser, web fetch, memory) and external MCP servers run on this Mac; file tools are held to the same folders by Kirie's path guard.";

export class SandboxController implements SandboxPolicySource {
  readonly spawns = new SandboxSpawnRegistry();
  readonly stats = new SandboxGuardStats();
  private gen = 0;
  private dockerState: DockerState = { healthy: false, used: false };
  private manager: SandboxManager | null = null;
  private notifiedDown = false;
  private recyclePending = false;
  private recycling = false;
  private checking: Promise<void> | null = null;
  private switching = false;
  private readonly env: SandboxPathEnv;
  private readonly workspace: string;

  constructor(private readonly deps: SandboxControllerDeps) {
    this.env = {
      home: deps.home,
      dataDir: deps.dataDir,
      ...(deps.agentCwd ? { agentCwd: deps.agentCwd } : {}),
      ...(deps.realpath ? { realpath: deps.realpath } : {}),
      ...(deps.readdir ? { readdir: deps.readdir } : {}),
    };
    this.workspace = resolve(expandApprovalHome(deps.config.docker.workspaceDir, deps.home));
  }

  // ── SandboxPolicySource ────────────────────────────────────────────────

  mode(): SandboxMode {
    try {
      return this.deps.settings.effective(SANDBOX_SETTING_KEYS.mode, SANDBOX_MODE_SCHEMA, this.deps.config.mode);
    } catch {
      return this.deps.config.mode;
    }
  }

  config(): SandboxConfig {
    return this.deps.config;
  }

  pathEnv(): SandboxPathEnv {
    return this.env;
  }

  workspaceDir(): string {
    return this.workspace;
  }

  dockerReadPaths(): readonly string[] {
    return [join(this.deps.dataDir, "media"), ...this.deps.config.docker.readPaths.map((p) => resolve(expandApprovalHome(p, this.deps.home)))];
  }

  docker(): SandboxDockerReadiness {
    return {
      healthy: this.dockerState.healthy,
      // The pinned id: sandbox_bash never addresses the container by a name something else could take.
      container: this.manager?.current()?.containerId ?? SANDBOX_SHARED_CONTAINER_NAME,
      ...(this.dockerState.binary ? { binary: this.dockerState.binary } : {}),
      ...(this.dockerState.reason ? { reason: this.dockerState.reason } : {}),
    };
  }

  generation(): number {
    return this.gen;
  }

  /** Config entries and runtime additions, `~` expanded. */
  allowWriteLists(): { config: string[]; added: string[] } {
    const config = this.deps.config.native.allowWrite.map((p) => resolve(expandApprovalHome(p, this.deps.home)));
    let added: string[] = [];
    try {
      added = this.deps.settings.get(SANDBOX_SETTING_KEYS.allowWrite, SANDBOX_ALLOW_WRITE_SCHEMA) ?? [];
    } catch {
      added = [];
    }
    return { config, added };
  }

  allowWrite(): readonly string[] {
    const { config, added } = this.allowWriteLists();
    return [...new Set([...config, ...added])];
  }

  // ── Derived views ──────────────────────────────────────────────────────

  /** What the approval engine should know (W2-APR `setSandboxInfo`). Docker counts only while the container is healthy. */
  approvalInfo(): ApprovalSandboxInfo {
    const mode = this.mode();
    if (mode === "docker") return this.dockerState.healthy ? { mode, network: this.deps.config.docker.network } : { mode: "off" };
    return { mode };
  }

  nativeSettingsFor(cwd: string, extraDenyWrite: readonly string[] = []): SandboxNativeSettings {
    return buildSandboxNativeSettings({ native: this.deps.config.native, allowWrite: this.allowWrite(), cwd, pathEnv: this.env, extraDenyWrite });
  }

  /** The `sandbox` prompt addendum: what is confined, when a sandbox is active. */
  addendum(_ctx: PromptAddendumContext): string | null {
    const mode = this.mode();
    if (mode === "off") return null;
    if (mode === "native") {
      const allowed = this.allowWrite();
      return [
        "<sandbox mode=\"native\">",
        "Your Bash commands run inside the macOS sandbox. They can write only inside your working directory, /tmp and Kirie's media folder" +
          (allowed.length > 0 ? `, plus: ${allowed.join(", ")}` : "") + ".",
        "Kirie's config, state, secrets, credentials and other protected files cannot be written, and credential files cannot be read, by Bash or by the file tools.",
        this.deps.config.native.allowedDomains.length > 0
          ? `Network access from Bash is limited to: ${this.deps.config.native.allowedDomains.join(", ")}.`
          : "Network access is not restricted.",
        "If a command fails with \"Operation not permitted\", that is the sandbox: do not try to work around it. Tell the owner which folder you need; they can allow it with /sandbox allow-write <path>.",
        "</sandbox>",
      ].join("\n");
    }
    if (!this.dockerState.healthy) {
      return [
        "<sandbox mode=\"docker\" state=\"unavailable\">",
        "Shell commands are configured to run in an isolated container, and that container is not running right now, so you have no shell. Nothing will run on this Mac instead.",
        "Do not try to run commands another way. Tell the owner; they can check it with /sandbox.",
        "</sandbox>",
      ].join("\n");
    }
    const ws = this.workspace;
    return [
      "<sandbox mode=\"docker\">",
      `Shell commands run inside an isolated Linux container through the tool ${SANDBOX_BASH_TOOL} (same input as Bash). The built-in Bash tool is not available.`,
      `The container sees only ${ws} (at the same path), runs as a normal user with a read-only system, ${this.deps.config.docker.network === "none" ? "and has no network" : "and has network access"}. /tmp inside it is scratch space.`,
      "Host tools and credentials (kubectl, gh, git with the owner's keys, pnpm in the owner's repositories, launchctl) are not available in the container.",
      `File tools (Write, Edit, Read, Grep, Glob) work only inside ${ws}; reading Kirie's media folder is also allowed. Files you create in the workspace appear on the owner's Mac.`,
      "If a command cannot work in the container, say so and suggest the owner runs it, or switches with /sandbox.",
      "</sandbox>",
    ].join("\n");
  }

  // ── Docker readiness and health ────────────────────────────────────────

  private getManager(): { ok: true; manager: SandboxManager } | { ok: false; reason: string } {
    if (this.manager) return { ok: true, manager: this.manager };
    const resolved = (this.deps.resolveBinary ?? resolveSandboxDockerBinary)(this.deps.config.docker.binary);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    this.dockerState.binary = resolved.path;
    const exec = (this.deps.dockerExec ?? ((bin: string) => createSandboxDockerExec(bin)))(resolved.path);
    this.manager = new SandboxManager(this.deps.config, {
      exec,
      workspaceDir: this.workspace,
      pathEnv: this.env,
      ...(this.deps.ensureDir ? { ensureDir: this.deps.ensureDir } : {}),
      ...(this.deps.uid !== undefined ? { uid: this.deps.uid } : {}),
      ...(this.deps.gid !== undefined ? { gid: this.deps.gid } : {}),
    });
    return { ok: true, manager: this.manager };
  }

  private setDocker(healthy: boolean, reason?: string, container?: SandboxContainerHealth): void {
    const changed = healthy !== this.dockerState.healthy;
    this.dockerState = {
      ...this.dockerState,
      healthy,
      checkedAt: (this.deps.now ?? Date.now)(),
      ...(container ? { container } : {}),
    };
    if (reason) this.dockerState.reason = reason;
    else delete this.dockerState.reason;
    // Container health shapes spawn options only in docker mode.
    if (changed && this.mode() === "docker") this.bump();
  }

  /**
   * Binary, daemon, image, workspace, container, self-test. On any failure
   * the container is marked unhealthy with the reason (fail closed).
   */
  async prepareDocker(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fail = (reason: string): { ok: false; reason: string } => {
      this.setDocker(false, reason, this.dockerState.container);
      return { ok: false, reason };
    };
    const got = this.getManager();
    if (!got.ok) return fail(got.reason);
    const mgr = got.manager;
    const avail = await mgr.available();
    if (!avail.ok) return fail(`Docker is not reachable: ${avail.reason ?? "unknown error"}`);
    if (avail.serverVersion) this.dockerState.serverVersion = avail.serverVersion;
    if (!(await mgr.imagePresent())) {
      return fail(`the image ${this.deps.config.docker.image} is not built on this Mac (run scripts/sandbox-setup.sh; Kirie never pulls it)`);
    }
    const refusal = mgr.workspaceRefusal();
    if (refusal) return fail(`the workspace ${this.workspace} cannot be mounted: ${refusal}`);
    try {
      await mgr.ensureShared();
      this.dockerState.used = true;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const probe = await mgr.selfTest();
    if (!probe.ok) return fail(`the container failed its self-test: ${probe.reason}`);
    this.setDocker(true, undefined, "running");
    return { ok: true };
  }

  private notifyDown(reason: string): void {
    this.deps.audit?.record({ feature: "sandbox", action: "container.unhealthy", actor: "system", detail: { reason: reason.slice(0, 200) } });
    if (this.notifiedDown) return;
    this.notifiedDown = true;
    this.deps.notifyOwner?.(
      `Sandbox (docker mode): shell commands are off because ${reason}. Nothing runs on this Mac instead. Fix it, then /sandbox recreate, or switch with /sandbox off.`,
    );
  }

  private async checkHealth(): Promise<void> {
    const wasHealthy = this.dockerState.healthy;
    const got = this.getManager();
    if (!got.ok) {
      this.setDocker(false, got.reason);
      this.notifyDown(got.reason);
      return;
    }
    const health = await got.manager.health();
    if (health === "running" && wasHealthy) {
      this.dockerState.container = "running";
      this.dockerState.checkedAt = (this.deps.now ?? Date.now)();
      return;
    }
    if (health === "unknown") {
      const reason = "Docker is not reachable";
      this.setDocker(false, reason, "unknown");
      this.notifyDown(reason);
      return;
    }
    // Missing, stopped, or running after being down: bring it back with the full checks.
    const r = await this.prepareDocker();
    if (!r.ok) {
      this.notifyDown(r.reason);
      return;
    }
    if (!wasHealthy && this.notifiedDown) {
      this.notifiedDown = false;
      this.deps.notifyOwner?.("Sandbox (docker mode): the container is running again; shell commands work from the next message.");
    }
  }

  private bump(): void {
    this.gen++;
    this.recyclePending = true;
  }

  /** Restart idle chat sessions spawned with older options; busy ones are retried on later ticks. */
  private async recycleStale(): Promise<void> {
    if (this.recycling) return;
    this.recycling = true;
    try {
      const stale = this.spawns.staleChats(this.gen);
      const sessions = this.deps.sessions;
      let remaining = 0;
      for (const key of stale) {
        if (sessions?.isBusy(key)) {
          remaining++;
          continue;
        }
        try {
          await sessions?.closeAndWait(key, 5_000);
        } catch (err) {
          log.warn({ sessionKey: key, err: err instanceof Error ? err.message : String(err) }, "could not restart a session after a sandbox change");
        }
        this.spawns.forgetChat(key);
      }
      if (remaining === 0) this.recyclePending = false;
    } finally {
      this.recycling = false;
    }
  }

  /** Heartbeat tick (10 s). */
  onTick(tickNumber: number): void {
    if (this.recyclePending) void this.recycleStale();
    if (this.mode() !== "docker") return;
    const every = this.dockerState.healthy ? SANDBOX_HEALTH_TICKS_HEALTHY : SANDBOX_HEALTH_TICKS_DOWN;
    if (tickNumber % every !== 0 || this.checking) return;
    this.checking = this.checkHealth()
      .catch((err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox health check failed"))
      .finally(() => {
        this.checking = null;
      });
  }

  /** Feature start: in docker mode, bring the container up or fail closed and tell the owner once. */
  async start(): Promise<void> {
    if (this.mode() !== "docker") return;
    const r = await this.prepareDocker();
    if (!r.ok) {
      log.warn({ reason: r.reason }, "docker sandbox is not ready; shell commands are disabled");
      this.notifyDown(r.reason);
    }
    this.bump();
  }

  /** Feature stop: remove the container when this process used it and `stopOnShutdown` is set. */
  async stop(): Promise<void> {
    if (this.checking) await this.checking;
    if (!this.manager || !this.dockerState.used || !this.deps.config.docker.stopOnShutdown) return;
    try {
      await this.manager.destroyAll();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not remove the sandbox container at shutdown");
    }
  }

  // ── Owner actions (called only from /sandbox handlers) ───────────────────

  private afterChange(): number {
    this.bump();
    const closed = this.deps.sessions?.closeIdleSessions(0) ?? 0;
    void this.recycleStale();
    return closed;
  }

  /** Switch mode after the self-test for native and docker. */
  async switchMode(target: SandboxMode, actor: string): Promise<SandboxSwitchResult> {
    if (this.switching) return { ok: false, text: "A sandbox change is already running. Try again in a moment." };
    this.switching = true;
    try {
      const from = this.mode();
      if (target === from && target !== "docker") return { ok: true, text: `The sandbox is already ${target}.` };
      if (target === "docker" && from === "docker" && this.dockerState.healthy) {
        return { ok: true, text: "The sandbox is already docker and the container is running. Use /sandbox recreate to rebuild it." };
      }

      if (target === "native") {
        if (!this.deps.nativeProbe) return this.refuse(from, target, actor, "the native self-test is not available in this process");
        const probe = await this.deps.nativeProbe((cwd, extra) => this.nativeSettingsFor(cwd, extra));
        if (!probe.ok) return this.refuse(from, target, actor, `the self-test failed: ${probe.reason ?? "unknown reason"}`);
      } else if (target === "docker") {
        const r = await this.prepareDocker();
        if (!r.ok) return this.refuse(from, target, actor, r.reason);
      }

      this.deps.settings.set(SANDBOX_SETTING_KEYS.mode, target, actor);
      const closed = this.afterChange();
      this.notifiedDown = false;
      this.deps.audit?.record({ feature: "sandbox", action: "mode.changed", actor, detail: { from, to: target } });
      const lines = [this.modeLine(target)];
      lines.push(`Restarted ${closed} idle chat session${closed === 1 ? "" : "s"}; busy ones restart when their current turn ends. Running background tasks keep the mode they started with.`);
      if (from === "docker" && target !== "docker") lines.push("The container keeps running for tasks that started in docker mode; it is removed when Kirie stops.");
      return { ok: true, text: lines.join("\n") };
    } finally {
      this.switching = false;
    }
  }

  private refuse(from: SandboxMode, target: SandboxMode, actor: string, reason: string): SandboxSwitchResult {
    this.deps.audit?.record({ feature: "sandbox", action: "mode.refused", actor, detail: { from, to: target, reason: reason.slice(0, 200) } });
    return { ok: false, text: `Not switched to ${target}: ${reason}. The sandbox stays ${from}.` };
  }

  private modeLine(mode: SandboxMode): string {
    if (mode === "off") return "Sandbox off: shell commands run directly on this Mac.";
    if (mode === "native") return "Sandbox native: the self-test passed. Bash runs in the macOS sandbox from the next message; I can write only in my workspace and the folders you allow (/sandbox allow-write <path>).";
    return `Sandbox docker: the container is running. Shell commands run in it from the next message, with access to ${this.workspace} only${this.deps.config.docker.network === "none" ? " and no network" : ""}.`;
  }

  /** Owner actions never interleave (a docker switch can wait on Docker for a while). */
  private async exclusive(fn: () => Promise<SandboxSwitchResult>): Promise<SandboxSwitchResult> {
    if (this.switching) return { ok: false, text: "A sandbox change is already running. Try again in a moment." };
    this.switching = true;
    try {
      return await fn();
    } finally {
      this.switching = false;
    }
  }

  addAllowWrite(raw: string, actor: string): Promise<SandboxSwitchResult> {
    return this.exclusive(() => this.addAllowWriteInner(raw, actor));
  }

  removeAllowWrite(raw: string, actor: string): Promise<SandboxSwitchResult> {
    return this.exclusive(() => this.removeAllowWriteInner(raw, actor));
  }

  reset(actor: string): Promise<SandboxSwitchResult> {
    return this.exclusive(() => this.resetInner(actor));
  }

  private async addAllowWriteInner(raw: string, actor: string): Promise<SandboxSwitchResult> {
    const check = checkSandboxAllowWritePath(raw, this.env);
    if (!check.ok) return { ok: false, text: `Not added: ${check.reason}.` };
    const { config, added } = this.allowWriteLists();
    if (config.includes(check.path) || added.includes(check.path)) return { ok: true, text: `${check.path} is already writable in native mode.` };
    if (added.length >= SANDBOX_ALLOW_WRITE_MAX) return { ok: false, text: `Not added: at most ${SANDBOX_ALLOW_WRITE_MAX} folders can be added here.` };
    this.deps.settings.set(SANDBOX_SETTING_KEYS.allowWrite, [...added, check.path], actor);
    this.deps.audit?.record({ feature: "sandbox", action: "allow-write.added", actor, detail: { path: check.path } });
    const mode = this.mode();
    if (mode === "native") this.afterChange();
    return {
      ok: true,
      text: `Added ${check.path} to the native sandbox's writable folders.` +
        (mode === "native" ? " It applies from the next message." : ` It applies when the sandbox is native (now: ${mode}).`),
    };
  }

  private async removeAllowWriteInner(raw: string, actor: string): Promise<SandboxSwitchResult> {
    const input = raw.trim();
    if (!input) return { ok: false, text: "Usage: /sandbox disallow-write <path>" };
    const path = resolve(expandApprovalHome(input, this.deps.home));
    const { config, added } = this.allowWriteLists();
    if (!added.includes(path)) {
      if (config.includes(path)) return { ok: false, text: `${path} comes from config.yaml (sandbox.native.allowWrite); remove it there.` };
      return { ok: false, text: `${path} is not in the list.` };
    }
    const next = added.filter((p) => p !== path);
    if (next.length > 0) this.deps.settings.set(SANDBOX_SETTING_KEYS.allowWrite, next, actor);
    else this.deps.settings.delete(SANDBOX_SETTING_KEYS.allowWrite, actor);
    this.deps.audit?.record({ feature: "sandbox", action: "allow-write.removed", actor, detail: { path } });
    if (this.mode() === "native") this.afterChange();
    return { ok: true, text: `Removed ${path}. File tools stop writing there now; Bash from the next message.` };
  }

  async recreate(actor: string): Promise<SandboxSwitchResult> {
    if (this.mode() !== "docker") return { ok: false, text: "Recreate only applies in docker mode." };
    if (this.switching) return { ok: false, text: "A sandbox change is already running. Try again in a moment." };
    this.switching = true;
    try {
      const got = this.getManager();
      if (got.ok) await got.manager.destroyAll();
      this.setDocker(false, "the container is being recreated");
      const r = await this.prepareDocker();
      this.afterChange();
      this.deps.audit?.record({ feature: "sandbox", action: "container.recreated", actor, detail: { ok: r.ok } });
      if (!r.ok) {
        this.notifyDown(r.reason);
        return { ok: false, text: `The container could not be recreated: ${r.reason}. Shell commands stay off (nothing runs on this Mac instead).` };
      }
      this.notifiedDown = false;
      return { ok: true, text: "The sandbox container was recreated and passed its self-test." };
    } finally {
      this.switching = false;
    }
  }

  /** Mode the config gives (what `reset` returns to). */
  configuredMode(): SandboxMode {
    return this.deps.config.mode;
  }

  private async resetInner(actor: string): Promise<SandboxSwitchResult> {
    const from = this.mode();
    this.deps.settings.delete(SANDBOX_SETTING_KEYS.mode, actor);
    this.deps.settings.delete(SANDBOX_SETTING_KEYS.allowWrite, actor);
    const to = this.mode();
    this.deps.audit?.record({ feature: "sandbox", action: "reset", actor, detail: { from, to } });
    const lines = [`Sandbox overrides dropped. Mode from config.yaml: ${to}.`];
    if (to === "docker") {
      const r = await this.prepareDocker();
      lines.push(r.ok ? "The container is running." : `The container is not ready: ${r.reason}. Shell commands are off until it is.`);
    }
    this.afterChange();
    return { ok: true, text: lines.join("\n") };
  }

  // ── Status ─────────────────────────────────────────────────────────────

  private overrideMode(): SandboxMode | undefined {
    try {
      return this.deps.settings.get(SANDBOX_SETTING_KEYS.mode, SANDBOX_MODE_SCHEMA);
    } catch {
      return undefined;
    }
  }

  /** Read-only snapshot for the status route and the sandbox_status tool. Never secrets. */
  statusSnapshot(): Record<string, unknown> {
    const mode = this.mode();
    const { config, added } = this.allowWriteLists();
    const snap: Record<string, unknown> = {
      mode,
      configuredMode: this.deps.config.mode,
      ...(this.overrideMode() ? { override: this.overrideMode() } : {}),
      deniedSinceStart: this.stats.denied,
      notSandboxed: ["kirie-tools MCP tools (messaging, browser, web fetch, memory)", "external MCP servers"],
    };
    if (mode === "native") {
      snap.native = {
        writable: [this.deps.agentCwd ?? this.deps.dataDir, ...sandboxNativeBaseWrite(this.deps.dataDir), ...config, ...added],
        network: this.deps.config.native.allowedDomains.length > 0 ? { allowedDomains: this.deps.config.native.allowedDomains } : "unrestricted",
        allowUnsandboxed: this.deps.config.native.allowUnsandboxed,
      };
    }
    if (mode === "docker") {
      snap.docker = {
        healthy: this.dockerState.healthy,
        ...(this.dockerState.reason ? { reason: this.dockerState.reason } : {}),
        container: SANDBOX_SHARED_CONTAINER_NAME,
        workspace: this.workspace,
        network: this.deps.config.docker.network,
        shellTool: SANDBOX_BASH_TOOL,
      };
    }
    return snap;
  }

  /** The `/sandbox` status text. In docker mode it asks Docker live. */
  async statusText(): Promise<string> {
    const mode = this.mode();
    const override = this.overrideMode();
    const lines = [
      `Sandbox: ${mode}${override ? ` (set with /sandbox; config.yaml says ${this.deps.config.mode})` : " (from config.yaml)"}`,
    ];
    if (mode === "off") lines.push("Shell commands and file tools run directly on this Mac.");
    if (mode === "native") {
      const { config, added } = this.allowWriteLists();
      const n = this.deps.config.native;
      lines.push(`Bash runs in the macOS sandbox. Writable: my working directory (${this.deps.agentCwd ?? this.deps.dataDir}), /tmp, Kirie's media folder`);
      for (const p of config) lines.push(`  ${p}   (config.yaml)`);
      for (const p of added) lines.push(`  ${p}`);
      lines.push("Protected (never writable): Kirie's config, state, secrets, credentials, databases, and credential files such as ~/.ssh and ~/.kube.");
      lines.push(n.allowedDomains.length > 0 ? `Network: only ${n.allowedDomains.join(", ")}` : "Network: unrestricted");
      if (n.excludedCommands.length > 0) lines.push(`Run outside the sandbox (config): ${n.excludedCommands.join(", ")}`);
      if (n.allowUnsandboxed) lines.push("WARNING: sandbox.native.allowUnsandboxed is true: the model may run commands outside the sandbox.");
    }
    if (mode === "docker") {
      const got = this.getManager();
      if (!got.ok) {
        lines.push(`Docker binary: not found (${got.reason})`);
      } else {
        lines.push(`Docker binary: ${this.dockerState.binary}`);
        const avail = await got.manager.available();
        lines.push(`Docker daemon: ${avail.ok ? `reachable${avail.serverVersion ? ` (server ${avail.serverVersion})` : ""}` : `not reachable (${avail.reason ?? "unknown"})`}`);
        if (avail.ok) {
          lines.push(`Image ${this.deps.config.docker.image}: ${(await got.manager.imagePresent()) ? "present" : "missing (run scripts/sandbox-setup.sh)"}`);
          lines.push(`Container ${SANDBOX_SHARED_CONTAINER_NAME}: ${await got.manager.health()}`);
        }
      }
      lines.push(`Shell: ${this.dockerState.healthy ? `available through ${SANDBOX_BASH_TOOL}` : `OFF${this.dockerState.reason ? ` (${this.dockerState.reason})` : ""}; nothing runs on this Mac instead`}`);
      const d = this.deps.config.docker;
      lines.push(`Workspace: ${this.workspace} (mounted at the same path; files written there land on this Mac)`);
      lines.push(`Network: ${d.network}. Limits: ${d.memory} memory, ${d.cpus} CPUs, ${d.pidsLimit} processes, ${d.tmpfsSizeMb} MB /tmp, ${d.execTimeoutSeconds}s per command (max 600s).`);
    }
    lines.push(NOT_SANDBOXED_LINE);
    if (this.stats.denied > 0) lines.push(`Path guard denials since start: ${this.stats.denied}`);
    return lines.join("\n");
  }
}
