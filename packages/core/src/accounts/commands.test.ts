import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { AuditTrail } from "../security/audit-trail.js";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { CommandRegistry, COMMAND_OWNER_ONLY_TEXT } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { AccountsConfigSchema } from "../config/sections/accounts.js";
import { FallbackConfigSchema, type FallbackConfig } from "../config/sections/fallback.js";
import { effectiveSettingFlag } from "../config/sections/effective.js";
import { AccountStore } from "./account-store.js";
import { AccountManager } from "./account-manager.js";
import { FallbackControl } from "./fallback-control.js";
import {
  ACCOUNTS_ROTATION_SETTING,
  AccountsBooleanSetting,
  FALLBACK_ENABLED_SETTING,
  FALLBACK_MODELS_SETTING,
  FallbackModelsSetting,
  createAccountsCommands,
} from "./commands.js";
import { ACCOUNTS_MCP_NOTE } from "./notices.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, senderId = OWNER): UnifiedMessage {
  return { id: `m-${Math.random()}`, channel: "telegram", senderId, senderName: "X", text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null };
}
function identity(m: UnifiedMessage): ResolvedIdentity {
  return { role: m.senderId === OWNER ? "owner" : "user", canonicalId: `telegram:${m.senderId}`, channel: m.channel, senderId: m.senderId };
}
function writeIdentity(file: string, uuid: string): void {
  writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.invalid` } }));
}

describe("accounts commands", () => {
  let root: string;
  let home: string;
  let store: AccountStore;
  let settings: RuntimeSettings;
  let audit: AuditTrail;
  let manager: AccountManager;
  let fallback: FallbackControl;
  let registry: CommandRegistry;
  let confirm: ReturnType<typeof vi.fn>;
  const verify = vi.fn(async () => ({ ok: true, label: "x", subscription: "Claude Max" }));

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-acccmd-")));
    home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeIdentity(join(home, ".claude.json"), "uuid-main");
    mkdirSync(join(home, ".claude2"));
    writeIdentity(join(home, ".claude2", ".claude.json"), "uuid-2");
    store = new AccountStore(join(root, "accounts.db"));
    audit = new AuditTrail(join(root, "audit.jsonl"));
    settings = new RuntimeSettings(join(root, "state", "rs.json"), { audit });
    const accountsCfg = AccountsConfigSchema.parse({});
    const rotationEnabled = () => effectiveSettingFlag(settings, ACCOUNTS_ROTATION_SETTING, accountsCfg.rotation.enabled);
    const base = FallbackConfigSchema.parse({});
    const fallbackConfig = (): FallbackConfig => ({
      ...base,
      enabled: settings.effective(FALLBACK_ENABLED_SETTING, AccountsBooleanSetting, base.enabled),
      models: settings.effective(FALLBACK_MODELS_SETTING, FallbackModelsSetting, base.models),
    });
    manager = new AccountManager({ store, config: () => accountsCfg, rotationEnabled, home, audit, verify, runSecurity: () => 0, platform: "darwin" });
    fallback = new FallbackControl({ store, config: fallbackConfig });
    confirm = vi.fn(async () => ({ outcome: "approved", optionId: "approve", code: "K7Q2" }));
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }), audit, prompts: { requestApproval: confirm } });
    registry.registerAll(
      createAccountsCommands({ manager, fallback, settings, audit, rotationEnabled, primaryModel: () => "opus", fallbackConfig, timezone: "Africa/Cairo", home }),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function run(text: string, sender = OWNER): Promise<string> {
    const m = msg(text, sender);
    const sent: CommandReply[] = [];
    const outcome = await registry.dispatch({ message: m, identity: identity(m), source: "channel", send: async (r) => void sent.push(r) });
    if (outcome.kind === "denied") return outcome.reply.text;
    return sent.map((r) => r.text).join("\n");
  }

  it("all three commands are refused for a non-owner and nothing changes", async () => {
    for (const cmd of ["/accounts", "/accounts import all", "/rotation on", "/fallback on"]) {
      expect(await run(cmd, STRANGER)).toBe(COMMAND_OWNER_ONLY_TEXT);
    }
    expect(manager.list()).toEqual([]);
    expect(settings.get(ACCOUNTS_ROTATION_SETTING, AccountsBooleanSetting)).toBeUndefined();
  });

  it("are owner-only, DM-only and in the accounts category", () => {
    for (const name of ["accounts", "rotation", "fallback"]) {
      const def = registry.get(name)!;
      expect(def).toMatchObject({ ownerOnly: true, scope: "dm", category: "accounts" });
    }
    expect(registry.get("accounts")!.usage).toContain(ACCOUNTS_MCP_NOTE);
  });

  it("lists nothing at first, then discovers and imports all logged-in dirs", async () => {
    expect(await run("/accounts")).toContain("No Claude accounts imported");
    const discovered = await run("/accounts discover");
    expect(discovered).toContain("~/.claude (default)");
    expect(discovered).toContain("not imported (id claude2)");
    const imported = await run("/accounts import all");
    expect(imported).toContain("Imported main");
    expect(imported).toContain("Imported claude2");
    expect(imported).toContain(ACCOUNTS_MCP_NOTE);
    const list = await run("/accounts");
    expect(list).toContain("* main");
    expect(list).toContain("claude2");
    expect(list).toContain("rotation off");
  });

  it("add, use, disable, enable, reset, test and log", async () => {
    mkdirSync(join(home, "work"));
    writeIdentity(join(home, "work", ".claude.json"), "uuid-w");
    expect(await run("/accounts add work ~/work")).toContain("Imported work");
    await run("/accounts import ~/.claude2");
    expect(await run("/accounts use claude2")).toContain("claude2 is active");
    expect(manager.activeAccountId()).toBe("claude2");
    expect(await run("/accounts disable work")).toContain("disabled");
    expect(manager.get("work")?.enabled).toBe(false);
    await run("/accounts enable work");
    manager.reportFailure("claude2", { class: "usage_limit_account", message: "x", resetAtMs: Date.now() + 3_600_000 });
    expect(await run("/accounts")).toMatch(/claude2 .*limit until/);
    expect(await run("/accounts reset all")).toContain("Cleared");
    expect(await run("/accounts test claude2")).toContain("verified");
    const log = await run("/accounts log");
    expect(log).toContain("imported");
    expect(log).toContain("reset");
  });

  it("remove asks for confirmation", async () => {
    await run("/accounts import ~/.claude2");
    confirm.mockResolvedValueOnce({ outcome: "denied", optionId: "deny", code: "AAAA" });
    expect(await run("/accounts remove claude2")).toBe("Cancelled.");
    expect(manager.get("claude2")).not.toBeNull();
    expect(await run("/accounts remove claude2")).toContain("removed");
    expect(manager.get("claude2")).toBeNull();
  });

  it("bad input gets a usage line, not an exception", async () => {
    expect(await run("/accounts use")).toContain("Usage");
    expect(await run("/accounts use nobody")).toContain("no account named nobody");
    expect(await run("/accounts import ~/missing")).toContain("Not imported");
    expect(await run("/accounts frobnicate")).toContain("Unknown subcommand");
  });

  it("/rotation on|off|reset writes and drops the runtime override", async () => {
    expect(await run("/rotation")).toContain("off");
    expect(await run("/rotation on")).toContain("Account rotation is on");
    expect(settings.get(ACCOUNTS_ROTATION_SETTING, AccountsBooleanSetting)).toBe(true);
    expect(await run("/rotation off")).toContain("off");
    expect(await run("/rotation reset")).toContain("config.yaml");
    expect(settings.get(ACCOUNTS_ROTATION_SETTING, AccountsBooleanSetting)).toBeUndefined();
  });

  it("/fallback show, set, on, off, clear, reset", async () => {
    expect(await run("/fallback")).toContain("Fallback: off");
    expect(await run("/fallback set sonnet, haiku")).toContain("Fallback chain: sonnet, haiku");
    expect(settings.get(FALLBACK_MODELS_SETTING, FallbackModelsSetting)).toEqual(["sonnet", "haiku"]);
    expect(await run("/fallback set bad;id")).toContain("Invalid model id");
    expect(await run("/fallback set a b c d e")).toContain("At most 4");
    expect(await run("/fallback on")).toContain("on");
    fallback.bench(null, "opus", undefined, "model_unavailable");
    const shown = await run("/fallback");
    expect(shown).toContain("Fallback: on; chain: sonnet, haiku");
    expect(shown).toContain("opus on default login");
    expect(await run("/fallback clear")).toContain("cleared");
    expect(await run("/fallback reset")).toContain("1 benched model cleared");
    expect(settings.get(FALLBACK_ENABLED_SETTING, AccountsBooleanSetting)).toBeUndefined();
    expect(fallback.benched()).toEqual([]);
  });

  it("does not record the arguments of accounts commands in the audit trail", async () => {
    await run("/accounts add work ~/secret-dir-name");
    const dispatch = audit.recent({ feature: "commands" });
    expect(JSON.stringify(dispatch)).not.toContain("secret-dir-name");
  });
});
