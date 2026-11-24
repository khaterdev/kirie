/**
 * Secret scrubbing wiring (PLAN B.8, C.12; W1B).
 *
 * `lifecycle.ts` calls `configureScrubber` and `registerKnownSecrets` as soon
 * as the config is loaded, before any channel, engine or store starts. The
 * feature setup below then puts the scrubber config into the kirie-tools MCP
 * env (the stdio subprocess scrubs with the same rules) and warns when
 * scrubbing is off. `security.scrubbing.enabled` is frozen at the first
 * configure call: a config reload or restart cannot turn it off.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createScrubApp,
  isPlausibleSecretValue,
  isSecretAssignmentName,
  resolveScrubbingConfig,
  type KirieConfig,
  type ScrubbingSchemaConfig,
  type SecretScrubber,
} from "@kirie/core";
import type { FeatureSetup } from "./types.js";

/** Config field names that hold a secret even when the generic name rule would not say so. */
const CONFIG_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "token", "botToken", "appToken", "signingSecret", "apiKey", "bearerToken",
  "authToken", "accountSid", "authId", "pin",
]);

export interface KnownSecretSources {
  /** Decrypted credential store values, by key */
  credentials?: ReadonlyMap<string, string>;
  /** The loaded config, with `$credential:` references already resolved */
  config?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  /** ~/.kirie/secrets: every `*.env` file's KEY=value lines */
  secretsDir?: string;
}

export interface KnownSecretCounts {
  credentialStore: number;
  config: number;
  env: number;
  secretsDir: number;
}

/**
 * Register known secret values with the scrubber, from the sources the
 * scrubbing config enables. Labels name the source and key, never the value.
 */
export function registerKnownSecrets(
  scrubber: SecretScrubber,
  cfg: ScrubbingSchemaConfig,
  sources: KnownSecretSources,
): KnownSecretCounts {
  const counts: KnownSecretCounts = { credentialStore: 0, config: 0, env: 0, secretsDir: 0 };
  const add = (value: string, label: string, source: keyof KnownSecretCounts) => {
    if (typeof value !== "string" || !value.trim() || value.startsWith("$credential:")) return;
    scrubber.addKnownSecret(value, label);
    counts[source] += 1;
  };

  if (cfg.knownSecrets.credentialStore && sources.credentials) {
    for (const [key, value] of sources.credentials) add(value, `credential:${key}`, "credentialStore");
  }

  if (cfg.knownSecrets.config && sources.config) {
    walkConfig(sources.config, [], (path, key, value) => {
      if (CONFIG_SECRET_FIELDS.has(key) || isSecretAssignmentName(key)) {
        if (isPlausibleSecretValue(value) || CONFIG_SECRET_FIELDS.has(key)) add(value, `config:${path.join(".")}`, "config");
      }
    });
  }

  if (cfg.knownSecrets.env && sources.env) {
    for (const [name, value] of Object.entries(sources.env)) {
      if (!value || !isSecretAssignmentName(name) || !isPlausibleSecretValue(value)) continue;
      add(value, `env:${name}`, "env");
    }
  }

  if (cfg.knownSecrets.secretsDir && sources.secretsDir) {
    for (const { file, name, value } of readSecretsDir(sources.secretsDir)) {
      add(value, `secrets:${file}:${name}`, "secretsDir");
    }
  }

  return counts;
}

function walkConfig(node: unknown, path: string[], visit: (path: string[], key: string, value: string) => void, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkConfig(v, [...path, String(i)], visit, depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string") visit([...path, key], key, value);
    else walkConfig(value, [...path, key], visit, depth + 1);
  }
}

/** KEY=value lines of every regular `*.env` file in the directory. A missing directory yields nothing. */
export function readSecretsDir(dir: string): Array<{ file: string; name: string; value: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; name: string; value: string }> = [];
  for (const file of entries) {
    if (!file.endsWith(".env")) continue;
    const full = join(dir, file);
    try {
      if (!statSync(full).isFile()) continue;
      for (const raw of readFileSync(full, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (name && value) out.push({ file, name, value });
      }
    } catch {
      // Unreadable file: nothing to register from it.
    }
  }
  return out;
}

/** The scrubber config handed to `configureScrubber` and to the stdio subprocess. */
export function daemonScrubbingConfig(config: KirieConfig): ScrubbingSchemaConfig {
  return resolveScrubbingConfig(config);
}

let frozenScrubbing: ScrubbingSchemaConfig | null = null;

/**
 * The scrubbing config of this process: the first call fixes it, later calls
 * (in-process restarts after a config change) return that first value. The
 * daemon's scrubber and the stdio subprocess env both use it, so a restart can
 * never loosen one without the other.
 */
export function freezeScrubbingConfig(cfg: ScrubbingSchemaConfig): ScrubbingSchemaConfig {
  frozenScrubbing ??= cfg;
  return frozenScrubbing;
}

/** Tests only. */
export function resetFrozenScrubbingConfigForTesting(): void {
  frozenScrubbing = null;
}

/** A rejection or exception reduced to `{ name, message }` before it reaches a log line (C.12 incident). */
export function sanitizeErrorForLog(reason: unknown): { name: string; message: string } {
  if (reason instanceof Error) {
    return { name: reason.name || "Error", message: String(reason.message ?? "").slice(0, 500) };
  }
  if (reason !== null && typeof reason === "object") {
    const r = reason as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : "Object";
    const message = typeof r.message === "string"
      ? r.message
      : typeof r.description === "string" ? r.description : "non-Error rejection";
    return { name, message: message.slice(0, 500) };
  }
  return { name: typeof reason, message: String(reason).slice(0, 500) };
}

/**
 * SCRUB-N8: the log files (launchd's daemon.out.log and daemon.err.log, the
 * audit trail, other *.log / *.jsonl) are made readable by the owner only.
 * launchd creates its log files 0644; this runs at every start. Best effort:
 * returns the files it changed.
 */
export function restrictLogPermissions(logsDir: string): string[] {
  const changed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return changed;
  }
  for (const name of names) {
    if (!/\.(log|jsonl|err|out)$/.test(name)) continue;
    const file = join(logsDir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || (st.mode & 0o077) === 0) continue;
      chmodSync(file, 0o600);
      changed.push(name);
    } catch {
      // a file that vanished or is not ours: skip
    }
  }
  return changed;
}

/** The startup failure line for daemon.err.log (SCRUB-N5): name and message only, scrubbed. */
export function startupFailureLine(err: unknown, scrub: (text: string) => string): string {
  const { name, message } = sanitizeErrorForLog(err);
  return `Failed to start Kirie daemon: ${scrub(`${name}: ${message}`)}`;
}

export const SCRUBBING_OFF_NOTICE =
  "Secret scrubbing is OFF (security.scrubbing.enabled: false). Replies, logs and stores are not scrubbed for secrets until it is turned back on and Kirie restarts.";

/**
 * Scrubbing (PLAN B.10 "scrubbing"): the stdio subprocess config, the known-value
 * route for its writes (SCRUB-N1: `/api/scrub/text`, guarded by a per-boot token
 * in the subprocess env) and the off warning.
 */
export const setupScrubbing: FeatureSetup = (ctx) => {
  ctx.kirieToolsEnv.KIRIE_SCRUB_CONFIG = JSON.stringify(freezeScrubbingConfig(daemonScrubbingConfig(ctx.config)));
  const token = randomBytes(32).toString("hex");
  ctx.kirieToolsEnv.KIRIE_SCRUB_TOKEN = token;
  ctx.internalApi.mount("scrub", createScrubApp({ scrubber: ctx.scrubber, token }));
  const enabled = ctx.scrubber.isEnabled();
  return {
    name: "scrubbing",
    async start() {
      if (!enabled) await ctx.notifyOwner(SCRUBBING_OFF_NOTICE, { key: "scrubbing-off" });
    },
  };
};
