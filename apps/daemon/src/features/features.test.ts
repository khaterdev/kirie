import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommandRegistry,
  OwnerDirectory,
  PromptAddenda,
  InternalApi,
  SecretScrubber,
  type ChannelAdapter,
  type ChannelRegistry,
} from "@kirie/core";
import { FEATURES, runFeatureSetups, startFeatures, stopFeatures, type DaemonContext, type FeatureEntry } from "./index.js";
import { featureFailureNotice, type FeatureFailure } from "./runner.js";
import { renderCommandsAddendum } from "./core-commands.js";
import { createOwnerNotifier, OWNER_NOTIFY_KEY_INTERVAL_MS } from "./notify.js";
import { registerCommandMenus } from "./menus.js";
import {
  registerKnownSecrets, readSecretsDir, sanitizeErrorForLog, SCRUBBING_OFF_NOTICE, setupScrubbing,
  freezeScrubbingConfig, resetFrozenScrubbingConfigForTesting,
} from "./scrubbing.js";
import { TaskHooks } from "../task-hooks.js";
import { KirieConfigSchema, type BackgroundTask } from "@kirie/core";

const OWNER = "1001";
/** Features whose stub has been replaced by a real setup; each is covered by its own test file. */
const FILLED_FEATURES = new Set(["accounts", "approvals", "computer-use", "curator", "goals", "heartbeat-control", "learning", "loops", "plugins", "sandbox", "secrets", "undo", "usermodel", "voice", "webhooks"]);
const STUB_FEATURES = FEATURES.filter((f) => !FILLED_FEATURES.has(f.name));

/** A DaemonContext with real registries and inert fakes for everything a stub never touches. */
function fakeContext(over: Partial<DaemonContext> = {}): DaemonContext {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const commands = new CommandRegistry({ owners });
  const ctx = {
    config: KirieConfigSchema.parse({}),
    dataDir: "/nonexistent-kirie-test",
    agentCwd: "/nonexistent-kirie-test",
    commands,
    owners,
    ownerPrompts: { pending: () => [], answerByCode: async () => ({ status: "not-found" as const }) },
    settings: {},
    audit: {},
    scrubber: new SecretScrubber(),
    sdkOptions: {},
    turnContext: {},
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    ingress: {},
    taskHooks: new TaskHooks(),
    channelRegistry: { getRunning: () => [], getAll: () => new Map(), isRunning: () => false, getById: () => undefined },
    identityResolver: {},
    credentialStore: {},
    sessionStore: { count: () => 0, listAll: () => [], getRow: () => undefined },
    pipeline: { abortSession: () => false, abortAll: () => 0, clearSession: () => {} },
    heartbeat: {},
    proactive: null,
    heartbeatLogStore: null,
    backgroundTaskStore: {},
    backgroundTaskManager: { cancelAll: () => 0 },
    scheduleStore: {},
    chatHistoryStore: { messageCount: () => 0 },
    memoryManager: null,
    embeddingProvider: null,
    agentEngine: {},
    v2Sessions: null,
    usageDashboard: {},
    mcpServers: {},
    kirieToolsEnv: {},
    notifyOwner: vi.fn(async () => {}),
    restart: vi.fn(),
    ...over,
  };
  return ctx as unknown as DaemonContext;
}

describe("FEATURES", () => {
  it("lists every feature in the B.10 order", () => {
    expect(FEATURES.map((f) => f.name)).toEqual([
      "core-commands", "scrubbing", "accounts", "approvals", "sandbox", "undo", "learning", "curator",
      "usermodel", "goals", "loops", "heartbeat-control", "webhooks", "secrets", "plugins", "computer-use", "voice",
    ]);
  });

  it("the daemon sets up and starts with every feature stubbed; stubs register nothing", async () => {
    const ctx = fakeContext();
    const handles = await runFeatureSetups(STUB_FEATURES, ctx);
    expect(handles.map((h) => h.name)).toEqual(STUB_FEATURES.map((f) => f.name));
    const started = await startFeatures(handles);
    expect(started).toHaveLength(STUB_FEATURES.length);
    // Only core-commands registers commands and an addendum; only scrubbing sets an env key.
    expect(ctx.commands.list()).toHaveLength(14);
    expect(ctx.promptAddenda.names()).toEqual(["commands"]);
    expect(Object.keys(ctx.kirieToolsEnv)).toEqual(["KIRIE_SCRUB_CONFIG"]);
    expect(ctx.internalApi.apps()).toEqual([]);
    expect(ctx.notifyOwner).not.toHaveBeenCalled();
    await stopFeatures(started);
  });
});

describe("feature runner", () => {
  it("skips a feature whose setup throws and reports it; the others still run", async () => {
    const order: string[] = [];
    const features: FeatureEntry[] = [
      { name: "one", setup: () => { order.push("setup:one"); return { name: "one", start: () => { order.push("start:one"); }, stop: () => { order.push("stop:one"); } }; } },
      { name: "broken", setup: () => { throw new Error("bad config"); } },
      { name: "two", setup: async () => { order.push("setup:two"); return { name: "two", start: () => { order.push("start:two"); }, stop: () => { order.push("stop:two"); } }; } },
    ];
    const failures: unknown[] = [];
    const handles = await runFeatureSetups(features, fakeContext(), { onFailure: (f) => failures.push(f) });
    expect(handles.map((h) => h.name)).toEqual(["one", "two"]);
    expect(failures).toEqual([{ name: "broken", phase: "setup", message: "bad config" }]);
    const started = await startFeatures(handles);
    await stopFeatures(started);
    expect(order).toEqual(["setup:one", "setup:two", "start:one", "start:two", "stop:two", "stop:one"]);
  });

  it("a feature whose start throws is stopped, reported, and left out of the started list", async () => {
    const stop = vi.fn();
    const failures: unknown[] = [];
    const started = await startFeatures(
      [{ name: "flaky", start: () => { throw new Error("port in use"); }, stop }, { name: "ok" }],
      { onFailure: (f) => failures.push(f) },
    );
    expect(started.map((h) => h.name)).toEqual(["ok"]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([{ name: "flaky", phase: "start", message: "port in use" }]);
  });

  it("CONF-N14: a security feature that fails to set up or start is reported as one, and the daemon keeps running", async () => {
    const failures: FeatureFailure[] = [];
    const stop = vi.fn();
    const handles = await runFeatureSetups([
      { name: "approvals", security: "the approval gate", setup: () => { throw new Error("bad rule"); } },
      { name: "learning", security: "the skill write guard", setup: () => ({ name: "learning", start: () => { throw new Error("db locked"); }, stop }) },
      { name: "goals", setup: () => { throw new Error("nope"); } },
      { name: "ok", setup: () => ({ name: "ok" }) },
    ], fakeContext(), { onFailure: (f) => failures.push(f) });
    const started = await startFeatures(handles, { onFailure: (f) => failures.push(f) });
    expect(started.map((h) => h.name)).toEqual(["ok"]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      { name: "approvals", phase: "setup", message: "bad rule", security: "the approval gate" },
      { name: "goals", phase: "setup", message: "nope" },
      { name: "learning", phase: "start", message: "db locked", security: "the skill write guard" },
    ]);
    const notice = featureFailureNotice(failures)!;
    expect(notice).toMatch(/^Security warning/);
    expect(notice).toContain("WITHOUT the approval gate (approvals)");
    expect(notice).toContain("WITHOUT the skill write guard (learning)");
    expect(notice).toContain("goals");
    expect(notice).not.toContain("bad rule");
  });

  it("CONF-N14: approvals, scrubbing and the skill write guard (learning) are marked as security features", () => {
    const security = Object.fromEntries(FEATURES.filter((f) => f.security).map((f) => [f.name, f.security]));
    expect(Object.keys(security).sort()).toEqual(["approvals", "learning", "scrubbing"]);
    expect(featureFailureNotice([])).toBeNull();
    expect(featureFailureNotice([{ name: "goals", phase: "setup", message: "x" }])).toBe("Kirie started without these features because they failed to start: goals. See the daemon log.");
  });

  it("stopFeatures never throws", async () => {
    await expect(stopFeatures([{ name: "x", stop: () => { throw new Error("boom"); } }])).resolves.toBeUndefined();
  });
});

describe("commands addendum", () => {
  it("lists every command in the owner DM and only public ones elsewhere; nothing for background", async () => {
    const ctx = fakeContext();
    await runFeatureSetups(FEATURES.slice(0, 1), ctx);
    const owner = renderCommandsAddendum(ctx.commands, { kind: "chat", ownerDm: true })!;
    expect(owner).toContain("/restart - Restart the daemon");
    const other = renderCommandsAddendum(ctx.commands, { kind: "chat", ownerDm: false })!;
    expect(other).toContain("/help - ");
    expect(other).not.toContain("/restart");
    expect(renderCommandsAddendum(ctx.commands, { kind: "background", ownerDm: false })).toBeNull();
  });
});

describe("owner notifier", () => {
  function setup(running = true) {
    const sendText = vi.fn(async () => [{ id: "1", timestamp: 0 }]);
    const adapter = { id: "telegram", sendText } as unknown as ChannelAdapter;
    let now = 0;
    const notify = createOwnerNotifier({
      owners: new OwnerDirectory({ telegram: [OWNER] }),
      channelRegistry: { getById: () => adapter, isRunning: () => running } as unknown as ChannelRegistry,
      now: () => now,
    });
    return { notify, sendText, advance: (ms: number) => { now += ms; } };
  }

  it("sends one plain line to the owner's DM", async () => {
    const { notify, sendText } = setup();
    await notify("hello");
    expect(sendText).toHaveBeenCalledWith({ ctx: { chatId: OWNER }, text: "hello", plain: true });
  });

  it("rate limits per key to one per 10 minutes", async () => {
    const { notify, sendText, advance } = setup();
    await notify("a", { key: "k" });
    await notify("b", { key: "k" });
    await notify("c", { key: "other" });
    expect(sendText).toHaveBeenCalledTimes(2);
    advance(OWNER_NOTIFY_KEY_INTERVAL_MS);
    await notify("d", { key: "k" });
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("always sends a notice marked as a state change, and still coalesces an identical repeat (RUNTIME-B4)", async () => {
    const { notify, sendText } = setup();
    await notify("off", { key: "k:off", always: true });
    await notify("off again", { key: "k:off" });
    await notify("on", { key: "k:on", always: true });
    await notify("off", { key: "k:off", always: true });
    expect(sendText.mock.calls.map((c) => (c as unknown as [{ text: string }])[0].text)).toEqual(["off", "on", "off"]);
  });

  it("does nothing when the channel is down or no owner exists", async () => {
    const { notify, sendText } = setup(false);
    await notify("x");
    expect(sendText).not.toHaveBeenCalled();
    const none = createOwnerNotifier({ owners: new OwnerDirectory({}), channelRegistry: { getById: () => undefined, isRunning: () => false } as unknown as ChannelRegistry });
    await expect(none("x")).resolves.toBeUndefined();
  });
});

describe("command menus", () => {
  it("registers the public menu in the default scope and the full menu per owner chat", async () => {
    const ctx = fakeContext();
    await runFeatureSetups(FEATURES.slice(0, 1), ctx);
    const registerCommands = vi.fn(async (_menu: Array<{ command: string }>, _opts?: { chatId?: string }) => {});
    await registerCommandMenus({ id: "telegram", registerCommands }, ctx.commands, { telegram: [OWNER, 42], discord: [], slack: [], whatsapp: [], signal: [] });
    expect(registerCommands).toHaveBeenCalledTimes(3);
    const [publicMenu, publicOpts] = registerCommands.mock.calls[0]!;
    expect(publicOpts).toBeUndefined();
    expect(publicMenu.map((m) => m.command)).not.toContain("restart");
    const [ownerMenu, ownerOpts] = registerCommands.mock.calls[1]!;
    expect(ownerOpts).toEqual({ chatId: OWNER });
    expect(ownerMenu.map((m) => m.command)).toContain("restart");
    expect(registerCommands.mock.calls[2]![1]).toEqual({ chatId: "42" });
  });

  it("skips adapters without menus and swallows errors", async () => {
    const ctx = fakeContext();
    await expect(registerCommandMenus({ id: "discord" }, ctx.commands, { telegram: [], discord: [], slack: [], whatsapp: [], signal: [] })).resolves.toBeUndefined();
    await expect(registerCommandMenus({ id: "telegram", registerCommands: async () => { throw new Error("429"); } }, ctx.commands, { telegram: [OWNER], discord: [], slack: [], whatsapp: [], signal: [] })).resolves.toBeUndefined();
  });
});

describe("scrubbing wiring", () => {
  /** Synthetic values assembled at run time. */
  const fake = (prefix: string) => `${prefix}${"Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1"}`;

  it("registers credential, config, env and secrets-dir values as known secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "kirie-secrets-"));
    try {
      const secretsDir = join(dir, "secrets");
      mkdirSync(secretsDir);
      const fileSecret = fake("plv-");
      writeFileSync(join(secretsDir, "voice.env"), `# comment\nPLIVO_AUTH_TOKEN="${fileSecret}"\nEMPTY=\n`, { mode: 0o600 });
      writeFileSync(join(secretsDir, "notes.txt"), `IGNORED=${fake("x-")}`);
      const credSecret = fake("cred-");
      const configSecret = fake("cfg-");
      const envSecret = fake("env-");
      const scrubber = new SecretScrubber();
      const cfg = KirieConfigSchema.parse({}).security.scrubbing;
      const counts = registerKnownSecrets(scrubber, cfg, {
        credentials: new Map([["telegram.bot_token", credSecret]]),
        config: { channels: { telegram: { token: configSecret, pollingTimeout: 30 } }, gateway: { bearerToken: "$credential:gateway.token" } },
        env: { MY_SERVICE_API_KEY: envSecret, HOME: "/Users/someone", PATH: "/usr/bin" },
        secretsDir,
      });
      expect(counts).toEqual({ credentialStore: 1, config: 1, env: 1, secretsDir: 1 });
      for (const v of [credSecret, configSecret, envSecret, fileSecret]) {
        expect(scrubber.scrub(`value=${v} end`)).not.toContain(v);
      }
      expect(scrubber.scrub("home is /Users/someone")).toBe("home is /Users/someone");
      expect(scrubber.knownSecretLabels().join(" ")).not.toContain(credSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours the knownSecrets source switches", () => {
    const scrubber = new SecretScrubber();
    const cfg = KirieConfigSchema.parse({ security: { scrubbing: { knownSecrets: { credentialStore: false, env: false } } } }).security.scrubbing;
    const counts = registerKnownSecrets(scrubber, cfg, {
      credentials: new Map([["k", fake("c-")]]),
      env: { SOME_TOKEN: fake("e-") },
    });
    expect(counts.credentialStore).toBe(0);
    expect(counts.env).toBe(0);
  });

  it("readSecretsDir returns nothing for a missing directory", () => {
    expect(readSecretsDir("/nonexistent-kirie-secrets-dir")).toEqual([]);
  });

  it("sanitizeErrorForLog keeps only name and message (the bot-token-in-URL incident)", () => {
    const token = `123456789:${"AAH" + "x".repeat(32)}`;
    const httpError = Object.assign(new Error(`Network request for 'getUpdates' failed!`), {
      name: "HttpError",
      error: { url: `https://api.telegram.org/bot${token}/getUpdates` },
    });
    const clean = sanitizeErrorForLog(httpError);
    expect(clean).toEqual({ name: "HttpError", message: "Network request for 'getUpdates' failed!" });
    expect(JSON.stringify(clean)).not.toContain(token);
    expect(sanitizeErrorForLog({ name: "GrammyError", description: "Bad Request" })).toEqual({ name: "GrammyError", message: "Bad Request" });
    expect(sanitizeErrorForLog("plain")).toEqual({ name: "string", message: "plain" });
  });

  it("a restart with a looser config keeps the first scrubbing config for the subprocess", async () => {
    resetFrozenScrubbingConfigForTesting();
    const first = fakeContext();
    await setupScrubbing(first);
    expect(JSON.parse(first.kirieToolsEnv.KIRIE_SCRUB_CONFIG!).enabled).toBe(true);
    const restarted = fakeContext({ config: KirieConfigSchema.parse({ security: { scrubbing: { enabled: false } } }) });
    await setupScrubbing(restarted);
    expect(JSON.parse(restarted.kirieToolsEnv.KIRIE_SCRUB_CONFIG!).enabled).toBe(true);
    expect(freezeScrubbingConfig(restarted.config.security.scrubbing).enabled).toBe(true);
    resetFrozenScrubbingConfigForTesting();
  });

  it("puts the scrub config in the kirie-tools env and tells the owner when scrubbing is off", async () => {
    resetFrozenScrubbingConfigForTesting();
    const off = new SecretScrubber({ enabled: false });
    const ctx = fakeContext({ scrubber: off, config: KirieConfigSchema.parse({ security: { scrubbing: { enabled: false } } }) });
    const handle = await setupScrubbing(ctx);
    expect(JSON.parse(ctx.kirieToolsEnv.KIRIE_SCRUB_CONFIG!).enabled).toBe(false);
    await handle.start?.();
    expect(ctx.notifyOwner).toHaveBeenCalledWith(SCRUBBING_OFF_NOTICE, { key: "scrubbing-off" });
  });

  it("maps logging.redactSensitive off to sinks.logs = false in the subprocess config", async () => {
    resetFrozenScrubbingConfigForTesting();
    const ctx = fakeContext({ config: KirieConfigSchema.parse({ logging: { redactSensitive: "off" } }) });
    await setupScrubbing(ctx);
    expect(JSON.parse(ctx.kirieToolsEnv.KIRIE_SCRUB_CONFIG!).sinks.logs).toBe(false);
  });
});

describe("TaskHooks", () => {
  const task = (profile?: string) => ({ id: "t1", meta: profile ? { profile } : null }) as unknown as BackgroundTask;

  it("dispatches by meta.profile and returns undefined otherwise", () => {
    const hooks = new TaskHooks();
    const controller = { onTurnResult: async () => ({ action: "finish" as const }) };
    hooks.registerController("goal", () => controller);
    hooks.registerProfile("webhook", () => ({ kind: "webhook", toolAllowlist: ["Read"] }));
    const done = vi.fn(async () => {});
    hooks.registerCompletionHandler("goal", done);
    expect(hooks.controllerFor(task("goal"))).toBe(controller);
    expect(hooks.controllerFor(task())).toBeUndefined();
    expect(hooks.profileFor(task("webhook"))?.toolAllowlist).toEqual(["Read"]);
    expect(hooks.profileFor(task("goal"))).toBeUndefined();
    expect(hooks.completionHandlerFor(task("goal"))).toBe(done);
    expect(hooks.failureHandlerFor(task("goal"))).toBeUndefined();
  });

  it("throws on a duplicate or invalid profile", () => {
    const hooks = new TaskHooks();
    hooks.registerController("goal", () => undefined);
    expect(() => hooks.registerController("goal", () => undefined)).toThrow(/already registered/);
    expect(() => hooks.registerProfile("Bad Name", () => undefined)).toThrow(/Invalid/);
  });
});
