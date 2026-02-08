import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSkillFile, scanSkillDirectory } from "./loader.js";
import type { SkillSource } from "./types.js";

/** Manages installed skills in the managed skills directory (~/.kirie/skills) */
export class SkillWorkspace {
  private managedDir: string;

  constructor(managedDir?: string) {
    this.managedDir = managedDir ?? join(homedir(), ".kirie", "skills");
  }

  /** Install a skill from a local directory */
  install(
    source: string,
    name: string,
  ): { success: boolean; path: string } {
    const dest = join(this.managedDir, name);
    try {
      mkdirSync(this.managedDir, { recursive: true });
      cpSync(source, dest, { recursive: true });
      return { success: true, path: dest };
    } catch {
      return { success: false, path: dest };
    }
  }

  /** Uninstall a managed skill */
  uninstall(name: string): boolean {
    const skillDir = join(this.managedDir, name);
    if (!existsSync(skillDir)) return false;
    try {
      rmSync(skillDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** List installed managed skill names */
  list(): string[] {
    if (!existsSync(this.managedDir)) return [];
    return readdirSync(this.managedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(this.managedDir, e.name, "SKILL.md")))
      .map((e) => e.name);
  }

  /** Get a snapshot of current managed skills with names and versions */
  snapshot(): Array<{ name: string; version?: string; source: SkillSource }> {
    const skills = scanSkillDirectory(this.managedDir, "managed");
    return skills.map((s) => ({
      name: s.name,
      version: s.version,
      source: s.source,
    }));
  }
}
