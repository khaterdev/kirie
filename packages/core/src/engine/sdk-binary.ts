/**
 * Preflight for the Agent SDK's native Claude Code binary.
 *
 * Since 0.3.x the SDK no longer ships a JS CLI: every query() spawns a
 * per-platform executable that lives in an optional dependency
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). If that package is
 * missing — an install that skipped optional deps, an interrupted download,
 * or node_modules deleted under a running daemon — the SDK only notices at
 * query time. The daemon then stays "up" with channels connected while every
 * message and triage run fails, which is how Kirie sat broken for a week.
 *
 * This mirrors the SDK's own lookup so the daemon can refuse to start (and the
 * launcher can reinstall) instead of degrading silently.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeBinaryCheck {
  ok: boolean;
  /** Absolute path of the resolved executable, when found. */
  path?: string;
  /** Platform packages that were looked for, in lookup order. */
  candidates: string[];
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** Same candidate order as the SDK: musl first on musl Linux, glibc first otherwise. */
function candidatePackages(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === "linux") {
    const glibc = `${SDK_PACKAGE}-linux-${arch}`;
    const musl = `${SDK_PACKAGE}-linux-${arch}-musl`;
    return isMusl() ? [musl, glibc] : [glibc, musl];
  }
  if (platform === "android") return [`${SDK_PACKAGE}-linux-${arch}-android`];
  return [`${SDK_PACKAGE}-${platform}-${arch}`];
}

function isMusl(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** Locate the native binary the SDK will spawn. */
export function checkClaudeBinary(): ClaudeBinaryCheck {
  const candidates = candidatePackages(process.platform, process.arch);
  let sdkEntry: string;
  try {
    sdkEntry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
  } catch {
    return { ok: false, candidates, error: `${SDK_PACKAGE} is not installed — run 'pnpm install'` };
  }

  // Resolve from the SDK's own location: under pnpm the platform package is a
  // sibling of the SDK in the store, not a dependency of @kirie/core.
  const fromSdk = createRequire(sdkEntry);
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const pkg of candidates) {
    try {
      const path = fromSdk.resolve(`${pkg}/${exe}`);
      if (existsSync(path)) return { ok: true, path, candidates };
    } catch {
      // try the next candidate
    }
  }

  return {
    ok: false,
    candidates,
    error:
      `native Claude binary for ${process.platform}-${process.arch} is missing ` +
      `(looked for ${candidates.join(", ")}) — run 'pnpm install' without --omit=optional`,
  };
}
