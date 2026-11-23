import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSecretsTools } from "./secrets-tools.js";
import { SECRETS_TOOL_ENV } from "../../security/secrets-scan.js";
import { buildSecretsFixture, type SecretsFixture } from "../../security/secrets-scan.test-fixtures.js";

describe("secrets_scan tool", () => {
  let fx: SecretsFixture;
  beforeEach(() => { fx = buildSecretsFixture(); });
  afterEach(() => fx.cleanup());

  it("does not exist unless the daemon's secrets feature turned it on, and the factory does no I/O", () => {
    const missing = join(fx.dataDir, "never-created");
    expect(createSecretsTools({ dbDir: missing, env: {} })).toEqual({});
    expect(Object.keys(createSecretsTools({ dbDir: missing, env: { [SECRETS_TOOL_ENV]: "1" } }))).toEqual(["secrets_scan"]);
    expect(existsSync(missing)).toBe(false);
  });

  it("takes no parameters: it cannot redact, reveal or change anything", () => {
    const tool = createSecretsTools({ dbDir: fx.dataDir, env: { [SECRETS_TOOL_ENV]: "1" } }).secrets_scan!;
    expect(tool.parameters.properties).toEqual({});
  });

  it("returns counts only: no values, locations, fingerprints or ids; writes nothing; changes nothing", async () => {
    const files = [fx.paths.memory, `${fx.paths.memory}-wal`, fx.paths.chat, `${fx.paths.chat}-wal`, fx.paths.log, fx.paths.memoryMd];
    const before = files.map((f) => (existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : "-"));
    const tool = createSecretsTools({ dbDir: fx.dataDir, env: { [SECRETS_TOOL_ENV]: "1" } }).secrets_scan!;
    const result = await tool.handler({}) as { counts: { total: number; byStore: Record<string, number>; byRule: Record<string, number> }; hint: string; mode: string };
    expect(result.mode).toBe("quick");
    expect(result.counts.total).toBeGreaterThan(5);
    expect(result.counts.byStore.memory).toBeGreaterThan(0);
    expect(result.counts.byStore.logs).toBeUndefined(); // quick: logs are not read
    expect(result.counts.byRule["linear-key"]).toBeGreaterThan(0);
    expect(result.hint).toContain("/secrets redact");
    const json = JSON.stringify(result);
    for (const v of fx.values) expect(json.includes(v)).toBe(false);
    expect(json).not.toMatch(/fingerprint|location|target|"id"|memories id=|api:linear:key/);
    expect(existsSync(join(fx.dataDir, "reports"))).toBe(false);
    expect(files.map((f) => (existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : "-"))).toEqual(before);
  });
});
