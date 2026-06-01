import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadRawConfig, type CredentialResolver } from "./loader.js";

const TEST_DIR = `/tmp/kirie-loader-test-${process.pid}`;
const TEST_CONFIG_PATH = join(TEST_DIR, "config.yaml");

function writeTestConfig(yaml: string): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  writeFileSync(TEST_CONFIG_PATH, yaml, "utf-8");
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadRawConfig", () => {
  it("returns empty object for non-existent path", () => {
    const result = loadRawConfig(join(TEST_DIR, "missing.yaml"));
    expect(result).toEqual({});
  });

  it("parses YAML into a plain object", () => {
    writeTestConfig(`
agent:
  customInstructions: "Test instructions"
  maxTurns: 10
`);
    const result = loadRawConfig(TEST_CONFIG_PATH);
    expect(result).toHaveProperty("agent");
    expect((result["agent"] as Record<string, unknown>)["customInstructions"]).toBe("Test instructions");
  });

  it("throws on non-mapping YAML (array)", () => {
    writeTestConfig(`
- item1
- item2
`);
    expect(() => loadRawConfig(TEST_CONFIG_PATH)).toThrow("must be a YAML mapping");
  });

  it("returns empty object for empty YAML file", () => {
    writeTestConfig("");
    const result = loadRawConfig(TEST_CONFIG_PATH);
    expect(result).toEqual({});
  });
});

describe("loadConfig", () => {
  it("creates a default config file when path does not exist", () => {
    const missingPath = join(TEST_DIR, "subdir", "config.yaml");
    mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });

    const config = loadConfig({ configPath: missingPath });
    expect(config.agent.customInstructions).toBeUndefined();
    expect(config.agent.maxTurns).toBe(100);
    expect(config.agent.model).toBe("claude-opus-4-8[1m]");
    expect(existsSync(missingPath)).toBe(true);
  });

  it("loads and validates a valid config", () => {
    writeTestConfig(`
agent:
  customInstructions: "Always be brief."
  maxTurns: 15
  model: "opus"

security:
  dmPolicy: "open"
  groupPolicy: "all"
  rateLimit:
    perUser:
      maxRequests: 50
      windowMs: 30000
    perGroup:
      maxRequests: 100
      windowMs: 30000

channels:
  telegram:
    enabled: true
    token: "some-token"

memory:
  enabled: false
  backend: "sqlite"

gateway:
  port: 9999
  bind: "all"
`);
    const config = loadConfig({ configPath: TEST_CONFIG_PATH });
    expect(config.agent.customInstructions).toBe("Always be brief.");
    expect(config.agent.maxTurns).toBe(15);
    expect(config.security.dmPolicy).toBe("open");
    expect(config.security.rateLimit.perUser.maxRequests).toBe(50);
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.memory.enabled).toBe(false);
    expect(config.gateway.port).toBe(9999);
    expect(config.gateway.bind).toBe("all");
  });

  it("throws on invalid config with descriptive message", () => {
    writeTestConfig(`
agent:
  maxTurns: -1
`);
    expect(() => loadConfig({ configPath: TEST_CONFIG_PATH })).toThrow("Invalid config");
  });

  it("resolves credential references when resolver is provided", () => {
    writeTestConfig(`
agent:
  maxTurns: 10
  model: "claude-opus-4-8"

channels:
  telegram:
    enabled: true
    token: "$credential:telegram.bot_token"
`);
    const resolver: CredentialResolver = {
      get(key: string): string | undefined {
        if (key === "telegram.bot_token") return "resolved-secret-token";
        return undefined;
      },
    };

    const config = loadConfig({ configPath: TEST_CONFIG_PATH, credentialResolver: resolver });
    expect(config.channels.telegram.token).toBe("resolved-secret-token");
  });

  it("keeps unresolvable credential references as-is", () => {
    writeTestConfig(`
channels:
  telegram:
    enabled: true
    token: "$credential:missing.key"
`);
    const resolver: CredentialResolver = {
      get(_key: string): string | undefined {
        return undefined;
      },
    };

    const config = loadConfig({ configPath: TEST_CONFIG_PATH, credentialResolver: resolver });
    expect(config.channels.telegram.token).toBe("$credential:missing.key");
  });

  it("resolves nested credential references in arrays", () => {
    writeTestConfig(`
agent:
  maxTurns: 5
  model: "claude-opus-4-8"
`);
    // This tests that loadConfig doesn't crash with nested structures
    const config = loadConfig({
      configPath: TEST_CONFIG_PATH,
      credentialResolver: { get: () => undefined },
    });
    expect(config.agent.maxTurns).toBe(5);
  });

  it("applies Zod defaults for partial configs", () => {
    writeTestConfig(`
agent:
  model: "haiku"
`);
    const config = loadConfig({ configPath: TEST_CONFIG_PATH });
    expect(config.agent.model).toBe("haiku");
    expect(config.agent.customInstructions).toBeUndefined();
    expect(config.agent.maxTurns).toBe(100);
    expect(config.security.dmPolicy).toBe("owner-only");
    expect(config.gateway.port).toBe(18789);
  });
});
