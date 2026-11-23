import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { AuditTrail } from "../security/audit-trail.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { ComputerUseConfigSchema } from "../config/sections/computer-use.js";
import { createComputerUseCommands } from "./commands.js";
import { ComputerUseService } from "./service.js";
import type { ComputerUseExecFn } from "./driver.js";

const OWNER = "1001";
const STRANGER = "2002";
const HOME = "/Users/tester";
const DRIVER = `${HOME}/.local/bin/cua-driver`;

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return { id: "10", channel: "telegram" as ChannelName, senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over } as UnifiedMessage;
}

function exec(perms: Record<string, unknown> = { accessibility: true, screen_recording: true, attribution: "driver-daemon" }): ComputerUseExecFn {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    if (key.startsWith("/usr/bin/codesign -dv")) return { code: 0, stdout: "", stderr: "Identifier=com.trycua.driver\nTeamIdentifier=ABCDE12345\n" };
    if (key === `${DRIVER} permissions status --json`) return { code: 0, stdout: JSON.stringify(perms), stderr: "" };
    if (key === `${DRIVER} --version`) return { code: 0, stdout: "cua-driver 0.59.2", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("/computer", () => {
  let dir: string;
  let audit: AuditTrail;
  let registry: CommandRegistry;
  let service: ComputerUseService;
  let confirmAnswer: "approved" | "denied";
  let requestApproval: ReturnType<typeof vi.fn>;
  let refreshSession: ReturnType<typeof vi.fn>;
  let installed: boolean;
  let execCalls: string[];

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

  function build(config: Record<string, unknown> = { enabled: true }, perms?: Record<string, unknown>): void {
    const e = exec(perms);
    service = new ComputerUseService({
      config: ComputerUseConfigSchema.parse(config),
      driver: { exec: async (f, a, o) => { execCalls.push(`${f} ${a.join(" ")}`); return e(f, a, o); }, isExecutable: (p) => installed && p === DRIVER, homeDir: HOME },
      originOf: () => "owner_message",
      isDangerousText: () => false,
      audit,
    });
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }), prompts: { requestApproval } as never, audit });
    registry.registerAll(createComputerUseCommands({ service, refreshSession }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-cu-cmd-"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    confirmAnswer = "approved";
    installed = true;
    execCalls = [];
    requestApproval = vi.fn(async () => ({ outcome: confirmAnswer, optionId: confirmAnswer === "approved" ? "approve" : "deny", code: "K7Q2" }));
    refreshSession = vi.fn();
    build();
  });

  afterEach(() => {
    void service.disarm("shutdown");
    rmSync(dir, { recursive: true, force: true });
  });

  it("is owner-only, DM-only, category media, and never runs from synthetic text", async () => {
    expect((await run("/computer on", { senderId: STRANGER, chatId: STRANGER })).kind).toBe("denied");
    expect((await run("/computer off", { senderId: STRANGER, chatId: STRANGER })).kind).toBe("denied");
    expect((await run("/computer on", { chatType: "group", chatId: "-100" })).kind).toBe("denied");
    const def = registry.get("computer")!;
    expect(def).toMatchObject({ ownerOnly: true, scope: "dm", category: "media" });
    const synthetic = await registry.dispatch({
      message: msg("/computer on 60"),
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "synthetic",
      send: async () => {},
    });
    expect(synthetic.kind).toBe("not-command");
    expect(service.arming.isArmed()).toBe(false);
  });

  it("on with the config flag off explains how to enable it, and arms nothing", async () => {
    build({ enabled: false });
    const r = await run("/computer on 10 Notes");
    expect(r.text).toMatch(/off in config/);
    expect(r.text).toMatch(/computerUse\.enabled: true/);
    expect(r.text).toMatch(/\/computer off still works/);
    expect(service.arming.isArmed()).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("on when the driver is not installed reports it with setup steps and never installs", async () => {
    installed = false;
    const r = await run("/computer on");
    expect(r.text).toMatch(/not installed/);
    expect(r.text).toMatch(/Kirie never installs it/);
    expect(r.text).toMatch(/computer-use-setup\.md/);
    expect(service.arming.isArmed()).toBe(false);
    expect(execCalls).toEqual([]);
  });

  it("on with missing macOS grants lists the problems", async () => {
    build({ enabled: true }, { accessibility: false, screen_recording: true, attribution: "driver-daemon" });
    const r = await run("/computer on 5");
    expect(r.text).toMatch(/cannot be armed/);
    expect(r.text).toMatch(/Accessibility is not granted/);
    expect(service.arming.isArmed()).toBe(false);
  });

  it("on asks for confirmation showing the limits; cancel arms nothing", async () => {
    confirmAnswer = "denied";
    const r = await run("/computer on 10 Notes");
    expect(r.text).toMatch(/not armed/);
    expect(service.arming.isArmed()).toBe(false);
    const body = requestApproval.mock.calls[0]![0].body as string;
    expect(body).toMatch(/Screenshots cannot be scrubbed/);
    expect(body).toMatch(/kill switch and a tripwire/);
  });

  it("on 10 Notes Finder arms for 10 minutes scoped to those apps and refreshes the session", async () => {
    const r = await run("/computer on 10 Notes Finder");
    expect(r.kind).toBe("handled");
    expect(r.text).toMatch(/Armed for 10 min, apps: Notes, Finder/);
    expect(r.text).toMatch(/first action in each app asks you first/);
    expect(service.arming.state()).toMatchObject({ armed: true, apps: ["Notes", "Finder"], armedBy: `owner:telegram:${OWNER}` });
    expect(service.arming.minutesLeft()).toBe(10);
    expect(refreshSession).toHaveBeenCalledWith(`telegram:dm:${OWNER}`);
  });

  it("on 999 is capped at maxArmMinutes; on with no minutes uses armMinutes", async () => {
    const capped = await run("/computer on 999");
    expect(capped.text).toMatch(/Armed for 60 min \(capped/);
    expect(service.arming.minutesLeft()).toBe(60);
    const dflt = await run("/computer on");
    expect(dflt.text).toMatch(/Armed for 15 min, apps: any app not denied/);
  });

  it("off disarms, clears grants and stops the driver; works with the config flag off", async () => {
    await run("/computer on 10");
    service.arming.grant("computer:act:com.apple.Notes", service.arming.epoch());
    const r = await run("/computer off");
    expect(r.text).toMatch(/Computer use is off\. Grants cleared/);
    expect(r.text).toMatch(/driver was stopped/);
    expect(service.arming.isArmed()).toBe(false);
    expect(service.arming.grants().size).toBe(0);
    expect(execCalls).toContain(`${DRIVER} stop`);

    build({ enabled: false });
    execCalls = [];
    const off = await run("/computer off");
    expect(off.kind).toBe("handled");
    expect(off.text).toMatch(/was not armed; it is off/);
    expect(execCalls.filter((c) => c.startsWith(DRIVER))).toEqual([`${DRIVER} stop`]);
  });

  it("on from a voice call is refused", async () => {
    const r = await run("/computer on 10", { channel: "voice" as ChannelName });
    expect(service.arming.isArmed()).toBe(false);
    expect(r.text).not.toMatch(/Armed for/);
  });

  it("status renders the probe, its problems and the arming state", async () => {
    build({ enabled: true }, { accessibility: true, screen_recording: false });
    const r = await run("/computer status");
    expect(r.text).toMatch(/enabled in config/);
    expect(r.text).toMatch(/Armed: no/);
    expect(r.text).toMatch(/Driver: installed \(cua-driver 0\.59\.2\)/);
    expect(r.text).toMatch(/Screen Recording: no/);
    expect(r.text).toMatch(/Problem: Screen Recording is not granted/);
    expect(r.text).toMatch(/Note: .*attribution/);
  });

  it("status with the flag off runs no driver command and says how to turn it on", async () => {
    build({ enabled: false });
    const r = await run("/computer");
    expect(r.text).toMatch(/off in config/);
    expect(r.text).toMatch(/To turn it on/);
    expect(execCalls).toEqual([]);
  });

  it("help states the limits", async () => {
    const r = await run("/computer help");
    expect(r.text).toMatch(/Screenshots cannot be scrubbed/);
    expect(r.text).toMatch(/not a sandbox/);
    expect(r.text).toMatch(/never installs the driver/);
  });
});
