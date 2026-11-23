import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, symlinkSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isE164, maskNumber, normalizeE164, withoutPlus, lastFour } from "./numbers.js";
import { readVoiceEnvFile, resolveVoiceSecret, parseEnvLines, type VoiceCredentialLookup } from "./secrets.js";
import { CallStore } from "./call-store.js";
import { capSpeech, chunkForSay, cleanForSpeech } from "./speech.js";

describe("numbers", () => {
  it("normalises formatting", () => {
    expect(normalizeE164("+20 100 123-4567")).toBe("+201001234567");
    expect(normalizeE164("(+1) 415.555.0100")).toBe("+14155550100");
    expect(normalizeE164("00201001234567")).toBe("+201001234567");
  });

  it("returns null for withheld, empty, too short, SIP and bare digits", () => {
    for (const v of ["anonymous", "Restricted", "", "   ", "+12345", "sip:alice@example.com", "201001234567", undefined, null]) {
      expect(normalizeE164(v as string | undefined)).toBeNull();
    }
  });

  it("assumePlus reads bare digits as international (Plivo)", () => {
    expect(normalizeE164("201001234567", { assumePlus: true })).toBe("+201001234567");
    expect(normalizeE164("anonymous", { assumePlus: true })).toBeNull();
  });

  it("masks and strips", () => {
    expect(maskNumber("+201001234567")).toBe("…4567");
    expect(maskNumber(null)).toBe("withheld");
    expect(withoutPlus("+14155550100")).toBe("14155550100");
    expect(lastFour("+14155550100")).toBe("0100");
    expect(isE164("+14155550100")).toBe(true);
    expect(isE164("14155550100")).toBe(false);
  });
});

describe("voice secrets", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-voice-secrets-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const tokenFromFile = ["file", "token", "value", "0001"].join("-");
  const tokenFromStore = ["store", "token", "value", "0002"].join("-");

  function writeEnv(mode: number, content = `# voice\nexport TWILIO_AUTH_TOKEN="${tokenFromFile}"\nVOICE_PIN=4321\n`): string {
    const p = join(dir, "voice.env");
    writeFileSync(p, content);
    chmodSync(p, mode);
    return p;
  }

  function store(entries: Record<string, string>): VoiceCredentialLookup {
    return { list: () => Object.keys(entries), get: async (k) => entries[k] };
  }

  it("parses KEY=value lines", () => {
    const m = parseEnvLines("A=1\n# c\nexport B='two'\nC=\"3\"\nbad\nD=\n");
    expect([...m.entries()]).toEqual([["A", "1"], ["B", "two"], ["C", "3"]]);
  });

  it("reads a 0600 file owned by the user", () => {
    const f = readVoiceEnvFile(writeEnv(0o600));
    expect(f.status).toBe("ok");
    expect(f.values.get("TWILIO_AUTH_TOKEN")).toBe(tokenFromFile);
  });

  it("ignores a file with group or world permissions, with a reason and no values", () => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const f = readVoiceEnvFile(writeEnv(mode));
      expect(f.status).toBe("ignored");
      expect(f.reason).toMatch(/chmod 600/);
      expect(f.values.size).toBe(0);
      expect(f.reason).not.toContain(tokenFromFile);
    }
  });

  it("ignores a file owned by someone else", () => {
    const p = writeEnv(0o600);
    const f = readVoiceEnvFile(p, { uid: statSync(p).uid + 1 });
    expect(f.status).toBe("ignored");
    expect(f.reason).toMatch(/not owned/);
  });

  it("ignores a symlink and reports an absent file as absent", () => {
    const real = writeEnv(0o600);
    const link = join(dir, "link.env");
    symlinkSync(real, link);
    expect(readVoiceEnvFile(link).status).toBe("ignored");
    expect(readVoiceEnvFile(join(dir, "nope.env")).status).toBe("absent");
  });

  it("voice.env wins over the credential store", async () => {
    const envFile = readVoiceEnvFile(writeEnv(0o600));
    const r = await resolveVoiceSecret("TWILIO_AUTH_TOKEN", {
      envFile, configValue: tokenFromStore, configPath: "voice.twilio.authToken", credentials: store({ "twilio.auth_token": tokenFromStore }),
    });
    expect(r).toEqual({ value: tokenFromFile, source: "voice.env" });
  });

  it("falls back to the credential store: a resolved reference, or one that is still unresolved", async () => {
    const envFile = readVoiceEnvFile(join(dir, "absent.env"));
    const creds = store({ "twilio.auth_token": tokenFromStore });
    expect(await resolveVoiceSecret("TWILIO_AUTH_TOKEN", { envFile, configValue: tokenFromStore, configPath: "voice.twilio.authToken", credentials: creds }))
      .toEqual({ value: tokenFromStore, source: "credential-store" });
    expect(await resolveVoiceSecret("TWILIO_AUTH_TOKEN", { envFile, configValue: "$credential:twilio.auth_token", configPath: "voice.twilio.authToken", credentials: creds }))
      .toEqual({ value: tokenFromStore, source: "credential-store" });
  });

  it("an ignored voice.env falls through to the store", async () => {
    const envFile = readVoiceEnvFile(writeEnv(0o644));
    const r = await resolveVoiceSecret("TWILIO_AUTH_TOKEN", {
      envFile, configValue: tokenFromStore, configPath: "voice.twilio.authToken", credentials: store({ "twilio.auth_token": tokenFromStore }),
    });
    expect(r.source).toBe("credential-store");
  });

  it("plaintext in config is refused with a reason that does not contain the value", async () => {
    const envFile = readVoiceEnvFile(join(dir, "absent.env"));
    const plaintext = ["plain", "text", "secret", "9"].join("-");
    const r = await resolveVoiceSecret("PLIVO_AUTH_TOKEN", { envFile, configValue: plaintext, configPath: "voice.plivo.authToken", credentials: store({}) });
    expect(r.value).toBeUndefined();
    expect(r.problem).toMatch(/plaintext/);
    expect(r.problem).not.toContain(plaintext);
  });

  it("an unresolvable reference is reported", async () => {
    const envFile = readVoiceEnvFile(join(dir, "absent.env"));
    const r = await resolveVoiceSecret("PLIVO_AUTH_ID", { envFile, configValue: "$credential:plivo.auth_id", configPath: "voice.plivo.authId", credentials: store({}) });
    expect(r.value).toBeUndefined();
    expect(r.problem).toMatch(/not in the credential store/);
  });

  it("neither source present means nothing", async () => {
    const envFile = readVoiceEnvFile(join(dir, "absent.env"));
    expect(await resolveVoiceSecret("PLIVO_AUTH_ID", { envFile, configPath: "voice.plivo.authId" })).toEqual({ source: "none" });
  });

  it("never reads environment variables", async () => {
    const before = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_AUTH_TOKEN = ["env", "token"].join("-");
    try {
      const envFile = readVoiceEnvFile(join(dir, "absent.env"));
      expect(await resolveVoiceSecret("TWILIO_AUTH_TOKEN", { envFile, configPath: "voice.twilio.authToken" })).toEqual({ source: "none" });
    } finally {
      if (before === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = before;
    }
  });
});

describe("CallStore", () => {
  let dir: string;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-voice-calls-"));
    now = new Date(2026, 10, 23, 12, 0, 0).getTime();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const base = { provider: "twilio" as const, direction: "outbound" as const, mode: "say" as const, role: "owner" as const, remote: "+201001234567", requestedBy: "owner-command" as const };

  it("create, update and lookup by provider call id; files are private", () => {
    const s = new CallStore(dir, () => now);
    const c = s.create(base);
    expect(c.state).toBe("dialing");
    s.update(c.id, { providerCallId: "CA1", state: "in-progress", answeredAt: now });
    expect(s.byProviderCallId("twilio", "CA1")?.id).toBe(c.id);
    expect(s.byProviderCallId("plivo", "CA1")).toBeNull();
    expect(s.byProviderCallId("twilio", "")).toBeNull();
    expect(statSync(join(dir, "calls.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("reloads the last state per id and tolerates a corrupt line", () => {
    const s = new CallStore(dir, () => now);
    const c = s.create(base);
    s.update(c.id, { state: "completed", durationSeconds: 30 });
    appendFileSync(join(dir, "calls.jsonl"), "{not json\n");
    const s2 = new CallStore(dir, () => now);
    expect(s2.get(c.id)?.state).toBe("completed");
    expect(readFileSync(join(dir, "calls.jsonl"), "utf8")).not.toContain("{not json");
  });

  it("recoverStale closes open records", () => {
    const s = new CallStore(dir, () => now);
    const open = s.create(base);
    const done = s.create({ ...base, state: "completed" });
    const s2 = new CallStore(dir, () => now);
    expect(s2.recoverStale()).toBe(1);
    expect(s2.get(open.id)).toMatchObject({ state: "failed", endReason: "daemon-restart" });
    expect(s2.get(done.id)?.state).toBe("completed");
    expect(s2.active()).toEqual([]);
  });

  it("usageToday counts calls and seconds on the local day across providers", () => {
    const s = new CallStore(dir, () => now);
    const yesterday = new CallStore(dir, () => now - 24 * 3600_000);
    yesterday.create({ ...base, state: "completed", durationSeconds: 999 });
    const s3 = new CallStore(dir, () => now);
    s3.create({ ...base, state: "completed", durationSeconds: 60 });
    s3.create({ ...base, provider: "plivo", state: "completed", durationSeconds: 30 });
    const live = s3.create(base);
    s3.update(live.id, { state: "in-progress", answeredAt: now - 15_000 });
    expect(s3.usageToday()).toEqual({ calls: 3, seconds: 105 });
    expect(s.recent(10).length).toBeGreaterThanOrEqual(0);
  });

  it("recent is newest first", () => {
    let t = now;
    const s = new CallStore(dir, () => t);
    const a = s.create(base);
    t += 1000;
    const b = s.create(base);
    expect(s.recent(2).map((r) => r.id)).toEqual([b.id, a.id]);
  });
});

describe("speech helpers", () => {
  it("cleans markdown, code, links and media markers", () => {
    const t = cleanForSpeech("# Title\n**Bold** and `code` see [docs](https://x.example) https://y.example\n```js\nx()\n```\nMEDIA:/tmp/a.png\n- item");
    expect(t).toBe("Title\nBold and code see docs\nitem");
  });

  it("caps at a sentence boundary and reports truncation", () => {
    const text = "First sentence here. Second sentence is longer than that. Third.";
    expect(capSpeech(text, 1000)).toEqual({ text, truncated: false });
    const c = capSpeech(text, 35);
    expect(c.truncated).toBe(true);
    expect(c.text).toBe("First sentence here.");
  });

  it("chunks into pieces no longer than the limit", () => {
    const long = `${"word ".repeat(400)}end.`;
    const chunks = chunkForSay(`Short one. ${long} Last.`, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks[0]).toBe("Short one.");
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("Last.");
  });
});
