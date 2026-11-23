import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createModuleLogger, createScrubbingDestination, type LogLineDestination } from "./logger.js";
import { configureScrubber, getScrubber, resetScrubberForTesting } from "../security/secret-scrubber.js";

/** Synthetic tokens, assembled at run time. */
const githubToken = (): string => ["gh", "p_", "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3hJ5"].join("");
const botToken = (): string => ["81", "23456789", ":", "AA", "Hq3Lm9Zt7Wc2Xv5Bn8Kd4Rf6Gj1Ps0Ty3Ue"].join("");

function capture(): { dest: LogLineDestination; lines: string[] } {
  const lines: string[] = [];
  return { dest: { write: (line: string) => lines.push(line) }, lines };
}

describe("createModuleLogger", () => {
  beforeEach(() => resetScrubberForTesting());
  afterEach(() => resetScrubberForTesting());

  it("writes pino JSON lines with the module name", () => {
    const { dest, lines } = capture();
    const log = createModuleLogger("test-module", { destination: dest });
    log.info({ n: 1 }, "hello");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ level: 30, name: "test-module", n: 1, msg: "hello" });
    expect(lines[0]!.endsWith("\n")).toBe(true);
  });

  it("defaults to level info", () => {
    const { dest, lines } = capture();
    const log = createModuleLogger("lvl", { destination: dest });
    log.debug("hidden");
    expect(lines).toHaveLength(0);
    expect(log.level).toBe("info");
  });

  it("redacts a secret in msg, in a nested field and in err.message", () => {
    const { dest, lines } = capture();
    const log = createModuleLogger("leaky", { destination: dest });
    const t = githubToken();
    log.info(`token is ${t}`);
    log.warn({ deep: { list: [`x ${t}`] } }, "nested");
    log.error({ err: new Error(`failed with ${t}`) }, "boom");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toContain(t);
      expect(line).toContain("«redacted:github-token»");
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("redacts the unhandled-rejection shape that leaked the bot token", () => {
    const { dest, lines } = capture();
    const log = createModuleLogger("daemon", { destination: dest });
    const token = botToken();
    const reason = { name: "HttpError", message: `Network request for 'getUpdates' failed! (https://api.telegram.org/bot${token}/getUpdates)` };
    log.fatal({ reason }, "unhandled promise rejection");
    expect(lines[0]).not.toContain(token.split(":")[1]);
    expect(lines[0]).toContain("«redacted:telegram-bot-token»/getUpdates");
  });

  it("redacts known secrets registered on the shared scrubber", () => {
    const { dest, lines } = capture();
    const log = createModuleLogger("known", { destination: dest });
    const secret = "Qz8wPl3nVb6xKr";
    getScrubber().addKnownSecret(secret, "test");
    log.info({ value: secret }, "value");
    expect(lines[0]).not.toContain(secret);
  });

  it("passes lines through unchanged when the log sink is disabled", () => {
    configureScrubber({ sinks: { logs: false } });
    const { dest, lines } = capture();
    const log = createModuleLogger("raw", { destination: dest });
    const t = githubToken();
    log.info(t);
    expect(lines[0]).toContain(t);
  });

  it("writes a placeholder line when scrubbing fails", () => {
    const { dest, lines } = capture();
    const scrubbing = createScrubbingDestination(dest);
    const original = getScrubber().scrub;
    getScrubber().scrub = () => {
      throw new Error("scrubber broke");
    };
    try {
      scrubbing.write(`{"msg":"${githubToken()}"}\n`);
    } finally {
      getScrubber().scrub = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(githubToken());
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 50, msg: "«log line withheld: scrubber error»" });
  });
});
