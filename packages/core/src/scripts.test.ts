import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Static analysis regression test: ensures no package.json in the monorepo
 * uses Unix-only `rm -rf` in its "clean" script.
 */

const REPO_ROOT = resolve(import.meta.dirname ?? ".", "../../..");

/** Recursively find all package.json files in directories that may contain them */
function findPackageJsons(root: string): string[] {
  const dirs = ["packages", "apps", "channels"];
  const results: string[] = [];

  for (const dir of dirs) {
    const dirPath = join(root, dir);
    if (!existsSync(dirPath)) continue;

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJson = join(dirPath, entry.name, "package.json");
      if (existsSync(pkgJson)) {
        results.push(pkgJson);
      }
    }
  }

  return results;
}

describe("npm clean scripts", () => {
  const packageJsons = findPackageJsons(REPO_ROOT);

  it("finds at least 10 package.json files", () => {
    expect(packageJsons.length).toBeGreaterThanOrEqual(10);
  });

  it.each(packageJsons)("%s does not use rm -rf in clean script", (pkgPath) => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const clean = pkg.scripts?.clean;
    if (!clean) return; // no clean script is fine

    expect(clean).not.toMatch(/\brm\s+-rf\b/);
  });

  it.each(packageJsons)(
    "%s uses cross-platform node -e pattern in clean script (if present)",
    (pkgPath) => {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      const clean = pkg.scripts?.clean;
      if (!clean) return;

      expect(clean).toMatch(/node -e/);
    },
  );
});
