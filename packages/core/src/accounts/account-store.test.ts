import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountStore, type ClaudeAccount } from "./account-store.js";

function account(id: string, over: Partial<ClaudeAccount> = {}): Omit<ClaudeAccount, "createdAt" | "updatedAt"> {
  return {
    id,
    kind: "config_dir",
    configDir: `/home/test/.${id}`,
    accountUuid: `uuid-${id}`,
    label: "so***@example.invalid",
    subscription: null,
    enabled: true,
    priority: 10,
    status: "ok",
    limitedUntil: null,
    limitType: null,
    limitMessage: null,
    lastUsedAt: null,
    lastErrorAt: null,
    lastError: null,
    ...over,
  };
}

describe("AccountStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-accstore-"));
    path = join(dir, "accounts.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file 0600 and migrations are idempotent", () => {
    const a = new AccountStore(path);
    a.insert(account("claude2"));
    a.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const b = new AccountStore(path);
    expect(b.list().map((x) => x.id)).toEqual(["claude2"]);
    b.close();
  });

  it("enforces a unique account uuid", () => {
    const s = new AccountStore(path);
    s.insert(account("claude2"));
    expect(() => s.insert(account("claude3", { accountUuid: "uuid-claude2" }))).toThrow();
    s.close();
  });

  it("orders by priority then id, updates fields, and keeps the active id", () => {
    const s = new AccountStore(path);
    s.insert(account("b", { priority: 20 }));
    s.insert(account("a", { priority: 20, accountUuid: "u-a" }));
    s.insert(account("z", { priority: 5, accountUuid: "u-z" }));
    expect(s.list().map((x) => x.id)).toEqual(["z", "a", "b"]);
    expect(s.update("a", { enabled: false, status: "limited", limitedUntil: 123 })).toMatchObject({ enabled: false, status: "limited", limitedUntil: 123 });
    s.setActiveId("b");
    expect(s.getActiveId()).toBe("b");
    s.setActiveId(null);
    expect(s.getActiveId()).toBeNull();
    expect(s.maxPriority()).toBe(20);
    s.close();
  });

  it("keeps the longer of two model benches and prunes expired ones", () => {
    const s = new AccountStore(path);
    s.setModelLimit("a", "m1", 1000, "model_unavailable");
    s.setModelLimit("a", "m1", 500, "overloaded");
    expect(s.getModelLimit("a", "m1")?.limitedUntil).toBe(1000);
    s.setModelLimit("", "m2", 200, null);
    expect(s.pruneModelLimits(300)).toBe(1);
    expect(s.modelLimits().map((l) => l.model)).toEqual(["m1"]);
    expect(s.clearModelLimits("a")).toBe(1);
    s.close();
  });

  it("removing an account drops its model benches", () => {
    const s = new AccountStore(path);
    s.insert(account("a"));
    s.setModelLimit("a", "m1", 1000, null);
    expect(s.remove("a")).toBe(true);
    expect(s.modelLimits()).toEqual([]);
    s.close();
  });

  it("is inert after close (a late turn never throws)", () => {
    const s = new AccountStore(path);
    s.insert(account("a"));
    s.close();
    expect(s.list()).toEqual([]);
    expect(s.get("a")).toBeNull();
    expect(() => s.setActiveId("a")).not.toThrow();
    expect(() => s.setModelLimit("a", "m", 1, null)).not.toThrow();
    expect(s.update("a", { enabled: false })).toBeNull();
  });
});
