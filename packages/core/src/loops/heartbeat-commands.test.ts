import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { splitCommandArgs } from "../commands/parse.js";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ProactiveEngineStatus } from "../engine/proactive.js";
import type { HeartbeatLogEntry } from "../mcp/tools/heartbeat-logs.js";
import {
  applyHeartbeatOverrides,
  createHeartbeatCommands,
  type HeartbeatCommandDeps,
  type HeartbeatEngineControl,
} from "./heartbeat-commands.js";
import { parseHeartbeatChecklist, renderHeartbeatChecklist, readHeartbeatChecklist } from "./heartbeat-checklist.js";

const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);
const OWNER = "1001";

/** A stand-in engine with the state /heartbeat reads and writes. */
function fakeEngine() {
  const state = { running: true, interval: 15, snoozedUntil: 0, lastTriageAt: T0 - 5 * 60_000, triageInProgress: false };
  const engine = {
    state,
    start: vi.fn(() => { state.running = true; }),
    stop: vi.fn(() => { state.running = false; }),
    get isRunning() { return state.running; },
    runTriage: vi.fn(async () => ({ signalsProcessed: 2, decisions: [{ action: "notify-now" }, { action: "silent" }, { action: "silent" }] })),
    setTier2IntervalMinutes: vi.fn((m: number) => { state.interval = m; }),
    snooze: vi.fn((until: number | null) => { state.snoozedUntil = until && until > Date.now() ? until : 0; }),
    status: vi.fn((): ProactiveEngineStatus => ({
      running: state.running, signalQueueSize: 1, lastTriageAt: state.lastTriageAt,
      nextTriageAt: state.lastTriageAt + state.interval * 60_000, digestQueueSize: 2, dedupCacheSize: 0,
      notifiedTypesCacheSize: 0, tier2IntervalMinutes: state.interval, snoozedUntil: state.snoozedUntil,
      triageInProgress: state.triageInProgress,
    })),
  };
  return engine;
}

describe("/heartbeat", () => {
  let dir: string;
  let settings: RuntimeSettings;
  let engine: ReturnType<typeof fakeEngine>;
  let checklistPath: string;
  let def: CommandDefinition;
  let replies: string[];
  let logs: HeartbeatLogEntry[];

  function build(over: Partial<HeartbeatCommandDeps> = {}): void {
    [def] = createHeartbeatCommands({
      proactive: engine as unknown as HeartbeatEngineControl,
      settings,
      config: { enabled: true, tier2IntervalMinutes: 15, maxChecklistBytes: 512, heartbeatFile: checklistPath },
      checklistPath,
      logs: { recent: (n: number) => logs.slice(0, n) },
      countActiveLoops: () => 2,
      countSchedules: () => 4,
      timezone: "UTC",
      ...over,
    }) as [CommandDefinition];
  }

  async function run(args: string): Promise<string> {
    const message = {
      id: "m1", channel: "telegram", senderId: OWNER, text: `/heartbeat ${args}`, chatType: "dm", chatId: OWNER, raw: {},
    } as unknown as UnifiedMessage;
    const ctx: CommandContext = {
      name: "heartbeat", args, argv: splitCommandArgs(args), message,
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as CommandContext["identity"],
      isOwner: true, sessionKey: `telegram:dm:${OWNER}`,
      reply: vi.fn(async (r) => { replies.push(typeof r === "string" ? r : r.text); }),
      confirm: vi.fn(async () => false),
    };
    const out = await def.handler(ctx);
    return typeof out === "string" ? out : out?.text ?? "";
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    dir = mkdtempSync(join(tmpdir(), "kirie-hbcmd-"));
    settings = new RuntimeSettings(join(dir, "state", "runtime-settings.json"));
    engine = fakeEngine();
    checklistPath = join(dir, "HEARTBEAT.md");
    replies = [];
    logs = [];
    build();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("is owner-only, DM-only, alias /hb, with the B.12 help line", () => {
    expect(def).toMatchObject({ name: "heartbeat", aliases: ["hb"], ownerOnly: true, scope: "dm", category: "automation" });
    expect(def.description).toBe("Control my background checks: status, on, off, every, now, show, add, remove, snooze, log, reset");
  });

  it("status shows state, interval, triage times, queues, snooze and counts", async () => {
    const out = await run("");
    expect(out).toContain("Heartbeat: running");
    expect(out).toContain("Triage every 15m");
    expect(out).toContain("Last triage: 23 Nov, 09:55 (5m ago)");
    expect(out).toContain("Next triage: 23 Nov, 10:10 (in 10m)");
    expect(out).toContain("Signals waiting: 1, digest queue: 2");
    expect(out).toContain("Snooze: off");
    expect(out).toContain("active loops: 2, schedules: 4");
  });

  it("off pauses detectors and triage, persists, and says the tick keeps running", async () => {
    const out = await run("off");
    expect(engine.stop).toHaveBeenCalled();
    expect(settings.get("proactive.enabled", (await import("zod/v3")).z.boolean())).toBe(false);
    expect(out).toContain("The 10-second tick that delivers schedules, retries and loops keeps running.");
    expect(await run("")).toContain("Heartbeat: paused");
  });

  it("on starts the engine and persists, with no restart note", async () => {
    engine.state.running = false;
    const out = await run("on");
    expect(engine.start).toHaveBeenCalled();
    expect(out).not.toMatch(/restart \(\/restart\)|proactive_status/);
    // Persisted in a fresh reader (what lifecycle reads at the next boot)
    const reread = new RuntimeSettings(settings.path, { readonly: true });
    expect(reread.get("proactive.enabled", (await import("zod/v3")).z.boolean())).toBe(true);
  });

  it("every sets the interval in 5m..24h, persists it, and points extra words to /loop", async () => {
    expect(await run("every 30m")).toBe("Triage now runs every 30m. Next triage: 23 Nov, 10:25 (in 25m).");
    expect(engine.setTier2IntervalMinutes).toHaveBeenLastCalledWith(30);
    expect(settings.keys("proactive")).toContain("proactive.tier2IntervalMinutes");
    expect(await run("every 4m")).toBe("The triage interval must be between 5m and 24h.");
    expect(await run("every 25h")).toBe("The triage interval must be between 5m and 24h.");
    expect(await run("every soon")).toMatch(/could not read/);
    expect(await run("every 10m check my email")).toMatch(/use \/loop <interval> <prompt>/);
    expect(engine.setTier2IntervalMinutes).toHaveBeenCalledTimes(1);
  });

  it("now runs a triage and reports the decisions; refuses while paused", async () => {
    expect(await run("now")).toBe("Triage done: 2 signals checked, 3 decisions (notify-now 1, silent 2).");
    expect(replies).toEqual(["Running a triage cycle now…"]);
    engine.state.running = false;
    expect(await run("now")).toMatch(/paused/);
    expect(engine.runTriage).toHaveBeenCalledTimes(1);
  });

  it("snooze sets and clears a persisted hold", async () => {
    const out = await run("snooze 2h");
    expect(out).toMatch(/^Snoozed until 23 Nov, 12:00 \(2h\)/);
    expect(engine.snooze).toHaveBeenLastCalledWith(T0 + 2 * 3_600_000);
    expect(settings.keys("proactive")).toContain("proactive.snoozedUntil");
    expect(await run("snooze 10d")).toMatch(/1m to 7d/);
    expect(await run("snooze off")).toMatch(/^Snooze off/);
    expect(engine.snooze).toHaveBeenLastCalledWith(null);
    expect(settings.keys("proactive")).not.toContain("proactive.snoozedUntil");
  });

  it("reset drops every override and returns to the config values", async () => {
    await run("off");
    await run("every 1h");
    await run("snooze 1h");
    const out = await run("reset");
    expect(settings.keys("proactive")).toEqual([]);
    expect(engine.state).toMatchObject({ running: true, interval: 15, snoozedUntil: 0 });
    expect(out).toContain("Back to the config: on, triage every 15m, no snooze.");
  });

  it("persisted overrides are applied at the next start", async () => {
    await run("every 45m");
    await run("snooze 3h");
    const next = fakeEngine();
    applyHeartbeatOverrides(next, new RuntimeSettings(settings.path, { readonly: true }), Date.now());
    expect(next.setTier2IntervalMinutes).toHaveBeenCalledWith(45);
    expect(next.snooze).toHaveBeenCalledWith(T0 + 3 * 3_600_000);
    // An expired snooze is not re-applied
    const later = fakeEngine();
    applyHeartbeatOverrides(later, settings, T0 + 4 * 3_600_000);
    expect(later.snooze).not.toHaveBeenCalled();
  });

  it("without an owner identity every engine action explains why", async () => {
    build({ proactive: null });
    for (const sub of ["", "on", "off", "every 30m", "now"]) {
      expect(await run(sub)).toMatch(/no owner identity is configured/);
    }
  });

  it("log shows the last n entries (default 10, max 30)", async () => {
    expect(await run("log")).toBe("No heartbeat log entries yet.");
    logs = Array.from({ length: 40 }, (_, i) => ({
      id: i, tick_number: i, tier: "tier1", category: "signal", level: "info", title: `signal ${i}`,
      content: "", metadata: null, duration_ms: null, created_at: "2026-11-23 10:00:00",
    })) as HeartbeatLogEntry[];
    expect((await run("log")).split("\n")).toHaveLength(11);
    expect((await run("log 3")).split("\n")).toEqual([
      "Last 3 heartbeat log entries:",
      "2026-11-23 10:00:00 tier1 info signal: signal 0",
      "2026-11-23 10:00:00 tier1 info signal: signal 1",
      "2026-11-23 10:00:00 tier1 info signal: signal 2",
    ]);
    expect(await run("log 31")).toMatch(/^Usage/);
    build({ logs: null });
    expect(await run("log")).toMatch(/logging is off/);
  });

  it("an unknown option shows the usage", async () => {
    expect(await run("bogus")).toMatch(/^Unknown \/heartbeat option "bogus"/);
  });

  describe("checklist", () => {
    it("show, add and remove with numbering, a .bak, and 0600 files", async () => {
      expect(await run("show")).toBe("The checklist is empty. Add an item with /heartbeat add <text>.");
      const initial = "# Heartbeat\n\n- check disk space\n- [ ] check backups\n\n```\n- not an item\n```\n";
      writeFileSync(checklistPath, initial);
      expect(await run("show")).toBe([
        `Checklist (2 items, ${Buffer.byteLength(initial)} of 512 bytes):`,
        "# Heartbeat",
        "",
        "1. check disk space",
        "2. check backups",
        "",
        "```",
        "- not an item",
        "```",
      ].join("\n"));

      expect(await run("add make sure the nightly\nbuild passed")).toBe("Added item 3: make sure the nightly build passed\nThe next triage reads it.");
      expect(readFileSync(checklistPath, "utf-8")).toBe(
        "# Heartbeat\n\n- check disk space\n- [ ] check backups\n\n```\n- not an item\n```\n\n## Owner Added\n\n- make sure the nightly build passed\n",
      );
      expect(readFileSync(`${checklistPath}.bak`, "utf-8")).toContain("check backups\n\n```");
      expect(statSync(checklistPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${checklistPath}.bak`).mode & 0o777).toBe(0o600);

      expect(await run("add second owner item")).toBe("Added item 4: second owner item\nThe next triage reads it.");
      expect(readFileSync(checklistPath, "utf-8")).toMatch(/## Owner Added\n\n- make sure the nightly build passed\n- second owner item\n$/);

      expect(await run("remove 1")).toBe("Removed item 1: check disk space");
      expect(parseHeartbeatChecklist(readFileSync(checklistPath, "utf-8")).map((i) => i.text)).toEqual([
        "check backups", "make sure the nightly build passed", "second owner item",
      ]);
      expect(readFileSync(`${checklistPath}.bak`, "utf-8")).toContain("- check disk space");
      expect(await run("remove 9")).toBe("No item 9. The checklist has 3 items.");
      expect(await run("remove x")).toMatch(/^Usage/);
      // No temp files are left behind
      expect(existsSync(checklistPath)).toBe(true);
    });

    it("caps each item at 300 characters and the file at maxChecklistBytes", async () => {
      expect(await run(`add ${"a".repeat(301)}`)).toMatch(/at most 300 characters/);
      expect(await run("add")).toMatch(/Say what to add/);
      writeFileSync(checklistPath, `- ${"b".repeat(400)}\n`);
      expect(await run(`add ${"c".repeat(150)}`)).toMatch(/over the 512-byte cap/);
      expect(readFileSync(checklistPath, "utf-8")).toBe(`- ${"b".repeat(400)}\n`);
    });

    it("creates the file with the Owner Added section when it does not exist", async () => {
      expect(await run("add check the certs")).toBe("Added item 1: check the certs\nThe next triage reads it.");
      expect(readFileSync(checklistPath, "utf-8")).toBe("## Owner Added\n\n- check the certs\n");
      expect(existsSync(`${checklistPath}.bak`)).toBe(false);
    });

    it("render cuts a long file", () => {
      writeFileSync(checklistPath, Array.from({ length: 100 }, (_, i) => `- item ${i} ${"x".repeat(40)}`).join("\n"));
      expect(renderHeartbeatChecklist(readHeartbeatChecklist(checklistPath), 500)).toMatch(/… \(cut; the file is \d+ bytes\)$/);
    });
  });
});
