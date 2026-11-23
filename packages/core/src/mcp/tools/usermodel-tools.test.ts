import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { UserModelConfigSchema } from "../../config/sections/usermodel.js";
import { openLearningDb } from "../../learning/learning-db.js";
import { UserFactStore } from "../../learning/usermodel/fact-store.js";
import { USER_MODEL_TOOLS_ENV, createUserModelTools, createUserModelToolsWith } from "./usermodel-tools.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  vi.restoreAllMocks();
});

const NOW = new Date("2026-11-20T10:00:00Z");

function seed(): { dbDir: string; dbPath: string } {
  dir = mkdtempSync(join(tmpdir(), "kirie-um-tool-"));
  const dbPath = join(dir, "learning.db");
  const db = openLearningDb(dbPath);
  const store = new UserFactStore(db);
  const vec = new Array<number>(8).fill(0);
  vec[0] = 1;
  store.insert({ category: "communication", statement: "Prefers short replies in English", kind: "explicit", confidence: 0.8, evidence: [{ t: "chat", id: 12, ts: "2026-11-20" }], embedding: vec, now: NOW });
  store.insert({ category: "tooling", statement: "Deploys with launchd on macOS", kind: "explicit", confidence: 0.7, evidence: [{ t: "chat", id: 13 }], now: NOW });
  store.insert({ category: "preference", statement: "Might like jazz while coding", kind: "inferred", confidence: 0.4, evidence: [{ t: "chat", id: 14 }], now: NOW });
  db.close();
  return { dbDir: dir, dbPath };
}

const envOn = { [USER_MODEL_TOOLS_ENV.config]: JSON.stringify(UserModelConfigSchema.parse({ enabled: true })) };
const envOff = { [USER_MODEL_TOOLS_ENV.config]: JSON.stringify(UserModelConfigSchema.parse({})) };

async function query(tools: ReturnType<typeof createUserModelTools>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tools.user_model_query!.handler(params)) as Record<string, unknown>;
}

describe("user_model_query", () => {
  it("is the only tool, and the factory touches no file", () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-um-tool-"));
    const tools = createUserModelTools({ dbDir: dir, env: envOn });
    expect(Object.keys(tools)).toEqual(["user_model_query"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("answers { enabled: false } when the feature is not running, is off in config, or turned off at runtime", async () => {
    const { dbDir } = seed();
    expect(await query(createUserModelTools({ dbDir, env: {} }), { question: "replies" })).toEqual({ enabled: false });
    expect(await query(createUserModelTools({ dbDir, env: envOff }), { question: "replies" })).toEqual({ enabled: false });
    const daemonSettings = new RuntimeSettings(join(dbDir, "state", "runtime-settings.json"));
    daemonSettings.set("userModel.enabled", false, "test");
    expect(await query(createUserModelTools({ dbDir, env: envOn }), { question: "replies" })).toEqual({ enabled: false });
    daemonSettings.set("userModel.enabled", true, "test");
    const on = await query(createUserModelToolsWith({ dbDir, env: envOff }, { queryEmbedder: () => null }), { question: "replies" });
    expect(on.enabled).toBe(true);
  });

  it("returns matching facts with bands and evidence refs; low confidence only on request", async () => {
    const { dbDir } = seed();
    const tools = createUserModelToolsWith({ dbDir, env: envOn }, { queryEmbedder: () => null });
    const r = await query(tools, { question: "how does the owner like replies?" });
    expect(r.match).toBe("keyword");
    expect(r.facts).toEqual([
      { id: 1, category: "communication", statement: "Prefers short replies in English", kind: "explicit", confidence: "high", pinned: false, lastConfirmed: "2026-11-20", evidence: [{ chatMessageId: 12, date: "2026-11-20" }] },
    ]);
    const low = await query(tools, { question: "jazz" });
    expect((low.facts as unknown[]).length).toBe(2);
    expect(low.match).toBe("top");
    const withLow = await query(tools, { question: "jazz", includeLowConfidence: true });
    expect((withLow.facts as Array<{ statement: string }>)[0]!.statement).toBe("Might like jazz while coding");
  });

  it("question text cannot inject FTS syntax", async () => {
    const { dbDir } = seed();
    const tools = createUserModelToolsWith({ dbDir, env: envOn }, { queryEmbedder: () => null });
    await expect(query(tools, { question: '"deploys" OR NOT* NEAR(x y) "' })).resolves.toMatchObject({ enabled: true });
    expect(await query(tools, { question: "x", category: "bogus" })).toMatchObject({ error: expect.stringContaining("category") });
  });

  it("is read-only and uses only the local embedder: the DB file is untouched and nothing is fetched", async () => {
    const { dbDir, dbPath } = seed();
    const before = statSync(dbPath);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const embed = vi.fn(async (texts: string[]) => texts.map(() => { const v = new Array<number>(8).fill(0); v[0] = 1; return v; }));
    const tools = createUserModelToolsWith({ dbDir, env: envOn }, { queryEmbedder: () => ({ model: "local", dimensions: 8, embed }) });
    const r = await query(tools, { question: "short replies", limit: 3 });
    expect(r.match).toBe("hybrid");
    expect(embed).toHaveBeenCalledWith(["short replies"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = statSync(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});
