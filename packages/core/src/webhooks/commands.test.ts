import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { CommandRegistry, COMMAND_DM_ONLY_TEXT, COMMAND_OWNER_ONLY_TEXT } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { WebhooksConfigSchema, type WebhooksConfig } from "../config/sections/webhooks.js";
import { WebhookStore, webhookSecretRef } from "./store.js";
import { WebhookService } from "./service.js";
import { createWebhookCommands } from "./commands.js";

const OWNER = "1001";
const STRANGER = "2002";

let dir: string;
let cfg: WebhooksConfig;
let secrets: Map<string, string>;
let service: WebhookService;
let registry: CommandRegistry;
let replies: CommandReply[];
let enabled: boolean;
let confirmAnswer: boolean;
let requestApproval: ReturnType<typeof vi.fn>;
let hooksChanged: ReturnType<typeof vi.fn>;

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return { id: "m1", channel: "telegram", senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over };
}

function identity(m: UnifiedMessage): ResolvedIdentity {
  return { role: m.senderId === OWNER ? "owner" : "user", canonicalId: `${m.channel}:${m.senderId}`, channel: m.channel, senderId: m.senderId };
}

async function send(text: string, over: Partial<UnifiedMessage> = {}): Promise<string> {
  replies = [];
  const m = msg(text, over);
  await registry.dispatch({ message: m, identity: identity(m), source: "channel", send: async (r) => { replies.push(r); } });
  return replies.map((r) => r.text).join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-webhook-cmd-"));
  cfg = WebhooksConfigSchema.parse({});
  secrets = new Map();
  enabled = false;
  confirmAnswer = true;
  hooksChanged = vi.fn(async () => {});
  service = new WebhookService({
    openStore: () => new WebhookStore(join(dir, "webhooks.db")),
    config: () => cfg,
    secrets: { get: async (k) => secrets.get(k), set: async (k, v) => { secrets.set(k, v); }, delete: async (k) => secrets.delete(k) },
    registerKnownSecret: () => {},
    notifyOwner: async () => {},
    sendToChat: async () => true,
    summarize: async () => "s",
    createTask: () => ({ id: "t" }),
    secretsDir: join(dir, "secrets"),
    publicBaseUrl: () => "https://hooks.example.test",
    trustedIpHeader: () => "",
  });
  requestApproval = vi.fn(async () => ({ outcome: confirmAnswer ? "approved" : "denied", optionId: confirmAnswer ? "approve" : "deny", code: "AAAA" }));
  registry = new CommandRegistry({
    owners: new OwnerDirectory({ telegram: [Number(OWNER)], discord: [], whatsapp: [], signal: [], slack: [] }),
    prompts: { requestApproval } as never,
  });
  registry.registerAll(createWebhookCommands({
    service,
    config: () => cfg,
    isEnabled: () => enabled,
    setEnabled: async (on) => { enabled = on; },
    onHooksChanged: hooksChanged,
    listener: () => ({ listening: false, port: null, publicBaseUrl: "https://hooks.example.test" }),
  }));
});

afterEach(() => {
  service.stop();
  rmSync(dir, { recursive: true, force: true });
});

const SUBS = ["status", "list", "add x github", "show x", "set x events=a", "remove x", "enable x", "disable x", "test x",
  "rotate-secret x", "secret x", "log", "forget 1", "on", "off"];

describe("/webhook access", () => {
  it("every subcommand is refused for a non-owner, and nothing changes", async () => {
    for (const sub of SUBS) {
      expect(await send(`/webhook ${sub}`, { senderId: STRANGER, chatId: STRANGER })).toBe(COMMAND_OWNER_ONLY_TEXT);
    }
    expect(service.store.listHooks()).toHaveLength(0);
    expect(enabled).toBe(false);
  });

  it("every subcommand is refused outside the owner's DM", async () => {
    for (const sub of SUBS) {
      expect(await send(`/webhook ${sub}`, { chatType: "group", chatId: "-500" })).toBe(COMMAND_DM_ONLY_TEXT);
    }
    expect(service.store.listHooks()).toHaveLength(0);
  });

  it("the alias /webhooks works and synthetic text is never a command", async () => {
    expect(await send("/webhooks list")).toMatch(/No hooks/);
    replies = [];
    const m = msg("/webhook on");
    const out = await registry.dispatch({ message: m, identity: identity(m), source: "synthetic", send: async (r) => { replies.push(r); } });
    expect(out.kind).toBe("not-command");
    expect(enabled).toBe(false);
  });
});

describe("/webhook subcommands", () => {
  it("add creates a disabled hook, replies with the file path, never the secret", async () => {
    const out = await send("/webhook add deploys github events=workflow_run action=task -- Tell me about failures only.");
    const hook = service.store.listHooks()[0]!;
    expect(hook).toMatchObject({ name: "deploys", enabled: false, events: ["workflow_run"], action: "task", toolProfile: "summarize", instructions: "Tell me about failures only.", channel: "telegram", chatId: OWNER });
    const secret = secrets.get(webhookSecretRef(hook.id))!;
    expect(out).toContain(`Created ${hook.id} (disabled)`);
    expect(out).toContain(`https://hooks.example.test/hooks/${hook.id}`);
    expect(out).toContain(service.secretFilePath(hook.id));
    expect(out).not.toContain(secret);
    for (const sub of ["list", `show ${hook.id}`, "status", `log ${hook.id}`, `secret ${hook.id}`, `rotate-secret ${hook.id}`]) {
      const text = await send(`/webhook ${sub}`);
      expect(text, sub).not.toContain(secrets.get(webhookSecretRef(hook.id))!);
      expect(text, sub).not.toContain(secret);
    }
  });

  it("add refuses tools=full and unknown sources", async () => {
    expect(await send("/webhook add x github tools=full")).toMatch(/cannot be set at creation/);
    expect(await send("/webhook add x ftp")).toMatch(/Unknown source/);
    expect(service.store.listHooks()).toHaveLength(0);
  });

  it("set tools=full is refused without the config flag, and asks to confirm with it", async () => {
    await send("/webhook add deploys github action=task");
    const id = service.store.listHooks()[0]!.id;
    expect(await send(`/webhook set ${id} tools=full`)).toMatch(/allowFullProfile/);
    expect(requestApproval).not.toHaveBeenCalled();
    cfg = { ...cfg, allowFullProfile: true };
    confirmAnswer = false;
    expect(await send(`/webhook set ${id} tools=full`)).toBe("Not changed.");
    expect(service.store.getHook(id)?.toolProfile).toBe("summarize");
    confirmAnswer = true;
    await send(`/webhook set ${id} tools=full`);
    expect(service.store.getHook(id)).toMatchObject({ toolProfile: "full", allowFull: true });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    await send(`/webhook set ${id} tools=investigate ip=10.0.0.0/8,2001:db8::/32 rate=5 daily=50 raw=off -- New instructions here`);
    expect(service.store.getHook(id)).toMatchObject({ toolProfile: "investigate", allowFull: false, ipAllowlist: ["10.0.0.0/8", "2001:db8::/32"], ratePerMin: 5, dailyCap: 50, includeRaw: false, instructions: "New instructions here" });
    expect(await send(`/webhook set ${id} ip=not-an-ip`)).toMatch(/Bad address/);
  });

  it("enable, disable and remove (with confirm) update the listener", async () => {
    await send("/webhook add deploys github");
    const id = service.store.listHooks()[0]!.id;
    expect(await send(`/webhook enable ${id}`)).toMatch(/enabled\. Webhooks are off globally/);
    expect(service.store.getHook(id)?.enabled).toBe(true);
    await send(`/webhook disable ${id}`);
    expect(service.store.getHook(id)?.enabled).toBe(false);
    confirmAnswer = false;
    expect(await send(`/webhook remove ${id}`)).toBe("Not removed.");
    expect(service.store.getHook(id)).not.toBeNull();
    confirmAnswer = true;
    expect(await send(`/webhook remove ${id}`)).toMatch(/Removed/);
    expect(service.store.getHook(id)).toBeNull();
    expect(secrets.has(webhookSecretRef(id))).toBe(false);
    expect(hooksChanged).toHaveBeenCalledTimes(3);
  });

  it("rotate-secret with grace, secret chat is refused, on/off, test, log, forget", async () => {
    await send("/webhook add deploys bearer");
    const id = service.store.listHooks()[0]!.id;
    const before = secrets.get(webhookSecretRef(id));
    expect(await send(`/webhook rotate-secret ${id} grace=10`)).toMatch(/stays valid for 10 minutes/);
    expect(secrets.get(webhookSecretRef(id))).not.toBe(before);
    expect(await send(`/webhook rotate-secret ${id} grace=999`)).toMatch(/grace must be/);
    expect(await send(`/webhook secret ${id} chat`)).toMatch(/never sent in chat/);
    expect(await send("/webhook on")).toMatch(/Webhooks on/);
    expect(enabled).toBe(true);
    expect(await send("/webhook off")).toMatch(/Webhooks off/);
    expect(await send(`/webhook test ${id}`)).toMatch(/signature: ok \(bearer\)/);
    await service.setHookEnabled(id, true, "t");
    expect(await send(`/webhook test ${id} run`)).toMatch(/HTTP 202/);
    const log = await send(`/webhook log ${id}`);
    expect(log).toMatch(/#1 .* accepted|#1 .* done/);
    expect(await send("/webhook forget 1")).toMatch(/forgotten/);
    expect(await send("/webhook forget 1")).toMatch(/No delivery/);
    expect(await send("/webhook bogus")).toMatch(/Unknown subcommand/);
  });
});
