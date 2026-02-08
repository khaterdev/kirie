import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BACKUP_DIR = join(homedir(), ".kirie", "config-backups");
const MAX_BACKUPS = 10;

export class ConfigBackup {
  private backupDir: string;

  constructor(backupDir?: string) {
    this.backupDir = backupDir ?? DEFAULT_BACKUP_DIR;
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /** Create a backup of the config file before writing changes */
  backup(configPath: string): string {
    if (!existsSync(configPath)) return "";

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${basename(configPath, ".yaml")}-${timestamp}.yaml`;
    const backupPath = join(this.backupDir, name);

    copyFileSync(configPath, backupPath);
    this.rotate();

    return backupPath;
  }

  /** Keep only the most recent MAX_BACKUPS files */
  private rotate(): void {
    const files = readdirSync(this.backupDir)
      .filter(f => f.endsWith(".yaml"))
      .sort()
      .reverse();

    for (const file of files.slice(MAX_BACKUPS)) {
      unlinkSync(join(this.backupDir, file));
    }
  }

  /** List available backups */
  list(): string[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter(f => f.endsWith(".yaml"))
      .sort()
      .reverse();
  }

  /** Restore a backup to the config path */
  restore(backupName: string, targetPath: string): void {
    const source = join(this.backupDir, backupName);
    if (!existsSync(source)) throw new Error(`Backup not found: ${backupName}`);
    this.backup(targetPath); // backup current before restoring
    copyFileSync(source, targetPath);
  }
}
