import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebhookStore, WEBHOOK_ID_RE, webhookSecretRef } from "./store.js";

let dir: string;
let store: WebhookStore;

const base = { source: "github" as const, action: "notify" as const, toolProfile: "summarize" as const, channel: "telegram", chatId: "1001" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-webhook-store-"));
  store = new WebhookStore(join(dir, "webhooks.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("WebhookStore hooks", () => {
  it("creates the database file 0600", () => {
    expect(statSync(join(dir, "webhooks.db")).mode & 0o777).toBe(0o600);
  });

  it("creates hooks disabled with a <slug>-<8 hex> id and a credential reference, never a secret", () => {
    const h = store.createHook({ ...base, name: "deploys" });
    expect(h.id).toMatch(/^deploys-[0-9a-f]{8}$/);
    expect(WEBHOOK_ID_RE.test(h.id)).toBe(true);
    expect(h.enabled).toBe(false);
    expect(h.secretRef).toBe(webhookSecretRef(h.id));
    expect(store.getHook(h.id)).toEqual(h);
    expect(store.findHook("deploys")?.id).toBe(h.id);
  });

  it("rejects bad and duplicate names", () => {
    expect(() => store.createHook({ ...base, name: "Bad Name" })).toThrow();
    expect(() => store.createHook({ ...base, name: "-x" })).toThrow();
    store.createHook({ ...base, name: "deploys" });
    expect(() => store.createHook({ ...base, name: "deploys" })).toThrow(/already exists/);
  });

  it("updates, lists and deletes", () => {
    const h = store.createHook({ ...base, name: "alerts" });
    const u = store.updateHook(h.id, { enabled: true, events: ["push"], ipAllowlist: ["10.0.0.0/8"], ratePerMin: 5 })!;
    expect(u).toMatchObject({ enabled: true, events: ["push"], ipAllowlist: ["10.0.0.0/8"], ratePerMin: 5 });
    expect(store.listHooks().map((x) => x.id)).toEqual([h.id]);
    expect(store.markVerified(h.id)).toBe(true);
    expect(store.markVerified(h.id)).toBe(false);
    expect(store.deleteHook(h.id)).toBe(true);
    expect(store.getHook(h.id)).toBeNull();
  });
});

describe("WebhookStore deliveries", () => {
  const at = (iso: string) => ({ hookId: "deploys-00000000", receivedAt: iso });

  it("claim is the replay check: a second claim of the same key is refused", () => {
    const a = store.claimDelivery({ ...at("2026-11-23T10:00:00.000Z"), dedupeKey: "k1" });
    expect(a.claimed).toBe(true);
    const b = store.claimDelivery({ ...at("2026-11-23T10:00:01.000Z"), dedupeKey: "k1" });
    expect(b).toEqual({ claimed: false, id: a.id });
    expect(store.claimDelivery({ ...at("2026-11-23T10:00:02.000Z"), dedupeKey: "k2" }).claimed).toBe(true);
  });

  it("a throttled row can be claimed again by a retry; other statuses cannot", () => {
    const a = store.claimDelivery({ ...at("2026-11-23T10:00:00.000Z"), dedupeKey: "k1" });
    store.updateDelivery(a.id, { status: "throttled", note: "rate" });
    expect(store.claimDelivery({ ...at("2026-11-23T10:01:00.000Z"), dedupeKey: "k1" })).toEqual({ claimed: true, id: a.id });
    store.updateDelivery(a.id, { status: "done" });
    expect(store.claimDelivery({ ...at("2026-11-23T10:02:00.000Z"), dedupeKey: "k1" }).claimed).toBe(false);
  });

  it("counts the daily budget, prunes by retention, forgets one row", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    store.claimDelivery({ ...at("2026-10-01T00:00:00.000Z"), dedupeKey: "old" });
    const r1 = store.claimDelivery({ ...at("2026-11-23T11:00:00.000Z"), dedupeKey: "a" });
    const r2 = store.claimDelivery({ ...at("2026-11-23T11:30:00.000Z"), dedupeKey: "b" });
    store.updateDelivery(r2.id, { status: "ignored" });
    expect(store.countActionsSince("deploys-00000000", new Date(now.getTime() - 86_400_000))).toBe(1);
    expect(store.pruneDeliveries(30, now)).toBe(1);
    expect(store.forgetDelivery(r1.id)).toBe(true);
    expect(store.claimDelivery({ ...at("2026-11-23T11:40:00.000Z"), dedupeKey: "a" }).claimed).toBe(true);
  });

  it("replay keys outlive the delivery log (prune keeps them a year)", () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    store.claimDelivery({ ...at("2026-10-01T00:00:00.000Z"), dedupeKey: "old" });
    expect(store.pruneDeliveries(30, now)).toBe(1);
    expect(store.recentDeliveries({})).toHaveLength(0);
    expect(store.claimDelivery({ ...at("2026-11-23T11:00:00.000Z"), dedupeKey: "old" }).claimed).toBe(false);
    // After a year the key is dropped too.
    store.pruneDeliveries(30, new Date("2027-10-02T00:00:00.000Z"));
    expect(store.claimDelivery({ ...at("2027-10-02T00:00:00.000Z"), dedupeKey: "old" }).claimed).toBe(true);
  });

  it("startup reconciliation marks accepted rows failed (at most once, never re-run)", () => {
    const a = store.claimDelivery({ ...at("2026-11-23T10:00:00.000Z"), dedupeKey: "k1" });
    const b = store.claimDelivery({ ...at("2026-11-23T10:00:00.000Z"), dedupeKey: "k2" });
    store.updateDelivery(b.id, { status: "done", taskId: "t1" });
    const failed = store.failInterruptedDeliveries();
    expect(failed.map((d) => d.id)).toEqual([a.id]);
    expect(store.getDelivery(a.id)).toMatchObject({ status: "failed", note: "interrupted by a restart" });
    expect(store.getDelivery(b.id)?.status).toBe("done");
  });

  it("opens read-only for the tools", () => {
    store.createHook({ ...base, name: "deploys" });
    const ro = new WebhookStore(join(dir, "webhooks.db"), { readonly: true });
    expect(ro.listHooks()).toHaveLength(1);
    expect(() => ro.createHook({ ...base, name: "other" })).toThrow();
    ro.close();
  });
});
