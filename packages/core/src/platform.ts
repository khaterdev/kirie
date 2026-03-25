import { execFileSync } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * Cross-platform binary existence check.
 * Uses execFileSync with `where` on Windows, `which` on Unix.
 * No shell invocation -- safe from injection.
 */
export function binExists(name: string): boolean {
  try {
    const cmd = IS_WINDOWS ? "where" : "which";
    execFileSync(cmd, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a Windows host path to a Docker-compatible path.
 * E.g. "C:\Users\foo\.kirie" → "/c/Users/foo/.kirie"
 * On non-Windows, returns the path unchanged.
 */
export function toDockerPath(hostPath: string): string {
  if (!IS_WINDOWS) return hostPath;
  return hostPath
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, "/");
}
