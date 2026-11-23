import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CommandRegistry, COMMAND_OWNER_ONLY_TEXT } from "../commands/registry.js";
import { OwnerDirectory } from "../interaction/owners.js";
import type { CommandReply } from "../commands/types.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "./auth.js";
import type { AuditTrail } from "./audit-trail.js";
import { SecretScrubber } from "./secret-scrubber.js";
import { SecretsAuditor } from "./secrets-scan.js";
import { createSecretsCommands, parseSecretsFindingIds } from "./secrets-commands.js";
import { buildSecretsFixture, type SecretsFixture } from "./secrets-scan.test-fixtures.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, senderId = OWNER): UnifiedMessage {
  return {
    id: "10", channel: "telegram" as ChannelName, senderId, senderName: "x",
    text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null,
  } as UnifiedMessage;
}

describe("/secrets", () => {
  let fx: SecretsFixture;
  let registry: CommandRegistry;
  let auditor: SecretsAuditor;
  let scrubber: SecretScrubber;
  let replies: string[];
  let approvals: Array<{ title: string; body?: string }>;
  let answer: "approved" | "denied" | "timeout";
  let audits: unknown[];

  async function run(text: string, senderId = OWNER) {
    replies = [];
    const message = msg(text, senderId);
    const outcome = await registry.dispatch({
      message,
      identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r: CommandReply) => { replies.push(r.text); },
    });
    return { outcome, text: replies.join("\n") };
  }

  function expectNoValues(text: string, where: string) {
    for (const v of fx.values) expect(text.includes(v), `${where} contains a secret`).toBe(false);
  }

  beforeEach(() => {
    fx = buildSecretsFixture();
    approvals = [];
    audits = [];
    answer = "approved";
    scrubber = new SecretScrubber({ disabledRules: ["jwt"] });
    const audit = { record: (r: unknown) => { audits.push(r); } };
    auditor = new SecretsAuditor({ dataDir: fx.dataDir, homeDir: fx.home, scrubber, audit });
    registry = new CommandRegistry({
      owners: new OwnerDirectory({ telegram: [OWNER] }),
      audit: audit as unknown as AuditTrail,
      prompts: {
        requestApproval: vi.fn(async (req: { title: string; body?: string }) => {
          approvals.push({ title: req.title, body: req.body });
          return { outcome: answer, optionId: answer === "approved" ? "approve" : "deny", code: "K7Q2" };
        }),
      },
    });
    registry.registerAll(createSecretsCommands({
      auditor,
      scrubber,
      scrubbingConfig: { enabled: true, disabledRules: ["jwt"] },
      homeDir: fx.home,
    }));
  });

  afterEach(() => fx.cleanup());

  it("is owner-only: a non-owner is refused and nothing is scanned", async () => {
    const scan = vi.spyOn(auditor, "scan");
    const { outcome, text } = await run("/secrets scan", STRANGER);
    expect(outcome.kind).toBe("denied");
    expect(text).toBe(COMMAND_OWNER_ONLY_TEXT);
    expect(scan).not.toHaveBeenCalled();
    const redact = await run("/secrets redact all", STRANGER);
    expect(redact.outcome.kind).toBe("denied");
    expect(approvals).toEqual([]);
  });

  it("is registered as a security, owner-only, DM command with no off switch", async () => {
    const def = registry.get("secrets")!;
    expect(def).toEqual(expect.objectContaining({ category: "security", ownerOnly: true, scope: "dm" }));
    expect(Object.keys(def.subcommands ?? {}).sort()).toEqual(["redact", "report", "scan", "status"]);
    const { text } = await run("/secrets off");
    expect(text).toMatch(/^Usage: \/secrets/);
  });

  it("status shows on/off, sinks, rules, known-secret labels only, counters and the last scan", async () => {
    scrubber.addKnownSecret(fx.secrets.github, "credential:github.token");
    scrubber.scrub(`x ${fx.secrets.linear}`, { sink: "channel" });
    const { text } = await run("/secrets");
    expect(text).toContain("Secret scrubbing: ON");
    expect(text).toContain("Sinks scrubbed: channels, logs, memory");
    expect(text).toMatch(/Rules active: \d+ \(disabled: jwt\)/);
    expect(text).toContain("Known secrets: 1 (credential 1)");
    expect(text).toContain("credential:github.token");
    expect(text).toContain("by sink: channel 1");
    expect(text).toContain("by rule: linear-key 1");
    expect(text).toContain("Last scan: never");
    expectNoValues(text, "status");
  });

  it("scan replies with counts, the report path and rotation advice, never values", async () => {
    const { text } = await run("/secrets scan full");
    expect(text).toMatch(/Secrets scan \(full\) finished: \d+ finding\(s\), \d+ redactable/);
    expect(text).toContain("By rule:");
    expect(text).toContain("auth-header (bare Bearer) 1");
    expect(text).toMatch(/Report: .*reports\/secrets-scan-.*\.json \(0600\)/);
    expect(text).toContain("Kirie cannot clean these");
    expect(text).toContain("~/.claude/projects");
    expect(text).toContain("rotating them is the real fix");
    expect(text).toContain("BotFather");
    expectNoValues(text, "scan reply");
    const status = await run("/secrets status");
    expect(status.text).toMatch(/Last scan: .* \(full\), \d+ finding/);
  });

  it("rejects a bad scan mode", async () => {
    expect((await run("/secrets scan everything")).text).toBe("Usage: /secrets scan [quick|full]");
  });

  it("report lists id, store, location, rule and fingerprint, never values", async () => {
    await run("/secrets scan full");
    const { text } = await run("/secrets report 100");
    const lines = text.split("\n").filter((l) => l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(l).toMatch(/^#\d+ [a-z-]+ \| .+ \| [a-z-]+.* \| fp [0-9a-f]{8}/);
    expect(text).toContain("vault suggested");
    expect(text).toContain("not redactable");
    expectNoValues(text, "report reply");
    expect((await run("/secrets report 0")).text).toMatch(/^Usage/);
    const short = await run("/secrets report 2");
    expect(short.text).toMatch(/\+\d+ more/);
  });

  it("redact asks first; Cancel or timeout changes nothing", async () => {
    await run("/secrets scan quick");
    const before = readFileSync(fx.paths.memory);
    const rowsBefore = fx.live[0]!.prepare("SELECT content FROM memories ORDER BY id").all();
    for (const a of ["denied", "timeout"] as const) {
      answer = a;
      const { text } = await run("/secrets redact all");
      expect(text).toBe("Cancelled. Nothing was changed.");
    }
    expect(approvals).toHaveLength(2);
    expect(approvals[0]!.title).toMatch(/^Redact \d+ stored secret\(s\)\?$/);
    expect(approvals[0]!.body).toContain("This cannot be undone");
    expectNoValues(JSON.stringify(approvals), "confirm prompt");
    expect(fx.live[0]!.prepare("SELECT content FROM memories ORDER BY id").all()).toEqual(rowsBefore);
    expect(readFileSync(fx.paths.memory).equals(before)).toBe(true);
    expect(audits.some((r) => (r as { feature: string; action: string }).feature === "secrets" && (r as { action: string }).action === "redact")).toBe(false);
  });

  it("redact without a prompt service is never confirmed", async () => {
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }) });
    registry.registerAll(createSecretsCommands({ auditor, scrubber, scrubbingConfig: {}, homeDir: fx.home }));
    await run("/secrets scan");
    const { text } = await run("/secrets redact all");
    expect(text).toBe("Cancelled. Nothing was changed.");
    expect((fx.live[0]!.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.linearMemory) as { content: string }).content)
      .toContain(fx.secrets.linear);
  });

  it("redact after Confirm changes the rows, reports per store, audits without values", async () => {
    await run("/secrets scan full");
    const { text } = await run("/secrets redact all");
    expect(text).toMatch(/^Redacted \d+ finding\(s\)\./);
    expect(text).toMatch(/memory\.db: \d+ row\(s\), index rebuilt \(memories_fts\).*checkpoint complete, vacuum ok/);
    expect(text).toMatch(/daemon\.out\.log: \d+ masked in place \(size kept, inode kept\)/);
    expect(text).toContain("rotating them is the real fix");
    expectNoValues(text, "redact reply");
    expect((fx.live[0]!.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.linearMemory) as { content: string }).content)
      .toBe("Linear key: «redacted:linear-key»");
    expectNoValues(JSON.stringify(audits), "audit records");
    const actions = audits.map((r) => `${(r as { feature: string }).feature}.${(r as { action: string }).action}`);
    expect(actions).toEqual(expect.arrayContaining(["secrets.scan", "secrets.redact", "commands.secrets"]));
  });

  it("redact by id list and range; unknown ids are explained; needs a scan first", async () => {
    expect((await run("/secrets redact all")).text).toMatch(/Send \/secrets scan first/);
    await run("/secrets scan");
    expect((await run("/secrets redact 9999")).text).toMatch(/^Nothing to redact\. #9999: no such finding/);
    expect((await run("/secrets redact abc")).text).toMatch(/^Usage: \/secrets redact/);
    const { text } = await run("/secrets redact 1-2");
    expect(text).toMatch(/Redacted 2 finding\(s\)|Skipped/);
  });

  it("parses finding ids", () => {
    expect(parseSecretsFindingIds(["all"])).toBe("all");
    expect(parseSecretsFindingIds(["1,4", "#7", "2-3"])).toEqual([1, 4, 7, 2, 3]);
    expect(parseSecretsFindingIds(["0"])).toBeNull();
    expect(parseSecretsFindingIds(["5-2"])).toBeNull();
    expect(parseSecretsFindingIds(["x"])).toBeNull();
    expect(parseSecretsFindingIds([])).toBeNull();
  });
});
