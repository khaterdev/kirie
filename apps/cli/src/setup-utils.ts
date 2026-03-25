import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ── Deep Merge ──────────────────────────────────────────────────────────────

/**
 * Deep-merge `source` into `target`. Returns a new object.
 *
 * Rules:
 * - Scalar values in source overwrite those in target.
 * - Objects are recursively merged.
 * - Arrays in source replace arrays in target (no element-level merge).
 * - `undefined` values in source are skipped (target preserved).
 * - `null` values in source DO overwrite (explicit clear).
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (srcVal === undefined) {
      // Skip undefined — preserve target
      continue;
    }

    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      // Both are plain objects — recurse
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      // Overwrite (scalars, arrays, null, or mismatched types)
      result[key] = srcVal;
    }
  }

  return result;
}

// ── .env File Parsing ────────────────────────────────────────────────────────

/**
 * Parse a .env file string into a key-value map.
 * Handles:
 * - KEY=VALUE (with and without quotes)
 * - Comments (lines starting with #)
 * - Blank lines
 * - Single-quoted, double-quoted, and unquoted values
 */
export function parseEnvFile(content: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      result.set(key, value);
    }
  }

  return result;
}

/**
 * Serialize a key-value map to .env file format.
 */
export function serializeEnvFile(entries: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Merge new env entries into an existing .env file path.
 * If the file doesn't exist, creates it with just the new entries.
 * Returns the merged content string.
 */
export function mergeEnvFile(
  envPath: string,
  newEntries: Record<string, string>,
): string {
  let existing = new Map<string, string>();

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    existing = parseEnvFile(content);
  }

  // Merge: new entries overwrite existing keys, existing untouched keys preserved
  for (const [key, value] of Object.entries(newEntries)) {
    existing.set(key, value);
  }

  return serializeEnvFile(existing);
}

// ── Config YAML Merge ────────────────────────────────────────────────────────

/**
 * Read an existing config.yaml, deep-merge new values into it, and return
 * the merged result.
 *
 * If the config file doesn't exist, returns the newConfig as-is.
 */
export function mergeConfigYaml(
  configPath: string,
  newConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return newConfig;
  }

  const existingContent = readFileSync(configPath, "utf-8");
  const existing = parseYaml(existingContent);

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    // Existing file is malformed or empty — replace with new config
    return newConfig;
  }

  return deepMerge(existing as Record<string, unknown>, newConfig);
}

/**
 * Write a YAML config object to a file path.
 */
export function writeConfigYaml(
  configPath: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(configPath, stringifyYaml(config), "utf-8");
}
