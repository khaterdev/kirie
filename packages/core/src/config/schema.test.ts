import { describe, it, expect } from "vitest";
import {
  KirieConfigSchema,
  AgentConfigSchema,
  SecurityConfigSchema,
  ChannelsConfigSchema,
  MemoryConfigSchema,
  GatewayConfigSchema,
  CREDENTIAL_REF_PATTERN,
} from "./schema.js";

describe("AgentConfigSchema", () => {
  it("applies all defaults when given empty object", () => {
    const result = AgentConfigSchema.parse({});
    expect(result.customInstructions).toBeUndefined();
    expect(result.maxTurns).toBe(100);
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("accepts valid custom values", () => {
    const result = AgentConfigSchema.parse({
      customInstructions: "Always respond in Spanish.",
      maxTurns: 10,
      model: "opus",
    });
    expect(result.customInstructions).toBe("Always respond in Spanish.");
    expect(result.maxTurns).toBe(10);
    expect(result.model).toBe("opus");
  });

  it("allows 0 for unlimited maxTurns", () => {
    const result = AgentConfigSchema.parse({ maxTurns: 0 });
    expect(result.maxTurns).toBe(0);
  });

  it("rejects negative maxTurns", () => {
    expect(() => AgentConfigSchema.parse({ maxTurns: -5 })).toThrow();
  });

  it("rejects non-integer maxTurns", () => {
    expect(() => AgentConfigSchema.parse({ maxTurns: 2.5 })).toThrow();
  });

  it("defaults backgroundTaskMaxTurns to 200", () => {
    const result = AgentConfigSchema.parse({});
    expect(result.backgroundTaskMaxTurns).toBe(200);
  });

  it("accepts custom backgroundTaskMaxTurns", () => {
    const result = AgentConfigSchema.parse({ backgroundTaskMaxTurns: 500 });
    expect(result.backgroundTaskMaxTurns).toBe(500);
  });

  it("rejects backgroundTaskMaxTurns less than 1", () => {
    expect(() => AgentConfigSchema.parse({ backgroundTaskMaxTurns: 0 })).toThrow();
    expect(() => AgentConfigSchema.parse({ backgroundTaskMaxTurns: -1 })).toThrow();
  });

  it("rejects non-integer backgroundTaskMaxTurns", () => {
    expect(() => AgentConfigSchema.parse({ backgroundTaskMaxTurns: 1.5 })).toThrow();
  });
});

describe("SecurityConfigSchema", () => {
  it("applies defaults for empty object", () => {
    const result = SecurityConfigSchema.parse({});
    expect(result.dmPolicy).toBe("owner-only");
    expect(result.groupPolicy).toBe("mention-only");
    expect(result.rateLimit.perUser.maxRequests).toBe(30);
    expect(result.rateLimit.perUser.windowMs).toBe(60_000);
    expect(result.rateLimit.perGroup.maxRequests).toBe(60);
    expect(result.rateLimit.perGroup.windowMs).toBe(60_000);
  });

  it("accepts valid dmPolicy values", () => {
    expect(SecurityConfigSchema.parse({ dmPolicy: "owner-only" }).dmPolicy).toBe("owner-only");
    expect(SecurityConfigSchema.parse({ dmPolicy: "allowlist" }).dmPolicy).toBe("allowlist");
    expect(SecurityConfigSchema.parse({ dmPolicy: "open" }).dmPolicy).toBe("open");
  });

  it("rejects invalid dmPolicy", () => {
    expect(() => SecurityConfigSchema.parse({ dmPolicy: "invalid" })).toThrow();
  });

  it("accepts valid groupPolicy values", () => {
    expect(SecurityConfigSchema.parse({ groupPolicy: "mention-only" }).groupPolicy).toBe("mention-only");
    expect(SecurityConfigSchema.parse({ groupPolicy: "all" }).groupPolicy).toBe("all");
    expect(SecurityConfigSchema.parse({ groupPolicy: "disabled" }).groupPolicy).toBe("disabled");
  });

  it("rejects invalid groupPolicy", () => {
    expect(() => SecurityConfigSchema.parse({ groupPolicy: "invalid" })).toThrow();
  });

  it("accepts telegram identities as numbers or strings", () => {
    const result = SecurityConfigSchema.parse({
      owner: { identities: { telegram: [12345, "67890"] } },
    });
    expect(result.owner.identities.telegram).toEqual([12345, "67890"]);
  });

  it("rejects negative rate limit values", () => {
    expect(() =>
      SecurityConfigSchema.parse({
        rateLimit: { perUser: { maxRequests: -1, windowMs: 60000 } },
      }),
    ).toThrow();
  });
});

describe("ChannelsConfigSchema", () => {
  it("defaults all channels to disabled", () => {
    const result = ChannelsConfigSchema.parse({});
    expect(result.telegram.enabled).toBe(false);
    expect(result.discord.enabled).toBe(false);
    expect(result.slack.enabled).toBe(false);
    expect(result.whatsapp.enabled).toBe(false);
    expect(result.signal.enabled).toBe(false);
  });

  it("accepts credential references in token fields", () => {
    const result = ChannelsConfigSchema.parse({
      telegram: { enabled: true, token: "$credential:telegram.bot_token" },
    });
    expect(result.telegram.token).toBe("$credential:telegram.bot_token");
  });

  it("accepts valid telegram webhook URL", () => {
    const result = ChannelsConfigSchema.parse({
      telegram: { webhookUrl: "https://example.com/webhook" },
    });
    expect(result.telegram.webhookUrl).toBe("https://example.com/webhook");
  });

  it("rejects invalid webhook URL", () => {
    expect(() =>
      ChannelsConfigSchema.parse({
        telegram: { webhookUrl: "not-a-url" },
      }),
    ).toThrow();
  });

  it("sets default Signal apiUrl", () => {
    const result = ChannelsConfigSchema.parse({});
    expect(result.signal.apiUrl).toBe("http://localhost:8080");
  });

  it("defaults channel security fields to permissive values", () => {
    const result = ChannelsConfigSchema.parse({});
    expect(result.telegram.allowedUserIds).toEqual([]);
    expect(result.telegram.allowGroups).toBe(true);
    expect(result.telegram.allowAddToGroups).toBe(true);
    expect(result.discord.allowedUserIds).toEqual([]);
    expect(result.discord.allowGroups).toBe(true);
  });

  it("accepts channel security restrictions", () => {
    const result = ChannelsConfigSchema.parse({
      telegram: {
        enabled: true,
        allowedUserIds: [123456, "789012"],
        allowGroups: false,
        allowAddToGroups: false,
      },
    });
    expect(result.telegram.allowedUserIds).toEqual([123456, "789012"]);
    expect(result.telegram.allowGroups).toBe(false);
    expect(result.telegram.allowAddToGroups).toBe(false);
  });
});

describe("MemoryConfigSchema", () => {
  it("defaults to enabled sqlite with local embeddings", () => {
    const result = MemoryConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.backend).toBe("sqlite");
    expect(result.embeddings.provider).toBe("local");
    expect(result.embeddings.model).toBeUndefined();
    expect(result.embeddings.apiKey).toBeUndefined();
  });

  it("rejects unknown backend", () => {
    expect(() => MemoryConfigSchema.parse({ backend: "postgres" })).toThrow();
  });

  it("accepts explicit openai embedding config", () => {
    const result = MemoryConfigSchema.parse({
      embeddings: {
        provider: "openai",
        apiKey: "$credential:openai.api_key",
        model: "text-embedding-ada-002",
      },
    });
    expect(result.embeddings.provider).toBe("openai");
    expect(result.embeddings.apiKey).toBe("$credential:openai.api_key");
    expect(result.embeddings.model).toBe("text-embedding-ada-002");
  });

  it("accepts local provider with custom model", () => {
    const result = MemoryConfigSchema.parse({
      embeddings: { provider: "local", model: "fast-bge-base-en-v1.5" },
    });
    expect(result.embeddings.provider).toBe("local");
    expect(result.embeddings.model).toBe("fast-bge-base-en-v1.5");
  });

  it("accepts noop provider", () => {
    const result = MemoryConfigSchema.parse({
      embeddings: { provider: "noop" },
    });
    expect(result.embeddings.provider).toBe("noop");
  });

  it("rejects unknown embedding provider", () => {
    expect(() => MemoryConfigSchema.parse({
      embeddings: { provider: "cohere" },
    })).toThrow();
  });
});

describe("GatewayConfigSchema", () => {
  it("defaults to port 18789 and loopback", () => {
    const result = GatewayConfigSchema.parse({});
    expect(result.port).toBe(18789);
    expect(result.bind).toBe("loopback");
  });

  it("rejects invalid port numbers", () => {
    expect(() => GatewayConfigSchema.parse({ port: 0 })).toThrow();
    expect(() => GatewayConfigSchema.parse({ port: 70000 })).toThrow();
    expect(() => GatewayConfigSchema.parse({ port: -1 })).toThrow();
  });

  it("accepts valid bind values", () => {
    expect(GatewayConfigSchema.parse({ bind: "loopback" }).bind).toBe("loopback");
    expect(GatewayConfigSchema.parse({ bind: "all" }).bind).toBe("all");
  });

  it("rejects invalid bind value", () => {
    expect(() => GatewayConfigSchema.parse({ bind: "external" })).toThrow();
  });
});

describe("KirieConfigSchema (root)", () => {
  it("applies all defaults for empty object", () => {
    const result = KirieConfigSchema.parse({});
    expect(result.agent.customInstructions).toBeUndefined();
    expect(result.security.dmPolicy).toBe("owner-only");
    expect(result.channels.telegram.enabled).toBe(false);
    expect(result.memory.enabled).toBe(true);
    expect(result.gateway.port).toBe(18789);
    expect(result.plugins).toEqual([]);
  });

  it("accepts a full config matching config.example.yaml", () => {
    const result = KirieConfigSchema.parse({
      agent: {
        maxTurns: 100,
        model: "claude-opus-4-6",
      },
      security: {
        owner: { identities: { telegram: [], discord: [] } },
        dmPolicy: "owner-only",
        groupPolicy: "mention-only",
        rateLimit: {
          perUser: { maxRequests: 30, windowMs: 60000 },
          perGroup: { maxRequests: 60, windowMs: 60000 },
        },
      },
      channels: {
        telegram: { enabled: false, token: "$credential:telegram.bot_token" },
      },
      memory: { enabled: true, backend: "sqlite" },
      gateway: { port: 18789, bind: "loopback" },
    });
    expect(result.agent.maxTurns).toBe(100);
    expect(result.security.rateLimit.perUser.maxRequests).toBe(30);
  });

  it("accepts plugin entries", () => {
    const result = KirieConfigSchema.parse({
      plugins: [
        { package: "@kirie/plugin-weather", enabled: true, config: { apiKey: "abc" } },
      ],
    });
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.package).toBe("@kirie/plugin-weather");
  });
});

describe("CREDENTIAL_REF_PATTERN", () => {
  it("matches valid credential references", () => {
    expect(CREDENTIAL_REF_PATTERN.test("$credential:telegram.bot_token")).toBe(true);
    expect(CREDENTIAL_REF_PATTERN.test("$credential:discord.bot_token")).toBe(true);
    expect(CREDENTIAL_REF_PATTERN.test("$credential:slack.app_token")).toBe(true);
  });

  it("extracts the key from a credential reference", () => {
    const match = CREDENTIAL_REF_PATTERN.exec("$credential:telegram.bot_token");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("telegram.bot_token");
  });

  it("does not match regular strings", () => {
    expect(CREDENTIAL_REF_PATTERN.test("telegram.bot_token")).toBe(false);
    expect(CREDENTIAL_REF_PATTERN.test("plain-string")).toBe(false);
    expect(CREDENTIAL_REF_PATTERN.test("$credential")).toBe(false);
  });
});
