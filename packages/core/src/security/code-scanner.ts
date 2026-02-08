export interface CodeScanResult {
  severity: "block" | "warn" | "info";
  pattern: string;
  description: string;
  line?: number;
  column?: number;
}

const PATTERNS: Array<{
  regex: RegExp;
  severity: CodeScanResult["severity"];
  description: string;
}> = [
  // Command injection
  { regex: /exec\s*\(\s*['"`].*\$\{/, severity: "block", description: "Template literal command injection" },
  { regex: /exec\s*\(\s*[^'"`)]+\+/, severity: "warn", description: "Dynamic command construction" },
  { regex: /child_process\.(exec|spawn|fork)/, severity: "warn", description: "Child process execution" },

  // Eval / dynamic code
  { regex: /\beval\s*\(/, severity: "block", description: "eval() usage" },
  { regex: /new\s+Function\s*\(/, severity: "block", description: "Dynamic Function constructor" },
  { regex: /setTimeout\s*\(\s*['"`]/, severity: "warn", description: "setTimeout with string argument" },
  { regex: /setInterval\s*\(\s*['"`]/, severity: "warn", description: "setInterval with string argument" },

  // Data exfiltration
  { regex: /fetch\s*\(\s*['"`]https?:\/\/(?!api\.(openai|anthropic|brave))/, severity: "info", description: "External HTTP request" },
  { regex: /XMLHttpRequest/, severity: "info", description: "XMLHttpRequest usage" },
  { regex: /\.send\s*\(.*process\.env/, severity: "block", description: "Sending environment variables externally" },

  // Environment harvesting
  { regex: /Object\.keys\s*\(\s*process\.env\s*\)/, severity: "block", description: "Enumerating all environment variables" },
  { regex: /JSON\.stringify\s*\(\s*process\.env\s*\)/, severity: "block", description: "Serializing all environment variables" },
  { regex: /process\.env\b/, severity: "info", description: "Environment variable access" },

  // Crypto mining
  { regex: /crypto.*mine|stratum\+tcp|coinhive|cryptonight/i, severity: "block", description: "Crypto mining indicators" },

  // Obfuscated code
  { regex: /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){5,}/, severity: "warn", description: "Hex-encoded string sequence" },
  { regex: /atob\s*\(\s*['"][A-Za-z0-9+/=]{20,}/, severity: "warn", description: "Long base64 decode" },
  { regex: /String\.fromCharCode\s*\((?:\s*\d+\s*,){5,}/, severity: "warn", description: "String.fromCharCode sequence" },

  // File system dangers
  { regex: /fs\.(rm|rmdir|unlink)Sync?\s*\(\s*['"`]\//, severity: "block", description: "Deleting files from root path" },
  { regex: /fs\.chmod/, severity: "warn", description: "File permission modification" },

  // Network dangers
  { regex: /require\s*\(\s*['"]https?:/, severity: "block", description: "Remote code loading via require" },
  { regex: /import\s*\(\s*['"]https?:/, severity: "block", description: "Remote code loading via dynamic import" },
];

export function scanCode(code: string): CodeScanResult[] {
  const results: CodeScanResult[] = [];
  const lines = code.split("\n");

  for (const { regex, severity, description } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const match = regex.exec(lines[i]!);
      if (match) {
        results.push({
          severity,
          pattern: regex.source,
          description,
          line: i + 1,
          column: match.index,
        });
      }
    }
  }

  return results;
}

export function hasBlockingIssues(results: CodeScanResult[]): boolean {
  return results.some(r => r.severity === "block");
}
