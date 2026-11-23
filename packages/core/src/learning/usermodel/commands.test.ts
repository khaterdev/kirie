import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import { CommandRegistry } from "../../commands/registry.js";
import type { CommandReply, DispatchOutcome } from "../../commands/types.js";
import type { UnifiedMessage } from "../../channels/normalizer.js";
import type { ResolvedIdentity } from "../../security/auth.js";
import { OwnerDirectory } from "../../interaction/owners.js";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { effectiveSettingFlag } from "../../config/sections/effective.js";
import type { UserModelConfig } from "../../config/sections/usermodel.js";
import type { OneShotRunner } from "../reflection.js";
import { fakeAudit, intakeConfig, type FakeAudit } from "../learning.test-util.js";
import { LearningIntake } from "../intake.js";
import { ProposalStore } from "../proposal-store.js";
import { USER_MODEL_KV } from "./deriver.js";
import { userFactStatementHash } from "./fact-store.js";
import { createUserModelSystem, type UserModelSystem } from "./system.js";
import { OWNER_ID, STRANGER_ID, tempUserModelEnv, userModelConfig, type TempUserModelEnv } from "./usermodel.test-util.js";

const BOOL = z.boolean();
const NOW = new Date("2026-11-23T12:00:00Z");

let env: TempUserModelEnv | null = null;
let system: UserModelSystem | null = null;
afterEach(() => {
  system?.close();
  system = null;
  env?.cleanup();
  env = null;
});

interface Harness {
  system: UserModelSystem;
  registry: CommandRegistry;
  settings: RuntimeSettings;
  audit: FakeAudit;
  approve: ReturnType<typeof vi.fn>;
  closeSessions: ReturnType<typeof vi.fn>;
  runner: ReturnType<typeof vi.fn>;
  sent: CommandReply[];
  run(text: string, senderId?: string): Promise<{ outcome: DispatchOutcome; reply: string }>;
}

function harness(cfgOver: Partial<UserModelConfig> = {}): Harness {
  env = tempUserModelEnv();
  const cfg = userModelConfig(cfgOver);
  const settings = new RuntimeSettings(join(env.dir, "state", "runtime-settings.json"));
  const audit = fakeAudit();
  const owners = new OwnerDirectory({ telegram: [OWNER_ID] });
  const closeSessions = vi.fn();
  const runner = vi.fn(async () => ({ value: { ops: [] }, costUsd: 0.001 }));
  system = createUserModelSystem({
    dataDir: env.dir,
    chatHistoryPath: env.historyPath,
    config: () => cfg,
    enabled: () => effectiveSettingFlag(settings, "userModel.enabled", cfg.enabled),
    configEnabled: () => cfg.enabled,
    inject: () => effectiveSettingFlag(settings, "userModel.inject", cfg.inject),
    configInject: () => cfg.inject,
    model: () => "utility-model",
    owners,
    settings,
    audit,
    sharedEmbedder: null,
    embedderOptions: { localAvailable: () => false },
    intake: () => null,
    closeSessions,
    runner: runner as unknown as OneShotRunner,
    now: () => NOW,
  });
  const approve = vi.fn(async () => ({ outcome: "approved", optionId: "approve", code: "AB12" }));
  const registry = new CommandRegistry({ owners, prompts: { requestApproval: approve as never } });
  registry.registerAll(system.commands);
  const sent: CommandReply[] = [];
  const run = async (text: string, senderId = OWNER_ID) => {
    const m: UnifiedMessage = { id: `m${Math.random()}`, channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null };
    const identity: ResolvedIdentity = { role: "owner", canonicalId: `telegram:${senderId}`, channel: "telegram", senderId };
    const before = sent.length;
    const outcome = await registry.dispatch({ message: m, identity, source: "channel", send: async (r) => { sent.push(r); } });
    return { outcome, reply: sent.slice(before).map((r) => r.text).join("\n") };
  };
  return { system, registry, settings, audit, approve, closeSessions, runner, sent, run };
}

function addFact(h: Harness, statement: string, over: Record<string, unknown> = {}): number {
  return h.system.store.insert({ category: "preference", statement, kind: "explicit", confidence: 0.7, evidence: [{ t: "chat", id: 1, ts: "2026-11-20" }], now: NOW, ...over }).id;
}

describe("/profile", () => {
  it("is owner-only and DM-only; scheduled text never runs it", async () => {
    const h = harness();
    const id = addFact(h, "Prefers short replies");
    const r = await h.run(`/profile forget ${id}`, STRANGER_ID);
    expect(r.outcome.kind).toBe("denied");
    expect(h.system.store.get(id)).not.toBeNull();
    expect((await h.run("/profile on", STRANGER_ID)).outcome.kind).toBe("denied");
    expect(h.settings.get("userModel.enabled", BOOL)).toBeUndefined();
    const m: UnifiedMessage = { id: "schedule-1", channel: "telegram", senderId: OWNER_ID, senderName: "Schedule", text: "/profile wipe", chatType: "dm", chatId: OWNER_ID, timestamp: Date.now(), raw: null };
    const out = await h.registry.dispatch({ message: m, identity: { role: "owner", canonicalId: "x", channel: "telegram", senderId: OWNER_ID }, source: "synthetic", send: async () => {} });
    expect(out.kind).toBe("not-command");
    expect(h.system.store.get(id)).not.toBeNull();
    const def = h.registry.list().find((d) => d.name === "profile")!;
    expect(def).toMatchObject({ ownerOnly: true, scope: "dm", category: "learning" });
  });

  it("on and off write runtime overrides; off closes live sessions; on explains what is read", async () => {
    const h = harness();
    const on = await h.run("/profile on");
    expect(h.settings.get("userModel.enabled", BOOL)).toBe(true);
    expect(on.reply).toContain("only messages you write to me in this direct chat");
    await h.run("/profile off");
    expect(h.settings.get("userModel.enabled", BOOL)).toBe(false);
    expect(h.closeSessions).toHaveBeenCalled();
    await h.run("/profile inject off");
    expect(h.settings.get("userModel.inject", BOOL)).toBe(false);
    await h.run("/profile reset");
    expect(h.settings.get("userModel.enabled", BOOL)).toBeUndefined();
    expect(h.audit.actions()).toEqual(expect.arrayContaining(["enabled", "disabled", "inject.disabled"]));
  });

  it("forget asks for confirmation; cancel keeps the fact", async () => {
    const h = harness();
    const id = addFact(h, "Prefers short replies");
    h.approve.mockResolvedValueOnce({ outcome: "denied", optionId: "deny", code: "AB12" });
    const r = await h.run(`/profile forget ${id}`);
    expect(r.reply).toContain("Cancelled");
    expect(h.system.store.get(id)).not.toBeNull();
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ kind: "confirm", title: `Forget profile fact #${id}?` }));
  });

  it("forget is permanent: the text is gone and re-deriving it does not bring it back", async () => {
    const h = harness({ enabled: true });
    const msg = env!.addRow({ content: "I work late in the evenings" });
    h.runner.mockImplementation((async () => ({
      value: { ops: [{ op: "add", category: "schedule", statement: "Works late in the evenings", kind: "explicit", evidence: [`c:${msg}`] }] },
      costUsd: 0.001,
    })) as never);
    await h.system.deriver.run("command");
    const id = h.system.store.list()[0]!.id;
    h.system.refreshCard();
    expect(readFileSync(join(env!.dir, "USER.md"), "utf8")).toContain("Works late in the evenings");

    const r = await h.run(`/profile forget ${id}`);
    expect(r.reply).toContain(`Forgotten #${id}`);
    expect(h.system.store.get(id)).toBeNull();
    expect(existsSync(join(env!.dir, "USER.md"))).toBe(false);
    expect(h.closeSessions).toHaveBeenCalled();

    h.system.kv.set(USER_MODEL_KV.watermark, "0");
    const again = await h.system.deriver.run("command");
    expect(again.counts.droppedTombstone).toBe(1);
    expect(h.system.store.list()).toHaveLength(0);
  });

  it("forget and wipe retire matching user_fact.add proposals, so forgotten text is neither kept nor approvable", async () => {
    const h = harness({ enabled: true, requireApproval: true });
    const proposals = new ProposalStore(h.system.db);
    const intake = new LearningIntake({ store: proposals, config: () => intakeConfig() });
    const file = (statement: string): number => {
      const r = intake.submit({
        kind: "user_fact.add", title: `Profile: ${statement}`, origin: "user_model", trust: "owner",
        payload: { op: "add", category: "preference", statement, kind: "explicit", evidence: [{ t: "chat", id: 1 }] },
      });
      if (!("id" in r)) throw new Error(r.dropped);
      return r.id;
    };
    const match = file("Prefers short replies");
    const other = file("Uses pnpm");
    const id = addFact(h, "Prefers short replies");
    await h.run(`/profile forget ${id}`);
    expect(proposals.get(match)).toMatchObject({ status: "rejected", decidedBy: "system", title: "Profile fact (removed by /profile)" });
    expect(JSON.stringify(proposals.get(match)!.payload)).not.toContain("short");
    expect(proposals.get(other)).toMatchObject({ status: "pending", title: "Profile: Uses pnpm" });

    await h.run("/profile wipe");
    expect(proposals.get(other)).toMatchObject({ status: "rejected", title: "Profile fact (removed by /profile)" });
    const leftover = h.system.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE title LIKE '%short%' OR payload LIKE '%short%' OR payload LIKE '%pnpm%'").get();
    expect(leftover).toEqual({ n: 0 });
  });

  it("rebuild asks for confirmation, then re-derives and reports", async () => {
    const h = harness({ enabled: true });
    addFact(h, "Unpinned fact");
    addFact(h, "Pinned fact", { pinned: true });
    h.approve.mockResolvedValueOnce({ outcome: "denied", optionId: "deny", code: "AB12" });
    expect((await h.run("/profile rebuild")).reply).toContain("Cancelled");
    expect(h.system.store.list()).toHaveLength(2);

    env!.addRow({ content: "hello" });
    const r = await h.run("/profile rebuild");
    expect(r.reply).toContain("Rebuilding");
    await vi.waitFor(() => expect(h.sent.map((s) => s.text).join("\n")).toContain("Profile rebuild:"));
    expect(h.system.store.list().map((f) => f.statement)).toEqual(["Pinned fact"]);
    expect(h.runner).toHaveBeenCalledTimes(1);
  });

  it("rebuild refuses while the model is off and makes no model call", async () => {
    const h = harness();
    expect((await h.run("/profile rebuild")).reply).toContain("off");
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.runner).not.toHaveBeenCalled();
  });

  it("wipe needs confirmation, deletes everything and turns the model off", async () => {
    const h = harness({ enabled: true });
    const id = addFact(h, "Prefers short replies");
    h.system.store.forget(addFact(h, "Uses vim"), NOW);
    h.system.refreshCard();
    h.approve.mockResolvedValueOnce({ outcome: "timeout", optionId: "deny", code: "AB12" });
    expect((await h.run("/profile wipe")).reply).toContain("Cancelled");
    expect(h.system.store.get(id)).not.toBeNull();
    const r = await h.run("/profile wipe");
    expect(r.reply).toContain("Wiped 1 facts and 1 forget records");
    expect(h.system.store.counts()).toMatchObject({ active: 0, tombstones: 0 });
    expect(existsSync(join(env!.dir, "USER.md"))).toBe(false);
    expect(h.settings.get("userModel.enabled", BOOL)).toBe(false);
  });

  it("add stores a pinned explicit fact, lifts a tombstone, and refuses sensitive or secret text", async () => {
    const h = harness();
    const gone = addFact(h, "Uses vim");
    h.system.store.forget(gone, NOW);
    const r = await h.run("/profile add tooling: Uses vim");
    expect(r.reply).toMatch(/Added #\d+ \[tooling\], pinned/);
    expect(h.system.store.isTombstoned(userFactStatementHash("Uses vim"))).toBe(false);
    expect(h.system.store.list()[0]).toMatchObject({ statement: "Uses vim", pinned: true, kind: "explicit", confidence: 0.9 });
    expect((await h.run("/profile add I was diagnosed with asthma")).reply).toContain("Not stored");
    const fake = ["sk", "-ant-", "api03-", "K".repeat(40)].join("");
    expect((await h.run(`/profile add my key is ${fake}`)).reply).toContain("Not stored");
    expect(h.system.store.list()).toHaveLength(1);
  });

  it("show, card, why, pin and status", async () => {
    const h = harness({ enabled: true });
    const msg = env!.addRow({ content: "I really prefer short replies" });
    const id = addFact(h, "Prefers short replies", { category: "communication", evidence: [{ t: "chat", id: msg, ts: "2026-11-20" }] });
    const low = addFact(h, "Maybe likes jazz", { kind: "inferred", confidence: 0.4 });
    h.system.refreshCard();
    expect((await h.run("/profile show")).reply).toContain(`#${id} [communication] Prefers short replies (explicit, medium`);
    expect((await h.run("/profile show communication")).reply).not.toContain("jazz");
    expect((await h.run("/profile show bogus")).reply).toContain("Unknown category");
    const card = (await h.run("/profile card")).reply;
    expect(card).toContain("Prefers short replies");
    expect(card).not.toContain("jazz");
    const why = (await h.run(`/profile why ${id}`)).reply;
    expect(why).toContain(`message #${msg} (2026-11-20): "I really prefer short replies"`);
    await h.run(`/profile pin ${low}`);
    expect(h.system.card()).toContain("Maybe likes jazz");
    const status = (await h.run("/profile status")).reply;
    expect(status).toContain("User model: on (config)");
    expect(status).toContain("2 active");
  });

  it("export sends the facts as JSON", async () => {
    const h = harness();
    addFact(h, "Prefers short replies");
    const r = await h.run("/profile export");
    const parsed = JSON.parse(r.reply) as { facts: Array<{ statement: string }> };
    expect(parsed.facts.map((f) => f.statement)).toEqual(["Prefers short replies"]);
  });
});
