export interface ScanResult {
  severity: "block" | "warn" | "info";
  pattern: string;
  description: string;
  line?: number;
}

const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  severity: ScanResult["severity"];
  description: string;
}> = [
  {
    pattern: /eval\s*\(/,
    severity: "block",
    description: "Dynamic code execution via eval()",
  },
  {
    pattern: /new\s+Function\s*\(/,
    severity: "block",
    description: "Dynamic function creation",
  },
  {
    pattern: /child_process/,
    severity: "warn",
    description: "Child process access",
  },
  {
    pattern: /process\.env/,
    severity: "info",
    description: "Environment variable access",
  },
  {
    pattern: /fs\.(write|unlink|rm|chmod)/,
    severity: "warn",
    description: "File system write operations",
  },
  {
    pattern: /require\s*\(\s*['"]https?:/,
    severity: "block",
    description: "Remote code loading",
  },
  {
    pattern: /fetch\s*\(\s*['"]https?:.*\.(exe|sh|bat)/,
    severity: "block",
    description: "Executable download",
  },
  {
    pattern: /Buffer\.from\s*\(.*,\s*['"]base64['"]/,
    severity: "info",
    description: "Base64 decoding",
  },
  {
    pattern: /crypto\s*\.\s*create(Cipher|Hash)/,
    severity: "info",
    description: "Cryptographic operations",
  },
  {
    pattern: /\.exec\s*\(/,
    severity: "warn",
    description: "Command execution",
  },
  {
    pattern: /btoa|atob/,
    severity: "info",
    description: "Base64 encoding/decoding",
  },
  {
    pattern: /document\.cookie/,
    severity: "block",
    description: "Cookie access",
  },
  {
    pattern: /localStorage|sessionStorage/,
    severity: "warn",
    description: "Browser storage access",
  },
  {
    pattern: /XMLHttpRequest|fetch\(/,
    severity: "info",
    description: "Network requests",
  },
  {
    pattern: /process\.exit/,
    severity: "warn",
    description: "Process termination",
  },
  {
    pattern: /require\s*\(\s*['"]child_process['"]/,
    severity: "block",
    description: "Direct child_process import",
  },
  {
    pattern: /exec\s*\(\s*['"`].*\$\{/,
    severity: "block",
    description: "Command injection via template literal",
  },
  {
    pattern: /\.env\[/,
    severity: "info",
    description: "Dynamic env var access",
  },
  {
    pattern: /webhook|exfil|leak|steal/i,
    severity: "warn",
    description: "Suspicious keyword",
  },
  {
    pattern: /miner|mining|crypto.*mine/i,
    severity: "block",
    description: "Crypto mining reference",
  },
];

/** Scan code content for dangerous patterns */
export function scanCode(code: string): ScanResult[] {
  const results: ScanResult[] = [];
  const lines = code.split("\n");

  for (const { pattern, severity, description } of DANGEROUS_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        results.push({
          severity,
          pattern: pattern.source,
          description,
          line: i + 1,
        });
      }
    }
  }

  return results;
}

/** Check if scan results contain any blocking issues */
export function hasBlockingIssues(results: ScanResult[]): boolean {
  return results.some((r) => r.severity === "block");
}
