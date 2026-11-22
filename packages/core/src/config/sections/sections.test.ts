import { describe, it, expect } from "vitest";
import { KirieConfigSchema } from "../schema.js";
import { resolveScrubbingConfig } from "./scrubbing.js";

/** The effective config for an unchanged config file (PLAN E.10). */
const defaults = KirieConfigSchema.parse({});

describe("Hermes-parity config defaults (PLAN B.11)", () => {
  it("commands", () => {
    expect(defaults.commands).toEqual({
      unknownCommand: "agent",
      registerMenu: true,
      promptTimeoutSeconds: 300,
      maxPendingPrompts: 10,
    });
  });

  it("agent.strictMcpConfig is off and agent.fallback is off", () => {
    expect(defaults.agent.strictMcpConfig).toBe(false);
    expect(defaults.agent.fallback).toMatchObject({
      enabled: false,
      models: [],
      sdkNative: true,
      cooldownMinutes: 30,
      maxAttemptsPerTurn: 4,
      notify: true,
    });
  });

  it("accounts: rotation off, carrySession on, agent tools manage", () => {
    expect(defaults.accounts.rotation).toEqual({
      enabled: false,
      returnToPrimary: false,
      maxRotationsPerTurn: 3,
      defaultCooldownMinutes: 60,
      notify: true,
      carrySession: true,
    });
    expect(defaults.accounts.importRoots).toEqual([]);
    expect(defaults.accounts.verifyOnImport).toBe(true);
    expect(defaults.accounts.agentTools).toBe("manage");
  });

  it("gateway.extraAllowedHosts is empty", () => {
    expect(defaults.gateway.extraAllowedHosts).toEqual([]);
  });

  it("ingress: port 18787, no public URL, cf-connecting-ip, and no bind key", () => {
    expect(defaults.ingress).toEqual({ port: 18787, trustedIpHeader: "cf-connecting-ip" });
    expect("bind" in defaults.ingress).toBe(false);
  });

  it("webhooks are off with the safe defaults", () => {
    expect(defaults.webhooks).toMatchObject({
      enabled: false,
      defaultAction: "notify",
      defaultToolProfile: "summarize",
      allowFullProfile: false,
      onSuspiciousPayload: "downgrade",
      secretDelivery: "file",
    });
    expect("port" in defaults.webhooks).toBe(false);
    expect("publicBaseUrl" in defaults.webhooks).toBe(false);
  });

  it("security.scrubbing is on, every sink on except toolOutputToModel", () => {
    const s = defaults.security.scrubbing;
    expect(s.enabled).toBe(true);
    expect(s.sinks).toEqual({
      channels: true, logs: true, memory: true, chatHistory: true, taskResults: true,
      heartbeatLogs: true, http: true, webhookPayloads: true, pluginEvents: true,
      toolOutputToModel: false,
    });
    expect(s.knownSecrets.minLength).toBe(12);
    expect(s.mask).toBe("label");
  });

  it("learning, curator, user model are off; models are optional", () => {
    expect(defaults.learning).toMatchObject({
      enabled: false, memoryPolicy: "direct", skillWriteGuard: "enforce", maxPending: 20, expiryDays: 14,
    });
    expect(defaults.learning.model).toBeUndefined();
    expect(defaults.curator).toMatchObject({
      enabled: false, intervalHours: 168, staleAfterDays: 30, archiveAfterDays: 90, pruneBundled: false, llm: false,
    });
    expect(defaults.curator.model).toBeUndefined();
    expect(defaults.userModel).toMatchObject({
      enabled: false, inject: true, injectBackground: false, requireApproval: false, promptBudgetChars: 1500,
    });
    expect(defaults.userModel.model).toBeUndefined();
  });

  it("goals and loops ship off (DECISIONS 17)", () => {
    expect(defaults.goals).toMatchObject({
      enabled: false, maxRounds: 10, maxMinutes: 120, maxCostUsd: 10, maxConcurrent: 1, agentCreate: "ask",
    });
    expect(defaults.goals.judgeModel).toBeUndefined();
    expect(defaults.loops).toMatchObject({
      enabled: false, minIntervalSeconds: 60, maxActive: 5, defaultMaxRuns: 100,
      defaultExpiryHours: 72, quietSentinel: "NO_REPLY", agentCreate: "ask",
    });
  });

  it("proactive.maxChecklistBytes defaults to 8192 and tier2IntervalMinutes keeps no bounds", () => {
    expect(defaults.proactive.maxChecklistBytes).toBe(8192);
    expect(defaults.proactive.tier2IntervalMinutes).toBe(15);
    expect(KirieConfigSchema.parse({ proactive: { tier2IntervalMinutes: 1 } }).proactive.tier2IntervalMinutes).toBe(1);
    expect(KirieConfigSchema.parse({ proactive: { tier2IntervalMinutes: 5000 } }).proactive.tier2IntervalMinutes).toBe(5000);
  });

  it("approvals: yolo with hardline on (DECISIONS 1, 2)", () => {
    expect(defaults.approvals).toMatchObject({
      enabled: true, mode: "yolo", askScope: "dangerous", hardline: true,
      timeoutSeconds: 300, unattended: "ask", inlineCode: "ask",
    });
  });

  it("sandbox, undo, computer use, voice, plugins are off", () => {
    expect(defaults.sandbox.mode).toBe("off");
    expect(defaults.undo).toMatchObject({
      enabled: false, backgroundTasks: true, maxTurnsPerSession: 50, retentionDays: 14,
      confirmTimeoutSeconds: 120, maxTurnsPerUndo: 5,
    });
    expect(defaults.computerUse).toMatchObject({
      enabled: false, approval: "per-app", screenshots: "window", armMinutes: 15, maxArmMinutes: 60,
    });
    expect(defaults.voice).toMatchObject({
      enabled: false,
      provider: "twilio",
      inbound: { mode: "reject", requirePin: true },
      outbound: { enabled: false, agentCalls: "ask" },
      agent: { toolProfile: "chat" },
    });
    expect(defaults.plugins).toMatchObject({
      enabled: false, dir: "~/.kirie/plugins", requireHashPin: true, hookTimeoutMs: 2000,
    });
  });

  it("voice has a plivo block, twilio.voice, and no publicBaseUrl or speech.voice", () => {
    expect(defaults.voice.twilio).toEqual({ apiBaseUrl: "https://api.twilio.com", voice: "Polly.Joanna-Neural" });
    expect(defaults.voice.plivo).toEqual({ apiBaseUrl: "https://api.plivo.com", voice: "WOMAN" });
    expect(defaults.voice.speech).toEqual({ language: "en-US", speechTimeoutSeconds: 3, hints: [] });
    expect("publicBaseUrl" in defaults.voice).toBe(false);
    expect(KirieConfigSchema.parse({ voice: { provider: "plivo" } }).voice.provider).toBe("plivo");
    expect(() => KirieConfigSchema.parse({ voice: { provider: "vonage" } })).toThrow();
  });
});

describe("old configs still parse", () => {
  it("old voice keys (tts, stt, maxConcurrentCalls) are accepted and dropped", () => {
    const result = KirieConfigSchema.parse({
      voice: {
        enabled: false,
        provider: "twilio",
        twilio: { fromNumber: "+15550000000" },
        maxConcurrentCalls: 3,
        tts: { provider: "openai", voice: "alloy" },
        stt: { provider: "openai", model: "whisper-1" },
      },
    });
    expect(result.voice.twilio.fromNumber).toBe("+15550000000");
    expect("tts" in result.voice).toBe(false);
  });

  it("old sandbox keys (workspaceAccess, prune) are accepted and dropped", () => {
    const result = KirieConfigSchema.parse({
      sandbox: { mode: "docker", workspaceAccess: "rw", prune: { idleHours: 24 }, docker: { memory: "512m", cpus: 1 } },
    });
    expect(result.sandbox.mode).toBe("docker");
    expect(result.sandbox.docker.memory).toBe("512m");
    expect("prune" in result.sandbox).toBe(false);
  });

  it("logging.redactSensitive stays parseable; off maps to sinks.logs = false", () => {
    const off = KirieConfigSchema.parse({ logging: { redactSensitive: "off" } });
    expect(resolveScrubbingConfig(off).sinks.logs).toBe(false);
    expect(resolveScrubbingConfig(off).sinks.channels).toBe(true);
    const tools = KirieConfigSchema.parse({ logging: { redactSensitive: "tools" } });
    expect(resolveScrubbingConfig(tools).sinks.logs).toBe(true);
    expect(resolveScrubbingConfig(defaults)).toBe(defaults.security.scrubbing);
  });

  it("a config that sets every pre-existing section still parses with the same values", () => {
    const result = KirieConfigSchema.parse({
      agent: { model: "claude-sonnet-5-5", maxTurns: 0, sessionMode: "v1", sessionIdleTimeoutMs: 60_000, maxSessions: 3 },
      security: { dmPolicy: "open", groupPolicy: "all", owner: { identities: { telegram: [12345] } } },
      gateway: { port: 18789, bind: "loopback" },
      proactive: { enabled: true, tier2IntervalMinutes: 15, tier2Model: "claude-haiku-4-5" },
      logging: { level: "debug", redactSensitive: "all" },
      mcpServers: { linear: { url: "https://mcp.example.com/sse" } },
    });
    expect(result.agent.sessionMode).toBe("v1");
    expect(result.security.dmPolicy).toBe("open");
    expect(result.security.owner.identities.telegram).toEqual([12345]);
    expect(result.gateway.port).toBe(18789);
    expect(result.proactive.tier2Model).toBe("claude-haiku-4-5");
    expect(result.mcpServers.linear?.url).toBe("https://mcp.example.com/sse");
  });
});

describe("scrubbing pattern validation", () => {
  it("rejects an unbounded custom pattern and accepts a bounded one", () => {
    expect(() => KirieConfigSchema.parse({
      security: { scrubbing: { customPatterns: [{ name: "acme", pattern: "acme_[a-z]+" }] } },
    })).toThrow();
    const ok = KirieConfigSchema.parse({
      security: { scrubbing: { customPatterns: [{ name: "acme", pattern: "acme_[a-z0-9]{20,40}" }] } },
    });
    expect(ok.security.scrubbing.customPatterns[0]?.flags).toBe("");
  });

  it("rejects an unbounded allow pattern", () => {
    expect(() => KirieConfigSchema.parse({ security: { scrubbing: { allowPatterns: ["x.*"] } } })).toThrow();
  });
});
