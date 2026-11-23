/**
 * Command audit (W4-INT item 7, PLAN B.4 and B.12).
 *
 * Builds every feature module against a realistic context (real registries,
 * real stores in a temp dir, a temp HOME) with every feature turned on in the
 * config, then checks every registered command:
 * - it has help text (a description, and `/help <name>` renders it);
 * - it is owner-only unless B.12 marks it public;
 * - no name or alias is registered twice;
 * - the generated /help lists owner commands to the owner and hides them from
 *   anyone else, and `/help <owner command>` answers a non-owner as unknown.
 *
 * Commands are checked by rule, not against a fixed list, so features that are
 * still being filled in (sandbox, computer use) are covered when they land.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  BackgroundTaskStore,
  ChannelRegistry,
  ChatHistoryStore,
  CommandRegistry,
  HeartbeatLogStore,
  InteractionRouter,
  InternalApi,
  KirieConfigSchema,
  MessagePipeline,
  OwnerDirectory,
  OwnerPrompts,
  PromptAddenda,
  PublicIngress,
  RuntimeSettings,
  ScheduleStore,
  SdkOptionsPipeline,
  SecretScrubber,
  SessionStore,
  TurnContextRegistry,
  type AgentExecutor,
  type CommandDefinition,
  type CommandReply,
  type SecurityGate,
  type UnifiedMessage,
} from "@kirie/core";
import { FEATURES, runFeatureSetups, stopFeatures, type DaemonContext, type FeatureHandle } from "./index.js";
import type { FeatureFailure } from "./runner.js";
import { TaskHooks } from "../task-hooks.js";

const OWNER = "1001";
const STRANGER = "2002";

/** B.12: the only commands anyone may run. Everything else is owner-only. */
const PUBLIC_COMMANDS = new Set(["help", "stop", "clear", "context"]);

/** Every feature switched on in config, as far as the schema allows without credentials. */
const ALL_ON_CONFIG = {
  security: { owner: { identities: { telegram: [OWNER] } } },
  proactive: { enabled: true },
  accounts: { rotation: { enabled: true } },
  agent: { fallback: { enabled: true } },
  learning: { enabled: true },
  curator: { enabled: true },
  userModel: { enabled: true },
  goals: { enabled: true },
  loops: { enabled: true },
  webhooks: { enabled: true },
  undo: { enabled: true },
  plugins: { enabled: true },
  computerUse: { enabled: true },
  voice: { enabled: true },
};

let home: string;
let prevHome: string | undefined;
let ctx: DaemonContext;
let handles: FeatureHandle[] = [];
let failures: FeatureFailure[] = [];
const closers: Array<() => void> = [];

function buildContext(dataDir: string): DaemonContext {
  const config = KirieConfigSchema.parse(ALL_ON_CONFIG);
  const owners = new OwnerDirectory(config.security.owner.identities);
  const channelRegistry = new ChannelRegistry();
  const audit = new AuditTrail(join(dataDir, "logs", "audit.jsonl"));
  const settings = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { audit });
  const router = new InteractionRouter({ channelRegistry, owners, audit });
  const ownerPrompts = new OwnerPrompts({ router, channelRegistry, owners, audit, maxPending: config.commands.maxPendingPrompts });
  const commands = new CommandRegistry({ owners, prompts: ownerPrompts, audit });
  const sessionStore = new SessionStore(join(dataDir, "sessions.db"));
  const backgroundTaskStore = new BackgroundTaskStore(join(dataDir, "background-tasks.db"));
  const scheduleStore = new ScheduleStore(join(dataDir, "schedules.db"));
  const chatHistoryStore = new ChatHistoryStore(join(dataDir, "chat-history.db"));
  const heartbeatLogStore = new HeartbeatLogStore(join(dataDir, "heartbeat-logs.db"), null);
  closers.push(() => sessionStore.close(), () => backgroundTaskStore.close(), () => scheduleStore.close(),
    () => chatHistoryStore.close(), () => heartbeatLogStore.close());
  const engine: AgentExecutor = { execute: vi.fn(async () => ({ response: "", sessionId: "s", costUsd: 0, numTurns: 0, isError: false })) } as unknown as AgentExecutor;
  const pipeline = new MessagePipeline({
    channelRegistry,
    securityGate: { check: () => ({ passed: false }) } as unknown as SecurityGate,
    sessionStore,
    agentEngine: engine,
    commands,
    owners,
    chatHistoryStore,
    backgroundTaskStore,
  });
  const resilience = { setResilience: vi.fn() };
  const proactiveState = { running: false };
  return {
    config,
    dataDir,
    agentCwd: dataDir,
    commands,
    owners,
    ownerPrompts,
    settings,
    audit,
    scrubber: new SecretScrubber(),
    sdkOptions: new SdkOptionsPipeline(),
    turnContext: new TurnContextRegistry(),
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    ingress: new PublicIngress(config.ingress),
    taskHooks: new TaskHooks(),
    channelRegistry,
    identityResolver: { addOwnerIdentities: vi.fn() },
    credentialStore: { get: () => undefined, has: () => false, list: () => [] },
    sessionStore,
    pipeline,
    heartbeat: new EventEmitter(),
    proactive: {
      get isRunning() { return proactiveState.running; },
      start: () => { proactiveState.running = true; },
      stop: () => { proactiveState.running = false; },
      setTier2IntervalMinutes: vi.fn(),
      snooze: vi.fn(),
      status: () => ({ running: proactiveState.running, signalQueueSize: 0, lastTriageAt: 0, nextTriageAt: 0, digestQueueSize: 0,
        dedupCacheSize: 0, notifiedTypesCacheSize: 0, tier2IntervalMinutes: 15, snoozedUntil: 0, triageInProgress: false }),
    },
    heartbeatLogStore,
    backgroundTaskStore,
    backgroundTaskManager: { ...resilience, cancelAll: () => 0, sendMessage: vi.fn() },
    scheduleStore,
    chatHistoryStore,
    memoryManager: null,
    embeddingProvider: null,
    agentEngine: resilience,
    v2Sessions: {
      ...resilience,
      closeIdleSessions: vi.fn(() => 0),
      isBusy: () => false,
      getIdleQuery: () => undefined,
      closeAndWait: vi.fn(async () => undefined),
    },
    usageDashboard: {},
    mcpServers: {},
    kirieToolsEnv: {},
    notifyOwner: vi.fn(async () => {}),
    restart: vi.fn(),
  } as unknown as DaemonContext;
}

async function helpAs(senderId: string, topic = ""): Promise<string> {
  const replies: string[] = [];
  const message = {
    id: "m1", channel: "telegram", senderId, senderName: "x", text: topic ? `/help ${topic}` : "/help",
    chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: {},
  } as unknown as UnifiedMessage;
  await ctx.commands.dispatch({
    message,
    identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" },
    source: "channel",
    send: async (r: CommandReply) => { replies.push(r.text); },
  });
  return replies.join("\n");
}

function listed(help: string, def: CommandDefinition): boolean {
  return help.split("\n").some((l) => l.startsWith(`/${def.name} `) || l === `/${def.name}`);
}

describe("command audit: every feature on", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "kirie-cmd-audit-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    const dataDir = join(home, ".kirie");
    mkdirSync(dataDir, { recursive: true });
    ctx = buildContext(dataDir);
    failures = [];
    handles = await runFeatureSetups(FEATURES, ctx, { onFailure: (f) => failures.push(f) });
  });

  afterAll(async () => {
    await stopFeatures(handles);
    for (const close of closers.splice(0)) {
      try { close(); } catch { /* already closed */ }
    }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("every feature sets up without error (a duplicate name would throw here)", () => {
    expect(failures).toEqual([]);
    expect(handles.map((h) => h.name)).toEqual(FEATURES.map((f) => f.name));
  });

  it("registers the core and feature commands", () => {
    const names = ctx.commands.list().map((d) => d.name);
    for (const n of ["help", "status", "pending", "approvals", "undo", "learn", "proposals", "curator", "profile", "goal", "loop", "heartbeat", "webhook", "secrets", "plugins", "voice", "call", "accounts"]) {
      expect(names).toContain(n);
    }
  });

  it("no name or alias is registered twice", () => {
    const all = ctx.commands.list().flatMap((d) => [d.name, ...(d.aliases ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("every command has help text, and /help <name> shows it to the owner", async () => {
    for (const def of ctx.commands.list()) {
      expect(def.description.trim().length, `/${def.name} description`).toBeGreaterThan(5);
      const help = await helpAs(OWNER, def.name);
      expect(help, `/help ${def.name}`).toContain(def.description);
      expect(help).not.toMatch(/^Unknown command/);
    }
  });

  it("every command is owner-only unless B.12 marks it public", () => {
    const offenders = ctx.commands.list().filter((d) => d.ownerOnly !== true && !PUBLIC_COMMANDS.has(d.name)).map((d) => d.name);
    expect(offenders).toEqual([]);
    for (const name of PUBLIC_COMMANDS) {
      const def = ctx.commands.get(name);
      if (def) expect(def.ownerOnly, `/${name}`).toBe(false);
    }
  });

  it("no owner-only command widens its scope beyond the DM (B.12: ownerOnly, scope dm)", () => {
    const wide = ctx.commands.list().filter((d) => d.ownerOnly !== false && d.scope === "any").map((d) => d.name);
    expect(wide).toEqual([]);
  });

  it("/help lists owner commands to the owner and hides them from anyone else", async () => {
    const ownerHelp = await helpAs(OWNER);
    const strangerHelp = await helpAs(STRANGER);
    for (const def of ctx.commands.list()) {
      if (PUBLIC_COMMANDS.has(def.name)) {
        expect(listed(strangerHelp, def), `/${def.name} for a non-owner`).toBe(true);
        expect(listed(ownerHelp, def), `/${def.name} for the owner`).toBe(true);
        continue;
      }
      expect(listed(ownerHelp, def), `/${def.name} for the owner`).toBe(true);
      expect(listed(strangerHelp, def), `/${def.name} for a non-owner`).toBe(false);
      expect(await helpAs(STRANGER, def.name), `/help ${def.name} for a non-owner`).toMatch(/^Unknown command/);
    }
  });

  it("the non-owner menu has only public commands; the owner menu has every visible command", () => {
    const publicMenu = ctx.commands.menu({ forOwner: false }).map((m) => m.command);
    expect(publicMenu.every((n) => PUBLIC_COMMANDS.has(n))).toBe(true);
    const ownerMenu = ctx.commands.menu({ forOwner: true }).map((m) => m.command);
    for (const def of ctx.commands.list()) if (!def.hidden) expect(ownerMenu).toContain(def.name);
  });
});
