import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountsConfigSchema, type AccountsConfig } from "../config/sections/accounts.js";
import { AccountStore } from "./account-store.js";
import { AccountManager, AccountImportError, IDENTITY_RECHECK_MS, WEEKLY_LIMIT_DEFAULT_MS } from "./account-manager.js";
import type { AccountVerifyResult } from "./account-verify.js";
import type { FailureInfo } from "../engine/failure.js";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

function writeIdentity(file: string, uuid: string, email: string): void {
  writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email, organizationType: "claude_max" } }));
}

function limit(over: Partial<FailureInfo> = {}): FailureInfo {
  return { class: "usage_limit_account", message: "You've hit your session limit", ...over };
}

describe("AccountManager", () => {
  let root: string;
  let home: string;
  let store: AccountStore;
  let clock: number;
  let rotation: boolean;
  let cfg: AccountsConfig;
  let audit: { record: ReturnType<typeof vi.fn> };
  let verify: ReturnType<typeof vi.fn<(a: unknown) => Promise<AccountVerifyResult>>>;
  let manager: AccountManager;

  function makeManager(): AccountManager {
    return new AccountManager({
      store,
      config: () => cfg,
      rotationEnabled: () => rotation,
      home,
      now: () => clock,
      baseEnv: () => ({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/inherited/dir" }),
      audit,
      verify,
      runSecurity: () => 0,
      platform: "darwin",
    });
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-accmgr-")));
    home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeIdentity(join(home, ".claude.json"), "uuid-main", "main@example.invalid");
    for (const n of [2, 3]) {
      mkdirSync(join(home, `.claude${n}`));
      writeIdentity(join(home, `.claude${n}`, ".claude.json"), `uuid-${n}`, `user${n}@example.invalid`);
    }
    clock = T0;
    rotation = false;
    cfg = AccountsConfigSchema.parse({});
    audit = { record: vi.fn() };
    verify = vi.fn(async () => ({ ok: true, label: "x", subscription: "Claude Max" }));
    store = new AccountStore(join(root, "accounts.db"), { now: () => clock });
    manager = makeManager();
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function importThree(): Promise<void> {
    await manager.importDir("~/.claude", { actor: "owner:test" });
    await manager.importDir("~/.claude2", { actor: "owner:test" });
    await manager.importDir("~/.claude3", { actor: "owner:test" });
  }

  it("with zero accounts the lease is null and nothing is set", () => {
    expect(manager.hasAccounts()).toBe(false);
    expect(manager.acquire()).toEqual({ accountId: null, env: undefined, exhausted: false });
  });

  it("imports the default dir as 'main' (variable unset) and ~/.claude2 with its exact path", async () => {
    const first = await manager.importDir("~/.claude/", { actor: "owner:test" });
    expect(first.account).toMatchObject({ id: "main", kind: "default", configDir: null, label: "ma***@example.invalid", subscription: "Claude Max" });
    expect(first.becameActive).toBe(true);
    const second = await manager.importDir("~/.claude2/", { actor: "owner:test" });
    expect(second.account).toMatchObject({ id: "claude2", kind: "config_dir", configDir: join(home, ".claude2") });
    expect(second.becameActive).toBe(false);

    const lease = manager.acquire();
    expect(lease.accountId).toBe("main");
    expect(lease.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    manager.use("claude2", "owner:test");
    expect(manager.acquire().env?.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude2"));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ feature: "accounts", action: "imported", actor: "owner:test" }));
  });

  it("refuses duplicates (same uuid, same dir) and a dir that is not logged in", async () => {
    await manager.importDir("~/.claude2", { actor: "owner:test" });
    await expect(manager.importDir("~/.claude2", { actor: "owner:test" })).rejects.toThrow(/already imported/);
    mkdirSync(join(home, ".claude4"));
    writeIdentity(join(home, ".claude4", ".claude.json"), "uuid-2", "dup@example.invalid");
    await expect(manager.importDir("~/.claude4", { actor: "owner:test" })).rejects.toThrow(/already imported as claude2/);
    mkdirSync(join(home, ".claude5"));
    writeFileSync(join(home, ".claude5", ".claude.json"), JSON.stringify({ numStartups: 1 }));
    await expect(manager.importDir("~/.claude5", { actor: "owner:test" })).rejects.toBeInstanceOf(AccountImportError);
  });

  it("a failed verify imports the account disabled with auth_error", async () => {
    verify.mockResolvedValueOnce({ ok: false, reason: "timeout" });
    const out = await manager.importDir("~/.claude2", { actor: "owner:test" });
    expect(out.account).toMatchObject({ enabled: false, status: "auth_error", lastError: "login not readable from the daemon" });
    expect(manager.hasAccounts()).toBe(false);
  });

  it("an explicit id is validated and must be free", async () => {
    await expect(manager.importDir("~/.claude2", { actor: "o", id: "Bad Id" })).rejects.toThrow(/lower-case/);
    await manager.importDir("~/.claude2", { actor: "o", id: "work" });
    await expect(manager.importDir("~/.claude3", { actor: "o", id: "work" })).rejects.toThrow(/taken/);
  });

  it("is fill-first by priority and sticky on the active account", async () => {
    await importThree();
    expect(manager.acquire().accountId).toBe("main");
    manager.use("claude3", "owner:test");
    expect(manager.acquire().accountId).toBe("claude3");
    rotation = true;
    expect(manager.acquire().accountId).toBe("claude3");
  });

  it("reportLimit benches the account; with rotation on the next acquire rotates once", async () => {
    await importThree();
    rotation = true;
    const rotated = vi.fn();
    manager.on("rotated", rotated);
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000, limitType: "five_hour" }));
    expect(manager.get("main")).toMatchObject({ status: "limited", limitedUntil: T0 + 3_600_000, limitType: "five_hour" });
    const lease = manager.acquire();
    expect(lease).toMatchObject({ accountId: "claude2", exhausted: false });
    expect(lease.env?.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude2"));
    expect(manager.acquire().accountId).toBe("claude2");
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(rotated).toHaveBeenCalledWith({ from: "main", to: "claude2", cause: "limit", fromResetAtMs: T0 + 3_600_000, fromLimitType: "five_hour" });
  });

  it("rotation off leaves the active account and reports exhausted with the reset time", async () => {
    await importThree();
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000 }));
    const lease = manager.acquire();
    expect(lease).toMatchObject({ accountId: "main", exhausted: true, earliestResetAt: T0 + 3_600_000 });
  });

  it("with every account limited, returns the earliest reset and notifies once", async () => {
    await importThree();
    rotation = true;
    const exhausted = vi.fn();
    manager.on("exhausted", exhausted);
    manager.reportFailure("main", limit({ resetAtMs: T0 + 5 * 3_600_000 }));
    manager.reportFailure("claude2", limit({ resetAtMs: T0 + 2 * 3_600_000 }));
    manager.reportFailure("claude3", limit({ resetAtMs: T0 + 9 * 3_600_000 }));
    const lease = manager.acquire();
    expect(lease.exhausted).toBe(true);
    expect(lease.earliestResetAt).toBe(T0 + 2 * 3_600_000);
    manager.acquire();
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted).toHaveBeenCalledWith({ earliest: { accountId: "claude2", atMs: T0 + 2 * 3_600_000 } });
  });

  it("recovers a bench once its time has passed, and logs it", async () => {
    await importThree();
    rotation = true;
    const recovered = vi.fn();
    manager.on("recovered", recovered);
    manager.reportFailure("main", limit({ resetAtMs: T0 + 60 * 60_000 }));
    expect(manager.acquire().accountId).toBe("claude2");
    clock = T0 + 61 * 60_000;
    expect(manager.acquire().accountId).toBe("claude2");
    expect(manager.get("main")?.status).toBe("ok");
    expect(recovered).toHaveBeenCalledWith({ accountId: "main" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "recovered" }));
  });

  it("returnToPrimary moves back to the lowest priority usable account at turn start", async () => {
    await importThree();
    rotation = true;
    manager.reportFailure("main", limit({ resetAtMs: T0 + 60 * 60_000 }));
    expect(manager.acquire().accountId).toBe("claude2");
    clock = T0 + 61 * 60_000;
    expect(manager.acquire().accountId).toBe("claude2");
    cfg = AccountsConfigSchema.parse({ rotation: { returnToPrimary: true } });
    expect(manager.acquire().accountId).toBe("main");
  });

  it("an auth error has no timer and is cleared by reset", async () => {
    await importThree();
    rotation = true;
    const authErr = vi.fn();
    manager.on("auth_error", authErr);
    manager.reportFailure("main", { class: "auth", message: "Not logged in · Please run /login" });
    expect(manager.get("main")?.status).toBe("auth_error");
    expect(authErr).toHaveBeenCalledWith({ accountId: "main", reason: "auth" });
    clock = T0 + 30 * 24 * 3_600_000;
    expect(manager.acquire().accountId).toBe("claude2");
    expect(manager.get("main")?.status).toBe("auth_error");
    manager.reset("main", "owner:test");
    expect(manager.get("main")?.status).toBe("ok");
  });

  it("skips disabled accounts; disabling the active one moves on even with rotation off", async () => {
    await importThree();
    manager.setEnabled("main", false, "owner:test");
    expect(manager.acquire().accountId).toBe("claude2");
  });

  it("a duplicate reportLimit is idempotent", async () => {
    await importThree();
    audit.record.mockClear();
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000 }));
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000 }));
    expect(audit.record.mock.calls.filter((c) => (c[0] as { action: string }).action === "limited")).toHaveLength(1);
  });

  it("uses the default cooldown for a session limit and 24 h for a weekly limit without a reset", async () => {
    await importThree();
    manager.reportFailure("main", limit());
    expect(manager.get("main")?.limitedUntil).toBe(T0 + 60 * 60_000);
    manager.reportFailure("claude2", limit({ message: "You've hit your weekly limit", limitType: "seven_day" }));
    expect(manager.get("claude2")?.limitedUntil).toBe(T0 + WEEKLY_LIMIT_DEFAULT_MS);
  });

  it("use() on a limited account clears the limit", async () => {
    await importThree();
    manager.reportFailure("claude2", limit({ resetAtMs: T0 + 3_600_000 }));
    const out = manager.use("claude2", "owner:test");
    expect(out.clearedLimit).toBe(true);
    expect(manager.get("claude2")?.status).toBe("ok");
    expect(manager.acquire().accountId).toBe("claude2");
  });

  it("state survives a re-open", async () => {
    await importThree();
    manager.use("claude3", "owner:test");
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000 }));
    store.close();
    store = new AccountStore(join(root, "accounts.db"), { now: () => clock });
    manager = makeManager();
    expect(manager.activeAccountId()).toBe("claude3");
    expect(manager.get("main")?.status).toBe("limited");
  });

  it("identity pin: a changed uuid puts the account in auth_error before use", async () => {
    await importThree();
    rotation = true;
    const authErr = vi.fn();
    manager.on("auth_error", authErr);
    writeIdentity(join(home, ".claude.json"), "uuid-someone-else", "other@example.invalid");
    // Checked at import; not re-read within 10 minutes.
    expect(manager.acquire().accountId).toBe("main");
    clock = T0 + IDENTITY_RECHECK_MS + 1;
    expect(manager.acquire().accountId).toBe("claude2");
    expect(manager.get("main")).toMatchObject({ status: "auth_error" });
    expect(authErr).toHaveBeenCalledWith({ accountId: "main", reason: "identity_changed" });
  });

  it("a signed-out or re-logged account is never handed out, even as the exhausted fallback", async () => {
    await importThree();
    writeIdentity(join(home, ".claude.json"), "uuid-someone-else", "other@example.invalid");
    clock = T0 + IDENTITY_RECHECK_MS + 1;
    // Rotation off: the active account fails its pin; nothing may be used.
    expect(manager.acquire()).toMatchObject({ accountId: null, env: undefined, exhausted: true, blocked: true });
    expect(manager.get("main")?.status).toBe("auth_error");
    // Rotation on with every other account limited: the limited one resetting first is the fallback.
    rotation = true;
    manager.reportFailure("claude2", limit({ resetAtMs: clock + 9 * 3_600_000 }));
    manager.reportFailure("claude3", limit({ resetAtMs: clock + 2 * 3_600_000 }));
    expect(manager.acquire()).toMatchObject({ accountId: "claude3", exhausted: true });
    // All signed out: blocked.
    manager.reportFailure("claude2", { class: "auth", message: "Not logged in" });
    manager.reportFailure("claude3", { class: "auth", message: "Not logged in" });
    expect(manager.acquire()).toMatchObject({ accountId: null, blocked: true });
  });

  it("a limited fallback whose login changed is not used either", async () => {
    await importThree();
    manager.reportFailure("main", limit({ resetAtMs: T0 + 3_600_000 }));
    writeIdentity(join(home, ".claude.json"), "uuid-someone-else", "other@example.invalid");
    clock = T0 + IDENTITY_RECHECK_MS + 1;
    expect(manager.acquire()).toMatchObject({ accountId: null, blocked: true });
  });

  it("accept skips candidates before any switch (one rotation, one notice)", async () => {
    await importThree();
    rotation = true;
    const rotated = vi.fn();
    manager.on("rotated", rotated);
    const lease = manager.acquire({ exclude: new Set(["main"]), accept: (id) => id !== "claude2" });
    expect(lease.accountId).toBe("claude3");
    expect(manager.activeAccountId()).toBe("claude3");
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(rotated).toHaveBeenCalledWith(expect.objectContaining({ from: "main", to: "claude3" }));
  });

  it('"all" cannot be an account id', async () => {
    await expect(manager.importDir("~/.claude2", { actor: "o", id: "all" })).rejects.toThrow(/reserved/);
  });

  it("identity pin: a file caught mid-write is not held against the account", async () => {
    await importThree();
    writeFileSync(join(home, ".claude.json"), '{"oauthAcc');
    clock = T0 + IDENTITY_RECHECK_MS + 1;
    expect(manager.acquire().accountId).toBe("main");
    expect(manager.get("main")?.status).toBe("ok");
  });

  it("acquire with an exclusion switches for a model-scoped limit", async () => {
    await importThree();
    rotation = true;
    const rotated = vi.fn();
    manager.on("rotated", rotated);
    const lease = manager.acquire({ exclude: new Set(["main"]) });
    expect(lease.accountId).toBe("claude2");
    expect(rotated).toHaveBeenCalledWith(expect.objectContaining({ from: "main", to: "claude2", cause: "model_limit" }));
  });

  it("remove forgets the account and moves the active pointer", async () => {
    await importThree();
    manager.remove("main", "owner:test");
    expect(manager.get("main")).toBeNull();
    expect(manager.activeAccountId()).toBe("claude2");
  });

  it("discover marks imported dirs", async () => {
    await manager.importDir("~/.claude2", { actor: "owner:test" });
    const found = manager.discover();
    expect(found.map((d) => [d.suggestedId, d.importedAs])).toEqual([
      ["main", null],
      ["claude2", "claude2"],
      ["claude3", null],
    ]);
  });

  it("onlyDiscovered refuses a dir outside the discovery pattern", async () => {
    mkdirSync(join(home, "work-claude"));
    writeIdentity(join(home, "work-claude", ".claude.json"), "uuid-w", "w@example.invalid");
    await expect(manager.importDir("~/work-claude", { actor: "agent:x", onlyDiscovered: true })).rejects.toThrow(/discover/);
    expect((await manager.importDir("~/work-claude", { actor: "owner:test" })).account.id).toBe("work-claude");
  });

  it("test() clears an auth error when the login verifies", async () => {
    await importThree();
    manager.reportFailure("claude2", { class: "auth", message: "OAuth access token has expired" });
    const res = await manager.test("claude2", "owner:test");
    expect(res.verify?.ok).toBe(true);
    expect(manager.get("claude2")?.status).toBe("ok");
  });

  it("carries a transcript between accounts by their dirs (same projects store: no copy)", async () => {
    await importThree();
    mkdirSync(join(home, ".claude", "projects"));
    symlinkSync(join(home, ".claude", "projects"), join(home, ".claude2", "projects"));
    expect(manager.carryTranscript("main", "claude2", "11111111-2222-3333-4444-555555555555")).toBe("same");
    expect(manager.carryTranscript("main", "claude3", "11111111-2222-3333-4444-555555555555")).toBe("failed");
    expect(manager.carryTranscript("gone", "claude2", "11111111-2222-3333-4444-555555555555")).toBe("failed");
  });
});
