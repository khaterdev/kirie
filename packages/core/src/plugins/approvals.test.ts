import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginApprovalStore, pluginApprovalsPath, type PluginApproval } from "./approvals.js";

let dataDir: string;
let file: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kirie-approvals-test-"));
  file = pluginApprovalsPath(dataDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function rec(over: Partial<PluginApproval> = {}): PluginApproval {
  return {
    name: "demo", version: "1.0.0", sha256: "a".repeat(64), capabilities: ["hooks:observe"], events: ["afterMessage"],
    enabled: true, approvedAt: "2026-11-23T00:00:00.000Z", approvedBy: "owner:telegram:1001", fileCount: 2, ...over,
  };
}

describe("PluginApprovalStore", () => {
  it("lives at <dataDir>/state/plugin-approvals.json", () => {
    expect(file).toBe(join(dataDir, "state", "plugin-approvals.json"));
  });

  it("a missing file is empty", () => {
    expect(new PluginApprovalStore(file).list()).toEqual([]);
  });

  it("writes atomically with 0600 file and 0700 directory, leaving no temp files", () => {
    const store = new PluginApprovalStore(file);
    store.upsert(rec());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "state")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dataDir, "state")).sort()).toEqual(["plugin-approvals.json", "plugin-approvals.json.seal"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, plugins: { demo: { sha256: "a".repeat(64) } } });
    expect(new PluginApprovalStore(file).get("demo")).toEqual(rec());
  });

  it("setEnabled keeps the approval; remove drops it", () => {
    const store = new PluginApprovalStore(file);
    store.upsert(rec());
    expect(store.setEnabled("demo", false)).toBe(true);
    expect(store.get("demo")).toMatchObject({ enabled: false, sha256: "a".repeat(64) });
    expect(store.setEnabled("nope", true)).toBe(false);
    expect(store.remove("demo")).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("rejects an invalid record on write", () => {
    const store = new PluginApprovalStore(file);
    expect(() => store.upsert(rec({ sha256: "short" }))).toThrow();
    expect(() => store.upsert(rec({ name: "../x" }))).toThrow();
  });

  it("a corrupt file reads as empty, and is preserved before the next write", () => {
    mkdirSync(join(dataDir, "state"), { recursive: true });
    writeFileSync(file, "{ not json");
    const store = new PluginApprovalStore(file);
    expect(store.list()).toEqual([]);
    store.upsert(rec());
    const names = readdirSync(join(dataDir, "state"));
    expect(names.some((n) => n.startsWith("plugin-approvals.json.corrupt-"))).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("skips invalid records and records filed under another key", () => {
    mkdirSync(join(dataDir, "state"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, plugins: { demo: rec(), other: rec(), bad: { name: "bad" } } }));
    expect(new PluginApprovalStore(file).list().map((r) => r.name)).toEqual(["demo"]);
  });

  it("every write seals the file; an outside edit or a missing seal breaks the seal", () => {
    const store = new PluginApprovalStore(file);
    expect(store.sealMatches()).toBe(true); // no file yet
    store.upsert(rec());
    expect(statSync(store.sealPath).mode & 0o777).toBe(0o600);
    expect(store.sealMatches()).toBe(true);
    writeFileSync(file, readFileSync(file, "utf8").replace("owner:telegram:1001", "owner:telegram:9"));
    expect(store.sealMatches()).toBe(false);
    store.setEnabled("demo", true);
    expect(store.sealMatches()).toBe(true);
    rmSync(store.sealPath);
    expect(store.sealMatches()).toBe(false);
  });

  it("changedSinceLastSeen: baseline first, then detects outside edits but not its own writes", () => {
    const store = new PluginApprovalStore(file);
    expect(store.changedSinceLastSeen()).toBe(false);
    store.upsert(rec());
    expect(store.changedSinceLastSeen()).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, plugins: { demo: rec({ sha256: "b".repeat(64) }) } }));
    expect(store.changedSinceLastSeen()).toBe(true);
    expect(store.changedSinceLastSeen()).toBe(false);
  });
});
