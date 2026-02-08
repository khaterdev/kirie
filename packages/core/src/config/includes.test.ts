import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  processIncludes,
  deepMerge,
  ConfigIncludeError,
  CircularIncludeError,
  INCLUDE_KEY,
  MAX_INCLUDE_DEPTH,
} from "./includes.js";

const TEST_DIR = `/tmp/kirie-includes-test-${process.pid}`;

function writeTempFile(relativePath: string, content: string): string {
  const fullPath = join(TEST_DIR, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

function mainConfigPath(): string {
  return join(TEST_DIR, "config.yaml");
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── deepMerge ───────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  it("overwrites primitives (source wins)", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("concatenates arrays", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3, 4] })).toEqual({ a: [1, 2, 3, 4] });
  });

  it("deep merges nested objects", () => {
    const target = { a: { b: 1, c: 2 } };
    const source = { a: { c: 3, d: 4 } };
    expect(deepMerge(target, source)).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it("adds new keys from source", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("returns source when target is not an object", () => {
    expect(deepMerge("hello", { a: 1 })).toEqual({ a: 1 });
  });

  it("returns source when source is not an object", () => {
    expect(deepMerge({ a: 1 }, "hello")).toBe("hello");
  });

  it("handles deeply nested merges", () => {
    const target = { a: { b: { c: { d: 1 } } } };
    const source = { a: { b: { c: { e: 2 } } } };
    expect(deepMerge(target, source)).toEqual({
      a: { b: { c: { d: 1, e: 2 } } },
    });
  });

  it("replaces object with primitive when source value is primitive", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: 42 })).toEqual({ a: 42 });
  });

  it("replaces primitive with object when source value is object", () => {
    expect(deepMerge({ a: 42 }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });

  it("handles empty objects", () => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
    expect(deepMerge({}, {})).toEqual({});
  });
});

// ── Single file include ─────────────────────────────────────────────────────

describe("processIncludes — single file include", () => {
  it("includes a single YAML file", () => {
    writeTempFile("channels.yaml", `telegram:\n  enabled: true\n  token: "abc"\n`);
    const config = {
      agent: { maxTurns: 10 },
      channels: { [INCLUDE_KEY]: "./channels.yaml" },
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    expect(result.agent).toEqual({ maxTurns: 10 });
    const channels = result.channels as Record<string, unknown>;
    const telegram = channels.telegram as Record<string, unknown>;
    expect(telegram.enabled).toBe(true);
    expect(telegram.token).toBe("abc");
  });

  it("includes a single JSON file", () => {
    writeTempFile("gateway.json", JSON.stringify({ port: 9999, bind: "all" }));
    const config = {
      gateway: { [INCLUDE_KEY]: "./gateway.json" },
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const gateway = result.gateway as Record<string, unknown>;
    expect(gateway.port).toBe(9999);
    expect(gateway.bind).toBe("all");
  });

  it("replaces the $include node with file content when no siblings", () => {
    writeTempFile("data.yaml", `key: value\n`);
    const config = { [INCLUDE_KEY]: "./data.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    expect(result).toEqual({ key: "value" });
    expect(result[INCLUDE_KEY]).toBeUndefined();
  });
});

// ── Multiple file include (array) ───────────────────────────────────────────

describe("processIncludes — multiple file include (array)", () => {
  it("merges multiple YAML files", () => {
    writeTempFile("a.yaml", `agent:\n  maxTurns: 50\n`);
    writeTempFile("b.yaml", `security:\n  dmPolicy: open\n`);
    const config = { [INCLUDE_KEY]: ["./a.yaml", "./b.yaml"] };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    expect((result.agent as Record<string, unknown>).maxTurns).toBe(50);
    expect((result.security as Record<string, unknown>).dmPolicy).toBe("open");
  });

  it("later files override earlier files", () => {
    writeTempFile("first.yaml", `agent:\n  maxTurns: 10\n  model: sonnet\n`);
    writeTempFile("second.yaml", `agent:\n  maxTurns: 99\n`);
    const config = { [INCLUDE_KEY]: ["./first.yaml", "./second.yaml"] };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const agent = result.agent as Record<string, unknown>;
    expect(agent.maxTurns).toBe(99);
    expect(agent.model).toBe("sonnet");
  });

  it("concatenates arrays from multiple files", () => {
    writeTempFile("plugins1.yaml", `plugins:\n  - name: a\n`);
    writeTempFile("plugins2.yaml", `plugins:\n  - name: b\n`);
    const config = { [INCLUDE_KEY]: ["./plugins1.yaml", "./plugins2.yaml"] };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const plugins = result.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.name).toBe("a");
    expect(plugins[1]!.name).toBe("b");
  });
});

// ── Include with sibling keys (merge) ───────────────────────────────────────

describe("processIncludes — include with sibling keys", () => {
  it("merges sibling keys over included content", () => {
    writeTempFile("base.yaml", `agent:\n  maxTurns: 50\n  model: sonnet\n`);
    const config = {
      [INCLUDE_KEY]: "./base.yaml",
      agent: { maxTurns: 100 },
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const agent = result.agent as Record<string, unknown>;
    expect(agent.maxTurns).toBe(100);
    expect(agent.model).toBe("sonnet");
  });

  it("sibling keys win over included content", () => {
    writeTempFile("defaults.yaml", `gateway:\n  port: 8080\n  bind: loopback\n`);
    const config = {
      [INCLUDE_KEY]: "./defaults.yaml",
      gateway: { port: 3000 },
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const gateway = result.gateway as Record<string, unknown>;
    expect(gateway.port).toBe(3000);
    expect(gateway.bind).toBe("loopback");
  });

  it("throws when included content is non-object but siblings exist", () => {
    writeTempFile("scalar.yaml", `just a string\n`);
    const config = {
      [INCLUDE_KEY]: "./scalar.yaml",
      extra: "key",
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(ConfigIncludeError);
    expect(() => processIncludes(config, configPath)).toThrow(
      "Sibling keys require included content to be an object",
    );
  });
});

// ── Nested includes (A includes B includes C) ──────────────────────────────

describe("processIncludes — nested includes", () => {
  it("resolves nested includes (A -> B -> C)", () => {
    writeTempFile("c.yaml", `deep: value\n`);
    writeTempFile("b.yaml", `middle:\n  $include: ./c.yaml\n`);
    writeTempFile("a.yaml", `top:\n  $include: ./b.yaml\n`);

    const config = { [INCLUDE_KEY]: "./a.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const top = result.top as Record<string, unknown>;
    const middle = top.middle as Record<string, unknown>;
    expect(middle.deep).toBe("value");
  });

  it("resolves includes in subdirectories (relative paths)", () => {
    mkdirSync(join(TEST_DIR, "sub"), { recursive: true });
    writeTempFile("sub/nested.yaml", `nested: true\n`);
    writeTempFile("parent.yaml", `$include: ./sub/nested.yaml\n`);

    const config = { [INCLUDE_KEY]: "./parent.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    expect(result.nested).toBe(true);
  });
});

// ── Circular include detection ──────────────────────────────────────────────

describe("processIncludes — circular include detection", () => {
  it("detects direct circular include (A -> A)", () => {
    writeTempFile("self.yaml", `$include: ./self.yaml\n`);
    const config = { [INCLUDE_KEY]: "./self.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(CircularIncludeError);
  });

  it("detects indirect circular include (A -> B -> A)", () => {
    writeTempFile("a.yaml", `$include: ./b.yaml\n`);
    writeTempFile("b.yaml", `$include: ./a.yaml\n`);
    const config = { [INCLUDE_KEY]: "./a.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(CircularIncludeError);
  });

  it("the error contains the chain of includes", () => {
    writeTempFile("x.yaml", `$include: ./y.yaml\n`);
    writeTempFile("y.yaml", `$include: ./x.yaml\n`);
    const config = { [INCLUDE_KEY]: "./x.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    try {
      processIncludes(config, configPath);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircularIncludeError);
      const circularErr = err as CircularIncludeError;
      expect(circularErr.chain.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── Max depth exceeded ──────────────────────────────────────────────────────

describe("processIncludes — max depth exceeded", () => {
  it("throws when include depth exceeds MAX_INCLUDE_DEPTH", () => {
    // Create a chain of includes deeper than MAX_INCLUDE_DEPTH
    // Each file includes the next: d0.yaml -> d1.yaml -> ... -> d11.yaml
    for (let i = 0; i <= MAX_INCLUDE_DEPTH + 1; i++) {
      if (i <= MAX_INCLUDE_DEPTH) {
        writeTempFile(`d${i}.yaml`, `$include: ./d${i + 1}.yaml\n`);
      } else {
        writeTempFile(`d${i}.yaml`, `final: done\n`);
      }
    }

    const config = { [INCLUDE_KEY]: "./d0.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(ConfigIncludeError);
    expect(() => processIncludes(config, configPath)).toThrow(
      `Include depth exceeds ${MAX_INCLUDE_DEPTH}`,
    );
  });
});

// ── File not found ──────────────────────────────────────────────────────────

describe("processIncludes — file not found", () => {
  it("throws a descriptive error when included file does not exist", () => {
    const config = { [INCLUDE_KEY]: "./nonexistent.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(ConfigIncludeError);
    expect(() => processIncludes(config, configPath)).toThrow("Failed to load");
  });

  it("includes the file path in the error", () => {
    const config = { [INCLUDE_KEY]: "./missing-file.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    try {
      processIncludes(config, configPath);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).includePath).toBe("./missing-file.yaml");
    }
  });

  it("preserves the original cause", () => {
    const config = { [INCLUDE_KEY]: "./missing-file.yaml" };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    try {
      processIncludes(config, configPath);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigIncludeError);
      expect((err as ConfigIncludeError).cause).toBeDefined();
    }
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("processIncludes — edge cases", () => {
  it("returns value as-is when no $include present", () => {
    const config = { agent: { maxTurns: 10 }, memory: { enabled: true } };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath);
    expect(result).toEqual(config);
  });

  it("handles primitives passed as config value", () => {
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(processIncludes("hello", configPath)).toBe("hello");
    expect(processIncludes(42, configPath)).toBe(42);
    expect(processIncludes(null, configPath)).toBe(null);
    expect(processIncludes(true, configPath)).toBe(true);
  });

  it("processes $include inside arrays of objects", () => {
    writeTempFile("plugin-defaults.yaml", `package: "@kirie/default"\nenabled: true\n`);
    const config = {
      plugins: [
        { [INCLUDE_KEY]: "./plugin-defaults.yaml" },
        { package: "@kirie/custom", enabled: false },
      ],
    };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    const result = processIncludes(config, configPath) as Record<string, unknown>;
    const plugins = result.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.package).toBe("@kirie/default");
    expect(plugins[0]!.enabled).toBe(true);
    expect(plugins[1]!.package).toBe("@kirie/custom");
  });

  it("throws for invalid $include value type (number)", () => {
    const config = { [INCLUDE_KEY]: 42 };
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(ConfigIncludeError);
    expect(() => processIncludes(config, configPath)).toThrow(
      "Expected string or string[]",
    );
  });

  it("throws for non-string item in $include array", () => {
    const config = { [INCLUDE_KEY]: ["./valid.yaml", 123] };
    writeTempFile("valid.yaml", `key: value\n`);
    const configPath = mainConfigPath();
    writeTempFile("config.yaml", "");

    expect(() => processIncludes(config, configPath)).toThrow(ConfigIncludeError);
    expect(() => processIncludes(config, configPath)).toThrow(
      "Expected string in $include array",
    );
  });
});
