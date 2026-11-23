/**
 * Plugin loader (PLAN C.15), rewritten.
 *
 * TRUST: a plugin is JavaScript loaded into the daemon with import(). It runs
 * with the daemon's full privileges; see PLUGIN_TRUST_STATEMENT. The checks
 * here decide WHICH code is loaded and what the host hands to it. They do not
 * confine that code.
 *
 * Loads only `<pluginsDir>/<name>/`: no npm package fallback, no absolute
 * paths, no URLs, no discovery-based loading, never an install. The loader
 * does not decide WHETHER a plugin may load (that is PluginManager: master
 * switch, owner approval, hash pin); it enforces how:
 *
 *   1. Validate the name, check the tree (integrity.ts) and hash it.
 *   2. Refuse when the hash differs from the expected (approved) one.
 *   3. Validate the manifest; requested capabilities and events must be within
 *      what the owner approved.
 *   4. Write the exact hashed bytes to a private 0700 copy and import the entry
 *      from there (so the plugin's own files that run are the ones that were
 *      hashed, and an edited plugin gets a fresh module URL; a bare import not
 *      vendored in the plugin can still resolve outside it, see docs/plugins.md).
 *   5. Call the factory, check name and version, run `setup`, all under the
 *      load timeout.
 *   6. Only then register hooks, only for events declared in the manifest.
 *      `mcpTools` and `channelAdapters` are ignored with a warning.
 *   7. Any failure: no hook stays registered, best-effort `teardown`.
 *
 * Each reload of new content leaves the old module instance in memory (Node
 * cannot unload ES modules): a small leak per reload.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookRegistry } from "../hooks/registry.js";
import type { HookEventType } from "../hooks/types.js";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import { inspectPluginTree, PluginIntegrityError, writePluginSnapshot, type PluginTreeLimits } from "./integrity.js";
import { parsePluginManifest, PluginManifestError, PLUGIN_MANIFEST_FILE } from "./manifest.js";
import {
  isValidPluginName,
  type PluginCapability,
  type PluginDefinition,
  type PluginFactory,
  type PluginHookBinding,
} from "./types.js";

const log = createModuleLogger("plugin-loader");

export const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS = 10_000;
export const DEFAULT_PLUGIN_TEARDOWN_TIMEOUT_MS = 5_000;
const MAX_HOOK_BINDINGS = 50;

export type PluginLoadErrorCode =
  | "invalid-name"
  | "integrity"
  | "hash-mismatch"
  | "manifest"
  | "not-approved-capability"
  | "import"
  | "factory"
  | "definition"
  | "setup"
  | "timeout"
  | "already-loaded";

export class PluginLoadError extends Error {
  constructor(
    readonly code: PluginLoadErrorCode,
    message: string,
    readonly detail: { sha256?: string; expectedSha256?: string } = {},
  ) {
    super(message);
    this.name = "PluginLoadError";
  }
}

export interface PluginLoaderOptions {
  /** The only directory plugins load from */
  pluginsDir: string;
  /** Where verified private copies are written (0700). Usually `<dataDir>/state/plugin-cache` */
  cacheDir: string;
  hookRegistry: HookRegistry;
  /** Import + factory + setup, together. Default 10 s */
  loadTimeoutMs?: number;
  teardownTimeoutMs?: number;
  limits?: Partial<PluginTreeLimits>;
  /** Tests only: override the owner uid check (null skips it) */
  uid?: number | null;
}

export interface LoadPluginRequest {
  name: string;
  /** The approved hash. When set, any other content is refused */
  expectedSha256?: string;
  /** The capabilities the owner approved; the manifest may not ask for more */
  approvedCapabilities?: readonly PluginCapability[];
  /** The events the owner approved; the manifest may not declare more */
  approvedEvents?: readonly HookEventType[];
  /** `plugins.config.<name>`; the plugin gets a copy */
  config?: Record<string, unknown>;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  sha256: string;
  events: HookEventType[];
  capabilities: PluginCapability[];
  hookCount: number;
  loadedAt: string;
  /** Warnings raised while loading (ignored fields) */
  warnings: string[];
  definition: PluginDefinition;
}

export class PluginLoader {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly inFlight = new Map<string, Promise<LoadedPlugin>>();
  private readonly loadTimeoutMs: number;
  private readonly teardownTimeoutMs: number;

  constructor(private readonly options: PluginLoaderOptions) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_PLUGIN_LOAD_TIMEOUT_MS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_PLUGIN_TEARDOWN_TIMEOUT_MS;
  }

  get pluginsDir(): string {
    return this.options.pluginsDir;
  }

  isLoaded(name: string): boolean {
    return this.plugins.has(name);
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Load one plugin. Loading a plugin that is already loaded with the same
   * content returns the loaded instance and registers nothing again.
   */
  async load(req: LoadPluginRequest): Promise<LoadedPlugin> {
    if (!isValidPluginName(req.name)) {
      throw new PluginLoadError("invalid-name", `"${String(req.name)}" is not a valid plugin name`);
    }
    const existing = this.plugins.get(req.name);
    if (existing) {
      if (!req.expectedSha256 || req.expectedSha256 === existing.sha256) return existing;
      throw new PluginLoadError("already-loaded", `plugin "${req.name}" is loaded with other content; reload it instead`);
    }
    const pending = this.inFlight.get(req.name);
    if (pending) return pending;
    const p = this.doLoad(req).finally(() => this.inFlight.delete(req.name));
    this.inFlight.set(req.name, p);
    return p;
  }

  /** Unregister a plugin's hooks, then run its teardown under a timeout. A hanging teardown is abandoned. */
  async unload(name: string): Promise<boolean> {
    const pending = this.inFlight.get(name);
    if (pending) await pending.catch(() => undefined);
    const loaded = this.plugins.get(name);
    if (!loaded) return false;
    this.options.hookRegistry.unregisterPlugin(name);
    this.plugins.delete(name);
    await this.teardown(name, loaded.definition);
    return true;
  }

  async unloadAll(): Promise<void> {
    for (const name of [...this.plugins.keys()].reverse()) {
      await this.unload(name);
    }
  }

  /** Unload (if loaded), then load again with the request. */
  async reload(req: LoadPluginRequest): Promise<LoadedPlugin> {
    await this.unload(req.name);
    return this.load(req);
  }

  private async doLoad(req: LoadPluginRequest): Promise<LoadedPlugin> {
    const { name } = req;
    const registry = this.options.hookRegistry;

    let snapshot;
    try {
      snapshot = inspectPluginTree(this.options.pluginsDir, name, {
        keepContents: true,
        ...(this.options.limits ? { limits: this.options.limits } : {}),
        ...(this.options.uid !== undefined ? { uid: this.options.uid } : {}),
      });
    } catch (err) {
      if (err instanceof PluginIntegrityError) throw new PluginLoadError("integrity", err.message);
      throw new PluginLoadError("integrity", `cannot inspect plugin "${name}": ${errText(err)}`);
    }

    if (req.expectedSha256 && snapshot.sha256 !== req.expectedSha256) {
      throw new PluginLoadError("hash-mismatch", `plugin "${name}" changed since it was approved`, {
        sha256: snapshot.sha256,
        expectedSha256: req.expectedSha256,
      });
    }

    const manifestEntry = snapshot.entries.find((e) => e.rel === PLUGIN_MANIFEST_FILE && e.kind === "file");
    if (!manifestEntry?.bytes) throw new PluginLoadError("manifest", `plugin "${name}" has no package.json`);
    let manifest;
    try {
      manifest = parsePluginManifest(manifestEntry.bytes, name);
    } catch (err) {
      throw new PluginLoadError("manifest", err instanceof PluginManifestError ? err.message : errText(err));
    }
    const entryFile = snapshot.entries.find((e) => e.rel === manifest.entry);
    if (!entryFile || entryFile.kind !== "file") {
      throw new PluginLoadError("manifest", `entry file ${manifest.entry} is missing or not a regular file`);
    }
    if (req.approvedCapabilities) {
      const extra = manifest.capabilities.filter((c) => c !== "hooks:observe" && !req.approvedCapabilities!.includes(c));
      if (extra.length > 0) {
        throw new PluginLoadError("not-approved-capability", `plugin "${name}" asks for capabilities that were not approved: ${extra.join(", ")}`);
      }
    }
    if (req.approvedEvents) {
      const extra = manifest.events.filter((e) => !req.approvedEvents!.includes(e));
      if (extra.length > 0) {
        throw new PluginLoadError("not-approved-capability", `plugin "${name}" declares events that were not approved: ${extra.join(", ")}`);
      }
    }

    let copyDir: string;
    try {
      copyDir = writePluginSnapshot(snapshot, this.options.cacheDir);
    } catch (err) {
      throw new PluginLoadError("integrity", `cannot prepare plugin "${name}": ${errText(err)}`);
    }
    const url = `${pathToFileURL(join(copyDir, ...manifest.entry.split("/"))).href}?v=${snapshot.sha256}`;

    const deadline = Date.now() + this.loadTimeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const config = structuredClone(req.config ?? {});

    let definition: PluginDefinition;
    try {
      const mod = (await withTimeout(import(url), remaining(), `importing plugin "${name}"`)) as { default?: unknown };
      if (typeof mod.default !== "function") {
        throw new PluginLoadError("factory", `plugin "${name}" must default-export a factory function`);
      }
      const factory = mod.default as PluginFactory;
      const def = await withTimeout(Promise.resolve().then(() => factory(config)), remaining(), `plugin "${name}" factory`);
      definition = def;
    } catch (err) {
      throw asLoadError(err, "import", name);
    }

    const warnings: string[] = [];
    let bindings: PluginHookBinding[];
    try {
      bindings = validateDefinition(definition, name, manifest.version, manifest.events, manifest.capabilities, warnings);
    } catch (err) {
      throw asLoadError(err, "definition", name);
    }
    for (const w of warnings) log.warn({ plugin: name }, w);

    let setupStarted = false;
    try {
      if (typeof definition.setup === "function") {
        setupStarted = true;
        const setup = definition.setup.bind(definition);
        await withTimeout(Promise.resolve().then(() => setup(config)), remaining(), `plugin "${name}" setup`);
      }
      for (const b of bindings) {
        registry.register(b.event, b.handler, {
          pluginName: name,
          priority: b.priority ?? 100,
          mode: b.mode ?? "observe",
        });
      }
    } catch (err) {
      registry.unregisterPlugin(name);
      if (setupStarted) await this.teardown(name, definition);
      throw asLoadError(err, "setup", name);
    }

    const loaded: LoadedPlugin = {
      name,
      version: manifest.version,
      sha256: snapshot.sha256,
      events: manifest.events,
      capabilities: manifest.capabilities,
      hookCount: bindings.length,
      loadedAt: new Date().toISOString(),
      warnings,
      definition,
    };
    this.plugins.set(name, loaded);
    log.info({ plugin: name, version: loaded.version, hooks: bindings.length }, "plugin loaded");
    return loaded;
  }

  private async teardown(name: string, def: PluginDefinition): Promise<void> {
    if (typeof def.teardown !== "function") return;
    const teardown = def.teardown.bind(def);
    try {
      await withTimeout(Promise.resolve().then(() => teardown()), this.teardownTimeoutMs, `plugin "${name}" teardown`);
    } catch (err) {
      log.warn({ plugin: name, err: scrubSecrets(errText(err), { sink: "log" }) }, "plugin teardown failed or timed out (abandoned)");
    }
  }
}

function validateDefinition(
  def: unknown,
  name: string,
  version: string,
  events: readonly HookEventType[],
  capabilities: readonly PluginCapability[],
  warnings: string[],
): PluginHookBinding[] {
  if (def === null || typeof def !== "object") {
    throw new PluginLoadError("definition", `plugin "${name}" factory did not return an object`);
  }
  const d = def as PluginDefinition;
  if (d.name !== name) {
    throw new PluginLoadError("definition", `plugin "${name}" factory returned the name "${String(d.name)}"`);
  }
  if (d.version !== version) {
    throw new PluginLoadError("definition", `plugin "${name}" factory returned version "${String(d.version)}", manifest says "${version}"`);
  }
  if (d.mcpTools !== undefined) warnings.push("mcpTools are not supported for plugins and were ignored");
  if (d.channelAdapters !== undefined) warnings.push("channelAdapters are not supported for plugins and were ignored");
  if (d.setup !== undefined && typeof d.setup !== "function") {
    throw new PluginLoadError("definition", `plugin "${name}" setup must be a function`);
  }
  if (d.teardown !== undefined && typeof d.teardown !== "function") {
    throw new PluginLoadError("definition", `plugin "${name}" teardown must be a function`);
  }
  const hooks = d.hooks ?? [];
  if (!Array.isArray(hooks)) throw new PluginLoadError("definition", `plugin "${name}" hooks must be an array`);
  if (hooks.length > MAX_HOOK_BINDINGS) {
    throw new PluginLoadError("definition", `plugin "${name}" registers more than ${MAX_HOOK_BINDINGS} hooks`);
  }
  const out: PluginHookBinding[] = [];
  for (const raw of hooks as unknown[]) {
    if (raw === null || typeof raw !== "object") {
      throw new PluginLoadError("definition", `plugin "${name}" has an invalid hook entry`);
    }
    const b = raw as PluginHookBinding;
    if (!events.includes(b.event)) {
      throw new PluginLoadError("definition", `plugin "${name}" registers a hook for "${String(b.event)}", which its manifest does not declare`);
    }
    if (typeof b.handler !== "function") {
      throw new PluginLoadError("definition", `plugin "${name}" hook for ${b.event} has no handler function`);
    }
    const mode = b.mode ?? "observe";
    if (mode !== "observe" && mode !== "transform") {
      throw new PluginLoadError("definition", `plugin "${name}" hook for ${b.event} has an unknown mode`);
    }
    if (mode === "transform") {
      if (b.event !== "beforeMessage") {
        throw new PluginLoadError("definition", `plugin "${name}": only beforeMessage hooks may transform`);
      }
      if (!capabilities.includes("hooks:transform-message")) {
        throw new PluginLoadError("definition", `plugin "${name}": a transform hook needs the hooks:transform-message capability`);
      }
    }
    const priority = typeof b.priority === "number" && Number.isFinite(b.priority) ? b.priority : 100;
    out.push({ event: b.event, handler: b.handler, priority, mode });
  }
  return out;
}

function asLoadError(err: unknown, fallback: PluginLoadErrorCode, name: string): PluginLoadError {
  if (err instanceof PluginLoadError) return err;
  if (err instanceof LoadTimeoutError) return new PluginLoadError("timeout", err.message);
  return new PluginLoadError(fallback, `plugin "${name}" ${fallback} failed: ${scrubSecrets(errText(err), { sink: "log" }).slice(0, 300)}`);
}

class LoadTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = "LoadTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LoadTimeoutError(what, ms)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
