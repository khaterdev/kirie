/**
 * Command audit (W4-INT item 7, PLAN B.4 and B.12).
 *
 * Builds every feature module against a realistic context (real registries,
 * real stores in a temp dir, a temp HOME) with every feature turned on in the
 * config, then checks every registered command:
 * - it has help text (a description, and `/help <name>` renders it);
 * - it is owner-only unless B.12 marks it public;
 * - no name or alias is registered twice;
 * - the generated /help lists owner commands to the owner and hides them from
 *   anyone else, and `/help <owner command>` answers a non-owner as unknown.
 *
 * Commands are checked by rule, not against a fixed list, so features that are
 * still being filled in (sandbox, computer use) are covered when they land.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandDefinition, CommandReply, UnifiedMessage } from "@kirie/core";
import { FEATURES, runFeatureSetups, stopFeatures, type DaemonContext, type FeatureHandle } from "./index.js";
import type { FeatureFailure } from "./runner.js";
import { AUDIT_OWNER, buildAuditContext } from "./audit-context.test-util.js";

const OWNER = AUDIT_OWNER;
const STRANGER = "2002";

/** B.12: the only commands anyone may run. Everything else is owner-only. */
const PUBLIC_COMMANDS = new Set(["help", "stop", "clear", "context"]);

let home: string;
let prevHome: string | undefined;
let ctx: DaemonContext;
let closeContext: () => void = () => {};
let handles: FeatureHandle[] = [];
let failures: FeatureFailure[] = [];

async function helpAs(senderId: string, topic = ""): Promise<string> {
  const replies: string[] = [];
  const message = {
    id: "m1", channel: "telegram", senderId, senderName: "x", text: topic ? `/help ${topic}` : "/help",
    chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: {},
  } as unknown as UnifiedMessage;
  await ctx.commands.dispatch({
    message,
    identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" },
    source: "channel",
    send: async (r: CommandReply) => { replies.push(r.text); },
  });
  return replies.join("\n");
}

function listed(help: string, def: CommandDefinition): boolean {
  return help.split("\n").some((l) => l.startsWith(`/${def.name} `) || l === `/${def.name}`);
}

describe("command audit: every feature on", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "kirie-cmd-audit-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    const dataDir = join(home, ".kirie");
    mkdirSync(dataDir, { recursive: true });
    ({ ctx, close: closeContext } = buildAuditContext(dataDir));
    failures = [];
    handles = await runFeatureSetups(FEATURES, ctx, { onFailure: (f) => failures.push(f) });
  });

  afterAll(async () => {
    await stopFeatures(handles);
    closeContext();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("every feature sets up without error (a duplicate name would throw here)", () => {
    expect(failures).toEqual([]);
    expect(handles.map((h) => h.name)).toEqual(FEATURES.map((f) => f.name));
  });

  it("registers the core and feature commands", () => {
    const names = ctx.commands.list().map((d) => d.name);
    for (const n of ["help", "status", "pending", "approvals", "undo", "learn", "proposals", "curator", "profile", "goal", "loop", "heartbeat", "webhook", "secrets", "plugins", "voice", "call", "accounts"]) {
      expect(names).toContain(n);
    }
  });

  it("no name or alias is registered twice", () => {
    const all = ctx.commands.list().flatMap((d) => [d.name, ...(d.aliases ?? [])]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("every command has help text, and /help <name> shows it to the owner", async () => {
    for (const def of ctx.commands.list()) {
      expect(def.description.trim().length, `/${def.name} description`).toBeGreaterThan(5);
      const help = await helpAs(OWNER, def.name);
      expect(help, `/help ${def.name}`).toContain(def.description);
      expect(help).not.toMatch(/^Unknown command/);
    }
  });

  it("every command is owner-only unless B.12 marks it public", () => {
    const offenders = ctx.commands.list().filter((d) => d.ownerOnly !== true && !PUBLIC_COMMANDS.has(d.name)).map((d) => d.name);
    expect(offenders).toEqual([]);
    for (const name of PUBLIC_COMMANDS) {
      const def = ctx.commands.get(name);
      if (def) expect(def.ownerOnly, `/${name}`).toBe(false);
    }
  });

  it("no owner-only command widens its scope beyond the DM (B.12: ownerOnly, scope dm)", () => {
    const wide = ctx.commands.list().filter((d) => d.ownerOnly !== false && d.scope === "any").map((d) => d.name);
    expect(wide).toEqual([]);
  });

  it("/help lists owner commands to the owner and hides them from anyone else", async () => {
    const ownerHelp = await helpAs(OWNER);
    const strangerHelp = await helpAs(STRANGER);
    for (const def of ctx.commands.list()) {
      if (PUBLIC_COMMANDS.has(def.name)) {
        expect(listed(strangerHelp, def), `/${def.name} for a non-owner`).toBe(true);
        expect(listed(ownerHelp, def), `/${def.name} for the owner`).toBe(true);
        continue;
      }
      expect(listed(ownerHelp, def), `/${def.name} for the owner`).toBe(true);
      expect(listed(strangerHelp, def), `/${def.name} for a non-owner`).toBe(false);
      expect(await helpAs(STRANGER, def.name), `/help ${def.name} for a non-owner`).toMatch(/^Unknown command/);
    }
  });

  it("the non-owner menu has only public commands; the owner menu has every visible command", () => {
    const publicMenu = ctx.commands.menu({ forOwner: false }).map((m) => m.command);
    expect(publicMenu.every((n) => PUBLIC_COMMANDS.has(n))).toBe(true);
    const ownerMenu = ctx.commands.menu({ forOwner: true }).map((m) => m.command);
    for (const def of ctx.commands.list()) if (!def.hidden) expect(ownerMenu).toContain(def.name);
  });
});
