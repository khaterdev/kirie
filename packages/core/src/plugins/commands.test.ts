import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandReply, DispatchOutcome } from "../commands/types.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { HookRegistry } from "../hooks/registry.js";
import { PluginApprovalStore, pluginApprovalsPath } from "./approvals.js";
import { PluginLoader } from "./loader.js";
import { PluginManager } from "./manager.js";
import { createPluginsCommands } from "./commands.js";
import { PLUGIN_TRUST_STATEMENT } from "./types.js";
import { makePluginSandbox, writePlugin, type PluginSandbox } from "./fixture.test-util.js";

const OWNER = "1001";
const STRANGER = "2002";

let sb: PluginSandbox;
let manager: PluginManager;
let loader: PluginLoader;
let approvals: PluginApprovalStore;
let registry: CommandRegistry;
let master: boolean;
let confirmAnswer: "approved" | "denied";
let requestApproval: ReturnType<typeof vi.fn>;
let sent: CommandReply[];
let setMaster: ReturnType<typeof vi.fn>;

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return { id: "m1", channel: "telegram", senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over };
}

function identityFor(m: UnifiedMessage): ResolvedIdentity {
  return { role: m.senderId === OWNER ? "owner" : "user", canonicalId: `${m.channel}:${m.senderId}`, channel: m.channel, senderId: m.senderId };
}

async function run(text: string, over: Partial<UnifiedMessage> = {}): Promise<{ outcome: DispatchOutcome; reply: string }> {
  sent = [];
  const message = msg(text, over);
  const outcome = await registry.dispatch({ message, identity: identityFor(message), source: "channel", send: async (r) => { sent.push(r); } });
  return { outcome, reply: sent.map((r) => r.text).join("\n") };
}

beforeEach(() => {
  sb = makePluginSandbox();
  const hooks = new HookRegistry();
  loader = new PluginLoader({ pluginsDir: sb.pluginsDir, cacheDir: sb.cacheDir, hookRegistry: hooks });
  approvals = new PluginApprovalStore(pluginApprovalsPath(sb.dataDir));
  master = false;
  manager = new PluginManager({
    pluginsDir: sb.pluginsDir, loader, registry: hooks, approvals,
    audit: { record: () => {} }, notifyOwner: async () => {}, isEnabled: () => master, settings: () => ({ allow: [], config: {} }),
  });
  manager.baseline();
  confirmAnswer = "approved";
  requestApproval = vi.fn(async () => ({ outcome: confirmAnswer, optionId: confirmAnswer === "approved" ? "approve" : "deny", code: "AB12" }));
  setMaster = vi.fn(async (on: boolean) => {
    master = on;
    if (!on) { await manager.stop("off"); return { loaded: [], refused: [] }; }
    const r = await manager.start();
    return { loaded: r.loaded.map((p) => `${p.name} ${p.version}`), refused: r.refused };
  });
  registry = new CommandRegistry({
    owners: new OwnerDirectory({ telegram: [Number(OWNER)] }),
    prompts: { requestApproval } as never,
  });
  registry.registerAll(createPluginsCommands({ manager, isEnabled: () => master, setMaster, pluginsDir: sb.pluginsDir }));
});

afterEach(async () => {
  await manager.stop("test");
  sb.cleanup();
});

describe("/plugins", () => {
  it("is owner-only and DM-only: a stranger and a group are refused, and nothing runs", async () => {
    writePlugin(sb.pluginsDir, "p");
    const stranger = await run("/plugins enable p", { senderId: STRANGER, chatId: STRANGER });
    expect(stranger.outcome.kind).toBe("denied");
    const group = await run("/plugins enable p", { chatType: "group", chatId: "-100" });
    expect(group.outcome.kind).toBe("denied");
    expect(requestApproval).not.toHaveBeenCalled();
    expect(approvals.list()).toEqual([]);
  });

  it("synthetic text is never a command", async () => {
    const message = msg("/plugins on");
    const outcome = await registry.dispatch({ message, identity: identityFor(message), source: "synthetic", send: async () => {} });
    expect(outcome.kind).toBe("not-command");
    expect(setMaster).not.toHaveBeenCalled();
  });

  it("list shows the switch and each plugin's state", async () => {
    writePlugin(sb.pluginsDir, "alpha");
    const { reply } = await run("/plugins");
    expect(reply).toContain("Plugins are OFF");
    expect(reply).toContain("alpha 1.0.0: not approved");
  });

  it("list with no plugins says Kirie never installs or downloads them", async () => {
    const { reply } = await run("/plugins list");
    expect(reply).toMatch(/never installed or downloaded/);
  });

  it("enable shows the trust statement and requires confirmation", async () => {
    writePlugin(sb.pluginsDir, "beta");
    confirmAnswer = "denied";
    const no = await run("/plugins enable beta");
    expect(no.reply).toMatch(/Not enabled/);
    expect(approvals.get("beta")).toBeUndefined();
    const req = requestApproval.mock.calls[0]![0] as { title: string; body: string };
    expect(req.title).toBe("Enable plugin beta?");
    expect(req.body).toContain(PLUGIN_TRUST_STATEMENT);
    expect(req.body).toContain("Hash:");

    confirmAnswer = "approved";
    const yes = await run("/plugins enable beta");
    expect(yes.reply).toMatch(/Approved beta 1.0.0 .*Plugins are off/);
    expect(approvals.get("beta")).toMatchObject({ enabled: true, approvedBy: `owner:telegram:${OWNER}` });
  });

  it("a blocking scan finding needs force", async () => {
    writePlugin(sb.pluginsDir, "risky", { code: `export default () => ({ name: "risky", version: "1.0.0" });\nnew Function("return 1");\n` });
    const first = await run("/plugins enable risky");
    expect(first.reply).toMatch(/blocking patterns/);
    expect(first.reply).toMatch(/force/);
    expect(requestApproval).not.toHaveBeenCalled();
    const forced = await run("/plugins enable risky force");
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(forced.reply).toMatch(/Approved risky/);
  });

  it("enable with the switch on loads; disable unloads", async () => {
    master = true;
    writePlugin(sb.pluginsDir, "gamma");
    expect((await run("/plugins enable gamma")).reply).toMatch(/Approved and loaded gamma/);
    expect(loader.isLoaded("gamma")).toBe(true);
    expect((await run("/plugins disable gamma")).reply).toMatch(/Disabled gamma/);
    expect(loader.isLoaded("gamma")).toBe(false);
    expect(approvals.get("gamma")?.enabled).toBe(false);
  });

  it("enable refuses a plugin that fails the directory checks", async () => {
    expect((await run("/plugins enable ghost")).reply).toMatch(/Cannot enable ghost: .*does not exist/);
    expect((await run("/plugins enable ../etc")).reply).toMatch(/Usage/);
  });

  it("on asks to confirm, then loads approved plugins; off unloads", async () => {
    writePlugin(sb.pluginsDir, "delta");
    await run("/plugins enable delta");
    requestApproval.mockClear();
    confirmAnswer = "denied";
    expect((await run("/plugins on")).reply).toBe("Plugins stay off.");
    expect(setMaster).not.toHaveBeenCalled();
    confirmAnswer = "approved";
    const on = await run("/plugins on");
    expect(on.reply).toMatch(/Plugins are on\. Loaded: delta 1\.0\.0/);
    expect((requestApproval.mock.calls[1]![0] as { body: string }).body).toContain(PLUGIN_TRUST_STATEMENT);
    expect(loader.isLoaded("delta")).toBe(true);
    expect((await run("/plugins on")).reply).toMatch(/already on/);
    expect((await run("/plugins off")).reply).toMatch(/Plugins are off/);
    expect(loader.isLoaded("delta")).toBe(false);
  });

  it("info shows hashes and flags a change since approval", async () => {
    const dir = writePlugin(sb.pluginsDir, "eps");
    await run("/plugins enable eps");
    writeFileSync(join(dir, "index.js"), "// changed\n");
    const { reply } = await run("/plugins info eps");
    expect(reply).toContain("Events: afterMessage");
    expect(reply).toMatch(/Approved hash: [0-9a-f]{16} \(DIFFERENT\)/);
  });

  it("reload needs the switch on", async () => {
    expect((await run("/plugins reload")).reply).toMatch(/Plugins are off/);
    master = true;
    writePlugin(sb.pluginsDir, "zeta");
    await run("/plugins enable zeta");
    expect((await run("/plugins reload zeta")).reply).toBe("zeta: reloaded");
  });

  it("unknown subcommand shows usage with the trust statement", async () => {
    const { reply } = await run("/plugins install x");
    expect(reply).toMatch(/Unknown subcommand "install"/);
    expect(reply).toContain(PLUGIN_TRUST_STATEMENT);
  });

  it("/help plugins includes the trust statement", () => {
    expect(registry.renderHelp({ isOwner: true, topic: "plugins" })).toContain("full privileges");
  });
});
