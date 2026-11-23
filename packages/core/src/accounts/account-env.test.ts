import { describe, it, expect } from "vitest";
import { ACCOUNT_AUTH_OVERRIDES, buildAccountEnv, mergeStaticEnv } from "./account-env.js";

// Synthetic, obviously fake values built at run time.
const fake = (name: string): string => ["fake", name, "value"].join("-");

function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/test", UNSET: undefined };
  for (const key of ACCOUNT_AUTH_OVERRIDES) env[key] = fake(key.toLowerCase());
  return env;
}

describe("buildAccountEnv", () => {
  it("leaves CLAUDE_CONFIG_DIR unset for the default account even when the base env has it", () => {
    const env = buildAccountEnv({ kind: "default", configDir: null }, baseEnv());
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("sets the exact config dir string for a config_dir account", () => {
    const env = buildAccountEnv({ kind: "config_dir", configDir: "/home/test/.claude2" }, baseEnv());
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/test/.claude2");
  });

  it("removes all seven auth override variables", () => {
    expect(ACCOUNT_AUTH_OVERRIDES).toHaveLength(7);
    const env = buildAccountEnv({ kind: "config_dir", configDir: "/x/.claude3" }, baseEnv());
    for (const key of ACCOUNT_AUTH_OVERRIDES) {
      if (key === "CLAUDE_CONFIG_DIR") continue;
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect("UNSET" in env).toBe(false);
  });

  it("does not mutate the base object", () => {
    const base = baseEnv();
    const snapshot = { ...base };
    buildAccountEnv({ kind: "config_dir", configDir: "/x/.claude4" }, base);
    expect(base).toEqual(snapshot);
  });

  it("refuses a config_dir account without a directory", () => {
    expect(() => buildAccountEnv({ kind: "config_dir", configDir: null }, {})).toThrow();
  });
});

describe("mergeStaticEnv", () => {
  it("adds extra keys but never lets them change the login", () => {
    const lease = buildAccountEnv({ kind: "config_dir", configDir: "/x/.claude2" }, { PATH: "/bin" });
    const merged = mergeStaticEnv(lease, { FOO: "1", CLAUDE_CONFIG_DIR: "/elsewhere", ANTHROPIC_API_KEY: fake("k") });
    expect(merged.FOO).toBe("1");
    expect(merged.CLAUDE_CONFIG_DIR).toBe("/x/.claude2");
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
