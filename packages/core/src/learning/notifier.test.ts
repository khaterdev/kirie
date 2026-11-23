import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join } from "node:path";
import { InteractionRouter } from "../interaction/router.js";
import { OwnerPrompts } from "../interaction/owner-prompts.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { makeFakeAdapter, makeFakeRegistry, type FakeAdapter } from "../interaction/fake-channel.test-util.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { ProposalApplier } from "./applier.js";
import { LearningIntake, type ProposalSubmission } from "./intake.js";
import { registerLearningKindHandlers } from "./kind-handlers.js";
import { LearningKv } from "./learning-db.js";
import {
  DIGEST_MAX_CARDS, PROPOSAL_ACTION_NS, ProposalNotifier, createProposalActionHandler, proposalCardButtons, renderProposalCard,
} from "./notifier.js";
import { ProposalStore } from "./proposal-store.js";
import { SkillStateStore } from "./skill-state-store.js";
import { payloadHash8 } from "./proposal-types.js";
import { OWNER_ID, STRANGER_ID, fakeAudit, intakeConfig, tempLearningEnv, type FakeAudit, type TempLearningEnv } from "./learning.test-util.js";

let env: TempLearningEnv;
let store: ProposalStore;
let intake: LearningIntake;
let applier: ProposalApplier;
let audit: FakeAudit;
let adapter: FakeAdapter;
let prompts: OwnerPrompts;
let notifier: ProposalNotifier;
let active: boolean;
let clock: number;
const memory = new Map<string, { content: string; tags: string[] }>();

beforeEach(() => {
  env = tempLearningEnv();
  store = new ProposalStore(env.db);
  audit = fakeAudit();
  memory.clear();
  const skillState = new SkillStateStore(env.db);
  intake = new LearningIntake({ store, config: () => intakeConfig({ maxPending: 50, maxProposalsPerDay: 50 }), skillState });
  applier = new ProposalApplier({ store, backupRoot: join(env.dir, "backups"), audit, config: () => ({ allowUntrustedSkillProposals: false }) });
  registerLearningKindHandlers(applier, {
    memory: { recall: (k) => memory.get(k) ?? null, store: (k, c, t) => { memory.set(k, { content: c, tags: t }); }, delete: (k) => memory.delete(k) },
    memoryMdPath: join(env.dir, "MEMORY.md"), memoryMdMaxBytes: () => 16_384, skillsRoot: join(env.dir, "skills"), skillState,
  });
  const owners = new OwnerDirectory({ telegram: [OWNER_ID] });
  adapter = makeFakeAdapter("telegram");
  const registry = makeFakeRegistry([adapter]);
  const trail = audit as unknown as AuditTrail;
  const router = new InteractionRouter({ channelRegistry: registry, owners, audit: trail });
  router.attach(adapter);
  prompts = new OwnerPrompts({ router, channelRegistry: registry, owners, audit: trail, maxPending: 10 });
  prompts.onAction(PROPOSAL_ACTION_NS, createProposalActionHandler({ store, applier, owners, audit }));
  active = true;
  clock = Date.parse("2026-11-23T10:00:00.000Z");
  notifier = new ProposalNotifier({
    store, prompts, preview: (r) => applier.preview(r), config: () => ({ digestIntervalMinutes: 180 }),
    isActiveHours: () => active, kv: new LearningKv(env.db), now: () => new Date(clock),
  });
});
afterEach(() => {
  prompts.cancelAll("test");
  env.cleanup();
});

function file(over: Partial<ProposalSubmission> = {}): number {
  const r = intake.submit({
    kind: "memory.upsert", title: "Remember something",
    payload: { key: `owner:k${Math.floor(Math.random() * 1e9)}`, content: "A fact", tags: [] },
    origin: "reflection", trust: "owner", ...over,
  });
  if (!("id" in r)) throw new Error(r.dropped);
  return r.id;
}

function dataOf(label: string, cardIndex = -1): string {
  const card = adapter.sentInteractive.at(cardIndex)!;
  return card.buttons.flat().find((b) => b.label === label)!.data!;
}

describe("proposal cards", () => {
  it("owner trust gets Approve / Reject / Show bound to the payload hash", () => {
    const rec = store.get(file())!;
    const rows = proposalCardButtons(rec);
    expect(rows[0]!.map((b) => b.label)).toEqual(["Approve", "Reject", "Show"]);
    expect(rows[0]![0]!.action).toBe(`a:${rec.id}:${payloadHash8(rec.payloadHash)}`);
  });

  it("mixed shows a warning; untrusted and unverified have no Approve button", () => {
    const mixed = store.get(file({ trust: "mixed" }))!;
    expect(renderProposalCard(mixed, "p").text).toContain("Warning");
    expect(proposalCardButtons(mixed)[0]!.map((b) => b.label)).toContain("Approve");
    for (const trust of ["untrusted", "unverified"] as const) {
      const rec = store.get(file({ trust, origin: trust === "unverified" ? "agent_tool" : "reflection" }))!;
      expect(proposalCardButtons(rec)[0]!.map((b) => b.label)).toEqual(["Show", "Reject"]);
      expect(renderProposalCard(rec, "p").text).toContain(`/proposals show ${rec.id}`);
    }
  });

  it("a scanner block disables one-tap approve", () => {
    const rec = { ...store.get(file())!, riskFlags: ["scanner_block" as const] };
    expect(proposalCardButtons(rec)[0]!.map((b) => b.label)).toEqual(["Show", "Reject"]);
  });
});

describe("digest", () => {
  it("sends at most 5 cards plus 'N more', only reflection/curator/user_model, then waits for the interval", async () => {
    for (let i = 0; i < 7; i++) file();
    file({ origin: "agent_tool" });
    notifier.queueLine("Curator: 2 stale skills");
    expect(await notifier.maybeSendDigest()).toEqual({ sent: DIGEST_MAX_CARDS });
    const header = adapter.sentText.at(-1)!.text;
    expect(header).toContain("7 new proposals");
    expect(header).toContain("2 more: /proposals list");
    expect(header).toContain("Curator: 2 stale skills");
    expect(adapter.sentInteractive).toHaveLength(5);
    expect(await notifier.maybeSendDigest()).toEqual({ sent: 0 });
    clock += 181 * 60_000;
    expect(await notifier.maybeSendDigest()).toEqual({ sent: 2 });
  });

  it("sends nothing outside active hours or when there is nothing to say", async () => {
    expect(await notifier.maybeSendDigest()).toEqual({ sent: 0 });
    file();
    active = false;
    expect(await notifier.maybeSendDigest({ force: true })).toEqual({ sent: 0 });
    expect(adapter.sentText).toHaveLength(0);
  });
});

describe("prop button handler", () => {
  it("owner press on Approve applies; a second press is refused", async () => {
    const id = file();
    await notifier.maybeSendDigest();
    const card = adapter.sentInteractive.at(-1)!;
    const messageId = "101";
    await adapter.press({ data: dataOf("Approve"), messageId });
    expect(store.get(id)).toMatchObject({ status: "applied", decidedVia: "button" });
    expect(memory.size).toBe(1);
    expect(card).toBeTruthy();
    await adapter.press({ data: dataOf("Approve"), messageId });
    expect(adapter.acks.at(-1)!.text).toContain("already");
  });

  it("a non-owner press is not routed and changes nothing", async () => {
    const id = file();
    await notifier.maybeSendDigest();
    await adapter.press({ data: dataOf("Approve"), senderId: STRANGER_ID, chatId: STRANGER_ID });
    expect(store.get(id)!.status).toBe("pending");
    expect(adapter.acks.at(-1)!.text).toBe("Only the owner can do that.");
  });

  it("a press from a group chat by the owner is not routed", async () => {
    const id = file();
    await notifier.maybeSendDigest();
    await adapter.press({ data: dataOf("Approve"), chatType: "group", chatId: "-500" });
    expect(store.get(id)!.status).toBe("pending");
  });

  it("a wrong h8 is refused", async () => {
    const id = file();
    await notifier.maybeSendDigest();
    const forged = dataOf("Approve").replace(/:[0-9a-f]{8}$/, ":deadbeef");
    await adapter.press({ data: forged });
    expect(store.get(id)!.status).toBe("pending");
    expect(adapter.acks.at(-1)!.text).toContain("no longer matches");
    expect(audit.actions()).toContain("proposal.card_mismatch");
  });

  it("an untrusted proposal cannot be approved by a forged Approve press", async () => {
    const id = file({ trust: "untrusted" });
    const rec = store.get(id)!;
    await adapter.press({ data: `k1|prop|a:${id}:${payloadHash8(rec.payloadHash)}` });
    expect(store.get(id)!.status).toBe("pending");
    expect(adapter.acks.at(-1)!.text).toContain(`/proposals show ${id}`);
  });

  it("Show replaces the text with the detail; Reject rejects", async () => {
    const id = file();
    await notifier.maybeSendDigest();
    await adapter.press({ data: dataOf("Show"), messageId: "101" });
    expect(adapter.updates.at(-1)!.text).toContain(`Proposal #${id}`);
    await adapter.press({ data: dataOf("Reject"), messageId: "101" });
    expect(store.get(id)).toMatchObject({ status: "rejected", decidedVia: "button" });
  });
});
