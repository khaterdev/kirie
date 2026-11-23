import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ChannelRegistry,
  CommandRegistry,
  IdentityResolver,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  SecretScrubber,
  chatCallContext,
  collectFeatureTools,
} from "@kirie/core";
import { createVoiceFeature, setupVoice } from "./voice.js";
import type { DaemonContext } from "./types.js";

const OWNER_PHONE = "+201001234567";
const SID = ["AC", "7".repeat(32)].join("");
const TOKEN = ["fake", "feature", "twilio", "token"].join("-");

class FakeIngress {
  readonly mounts = new Map<string, unknown>();
  publicBaseUrl: string | null = "https://kirie.example.com";
  ensureStarted = vi.fn(async () => {});
  stopIfIdle = vi.fn(async () => {});
  mount(prefix: string, app: unknown) { this.mounts.set(prefix, app); }
  unmount(prefix: string) { this.mounts.delete(prefix); }
  mountedPrefixes() { return [...this.mounts.keys()]; }
}

let dir: string;

function voiceToolNames(env: Record<string, string>): string[] {
  return Object.keys(collectFeatureTools({ dbDir: dir, gatewayUrl: "http://127.0.0.1:1", env })).filter((n) => n.startsWith("voice_")).sort();
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-voice-feature-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeVoiceEnv(lines: string): void {
  mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
  const p = join(dir, "secrets", "voice.env");
  writeFileSync(p, lines);
  chmodSync(p, 0o600);
}

function context(rawConfig: Record<string, unknown>) {
  const config = KirieConfigSchema.parse(rawConfig);
  const ingress = new FakeIngress();
  const channelRegistry = new ChannelRegistry();
  const identityResolver = new IdentityResolver({ securityConfig: config.security });
  const sdkOptions = new SdkOptionsPipeline();
  const commands = new CommandRegistry({ owners: new OwnerDirectory({ telegram: ["1001"] }) });
  const kirieToolsEnv: Record<string, string> = {};
  const scrubber = new SecretScrubber();
  const ctx = {
    config,
    dataDir: dir,
    agentCwd: dir,
    commands,
    owners: new OwnerDirectory({ telegram: ["1001"] }),
    ownerPrompts: { requestApproval: vi.fn(async () => ({ outcome: "denied", optionId: "deny", code: "AB12" })) },
    settings: new RuntimeSettings(join(dir, "state", "runtime-settings.json")),
    audit: { record: vi.fn() },
    scrubber,
    sdkOptions,
    turnContext: {},
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    ingress,
    taskHooks: {},
    channelRegistry,
    identityResolver,
    credentialStore: { list: () => [], get: async () => undefined },
    pipeline: {
      isBusy: () => false,
      addNextTurnNote: vi.fn(),
      onTurnComplete: vi.fn(() => () => {}),
      onTurnError: vi.fn(() => () => {}),
    },
    mcpServers: {},
    kirieToolsEnv,
    notifyOwner: vi.fn(async () => {}),
    restart: vi.fn(),
  };
  return { ctx: ctx as unknown as DaemonContext, ingress, channelRegistry, identityResolver, sdkOptions, commands, kirieToolsEnv, scrubber, internalApi: ctx.internalApi, promptAddenda: ctx.promptAddenda };
}

const readyConfig = {
  ingress: { publicBaseUrl: "https://kirie.example.com" },
  voice: {
    enabled: true,
    ownerNumbers: [OWNER_PHONE],
    twilio: { fromNumber: "+14155550100" },
    outbound: { enabled: true },
  },
};

describe("voice feature", () => {
  it("with the default config nothing is constructed, registered, mounted or callable", async () => {
    const c = context({});
    const handle = await setupVoice(c.ctx);
    await handle.start?.();
    expect(c.commands.list()).toEqual([]);
    expect(c.promptAddenda.names()).toEqual([]);
    expect(c.internalApi.apps()).toEqual([]);
    expect(c.ingress.mountedPrefixes()).toEqual([]);
    expect(c.channelRegistry.getById("voice")).toBeUndefined();
    expect(c.kirieToolsEnv).toEqual({});
    expect(voiceToolNames(c.kirieToolsEnv)).toEqual([]);
    await handle.stop?.();
  });

  it("enabled with missing credentials: the daemon starts, nothing is mounted, no tools, no adapter", async () => {
    const c = context(readyConfig);
    const handle = await createVoiceFeature({ uid: process.getuid?.() })(c.ctx);
    await expect(handle.start?.()).resolves.toBeUndefined();
    expect(c.ingress.mountedPrefixes()).toEqual([]);
    expect(c.channelRegistry.getById("voice")).toBeUndefined();
    expect(c.kirieToolsEnv.KIRIE_VOICE_TOOLS).toBeUndefined();
    expect(c.commands.list().map((d) => d.name).sort()).toEqual(["call", "voice"]);
    expect(c.internalApi.apps().map((a) => a.name)).toEqual(["voice"]);
    await handle.stop?.();
  });

  it("enabled and ready: adapter, owner identities, tools flag, contributor, addendum, and only the active provider's routes", async () => {
    writeVoiceEnv(`TWILIO_ACCOUNT_SID=${SID}\nTWILIO_AUTH_TOKEN=${TOKEN}\n`);
    const c = context(readyConfig);
    const handle = await createVoiceFeature()(c.ctx);
    expect(c.channelRegistry.getById("voice")).toBeDefined();
    expect(c.identityResolver.resolveIdentity("voice", OWNER_PHONE).role).toBe("owner");
    expect(c.kirieToolsEnv.KIRIE_VOICE_TOOLS).toBe("1");
    expect(voiceToolNames(c.kirieToolsEnv))
      .toEqual(["voice_call_hangup", "voice_call_initiate", "voice_call_list", "voice_call_status"]);
    expect(c.promptAddenda.names()).toEqual(["voice"]);
    await handle.start?.();
    expect(c.ingress.mountedPrefixes()).toEqual(["/voice/twilio"]);
    expect(c.ingress.ensureStarted).toHaveBeenCalled();

    const voiceOptions = c.sdkOptions.apply(
      { allowedTools: ["Bash", "Read"], permissionMode: "bypassPermissions" },
      chatCallContext({ sessionKey: `voice:dm:${OWNER_PHONE}`, channel: "voice", chatType: "dm", senderRole: "owner", cwd: dir }),
    );
    expect(voiceOptions.allowedTools).toEqual(["Read"]);
    expect(voiceOptions.disallowedTools).toContain("Bash");
    const tgOptions = c.sdkOptions.apply(
      { allowedTools: ["Bash", "Read"], permissionMode: "bypassPermissions" },
      chatCallContext({ sessionKey: "telegram:dm:1001", channel: "telegram", chatType: "dm", senderRole: "owner", cwd: dir }),
    );
    expect(tgOptions.allowedTools).toEqual(["Bash", "Read"]);

    expect(c.scrubber.scrub(`token ${TOKEN}`)).not.toContain(TOKEN);
    await handle.stop?.();
    expect(c.ingress.mountedPrefixes()).toEqual([]);
  });

  it("a group- or world-readable voice.env is ignored, so voice stays not ready", async () => {
    writeVoiceEnv(`TWILIO_ACCOUNT_SID=${SID}\nTWILIO_AUTH_TOKEN=${TOKEN}\n`);
    chmodSync(join(dir, "secrets", "voice.env"), 0o644);
    const c = context(readyConfig);
    const handle = await createVoiceFeature()(c.ctx);
    await handle.start?.();
    expect(c.ingress.mountedPrefixes()).toEqual([]);
    expect(c.kirieToolsEnv.KIRIE_VOICE_TOOLS).toBeUndefined();
    await handle.stop?.();
  });

  it("Plivo selected in config with only Twilio credentials stays off and costs nothing", async () => {
    writeVoiceEnv(`TWILIO_ACCOUNT_SID=${SID}\nTWILIO_AUTH_TOKEN=${TOKEN}\n`);
    const c = context({ ...readyConfig, voice: { ...readyConfig.voice, provider: "plivo", plivo: { fromNumber: "+14155550100" } } });
    const fetch = vi.fn();
    const handle = await createVoiceFeature({ fetch })(c.ctx);
    await handle.start?.();
    expect(c.ingress.mountedPrefixes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await handle.stop?.();
  });
});
