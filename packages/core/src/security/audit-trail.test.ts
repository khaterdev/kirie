import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail, AUDIT_DETAIL_MAX_BYTES, type AuditRecord } from "./audit-trail.js";

describe("AuditTrail", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-audit-test-"));
    file = join(dir, "logs", "audit.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lines(): AuditRecord[] {
    return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
  }

  it("appends one JSON line per record, creating the file 0600", () => {
    const audit = new AuditTrail(file);
    audit.record({ feature: "commands", action: "goal", actor: "owner:telegram:1", detail: { outcome: "handled" } });
    audit.record({ feature: "settings", action: "set", actor: "owner:telegram:1" });
    const recs = lines();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ feature: "commands", action: "goal", actor: "owner:telegram:1", detail: { outcome: "handled" } });
    expect(Date.parse(recs[0]!.ts)).not.toBeNaN();
    expect(recs[1]).not.toHaveProperty("detail");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
  });

  it("appends to an existing file written by another process", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), feature: "x", action: "y", actor: "system" }) + "\n");
    new AuditTrail(file).record({ feature: "x", action: "z", actor: "system" });
    expect(lines().map((r) => r.action)).toEqual(["y", "z"]);
  });

  it("scrubs every string in the record", () => {
    const audit = new AuditTrail(file, { scrub: (t) => t.replaceAll("TOPSECRET", "«redacted:test»") });
    audit.record({
      feature: "accounts",
      action: "imported",
      actor: "owner:telegram:TOPSECRET",
      detail: { note: "key TOPSECRET", nested: { list: ["TOPSECRET"] }, err: new Error("failed TOPSECRET") },
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("TOPSECRET");
    expect(raw).toContain("«redacted:test»");
  });

  it("caps detail at 2 KB", () => {
    const audit = new AuditTrail(file);
    audit.record({ feature: "x", action: "y", actor: "system", detail: { blob: "a".repeat(10_000) } });
    const rec = lines()[0]!;
    expect(Buffer.byteLength(JSON.stringify(rec.detail), "utf8")).toBeLessThanOrEqual(AUDIT_DETAIL_MAX_BYTES);
    expect(rec.detail).toMatchObject({ truncated: true });
  });

  it("handles cycles, deep nesting and odd values", () => {
    const audit = new AuditTrail(file);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) deep = { deep };
    audit.record({ feature: "x", action: "y", actor: "system", detail: { cyclic, deep, big: 10n, nan: Number.NaN, fn: () => 1, when: new Date(0) } });
    const rec = lines()[0]!;
    expect(rec.detail).toMatchObject({ cyclic: { a: 1, self: "[circular]" }, big: "10", nan: "NaN", fn: "[function]", when: "1970-01-01T00:00:00.000Z" });
    expect(JSON.stringify(rec.detail)).toContain("[truncated]");
  });

  it("never throws, even when the file cannot be written", () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    chmodSync(join(dir, "logs"), 0o500);
    const audit = new AuditTrail(file);
    try {
      expect(() => audit.record({ feature: "x", action: "y", actor: "system" })).not.toThrow();
    } finally {
      chmodSync(join(dir, "logs"), 0o700);
    }
    const throwingScrub = new AuditTrail(file, { scrub: () => { throw new Error("scrubber bug"); } });
    expect(() => throwingScrub.record({ feature: "x", action: "y", actor: "system" })).not.toThrow();
  });

  describe("recent", () => {
    it("filters by feature, action and time, newest first, with a limit", () => {
      const audit = new AuditTrail(file);
      audit.record({ feature: "commands", action: "goal", actor: "a" });
      audit.record({ feature: "settings", action: "set", actor: "b" });
      audit.record({ feature: "commands", action: "loop", actor: "c" });
      audit.record({ feature: "commands", action: "goal", actor: "d" });
      expect(audit.recent({ feature: "commands" }).map((r) => r.actor)).toEqual(["d", "c", "a"]);
      expect(audit.recent({ feature: "commands", action: "goal" }).map((r) => r.actor)).toEqual(["d", "a"]);
      expect(audit.recent({ limit: 2 }).map((r) => r.actor)).toEqual(["d", "c"]);
      expect(audit.recent({ sinceMs: Date.now() + 60_000 })).toEqual([]);
      expect(audit.recent({ sinceMs: Date.now() - 60_000 })).toHaveLength(4);
      expect(audit.recent({ limit: 0 })).toEqual([]);
    });

    it("returns nothing for a missing file and skips corrupt lines", () => {
      const audit = new AuditTrail(file);
      expect(audit.recent({})).toEqual([]);
      audit.record({ feature: "x", action: "1", actor: "system" });
      writeFileSync(file, "not json\n{\"half\":", { flag: "a" });
      writeFileSync(file, "\n", { flag: "a" });
      audit.record({ feature: "x", action: "2", actor: "system" });
      expect(audit.recent({ feature: "x" }).map((r) => r.action)).toEqual(["2", "1"]);
    });

    it("reads only the tail of a large file, dropping the partial first line", () => {
      mkdirSync(join(dir, "logs"), { recursive: true });
      const old = JSON.stringify({ ts: new Date().toISOString(), feature: "old", action: "x", actor: "system", detail: { pad: "p".repeat(1000) } }) + "\n";
      writeFileSync(file, old.repeat(6000)); // ~6 MB
      const audit = new AuditTrail(file);
      audit.record({ feature: "new", action: "x", actor: "system" });
      expect(audit.recent({ feature: "new" })).toHaveLength(1);
      const olds = audit.recent({ feature: "old", limit: 100_000 });
      expect(olds.length).toBeGreaterThan(4000);
      expect(olds.length).toBeLessThan(6000);
    });
  });

  describe("rotateIfNeeded", () => {
    it("does nothing below the threshold", () => {
      const audit = new AuditTrail(file, { maxBytes: 10_000 });
      audit.record({ feature: "x", action: "y", actor: "system" });
      audit.rotateIfNeeded();
      expect(existsSync(`${file}.1`)).toBe(false);
    });

    it("shifts files and keeps at most `keep` rotated files", () => {
      const audit = new AuditTrail(file, { maxBytes: 50, keep: 2 });
      for (let round = 1; round <= 4; round++) {
        audit.record({ feature: "x", action: `round${round}`, actor: "system", detail: { pad: "p".repeat(60) } });
        audit.rotateIfNeeded();
      }
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(`${file}.1`, "utf8")).toContain("round4");
      expect(readFileSync(`${file}.2`, "utf8")).toContain("round3");
      expect(existsSync(`${file}.3`)).toBe(false);
      audit.record({ feature: "x", action: "after", actor: "system" });
      expect(audit.recent({}).map((r) => r.action)).toEqual(["after"]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});
