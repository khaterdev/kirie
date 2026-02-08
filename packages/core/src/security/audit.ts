import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CredentialStore } from "./credential-store.js";
import { checkTls } from "./transport.js";
import { scanCode as scanCodePatterns } from "./code-scanner.js";
import type { SecurityConfig, KirieConfig } from "../config/schema.js";
import { CREDENTIAL_REF_PATTERN } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditSeverity = "critical" | "warning" | "info" | "pass";

export interface AuditFinding {
  /** Category of the finding */
  category: string;
  /** Severity level */
  severity: AuditSeverity;
  /** Human-readable description */
  message: string;
  /** Suggested remediation */
  remediation?: string;
}

export interface AuditReport {
  /** When the audit was performed */
  timestamp: Date;
  /** Total number of findings */
  totalFindings: number;
  /** Counts by severity */
  summary: Record<AuditSeverity, number>;
  /** All findings */
  findings: AuditFinding[];
  /** Overall pass/fail */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// SecurityAudit
// ---------------------------------------------------------------------------

export class SecurityAudit {
  private readonly credentialsDir: string;
  private readonly kirieDir: string;

  constructor(options?: { credentialsDir?: string; kirieDir?: string }) {
    this.kirieDir = options?.kirieDir ?? join(homedir(), ".kirie");
    this.credentialsDir =
      options?.credentialsDir ?? join(this.kirieDir, "credentials");
  }

  /**
   * Run a full security audit and return a structured report.
   * When `deep` is true, additional probing checks are performed
   * (gateway reachability, code safety scanning).
   */
  async run(config?: KirieConfig, opts?: { deep?: boolean; configPath?: string }): Promise<AuditReport> {
    const findings: AuditFinding[] = [];

    // File permissions
    findings.push(...this.auditFilePermissions());

    // Credential exposure
    if (config) {
      findings.push(...this.auditCredentialExposure(config));
    }

    // Credential integrity
    findings.push(...(await this.auditCredentialIntegrity()));

    // Policy review
    if (config) {
      findings.push(...this.auditSecurityPolicy(config.security));
    }

    // Transport security
    if (config) {
      findings.push(...this.auditTransportSecurity(config));
    }

    // Owner identity configuration
    if (config) {
      findings.push(...this.auditOwnerIdentities(config.security));
    }

    // Deep mode: gateway probing, code scanning, synced folders, attack surface
    if (opts?.deep) {
      if (config) {
        findings.push(...(await probeGateway(
          `http://127.0.0.1:${config.gateway.port}`,
        )));
      }
      findings.push(...detectSyncedFolders(this.kirieDir, opts.configPath));
      if (config) {
        findings.push(...collectAttackSurface(config));
      }
      findings.push(...this.auditCodeSafetyWithScanner());
    }

    const summary: Record<AuditSeverity, number> = {
      critical: 0,
      warning: 0,
      info: 0,
      pass: 0,
    };

    for (const f of findings) {
      summary[f.severity]++;
    }

    const passed = summary.critical === 0;

    return {
      timestamp: new Date(),
      totalFindings: findings.length,
      summary,
      findings,
      passed,
    };
  }

  /**
   * Format an audit report as a human-readable string.
   */
  static formatReport(report: AuditReport): string {
    const lines: string[] = [];
    lines.push("=== Kirie Security Audit ===");
    lines.push(`Date: ${report.timestamp.toISOString()}`);
    lines.push(`Status: ${report.passed ? "PASSED" : "FAILED"}`);
    lines.push("");
    lines.push("Summary:");
    lines.push(`  Critical: ${report.summary.critical}`);
    lines.push(`  Warning:  ${report.summary.warning}`);
    lines.push(`  Info:     ${report.summary.info}`);
    lines.push(`  Pass:     ${report.summary.pass}`);
    lines.push("");

    if (report.findings.length === 0) {
      lines.push("No findings.");
      return lines.join("\n");
    }

    lines.push("Findings:");
    lines.push("");

    for (const f of report.findings) {
      const icon = severityIcon(f.severity);
      lines.push(`${icon} [${f.category}] ${f.message}`);
      if (f.remediation) {
        lines.push(`   Fix: ${f.remediation}`);
      }
    }

    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Audit checks
  // -----------------------------------------------------------------------

  private auditFilePermissions(): AuditFinding[] {
    const findings: AuditFinding[] = [];

    // Check ~/.kirie directory
    if (!existsSync(this.kirieDir)) {
      findings.push({
        category: "filesystem",
        severity: "info",
        message: "Kirie config directory does not exist yet",
      });
      return findings;
    }

    const dirStat = statSync(this.kirieDir);
    const dirMode = dirStat.mode & 0o777;
    if ((dirMode & 0o077) !== 0) {
      findings.push({
        category: "filesystem",
        severity: "warning",
        message: `~/.kirie directory has permissions ${dirMode.toString(8)}, should not be world/group-accessible`,
        remediation: "chmod 700 ~/.kirie",
      });
    } else {
      findings.push({
        category: "filesystem",
        severity: "pass",
        message: "~/.kirie directory permissions are secure",
      });
    }

    // Check credentials directory
    if (!existsSync(this.credentialsDir)) {
      findings.push({
        category: "filesystem",
        severity: "info",
        message: "Credentials directory does not exist (no credentials stored)",
      });
      return findings;
    }

    const credDirStat = statSync(this.credentialsDir);
    const credDirMode = credDirStat.mode & 0o777;
    if (credDirMode !== 0o700) {
      findings.push({
        category: "filesystem",
        severity: "critical",
        message: `Credentials directory has permissions ${credDirMode.toString(8)}, expected 700`,
        remediation: "chmod 700 ~/.kirie/credentials",
      });
    } else {
      findings.push({
        category: "filesystem",
        severity: "pass",
        message: "Credentials directory permissions are secure (700)",
      });
    }

    // Check individual credential files
    const files = readdirSync(this.credentialsDir).filter((f) =>
      f.endsWith(".enc"),
    );

    for (const file of files) {
      const filePath = join(this.credentialsDir, file);
      const fileStat = statSync(filePath);
      const fileMode = fileStat.mode & 0o777;
      if (fileMode !== 0o600) {
        findings.push({
          category: "filesystem",
          severity: "critical",
          message: `Credential file ${file} has permissions ${fileMode.toString(8)}, expected 600`,
          remediation: `chmod 600 ${filePath}`,
        });
      }
    }

    if (files.length > 0) {
      const badFiles = files.filter((f) => {
        const mode = statSync(join(this.credentialsDir, f)).mode & 0o777;
        return mode !== 0o600;
      });
      if (badFiles.length === 0) {
        findings.push({
          category: "filesystem",
          severity: "pass",
          message: `All ${files.length} credential file(s) have secure permissions (600)`,
        });
      }
    }

    return findings;
  }

  private auditCredentialExposure(config: KirieConfig): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const secrets = findPlaintextSecrets(config);

    if (secrets.length > 0) {
      for (const path of secrets) {
        findings.push({
          category: "credentials",
          severity: "critical",
          message: `Potential plaintext secret at config path "${path}"`,
          remediation: `Use $credential:key reference instead of plaintext value at "${path}"`,
        });
      }
    } else {
      findings.push({
        category: "credentials",
        severity: "pass",
        message: "No plaintext secrets detected in config",
      });
    }

    return findings;
  }

  private async auditCredentialIntegrity(): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];

    if (!existsSync(this.credentialsDir)) {
      return findings;
    }

    try {
      const store = new CredentialStore({
        credentialsDir: this.credentialsDir,
      });
      const audit = await store.audit();

      let corruptCount = 0;
      for (const entry of audit) {
        if (!entry.integrityOk) {
          corruptCount++;
          findings.push({
            category: "credentials",
            severity: "critical",
            message: `Credential "${entry.key}" failed integrity check (may be corrupt or master key changed)`,
            remediation: `Re-set the credential: kirie credential set ${entry.key}`,
          });
        }
      }

      if (corruptCount === 0 && audit.length > 0) {
        findings.push({
          category: "credentials",
          severity: "pass",
          message: `All ${audit.length} credential(s) passed integrity verification`,
        });
      }
    } catch (err) {
      findings.push({
        category: "credentials",
        severity: "warning",
        message: `Could not verify credential integrity: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return findings;
  }

  private auditSecurityPolicy(security: SecurityConfig): AuditFinding[] {
    const findings: AuditFinding[] = [];

    // DM policy
    if (security.dmPolicy === "open") {
      findings.push({
        category: "policy",
        severity: "warning",
        message: 'DM policy is "open" — anyone can interact with the bot via DM',
        remediation: 'Set dmPolicy to "owner-only" or "allowlist" for better security',
      });
    } else {
      findings.push({
        category: "policy",
        severity: "pass",
        message: `DM policy is "${security.dmPolicy}"`,
      });
    }

    // Group policy
    if (security.groupPolicy === "all") {
      findings.push({
        category: "policy",
        severity: "info",
        message: 'Group policy is "all" — bot responds to all messages in groups',
      });
    } else if (security.groupPolicy === "disabled") {
      findings.push({
        category: "policy",
        severity: "pass",
        message: "Group interaction is disabled",
      });
    } else {
      findings.push({
        category: "policy",
        severity: "pass",
        message: `Group policy is "${security.groupPolicy}"`,
      });
    }

    // Rate limits
    const { perUser, perGroup } = security.rateLimit;
    if (perUser.maxRequests > 100) {
      findings.push({
        category: "policy",
        severity: "warning",
        message: `Per-user rate limit is very high: ${perUser.maxRequests} req/${Math.round(perUser.windowMs / 1000)}s`,
        remediation: "Consider lowering the per-user rate limit",
      });
    } else {
      findings.push({
        category: "policy",
        severity: "pass",
        message: `Per-user rate limit: ${perUser.maxRequests} req/${Math.round(perUser.windowMs / 1000)}s`,
      });
    }

    if (perGroup.maxRequests > 200) {
      findings.push({
        category: "policy",
        severity: "warning",
        message: `Per-group rate limit is very high: ${perGroup.maxRequests} req/${Math.round(perGroup.windowMs / 1000)}s`,
        remediation: "Consider lowering the per-group rate limit",
      });
    }

    return findings;
  }

  private auditTransportSecurity(config: KirieConfig): AuditFinding[] {
    const findings: AuditFinding[] = [];

    // Check webhook URLs
    const telegram = config.channels.telegram;
    if (telegram.enabled && telegram.webhookUrl) {
      const tls = checkTls(telegram.webhookUrl);
      if (!tls.secure) {
        findings.push({
          category: "transport",
          severity: "critical",
          message: `Telegram webhook URL is not using TLS: ${tls.issues.join("; ")}`,
          remediation: "Use an HTTPS URL for the Telegram webhook",
        });
      } else {
        findings.push({
          category: "transport",
          severity: "pass",
          message: "Telegram webhook URL is using TLS",
        });
      }
    }

    // Check gateway bind
    if (config.gateway.bind === "all") {
      findings.push({
        category: "transport",
        severity: "warning",
        message: "Gateway is bound to all interfaces (0.0.0.0) — accessible from network",
        remediation: 'Set gateway.bind to "loopback" unless network access is needed',
      });
    } else {
      findings.push({
        category: "transport",
        severity: "pass",
        message: "Gateway is bound to loopback only",
      });
    }

    // Check gateway bearer token
    if (config.gateway.bind === "all" && !config.gateway.bearerToken) {
      findings.push({
        category: "transport",
        severity: "critical",
        message: "Gateway is network-accessible without a bearer token",
        remediation: "Set gateway.bearerToken to a strong secret value",
      });
    }

    // Check Signal API URL
    const signal = config.channels.signal;
    if (signal.enabled) {
      const tls = checkTls(signal.apiUrl);
      if (!tls.secure) {
        findings.push({
          category: "transport",
          severity: "info",
          message: `Signal API URL is not using TLS: ${tls.issues.join("; ")}`,
        });
      }
    }

    return findings;
  }

  private auditOwnerIdentities(security: SecurityConfig): AuditFinding[] {
    const findings: AuditFinding[] = [];

    const identities = security.owner.identities;
    const hasAnyOwner = Object.values(identities).some(
      (ids) => (ids as Array<string | number>).length > 0,
    );

    if (!hasAnyOwner) {
      findings.push({
        category: "identity",
        severity: "warning",
        message: "No owner identities configured for any channel",
        remediation:
          "Add your user IDs to security.owner.identities in config.yaml",
      });
    } else {
      const channels = Object.entries(identities)
        .filter(([, ids]) => (ids as Array<string | number>).length > 0)
        .map(([ch]) => ch);
      findings.push({
        category: "identity",
        severity: "pass",
        message: `Owner identities configured for: ${channels.join(", ")}`,
      });
    }

    return findings;
  }
  // -----------------------------------------------------------------------
  // Deep audit checks
  // -----------------------------------------------------------------------

  /**
   * Scan skill/plugin directories using the full code-scanner pattern set
   * (20+ patterns) instead of the minimal inline list.
   */
  private auditCodeSafetyWithScanner(): AuditFinding[] {
    const findings: AuditFinding[] = [];

    const dirsToScan = [
      join(this.kirieDir, "plugins"),
      join(this.kirieDir, "skills"),
    ];

    for (const dir of dirsToScan) {
      if (!existsSync(dir)) continue;

      try {
        const files = collectJsTsFiles(dir);
        for (const file of files) {
          try {
            const content = readFileSync(file, "utf-8");
            const results = scanCodePatterns(content);
            for (const r of results) {
              const severity: AuditSeverity =
                r.severity === "block" ? "critical" : r.severity === "warn" ? "warning" : "info";
              findings.push({
                category: "code-safety",
                severity,
                message: `${r.description} in ${file}${r.line ? ` (line ${r.line})` : ""}`,
                remediation: "Review the file for potential security issues",
              });
            }
          } catch {
            // Skip unreadable files
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "code-safety",
        severity: "pass",
        message: "No dangerous code patterns detected in plugins/skills",
      });
    }

    return findings;
  }
}

// ---------------------------------------------------------------------------
// Deep audit standalone functions (exported for direct use & testing)
// ---------------------------------------------------------------------------

/**
 * Probe a gateway URL: check reachability via /health and detect
 * whether the gateway is exposed on a public network interface.
 */
export async function probeGateway(url: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // HTTP health check
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    findings.push({
      category: "gateway",
      severity: "info",
      message: `Gateway is reachable — responded with ${res.status}`,
    });
  } catch {
    findings.push({
      category: "gateway",
      severity: "warning",
      message: `Gateway not reachable at ${url}`,
      remediation: "Verify gateway URL and service status",
    });
  }

  // Public exposure check
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      findings.push({
        category: "gateway",
        severity: "critical",
        message: `Gateway exposed on public interface (${parsed.hostname})`,
        remediation:
          "Bind to localhost unless remote access is intentional",
      });
    }
  } catch {
    // URL parsing failed — already reported as unreachable
  }

  return findings;
}

/**
 * Detect if the state directory or config file lives inside a
 * cloud-synced folder (iCloud, Dropbox, Google Drive, OneDrive).
 */
export function detectSyncedFolders(
  stateDir?: string,
  configPath?: string,
): AuditFinding[] {
  const patterns = [
    /iCloud/i,
    /Dropbox/i,
    /Google Drive/i,
    /OneDrive/i,
    /Library\/Mobile Documents/i,
  ];
  const findings: AuditFinding[] = [];

  for (const [label, path] of [
    ["State directory", stateDir],
    ["Config file", configPath],
  ] as const) {
    if (!path) continue;
    if (patterns.some((p) => p.test(path))) {
      findings.push({
        category: "filesystem",
        severity: "warning",
        message: `${label} is in a cloud-synced folder (${path})`,
        remediation: "Move to a non-synced location to prevent conflicts",
      });
    }
  }

  return findings;
}

/**
 * Analyse config for broad attack surface: open group policy,
 * disabled sandbox, etc.
 */
export function collectAttackSurface(config: KirieConfig): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (config.security.groupPolicy === "all") {
    findings.push({
      category: "attack-surface",
      severity: "critical",
      message: "Group policy is open — anyone can interact with the bot in groups",
      remediation: "Set groupPolicy to 'mention-only' or 'disabled'",
    });
  }

  if (config.sandbox.mode === "off") {
    findings.push({
      category: "attack-surface",
      severity: "info",
      message: "Sandbox disabled — agent tools run without isolation",
      remediation: "Enable Docker sandbox for production",
    });
  }

  return findings;
}

/**
 * Convenience entry-point: create a SecurityAudit instance and run
 * with deep=true, returning the full report.
 */
export async function runDeepAudit(
  config?: KirieConfig,
  opts?: {
    kirieDir?: string;
    credentialsDir?: string;
    configPath?: string;
  },
): Promise<AuditReport> {
  const audit = new SecurityAudit({
    kirieDir: opts?.kirieDir,
    credentialsDir: opts?.credentialsDir,
  });
  return audit.run(config, { deep: true, configPath: opts?.configPath });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectJsTsFiles(dir: string, maxDepth = 3): string[] {
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      ) {
        results.push(...collectJsTsFiles(fullPath, maxDepth - 1));
      } else if (
        entry.isFile() &&
        /\.(js|ts|mjs|mts)$/.test(entry.name)
      ) {
        results.push(fullPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityIcon(severity: AuditSeverity): string {
  switch (severity) {
    case "critical":
      return "[CRITICAL]";
    case "warning":
      return "[WARNING] ";
    case "info":
      return "[INFO]    ";
    case "pass":
      return "[PASS]    ";
  }
}

/**
 * Walk the config object and find string values that look like plaintext
 * secrets (long random-looking strings in token/secret/key fields) but
 * are NOT $credential: references.
 */
function findPlaintextSecrets(
  obj: unknown,
  path: string = "",
): string[] {
  const results: string[] = [];

  if (typeof obj === "string") {
    // Skip $credential: references — they're handled correctly
    if (CREDENTIAL_REF_PATTERN.test(obj)) {
      return results;
    }

    // Check if this path looks like it should contain a secret
    const sensitiveKeys =
      /\b(token|secret|password|key|credential|api_key|apiKey|botToken|appToken|signingSecret)\b/i;
    if (sensitiveKeys.test(path) && obj.length > 8) {
      results.push(path);
    }

    return results;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...findPlaintextSecrets(obj[i], `${path}[${i}]`));
    }
    return results;
  }

  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      results.push(...findPlaintextSecrets(value, path ? `${path}.${key}` : key));
    }
  }

  return results;
}
