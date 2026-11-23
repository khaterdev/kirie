/**
 * cua-driver probe (PLAN C.13): read-only checks of the installed driver.
 *
 * Kirie never installs, updates, grants permissions to, connects or
 * reconfigures the driver. Every command goes through an injected `exec`
 * (tests never run a binary) and through `assertReadOnlyComputerUseDriverArgs`, which
 * refuses the subcommands that change anything. No shell is used.
 *
 * Unverified upstream details (R5 Appendix B, EXPERIMENTS E10): the exact JSON
 * of `cua-driver permissions status --json`, and the attribution field. The
 * parser is tolerant and the result says what it could not read.
 */

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ComputerUseConfig } from "../config/sections/computer-use.js";
import type { ComputerUseAppInfo } from "./policy.js";

export interface ComputerUseExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Run a file with arguments, no shell. Must resolve, never reject (spawn failure = code -1). */
export type ComputerUseExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<ComputerUseExecResult>;

export interface ComputerUseDriverDeps {
  exec: ComputerUseExecFn;
  /** True when the path is an executable regular file. */
  isExecutable: (path: string) => boolean;
  homeDir?: string;
  now?: () => number;
}

export interface ComputerUseDriverStatus {
  checkedAt: number;
  driverPath: string;
  installed: boolean;
  version?: string;
  /** codesign verified and the identifier is com.trycua.driver. Undefined when not checked. */
  appBundleOk?: boolean;
  bundleIdentifier?: string;
  daemonRunning?: boolean;
  accessibility?: boolean;
  screenRecording?: boolean;
  /** "driver-daemon" means the macOS grants attach to CuaDriver.app; "caller" means they would attach to node. */
  attribution?: string;
  /** Everything needed to use the driver is in place. */
  healthy: boolean;
  /** Blocking. */
  problems: string[];
  /** Not blocking, shown by /computer status. */
  warnings: string[];
}

export const COMPUTER_USE_DRIVER_BUNDLE_ID = "com.trycua.driver";
export const COMPUTER_USE_SETUP_DOC = "docs/computer-use-setup.md";
const CODESIGN = "/usr/bin/codesign";
const LSAPPINFO = "/usr/bin/lsappinfo";
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Subcommands and flags Kirie must never pass to the driver: they grant
 * permissions, connect it to other agents, update or install it, serve it on a
 * port, or change its config or telemetry.
 */
const FORBIDDEN_DRIVER_WORDS: ReadonlySet<string> = new Set([
  "grant", "connect", "update", "upgrade", "serve", "install", "uninstall", "set", "enable", "reset", "call",
]);

/** Throws when an argument list could change the driver's state. The probe's last line of defence. */
export function assertReadOnlyComputerUseDriverArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_DRIVER_WORDS.has(arg.toLowerCase())) {
      throw new Error(`refusing to run cua-driver with "${arg}": Kirie only runs read-only driver commands`);
    }
  }
}

/** "~/x" -> "<home>/x". */
export function expandComputerUsePath(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Default exec: execFile with a timeout, never a shell, never rejects. */
export const defaultComputerUseExec: ComputerUseExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      const code = typeof e.code === "number" ? e.code : -1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? e.message), ...(e.killed ? { timedOut: true } : {}) });
    });
  });

export function defaultComputerUseIsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function truthy(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (["granted", "authorized", "allowed", "yes", "true", "ok"].includes(s)) return true;
    if (["denied", "not_granted", "not granted", "missing", "no", "false", "unknown", "not_determined"].includes(s)) return false;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    for (const key of ["granted", "status", "state", "value"]) if (key in o) return truthy(o[key]);
  }
  return undefined;
}

/** Tolerant read of `permissions status --json`. Field names are not verified upstream. */
export function parseComputerUsePermissions(text: string): { accessibility?: boolean; screenRecording?: boolean; attribution?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const out: { accessibility?: boolean; screenRecording?: boolean; attribution?: string } = {};
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if (out.accessibility === undefined && /accessib/.test(k)) {
        const t = truthy(value);
        if (t !== undefined) out.accessibility = t;
      } else if (out.screenRecording === undefined && /screen.?(recording|capture)/.test(k)) {
        const t = truthy(value);
        if (t !== undefined) out.screenRecording = t;
      } else if (out.attribution === undefined && /attribution/.test(k) && typeof value === "string") {
        out.attribution = value;
      }
      if (typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(parsed, 0);
  return out;
}

async function runDriver(deps: ComputerUseDriverDeps, driverPath: string, args: readonly string[]): Promise<ComputerUseExecResult> {
  assertReadOnlyComputerUseDriverArgs(args);
  return deps.exec(driverPath, args, { timeoutMs: PROBE_TIMEOUT_MS });
}

function notInstalledProblem(driverPath: string): string {
  return `cua-driver is not installed at ${driverPath}. Kirie does not install it: follow ${COMPUTER_USE_SETUP_DOC} (install it yourself, then grant Accessibility and Screen Recording to CuaDriver.app).`;
}

/** Read-only probe. Never throws. */
export async function probeComputerUseDriver(cfg: ComputerUseConfig, deps: ComputerUseDriverDeps): Promise<ComputerUseDriverStatus> {
  const now = deps.now ?? Date.now;
  const home = deps.homeDir ?? homedir();
  const driverPath = expandComputerUsePath(cfg.driverPath, home);
  const appPath = expandComputerUsePath(cfg.appPath, home);
  const problems: string[] = [];
  const warnings: string[] = [];
  const status: ComputerUseDriverStatus = { checkedAt: now(), driverPath, installed: false, healthy: false, problems, warnings };

  try {
    if (!isAbsolute(driverPath)) {
      problems.push(`computerUse.driverPath must be an absolute path (it is never searched on PATH): ${cfg.driverPath}`);
      return status;
    }
    if (!deps.isExecutable(driverPath)) {
      problems.push(notInstalledProblem(driverPath));
      return status;
    }
    status.installed = true;

    // Signatures first: nothing from driverPath runs until both the app and the CLI verify.
    if (cfg.requireSignedDriver) {
      const verify = await deps.exec(CODESIGN, ["--verify", "--deep", "--strict", appPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const info = await deps.exec(CODESIGN, ["-dv", appPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const appInfo = `${info.stderr}\n${info.stdout}`;
      const id = /^Identifier=(.+)$/m.exec(appInfo)?.[1]?.trim();
      const appTeam = /^TeamIdentifier=(.+)$/m.exec(appInfo)?.[1]?.trim();
      if (id) status.bundleIdentifier = id;
      status.appBundleOk = verify.code === 0 && id === COMPUTER_USE_DRIVER_BUNDLE_ID;
      if (verify.code !== 0) problems.push(`The signature of ${appPath} does not verify (codesign --verify failed).`);
      else if (id !== COMPUTER_USE_DRIVER_BUNDLE_ID) problems.push(`${appPath} is not signed as ${COMPUTER_USE_DRIVER_BUNDLE_ID} (identifier: ${id ?? "none"}).`);

      // The CLI is what Kirie runs (probe and MCP server), so it must verify too, by the same team as the app.
      const cliVerify = await deps.exec(CODESIGN, ["--verify", "--strict", driverPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const cliInfo = await deps.exec(CODESIGN, ["-dv", driverPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const cliTeam = /^TeamIdentifier=(.+)$/m.exec(`${cliInfo.stderr}\n${cliInfo.stdout}`)?.[1]?.trim();
      if (cliVerify.code !== 0) {
        problems.push(`The signature of ${driverPath} does not verify (codesign --verify failed). Kirie does not run an unsigned driver unless computerUse.requireSignedDriver is false.`);
      } else if (!appTeam || !cliTeam || appTeam === "not set" || cliTeam !== appTeam) {
        problems.push(`${driverPath} is not signed by the same team as ${appPath} (app team: ${appTeam ?? "none"}, cli team: ${cliTeam ?? "none"}).`);
      }
      if (problems.length > 0) return status;
    } else {
      warnings.push("computerUse.requireSignedDriver is off: neither the app bundle nor the cua-driver CLI signature is checked.");
    }

    const version = await runDriver(deps, driverPath, ["--version"]);
    if (version.code === 0) status.version = version.stdout.trim().split("\n")[0]?.slice(0, 80);
    else warnings.push(version.timedOut ? "cua-driver --version timed out." : "cua-driver --version failed.");

    const daemon = await runDriver(deps, driverPath, ["status"]);
    status.daemonRunning = daemon.code === 0;
    if (!status.daemonRunning) warnings.push("The CuaDriver daemon is not running. It may start on first use; if calls fail, start it from Terminal (see the setup doc).");

    const perms = await runDriver(deps, driverPath, ["permissions", "status", "--json"]);
    const parsed = perms.code === 0 ? parseComputerUsePermissions(perms.stdout) : null;
    if (!parsed) {
      problems.push("Could not read `cua-driver permissions status --json`. Run it in Terminal to check the macOS grants.");
    } else {
      if (parsed.accessibility !== undefined) status.accessibility = parsed.accessibility;
      if (parsed.screenRecording !== undefined) status.screenRecording = parsed.screenRecording;
      if (parsed.attribution !== undefined) status.attribution = parsed.attribution;
      if (parsed.accessibility !== true) {
        problems.push("Accessibility is not granted to CuaDriver.app (System Settings > Privacy & Security > Accessibility). Never grant it to node or bash.");
      }
      if (parsed.screenRecording !== true) {
        problems.push("Screen Recording is not granted to CuaDriver.app (System Settings > Privacy & Security > Screen & System Audio Recording).");
      }
      if (parsed.attribution === "caller") {
        problems.push("The driver reports attribution \"caller\": the macOS grants would attach to Kirie's node process. Start the driver through CuaDriver.app (see the setup doc).");
      } else if (parsed.attribution === undefined) {
        warnings.push("The driver did not report its permission attribution; check `cua-driver permissions status --json` shows driver-daemon.");
      }
    }
  } catch (err) {
    problems.push(`The driver probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  status.healthy = status.installed && problems.length === 0;
  return status;
}

/** `cua-driver stop`, best effort. Returns false when the driver is not installed or the command failed. */
export async function stopComputerUseDriver(cfg: ComputerUseConfig, deps: ComputerUseDriverDeps): Promise<boolean> {
  const driverPath = expandComputerUsePath(cfg.driverPath, deps.homeDir ?? homedir());
  if (!isAbsolute(driverPath) || !deps.isExecutable(driverPath)) return false;
  try {
    if (cfg.requireSignedDriver) {
      // Never run a binary that has been swapped since install, not even to stop it.
      const verify = await deps.exec(CODESIGN, ["--verify", "--strict", driverPath], { timeoutMs: PROBE_TIMEOUT_MS });
      if (verify.code !== 0) return false;
    }
    const res = await runDriver(deps, driverPath, ["stop"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

/** Parse one `"Key"="value"` line of lsappinfo output. */
function lsappinfoValue(text: string): string | undefined {
  const m = /"[^"]+"\s*=\s*"([^"]*)"/.exec(text);
  return m?.[1] || undefined;
}

/**
 * Resolve a pid to its app with `lsappinfo info -only bundleid|name <pid>`
 * (read-only). Results are cached for `ttlMs` (30 s).
 */
export function createComputerUseAppResolver(deps: { exec: ComputerUseExecFn; now?: () => number; ttlMs?: number }): (pid: number) => Promise<ComputerUseAppInfo | null> {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 30_000;
  const cache = new Map<number, { at: number; app: ComputerUseAppInfo | null }>();
  return async (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const hit = cache.get(pid);
    if (hit && now() - hit.at < ttl) return hit.app;
    let app: ComputerUseAppInfo | null = null;
    try {
      const id = await deps.exec(LSAPPINFO, ["info", "-only", "bundleid", String(pid)], { timeoutMs: 2_000 });
      const bundleId = id.code === 0 ? lsappinfoValue(id.stdout) : undefined;
      if (bundleId) {
        const nameRes = await deps.exec(LSAPPINFO, ["info", "-only", "name", String(pid)], { timeoutMs: 2_000 });
        const name = nameRes.code === 0 ? lsappinfoValue(nameRes.stdout) : undefined;
        app = { bundleId, ...(name ? { name } : {}) };
      }
    } catch {
      app = null;
    }
    if (cache.size > 256) cache.clear();
    cache.set(pid, { at: now(), app });
    return app;
  };
}
