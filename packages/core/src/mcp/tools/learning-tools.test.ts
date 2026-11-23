import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLearningTools, LEARNING_TOOLS_ENV } from "./learning-tools.js";
import { collectFeatureTools } from "../feature-tools.js";
import { createMcpToolRegistry } from "../server.js";
import type { ChannelRegistry } from "../../channels/registry.js";
import { openLearningDb } from "../../learning/learning-db.js";
import { ProposalStore } from "../../learning/proposal-store.js";
import { sha256Hex } from "../../learning/proposal-types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-learning-tools-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN_TOOL_NAME = /approve|apply|reject|undo/i;

function tools(env: Record<string, string | undefined> = {}) {
  return createLearningTools({ dbDir: dir, env });
}

function skill(name: string, body = "steps\n"): string {
  return `---\nname: ${name}\ndescription: How to ${name}\n---\n\n${body}`;
}

function listSources(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes(".test-util")) out.push(p);
  }
  return out;
}

describe("learning tools", () => {
  it("the factory is pure: nothing is opened until a handler runs", () => {
    const t = tools();
    expect(Object.keys(t)).toEqual(["learning_propose", "proposals_list"]);
    expect(existsSync(join(dir, "learning.db"))).toBe(false);
  });

  it("learning_propose only inserts a pending, unverified proposal", async () => {
    const t = tools();
    const out = await t.learning_propose!.handler({
      kind: "memory", title: "Owner timezone", rationale: "said so", sessionKey: "telegram:dm:1001",
      payload: JSON.stringify({ key: "owner:tz", content: "Africa/Cairo", tags: ["owner"] }),
    }) as { id: number; status: string; note: string };
    expect(out.status).toBe("pending");
    expect(out.note).toContain("You cannot approve it");
    const db = openLearningDb(join(dir, "learning.db"));
    const rec = new ProposalStore(db).get(out.id)!;
    expect(rec).toMatchObject({ kind: "memory.upsert", status: "pending", trust: "unverified", origin: "agent_tool", sourceSessionKey: "telegram:dm:1001" });
    db.close();
    // Nothing else on disk changed: no memory.db, no MEMORY.md, no skills.
    expect(existsSync(join(dir, "memory.db"))).toBe(false);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("skill_update reads the current file for the base hash and changes nothing on disk", async () => {
    const root = join(dir, "skills");
    mkdirSync(join(root, "deploy"), { recursive: true });
    writeFileSync(join(root, "deploy", "SKILL.md"), skill("deploy", "old\n"));
    const t = tools({ [LEARNING_TOOLS_ENV.skillsRoot]: root });
    const up = await t.learning_propose!.handler({
      kind: "skill_update", title: "Better deploy", sessionKey: "telegram:dm:1001",
      payload: JSON.stringify({ name: "deploy", skillMd: skill("deploy", "new\n") }),
    }) as { id: number };
    const db = openLearningDb(join(dir, "learning.db"));
    const rec = new ProposalStore(db).get(up.id)!;
    expect(rec.kind).toBe("skill.patch");
    expect((rec.payload as { baseHash: string }).baseHash).toBe(sha256Hex(skill("deploy", "old\n")));
    db.close();
    expect(readFileSync(join(root, "deploy", "SKILL.md"), "utf8")).toBe(skill("deploy", "old\n"));
    expect(await t.learning_propose!.handler({ kind: "skill_update", title: "x", sessionKey: "k", payload: JSON.stringify({ name: "ghost", skillMd: skill("ghost") }) }))
      .toMatchObject({ error: expect.stringContaining("does not exist") });
  });

  it("rejects bad kinds and bad JSON, and reports intake drops", async () => {
    const t = tools();
    expect(await t.learning_propose!.handler({ kind: "approve", title: "x", payload: "{}", sessionKey: "k" })).toMatchObject({ error: expect.any(String) });
    expect(await t.learning_propose!.handler({ kind: "memory", title: "x", payload: "not json", sessionKey: "k" })).toEqual({ error: "payload is not valid JSON" });
    expect(await t.learning_propose!.handler({ kind: "memory", title: "x", payload: JSON.stringify({ key: "has space", content: "c" }), sessionKey: "k" }))
      .toMatchObject({ status: "dropped" });
  });

  it("honours the learning config passed through the env (pending cap)", async () => {
    const t = tools({ [LEARNING_TOOLS_ENV.config]: JSON.stringify({ maxPending: 1 }) });
    await t.learning_propose!.handler({ kind: "memory", title: "a", sessionKey: "k", payload: JSON.stringify({ key: "a:1", content: "one" }) });
    expect(await t.learning_propose!.handler({ kind: "memory", title: "b", sessionKey: "k", payload: JSON.stringify({ key: "a:2", content: "two" }) }))
      .toEqual({ status: "dropped", reason: "pending_cap" });
  });

  it("proposals_list is read-only and returns the summary fields", async () => {
    const t = tools();
    await t.learning_propose!.handler({ kind: "memory", title: "a", sessionKey: "k", payload: JSON.stringify({ key: "a:1", content: "one" }) });
    const out = await t.proposals_list!.handler({}) as { proposals: Array<Record<string, unknown>> };
    expect(out.proposals).toHaveLength(1);
    expect(Object.keys(out.proposals[0]!).sort()).toEqual(["created_at", "id", "kind", "status", "title", "trust"]);
    expect(await t.proposals_list!.handler({ status: "bogus" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("regression guard: nothing the agent can reach may approve, apply, reject or undo", () => {
  it("no tool name in the in-process registry or the feature tools matches /approve|apply|reject|undo/", () => {
    const featureNames = Object.keys(collectFeatureTools({ dbDir: dir, env: { KIRIE_SANDBOX_MODE: "docker", KIRIE_BROWSER_ENABLED: "1" } }));
    const reg = createMcpToolRegistry({
      channelRegistry: { getAll: () => new Map(), getById: () => undefined, isRunning: () => false, getRunning: () => [] } as unknown as ChannelRegistry,
      memoryDbPath: join(dir, "m.db"), scheduleDbPath: join(dir, "s.db"), chatHistoryDbPath: join(dir, "c.db"),
      backgroundTasksDbPath: join(dir, "b.db"), heartbeatLogDbPath: join(dir, "h.db"),
    });
    const names = [...reg.tools.keys(), ...featureNames];
    reg.shutdown();
    expect(names).toContain("learning_propose");
    expect(names.filter((n) => FORBIDDEN_TOOL_NAME.test(n))).toEqual([]);
  });

  it("no MCP, gateway or ingress source imports the applier, the approval minting or the learning system", () => {
    const offenders: string[] = [];
    const pattern = /\b(mintOwnerApproval|ProposalApplier|createLearningSystem|createProposalActionHandler|createLearningCommands)\b|from\s+["'][^"']*learning\/(applier|system|commands|notifier|kind-handlers)\.js["']/;
    for (const sub of ["mcp", "gateway", "ingress"]) {
      for (const file of listSources(join(SRC, sub))) {
        if (pattern.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no gateway route path mentions approve, apply, reject or undo", () => {
    const routes = readFileSync(join(SRC, "gateway", "routes.ts"), "utf8");
    const paths = [...routes.matchAll(/\.(?:get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => FORBIDDEN_TOOL_NAME.test(p))).toEqual([]);
  });
});
