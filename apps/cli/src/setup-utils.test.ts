import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  deepMerge,
  parseEnvFile,
  serializeEnvFile,
  mergeEnvFile,
  mergeConfigYaml,
  writeConfigYaml,
} from "./setup-utils.js";

// ── Temp directory helpers ──────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `kirie-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── deepMerge ───────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("returns source when target is empty", () => {
    const result = deepMerge({}, { a: 1, b: "hello" });
    expect(result).toEqual({ a: 1, b: "hello" });
  });

  it("preserves target keys not in source", () => {
    const result = deepMerge(
      { existing: "value", keep: true },
      { newKey: "added" },
    );
    expect(result).toEqual({
      existing: "value",
      keep: true,
      newKey: "added",
    });
  });

  it("overwrites scalar values from source", () => {
    const result = deepMerge(
      { port: 3000, name: "old" },
      { port: 8080, name: "new" },
    );
    expect(result).toEqual({ port: 8080, name: "new" });
  });

  it("recursively merges nested objects", () => {
    const target = {
      gateway: { port: 18789, bind: "loopback", extra: "keep" },
      agent: { model: "opus", workspace: "/old" },
    };
    const source = {
      gateway: { port: 9000 },
      agent: { workspace: "/new" },
    };
    const result = deepMerge(target, source);
    expect(result).toEqual({
      gateway: { port: 9000, bind: "loopback", extra: "keep" },
      agent: { model: "opus", workspace: "/new" },
    });
  });

  it("replaces arrays entirely (does not merge elements)", () => {
    const result = deepMerge(
      { tags: ["a", "b", "c"] },
      { tags: ["x"] },
    );
    expect(result).toEqual({ tags: ["x"] });
  });

  it("skips undefined values in source (preserves target)", () => {
    const result = deepMerge(
      { a: 1, b: 2 },
      { a: undefined, b: 3 },
    );
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it("overwrites with null (explicit clear)", () => {
    const result = deepMerge(
      { a: "hello", b: "world" },
      { a: null },
    );
    expect(result).toEqual({ a: null, b: "world" });
  });

  it("handles deeply nested merge preserving custom fields", () => {
    // Simulates real-world case: existing config with custom MCP servers
    const existing = {
      agent: { model: "opus", maxTurns: 100 },
      mcpServers: {
        linear: { command: "npx", args: ["-y", "mcp-linear"], enabled: true },
        github: { command: "npx", args: ["-y", "mcp-github"], enabled: true },
      },
      channels: {
        telegram: { enabled: true, token: "$credential:telegram.bot_token" },
      },
    };
    const wizardChanges = {
      agent: { model: "sonnet", maxTurns: 50 },
      channels: {
        telegram: { enabled: true, token: "$credential:telegram.bot_token" },
        discord: { enabled: true, token: "$credential:discord.bot_token" },
      },
    };
    const result = deepMerge(existing, wizardChanges);

    // MCP servers should be preserved (not in wizard changes)
    expect(result.mcpServers).toEqual(existing.mcpServers);
    // Agent fields updated
    expect(result.agent).toEqual({ model: "sonnet", maxTurns: 50 });
    // Channels merged: telegram updated, discord added
    expect((result.channels as Record<string, unknown>).telegram).toEqual({
      enabled: true,
      token: "$credential:telegram.bot_token",
    });
    expect((result.channels as Record<string, unknown>).discord).toEqual({
      enabled: true,
      token: "$credential:discord.bot_token",
    });
  });

  it("overwrites when source has object but target has scalar", () => {
    const result = deepMerge(
      { val: "string" },
      { val: { nested: true } },
    );
    expect(result).toEqual({ val: { nested: true } });
  });

  it("overwrites when source has scalar but target has object", () => {
    const result = deepMerge(
      { val: { nested: true } },
      { val: "string" },
    );
    expect(result).toEqual({ val: "string" });
  });
});

// ── parseEnvFile ────────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(result.get("FOO")).toBe("bar");
    expect(result.get("BAZ")).toBe("qux");
  });

  it("skips comments and blank lines", () => {
    const result = parseEnvFile("# comment\n\nKEY=value\n  \n# another\n");
    expect(result.size).toBe(1);
    expect(result.get("KEY")).toBe("value");
  });

  it("strips double quotes from values", () => {
    const result = parseEnvFile('API_KEY="sk-ant-123"\n');
    expect(result.get("API_KEY")).toBe("sk-ant-123");
  });

  it("strips single quotes from values", () => {
    const result = parseEnvFile("API_KEY='sk-ant-123'\n");
    expect(result.get("API_KEY")).toBe("sk-ant-123");
  });

  it("handles values with = signs", () => {
    const result = parseEnvFile("URL=https://example.com?foo=bar&baz=qux\n");
    expect(result.get("URL")).toBe("https://example.com?foo=bar&baz=qux");
  });

  it("handles empty values", () => {
    const result = parseEnvFile("EMPTY=\n");
    expect(result.get("EMPTY")).toBe("");
  });

  it("returns empty map for empty string", () => {
    const result = parseEnvFile("");
    expect(result.size).toBe(0);
  });
});

// ── serializeEnvFile ────────────────────────────────────────────────────────

describe("serializeEnvFile", () => {
  it("serializes a map to KEY=VALUE format", () => {
    const map = new Map([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
    const result = serializeEnvFile(map);
    expect(result).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("handles empty map", () => {
    const result = serializeEnvFile(new Map());
    expect(result).toBe("\n");
  });
});

// ── mergeEnvFile ────────────────────────────────────────────────────────────

describe("mergeEnvFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates new content when .env does not exist", () => {
    const envPath = join(tempDir, ".env");
    const result = mergeEnvFile(envPath, { ANTHROPIC_API_KEY: "sk-ant-new" });
    expect(result).toContain("ANTHROPIC_API_KEY=sk-ant-new");
  });

  it("merges new keys into existing .env", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-openai-123\n", "utf-8");

    const result = mergeEnvFile(envPath, { ANTHROPIC_API_KEY: "sk-ant-new" });
    expect(result).toContain("OPENAI_API_KEY=sk-openai-123");
    expect(result).toContain("ANTHROPIC_API_KEY=sk-ant-new");
  });

  it("overwrites existing keys when the same key is provided", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk-ant-old\nOPENAI_API_KEY=sk-openai-123\n",
      "utf-8",
    );

    const result = mergeEnvFile(envPath, { ANTHROPIC_API_KEY: "sk-ant-new" });
    expect(result).toContain("ANTHROPIC_API_KEY=sk-ant-new");
    expect(result).toContain("OPENAI_API_KEY=sk-openai-123");
    expect(result).not.toContain("sk-ant-old");
  });

  it("preserves keys not touched by the merge", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk-ant-old\nCUSTOM_VAR=my-value\nANOTHER=123\n",
      "utf-8",
    );

    const result = mergeEnvFile(envPath, { ANTHROPIC_API_KEY: "sk-ant-new" });
    expect(result).toContain("CUSTOM_VAR=my-value");
    expect(result).toContain("ANOTHER=123");
    expect(result).toContain("ANTHROPIC_API_KEY=sk-ant-new");
  });
});

// ── mergeConfigYaml ─────────────────────────────────────────────────────────

describe("mergeConfigYaml", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns newConfig when config file does not exist", () => {
    const configPath = join(tempDir, "config.yaml");
    const newConfig = { agent: { model: "opus" } };
    const result = mergeConfigYaml(configPath, newConfig);
    expect(result).toEqual(newConfig);
  });

  it("deep-merges wizard changes into existing config", () => {
    const configPath = join(tempDir, "config.yaml");
    const existingConfig = {
      agent: { model: "opus", maxTurns: 100 },
      mcpServers: {
        linear: { command: "npx", args: ["-y", "mcp-linear"], enabled: true },
      },
      gateway: { port: 18789, bind: "loopback" },
    };
    // Use yaml library to write so we test the parse-merge cycle
    const { stringify } = require("yaml");
    writeFileSync(configPath, stringify(existingConfig), "utf-8");

    const wizardChanges = {
      agent: { model: "sonnet", maxTurns: 50 },
      gateway: { port: 9000 },
    };
    const result = mergeConfigYaml(configPath, wizardChanges);

    // Custom MCP servers preserved
    expect(result.mcpServers).toEqual(existingConfig.mcpServers);
    // Agent fields updated
    expect(result.agent).toEqual({ model: "sonnet", maxTurns: 50 });
    // Gateway port updated, bind preserved
    expect(result.gateway).toEqual({ port: 9000, bind: "loopback" });
  });

  it("preserves custom agents array in existing config", () => {
    const configPath = join(tempDir, "config.yaml");
    const existingConfig = {
      agent: { model: "opus" },
      agents: [
        { id: "coder", name: "Coder Agent", model: "sonnet" },
        { id: "researcher", name: "Research Agent" },
      ],
    };
    const { stringify } = require("yaml");
    writeFileSync(configPath, stringify(existingConfig), "utf-8");

    const wizardChanges = {
      agent: { model: "haiku" },
    };
    const result = mergeConfigYaml(configPath, wizardChanges);

    // agents array preserved (wizard doesn't touch it)
    expect(result.agents).toEqual(existingConfig.agents);
    // agent.model updated
    expect((result.agent as Record<string, unknown>).model).toBe("haiku");
  });

  it("returns newConfig when existing file is empty", () => {
    const configPath = join(tempDir, "config.yaml");
    writeFileSync(configPath, "", "utf-8");
    const newConfig = { agent: { model: "opus" } };
    const result = mergeConfigYaml(configPath, newConfig);
    expect(result).toEqual(newConfig);
  });
});

// ── writeConfigYaml ─────────────────────────────────────────────────────────

describe("writeConfigYaml", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a valid YAML file", () => {
    const configPath = join(tempDir, "config.yaml");
    writeConfigYaml(configPath, { agent: { model: "opus" }, gateway: { port: 18789 } });

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("agent:");
    expect(content).toContain("model: opus");
    expect(content).toContain("gateway:");
    expect(content).toContain("port: 18789");
  });
});

// ── Integration: SOUL.md protection ─────────────────────────────────────────

describe("SOUL.md protection logic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not overwrite existing SOUL.md in merge mode", () => {
    const soulPath = join(tempDir, "SOUL.md");
    const originalContent = "# My Custom Soul\n\nI am unique and customized.\n";
    writeFileSync(soulPath, originalContent, "utf-8");

    // Simulate setup's behavior: check existence before writing
    const forceClean = false;
    if (!existsSync(soulPath) || forceClean) {
      writeFileSync(soulPath, "# Fresh Soul\n", "utf-8");
    }

    const content = readFileSync(soulPath, "utf-8");
    expect(content).toBe(originalContent);
  });

  it("overwrites SOUL.md when forceClean is true", () => {
    const soulPath = join(tempDir, "SOUL.md");
    const originalContent = "# My Custom Soul\n";
    writeFileSync(soulPath, originalContent, "utf-8");

    const forceClean = true;
    const newContent = "# Fresh Soul\n";
    if (!existsSync(soulPath) || forceClean) {
      writeFileSync(soulPath, newContent, "utf-8");
    }

    const content = readFileSync(soulPath, "utf-8");
    expect(content).toBe(newContent);
  });

  it("creates SOUL.md when it does not exist", () => {
    const soulPath = join(tempDir, "SOUL.md");
    const forceClean = false;
    const newContent = "# Fresh Soul\n";

    if (!existsSync(soulPath) || forceClean) {
      writeFileSync(soulPath, newContent, "utf-8");
    }

    expect(existsSync(soulPath)).toBe(true);
    expect(readFileSync(soulPath, "utf-8")).toBe(newContent);
  });
});

// ── Integration: .env merge vs overwrite ────────────────────────────────────

describe(".env merge vs overwrite integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fresh install creates .env with just ANTHROPIC_API_KEY", () => {
    const envPath = join(tempDir, ".env");
    const forceClean = false;
    const apiKey = "sk-ant-test123";

    if (!existsSync(envPath) || forceClean) {
      writeFileSync(envPath, `ANTHROPIC_API_KEY=${apiKey}\n`, "utf-8");
    }

    const content = readFileSync(envPath, "utf-8");
    expect(content).toBe("ANTHROPIC_API_KEY=sk-ant-test123\n");
  });

  it("re-run merges and preserves existing env vars", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk-ant-old\nOPENAI_API_KEY=sk-openai-123\nCUSTOM=myval\n",
      "utf-8",
    );

    const forceClean = false;
    const apiKey = "sk-ant-new";

    if (!existsSync(envPath) || forceClean) {
      writeFileSync(envPath, `ANTHROPIC_API_KEY=${apiKey}\n`, "utf-8");
    } else {
      const mergedEnv = mergeEnvFile(envPath, { ANTHROPIC_API_KEY: apiKey });
      writeFileSync(envPath, mergedEnv, "utf-8");
    }

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-new");
    expect(content).toContain("OPENAI_API_KEY=sk-openai-123");
    expect(content).toContain("CUSTOM=myval");
    expect(content).not.toContain("sk-ant-old");
  });

  it("--force creates .env from scratch (loses other vars)", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(
      envPath,
      "ANTHROPIC_API_KEY=sk-ant-old\nOPENAI_API_KEY=sk-openai-123\n",
      "utf-8",
    );

    const forceClean = true;
    const apiKey = "sk-ant-new";

    if (!existsSync(envPath) || forceClean) {
      writeFileSync(envPath, `ANTHROPIC_API_KEY=${apiKey}\n`, "utf-8");
    }

    const content = readFileSync(envPath, "utf-8");
    expect(content).toBe("ANTHROPIC_API_KEY=sk-ant-new\n");
    expect(content).not.toContain("OPENAI_API_KEY");
  });
});

// ── Integration: Config merge preserves MCP servers ─────────────────────────

describe("config merge preserves custom MCP servers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves mcpServers that wizard does not touch", () => {
    const { stringify } = require("yaml");
    const configPath = join(tempDir, "config.yaml");
    const existingConfig = {
      agent: { model: "opus", maxTurns: 100 },
      gateway: { port: 18789, bind: "loopback" },
      mcpServers: {
        linear: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"], enabled: true },
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/docs"], enabled: true },
      },
      plugins: [{ package: "custom-plugin", enabled: true }],
    };
    writeFileSync(configPath, stringify(existingConfig), "utf-8");

    // Wizard only changes agent and gateway
    const wizardConfig = {
      agent: { model: "sonnet", maxTurns: 50 },
      gateway: { port: 9000, bind: "all" },
      channels: { telegram: { enabled: true } },
    };

    const merged = mergeConfigYaml(configPath, wizardConfig);

    // MCP servers preserved
    expect(merged.mcpServers).toEqual(existingConfig.mcpServers);
    // Plugins preserved
    expect(merged.plugins).toEqual(existingConfig.plugins);
    // Agent and gateway updated
    expect((merged.agent as Record<string, unknown>).model).toBe("sonnet");
    expect((merged.gateway as Record<string, unknown>).port).toBe(9000);
    expect((merged.gateway as Record<string, unknown>).bind).toBe("all");
    // Channels added
    expect(merged.channels).toEqual({ telegram: { enabled: true } });
  });
});
