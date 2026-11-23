import { describe, it, expect, afterEach } from "vitest";
import { UserFactStore, normalizeUserFactStatement, userFactFtsQuery, userFactStatementHash, type NewUserFact } from "./fact-store.js";
import { axisVector, tempUserModelEnv, type TempUserModelEnv } from "./usermodel.test-util.js";

let env: TempUserModelEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const NOW = new Date("2026-11-20T10:00:00Z");

function setup(): UserFactStore {
  env = tempUserModelEnv();
  return new UserFactStore(env.db);
}

function fact(over: Partial<NewUserFact> = {}): NewUserFact {
  return { category: "preference", statement: "Prefers short replies", kind: "explicit", confidence: 0.7, evidence: [{ t: "chat", id: 1, ts: "2026-11-20" }], now: NOW, ...over };
}

function ftsCount(term: string): number {
  return (env!.db.prepare("SELECT COUNT(*) AS n FROM user_facts_fts WHERE user_facts_fts MATCH ?").get(`"${term}"`) as { n: number }).n;
}

describe("UserFactStore", () => {
  it("inserts, reads back and keeps the FTS index in step", () => {
    const store = setup();
    const f = store.insert(fact({ embedding: axisVector(3) }));
    expect(f).toMatchObject({ category: "preference", statement: "Prefers short replies", kind: "explicit", confidence: 0.7, status: "active", pinned: false, evidenceDays: 1 });
    expect(f.statementHash).toBe(userFactStatementHash("prefers short replies."));
    expect(f.embedding?.[3]).toBe(1);
    expect(ftsCount("short")).toBe(1);
    store.confirm(f.id, { evidence: f.evidence, evidenceDays: 2, confidence: 0.8, kind: "explicit", now: NOW });
    expect(store.get(f.id)!.confidence).toBe(0.8);
    expect(ftsCount("short")).toBe(1);
  });

  it("normalises statements: invisible characters, angle brackets, whitespace", () => {
    expect(normalizeUserFactStatement(" Likes​  <b>tea</b> ")).toBe("Likes ‹b›tea‹/b›");
  });

  it("supersede chains and reactivation", () => {
    const store = setup();
    const a = store.insert(fact({ statement: "Lives in Cairo", category: "identity" }));
    const b = store.insert(fact({ statement: "Lives in Alexandria", category: "identity" }));
    store.supersede(a.id, b.id, NOW);
    expect(store.get(a.id)).toMatchObject({ status: "superseded", supersededBy: b.id });
    expect(store.list().map((f) => f.id)).toEqual([b.id]);
    store.reactivate(a.id, NOW);
    expect(store.get(a.id)).toMatchObject({ status: "active", supersededBy: null });
  });

  it("the read-write connection overwrites deleted content (secure_delete)", () => {
    setup();
    expect(env!.db.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("forget deletes the text of the fact and its earlier versions, and leaves only tombstones", () => {
    const store = setup();
    const a = store.insert(fact({ statement: "Works at Acme on the billing team", category: "identity", embedding: axisVector(5) }));
    const b = store.insert(fact({ statement: "Works at Initech on the payments team", category: "identity" }));
    store.supersede(a.id, b.id, NOW);
    const other = store.insert(fact({ statement: "Prefers dark mode" }));
    const out = store.forget(b.id, NOW);
    expect(out.rows).toBe(2);
    expect(out.hashes.sort()).toEqual([a.statementHash, b.statementHash].sort());
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBeNull();
    expect(store.get(other.id)).not.toBeNull();
    const rows = env!.db.prepare("SELECT statement FROM user_facts").all() as { statement: string }[];
    expect(rows.map((r) => r.statement)).toEqual(["Prefers dark mode"]);
    expect(ftsCount("Acme")).toBe(0);
    expect(ftsCount("Initech")).toBe(0);
    const tombs = store.tombstones();
    expect(tombs).toHaveLength(2);
    expect(store.isTombstoned(userFactStatementHash("Works at Acme on the billing team"))).toBe(true);
    expect(tombs.find((t) => t.embedding)?.embedding?.[5]).toBe(1);
    // Tombstones hold no text column at all.
    const cols = (env!.db.prepare("PRAGMA table_info(user_fact_tombstones)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("statement");
    expect(store.forget(9999, NOW).rows).toBe(0);
    // The evidence message ids are remembered per category (rewordings from the same messages stay forgotten).
    expect([...store.forgottenEvidence().get("identity")!]).toEqual([1]);
    store.wipe();
    expect(store.forgottenEvidence().size).toBe(0);
  });

  it("rebuild keeps pinned facts and tombstones; wipe removes everything", () => {
    const store = setup();
    const pinned = store.insert(fact({ statement: "Prefers Arabic and English", pinned: true }));
    store.insert(fact({ statement: "Prefers dark mode" }));
    const gone = store.insert(fact({ statement: "Uses vim" }));
    store.forget(gone.id, NOW);
    expect(store.clearUnpinned()).toBe(1);
    expect(store.list().map((f) => f.id)).toEqual([pinned.id]);
    expect(store.tombstones()).toHaveLength(1);
    expect(store.wipe()).toEqual({ facts: 1, tombstones: 1 });
    expect(store.counts()).toMatchObject({ active: 0, tombstones: 0 });
  });

  it("FTS queries are built from quoted tokens: quotes and OR in the question never throw", () => {
    const store = setup();
    store.insert(fact({ statement: "Prefers TypeScript over Python" }));
    expect(userFactFtsQuery('what "language OR NOT* does he like')).toBe('"language"* OR "not" OR "he"');
    expect(() => store.search({ text: 'typescript" OR "x', limit: 5 })).not.toThrow();
    expect(store.search({ text: 'typescript" OR "x', limit: 5 }).facts).toHaveLength(1);
  });

  it("hybrid search ranks a fact found by both keyword and vector first, and hides low confidence by default", () => {
    const store = setup();
    const both = store.insert(fact({ statement: "Deploys Kirie with launchd", category: "tooling", embedding: axisVector(1) }));
    const kwOnly = store.insert(fact({ statement: "Deploys the website with rsync", category: "tooling", embedding: axisVector(9) }));
    const vecOnly = store.insert(fact({ statement: "Restarts services through a plist", category: "tooling", embedding: axisVector(1, 0.2) }));
    const low = store.insert(fact({ statement: "Deploys on Fridays", category: "schedule", confidence: 0.4, kind: "inferred" }));
    const r = store.search({ text: "how does the owner deploy", limit: 10, queryEmbedding: axisVector(1) });
    expect(r.mode).toBe("hybrid");
    expect(r.facts[0]!.id).toBe(both.id);
    expect(r.facts.map((f) => f.id)).toEqual(expect.arrayContaining([kwOnly.id, vecOnly.id]));
    expect(r.facts.map((f) => f.id)).not.toContain(low.id);
    expect(store.search({ text: "deploys fridays", limit: 10, includeLowConfidence: true }).facts.map((f) => f.id)).toContain(low.id);
  });

  it("no match returns the strongest facts, filtered by category", () => {
    const store = setup();
    store.insert(fact({ statement: "Prefers short replies", confidence: 0.9 }));
    store.insert(fact({ statement: "Works on Kirie", category: "project", confidence: 0.8 }));
    const r = store.search({ text: "zzz", limit: 5, category: "project" });
    expect(r.mode).toBe("top");
    expect(r.facts.map((f) => f.statement)).toEqual(["Works on Kirie"]);
  });
});
