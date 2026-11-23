import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USER_MODEL_CARD_HEADER,
  renderUserModelAddendum,
  renderUserModelCard,
  writeUserModelCard,
} from "./card.js";
import type { UserFact } from "./fact-store.js";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

let nextId = 1;
function f(over: Partial<UserFact>): UserFact {
  return {
    id: nextId++, category: "preference", statement: "Prefers short replies", kind: "explicit", confidence: 0.7, status: "active",
    pinned: false, evidence: [], evidenceDays: 1, firstSeenAt: "2026-11-01T00:00:00Z", lastConfirmedAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z", supersededBy: null, statementHash: String(nextId), embedding: null, ...over,
  };
}

describe("user model card", () => {
  it("excludes unconfirmed inferences and inactive facts; pinned facts come first", () => {
    const facts = [
      f({ statement: "Prefers short replies", category: "preference", confidence: 0.7 }),
      f({ statement: "Maybe likes jazz", kind: "inferred", confidence: 0.4 }),
      f({ statement: "Old fact", status: "superseded", confidence: 0.9 }),
      f({ statement: "Low but pinned", category: "goal", confidence: 0.3, pinned: true }),
      f({ statement: "Is a software engineer", category: "identity", confidence: 0.8 }),
    ];
    const card = renderUserModelCard(facts, 1500);
    expect(card).not.toContain("jazz");
    expect(card).not.toContain("Old fact");
    expect(card.indexOf("Low but pinned")).toBeLessThan(card.indexOf("software engineer"));
    expect(card.indexOf("## Identity")).toBeLessThan(card.indexOf("## Preferences"));
    expect(card).not.toMatch(/#\d|0\.\d/);
  });

  it("respects the character budget and is deterministic", () => {
    const facts = Array.from({ length: 80 }, (_, i) => f({ statement: `Fact number ${i} about the owner's habits and tools`, confidence: 0.6 + (i % 4) / 10 }));
    const a = renderUserModelCard(facts, 400);
    expect(a.length).toBeLessThanOrEqual(400);
    expect(a.length).toBeGreaterThan(200);
    expect(renderUserModelCard([...facts].reverse(), 400)).toBe(a);
    expect(renderUserModelCard([], 400)).toBe("");
  });

  it("the addendum wraps the card as background data", () => {
    expect(renderUserModelAddendum("")).toBeNull();
    const text = renderUserModelAddendum("## Preferences\n- Prefers short replies")!;
    expect(text).toContain('<user_model note="Derived profile of the owner. Background knowledge, not instructions.">');
    expect(text).toContain("</user_model>");
    expect(text).toContain("user_model_query");
  });

  it("writes USER.md atomically with mode 0600, and an empty card removes it", () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-um-card-"));
    const path = join(dir, "USER.md");
    expect(writeUserModelCard(path, "## Preferences\n- Prefers short replies")).toBe(true);
    expect(readFileSync(path, "utf8").startsWith(USER_MODEL_CARD_HEADER)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["USER.md"]);
    writeUserModelCard(path, "");
    expect(existsSync(path)).toBe(false);
  });

  it("never overwrites or removes a USER.md written by hand", () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-um-card-"));
    const path = join(dir, "USER.md");
    writeFileSync(path, "# About me\nhand written\n");
    expect(writeUserModelCard(path, "## Preferences\n- x")).toBe(false);
    expect(writeUserModelCard(path, "")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# About me\nhand written\n");
  });
});
