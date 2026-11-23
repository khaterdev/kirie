/**
 * Test-only helpers: plugin fixtures in temp directories. Never touches ~/.kirie.
 * Not exported from the package and not bundled.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface PluginSandbox {
  /** Temp data dir (stands in for ~/.kirie) */
  dataDir: string;
  /** <dataDir>/plugins */
  pluginsDir: string;
  /** <dataDir>/state/plugin-cache */
  cacheDir: string;
  cleanup(): void;
}

export function makePluginSandbox(): PluginSandbox {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "kirie-plugins-test-")));
  const pluginsDir = join(dataDir, "plugins");
  mkdirSync(pluginsDir, { mode: 0o700 });
  return {
    dataDir,
    pluginsDir,
    cacheDir: join(dataDir, "state", "plugin-cache"),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

export interface FixtureOptions {
  version?: string;
  events?: string[];
  capabilities?: string[];
  entry?: string;
  /** Full entry source; default: a factory that records events on globalThis.__kiriePluginEvents */
  code?: string;
  /** Replace the whole package.json (object or raw text) */
  manifest?: unknown;
  /** Extra files, relative path to content */
  files?: Record<string, string>;
  /** Name the factory returns (default: the plugin name) */
  factoryName?: string;
}

/** Events recorded by default fixtures: [pluginName, eventType, payload] */
export function recordedEvents(): Array<[string, string, unknown]> {
  const g = globalThis as { __kiriePluginEvents?: Array<[string, string, unknown]> };
  g.__kiriePluginEvents ??= [];
  return g.__kiriePluginEvents;
}

export function resetRecordedEvents(): void {
  (globalThis as { __kiriePluginEvents?: unknown[] }).__kiriePluginEvents = [];
}

export function defaultPluginCode(name: string, version: string, events: string[], factoryName = name): string {
  const hooks = events
    .map((ev) => `{ event: ${JSON.stringify(ev)}, handler(e) { (globalThis.__kiriePluginEvents ??= []).push([${JSON.stringify(name)}, e.type, e]); } }`)
    .join(",\n      ");
  return `export default function factory(config) {
  return {
    name: ${JSON.stringify(factoryName)},
    version: ${JSON.stringify(version)},
    hooks: [
      ${hooks}
    ],
  };
}
`;
}

export function writePlugin(pluginsDir: string, name: string, opts: FixtureOptions = {}): string {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const version = opts.version ?? "1.0.0";
  const events = opts.events ?? ["afterMessage"];
  const entry = opts.entry ?? "index.js";
  const manifest = opts.manifest ?? {
    name,
    version,
    type: "module",
    kirie: { entry, events, capabilities: opts.capabilities ?? ["hooks:observe"] },
  };
  writeFileSync(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2), { mode: 0o644 });
  writeFileSync(join(dir, entry), opts.code ?? defaultPluginCode(name, version, events, opts.factoryName), { mode: 0o644 });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
    writeFileSync(p, content, { mode: 0o644 });
  }
  return dir;
}
