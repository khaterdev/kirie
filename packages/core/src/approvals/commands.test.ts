import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { AuditTrail } from "../security/audit-trail.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { ApprovalsConfigSchema } from "../config/sections/approvals.js";
import { ApprovalEngine } from "./engine.js";
import { createApprovalsCommands } from "./commands.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return { id: "10", channel: "telegram" as ChannelName, senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over } as UnifiedMessage;
}

describe("/approvals", () => {
  let dir: string;
  let settings: RuntimeSettings;
  let audit: AuditTrail;
  let registry: CommandRegistry;
  let engine: ApprovalEngine;
  let confirmAnswer: "approved" | "denied";
  let requestApproval: ReturnType<typeof vi.fn>;

  async function run(text: string, over: Partial<UnifiedMessage> = {}): Promise<{ kind: string; text: string }> {
    const replies: CommandReply[] = [];
    const message = msg(text, over);
    const outcome = await registry.dispatch({
      message,
      identity: { canonicalId: message.senderId, senderId: message.senderId, role: message.senderId === OWNER ? "owner" : "user", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r) => { replies.push(r); },
    });
    return { kind: outcome.kind, text: replies.map((r) => r.text).join("\n") };
  }

  function build(config: Record<string, unknown> = {}, enabled = true): void {
    engine = new ApprovalEngine({ config: ApprovalsConfigSchema.parse(config), settings, homeDir: "/Users/tester", dataDir: "/Users/tester/.kirie", realpath: (p) => p });
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }), prompts: { requestApproval } as never, audit });
    registry.registerAll(createApprovalsCommands({ engine, settings, audit, prompter: { pendingCount: () => 2 }, stats: { snapshot: () => ({ allowed: 5, allowedFlagged: 1, asked: 2, denied: 1, errors: 0, since: 0 }) }, enabled }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-apr-cmd-"));
    settings = new RuntimeSettings(join(dir, "state", "runtime-settings.json"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    confirmAnswer = "approved";
    requestApproval = vi.fn(async () => ({ outcome: confirmAnswer, optionId: confirmAnswer === "approved" ? "approve" : "deny", code: "K7Q2" }));
    build();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is owner-only and DM-only through the registry", async () => {
    expect((await run("/approvals", { senderId: STRANGER, chatId: STRANGER })).kind).toBe("denied");
    expect((await run("/approvals mode yolo", { senderId: STRANGER, chatId: STRANGER })).kind).toBe("denied");
    expect((await run("/approvals", { chatType: "group", chatId: "-100" })).kind).toBe("denied");
    const def = registry.get("approvals")!;
    expect(def.ownerOnly).toBe(true);
    expect(def.scope).toBe("dm");
    expect(def.category).toBe("security");
  });

  it("synthetic text never runs it", async () => {
    const outcome = await registry.dispatch({
      message: msg("/approvals mode yolo"),
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "synthetic",
      send: async () => {},
    });
    expect(outcome.kind).toBe("not-command");
  });

  it("status", async () => {
    const r = await run("/approvals");
    expect(r.text).toContain("Mode: yolo");
    expect(r.text).toContain("Hardline list: on");
    expect(r.text).toContain("Waiting for you: 2");
    expect(r.text).toContain("Last 24 h:");
  });

  it("status says when the gate is disabled", async () => {
    build({ enabled: false }, false);
    expect((await run("/approvals status")).text).toContain("OFF");
  });

  it("mode ask needs no confirmation; mode yolo does", async () => {
    expect((await run("/approvals mode ask")).text).toContain("Mode is now ask");
    expect(engine.mode()).toBe("ask");
    expect(requestApproval).not.toHaveBeenCalled();
    confirmAnswer = "denied";
    expect((await run("/approvals mode yolo")).text).toContain("Cancelled");
    expect(engine.mode()).toBe("ask");
    confirmAnswer = "approved";
    expect((await run("/approvals mode yolo")).text).toContain("Mode is now yolo");
    expect(engine.mode()).toBe("yolo");
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ kind: "confirm" });
    expect((await run("/approvals mode off")).text).toContain("Usage");
  });

  it("scope all, then dangerous with confirmation", async () => {
    await run("/approvals scope all");
    expect(engine.policy().askScope).toBe("all");
    await run("/approvals scope dangerous");
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(engine.policy().askScope).toBe("dangerous");
  });

  it("hardline off needs confirmation; on does not", async () => {
    confirmAnswer = "denied";
    await run("/approvals hardline off");
    expect(engine.policy().hardline).toBe(true);
    confirmAnswer = "approved";
    await run("/approvals hardline off");
    expect(engine.policy().hardline).toBe(false);
    requestApproval.mockClear();
    await run("/approvals hardline on");
    expect(engine.policy().hardline).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("allow and deny patterns; broad allow patterns need --force and a confirmation", async () => {
    expect((await run("/approvals allow pnpm *")).text).toContain("Added to the allow list: pnpm *");
    expect((await run("/approvals allow pnpm *")).text).toContain("Already");
    expect((await run("/approvals allow bash *")).text).toContain("Refused");
    expect(engine.policy().allow).toEqual(["pnpm *"]);
    confirmAnswer = "denied";
    expect((await run("/approvals allow bash * --force")).text).toContain("Cancelled");
    confirmAnswer = "approved";
    expect((await run("/approvals allow \"sudo *\" --force")).text).toContain("Added");
    expect(engine.policy().allow).toEqual(["pnpm *", "sudo *"]);
    expect((await run("/approvals deny \"terraform destroy*\"")).text).toContain("blocked in every mode");
    expect(engine.policy().deny).toEqual(["terraform destroy*"]);
    expect((await run("/approvals allow Write(~/.ssh/**")).text).toContain("Not added");
  });

  it("list numbers config entries first and refuses to remove them", async () => {
    build({ allow: ["ls *"], deny: ["mkfs*"] });
    await run("/approvals allow pnpm *");
    await run("/approvals deny terraform *");
    const list = (await run("/approvals list")).text;
    expect(list).toContain("1. ls *   (config.yaml)");
    expect(list).toContain("2. pnpm *");
    expect((await run("/approvals unallow 1")).text).toContain("config.yaml");
    expect((await run("/approvals unallow 2")).text).toContain("Removed from the allow list: pnpm *");
    expect(engine.policy().allow).toEqual(["ls *"]);
    expect((await run("/approvals unallow nope")).text).toContain("Not on the allow list");
  });

  it("undeny is a loosening change and asks first", async () => {
    await run("/approvals deny terraform *");
    confirmAnswer = "denied";
    await run("/approvals undeny terraform *");
    expect(engine.policy().deny).toEqual(["terraform *"]);
    confirmAnswer = "approved";
    await run("/approvals undeny 1");
    expect(engine.policy().deny).toEqual([]);
  });

  it("reset drops every override after confirmation", async () => {
    await run("/approvals mode ask");
    await run("/approvals allow pnpm *");
    await run("/approvals deny terraform *");
    confirmAnswer = "approved";
    expect((await run("/approvals reset")).text).toContain("Reset. Mode yolo");
    expect(engine.policy()).toMatchObject({ mode: "yolo", allow: [], deny: [], hardline: true });
    expect(settings.keys("approvals")).toEqual([]);
  });

  it("test is a dry run that shows segments, findings and every decision", async () => {
    const r = (await run("/approvals test \"git push -f origin main\"")).text;
    expect(r).toContain("git.force-push");
    expect(r).toContain("Decision: yolo allow, ask ask, ask (scope all) ask");
    expect(r).toContain("Nothing was executed.");
    const h = (await run("/approvals test rm -rf \"$HOME\"")).text;
    expect(h).toContain("hard.rm-root");
    expect(h).toContain("yolo deny");
    const hidden = (await run("/approvals test echo hi​")).text;
    expect(hidden).toContain("⟨U+200B⟩");
  });

  it("rules lists the built-in ids", async () => {
    build({ disabledRules: ["git.destroy"] });
    const r = (await run("/approvals rules")).text;
    expect(r).toContain("hard.rm-root [hardline]");
    expect(r).toContain("git.destroy [disabled]");
  });

  it("log shows recent decisions without command text", async () => {
    audit.record({ feature: "approvals", action: "denied.hardline", actor: "agent:x", detail: { tool: "Bash", rules: ["hard.rm-root"], context: "chat telegram:dm" } });
    const r = (await run("/approvals log 5")).text;
    expect(r).toContain("denied.hardline Bash hard.rm-root (chat telegram:dm)");
  });

  it("writes settings as the owner and never config.yaml", async () => {
    await run("/approvals mode ask");
    expect(settings.describe("approvals.mode")?.setBy).toBe(`owner:telegram:${OWNER}`);
  });

  it("unknown subcommand shows usage", async () => {
    expect((await run("/approvals frobnicate")).text).toContain("Unknown subcommand");
  });
});
