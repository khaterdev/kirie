import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AccountStore,
  AuditTrail,
  CommandRegistry,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  ACCOUNTS_MCP_NOTE,
  type SdkCallContext,
  type SdkCallKind,
} from "@kirie/core";
import type { DaemonContext, FeatureHandle } from "./types.js";

/** The SDK's Options as the pipeline sees them (the daemon does not depend on the SDK directly). */
type Options = Parameters<SdkOptionsPipeline["apply"]>[0];
import { renderAccountsAddendum, setupAccounts } from "./accounts.js";

const ctxOf = (kind: SdkCallKind): SdkCallContext => ({ kind, ownerDm: kind === "chat", interactive: kind === "chat", label: kind, cwd: "/tmp" });

describe("accounts feature", () => {
  let root: string;
  let dataDir: string;
  let sdkOptions: SdkOptionsPipeline;
  let settings: RuntimeSettings;
  let notifyOwner: ReturnType<typeof vi.fn>;
  let engines: { agentEngine: { setResilience: ReturnType<typeof vi.fn> }; v2: { setResilience: ReturnType<typeof vi.fn> }; tasks: { setResilience: ReturnType<typeof vi.fn> } };
  let handle: FeatureHandle | null;
  let ctx: DaemonContext;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-accfeat-")));
    dataDir = join(root, "kirie");
    mkdirSync(dataDir);
    sdkOptions = new SdkOptionsPipeline();
    const audit = new AuditTrail(join(dataDir, "logs", "audit.jsonl"));
    settings = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { audit });
    notifyOwner = vi.fn(async () => {});
    engines = { agentEngine: { setResilience: vi.fn() }, v2: { setResilience: vi.fn() }, tasks: { setResilience: vi.fn() } };
    handle = null;
    const owners = new OwnerDirectory({ telegram: ["1001"] });
    ctx = {
      config: KirieConfigSchema.parse({ agent: { model: "opus" } }),
      dataDir,
      agentCwd: dataDir,
      commands: new CommandRegistry({ owners }),
      owners,
      ownerPrompts: { requestApproval: vi.fn() },
      settings,
      audit,
      sdkOptions,
      promptAddenda: new PromptAddenda(),
      internalApi: new InternalApi(),
      agentEngine: engines.agentEngine,
      v2Sessions: engines.v2,
      backgroundTaskManager: engines.tasks,
      kirieToolsEnv: {},
      notifyOwner,
    } as unknown as DaemonContext;
  });

  afterEach(async () => {
    await handle?.stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  function apply(kind: SdkCallKind, base: Partial<Options> = {}): Options {
    const options: Options = { model: "opus", ...base };
    sdkOptions.apply(options, ctxOf(kind));
    return options;
  }

  /** An imported config_dir account in a temp dir (never the real home). */
  function seedAccount(id: string): string {
    const dir = join(root, `.${id}`);
    mkdirSync(dir);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `uuid-${id}`, emailAddress: `${id}@example.invalid` } }));
    const store = new AccountStore(join(dataDir, "accounts.db"));
    store.insert({
      id, kind: "config_dir", configDir: dir, accountUuid: `uuid-${id}`, label: null, subscription: null, enabled: true, priority: 10,
      status: "ok", limitedUntil: null, limitType: null, limitMessage: null, lastUsedAt: null, lastErrorAt: null, lastError: null,
    });
    store.setActiveId(id);
    store.close();
    return dir;
  }

  it("with nothing imported and fallback off, no call site gets env or fallbackModel", async () => {
    handle = await setupAccounts(ctx);
    for (const kind of ["chat", "background", "goal", "webhook", "judge", "triage", "oneshot", "utility"] as const) {
      const options = apply(kind);
      expect(options.env).toBeUndefined();
      expect(options.fallbackModel).toBeUndefined();
    }
    expect(engines.agentEngine.setResilience).toHaveBeenCalledTimes(1);
    expect(engines.v2.setResilience).toHaveBeenCalledTimes(1);
    expect(engines.tasks.setResilience).toHaveBeenCalledTimes(1);
  });

  it("account-env serves only no-lease calls, and only when env is not set", async () => {
    const dir = seedAccount("work");
    handle = await setupAccounts(ctx);
    expect(apply("triage").env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(apply("utility").env?.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(apply("chat").env).toBeUndefined();
    expect(apply("background").env).toBeUndefined();
    expect(apply("oneshot", { env: { PATH: "/bin" } }).env).toEqual({ PATH: "/bin" });
  });

  it("fallback-model passes the chain to agent turns, without the primary, only when on", async () => {
    handle = await setupAccounts(ctx);
    settings.set("agent.fallback.models", ["opus", "sonnet", "haiku"], "owner:test");
    expect(apply("chat").fallbackModel).toBeUndefined();
    settings.set("agent.fallback.enabled", true, "owner:test");
    expect(apply("chat").fallbackModel).toBe("sonnet,haiku");
    expect(apply("background").fallbackModel).toBe("sonnet,haiku");
    expect(apply("chat", { model: "sonnet" }).fallbackModel).toBe("opus,haiku");
    expect(apply("triage").fallbackModel).toBeUndefined();
    expect(apply("judge").fallbackModel).toBeUndefined();
  });

  it("registers the commands, the internal API, the tools flag and the addendum", async () => {
    handle = await setupAccounts(ctx);
    expect(ctx.commands.list().map((c) => c.name)).toEqual(["accounts", "rotation", "fallback"]);
    expect(ctx.internalApi.apps().map((a) => a.name)).toEqual(["accounts"]);
    expect(ctx.kirieToolsEnv.KIRIE_ACCOUNTS_AGENT_TOOLS).toBe("manage");
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toContain("/accounts");
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: false })).toBe("");
  });

  it("agentTools off sets no tools flag and the addendum names only the commands", async () => {
    ctx = { ...ctx, config: KirieConfigSchema.parse({ accounts: { agentTools: "off" } }), kirieToolsEnv: {} } as DaemonContext;
    handle = await setupAccounts(ctx);
    expect(ctx.kirieToolsEnv.KIRIE_ACCOUNTS_AGENT_TOOLS).toBeUndefined();
    expect(renderAccountsAddendum("off", { kind: "chat", ownerDm: true })).not.toContain("accounts_list");
    expect(renderAccountsAddendum("read", { kind: "chat", ownerDm: true })).not.toContain("accounts_import");
  });

  it("a rotation tells the owner once, with the MCP tool-set note", async () => {
    seedAccount("one");
    seedAccount("two");
    handle = await setupAccounts(ctx);
    settings.set("accounts.rotation.enabled", true, "owner:test");
    const before = notifyOwner.mock.calls.length;
    const store = new AccountStore(join(dataDir, "accounts.db"));
    store.update("two", { status: "limited", limitedUntil: Date.now() + 3_600_000, limitType: "five_hour" });
    store.close();
    // The next lease rotates away from the limited active account.
    expect(apply("triage").env?.CLAUDE_CONFIG_DIR).toBe(join(root, ".one"));
    expect(notifyOwner.mock.calls.length).toBe(before + 1);
    const [text, opts] = notifyOwner.mock.calls.at(-1)! as [string, { key: string }];
    expect(text).toContain("Claude account two hit its session limit");
    expect(text).toContain("Switched to one");
    expect(text).toContain(ACCOUNTS_MCP_NOTE);
    expect(opts.key).toBe("accounts:rotated:two");
  });

  it("account-env fails closed when every imported account is signed out", async () => {
    seedAccount("gone");
    const store = new AccountStore(join(dataDir, "accounts.db"));
    store.update("gone", { status: "auth_error", lastError: "Not logged in" });
    store.close();
    handle = await setupAccounts(ctx);
    expect(() => apply("oneshot")).toThrow(/no usable Claude account/);
    expect(apply("chat").env).toBeUndefined();
  });

  it("stop removes the loop from the engines", async () => {
    handle = await setupAccounts(ctx);
    await handle.stop?.();
    expect(engines.v2.setResilience).toHaveBeenLastCalledWith(null);
    handle = null;
  });
});
