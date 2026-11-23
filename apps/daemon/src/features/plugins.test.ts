import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditTrail,
  CommandRegistry,
  inspectPluginTree,
  KirieConfigSchema,
  OwnerDirectory,
  PluginApprovalStore,
  pluginApprovalsPath,
  RuntimeSettings,
  SdkOptionsPipeline,
  type ResolvedIdentity,
  type UnifiedMessage,
} from "@kirie/core";
import { resolvePluginsDir, setupPlugins } from "./plugins.js";
import type { DaemonContext, FeatureHandle } from "./types.js";

const OWNER = "1001";

type Transform = ((text: string, meta: { sessionKey: string; channel: string; senderId: string }) => Promise<string>) | null;

let dataDir: string;
let transform: Transform;
let ctx: DaemonContext;
let sdk: SdkOptionsPipeline;
let closeIdle: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let handle: FeatureHandle | null;

function writePlugin(name: string, code: string, events = ["afterMessage"], capabilities = ["hooks:observe"]): void {
  const dir = join(dataDir, "plugins", name);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", kirie: { events, capabilities } }));
  writeFileSync(join(dir, "index.js"), code);
}

function counterPlugin(name: string): string {
  return `globalThis.__kirieFeatureImports = (globalThis.__kirieFeatureImports ?? 0) + 1;
export default () => ({ name: "${name}", version: "1.0.0", hooks: [{ event: "afterMessage", handler() {} }] });`;
}

function imports(): number {
  return (globalThis as { __kirieFeatureImports?: number }).__kirieFeatureImports ?? 0;
}

/** Write an approval as if a previous daemon run had recorded it. */
function preApprove(name: string, events = ["afterMessage"], capabilities = ["hooks:observe"]): void {
  new PluginApprovalStore(pluginApprovalsPath(dataDir)).upsert({
    name, version: "1.0.0", sha256: inspectPluginTree(join(dataDir, "plugins"), name).sha256,
    capabilities: capabilities as never, events: events as never, enabled: true,
    approvedAt: new Date().toISOString(), approvedBy: `owner:telegram:${OWNER}`,
  });
}

function makeCtx(pluginsConfig: Record<string, unknown> = {}): DaemonContext {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const commands = new CommandRegistry({
    owners,
    prompts: { requestApproval: async () => ({ outcome: "approved", optionId: "approve", code: "AB12" }) } as never,
  });
  sdk = new SdkOptionsPipeline();
  transform = null;
  closeIdle = vi.fn(() => 0);
  notify = vi.fn(async () => {});
  const audit = new AuditTrail(join(dataDir, "logs", "audit.jsonl"));
  return {
    config: KirieConfigSchema.parse({ plugins: pluginsConfig }),
    dataDir,
    agentCwd: dataDir,
    commands,
    owners,
    settings: new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { audit }),
    audit,
    sdkOptions: sdk,
    pipeline: {
      setMessageTransform: (fn: Transform) => { transform = fn; },
      onTurnComplete: () => () => {},
      onTurnError: () => () => {},
    },
    channelRegistry: { on: () => {}, off: () => {} },
    v2Sessions: { closeIdleSessions: closeIdle },
    kirieToolsEnv: {},
    notifyOwner: notify,
  } as unknown as DaemonContext;
}

async function command(text: string): Promise<string> {
  const message: UnifiedMessage = { id: "m", channel: "telegram", senderId: OWNER, senderName: "O", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null };
  const identity: ResolvedIdentity = { role: "owner", canonicalId: `telegram:${OWNER}`, channel: "telegram", senderId: OWNER };
  const sent: string[] = [];
  await ctx.commands.dispatch({ message, identity, source: "channel", send: async (r) => { sent.push(r.text); } });
  return sent.join("\n");
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "kirie-feature-plugins-")));
  mkdirSync(join(dataDir, "plugins"), { mode: 0o700 });
  (globalThis as { __kirieFeatureImports?: number }).__kirieFeatureImports = 0;
  handle = null;
});

afterEach(async () => {
  await handle?.stop?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resolvePluginsDir", () => {
  it("maps the default to <dataDir>/plugins and expands ~", () => {
    expect(resolvePluginsDir("~/.kirie/plugins", "/data")).toBe("/data/plugins");
    expect(resolvePluginsDir("~/my-plugins", "/data")).toBe(join(homedir(), "my-plugins"));
    expect(resolvePluginsDir("/abs/p", "/data")).toBe("/abs/p");
    expect(resolvePluginsDir("rel", "/data")).toBe("/data/rel");
  });
});

describe("setupPlugins", () => {
  it("off by default: /plugins is registered, nothing is imported even with approvals, no observer, no transform", async () => {
    writePlugin("p1", counterPlugin("p1"));
    preApprove("p1");
    ctx = makeCtx();
    const spy = vi.spyOn(sdk, "registerToolObserver");
    handle = await setupPlugins(ctx);
    await handle.start?.();
    expect(ctx.commands.get("plugins")?.ownerOnly).toBe(true);
    expect(imports()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(transform).toBeNull();
    expect(ctx.kirieToolsEnv).toEqual({});
  });

  it("on in config at boot: the observer is registered at setup and approved plugins load at start", async () => {
    writePlugin("p2", counterPlugin("p2"));
    preApprove("p2");
    ctx = makeCtx({ enabled: true });
    const spy = vi.spyOn(sdk, "registerToolObserver");
    handle = await setupPlugins(ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(imports()).toBe(0);
    await handle.start?.();
    expect(imports()).toBe(1);
    expect(transform).not.toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Plugins loaded: p2 1.0.0"), expect.anything());
    const audit = readFileSync(join(dataDir, "logs", "audit.jsonl"), "utf8");
    expect(audit).toContain("plugin.loaded");
    await handle.stop?.();
    expect(transform).toBeNull();
    handle = null;
  });

  it("/plugins on writes the runtime override, loads, and restarts idle sessions; /plugins off unloads", async () => {
    writePlugin("p3", counterPlugin("p3"));
    ctx = makeCtx();
    handle = await setupPlugins(ctx);
    await handle.start?.();
    expect(await command("/plugins enable p3")).toMatch(/Approved p3/);
    expect(imports()).toBe(0);
    expect(await command("/plugins on")).toMatch(/Loaded: p3 1\.0\.0/);
    expect(imports()).toBe(1);
    expect(ctx.settings.describe("plugins.enabled")?.setBy).toBe(`owner:telegram:${OWNER}`);
    expect(closeIdle).toHaveBeenCalledWith(0);
    expect(transform).not.toBeNull();
    expect(await command("/plugins off")).toMatch(/Plugins are off/);
    expect(transform).toBeNull();
    expect(await command("/plugins")).toMatch(/Plugins are OFF/);
  });

  it("a hanging transform plugin never holds the message past the hook budget", async () => {
    writePlugin(
      "hang",
      `export default () => ({ name: "hang", version: "1.0.0", hooks: [{ event: "beforeMessage", mode: "transform", handler: () => new Promise(() => {}) }] });`,
      ["beforeMessage"],
      ["hooks:transform-message"],
    );
    preApprove("hang", ["beforeMessage"], ["hooks:observe", "hooks:transform-message"]);
    ctx = makeCtx({ enabled: true, hookTimeoutMs: 200 });
    handle = await setupPlugins(ctx);
    await handle.start?.();
    const t0 = Date.now();
    const out = await transform!("hello", { sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", senderId: OWNER });
    expect(out).toBe("hello");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a plugins.dir other than the default is passed to the tool subprocess", async () => {
    ctx = makeCtx({ dir: join(dataDir, "custom") });
    handle = await setupPlugins(ctx);
    expect(ctx.kirieToolsEnv).toEqual({ KIRIE_PLUGINS_DIR: join(dataDir, "custom") });
  });
});
