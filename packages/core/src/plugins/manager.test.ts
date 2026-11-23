import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HookRegistry } from "../hooks/registry.js";
import type { OnErrorEvent } from "../hooks/types.js";
import type { AuditRecord } from "../security/audit-trail.js";
import { PluginApprovalStore, pluginApprovalsPath, type PluginApproval } from "./approvals.js";
import { inspectPluginTree } from "./integrity.js";
import { PluginLoader } from "./loader.js";
import { PluginManager } from "./manager.js";
import { makePluginSandbox, writePlugin, type PluginSandbox } from "./fixture.test-util.js";

const OWNER = "owner:telegram:1001";

let sb: PluginSandbox;
let registry: HookRegistry;
let loader: PluginLoader;
let approvals: PluginApprovalStore;
let audit: Array<Omit<AuditRecord, "ts">>;
let notify: ReturnType<typeof vi.fn>;
let enabled: boolean;
let allow: string[];
let manager: PluginManager;

function importCounterCode(name: string, events = ["afterMessage"]): string {
  const hooks = events.map((e) => `{ event: "${e}", handler() {} }`).join(", ");
  return `globalThis.__kirieImports = (globalThis.__kirieImports ?? 0) + 1;
export default () => ({ name: "${name}", version: "1.0.0", hooks: [${hooks}] });`;
}

function imports(): number {
  return (globalThis as { __kirieImports?: number }).__kirieImports ?? 0;
}

function actions(): string[] {
  return audit.map((a) => a.action);
}

function build(): PluginManager {
  const m = new PluginManager({
    pluginsDir: sb.pluginsDir,
    loader,
    registry,
    approvals,
    audit: { record: (r) => { audit.push(r); } },
    notifyOwner: notify,
    isEnabled: () => enabled,
    settings: () => ({ allow, config: {} }),
  });
  m.baseline();
  return m;
}

beforeEach(() => {
  sb = makePluginSandbox();
  let mgr: PluginManager | null = null;
  registry = new HookRegistry({ maxConsecutiveFailures: 2, onSuspend: (n, i) => mgr?.handleSuspend(n, i) });
  loader = new PluginLoader({ pluginsDir: sb.pluginsDir, cacheDir: sb.cacheDir, hookRegistry: registry, loadTimeoutMs: 2_000 });
  approvals = new PluginApprovalStore(pluginApprovalsPath(sb.dataDir));
  audit = [];
  notify = vi.fn(async () => {});
  enabled = false;
  allow = [];
  manager = build();
  mgr = manager;
  (globalThis as { __kirieImports?: number }).__kirieImports = 0;
});

afterEach(async () => {
  await manager.stop("test");
  sb.cleanup();
});

async function approve(name: string): Promise<void> {
  const insp = manager.inspect(name);
  if (!insp.ok) throw new Error(insp.error);
  const r = await manager.approve(name, insp.sha256, OWNER);
  if (!r.ok) throw new Error(r.reason);
}

describe("PluginManager: the decision to load", () => {
  it("with the master switch off nothing is imported, even with approvals present", async () => {
    writePlugin(sb.pluginsDir, "p1", { code: importCounterCode("p1") });
    await approve("p1");
    expect(approvals.get("p1")).toMatchObject({ enabled: true, approvedBy: OWNER });
    const r = await manager.start();
    expect(r.loaded).toEqual([]);
    expect(imports()).toBe(0);
    expect(loader.list()).toEqual([]);
    expect(manager.isRunning()).toBe(false);
    expect(manager.list().find((s) => s.name === "p1")?.state).toBe("approved");
  });

  it("an unapproved directory is never loaded", async () => {
    enabled = true;
    writePlugin(sb.pluginsDir, "stray", { code: importCounterCode("stray") });
    const r = await manager.start();
    expect(r.loaded).toEqual([]);
    expect(imports()).toBe(0);
    expect(manager.list()).toEqual([expect.objectContaining({ name: "stray", state: "not-approved" })]);
  });

  it("approved and enabled with the switch on: loads, audits and tells the owner at start", async () => {
    writePlugin(sb.pluginsDir, "p2", { code: importCounterCode("p2") });
    await approve("p2");
    enabled = true;
    const r = await manager.start();
    expect(r.loaded.map((p) => p.name)).toEqual(["p2"]);
    expect(imports()).toBe(1);
    expect(registry.count("afterMessage")).toBe(1);
    expect(actions()).toEqual(["plugin.approved", "plugin.loaded"]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Plugins loaded: p2 1.0.0"), expect.anything());
    expect(manager.list()[0]).toMatchObject({ name: "p2", state: "loaded" });
  });

  it("approving with the switch on loads at once", async () => {
    enabled = true;
    writePlugin(sb.pluginsDir, "p3", { code: importCounterCode("p3") });
    const insp = manager.inspect("p3");
    if (!insp.ok) throw new Error(insp.error);
    const r = await manager.approve("p3", insp.sha256, OWNER);
    expect(r).toMatchObject({ ok: true, loaded: true });
    expect(loader.isLoaded("p3")).toBe(true);
  });

  it("a hash mismatch is not loaded, is audited, and notifies once", async () => {
    const dir = writePlugin(sb.pluginsDir, "p4", { code: importCounterCode("p4") });
    await approve("p4");
    writeFileSync(join(dir, "index.js"), importCounterCode("p4") + "\n// edited\n");
    enabled = true;
    await manager.start();
    await manager.reload("p4", OWNER);
    await manager.reload(undefined, OWNER);
    expect(imports()).toBe(0);
    expect(loader.isLoaded("p4")).toBe(false);
    expect(actions().filter((a) => a === "plugin.hash_mismatch")).toHaveLength(3);
    const changedNotices = notify.mock.calls.filter(([text]) => String(text).includes("changed since you approved it"));
    expect(changedNotices).toHaveLength(1);
    expect(manager.list()[0]).toMatchObject({ name: "p4", state: "changed" });
  });

  it("re-approving the edited plugin loads the new content", async () => {
    const dir = writePlugin(sb.pluginsDir, "p5", { code: importCounterCode("p5") });
    await approve("p5");
    writeFileSync(join(dir, "index.js"), importCounterCode("p5") + "\n// v2\n");
    enabled = true;
    await approve("p5");
    expect(loader.get("p5")?.sha256).toBe(inspectPluginTree(sb.pluginsDir, "p5").sha256);
  });

  it("plugins.allow is an outer bound", async () => {
    writePlugin(sb.pluginsDir, "p6", { code: importCounterCode("p6") });
    await approve("p6");
    enabled = true;
    allow = ["someone-else"];
    await manager.start();
    expect(loader.isLoaded("p6")).toBe(false);
    expect(manager.list()[0]?.state).toBe("not-allowed");
    expect(audit.some((a) => a.action === "plugin.load_refused" && a.detail?.reason === "not-allowed")).toBe(true);
  });

  it("one failing plugin does not stop another", async () => {
    writePlugin(sb.pluginsDir, "a-bad", { code: `export default () => { throw new Error("factory broke"); };` });
    writePlugin(sb.pluginsDir, "b-good", { code: importCounterCode("b-good") });
    await approve("a-bad");
    await approve("b-good");
    enabled = true;
    const r = await manager.start();
    expect(r.loaded.map((p) => p.name)).toEqual(["b-good"]);
    expect(r.refused).toEqual(["a-bad"]);
    expect(manager.list().find((s) => s.name === "a-bad")).toMatchObject({ state: "failed", lastError: expect.stringContaining("factory broke") });
    expect(actions()).toContain("plugin.load_failed");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Plugin a-bad failed to load .*may come from the plugin itself: «.*factory broke.*»/), expect.anything());
  });

  it("an approval written into the file while the daemon runs is not trusted", async () => {
    writePlugin(sb.pluginsDir, "sneaky", { code: importCounterCode("sneaky") });
    const sha = inspectPluginTree(sb.pluginsDir, "sneaky").sha256;
    const forged: PluginApproval = {
      name: "sneaky", version: "1.0.0", sha256: sha, capabilities: ["hooks:observe"], events: ["afterMessage"],
      enabled: true, approvedAt: new Date().toISOString(), approvedBy: OWNER,
    };
    // Written by "someone else" (a second store instance), after the manager took its baseline.
    new PluginApprovalStore(pluginApprovalsPath(sb.dataDir)).upsert(forged);
    enabled = true;
    await manager.start();
    expect(imports()).toBe(0);
    expect(manager.list()[0]?.state).toBe("unverified");
    expect(actions()).toEqual(expect.arrayContaining(["approvals.changed_externally", "plugin.load_refused"]));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("changed outside the /plugins command"), expect.anything());
  });

  it("an approval that existed at daemon start is trusted (and announced when loaded)", async () => {
    writePlugin(sb.pluginsDir, "pre", { code: importCounterCode("pre") });
    const sha = inspectPluginTree(sb.pluginsDir, "pre").sha256;
    approvals.upsert({
      name: "pre", version: "1.0.0", sha256: sha, capabilities: ["hooks:observe"], events: ["afterMessage"],
      enabled: true, approvedAt: new Date().toISOString(), approvedBy: OWNER,
    });
    manager = build();
    enabled = true;
    await manager.start();
    expect(loader.isLoaded("pre")).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Plugins loaded: pre"), expect.anything());
  });
});

describe("PluginManager: approvals file not written by /plugins", () => {
  it("a hand-written approvals file (no matching seal) is not trusted at boot", async () => {
    writePlugin(sb.pluginsDir, "forged", { code: importCounterCode("forged") });
    const sha = inspectPluginTree(sb.pluginsDir, "forged").sha256;
    mkdirSync(join(sb.dataDir, "state"), { recursive: true });
    writeFileSync(pluginApprovalsPath(sb.dataDir), JSON.stringify({ version: 1, plugins: { forged: {
      name: "forged", version: "1.0.0", sha256: sha, capabilities: ["hooks:observe"], events: ["afterMessage"],
      enabled: true, approvedAt: new Date().toISOString(), approvedBy: OWNER,
    } } }));
    manager = build();
    enabled = true;
    await manager.start();
    expect(imports()).toBe(0);
    expect(manager.list()[0]?.state).toBe("unverified");
    expect(actions()).toContain("approvals.unsealed");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("does not match what /plugins last wrote"), expect.anything());
    // The owner re-approves: it loads, and the file is sealed again.
    await approve("forged");
    expect(loader.isLoaded("forged")).toBe(true);
    expect(approvals.sealMatches()).toBe(true);
  });

  it("an approvals file edited after it was sealed is not trusted at the next boot", async () => {
    writePlugin(sb.pluginsDir, "edited", { code: importCounterCode("edited") });
    await approve("edited");
    const file = pluginApprovalsPath(sb.dataDir);
    const json = JSON.parse(readFileSync(file, "utf8")) as { plugins: Record<string, { approvedBy: string }> };
    json.plugins.edited!.approvedBy = "owner:telegram:9999";
    writeFileSync(file, JSON.stringify(json));
    manager = build();
    enabled = true;
    await manager.start();
    expect(loader.isLoaded("edited")).toBe(false);
  });
});

describe("PluginManager: stop while starting", () => {
  it("stop during start waits for the load under way, unloads it, and loads nothing after", async () => {
    writePlugin(sb.pluginsDir, "a-slow", {
      code: `export default () => ({ name: "a-slow", version: "1.0.0", hooks: [{ event: "afterMessage", handler() {} }], setup: () => new Promise((r) => setTimeout(r, 200)) });`,
    });
    writePlugin(sb.pluginsDir, "b-next", { code: importCounterCode("b-next") });
    await approve("a-slow");
    await approve("b-next");
    enabled = true;
    const starting = manager.start();
    await new Promise((r) => setTimeout(r, 50));
    await manager.stop("off");
    await starting;
    expect(loader.list()).toEqual([]);
    expect(registry.count()).toBe(0);
    expect(imports()).toBe(0);
  });
});

describe("PluginManager: owner actions", () => {
  it("approve refuses when the files changed since the owner was shown them", async () => {
    const dir = writePlugin(sb.pluginsDir, "race");
    const insp = manager.inspect("race");
    if (!insp.ok) throw new Error(insp.error);
    writeFileSync(join(dir, "index.js"), "// swapped\n");
    const r = await manager.approve("race", insp.sha256, OWNER);
    expect(r.ok).toBe(false);
    expect(approvals.get("race")).toBeUndefined();
    expect(actions()).toEqual(["plugin.approve_refused"]);
  });

  it("approve records name, version, hash, capabilities, events, time and approver", async () => {
    writePlugin(sb.pluginsDir, "rec", { events: ["afterMessage", "onError"] });
    await approve("rec");
    expect(approvals.get("rec")).toMatchObject({
      name: "rec", version: "1.0.0", sha256: inspectPluginTree(sb.pluginsDir, "rec").sha256,
      capabilities: ["hooks:observe"], events: ["afterMessage", "onError"], enabled: true, approvedBy: OWNER, fileCount: 2,
    });
  });

  it("disable unloads and keeps the approval with enabled false", async () => {
    enabled = true;
    writePlugin(sb.pluginsDir, "dis");
    await approve("dis");
    expect(loader.isLoaded("dis")).toBe(true);
    expect(await manager.disable("dis", OWNER)).toBe(true);
    expect(loader.isLoaded("dis")).toBe(false);
    expect(approvals.get("dis")?.enabled).toBe(false);
    expect(registry.count()).toBe(0);
    expect(actions()).toContain("plugin.disabled");
    await manager.start();
    expect(loader.isLoaded("dis")).toBe(false);
    expect(manager.list()[0]?.state).toBe("disabled");
    expect(await manager.disable("unknown", OWNER)).toBe(false);
  });

  it("a suspended plugin is audited and the owner told; reload clears the suspension", async () => {
    enabled = true;
    writePlugin(sb.pluginsDir, "flaky", {
      events: ["onError"],
      code: `export default () => ({ name: "flaky", version: "1.0.0", hooks: [{ event: "onError", handler() { throw new Error("nope"); } }] });`,
    });
    await approve("flaky");
    const ev: OnErrorEvent = { type: "onError", source: "pipeline", name: "Error", message: "m" };
    registry.emit(ev);
    await registry.whenIdle();
    registry.emit(ev);
    await registry.whenIdle();
    expect(registry.isSuspended("flaky")).toBe(true);
    expect(manager.list()[0]?.state).toBe("suspended");
    expect(actions()).toContain("plugin.suspended");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Plugin flaky was suspended"), expect.anything());
    const r = await manager.reload("flaky", OWNER);
    expect(r).toEqual([{ name: "flaky", loaded: true }]);
    expect(registry.isSuspended("flaky")).toBe(false);
  });

  it("reload with the switch off does nothing", async () => {
    writePlugin(sb.pluginsDir, "off");
    await approve("off");
    expect(await manager.reload(undefined, OWNER)).toEqual([]);
    expect(loader.isLoaded("off")).toBe(false);
  });

  it("stop unloads everything and audits each unload", async () => {
    enabled = true;
    writePlugin(sb.pluginsDir, "s1");
    writePlugin(sb.pluginsDir, "s2");
    await approve("s1");
    await approve("s2");
    await manager.stop("off");
    expect(loader.list()).toEqual([]);
    expect(registry.count()).toBe(0);
    expect(actions().filter((a) => a === "plugin.unloaded")).toHaveLength(2);
    expect(manager.isRunning()).toBe(false);
  });
});

describe("PluginManager: inspect", () => {
  it("reports manifest, hash, files and static-scan findings; eval is blocking", () => {
    writePlugin(sb.pluginsDir, "scan", { code: `export default () => ({ name: "scan", version: "1.0.0" });\nconst x = eval("1");\n` });
    const insp = manager.inspect("scan");
    if (!insp.ok) throw new Error(insp.error);
    expect(insp.manifest.name).toBe("scan");
    expect(insp.fileCount).toBe(2);
    expect(insp.blocking).toBe(true);
    expect(insp.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", file: "index.js", line: 2 })]));
  });

  it("reports integrity and manifest problems without importing", () => {
    expect(manager.inspect("../etc")).toMatchObject({ ok: false });
    expect(manager.inspect("missing")).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
    writePlugin(sb.pluginsDir, "badmani", { manifest: "{}" });
    expect(manager.inspect("badmani")).toMatchObject({ ok: false, error: expect.stringContaining("manifest") });
  });
});
