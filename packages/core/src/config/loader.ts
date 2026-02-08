import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ZodError } from "zod/v3";
import { KirieConfigSchema, CREDENTIAL_REF_PATTERN } from "./schema.js";
import type { KirieConfig } from "./schema.js";
import { processIncludes } from "./includes.js";

const KIRIE_DIR = join(homedir(), ".kirie");
const DEFAULT_CONFIG_PATH = join(KIRIE_DIR, "config.yaml");

export interface CredentialResolver {
  get(key: string): string | undefined;
}

export interface LoadConfigOptions {
  configPath?: string;
  credentialResolver?: CredentialResolver;
}

/**
 * Recursively walk a value and resolve any $credential:key references
 * found in string leaves.
 */
function resolveCredentials(
  value: unknown,
  resolver: CredentialResolver,
): unknown {
  if (typeof value === "string") {
    const match = CREDENTIAL_REF_PATTERN.exec(value);
    if (match) {
      const key = match[1]!;
      const resolved = resolver.get(key);
      if (resolved === undefined) {
        return value; // keep the reference if not yet resolvable
      }
      return resolved;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveCredentials(item, resolver));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveCredentials(v, resolver);
    }
    return result;
  }

  return value;
}

/**
 * Ensures the ~/.kirie directory exists and creates a default config.yaml
 * if none is present.
 */
function ensureDefaults(configPath: string): void {
  const dir = configPath === DEFAULT_CONFIG_PATH ? KIRIE_DIR : undefined;
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(configPath)) {
    const defaultYaml = stringifyYaml({
      agent: {
        maxTurns: 100,
        model: "claude-opus-4-6",
      },
      security: {
        dmPolicy: "owner-only",
        groupPolicy: "mention-only",
      },
      memory: {
        enabled: true,
        backend: "sqlite",
      },
      gateway: {
        port: 18789,
        bind: "loopback",
      },
    });
    writeFileSync(configPath, defaultYaml, "utf-8");
  }
}

/**
 * Load raw YAML from the config file without Zod parsing.
 * Returns the unvalidated object. Useful for the watcher to detect raw diffs.
 */
export function loadRawConfig(configPath?: string): Record<string, unknown> {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) {
    return {};
  }
  const content = readFileSync(path, "utf-8");
  const parsed = parseYaml(content);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${path} must be a YAML mapping, got ${typeof parsed}`);
  }
  // Resolve $include directives before returning
  const resolved = processIncludes(parsed, path);
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw new Error(`Config at ${path} must be a YAML mapping after include resolution`);
  }
  return resolved as Record<string, unknown>;
}

/**
 * Load, validate, and optionally resolve credentials in the Kirie config.
 *
 * 1. Ensures ~/.kirie/ and a default config.yaml exist.
 * 2. Reads and parses the YAML file.
 * 3. Validates against the KirieConfigSchema (Zod).
 * 4. Optionally resolves $credential:key references if a resolver is provided.
 */
export function loadConfig(options: LoadConfigOptions = {}): KirieConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  ensureDefaults(configPath);

  const raw = loadRawConfig(configPath);

  let config: KirieConfig;
  try {
    config = KirieConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid config at ${configPath}:\n${issues}`);
    }
    throw err;
  }

  if (options.credentialResolver) {
    config = KirieConfigSchema.parse(
      resolveCredentials(config, options.credentialResolver),
    );
  }

  return config;
}

export { DEFAULT_CONFIG_PATH, KIRIE_DIR };
