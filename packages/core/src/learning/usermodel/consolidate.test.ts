import { describe, it, expect, afterEach } from "vitest";
import { consolidateUserModel, isUserFactStale } from "./consolidate.js";
import { UserFactStore } from "./fact-store.js";
import { axisVector, tempUserModelEnv, type TempUserModelEnv } from "./usermodel.test-util.js";

let env: TempUserModelEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const DAY = 86_400_000;
const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function setup(): UserFactStore {
  env = tempUserModelEnv();
  return new UserFactStore(env.db);
}

describe("consolidateUserModel", () => {
  it("merges near-duplicates in one category into the stronger fact and keeps both evidence lists", () => {
    const store = setup();
    const a = store.insert({ category: "tooling", statement: "Uses pnpm", kind: "inferred", confidence: 0.5, evidence: [{ t: "chat", id: 1, ts: "2026-11-01" }], embedding: axisVector(7), now: ago(10) });
    const b = store.insert({ category: "tooling", statement: "Uses pnpm for installs", kind: "explicit", confidence: 0.8, evidence: [{ t: "chat", id: 2, ts: "2026-11-02" }], embedding: axisVector(7, 0.1), now: ago(5) });
    const other = store.insert({ category: "preference", statement: "Uses pnpm", kind: "inferred", confidence: 0.5, evidence: [], embedding: axisVector(7), now: ago(5) });
    const r = consolidateUserModel(store, NOW);
    expect(r.merged).toBe(1);
    expect(store.get(a.id)).toMatchObject({ status: "superseded", supersededBy: b.id });
    expect(store.get(b.id)!.evidence.map((e) => (e.t === "chat" ? e.id : 0))).toEqual([1, 2]);
    expect(store.get(other.id)!.status).toBe("active");
  });

  it("never merges two pinned facts", () => {
    const store = setup();
    store.insert({ category: "tooling", statement: "Uses pnpm", kind: "explicit", confidence: 0.9, pinned: true, evidence: [], embedding: axisVector(7), now: NOW });
    store.insert({ category: "tooling", statement: "Uses pnpm daily", kind: "explicit", confidence: 0.9, pinned: true, evidence: [], embedding: axisVector(7), now: NOW });
    expect(consolidateUserModel(store, NOW).merged).toBe(0);
  });

  it("decays stale inferences once per 30 days down to the floor, then suppresses them", () => {
    const store = setup();
    const stale = store.insert({ category: "schedule", statement: "Works late", kind: "inferred", confidence: 0.3, evidence: [], now: ago(90) });
    const fresh = store.insert({ category: "schedule", statement: "Starts at nine", kind: "inferred", confidence: 0.4, evidence: [], now: ago(10) });
    const explicit = store.insert({ category: "schedule", statement: "Wakes at six", kind: "explicit", confidence: 0.7, evidence: [], now: ago(200) });
    const pinned = store.insert({ category: "schedule", statement: "Fasts on Mondays", kind: "inferred", confidence: 0.3, pinned: true, evidence: [], now: ago(200) });

    const r1 = consolidateUserModel(store, NOW);
    expect(r1.decayed).toBe(1);
    expect(store.get(stale.id)).toMatchObject({ confidence: 0.25, status: "active" });
    // Same week: no second decay (updated_at was just bumped).
    expect(consolidateUserModel(store, new Date(NOW.getTime() + 7 * DAY)).decayed).toBe(0);
    const later = new Date(NOW.getTime() + 31 * DAY);
    const r2 = consolidateUserModel(store, later);
    expect(r2).toMatchObject({ decayed: 1, suppressed: 1 });
    expect(store.get(stale.id)).toMatchObject({ confidence: 0.2, status: "suppressed" });
    expect(store.get(fresh.id)).toMatchObject({ confidence: 0.4, status: "active" });
    expect(store.get(explicit.id)!.confidence).toBe(0.7);
    expect(store.get(pinned.id)).toMatchObject({ confidence: 0.3, status: "active" });
    expect(isUserFactStale(store.get(explicit.id)!, NOW)).toBe(true);
    expect(isUserFactStale(store.get(fresh.id)!, NOW)).toBe(false);
  });
});
