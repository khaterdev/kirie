/**
 * Test-only helpers for the curator tests (not exported, not bundled).
 * Every fixture lives in a fresh temp directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillStateRecord } from "@kirie/core";
import type { DetectorEnv } from "./detectors.js";

export function skillMd(name: string, description = `How to ${name}`, body = `# ${name}\n\n1. Do the thing.\n2. Check it worked.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

export interface FixtureTree {
  dir: string;
  root: string;
  write(name: string, files: Record<string, string>): string;
  cleanup(): void;
}

export function fixtureTree(prefix = "kirie-curator-"): FixtureTree {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, ".claude", "skills");
  mkdirSync(root, { recursive: true });
  return {
    dir,
    root,
    write(name, files) {
      const skillDir = join(root, name);
      mkdirSync(skillDir, { recursive: true });
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(skillDir, rel)), { recursive: true });
        writeFileSync(join(skillDir, rel), text);
      }
      return skillDir;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function stateRow(name: string, over: Partial<SkillStateRecord> = {}): SkillStateRecord {
  return {
    name, root: "project", source: "local", state: "active", pinned: false, override: false,
    firstSeenAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, useCount: 0, approvedHash: null, approvedAt: null,
    archivedAt: null, archivePath: null, absorbedInto: null,
    ...over,
  };
}

export function testEnv(over: Partial<DetectorEnv> = {}): DetectorEnv {
  return {
    binExists: (b) => b === "git",
    platform: "darwin",
    hasEnv: (n) => n === "PRESENT_KEY",
    scanCode: (code) => (/eval\s*\(/.test(code) ? [{ severity: "block", description: "Dynamic code execution via eval()" }] : []),
    ...over,
  };
}
