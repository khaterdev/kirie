import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  CommandRegistry,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  TurnContextRegistry,
  type CommandReply,
  type ResolvedIdentity,
  type TurnCompleteEvent,
  type UnifiedMessage,
} from "@kirie/core";
import type { SkillDefinition } from "@kirie/skills";
import type { DaemonContext, FeatureHandle } from "./types.js";
import { getLearningSystem, setupLearning } from "./learning.js";
import { createCuratorSetup } from "./curator.js";
import { syncBundledSkills } from "../skill-sync.js";

const OWNER = "1001";
const STRANGER = "2002";
/** Never set on any machine: makes the bundled fixture ineligible (B7). */
const MISSING_ENV = "KIRIE_CURATOR_TEST_NEVER_SET_ENV";

let dir: string;
let dataDir: string;
let repoSkills: string;
let userRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-feature-curator-"));
  dataDir = join(dir, "kirie");
  repoSkills = join(dir, "repo-skills");
  userRoot = join(dir, "user-skills");
  mkdirSync(dataDir);
  mkdirSync(join(repoSkills, "weather"), { recursive: true });
  writeFileSync(join(repoSkills, "weather", "SKILL.md"), `---\nname: weather\ndescription: Get the weather\nrequires:\n  env: [${MISSING_ENV}]\n---\n\n# Weather\n`);
  mkdirSync(join(userRoot, "personal"), { recursive: true });
  writeFileSync(join(userRoot, "personal", "SKILL.md"), "no frontmatter in the user's own skill");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Ctx = DaemonContext & { heartbeat: EventEmitter };

function context(config: Record<string, unknown> = {}): Ctx {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const ctx = {
    config: KirieConfigSchema.parse(config),
    dataDir,
    agentCwd: dataDir,
    commands: new CommandRegistry({ owners }),
    owners,
    ownerPrompts: { sendCard: vi.fn(async () => null), onAction: () => {} },
    settings: new RuntimeSettings(join(dataDir, "state", "runtime-settings.json")),
    audit: new AuditTrail(join(dataDir, "logs", "audit.jsonl")),
    sdkOptions: new SdkOptionsPipeline(),
    turnContext: new TurnContextRegistry(),
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    pipeline: { onTurnComplete: (_l: (ev: TurnCompleteEvent) => void) => () => {} },
    heartbeat: new EventEmitter(),
    chatHistoryStore: { recent: () => [] },
    scheduleStore: { list: () => [] },
    memoryManager: null,
    embeddingProvider: null,
    kirieToolsEnv: {} as Record<string, string>,
  };
  return ctx as unknown as Ctx;
}

interface Booted { ctx: Ctx; handles: FeatureHandle[] }

/** What lifecycle.ts does: boot sync first, then the learning and curator feature setups and starts. */
async function boot(config: Record<string, unknown> = {}): Promise<Booted> {
  const bundled: SkillDefinition[] = [{
    name: "weather", description: "Get the weather", content: "# Weather\n", source: "bundled", filePath: join(repoSkills, "weather", "SKILL.md"),
  }];
  syncBundledSkills({ skills: bundled, sdkSkillsDir: join(dataDir, ".claude", "skills"), dataDir });
  const ctx = context(config);
  const handles = [await setupLearning(ctx), await createCuratorSetup({ bundledDir: repoSkills, userSkillsRoot: userRoot, llm: null })(ctx)];
  for (const h of handles) await h.start?.();
  return { ctx, handles };
}

async function shutdown(b: Booted): Promise<void> {
  for (const h of [...b.handles].reverse()) await h.stop?.();
}

async function say(ctx: DaemonContext, text: string, senderId = OWNER): Promise<{ kind: string; reply: string }> {
  const sent: CommandReply[] = [];
  const message: UnifiedMessage = { id: `m${Math.random()}`, channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null };
  const identity: ResolvedIdentity = { role: "owner", canonicalId: `telegram:${senderId}`, channel: "telegram", senderId };
  const outcome = await ctx.commands.dispatch({ message, identity, source: "channel", send: async (r) => { sent.push(r); } });
  return { kind: outcome.kind, reply: sent.map((r) => r.text).join("\n") };
}

const skillsDir = (): string => join(dataDir, ".claude", "skills");

describe("curator feature", () => {
  it("registers /curator and the four proposal kinds; no MCP route or internal API mount", async () => {
    const b = await boot();
    try {
      expect(b.ctx.commands.list().map((c) => c.name).sort()).toEqual(["curator", "learn", "proposals"]);
      const applier = getLearningSystem(b.ctx)!.applier;
      for (const kind of ["skill.archive", "skill.merge", "skill.adopt", "skill.revert"] as const) expect(applier.hasKind(kind)).toBe(true);
      expect(b.ctx.internalApi.apps()).toEqual([]);
      expect(Object.keys(b.ctx.kirieToolsEnv).filter((k) => k.includes("CURATOR"))).toEqual([]);
    } finally {
      await shutdown(b);
    }
  });

  it("the weekly run is off by default: heartbeat ticks do nothing", async () => {
    const b = await boot();
    try {
      for (let t = 1; t <= 720; t++) b.ctx.heartbeat.emit("tick", { tickNumber: t, timestamp: Date.now(), pendingRetries: 0 });
      const sys = getLearningSystem(b.ctx)!;
      expect(sys.kv.get("curator:last_run_at")).toBeUndefined();
      expect(sys.db.prepare("SELECT COUNT(*) AS n FROM curator_runs").get()).toEqual({ n: 0 });
    } finally {
      await shutdown(b);
    }
  });

  it("when turned on, an overdue heartbeat check runs the curator (no schedules row involved)", async () => {
    const b = await boot();
    try {
      expect((await say(b.ctx, "/curator on")).reply).toContain("Weekly skill check is on");
      const sys = getLearningSystem(b.ctx)!;
      sys.kv.set("curator:last_run_at", new Date(Date.now() - 10 * 86_400_000).toISOString());
      b.ctx.heartbeat.emit("tick", { tickNumber: 360, timestamp: Date.now(), pendingRetries: 0 });
      await vi.waitFor(() => {
        expect(sys.db.prepare("SELECT trigger FROM curator_runs WHERE finished_at IS NOT NULL").all()).toEqual([{ trigger: "schedule" }]);
      });
    } finally {
      await shutdown(b);
    }
  });

  it("run -> owner approves -> archived skill survives a restart -> restore brings it back", async () => {
    let b = await boot();
    expect(existsSync(join(skillsDir(), "weather", "SKILL.md"))).toBe(true);

    const run = await say(b.ctx, "/curator run");
    expect(run.kind).toBe("handled");
    const id = Number(/#(\d+) archive weather/.exec(run.reply)?.[1]);
    expect(id).toBeGreaterThan(0);
    // Nothing moved before approval.
    expect(existsSync(join(skillsDir(), "weather", "SKILL.md"))).toBe(true);
    // A non-owner cannot approve it.
    expect((await say(b.ctx, `/proposals approve ${id}`, STRANGER)).kind).toBe("denied");
    expect(existsSync(join(skillsDir(), "weather"))).toBe(true);

    const approved = await say(b.ctx, `/proposals approve ${id}`);
    expect(approved.reply).toContain(`Applied #${id}`);
    expect(existsSync(join(skillsDir(), "weather"))).toBe(false);
    const archive = readdirSync(join(dataDir, "skills-archive")).filter((n) => n.startsWith("weather@"));
    expect(archive).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, "skills-archive", archive[0]!, "ARCHIVE.json"), "utf8"))).toMatchObject({ name: "weather", proposalId: id });
    await shutdown(b);

    // Restart: the boot sync must not write the archived bundled skill back.
    b = await boot();
    expect(existsSync(join(skillsDir(), "weather"))).toBe(false);
    expect((await say(b.ctx, "/curator list archived")).reply).toContain("weather");

    expect((await say(b.ctx, "/curator restore weather")).reply).toContain("Restored weather");
    expect(readFileSync(join(skillsDir(), "weather", "SKILL.md"), "utf8")).toContain("name: weather");
    await shutdown(b);

    // After a restore the boot sync manages it again.
    b = await boot();
    expect(existsSync(join(skillsDir(), "weather", "SKILL.md"))).toBe(true);
    await shutdown(b);
  });

  it("reports a skill with no frontmatter as broken and proposes a fix instead of crashing", async () => {
    const b = await boot();
    try {
      mkdirSync(join(skillsDir(), "remotion"));
      writeFileSync(join(skillsDir(), "remotion", "SKILL.md"), "# Remotion\n\nRender videos with React.\n");
      const run = await say(b.ctx, "/curator run");
      expect(run.reply).toMatch(/#\d+ fix remotion/);
      expect((await say(b.ctx, "/curator list broken")).reply).toContain("remotion · B2");
      expect(readFileSync(join(skillsDir(), "remotion", "SKILL.md"), "utf8")).toBe("# Remotion\n\nRender videos with React.\n");
    } finally {
      await shutdown(b);
    }
  });

  it("never touches ~/.claude/skills (the user root), even with includeUserSkills on", async () => {
    const b = await boot({ curator: { includeUserSkills: true } });
    try {
      await say(b.ctx, "/curator run");
      expect(readdirSync(userRoot)).toEqual(["personal"]);
      expect(readFileSync(join(userRoot, "personal", "SKILL.md"), "utf8")).toBe("no frontmatter in the user's own skill");
      const sys = getLearningSystem(b.ctx)!;
      expect(sys.store.list({ status: "pending" }).some((p) => JSON.stringify(p.payload).includes("personal"))).toBe(false);
    } finally {
      await shutdown(b);
    }
  });
});
