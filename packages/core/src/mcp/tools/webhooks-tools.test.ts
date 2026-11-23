import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebhooksTools } from "./webhooks-tools.js";
import { WebhookStore } from "../../webhooks/store.js";

describe("webhook tools", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("are pure when created and return empty lists when there is no database", async () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-webhook-tools-"));
    const tools = createWebhooksTools({ dbDir: dir, env: {} });
    expect(Object.keys(tools).sort()).toEqual(["webhook_deliveries", "webhook_list"]);
    expect(existsSync(join(dir, "webhooks.db"))).toBe(false);
    expect(await tools.webhook_list!.handler({})).toEqual({ hooks: [] });
    expect(await tools.webhook_deliveries!.handler({})).toEqual({ deliveries: [] });
    expect(existsSync(join(dir, "webhooks.db"))).toBe(false);
  });

  it("list hooks and deliveries read-only, without secret references", async () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-webhook-tools-"));
    const store = new WebhookStore(join(dir, "webhooks.db"));
    const h = store.createHook({ name: "deploys", source: "github", action: "notify", toolProfile: "summarize", channel: "telegram", chatId: "1" });
    store.claimDelivery({ hookId: h.id, dedupeKey: "k", event: "push", receivedAt: "2026-11-23T10:00:00.000Z" });
    const tools = createWebhooksTools({ dbDir: dir, env: {} });
    const list = await tools.webhook_list!.handler({}) as { hooks: Array<Record<string, unknown>> };
    expect(list.hooks).toHaveLength(1);
    expect(list.hooks[0]).toMatchObject({ id: h.id, source: "github", enabled: false, verified: false });
    const text = JSON.stringify(list);
    expect(text).not.toMatch(/secret/i);
    const dels = await tools.webhook_deliveries!.handler({ hookId: h.id, limit: 500 }) as { deliveries: Array<Record<string, unknown>> };
    expect(dels.deliveries).toEqual([expect.objectContaining({ hookId: h.id, event: "push", status: "accepted" })]);
    expect(JSON.stringify(dels)).not.toContain("dedupe");
    store.close();
  });

  it("offer no tool that adds, changes, enables, rotates or reveals a hook", () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-webhook-tools-"));
    const names = Object.keys(createWebhooksTools({ dbDir: dir, env: {} }));
    for (const n of names) expect(n).toMatch(/^webhook_(list|deliveries)$/);
  });
});
