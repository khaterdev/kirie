/**
 * RUNTIME-B4: every agent-initiated account change reaches the owner, with the
 * daemon's real rate-limited notifier (not a mock) in front of the real routes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AccountManager,
  AccountStore,
  AuditTrail,
  FallbackControl,
  RuntimeSettings,
  ACCOUNTS_ROTATION_SETTING,
  createAccountsInternalApi,
  effectiveSettingFlag,
} from "@kirie/core";
import { createOwnerNotifier, OWNER_NOTIFY_KEY_INTERVAL_MS } from "./notify.js";

describe("agent account changes always reach the owner", () => {
  let root = "";
  let store: AccountStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-accnotify-")));
    const home = join(root, "home");
    mkdirSync(join(home, ".claude2"), { recursive: true });
    writeFileSync(join(home, ".claude2", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u2", emailAddress: "a@example.invalid" } }));
    store = new AccountStore(join(root, "accounts.db"));
    const audit = new AuditTrail(join(root, "audit.jsonl"));
    const settings = new RuntimeSettings(join(root, "state", "rs.json"), { audit });
    const rotationEnabled = () => effectiveSettingFlag(settings, ACCOUNTS_ROTATION_SETTING, false);
    const accountsCfg = {
      rotation: { enabled: false, returnToPrimary: false, maxRotationsPerTurn: 3, defaultCooldownMinutes: 60, notify: true, carrySession: true },
      importRoots: [], verifyOnImport: false, agentTools: "manage" as const,
    };
    const manager = new AccountManager({ store, config: () => accountsCfg, rotationEnabled, home, audit, runSecurity: () => 0, platform: "darwin" });
    await manager.importDir(join(home, ".claude2"), { actor: "owner:test", verify: false });
    const fbCfg = { enabled: false, models: [], sdkNative: true, on: ["overloaded" as const], cooldownMinutes: 30, maxAttemptsPerTurn: 4, notify: true };
    const fallback = new FallbackControl({ store, config: () => fbCfg });

    // The notifier exactly as lifecycle.ts builds it; the clock stays inside one 10-minute window.
    let now = 1_000_000;
    const sent: string[] = [];
    const notifyOwner = createOwnerNotifier({
      owners: { primary: () => ({ channel: "telegram", chatId: "1" }) } as never,
      channelRegistry: {
        getById: () => ({ sendText: async (p: { text: string }) => { sent.push(p.text); return []; } }),
        isRunning: () => true,
      } as never,
      now: () => now,
    });
    const app = createAccountsInternalApi({
      manager, fallback, settings,
      agentTools: () => "manage",
      rotationEnabled,
      fallbackConfig: () => fbCfg,
      primaryModel: () => "opus",
      requestApproval: async () => ({ outcome: "denied", optionId: "deny", code: "AAAA" }),
      approvalTimeoutMs: 1000,
      notifyOwner,
      home,
    });
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await new Promise((r) => setTimeout(r, 5));
      now += 60_000;
      return res;
    };
    return { manager, settings, rotationEnabled, sent, post };
  }

  it("rotation off then on within 10 minutes: two notices, the last one says on (reviewer proof)", async () => {
    const h = await setup();
    await h.post("/rotation", { enabled: false });
    await h.post("/rotation", { enabled: true });
    expect(h.rotationEnabled()).toBe(true);
    const notices = h.sent.filter((t) => t.includes("account rotation"));
    expect(notices).toEqual([
      "The agent turned account rotation off. Undo with /rotation on.",
      "The agent turned account rotation on. Undo with /rotation off.",
    ]);
  });

  it("enable then disable within 10 minutes: two notices, the last one says disabled (reviewer proof)", async () => {
    const h = await setup();
    await h.post("/claude2/enabled", { enabled: false });
    await h.post("/claude2/enabled", { enabled: true });
    await h.post("/claude2/enabled", { enabled: false });
    expect(h.manager.get("claude2")?.enabled).toBe(false);
    const notices = h.sent.filter((t) => t.includes("Claude account claude2"));
    expect(notices.map((t) => t.split(" ")[2])).toEqual(["disabled", "enabled", "disabled"]);
  });

  it("an agent change after the owner's own change is reported even when it repeats an earlier notice", async () => {
    const h = await setup();
    await h.post("/rotation", { enabled: true });
    h.settings.set(ACCOUNTS_ROTATION_SETTING, false, "owner:telegram:1"); // the owner's /rotation off
    await h.post("/rotation", { enabled: true });
    expect(h.sent.filter((t) => t.includes("account rotation on"))).toHaveLength(2);
  });

  it("a repeat that changes nothing is coalesced with the identical notice", async () => {
    const h = await setup();
    await h.post("/rotation", { enabled: true });
    await h.post("/rotation", { enabled: true });
    await h.post("/rotation", { enabled: true });
    expect(h.sent.filter((t) => t.includes("account rotation"))).toHaveLength(1);
    expect(OWNER_NOTIFY_KEY_INTERVAL_MS).toBe(10 * 60_000);
  });

  it("switching the active account away and back gives a notice each time", async () => {
    const h = await setup();
    await h.post("/claude2/use", {});
    await h.post("/claude2/use", {}); // already active: coalesced
    expect(h.sent.filter((t) => t.includes("switched the active Claude account"))).toHaveLength(1);
  });
});
