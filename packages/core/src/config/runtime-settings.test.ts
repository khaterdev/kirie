import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import { AuditTrail } from "../security/audit-trail.js";
import { RuntimeSettings } from "./runtime-settings.js";

const BY = "owner:telegram:1001";
const mode = z.enum(["yolo", "ask", "strict"]);

describe("RuntimeSettings", () => {
  let dir: string;
  let file: string;
  let audit: AuditTrail;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-settings-test-"));
    file = join(dir, "state", "runtime-settings.json");
    audit = new AuditTrail(join(dir, "logs", "audit.jsonl"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file does not exist, without creating it", () => {
    const s = new RuntimeSettings(file);
    expect(s.get("approvals.mode", mode)).toBeUndefined();
    expect(s.keys()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("sets, persists and reloads values", () => {
    const s = new RuntimeSettings(file, { audit });
    s.set("approvals.mode", "ask", BY);
    s.set("goals.enabled", true, BY);
    expect(s.get("approvals.mode", mode)).toBe("ask");
    const reopened = new RuntimeSettings(file);
    expect(reopened.get("approvals.mode", mode)).toBe("ask");
    expect(reopened.get("goals.enabled", z.boolean())).toBe(true);
    expect(reopened.describe("approvals.mode")).toMatchObject({ setBy: BY });
  });

  it("writes the file 0600 in a 0700 directory", () => {
    const s = new RuntimeSettings(file);
    s.set("a.b", 1, BY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
  });

  it("writes atomically: no temp files left, and the file is always complete JSON", () => {
    const s = new RuntimeSettings(file);
    for (let i = 0; i < 20; i++) {
      s.set("loops.maxActive", i, BY);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; settings: Record<string, { value: unknown }> };
      expect(parsed.version).toBe(1);
      expect(parsed.settings["loops.maxActive"]!.value).toBe(i);
    }
    expect(readdirSync(join(dir, "state"))).toEqual(["runtime-settings.json"]);
  });

  it("keeps the old file when the write fails", () => {
    const s = new RuntimeSettings(file);
    s.set("a.b", 1, BY);
    const before = readFileSync(file, "utf8");
    expect(() => s.set("a.c", 1n as unknown as number, BY)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(s.get("a.c", z.number())).toBeUndefined();
  });

  it("ignores an invalid stored value with a warning, once", () => {
    const s = new RuntimeSettings(file);
    s.set("approvals.mode", "chaos", BY);
    expect(s.get("approvals.mode", mode)).toBeUndefined();
    expect(s.effective("approvals.mode", mode, "yolo")).toBe("yolo");
  });

  it("effective: override wins over config, config when none", () => {
    const s = new RuntimeSettings(file);
    expect(s.effective("approvals.mode", mode, "yolo")).toBe("yolo");
    s.set("approvals.mode", "strict", BY);
    expect(s.effective("approvals.mode", mode, "yolo")).toBe("strict");
    s.delete("approvals.mode", BY);
    expect(s.effective("approvals.mode", mode, "yolo")).toBe("yolo");
  });

  it("an override of false still wins over a config value of true", () => {
    const s = new RuntimeSettings(file);
    s.set("proactive.enabled", false, BY);
    expect(s.effective("proactive.enabled", z.boolean(), true)).toBe(false);
  });

  it("audits set and delete with old and new values", () => {
    const s = new RuntimeSettings(file, { audit });
    s.set("approvals.mode", "ask", BY);
    s.set("approvals.mode", "strict", BY);
    s.delete("approvals.mode", BY);
    s.delete("approvals.mode", BY); // no-op: nothing to delete, no record
    const recs = audit.recent({ feature: "settings" }).reverse();
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ action: "set", actor: BY, detail: { key: "approvals.mode", old: null, new: '"ask"' } });
    expect(recs[1]).toMatchObject({ action: "set", detail: { old: '"ask"', new: '"strict"' } });
    expect(recs[2]).toMatchObject({ action: "delete", detail: { key: "approvals.mode", old: '"strict"' } });
  });

  it("rejects bad keys and undefined values", () => {
    const s = new RuntimeSettings(file);
    expect(() => s.set("", 1, BY)).toThrow(/Invalid/);
    expect(() => s.set("a..b", 1, BY)).toThrow(/Invalid/);
    expect(() => s.set(".a", 1, BY)).toThrow(/Invalid/);
    expect(() => s.set("a.b", undefined, BY)).toThrow(/delete/);
  });

  it("lists keys, optionally by prefix", () => {
    const s = new RuntimeSettings(file);
    s.set("approvals.mode", "ask", BY);
    s.set("approvals.hardline", true, BY);
    s.set("goals.enabled", true, BY);
    expect(s.keys()).toEqual(["approvals.hardline", "approvals.mode", "goals.enabled"]);
    expect(s.keys("approvals.")).toEqual(["approvals.hardline", "approvals.mode"]);
  });

  it("calls onChange listeners and lets them unsubscribe", () => {
    const s = new RuntimeSettings(file);
    const cb = vi.fn();
    const off = s.onChange("approvals.mode", cb);
    s.set("approvals.mode", "ask", BY);
    s.set("other.key", 1, BY);
    s.delete("approvals.mode", BY);
    expect(cb.mock.calls).toEqual([["ask"], [undefined]]);
    off();
    s.set("approvals.mode", "strict", BY);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing listener", () => {
    const s = new RuntimeSettings(file);
    s.onChange("a.b", () => {
      throw new Error("listener bug");
    });
    expect(() => s.set("a.b", 1, BY)).not.toThrow();
    expect(s.get("a.b", z.number())).toBe(1);
  });

  it("treats a corrupt file as empty and keeps a copy before replacing it", () => {
    const s0 = new RuntimeSettings(file);
    s0.set("a.b", 1, BY);
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const s = new RuntimeSettings(file);
    expect(s.keys()).toEqual([]);
    s.set("a.c", 2, BY);
    expect(readdirSync(join(dir, "state")).some((f) => f.startsWith("runtime-settings.json.corrupt-"))).toBe(true);
    expect(new RuntimeSettings(file).get("a.c", z.number())).toBe(2);
  });

  describe("readonly (stdio subprocess)", () => {
    it("refuses writes", () => {
      const ro = new RuntimeSettings(file, { readonly: true });
      expect(() => ro.set("a.b", 1, BY)).toThrow(/read-only/);
      expect(() => ro.delete("a.b", BY)).toThrow(/read-only/);
    });

    it("re-reads when the file changes and notifies listeners", () => {
      const writer = new RuntimeSettings(file);
      const ro = new RuntimeSettings(file, { readonly: true });
      const cb = vi.fn();
      ro.onChange("approvals.mode", cb);
      expect(ro.get("approvals.mode", mode)).toBeUndefined();
      writer.set("approvals.mode", "ask", BY);
      // Make sure the mtime moves even on coarse-grained filesystems.
      const future = new Date(Date.now() + 5_000);
      utimesSync(file, future, future);
      expect(ro.get("approvals.mode", mode)).toBe("ask");
      expect(cb).toHaveBeenCalledWith("ask");
      writer.delete("approvals.mode", BY);
      const later = new Date(Date.now() + 10_000);
      utimesSync(file, later, later);
      expect(ro.keys()).toEqual([]);
      expect(cb).toHaveBeenLastCalledWith(undefined);
    });
  });
});
