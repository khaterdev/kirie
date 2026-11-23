import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import type { AfterMessageEvent } from "../hooks/types.js";
import { inspectPluginTree } from "./integrity.js";
import { PluginLoader, PluginLoadError, type LoadPluginRequest } from "./loader.js";
import { makePluginSandbox, recordedEvents, resetRecordedEvents, writePlugin, type PluginSandbox } from "./fixture.test-util.js";

let sb: PluginSandbox;
let registry: HookRegistry;
let loader: PluginLoader;

function makeLoader(opts: { loadTimeoutMs?: number; teardownTimeoutMs?: number } = {}): PluginLoader {
  return new PluginLoader({ pluginsDir: sb.pluginsDir, cacheDir: sb.cacheDir, hookRegistry: registry, ...opts });
}

beforeEach(() => {
  sb = makePluginSandbox();
  registry = new HookRegistry();
  loader = makeLoader();
  resetRecordedEvents();
});
afterEach(async () => {
  await loader.unloadAll();
  sb.cleanup();
});

const afterEv: AfterMessageEvent = {
  type: "afterMessage", sessionKey: "telegram:dm:1", channel: "telegram", senderId: "1", origin: "owner_message",
  responseText: "r", isError: false, durationMs: 1,
};

async function loadErr(req: LoadPluginRequest, l: PluginLoader = loader): Promise<PluginLoadError> {
  try {
    await l.load(req);
  } catch (err) {
    if (err instanceof PluginLoadError) return err;
    throw err;
  }
  throw new Error("expected load to fail");
}

describe("PluginLoader: valid plugins", () => {
  it("loads a valid plugin and registers its declared hooks", async () => {
    writePlugin(sb.pluginsDir, "good");
    const sha = inspectPluginTree(sb.pluginsDir, "good").sha256;
    const p = await loader.load({ name: "good", expectedSha256: sha });
    expect(p).toMatchObject({ name: "good", version: "1.0.0", sha256: sha, hookCount: 1, events: ["afterMessage"] });
    expect(registry.count("afterMessage")).toBe(1);
    registry.emit(afterEv);
    await registry.whenIdle();
    expect(recordedEvents().map(([n, t]) => [n, t])).toEqual([["good", "afterMessage"]]);
  });

  it("imports from the verified private copy, not from the plugins directory", async () => {
    writePlugin(sb.pluginsDir, "where", {
      code: `export default () => ({ name: "where", version: "1.0.0", hooks: [], setup() { globalThis.__kirieWhere = import.meta.url; } });`,
    });
    const p = await loader.load({ name: "where" });
    const url = (globalThis as { __kirieWhere?: string }).__kirieWhere ?? "";
    expect(url).toContain(join("state", "plugin-cache", "where", p.sha256));
  });

  it("passes a copy of the plugin's config to the factory and setup", async () => {
    writePlugin(sb.pluginsDir, "cfg", {
      code: `export default (config) => { config.mutated = true; return { name: "cfg", version: "1.0.0", setup(c) { globalThis.__kirieCfg = c; } }; };`,
    });
    const config = { slowMs: 5 };
    await loader.load({ name: "cfg", config });
    expect(config).toEqual({ slowMs: 5 });
    expect((globalThis as { __kirieCfg?: unknown }).__kirieCfg).toMatchObject({ slowMs: 5 });
  });

  it("loading twice does not double-register", async () => {
    writePlugin(sb.pluginsDir, "twice");
    const a = await loader.load({ name: "twice" });
    const b = await loader.load({ name: "twice" });
    expect(b).toBe(a);
    expect(registry.count("afterMessage")).toBe(1);
  });

  it("concurrent loads of one plugin register once", async () => {
    writePlugin(sb.pluginsDir, "conc");
    const [a, b] = await Promise.all([loader.load({ name: "conc" }), loader.load({ name: "conc" })]);
    expect(a).toBe(b);
    expect(registry.count("afterMessage")).toBe(1);
  });

  it("reload after editing runs the new code, including nested modules", async () => {
    const dir = writePlugin(sb.pluginsDir, "edit", {
      files: { "lib/v.js": "export const v = 'one';\n" },
      code: `import { v } from "./lib/v.js";
export default () => ({ name: "edit", version: "1.0.0", hooks: [], setup() { globalThis.__kirieEdit = v; } });`,
    });
    await loader.load({ name: "edit" });
    expect((globalThis as { __kirieEdit?: string }).__kirieEdit).toBe("one");
    writeFileSync(join(dir, "lib/v.js"), "export const v = 'two';\n");
    const p2 = await loader.reload({ name: "edit" });
    expect((globalThis as { __kirieEdit?: string }).__kirieEdit).toBe("two");
    expect(p2.sha256).toBe(inspectPluginTree(sb.pluginsDir, "edit").sha256);
  });

  it("ignores mcpTools and channelAdapters with a warning", async () => {
    writePlugin(sb.pluginsDir, "extras", {
      code: `export default () => ({ name: "extras", version: "1.0.0", mcpTools: [{ name: "x" }], channelAdapters: { fake: () => ({}) }, hooks: [] });`,
    });
    const p = await loader.load({ name: "extras" });
    expect(p.warnings).toEqual([
      "mcpTools are not supported for plugins and were ignored",
      "channelAdapters are not supported for plugins and were ignored",
    ]);
    expect(registry.count()).toBe(0);
  });

  it("a transform hook loads only with the capability", async () => {
    const code = (name: string) => `export default () => ({ name: "${name}", version: "1.0.0", hooks: [{ event: "beforeMessage", mode: "transform", handler: (e) => ({ text: e.text + "!" }) }] });`;
    writePlugin(sb.pluginsDir, "tx-ok", { events: ["beforeMessage"], capabilities: ["hooks:transform-message"], code: code("tx-ok") });
    await loader.load({ name: "tx-ok", approvedCapabilities: ["hooks:observe", "hooks:transform-message"] });
    expect(registry.hasSubscribers("beforeMessage", "transform")).toBe(true);

    writePlugin(sb.pluginsDir, "tx-no", { events: ["beforeMessage"], code: code("tx-no") });
    const err = await loadErr({ name: "tx-no" });
    expect(err.code).toBe("definition");
    expect(err.message).toMatch(/transform-message capability/);
  });
});

describe("PluginLoader: where code may come from", () => {
  it.each(["../x", "/abs/path", "a/b", "Upper", "", "..", "x/../y"])("rejects the name %j", async (name) => {
    expect((await loadErr({ name })).code).toBe("invalid-name");
  });

  it("a name that is not a directory in the plugins dir is an error; there is no npm fallback", async () => {
    // "vitest" is resolvable from here as a package; the loader must not import it.
    const err = await loadErr({ name: "vitest" });
    expect(err.code).toBe("integrity");
    expect(err.message).toMatch(/does not exist/);
    expect(loader.isLoaded("vitest")).toBe(false);
  });

  it("rejects a symlinked entry pointing outside", async () => {
    const dir = writePlugin(sb.pluginsDir, "sym");
    writeFileSync(join(sb.dataDir, "outside.js"), "export default () => ({ name: 'sym', version: '1.0.0' });");
    const entry = join(dir, "index.js");
    // Replace the entry with a link out of the tree.
    rmSync(entry);
    symlinkSync(join(sb.dataDir, "outside.js"), entry);
    expect((await loadErr({ name: "sym" })).code).toBe("integrity");
  });

  it("rejects a group-writable plugin directory", async () => {
    const dir = writePlugin(sb.pluginsDir, "gw");
    chmodSync(dir, 0o775);
    expect((await loadErr({ name: "gw" })).code).toBe("integrity");
  });

  it("refuses content that differs from the expected hash and registers nothing", async () => {
    writePlugin(sb.pluginsDir, "pinned");
    const err = await loadErr({ name: "pinned", expectedSha256: "0".repeat(64) });
    expect(err.code).toBe("hash-mismatch");
    expect(err.detail.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.count()).toBe(0);
    expect(recordedEvents()).toEqual([]);
  });
});

describe("PluginLoader: manifest and definition checks", () => {
  it("missing manifest", async () => {
    const dir = writePlugin(sb.pluginsDir, "nomani");
    rmSync(join(dir, "package.json"));
    expect((await loadErr({ name: "nomani" })).code).toBe("manifest");
  });

  it("missing kirie.events", async () => {
    writePlugin(sb.pluginsDir, "noevents", { manifest: { name: "noevents", version: "1.0.0", kirie: {} } });
    expect((await loadErr({ name: "noevents" })).code).toBe("manifest");
  });

  it("directory name and manifest name mismatch", async () => {
    writePlugin(sb.pluginsDir, "dirname", { manifest: { name: "other", version: "1.0.0", kirie: { events: ["afterMessage"] } } });
    const err = await loadErr({ name: "dirname" });
    expect(err.code).toBe("manifest");
    expect(err.message).toMatch(/does not match/);
  });

  it("factory name mismatch (a plugin cannot claim another's name)", async () => {
    writePlugin(sb.pluginsDir, "claimer", { factoryName: "good" });
    const err = await loadErr({ name: "claimer" });
    expect(err.code).toBe("definition");
    expect(registry.count()).toBe(0);
  });

  it("factory version mismatch", async () => {
    writePlugin(sb.pluginsDir, "ver", { code: `export default () => ({ name: "ver", version: "9.9.9" });` });
    expect((await loadErr({ name: "ver" })).code).toBe("definition");
  });

  it("a hook for an undeclared event rejects the plugin", async () => {
    writePlugin(sb.pluginsDir, "undeclared", {
      events: ["afterMessage"],
      code: `export default () => ({ name: "undeclared", version: "1.0.0", hooks: [
        { event: "afterMessage", handler() {} }, { event: "beforeToolUse", handler() {} }] });`,
    });
    const err = await loadErr({ name: "undeclared" });
    expect(err.code).toBe("definition");
    expect(err.message).toMatch(/does not declare/);
    expect(registry.count()).toBe(0);
  });

  it("requested capabilities and events must be within the approval", async () => {
    writePlugin(sb.pluginsDir, "caps", { events: ["beforeMessage"], capabilities: ["hooks:transform-message"] });
    expect((await loadErr({ name: "caps", approvedCapabilities: ["hooks:observe"] })).code).toBe("not-approved-capability");
    writePlugin(sb.pluginsDir, "evs", { events: ["afterMessage", "onError"] });
    expect((await loadErr({ name: "evs", approvedEvents: ["afterMessage"] })).code).toBe("not-approved-capability");
  });

  it("a default export that is not a function", async () => {
    writePlugin(sb.pluginsDir, "nofn", { code: `export default { name: "nofn" };` });
    expect((await loadErr({ name: "nofn" })).code).toBe("factory");
  });

  it("an entry that throws at import", async () => {
    writePlugin(sb.pluginsDir, "throws", { code: `throw new Error("at import");` });
    const err = await loadErr({ name: "throws" });
    expect(err.code).toBe("import");
    expect(err.message).toMatch(/at import/);
  });
});

describe("PluginLoader: setup, timeouts, teardown", () => {
  it("setup throws: no hooks remain registered and teardown is attempted", async () => {
    writePlugin(sb.pluginsDir, "badsetup", {
      code: `export default () => ({ name: "badsetup", version: "1.0.0",
        hooks: [{ event: "afterMessage", handler() {} }],
        setup() { throw new Error("setup failed"); },
        teardown() { globalThis.__kirieTorn = true; } });`,
    });
    const err = await loadErr({ name: "badsetup" });
    expect(err.code).toBe("setup");
    expect(registry.count()).toBe(0);
    expect(loader.isLoaded("badsetup")).toBe(false);
    expect((globalThis as { __kirieTorn?: boolean }).__kirieTorn).toBe(true);
  });

  it("setup hangs: the load times out and nothing is registered", async () => {
    const l = makeLoader({ loadTimeoutMs: 200 });
    writePlugin(sb.pluginsDir, "hangsetup", {
      code: `export default () => ({ name: "hangsetup", version: "1.0.0", hooks: [{ event: "afterMessage", handler() {} }], setup: () => new Promise(() => {}) });`,
    });
    const t0 = Date.now();
    const err = await loadErr({ name: "hangsetup" }, l);
    expect(err.code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(registry.count()).toBe(0);
  });

  it("an import that never finishes times out", async () => {
    const l = makeLoader({ loadTimeoutMs: 200 });
    writePlugin(sb.pluginsDir, "hangimport", { code: `await new Promise(() => {});\nexport default () => ({});` });
    expect((await loadErr({ name: "hangimport" }, l)).code).toBe("timeout");
  });

  it("a hanging teardown is abandoned and unload completes", async () => {
    const l = makeLoader({ teardownTimeoutMs: 100 });
    writePlugin(sb.pluginsDir, "hangtear", {
      code: `export default () => ({ name: "hangtear", version: "1.0.0", hooks: [{ event: "afterMessage", handler() {} }], teardown: () => new Promise(() => {}) });`,
    });
    await l.load({ name: "hangtear" });
    expect(registry.count()).toBe(1);
    const t0 = Date.now();
    expect(await l.unload("hangtear")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(registry.count()).toBe(0);
    expect(l.isLoaded("hangtear")).toBe(false);
  });

  it("unload of an unknown plugin is false", async () => {
    expect(await loader.unload("nobody")).toBe(false);
  });
});
