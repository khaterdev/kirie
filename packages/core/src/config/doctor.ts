/**
 * Config doctor - validates configuration and optionally auto-fixes issues.
 */
import { existsSync, statSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { KirieConfigSchema } from "./schema.js";
import { loadRawConfig } from "./loader.js";

export interface DoctorCheck {
  category: string;
  status: "pass" | "warning" | "error";
  message: string;
  fixable?: boolean;
}

export interface DoctorFix {
  category: string;
  action: string;
  applied: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  fixes: DoctorFix[];
  summary: { passed: number; warnings: number; errors: number; fixed: number };
}

export async function runDoctor(opts: {
  fix?: boolean;
  configPath?: string;
}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const fixes: DoctorFix[] = [];
  const kirieDir = join(homedir(), ".kirie");

  // 1. Check kirie directory exists
  if (!existsSync(kirieDir)) {
    checks.push({
      category: "filesystem",
      status: "warning",
      message: "~/.kirie directory does not exist",
      fixable: true,
    });
    if (opts.fix) {
      mkdirSync(kirieDir, { recursive: true, mode: 0o700 });
      fixes.push({ category: "filesystem", action: "Created ~/.kirie directory", applied: true });
    }
  } else {
    // Check permissions
    const stat = statSync(kirieDir);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      checks.push({
        category: "filesystem",
        status: "warning",
        message: `~/.kirie has permissions ${mode.toString(8)}, should be 700`,
        fixable: true,
      });
      if (opts.fix) {
        chmodSync(kirieDir, 0o700);
        fixes.push({ category: "filesystem", action: "Fixed ~/.kirie permissions to 700", applied: true });
      }
    } else {
      checks.push({ category: "filesystem", status: "pass", message: "~/.kirie permissions are secure" });
    }
  }

  // 2. Check config file
  const configPath = opts.configPath ?? join(kirieDir, "config.yaml");
  if (!existsSync(configPath)) {
    checks.push({
      category: "config",
      status: "warning",
      message: "Config file not found at " + configPath,
    });
  } else {
    // Check config file permissions
    const fileStat = statSync(configPath);
    const fileMode = fileStat.mode & 0o777;
    if ((fileMode & 0o077) !== 0) {
      checks.push({
        category: "filesystem",
        status: "warning",
        message: `Config file has permissions ${fileMode.toString(8)}, should be 600`,
        fixable: true,
      });
      if (opts.fix) {
        chmodSync(configPath, 0o600);
        fixes.push({ category: "filesystem", action: "Fixed config file permissions to 600", applied: true });
      }
    } else {
      checks.push({ category: "filesystem", status: "pass", message: "Config file permissions are secure" });
    }

    // Validate config schema
    try {
      const raw = loadRawConfig(configPath);
      const result = KirieConfigSchema.safeParse(raw);
      if (result.success) {
        checks.push({ category: "config", status: "pass", message: "Config schema validation passed" });

        // Check security policies
        const config = result.data;
        if (config.security.dmPolicy === "open") {
          checks.push({
            category: "security",
            status: "warning",
            message: 'DM policy is "open" — consider "owner-only" or "allowlist"',
          });
        } else {
          checks.push({ category: "security", status: "pass", message: `DM policy: ${config.security.dmPolicy}` });
        }

        // Check if owner identities are configured
        const hasOwner = Object.values(config.security.owner.identities).some(
          (ids) => (ids as unknown[]).length > 0,
        );
        if (!hasOwner) {
          checks.push({
            category: "security",
            status: "warning",
            message: "No owner identities configured",
          });
        } else {
          checks.push({ category: "security", status: "pass", message: "Owner identities configured" });
        }

        // Check gateway security
        if (config.gateway.bind === "all" && !config.gateway.bearerToken) {
          checks.push({
            category: "security",
            status: "error",
            message: "Gateway bound to all interfaces without bearer token",
          });
        }
      } else {
        for (const issue of result.error.issues) {
          checks.push({
            category: "config",
            status: "error",
            message: `Schema error at ${issue.path.join(".")}: ${issue.message}`,
          });
        }
      }
    } catch (err) {
      checks.push({
        category: "config",
        status: "error",
        message: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 3. Check required directories
  const requiredDirs = ["media", "logs", "workspace"];
  for (const dir of requiredDirs) {
    const dirPath = join(kirieDir, dir);
    if (!existsSync(dirPath)) {
      checks.push({
        category: "filesystem",
        status: "warning",
        message: `Missing directory: ~/.kirie/${dir}`,
        fixable: true,
      });
      if (opts.fix) {
        mkdirSync(dirPath, { recursive: true });
        fixes.push({ category: "filesystem", action: `Created ~/.kirie/${dir}`, applied: true });
      }
    }
  }

  // Build summary
  const summary = {
    passed: checks.filter((c) => c.status === "pass").length,
    warnings: checks.filter((c) => c.status === "warning").length,
    errors: checks.filter((c) => c.status === "error").length,
    fixed: fixes.filter((f) => f.applied).length,
  };

  return { checks, fixes, summary };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push("=== Kirie Config Doctor ===");
  lines.push(`Passed: ${result.summary.passed} | Warnings: ${result.summary.warnings} | Errors: ${result.summary.errors} | Fixed: ${result.summary.fixed}`);
  lines.push("");

  for (const check of result.checks) {
    const icon = check.status === "pass" ? "[PASS]" : check.status === "warning" ? "[WARN]" : "[ERR] ";
    lines.push(`${icon} [${check.category}] ${check.message}`);
  }

  if (result.fixes.length > 0) {
    lines.push("");
    lines.push("Fixes applied:");
    for (const fix of result.fixes) {
      lines.push(`  - [${fix.category}] ${fix.action}`);
    }
  }

  return lines.join("\n");
}
