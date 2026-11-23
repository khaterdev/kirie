import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommandRegistry,
  OwnerDirectory,
  SecretScrubber,
  KirieConfigSchema,
  SECRETS_HEARTBEAT_DB_ENV,
  SECRETS_TOOL_ENV,
  type CommandReply,
  type ResolvedIdentity,
  type UnifiedMessage,
} from "@kirie/core";
import { setupSecrets } from "./secrets.js";
import type { DaemonContext } from "./types.js";

const OWNER = "1001";

describe("setupSecrets", () => {
  let dir: string;
  let audits: unknown[];

  function context(configOver: Record<string, unknown> = {}): DaemonContext {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    audits = [];
    return {
      config: KirieConfigSchema.parse(configOver),
      dataDir: dir,
      agentCwd: dir,
      commands: new CommandRegistry({ owners }),
      owners,
      scrubber: new SecretScrubber(),
      credentialStore: { get: async () => undefined, set: async () => {} },
      memoryManager: null,
      audit: { record: (r: unknown) => { audits.push(r); } },
      kirieToolsEnv: {},
      notifyOwner: vi.fn(async () => {}),
    } as unknown as DaemonContext;
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kirie-secrets-feature-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers /secrets, turns on the counts-only tool, and does no I/O at setup", async () => {
    const ctx = context();
    const handle = await setupSecrets(ctx);
    expect(handle).toEqual({ name: "secrets" });
    expect(ctx.commands.get("secrets")).toEqual(expect.objectContaining({ ownerOnly: true, category: "security" }));
    expect(ctx.kirieToolsEnv).toEqual({ [SECRETS_TOOL_ENV]: "1" });
  });

  it("passes a moved heartbeat log DB to the tool subprocess", async () => {
    const ctx = context({ proactive: { heartbeatLogging: { dbPath: join(dir, "hb.db") } } });
    await setupSecrets(ctx);
    expect(ctx.kirieToolsEnv[SECRETS_HEARTBEAT_DB_ENV]).toBe(join(dir, "hb.db"));
  });

  it("an owner /secrets scan in the data dir reports a synthetic key without its value", async () => {
    const key = ["lin", "_api_", "Q".repeat(8), "7a".repeat(16)].join("");
    writeFileSync(join(dir, "MEMORY.md"), `# Memory\nlinear ${key}\n`);
    const ctx = context();
    await setupSecrets(ctx);
    const replies: string[] = [];
    const message = { id: "1", channel: "telegram", senderId: OWNER, senderName: "o", text: "/secrets scan", chatType: "dm", chatId: OWNER, timestamp: 0, raw: null } as unknown as UnifiedMessage;
    await ctx.commands.dispatch({
      message,
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r: CommandReply) => { replies.push(r.text); },
    });
    const text = replies.join("\n");
    expect(text).toMatch(/finished: 1 finding\(s\), 1 redactable/);
    expect(text).toContain("linear-key 1");
    expect(text.includes(key)).toBe(false);
    expect(JSON.stringify(audits).includes(key)).toBe(false);
  });
});
