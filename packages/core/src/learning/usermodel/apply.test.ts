import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { ProposalApplier, mintOwnerApproval } from "../applier.js";
import { LearningIntake } from "../intake.js";
import { ProposalStore } from "../proposal-store.js";
import { fakeAudit, intakeConfig } from "../learning.test-util.js";
import { LearningConfigSchema } from "../../config/sections/learning.js";
import { USER_FACT_PROPOSAL_KIND, createUserFactApplyHandler } from "./apply.js";
import { UserFactStore } from "./fact-store.js";
import { OWNER_ID, STRANGER_ID, tempUserModelEnv, testOwners, userModelConfig, type TempUserModelEnv } from "./usermodel.test-util.js";

let env: TempUserModelEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const NOW = new Date("2026-11-23T12:00:00Z");

function setup() {
  env = tempUserModelEnv();
  const facts = new UserFactStore(env.db);
  const proposals = new ProposalStore(env.db);
  const intake = new LearningIntake({ store: proposals, config: () => intakeConfig() });
  const applier = new ProposalApplier({
    store: proposals, backupRoot: join(env.dir, "backups"), audit: fakeAudit(), config: () => LearningConfigSchema.parse({}),
  });
  let changes = 0;
  applier.registerKind(USER_FACT_PROPOSAL_KIND, createUserFactApplyHandler({
    store: facts, config: () => userModelConfig(), embedder: () => null, onChanged: () => { changes++; }, now: () => NOW,
  }));
  const file = (payload: Record<string, unknown>): number => {
    const r = intake.submit({ kind: "user_fact.add", title: "Profile fact", payload, origin: "user_model", trust: "owner" });
    if (!("id" in r)) throw new Error(r.dropped);
    return r.id;
  };
  const owner = mintOwnerApproval(testOwners, { channel: "telegram", senderId: OWNER_ID, via: "command" })!;
  return { facts, proposals, applier, file, owner, changes: () => changes };
}

const base = { op: "add", category: "communication", statement: "Prefers short replies", kind: "explicit", evidence: [{ t: "chat", id: 7, ts: "2026-11-20" }] };

describe("user_fact.add proposals", () => {
  it("only an owner approval applies; the fact gets a code-assigned confidence; undo removes it", async () => {
    const s = setup();
    const id = s.file(base);
    expect(mintOwnerApproval(testOwners, { channel: "telegram", senderId: STRANGER_ID, via: "command" })).toBeNull();
    const forged = Object.freeze({ channel: "telegram", senderId: OWNER_ID, via: "command" as const, at: NOW.toISOString() });
    expect((await s.applier.approve(id, forged)).ok).toBe(false);
    expect(s.facts.list()).toHaveLength(0);

    const out = await s.applier.approve(id, s.owner);
    expect(out.ok).toBe(true);
    const fact = s.facts.list()[0]!;
    expect(fact).toMatchObject({ statement: "Prefers short replies", confidence: 0.7, kind: "explicit" });
    expect(s.changes()).toBe(1);
    expect((await s.applier.undo(id, s.owner)).ok).toBe(true);
    expect(s.facts.list()).toHaveLength(0);
  });

  it("a statement forgotten after it was filed is refused as stale", async () => {
    const s = setup();
    const id = s.file(base);
    const f = s.facts.insert({ category: "communication", statement: "Prefers short replies", kind: "explicit", confidence: 0.7, evidence: [], now: NOW });
    s.facts.forget(f.id, NOW);
    const out = await s.applier.approve(id, s.owner);
    expect(out).toMatchObject({ ok: false, code: "stale" });
    expect(s.facts.list()).toHaveLength(0);
  });

  it("a sensitive statement is refused at apply time even if it got into the store", async () => {
    const s = setup();
    const id = s.file({ ...base, statement: "Was diagnosed with asthma" });
    expect(await s.applier.approve(id, s.owner)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("an update supersedes the replaced fact; undo brings it back; a pinned target is a conflict", async () => {
    const s = setup();
    const old = s.facts.insert({ category: "identity", statement: "Lives in Cairo", kind: "explicit", confidence: 0.8, evidence: [], now: NOW });
    const id = s.file({ ...base, op: "contradict", category: "identity", statement: "Lives in Alexandria", replaces: old.id });
    expect((await s.applier.approve(id, s.owner)).ok).toBe(true);
    expect(s.facts.get(old.id)!.status).toBe("superseded");
    const fresh = s.facts.list({ category: "identity" })[0]!;
    expect(fresh).toMatchObject({ statement: "Lives in Alexandria", confidence: 0.6 });
    await s.applier.undo(id, s.owner);
    expect(s.facts.get(old.id)!.status).toBe("active");
    expect(s.facts.get(fresh.id)).toBeNull();

    const pinned = s.facts.insert({ category: "identity", statement: "Is a software engineer", kind: "explicit", confidence: 0.9, pinned: true, evidence: [], now: NOW });
    const id2 = s.file({ ...base, op: "update", category: "identity", statement: "Is a product manager", replaces: pinned.id });
    expect(await s.applier.approve(id2, s.owner)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("preview is computed by code", () => {
    const s = setup();
    const id = s.file(base);
    expect(s.applier.preview(s.proposals.get(id)!)).toContain("New profile fact (communication, explicit):\nPrefers short replies");
  });
});
