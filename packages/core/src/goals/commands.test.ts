import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandRegistry, COMMAND_OWNER_ONLY_TEXT } from "../commands/registry.js";
import { OwnerDirectory } from "../interaction/owners.js";
import type { CommandReply } from "../commands/types.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { GoalsConfigSchema, type GoalsConfig } from "../config/sections/goals.js";
import { GoalStore } from "./goal-store.js";
import type { BackgroundTask } from "../engine/background-task-store.js";
import { GoalController, type GoalControllerDeps } from "./goal-controller.js";
import { createGoalCommands, parseGoalStartText, resolveGoalCwd, GOAL_OFF_TEXT } from "./commands.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, senderId = OWNER): UnifiedMessage {
  return {
    id: "10", channel: "telegram" as ChannelName, senderId, senderName: "x",
    text, chatType: "dm", chatId: senderId, timestamp: Date.now(), raw: null,
  } as UnifiedMessage;
}

describe("parseGoalStartText", () => {
  it("parses text and every flag", () => {
    const r = parseGoalStartText(
      `fix the tests --check "pnpm vitest run" --check="pnpm lint" --rounds 8 --time 1h30m --budget $5 --cwd /tmp`,
      { maxChecks: 5 },
    );
    expect(r).toEqual({ text: "fix the tests", checks: ["pnpm vitest run", "pnpm lint"], rounds: 8, minutes: 90, budgetUsd: 5, cwd: "/tmp" });
  });

  it("accepts bare minutes for --time", () => {
    expect(parseGoalStartText("x --time 45", { maxChecks: 5 })).toMatchObject({ minutes: 45 });
  });

  it.each([
    ["x --rounds 0", "--rounds must be"],
    ["x --rounds 101", "--rounds must be"],
    ["x --time 25h", "--time must be"],
    ["x --budget abc", "--budget must be"],
    ["x --budget 5000", "--budget must be"],
    ["x --check", "needs a value"],
    [`x --check "  "`, "needs a command"],
    ["x --check \"a\nb\"", "one line"],
    ["x --frobnicate 1", "Unknown option"],
    ["--rounds 3", "Say what the goal is"],
  ])("rejects %j", (raw, msgPart) => {
    const r = parseGoalStartText(raw, { maxChecks: 5 });
    expect("error" in r && r.error).toContain(msgPart);
  });

  it("limits the number of checks", () => {
    const r = parseGoalStartText("x --check a --check b", { maxChecks: 1 });
    expect("error" in r && r.error).toContain("At most 1");
  });

  // RUNTIME-B1 / GOAL-B1: shell quoting rules on prose hid or mangled the flags.
  it.each([
    [
      `fix the user's login bug --check "pnpm vitest run packages/core" --rounds 3 --budget 2`,
      { text: "fix the user's login bug", checks: ["pnpm vitest run packages/core"], rounds: 3, budgetUsd: 2 },
    ],
    [
      `don't stop until the auth tests pass --check "pnpm vitest run packages/core" --rounds 3 --budget 2`,
      { text: "don't stop until the auth tests pass", checks: ["pnpm vitest run packages/core"], rounds: 3, budgetUsd: 2 },
    ],
    [`fix auth --check “pnpm vitest run” --rounds 3`, { text: "fix auth", checks: ["pnpm vitest run"], rounds: 3 }],
    [`fix auth --check ‘pnpm vitest run’ --time 90m`, { text: "fix auth", checks: ["pnpm vitest run"], minutes: 90 }],
    [`don’t break the user’s login --check "pnpm test" --budget 2`, { text: "don’t break the user’s login", checks: ["pnpm test"], budgetUsd: 2 }],
    [`the “auth” tests --check “pnpm test” --rounds 4`, { text: "the “auth” tests", checks: ["pnpm test"], rounds: 4 }],
    [`it's done when 'ok' prints --check "grep -q 'ok' out.txt" --rounds 2`, { text: "it's done when 'ok' prints", checks: ["grep -q 'ok' out.txt"], rounds: 2 }],
    [`fix it --check 'test "$(cat v)" = 1' --rounds 2`, { text: "fix it", checks: ['test "$(cat v)" = 1'], rounds: 2 }],
    [`fix it --check “grep "ok" out.txt” --rounds 2`, { text: "fix it", checks: ['grep "ok" out.txt'], rounds: 2 }],
    [`fix it --check "grep -E 'a\\|b' f" --budget 1`, { text: "fix it", checks: ["grep -E 'a\\|b' f"], budgetUsd: 1 }],
    [`back\\slash \\ text --rounds 2`, { text: "back\\slash \\ text", checks: [], rounds: 2 }],
    [`don't stop —check “pnpm test” —rounds 3 —budget 2`, { text: "don't stop", checks: ["pnpm test"], rounds: 3, budgetUsd: 2 }],
    [`"fix the --verbose flag" --rounds 2`, { text: "fix the --verbose flag", checks: [], rounds: 2 }],
    [`wait — the deploy is broken —check “make check”`, { text: "wait — the deploy is broken", checks: ["make check"] }],
  ])("keeps every flag with quotes in the text: %s", (raw, want) => {
    expect(parseGoalStartText(raw, { maxChecks: 5 })).toEqual(want);
  });

  it.each([
    [`fix auth --check pnpm vitest run --rounds 3`, "Unexpected text after --check pnpm"],
    [`fix auth --check "pnpm vitest run --rounds 3`, "not closed"],
    [`fix auth --check “pnpm vitest run --rounds 3`, "not closed"],
    [`fix auth --rounds 3 and also lint`, "Unexpected text after --rounds 3"],
    [`fix the --verbose output`, "Unknown option --verbose"],
    [`--rounds 3 fix the bug`, "Unexpected text"],
    [`fix it --rounds 3 --rounds 5`, "given twice"],
    [`fix it --check`, "needs a value"],
    [`fix it --check --rounds 3`, "needs a value"],
  ])("refuses flag text it cannot read one way only: %s", (raw, msgPart) => {
    const r = parseGoalStartText(raw, { maxChecks: 5 });
    expect("error" in r).toBe(true);
    expect("error" in r && r.error).toContain(msgPart);
  });
});

describe("resolveGoalCwd", () => {
  it("requires an absolute existing directory", () => {
    expect(resolveGoalCwd("relative/path")).toMatchObject({ error: expect.stringContaining("absolute") });
    expect(resolveGoalCwd("/definitely/not/here")).toMatchObject({ error: expect.stringContaining("not a directory") });
    expect(resolveGoalCwd(tmpdir())).toBe(tmpdir());
  });
});

describe("/goal", () => {
  let dir: string;
  let store: GoalStore;
  let cfg: GoalsConfig;
  let enabled: boolean;
  let registry: CommandRegistry;
  let controller: GoalController;
  let settingsSet: ReturnType<typeof vi.fn>;
  let requestApproval: ReturnType<typeof vi.fn>;
  let evaluateCheck: ReturnType<typeof vi.fn<GoalControllerDeps["evaluateCheck"]>>;
  let created: string[];
  const taskRows = new Map<string, BackgroundTask>();
  let replies: CommandReply[];

  async function run(text: string, senderId = OWNER) {
    replies = [];
    const message = msg(text, senderId);
    const outcome = await registry.dispatch({
      message,
      identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r) => {
        replies.push(r);
      },
    });
    return { outcome, text: replies.map((r) => r.text).join("\n") };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-goal-cmd-"));
    store = new GoalStore(join(dir, "goals.db"));
    cfg = GoalsConfigSchema.parse({});
    enabled = true;
    created = [];
    evaluateCheck = vi.fn(async () => ({ decision: "pass" as const, reasons: [] }));
    controller = new GoalController({
      store,
      tasks: {
        create: (sessionKey, description, prompt, meta) => {
          const id = `task-${created.length + 1}`;
          created.push(id);
          const task: BackgroundTask = { id, session_key: sessionKey, description, prompt, status: "pending", result: null, error: null, cost_usd: 0, num_turns: 0, created_at: "", updated_at: "", sdk_session_id: null, meta: meta ?? null };
          taskRows.set(id, task);
          return task;
        },
        get: (id) => taskRows.get(id) ?? null,
        markCompleted: () => {},
        markFailed: () => {},
        markCancelled: () => true,
        listByStatus: () => [],
      },
      taskManager: { cancelTask: () => true },
      config: () => cfg,
      isEnabled: () => enabled,
      judge: async () => ({ ok: false, error: "unused", costUsd: 0 }),
      evaluateCheck,
      ask: async () => ({ optionId: "decline", outcome: "unavailable", code: "" }),
      askTimeoutMs: 300_000,
      sendToChat: async () => {},
      defaultCwd: dir,
    });
    settingsSet = vi.fn((_key: string, value: unknown) => {
      enabled = value === true;
    });
    requestApproval = vi.fn(async () => ({ outcome: "approved", optionId: "approve", code: "K7Q2" }));
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }), prompts: { requestApproval } });
    registry.registerAll(createGoalCommands({ controller, settings: { set: settingsSet }, isEnabled: () => enabled, config: () => cfg, defaultCwd: dir }));
  });

  afterEach(() => {
    controller.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is owner-only and DM-only in the automation category", () => {
    const def = registry.get("goal")!;
    expect(def).toMatchObject({ ownerOnly: true, scope: "dm", category: "automation" });
  });

  it("a non-owner is refused and nothing is created", async () => {
    const r = await run("/goal fix everything", STRANGER);
    expect(r.outcome.kind).toBe("denied");
    expect(r.text).toBe(COMMAND_OWNER_ONLY_TEXT);
    expect(store.listRecent()).toEqual([]);
  });

  it("while off, /goal <text> explains how to turn it on and starts nothing", async () => {
    enabled = false;
    const r = await run("/goal fix the tests --check \"pnpm test\"");
    expect(r.text).toBe(GOAL_OFF_TEXT);
    expect(store.listRecent()).toEqual([]);
    expect(evaluateCheck).not.toHaveBeenCalled();
  });

  it("/goal on describes agent-created goals as goals.agentCreate sets them (CONF-N7)", async () => {
    enabled = false;
    expect((await run("/goal on")).text).toContain("still need your tap on Start");
    cfg = { ...cfg, agentCreate: "allow" };
    const allow = (await run("/goal on")).text;
    expect(allow).not.toContain("tap");
    expect(allow).toContain("start without asking you");
    cfg = { ...cfg, agentCreate: "deny" };
    expect((await run("/goal on")).text).toContain("cannot start goals");
  });

  it("/goal on and off persist the runtime override", async () => {
    enabled = false;
    expect((await run("/goal on")).text).toContain("Goals are on");
    expect(settingsSet).toHaveBeenCalledWith("goals.enabled", true, "owner:telegram:1001");
    expect((await run("/goal off")).text).toContain("Goals are off");
    expect(settingsSet).toHaveBeenLastCalledWith("goals.enabled", false, "owner:telegram:1001");
  });

  it("starts a goal with the config defaults and its checks gate-reviewed", async () => {
    const r = await run("/goal fix the auth tests --check \"pnpm vitest run packages/core\"");
    expect(r.outcome.kind).toBe("handled");
    const [g] = store.listRecent();
    expect(g).toMatchObject({
      goal: "fix the auth tests",
      status: "running",
      maxRounds: cfg.maxRounds,
      maxMinutes: cfg.maxMinutes,
      maxCostUsd: cfg.maxCostUsd,
      checks: [{ command: "pnpm vitest run packages/core", timeoutSec: cfg.checkTimeoutSeconds }],
      createdBy: "owner",
      sessionKey: "telegram:dm:1001",
    });
    expect(evaluateCheck).toHaveBeenCalledWith("pnpm vitest run packages/core", { sessionKey: "telegram:dm:1001", cwd: dir });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("an apostrophe in the goal text keeps the check and caps, and the reply lists them (RUNTIME-B1 reviewer proof)", async () => {
    const r = await run(`/goal don't stop until the auth tests pass --check "pnpm vitest run packages/core" --rounds 3 --budget 2`);
    const [g] = store.listRecent();
    expect(g).toMatchObject({
      goal: "don't stop until the auth tests pass",
      checks: [{ command: "pnpm vitest run packages/core" }],
      maxRounds: 3,
      maxCostUsd: 2,
      maxMinutes: cfg.maxMinutes,
    });
    expect(evaluateCheck).toHaveBeenCalledWith("pnpm vitest run packages/core", expect.anything());
    expect(r.text).toContain("1. pnpm vitest run packages/core");
    expect(r.text).toContain("Caps: 3 rounds");
    expect(r.text).toContain("$2");
  });

  it("typographic quotes around a check give the whole command, not a broken first word", async () => {
    const r = await run(`/goal fix auth --check “pnpm vitest run” --rounds 3`);
    expect(store.listRecent()[0]).toMatchObject({ goal: "fix auth", checks: [{ command: "pnpm vitest run" }], maxRounds: 3 });
    expect(r.text).toContain("1. pnpm vitest run");
  });

  it("a goal without checks says so in the reply", async () => {
    const r = await run("/goal tidy the readme");
    expect(r.text).toContain("Checks: none");
    expect(r.text).toContain(`Caps: ${cfg.maxRounds} rounds`);
  });

  it.each([
    `/goal fix auth --check pnpm vitest run --rounds 3`,
    `/goal don't stop --check "pnpm vitest run --rounds 3`,
    `/goal fix auth --rounds 3 and also lint`,
  ])("flag text that cannot be read one way only starts nothing and shows an example: %s", async (text) => {
    const r = await run(text);
    expect(r.text).toContain("Nothing was started");
    expect(r.text).toContain("Example: /goal");
    expect(store.listRecent()).toEqual([]);
    expect(evaluateCheck).not.toHaveBeenCalled();
  });

  it("resume keeps --budget when the instructions contain an apostrophe", async () => {
    await run("/goal first");
    const [g] = store.listRecent();
    store.transition(g!.id, ["running"], "paused", { pauseRequested: false });
    store.update(g!.id, { costUsd: 9.5 });
    const r = await run(`/goal resume ${g!.id} don't touch the public API --budget 3`);
    expect(r.text).toContain("resumed");
    const after = store.get(g!.id)!;
    expect(after.costLimitUsd).toBeCloseTo(12.5);
    expect(after.resumeNote).toBe("don't touch the public API");
  });

  it("owner flags override the defaults", async () => {
    await run("/goal ship it --rounds 3 --time 90m --budget 2.5");
    expect(store.listRecent()[0]).toMatchObject({ maxRounds: 3, maxMinutes: 90, maxCostUsd: 2.5, roundLimit: 3 });
  });

  it("a check the gates deny rejects the goal", async () => {
    evaluateCheck.mockResolvedValueOnce({ decision: "deny", reasons: ["hardline: rm -rf /"] });
    const r = await run("/goal clean up --check \"rm -rf /\"");
    expect(r.text).toContain("Goal not started");
    expect(r.text).toContain("hardline");
    expect(store.listRecent()).toEqual([]);
  });

  it("a check the gates would ask about needs a Confirm tap", async () => {
    evaluateCheck.mockResolvedValue({ decision: "ask", reasons: ["dangerous"] });
    requestApproval.mockResolvedValueOnce({ outcome: "denied", optionId: "deny", code: "K7Q2" });
    let r = await run("/goal deploy --check \"make deploy-check\"");
    expect(r.text).toBe("Goal not started.");
    expect(requestApproval.mock.calls[0]![0].body).toContain("make deploy-check");
    expect(store.listRecent()).toEqual([]);
    r = await run("/goal deploy --check \"make deploy-check\"");
    const [g] = store.listRecent();
    expect(g!.checkReview).toEqual([{ command: "make deploy-check", decision: "ask", reasons: ["dangerous"] }]);
  });

  it("a second goal is queued behind the running one", async () => {
    await run("/goal first");
    const r = await run("/goal second");
    expect(r.text).toContain("is queued");
  });

  it("the id is optional with one open goal and required with several", async () => {
    await run("/goal first");
    const [first] = store.listRecent();
    expect((await run("/goal status")).text).toContain(`Goal ${first!.id}: running`);
    await run("/goal second");
    expect((await run("/goal status")).text).toContain("Several goals are open");
    expect((await run("/goal stop")).text).toContain("Several goals could be meant");
    expect((await run(`/goal stop ${first!.id}`)).text).toContain("stopped");
    expect(store.get(first!.id)!.status).toBe("cancelled");
  });

  it("a control word followed by text that is not an id does not start or stop anything", async () => {
    const r = await run("/goal stop the server from crashing");
    expect(r.text).toContain("/goal start <text>");
    expect(store.listRecent()).toEqual([]);
    await run("/goal start stop the server from crashing");
    expect(store.listRecent()[0]!.goal).toBe("stop the server from crashing");
  });

  it("list shows open goals", async () => {
    expect((await run("/goal")).text).toContain("No goals yet");
    await run("/goal first");
    expect((await run("/goal list")).text).toMatch(/Open:\ng-[a-z2-7]{6} running/);
  });

  it("pause and resume with a budget and instructions", async () => {
    await run("/goal first");
    const [g] = store.listRecent();
    expect((await run("/goal pause")).text).toContain("will pause at the end");
    store.transition(g!.id, ["running"], "paused", { pauseRequested: false });
    store.update(g!.id, { costUsd: 9.5 });
    const r = await run(`/goal resume ${g!.id} --budget 3 also update the docs`);
    expect(r.text).toContain("resumed");
    const after = store.get(g!.id)!;
    expect(after.costLimitUsd).toBeCloseTo(12.5);
    expect(after.status).toBe("running");
    expect(after.resumeNote).toBe("also update the docs");
  });

  it("resume refuses while goals are off", async () => {
    await run("/goal first");
    const [g] = store.listRecent();
    store.transition(g!.id, ["running"], "paused");
    enabled = false;
    expect((await run("/goal resume")).text).toContain("Goals are off");
  });

  it("an unknown option shows the usage", async () => {
    const r = await run("/goal x --nope 1");
    expect(r.text).toContain("Unknown option --nope");
    expect(r.text).toContain("/goal <text>");
  });
});
