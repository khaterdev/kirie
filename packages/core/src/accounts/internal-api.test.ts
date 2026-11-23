import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditTrail } from "../security/audit-trail.js";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { AccountsConfigSchema } from "../config/sections/accounts.js";
import { FallbackConfigSchema } from "../config/sections/fallback.js";
import { effectiveSettingFlag } from "../config/sections/effective.js";
import type { OwnerApprovalRequest } from "../interaction/owner-prompts.js";
import { AccountStore } from "./account-store.js";
import { AccountManager } from "./account-manager.js";
import { FallbackControl } from "./fallback-control.js";
import { ACCOUNTS_ROTATION_SETTING, AccountsBooleanSetting } from "./commands.js";
import { createAccountsInternalApi, type AccountsAgentToolsMode } from "./internal-api.js";

function writeIdentity(file: string, uuid: string): void {
  writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.invalid` } }));
}

describe("accounts internal API", () => {
  let root: string;
  let home: string;
  let store: AccountStore;
  let audit: AuditTrail;
  let settings: RuntimeSettings;
  let manager: AccountManager;
  let mode: AccountsAgentToolsMode;
  let approval: ReturnType<typeof vi.fn<(req: OwnerApprovalRequest) => Promise<{ outcome: "approved" | "denied" | "timeout" | "cancelled" | "unavailable"; optionId: string; code: string }>>>;
  let notifyOwner: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createAccountsInternalApi>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-accapi-")));
    home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeIdentity(join(home, ".claude.json"), "uuid-main");
    mkdirSync(join(home, ".claude2"));
    writeIdentity(join(home, ".claude2", ".claude.json"), "uuid-2");
    store = new AccountStore(join(root, "accounts.db"));
    audit = new AuditTrail(join(root, "audit.jsonl"));
    settings = new RuntimeSettings(join(root, "state", "rs.json"), { audit });
    const cfg = AccountsConfigSchema.parse({});
    const rotationEnabled = () => effectiveSettingFlag(settings, ACCOUNTS_ROTATION_SETTING, false);
    manager = new AccountManager({ store, config: () => cfg, rotationEnabled, home, audit, runSecurity: () => 0, platform: "darwin" });
    const fbCfg = FallbackConfigSchema.parse({ models: ["sonnet"] });
    const fallback = new FallbackControl({ store, config: () => fbCfg });
    mode = "manage";
    approval = vi.fn(async () => ({ outcome: "denied" as const, optionId: "deny", code: "AAAA" }));
    notifyOwner = vi.fn(async () => {});
    app = createAccountsInternalApi({
      manager,
      fallback,
      settings,
      agentTools: () => mode,
      rotationEnabled,
      fallbackConfig: () => fbCfg,
      primaryModel: () => "opus",
      requestApproval: approval,
      approvalTimeoutMs: 5_000,
      notifyOwner,
      home,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("agentTools off refuses everything; read allows only the GET routes", async () => {
    mode = "off";
    expect((await app.request("/")).status).toBe(403);
    expect((await post("/rotation", { enabled: true })).status).toBe(403);
    mode = "read";
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/discover")).status).toBe(200);
    expect((await post("/rotation", { enabled: true })).status).toBe(403);
    expect((await post("/import", { config_dir: "~/.claude2" })).status).toBe(403);
    expect(approval).not.toHaveBeenCalled();
  });

  it("list includes the fallback state and never a full home path", async () => {
    await manager.importDir("~/.claude2", { actor: "owner:test", verify: false });
    const body = (await (await app.request("/")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ activeId: "claude2", rotation: { enabled: false }, fallback: { enabled: false, models: ["sonnet"], benched: [] } });
    expect(JSON.stringify(body)).not.toContain(home);
  });

  it("accounts_import without owner approval imports nothing", async () => {
    const res = await post("/import", { config_dir: "~/.claude2", session_key: "telegram:dm:1" });
    expect(await res.json()).toMatchObject({ imported: false });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval.mock.calls[0]![0]).toMatchObject({ kind: "accounts" });
    expect(manager.list()).toEqual([]);
  });

  it("accounts_import imports a discovered dir after Approve, audited as the agent", async () => {
    approval.mockResolvedValueOnce({ outcome: "approved", optionId: "approve", code: "BBBB" });
    const res = await post("/import", { config_dir: "~/.claude2", session_key: "telegram:dm:1" });
    expect(await res.json()).toMatchObject({ imported: true, account: { id: "claude2" } });
    expect(audit.recent({ feature: "accounts", action: "imported" })[0]?.actor).toBe("agent:telegram:dm:1");
  });

  it("refuses a dir that discover does not list, without asking the owner", async () => {
    mkdirSync(join(home, "elsewhere"));
    writeIdentity(join(home, "elsewhere", ".claude.json"), "uuid-x");
    const res = await post("/import", { config_dir: join(home, "elsewhere") });
    expect(res.status).toBe(400);
    expect(approval).not.toHaveBeenCalled();
  });

  it("use, enabled, reset and rotation are bounded, audited and told to the owner", async () => {
    await manager.importDir("~/.claude", { actor: "owner:test", verify: false });
    await manager.importDir("~/.claude2", { actor: "owner:test", verify: false });
    expect((await post("/claude2/use", { session_key: "telegram:dm:1" })).status).toBe(200);
    expect(manager.activeAccountId()).toBe("claude2");
    expect((await post("/main/enabled", { enabled: false })).status).toBe(200);
    expect(manager.get("main")?.enabled).toBe(false);
    expect((await post("/main/reset", {})).status).toBe(200);
    expect((await post("/rotation", { enabled: true, session_key: "bad key with spaces" })).status).toBe(200);
    expect(settings.get(ACCOUNTS_ROTATION_SETTING, AccountsBooleanSetting)).toBe(true);
    expect(notifyOwner).toHaveBeenCalledTimes(4);
    const actors = audit.recent({ feature: "accounts" }).map((r) => r.actor);
    expect(actors).toContain("agent:telegram:dm:1");
    expect(actors).toContain("agent:unknown");
    expect((await post("/NOT_AN_ID/use", {})).status).toBe(400);
    expect((await post("/main/enabled", { enabled: "yes" })).status).toBe(400);
  });

  it("has no route that removes an account or changes the fallback chain", async () => {
    await manager.importDir("~/.claude2", { actor: "owner:test", verify: false });
    expect((await app.request("/claude2", { method: "DELETE" })).status).toBe(404);
    expect((await post("/claude2/remove", {})).status).toBe(404);
    expect((await post("/fallback", { models: ["haiku"] })).status).toBe(404);
    expect(manager.get("claude2")).not.toBeNull();
  });
});
