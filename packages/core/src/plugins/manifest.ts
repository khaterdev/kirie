/**
 * Plugin manifest: the plugin's package.json (PLAN C.15).
 *
 * {
 *   "name": "reply-timer", "version": "1.0.0", "type": "module",
 *   "kirie": { "entry": "index.js", "events": ["afterMessage"], "capabilities": ["hooks:observe"] }
 * }
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import { HOOK_EVENT_TYPES, type HookEventType } from "../hooks/types.js";
import { PLUGIN_CAPABILITIES, isValidPluginName, type PluginCapability, type PluginManifest } from "./types.js";

export const PLUGIN_MANIFEST_FILE = "package.json";
const MAX_MANIFEST_BYTES = 64 * 1024;

const EntrySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[a-zA-Z]:/.test(p), "entry must be a relative path")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "entry must stay inside the plugin directory")
  .refine((p) => /\.(m?js)$/.test(p), "entry must be a .js or .mjs file")
  .refine((p) => !/[?#\0]/.test(p), "entry must be a plain file path");

const KirieBlockSchema = z.object({
  entry: EntrySchema.default("index.js"),
  events: z.array(z.enum(HOOK_EVENT_TYPES as [HookEventType, ...HookEventType[]])).min(1).max(HOOK_EVENT_TYPES.length),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES as [PluginCapability, ...PluginCapability[]])).max(8).default(["hooks:observe"]),
  description: z.string().max(500).optional(),
});

const PackageJsonSchema = z.object({
  name: z.string(),
  version: z.string().min(1).max(64).regex(/^[0-9A-Za-z.+-]+$/, "version must be a plain semver-like string"),
  kirie: KirieBlockSchema,
});

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

/**
 * Validate the raw text of a plugin's package.json. `expectedName` is the
 * directory name: the manifest name must equal it.
 */
export function parsePluginManifest(raw: string | Buffer, expectedName: string): PluginManifest {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    throw new PluginManifestError("package.json is larger than 64 KB");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PluginManifestError("package.json is not valid JSON");
  }
  const parsed = PackageJsonSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "package.json";
    throw new PluginManifestError(`invalid manifest at ${where}: ${issue?.message ?? "invalid"}`);
  }
  const { name, version, kirie } = parsed.data;
  if (!isValidPluginName(name)) {
    throw new PluginManifestError(`manifest name "${name}" is not a valid plugin name`);
  }
  if (name !== expectedName) {
    throw new PluginManifestError(`manifest name "${name}" does not match the directory name "${expectedName}"`);
  }
  const events = [...new Set(kirie.events)];
  const capabilities = [...new Set<PluginCapability>(["hooks:observe", ...kirie.capabilities])];
  if (capabilities.includes("hooks:transform-message") && !events.includes("beforeMessage")) {
    throw new PluginManifestError("hooks:transform-message needs beforeMessage in kirie.events");
  }
  return {
    name,
    version,
    entry: kirie.entry.replace(/^\.\//, ""),
    events,
    capabilities,
    ...(kirie.description ? { description: kirie.description } : {}),
  };
}

/**
 * Read a plugin's manifest for display only (lists, the read-only tool). No
 * integrity checks, never imports. Throws PluginManifestError when it is
 * missing, not a regular file, too large or invalid.
 */
export function peekPluginManifest(pluginsDir: string, name: string): PluginManifest {
  const file = join(pluginsDir, name, PLUGIN_MANIFEST_FILE);
  let size: number;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new PluginManifestError("package.json is not a regular file");
    size = st.size;
  } catch (err) {
    if (err instanceof PluginManifestError) throw err;
    throw new PluginManifestError("no package.json");
  }
  if (size > MAX_MANIFEST_BYTES) throw new PluginManifestError("package.json is larger than 64 KB");
  return parsePluginManifest(readFileSync(file), name);
}
