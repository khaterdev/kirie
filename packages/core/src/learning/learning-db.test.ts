import { describe, it, expect, afterEach } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { LearningKv, migrateLearningDb, openLearningDb } from "./learning-db.js";
import { ProposalStore } from "./proposal-store.js";
import { tempLearningEnv, type TempLearningEnv } from "./learning.test-util.js";

let env: TempLearningEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const TABLES = ["kv", "turn_log", "proposals", "skill_usage", "skill_state", "curator_runs", "user_facts", "user_facts_fts", "user_fact_tombstones"];

function newProposal(hash: string) {
  return {
    kind: "memory.upsert" as const, title: "t", rationale: "", payload: { key: "k", content: "c", tags: [] },
    payloadHash: hash, origin: "reflection" as const, trust: "owner" as const, riskFlags: [], redactions: 0,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

describe("learning.db", () => {
  it("creates every learning table (including the curator's and the user model's) and no learning_audit", () => {
    env = tempLearningEnv();
    const names = (env.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(names).not.toContain("learning_audit");
  });

  it("migration is idempotent", () => {
    env = tempLearningEnv();
    migrateLearningDb(env.db);
    migrateLearningDb(env.db);
    const db2 = openLearningDb(join(env.dir, "learning.db"));
    db2.close();
  });

  it("creates the file 0600 with WAL and a busy timeout", () => {
    env = tempLearningEnv();
    const mode = statSync(join(env.dir, "learning.db")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(env.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(env.db.pragma("busy_timeout", { simple: true })).toBe(3000);
  });

  it("the partial unique index blocks a second pending row with the same hash, but allows it after rejection", () => {
    env = tempLearningEnv();
    const store = new ProposalStore(env.db);
    const id = store.insert(newProposal("a".repeat(64)));
    expect(id).not.toBeNull();
    expect(store.insert(newProposal("a".repeat(64)))).toBeNull();
    store.markRejected(id!, { by: "telegram:1", via: "command", at: new Date().toISOString() }, null);
    expect(store.insert(newProposal("a".repeat(64)))).not.toBeNull();
  });

  it("recoverInterrupted turns a row stuck in applying into failed", () => {
    env = tempLearningEnv();
    const store = new ProposalStore(env.db);
    const id = store.insert(newProposal("b".repeat(64)))!;
    expect(store.claimForApply(id, { by: "telegram:1", via: "command", at: new Date().toISOString() })).toBe(true);
    expect(store.recoverInterrupted()).toEqual([id]);
    expect(store.get(id)).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted") });
  });

  it("user_facts_fts follows inserts and deletes through triggers", () => {
    env = tempLearningEnv();
    const now = new Date().toISOString();
    env.db.prepare(
      `INSERT INTO user_facts (category, statement, kind, confidence, first_seen_at, last_confirmed_at, updated_at, statement_hash)
       VALUES ('preference', 'Prefers green tea', 'explicit', 0.9, ?, ?, ?, 'h')`,
    ).run(now, now, now);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM user_facts_fts WHERE user_facts_fts MATCH 'tea'").get() as { n: number }).n).toBe(1);
    env.db.prepare("DELETE FROM user_facts").run();
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM user_facts_fts WHERE user_facts_fts MATCH 'tea'").get() as { n: number }).n).toBe(0);
  });

  it("kv: set, setIfAbsent, add", () => {
    env = tempLearningEnv();
    const kv = new LearningKv(env.db);
    expect(kv.setIfAbsent("first", "a")).toBe("a");
    expect(kv.setIfAbsent("first", "b")).toBe("a");
    expect(kv.add("n", 2)).toBe(2);
    expect(kv.add("n", 0.5)).toBe(2.5);
    kv.delete("n");
    expect(kv.getNumber("n")).toBe(0);
  });
});
