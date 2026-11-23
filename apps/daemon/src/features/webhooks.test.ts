import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommandRegistry,
  KirieConfigSchema,
  OwnerDirectory,
  PublicIngress,
  RuntimeSettings,
  SecretScrubber,
  signWebhookPayload,
  webhookSecretRef,
  WEBHOOK_INVESTIGATE_TOOLS,
  type BackgroundTask,
  type CommandReply,
  type KirieConfig,
  type UnifiedMessage,
} from "@kirie/core";
import { TaskHooks } from "../task-hooks.js";
import { setupWebhooks } from "./webhooks.js";
import { createOwnerNotifier } from "./notify.js";
import type { DaemonContext, FeatureHandle } from "./types.js";

const OWNER = "1001";

let dir: string;
let ingress: PublicIngress;
let commands: CommandRegistry;
let taskHooks: TaskHooks;
let secrets: Map<string, string>;
let sent: string[];
let sentParams: Array<Record<string, unknown>>;
let handle: FeatureHandle | null;

function context(config: KirieConfig): DaemonContext {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  commands = new CommandRegistry({ owners, prompts: { requestApproval: async () => ({ outcome: "approved", optionId: "approve", code: "AAAA" }) } as never });
  taskHooks = new TaskHooks();
  // Port 0: an ephemeral loopback port; never the real 18787.
  ingress = new PublicIngress({ ...config.ingress, port: 0 });
  const adapter = { id: "telegram", sendText: async (p: { text: string }) => { sent.push(p.text); sentParams.push(p); return [{ id: "1", timestamp: 0 }]; } };
  const ctx = {
    config,
    dataDir: dir,
    agentCwd: dir,
    commands,
    owners,
    settings: new RuntimeSettings(join(dir, "state", "runtime-settings.json")),
    audit: { record: vi.fn(), recent: () => [] },
    scrubber: new SecretScrubber(),
    sdkOptions: {},
    ingress,
    taskHooks,
    credentialStore: {
      get: async (k: string) => secrets.get(k),
      set: async (k: string, v: string) => { secrets.set(k, v); },
      delete: async (k: string) => secrets.delete(k),
    },
    channelRegistry: { getById: (id: string) => (id === "telegram" ? adapter : undefined), isRunning: () => true },
    backgroundTaskStore: { create: vi.fn(() => ({ id: "task-1" })) },
    mcpServers: { "kirie-tools": { command: "node", args: ["stdio.js"] } },
    notifyOwner: vi.fn(async () => {}),
  };
  return ctx as unknown as DaemonContext;
}

async function send(text: string): Promise<string> {
  const replies: CommandReply[] = [];
  const message: UnifiedMessage = { id: "m", channel: "telegram", senderId: OWNER, senderName: "o", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null };
  await commands.dispatch({
    message, source: "channel",
    identity: { role: "owner", canonicalId: `telegram:${OWNER}`, channel: "telegram", senderId: OWNER },
    send: async (r) => { replies.push(r); },
  });
  return replies.map((r) => r.text).join("\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-webhook-feature-"));
  secrets = new Map();
  sent = [];
  sentParams = [];
  handle = null;
});

afterEach(async () => {
  await handle?.stop?.();
  await ingress.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("setupWebhooks", () => {
  it("off by default: nothing is bound, no database is created, /webhook exists", async () => {
    const ctx = context(KirieConfigSchema.parse({}));
    handle = await setupWebhooks(ctx);
    await handle.start?.();
    expect(ingress.isListening()).toBe(false);
    expect(ingress.mountedPrefixes()).toEqual([]);
    expect(existsSync(join(dir, "webhooks.db"))).toBe(false);
    expect(commands.get("webhook")?.ownerOnly).toBe(true);
    expect(commands.get("webhooks")?.name).toBe("webhook");
  });

  it("binds 127.0.0.1 only once webhooks are on AND a hook is enabled; off and stop release the port", async () => {
    const ctx = context(KirieConfigSchema.parse({}));
    handle = await setupWebhooks(ctx);
    await handle.start?.();

    await send("/webhook add deploys github");
    expect(ingress.isListening()).toBe(false);
    await send("/webhook on");
    expect(ingress.isListening()).toBe(false);
    const id = (await send("/webhook list")).split(/\s+/)[0]!;
    await send(`/webhook enable ${id}`);
    expect(ingress.isListening()).toBe(true);
    const port = ingress.port!;

    const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: "example/app" } }));
    const headers = { "content-type": "application/json", "x-github-event": "workflow_run", ...signWebhookPayload("github", secrets.get(webhookSecretRef(id))!, raw) };
    const ok = await fetch(`http://127.0.0.1:${port}/hooks/${id}`, { method: "POST", headers, body: raw });
    expect(ok.status).toBe(202);
    for (const path of ["/status", "/api/channel-action", "/restart", "/sessions"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: path === "/status" || path === "/sessions" ? "GET" : "POST" });
      expect(res.status, path).toBe(404);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((t) => t.includes("example/app"))).toBe(true);

    await send(`/webhook disable ${id}`);
    expect(ingress.isListening()).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();

    await send(`/webhook enable ${id}`);
    expect(ingress.isListening()).toBe(true);
    await send("/webhook off");
    expect(ingress.isListening()).toBe(false);

    await send("/webhook on");
    expect(ingress.isListening()).toBe(true);
    await handle.stop?.();
    handle = null;
    expect(ingress.mountedPrefixes()).toEqual([]);
  });

  it("webhook messages reach the adapter as plain text with link previews disabled (HOOK-B1)", async () => {
    const ctx = context(KirieConfigSchema.parse({ webhooks: { enabled: true } }));
    handle = await setupWebhooks(ctx);
    await handle.start?.();
    await send("/webhook add deploys github");
    const id = (await send("/webhook list")).split(/\s+/)[0]!;
    await send(`/webhook enable ${id}`);
    const raw = Buffer.from(JSON.stringify({ action: "completed", repository: { full_name: "example/app" } }));
    const headers = { "content-type": "application/json", "x-github-event": "workflow_run", ...signWebhookPayload("github", secrets.get(webhookSecretRef(id))!, raw) };
    const before = sentParams.length;
    const ok = await fetch(`http://127.0.0.1:${ingress.port!}/hooks/${id}`, { method: "POST", headers, body: raw });
    expect(ok.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const delivered = sentParams.slice(before).filter((p) => String(p.text).includes("example/app"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ plain: true, disableLinkPreview: true });
  });

  it("the owner notifier passes disableLinkPreview through, and adds nothing when it is not asked for", async () => {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    const adapter = { id: "telegram", sendText: async (p: Record<string, unknown>) => { sentParams.push(p); return [{ id: "1", timestamp: 0 }]; } };
    const notify = createOwnerNotifier({ owners, channelRegistry: { getById: () => adapter, isRunning: () => true } as never });
    await notify("report", { disableLinkPreview: true });
    await notify("plain notice");
    expect(sentParams).toEqual([
      { ctx: { chatId: OWNER }, text: "report", plain: true, disableLinkPreview: true },
      { ctx: { chatId: OWNER }, text: "plain notice", plain: true },
    ]);
  });

  it("webhooks.enabled in config with an enabled hook binds at start", async () => {
    const config = KirieConfigSchema.parse({ webhooks: { enabled: true } });
    let ctx = context(config);
    let h = await setupWebhooks(ctx);
    await h.start?.();
    expect(ingress.isListening()).toBe(false);
    await send("/webhook add deploys bearer");
    const id = (await send("/webhook list")).split(/\s+/)[0]!;
    await send(`/webhook enable ${id}`);
    await h.stop?.();
    await ingress.stop();
    // A fresh daemon start reads the hook from webhooks.db and its secret from the credential store.
    ctx = context(config);
    h = await setupWebhooks(ctx);
    handle = h;
    await h.start?.();
    expect(ingress.isListening()).toBe(true);
  });

  it("the task profile fails closed to the read-only allowlist when the hook database cannot be read", async () => {
    const config = KirieConfigSchema.parse({ webhooks: { allowFullProfile: true } });
    const ctx = context(config);
    // dataDir is a regular file: opening webhooks.db under it throws.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    handle = await setupWebhooks({ ...ctx, dataDir: blocker } as DaemonContext);
    const task = { id: "t", meta: { origin: "webhook", profile: "webhook", data: { hookId: "x-00000000", toolProfile: "full" } } } as unknown as BackgroundTask;
    expect(taskHooks.profileFor(task)?.toolAllowlist).toEqual(WEBHOOK_INVESTIGATE_TOOLS);
  });

  it("registers the webhook task profile: read-only allowlist unless full is allowed twice", async () => {
    const ctx = context(KirieConfigSchema.parse({}));
    handle = await setupWebhooks(ctx);
    const task = { id: "t", meta: { origin: "webhook", profile: "webhook", data: { hookId: "nope-00000000", toolProfile: "full" } } } as unknown as BackgroundTask;
    const profile = taskHooks.profileFor(task)!;
    expect(profile.kind).toBe("webhook");
    expect(profile.toolAllowlist).toEqual(WEBHOOK_INVESTIGATE_TOOLS);
    expect(profile.options?.mcpServers).toEqual({ "kirie-tools": { command: "node", args: ["stdio.js"] } });
    const controller = taskHooks.controllerFor({ ...task, prompt: "<webhook_event>x</webhook_event>" } as BackgroundTask)!;
    expect(controller.initialMessage?.({ ...task, prompt: "<webhook_event>x</webhook_event>" } as BackgroundTask, false)).toBe("<webhook_event>x</webhook_event>");
    expect(taskHooks.completionHandlerFor(task)).toBeTypeOf("function");
    expect(taskHooks.failureHandlerFor(task)).toBeTypeOf("function");
  });
});
