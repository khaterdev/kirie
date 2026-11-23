import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProposalApplier, isMintedOwnerApproval, mintOwnerApproval, type OwnerApproval } from "./applier.js";
import { LearningIntake, type ProposalSubmission } from "./intake.js";
import { appendUnderSection, registerLearningKindHandlers, type LearningMemoryTarget } from "./kind-handlers.js";
import { ProposalStore } from "./proposal-store.js";
import { SkillStateStore } from "./skill-state-store.js";
import { proposalPayloadHash, sha256Hex } from "./proposal-types.js";
import {
  OWNER_ID, STRANGER_ID, fakeAudit, fakeOwners, intakeConfig, skillMd, tempLearningEnv,
  type FakeAudit, type TempLearningEnv,
} from "./learning.test-util.js";

let env: TempLearningEnv;
let store: ProposalStore;
let skillState: SkillStateStore;
let audit: FakeAudit;
let applier: ProposalApplier;
let intake: LearningIntake;
let skillsRoot: string;
let memoryMd: string;
let memory: Map<string, { content: string; tags: string[] }>;
let mdMax = 16_384;
let owner: OwnerApproval;

function memoryTarget(): LearningMemoryTarget {
  return {
    recall: (k) => memory.get(k) ?? null,
    store: (k, content, tags) => { memory.set(k, { content, tags }); },
    delete: (k) => memory.delete(k),
  };
}

beforeEach(() => {
  env = tempLearningEnv();
  store = new ProposalStore(env.db);
  skillState = new SkillStateStore(env.db);
  audit = fakeAudit();
  skillsRoot = join(env.dir, "agent", ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  memoryMd = join(env.dir, "MEMORY.md");
  memory = new Map();
  mdMax = 16_384;
  applier = new ProposalApplier({ store, backupRoot: join(env.dir, "backups", "learning"), audit, config: () => ({ allowUntrustedSkillProposals: false }) });
  registerLearningKindHandlers(applier, { memory: memoryTarget(), memoryMdPath: memoryMd, memoryMdMaxBytes: () => mdMax, skillsRoot, skillState });
  intake = new LearningIntake({ store, config: () => intakeConfig(), audit, skillsRoot, skillState, memoryRecall: (k) => memory.get(k) ?? null });
  owner = mintOwnerApproval(fakeOwners, { channel: "telegram", senderId: OWNER_ID, via: "command" })!;
});
afterEach(() => env.cleanup());

function file(sub: Partial<ProposalSubmission> & Pick<ProposalSubmission, "kind" | "payload">): number {
  const r = intake.submit({ title: "A proposal", origin: "reflection", trust: "owner", ...sub });
  if (!("id" in r)) throw new Error(`dropped: ${r.dropped}`);
  return r.id;
}

describe("owner approval", () => {
  it("is minted only for an owner, and a look-alike object is refused", async () => {
    expect(mintOwnerApproval(fakeOwners, { channel: "telegram", senderId: STRANGER_ID, via: "button" })).toBeNull();
    expect(isMintedOwnerApproval(owner)).toBe(true);
    const forged: OwnerApproval = { channel: "telegram", senderId: OWNER_ID, via: "command", at: new Date().toISOString() };
    expect(isMintedOwnerApproval(forged)).toBe(false);
    const id = file({ kind: "memory.upsert", payload: { key: "k:1", content: "c", tags: [] } });
    const out = await applier.approve(id, forged);
    expect(out).toMatchObject({ ok: false, code: "not_owner" });
    expect(applier.reject(id, forged)).toBe(false);
    expect(memory.size).toBe(0);
    expect(store.get(id)!.status).toBe("pending");
  });
});

describe("applier", () => {
  it("memory.upsert applies with a backup and undo deletes a key that did not exist", async () => {
    const id = file({ kind: "memory.upsert", payload: { key: "owner:tz", content: "Cairo", tags: ["owner"] } });
    const out = await applier.approve(id, owner);
    expect(out.ok).toBe(true);
    expect(memory.get("owner:tz")).toEqual({ content: "Cairo", tags: ["owner", "learned"] });
    const rec = store.get(id)!;
    expect(rec.status).toBe("applied");
    expect(rec.decidedBy).toBe(`telegram:${OWNER_ID}`);
    expect(existsSync(String(rec.applyResult!.backupDir))).toBe(true);
    expect(audit.actions()).toContain("proposal.applied");
    expect((await applier.undo(id, owner)).ok).toBe(true);
    expect(memory.has("owner:tz")).toBe(false);
    expect(store.get(id)!.status).toBe("undone");
  });

  it("memory.upsert undo restores the previous content; a changed key is stale", async () => {
    memory.set("owner:tz", { content: "Giza", tags: ["x"] });
    const id = file({ kind: "memory.upsert", payload: { key: "owner:tz", content: "Cairo", tags: [] } });
    expect((await applier.approve(id, owner)).ok).toBe(true);
    await applier.undo(id, owner);
    expect(memory.get("owner:tz")).toEqual({ content: "Giza", tags: ["x"] });

    const id2 = file({ kind: "memory.upsert", payload: { key: "owner:tz", content: "Luxor", tags: [] } });
    memory.set("owner:tz", { content: "Aswan", tags: [] });
    const out = await applier.approve(id2, owner);
    expect(out).toMatchObject({ ok: false, code: "stale" });
    expect(store.get(id2)!.status).toBe("failed");
    expect(memory.get("owner:tz")!.content).toBe("Aswan");
  });

  it("memory_md.append adds under the section, enforces the size cap, and undo restores", async () => {
    writeFileSync(memoryMd, "# Memory\n\n## Knowledge Index\n- a: first\n\n## Other\n- z\n");
    const id = file({ kind: "memory_md.append", payload: { section: "Knowledge Index", line: "b: second" } });
    expect((await applier.approve(id, owner)).ok).toBe(true);
    expect(readFileSync(memoryMd, "utf8")).toBe("# Memory\n\n## Knowledge Index\n- a: first\n- b: second\n\n## Other\n- z\n");
    expect((await applier.undo(id, owner)).ok).toBe(true);
    expect(readFileSync(memoryMd, "utf8")).toBe("# Memory\n\n## Knowledge Index\n- a: first\n\n## Other\n- z\n");

    mdMax = 1024;
    writeFileSync(memoryMd, "x".repeat(1020));
    const id2 = file({ kind: "memory_md.append", payload: { section: "S", line: "one more line" } });
    expect(await applier.approve(id2, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(readFileSync(memoryMd, "utf8")).toBe("x".repeat(1020));
  });

  it("skill.create writes exactly one SKILL.md with a backup record, and undo removes it", async () => {
    const md = skillMd("deploy-app");
    const id = file({ kind: "skill.create", payload: { name: "deploy-app", description: "How to deploy-app", skillMd: md } });
    const out = await applier.approve(id, owner);
    expect(out).toMatchObject({ ok: true, status: "applied" });
    expect(out.ok && out.message).toContain("Active from the next session");
    expect(readdirSync(join(skillsRoot, "deploy-app"))).toEqual(["SKILL.md"]);
    expect(readFileSync(join(skillsRoot, "deploy-app", "SKILL.md"), "utf8")).toBe(md);
    expect(skillState.get("project", "deploy-app")).toMatchObject({ source: "learned", approvedHash: sha256Hex(md) });
    expect(store.get(id)!.applyResult!.backupDir).toBeTruthy();
    expect((await applier.undo(id, owner)).ok).toBe(true);
    expect(existsSync(join(skillsRoot, "deploy-app"))).toBe(false);
    expect(skillState.get("project", "deploy-app")).toBeNull();
  });

  it("skill.patch: baseHash mismatch fails stale; a bundled skill gets the override flag; undo restores", async () => {
    mkdirSync(join(skillsRoot, "tmux"));
    const v1 = skillMd("tmux", "Tmux", "v1\n");
    writeFileSync(join(skillsRoot, "tmux", "SKILL.md"), v1);
    skillState.insert({ name: "tmux", root: "project", source: "bundled" });
    const id = file({ kind: "skill.patch", payload: { name: "tmux", baseHash: sha256Hex(v1), newSkillMd: skillMd("tmux", "Tmux", "v2\n") } });
    expect(store.get(id)!.riskFlags).toContain("bundled_skill");
    expect((await applier.approve(id, owner)).ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "tmux", "SKILL.md"), "utf8")).toContain("v2");
    expect(skillState.get("project", "tmux")!.override).toBe(true);
    expect((await applier.undo(id, owner)).ok).toBe(true);
    expect(readFileSync(join(skillsRoot, "tmux", "SKILL.md"), "utf8")).toBe(v1);
    expect(skillState.get("project", "tmux")!.override).toBe(false);

    const id2 = file({ kind: "skill.fix", payload: { name: "tmux", baseHash: sha256Hex(v1), newSkillMd: skillMd("tmux", "Tmux", "v3\n"), issue: "typo" } });
    writeFileSync(join(skillsRoot, "tmux", "SKILL.md"), skillMd("tmux", "Tmux", "edited by hand\n"));
    expect(await applier.approve(id2, owner)).toMatchObject({ ok: false, code: "stale" });
    expect(readFileSync(join(skillsRoot, "tmux", "SKILL.md"), "utf8")).toContain("edited by hand");
  });

  it("refuses a path-traversal name stored behind intake's back", async () => {
    const id = store.insert({
      kind: "skill.create", title: "x", rationale: "", payload: { name: "../escape", description: "d", skillMd: skillMd("../escape") },
      payloadHash: "f".repeat(64), origin: "reflection", trust: "owner", riskFlags: [], redactions: 0,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })!;
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(existsSync(join(skillsRoot, "..", "escape"))).toBe(false);
  });

  it("refuses to patch through a symlinked skill dir", async () => {
    const outside = join(env.dir, "outside");
    mkdirSync(outside);
    const v1 = skillMd("linked");
    writeFileSync(join(outside, "SKILL.md"), v1);
    symlinkSync(outside, join(skillsRoot, "linked"));
    const id = file({ kind: "skill.patch", payload: { name: "linked", baseHash: sha256Hex(v1), newSkillMd: skillMd("linked", "x", "changed\n") } });
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe(v1);
  });

  it("double approve is idempotent", async () => {
    const id = file({ kind: "memory.upsert", payload: { key: "k:double", content: "c", tags: [] } });
    const [a, b] = await Promise.all([applier.approve(id, owner), applier.approve(id, owner)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "already_decided" });
  });

  it("force is required for scanner_block", async () => {
    const md = skillMd("runner", "Run things", "```js\neval(x)\n```\n");
    const id = file({ kind: "skill.create", payload: { name: "runner", description: "Run things", skillMd: md } });
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "needs_force" });
    expect(store.get(id)!.status).toBe("pending");
    expect((await applier.approve(id, owner, { force: true })).ok).toBe(true);
  });

  it("an unverified skill proposal cannot be applied", async () => {
    const id = file({ kind: "skill.create", origin: "agent_tool", payload: { name: "agent-made", description: "d", skillMd: skillMd("agent-made", "d") } });
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "unverified" });
    expect(existsSync(join(skillsRoot, "agent-made"))).toBe(false);
  });

  it("the stored payload is scrubbed again at apply", async () => {
    // A row written without intake (simulates a secret added to the known list after intake).
    const secretish = ["gh", "p_", "Ab1".repeat(12)].join("");
    const payload = { key: "k:s", content: `token ${secretish}`, tags: [] };
    const id = store.insert({
      kind: "memory.upsert", title: "x", rationale: "", payload,
      payloadHash: proposalPayloadHash("memory.upsert", payload), origin: "reflection", trust: "owner", riskFlags: [], redactions: 0,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })!;
    expect((await applier.approve(id, owner)).ok).toBe(true);
    expect(memory.get("k:s")!.content).not.toContain(secretish);
    expect(JSON.stringify(store.get(id)!.payload)).not.toContain(secretish);
  });

  it("a payload changed in the DB after filing is refused (it no longer matches its hash)", async () => {
    const id = file({ kind: "memory.upsert", payload: { key: "k:t", content: "shown content", tags: [] } });
    env.db.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ key: "k:t", content: "swapped content", tags: [] }), id);
    expect(await applier.approve(id, owner)).toMatchObject({ ok: false, code: "invalid" });
    expect(memory.size).toBe(0);
    expect(audit.actions()).toContain("proposal.integrity_failed");
  });

  it("a partial undo can be retried to completion", async () => {
    writeFileSync(memoryMd, "## Knowledge Index\n- a\n");
    const id = file({ kind: "memory.upsert", payload: { key: "k:p", content: "c", tags: [], pointer: { section: "Knowledge Index", line: "k:p: c" } } });
    expect((await applier.approve(id, owner)).ok).toBe(true);
    expect(readFileSync(memoryMd, "utf8")).toContain("- k:p: c");
    // Simulate a crash after the memory was restored but before MEMORY.md was.
    memory.delete("k:p");
    expect((await applier.undo(id, owner)).ok).toBe(true);
    expect(readFileSync(memoryMd, "utf8")).toBe("## Knowledge Index\n- a\n");
    expect(memory.has("k:p")).toBe(false);
  });

  it("a retried append after a crash does not add the line twice", () => {
    const once = appendUnderSection("## S\n- a\n", "S", "b");
    expect(appendUnderSection(once, "S", "b")).toBe(once);
  });

  it("reject is remembered and expiry never applies", async () => {
    const a = file({ kind: "memory.upsert", payload: { key: "k:a", content: "a", tags: [] } });
    expect(applier.reject(a, owner, "no")).toBe(true);
    expect(store.get(a)).toMatchObject({ status: "rejected", rejectReason: "no" });
    const b = file({ kind: "memory.upsert", payload: { key: "k:b", content: "b", tags: [] } });
    const expired = applier.expireDue(new Date(Date.now() + 15 * 86_400_000));
    expect(expired).toBe(1);
    expect(store.get(b)!.status).toBe("expired");
    expect(memory.size).toBe(0);
    expect(await applier.approve(b, owner)).toMatchObject({ ok: false, code: "already_decided" });
  });

  it("registerKind throws on a duplicate kind; preview falls back to JSON", () => {
    expect(() => applier.registerKind("memory.upsert", { apply: async () => ({}), preview: () => "" })).toThrow(/already/);
    expect(applier.preview({ kind: "skill.archive", payload: { name: "x" } })).toContain("\"name\"");
  });
});

describe("appendUnderSection", () => {
  it("creates the section at the end when missing", () => {
    expect(appendUnderSection("", "Index", "a")).toBe("## Index\n- a\n");
    expect(appendUnderSection("# T\n", "Index", "a")).toBe("# T\n\n## Index\n- a\n");
  });
});
