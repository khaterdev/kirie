import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopsConfigSchema, type LoopsConfig } from "../config/sections/loops.js";
import { splitCommandArgs } from "../commands/parse.js";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import { LoopStore } from "./loop-store.js";
import { createLoopCommands, parseLoopStartArgs } from "./commands.js";

const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);
const OWNER = "1001";

describe("/loop", () => {
  let dir: string;
  let store: LoopStore;
  let cfg: LoopsConfig;
  let enabled: boolean;
  let setEnabled: ReturnType<typeof vi.fn>;
  let service: { reload: ReturnType<typeof vi.fn>; runNow: ReturnType<typeof vi.fn> };
  let audit: ReturnType<typeof vi.fn>;
  let def: CommandDefinition;

  async function run(args: string): Promise<string> {
    const message = {
      id: "m1", channel: "telegram", senderId: OWNER, senderName: "Owner", text: `/loop ${args}`,
      chatType: "dm", chatId: OWNER, raw: {},
    } as unknown as UnifiedMessage;
    const ctx: CommandContext = {
      name: "loop",
      args,
      argv: splitCommandArgs(args),
      message,
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as CommandContext["identity"],
      isOwner: true,
      sessionKey: `telegram:dm:${OWNER}`,
      reply: vi.fn(async () => {}),
      confirm: vi.fn(async () => false),
    };
    const out = await def.handler(ctx);
    return typeof out === "string" ? out : out?.text ?? "";
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    dir = mkdtempSync(join(tmpdir(), "kirie-loopcmd-"));
    store = new LoopStore(join(dir, "loops.db"));
    cfg = LoopsConfigSchema.parse({});
    enabled = true;
    setEnabled = vi.fn((on: boolean) => { enabled = on; });
    service = { reload: vi.fn(), runNow: vi.fn(() => ({ ok: true })) };
    audit = vi.fn();
    [def] = createLoopCommands({
      store,
      service,
      config: () => cfg,
      isEnabled: () => enabled,
      setEnabled,
      audit,
    }) as [CommandDefinition];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("is owner-only, DM-only, in automation, with the B.12 help line", () => {
    expect(def).toMatchObject({ name: "loop", ownerOnly: true, scope: "dm", category: "automation" });
    expect(def.description).toBe("Re-run a prompt in this chat on an interval, quiet unless something changed: start, list, pause, resume, stop, now, on, off");
  });

  it("starts a loop in this chat with the defaults; the first run is due now", async () => {
    const out = await run("5m check the deploy of api-gateway");
    expect(out).toMatch(/^Started loop l-[a-z2-7]{5}: every 5m, up to 100 runs, for 3d\./);
    const [loop] = store.list();
    expect(loop).toMatchObject({
      sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", chatId: OWNER, chatType: "dm",
      prompt: "check the deploy of api-gateway", baseIntervalSec: 300, backoff: true, maxRuns: 100,
      status: "active", createdBy: "owner", nextRunAt: T0, expiresAt: T0 + 72 * 3_600_000,
    });
    expect(service.reload).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith("loop.created", `owner:telegram:${OWNER}`, expect.objectContaining({ id: loop!.id }), expect.any(Object));
  });

  it("reads --times, --for and --no-backoff anywhere in the text", async () => {
    await run("90s --times 5 watch the queue depth --for 2h --no-backoff");
    const [loop] = store.list();
    expect(loop).toMatchObject({ prompt: "watch the queue depth", baseIntervalSec: 90, maxRuns: 5, backoff: false, expiresAt: T0 + 2 * 3_600_000 });
  });

  it("while off, a start replies how to turn loops on and starts nothing", async () => {
    enabled = false;
    expect(await run("5m check")).toBe("Loops are off. Turn them on with /loop on, then send this again.");
    expect(store.list()).toHaveLength(0);
  });

  it("enforces the interval bounds and argument ranges", async () => {
    expect(await run("30s check")).toMatch(/at least 1m/);
    expect(await run("2d check")).toMatch(/at most 1d/);
    expect(await run("soon check")).toMatch(/could not read "soon"/);
    expect(await run("5m")).toMatch(/Say what to check/);
    expect(await run("5m check --times 0")).toMatch(/--times must be/);
    expect(await run("5m check --times 20000")).toMatch(/--times must be/);
    expect(await run("5m check --for 31d")).toMatch(/between 1m and 720h/);
    expect(await run(`5m ${"x".repeat(2001)}`)).toMatch(/at most 2000 characters/);
    expect(store.list()).toHaveLength(0);
  });

  it("enforces maxActive", async () => {
    cfg = { ...cfg, maxActive: 2 };
    await run("5m one");
    await run("5m two");
    expect(await run("5m three")).toMatch(/2 loops are already active/);
    expect(store.count("active")).toBe(2);
  });

  it("lists loops with id, interval, runs and next run", async () => {
    expect(await run("")).toBe("Loops are on.\nNo loops. Start one with /loop 5m <what to check>.");
    await run("5m check the deploy");
    const [loop] = store.list();
    store.update(loop!.id, { currentIntervalSec: 600, runs: 3, nextRunAt: T0 + 600_000 });
    const out = await run("list");
    expect(out).toContain("Loops are on. 1 loop:");
    expect(out).toContain(`${loop!.id} active · every 5m (now 10m) · run 3/100 · next in 10m · ends in 3d`);
    expect(out).toContain('"check the deploy"');
  });

  it("pause, resume, stop and stop all", async () => {
    await run("5m one");
    await run("5m two");
    const [b, a] = store.list();
    expect(await run(`pause ${a!.id}`)).toBe(`Paused loop ${a!.id}. /loop resume ${a!.id} continues it.`);
    expect(store.get(a!.id)).toMatchObject({ status: "paused", pauseReason: "owner" });
    expect(await run(`pause ${a!.id}`)).toMatch(/is paused, not active/);
    store.update(a!.id, { errorStreak: 2 });
    expect(await run(`resume ${a!.id}`)).toMatch(/^Resumed loop/);
    expect(store.get(a!.id)).toMatchObject({ status: "active", pauseReason: null, errorStreak: 0, nextRunAt: T0 });
    expect(await run(`stop ${a!.id}`)).toBe(`Stopped loop ${a!.id} after 0 runs.`);
    expect(store.get(a!.id)).toMatchObject({ status: "cancelled", endedReason: "owner" });
    expect(await run(`stop ${a!.id}`)).toMatch(/already ended/);
    expect(await run("stop all")).toBe(`Stopped 1 loop: ${b!.id}.`);
    expect(await run("stop all")).toBe("No loops to stop.");
    expect(await run("pause nope")).toMatch(/^Usage/);
    expect(await run("stop l-zzzzz")).toBe("No loop l-zzzzz.");
  });

  it("resume respects maxActive and the off switch", async () => {
    cfg = { ...cfg, maxActive: 1 };
    await run("5m one");
    const [a] = store.list();
    await run(`pause ${a!.id}`);
    await run("5m two");
    expect(await run(`resume ${a!.id}`)).toMatch(/1 loops are already active/);
    enabled = false;
    expect(await run(`resume ${a!.id}`)).toMatch(/Loops are off/);
  });

  it("/loop off persists the switch and pauses active loops; /loop on resumes those", async () => {
    await run("5m one");
    await run("5m two");
    const [b, a] = store.list();
    await run(`pause ${a!.id}`);
    const off = await run("off");
    expect(setEnabled).toHaveBeenLastCalledWith(false, `owner:telegram:${OWNER}`);
    expect(off).toBe("Loops are off. Paused 1 loop; /loop on resumes them.");
    expect(store.get(b!.id)).toMatchObject({ status: "paused", pauseReason: "disabled" });
    const on = await run("on");
    expect(setEnabled).toHaveBeenLastCalledWith(true, `owner:telegram:${OWNER}`);
    expect(on).toContain(`Resumed 1 loop paused by /loop off: ${b!.id}.`);
    expect(store.get(b!.id)).toMatchObject({ status: "active", pauseReason: null });
    // The owner's own pause is kept
    expect(store.get(a!.id)).toMatchObject({ status: "paused", pauseReason: "owner" });
  });

  it("/loop now runs through the service and maps refusals", async () => {
    await run("5m one");
    const [a] = store.list();
    expect(await run(`now ${a!.id}`)).toBe(`Running loop ${a!.id} now.`);
    expect(service.runNow).toHaveBeenCalledWith(a!.id);
    service.runNow.mockReturnValueOnce({ ok: false, reason: "busy" });
    expect(await run(`now ${a!.id}`)).toMatch(/busy/);
    service.runNow.mockReturnValueOnce({ ok: false, reason: "disabled" });
    expect(await run(`now ${a!.id}`)).toMatch(/Loops are off/);
  });
});

describe("parseLoopStartArgs", () => {
  it("keeps the prompt text as typed", () => {
    expect(parseLoopStartArgs(`1h30m tell me if "prod" is down --times 3`)).toEqual({
      interval: "1h30m", prompt: `tell me if "prod" is down`, times: "3", noBackoff: false,
    });
    expect(parseLoopStartArgs("5m")).toEqual({ interval: "5m", prompt: "", noBackoff: false });
    expect(parseLoopStartArgs("5m x --for=2h --no-backoff")).toEqual({ interval: "5m", prompt: "x", forText: "2h", noBackoff: true });
  });
});
