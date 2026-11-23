import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { LoopStore } from "../../loops/loop-store.js";
import { LOOPS_TOOLS_CONFIG_ENV } from "../../loops/loop-service.js";
import { createLoopsTools } from "./loops-tools.js";
import type { McpToolDefinition } from "../server.js";

const SESSION = "telegram:dm:1001";

describe("loop tools", () => {
  let dir: string;
  let tools: Record<string, McpToolDefinition>;

  function build(config: Record<string, unknown> = {}): void {
    tools = createLoopsTools({ dbDir: dir, env: { [LOOPS_TOOLS_CONFIG_ENV]: JSON.stringify(config) } });
  }

  function setOverride(on: boolean): void {
    new RuntimeSettings(join(dir, "state", "runtime-settings.json")).set("loops.enabled", on, "owner:telegram:1001");
  }

  async function call(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await tools[name]!.handler(params)) as Record<string, unknown>;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-looptools-"));
    build();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers exactly loop_create, loop_list, loop_stop and touches nothing when built", () => {
    expect(Object.keys(tools).sort()).toEqual(["loop_create", "loop_list", "loop_stop"]);
    expect(existsSync(join(dir, "loops.db"))).toBe(false);
  });

  it("loop_create errors while loops are off (config default) and creates nothing", async () => {
    const res = await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "watch it" });
    expect(res).toEqual({ created: false, error: "Loops are off. The owner can turn them on with /loop on." });
    expect(existsSync(join(dir, "loops.db"))).toBe(false);
  });

  it("loop_create only files a pending_approval row once the owner turned loops on", async () => {
    setOverride(true);
    const res = await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "watch the deploy" });
    expect(res).toMatchObject({ created: true, status: "pending_approval" });
    expect(String(res.note)).toMatch(/asked to Start or Decline/);
    const store = new LoopStore(join(dir, "loops.db"));
    const loop = store.get(String(res.id))!;
    store.close();
    expect(loop).toMatchObject({
      status: "pending_approval", createdBy: "agent", sessionKey: SESSION, channel: "telegram", chatId: "1001",
      baseIntervalSec: 300, maxRuns: 100, backoff: true,
    });
    const audit = readFileSync(join(dir, "logs", "audit.jsonl"), "utf-8");
    expect(audit).toContain('"action":"loop.proposed"');
  });

  it("the runtime override wins over the config value, both ways", async () => {
    build({ enabled: true });
    setOverride(false);
    expect(await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "x" })).toMatchObject({ created: false });
    setOverride(true);
    expect(await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "x" })).toMatchObject({ created: true });
  });

  it("loop_create validates the request and the agent's caps", async () => {
    setOverride(true);
    const base = { sessionKey: SESSION, intervalSeconds: 300, prompt: "x" };
    expect(await call("loop_create", { ...base, sessionKey: "nonsense" })).toMatchObject({ created: false, error: expect.stringMatching(/session key/) });
    expect(await call("loop_create", { ...base, sessionKey: "telegram:group:-100" })).toMatchObject({ error: "Loops run only in the owner's DM." });
    expect(await call("loop_create", { ...base, prompt: "  " })).toMatchObject({ error: "prompt is required." });
    expect(await call("loop_create", { ...base, intervalSeconds: 10 })).toMatchObject({ error: expect.stringMatching(/at least 1m/) });
    expect(await call("loop_create", { ...base, maxRuns: 101 })).toMatchObject({ error: expect.stringMatching(/between 1 and 100/) });
    expect(await call("loop_create", { ...base, expiryHours: 73 })).toMatchObject({ error: expect.stringMatching(/72h/) });
    expect(await call("loop_create", { ...base, intervalSeconds: "abc" })).toMatchObject({ created: false });
  });

  it("agentCreate deny refuses; too many pending requests are refused", async () => {
    setOverride(true);
    build({ agentCreate: "deny" });
    expect(await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "x" })).toMatchObject({
      created: false, error: expect.stringMatching(/agentCreate: deny/),
    });
    build({ maxActive: 2 });
    await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "a" });
    await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "b" });
    expect(await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "c" })).toMatchObject({
      created: false, error: expect.stringMatching(/waiting for the owner/),
    });
  });

  it("loop_list lists live loops, filtered by session; ended ones only on request", async () => {
    setOverride(true);
    const a = await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "a" });
    await call("loop_create", { sessionKey: "telegram:dm:42", intervalSeconds: 300, prompt: "b" });
    await call("loop_stop", { id: a.id });
    const live = await call("loop_list", {});
    expect((live.loops as unknown[]).length).toBe(1);
    expect(live.enabled).toBe(true);
    const all = await call("loop_list", { includeEnded: true, sessionKey: SESSION });
    expect(all.loops).toEqual([expect.objectContaining({ id: a.id, status: "cancelled", endedReason: "agent" })]);
  });

  it("loop_stop always works on a live loop, and only once", async () => {
    setOverride(true);
    const a = await call("loop_create", { sessionKey: SESSION, intervalSeconds: 300, prompt: "a" });
    setOverride(false); // stop is allowed even while loops are off
    expect(await call("loop_stop", { id: a.id })).toMatchObject({ stopped: true, id: a.id });
    expect(await call("loop_stop", { id: a.id })).toMatchObject({ stopped: false, error: expect.stringMatching(/already ended/) });
    expect(await call("loop_stop", { id: "l-zzzzz" })).toMatchObject({ stopped: false, error: "No loop l-zzzzz." });
    expect(await call("loop_stop", { id: "drop table" })).toMatchObject({ stopped: false });
  });
});
