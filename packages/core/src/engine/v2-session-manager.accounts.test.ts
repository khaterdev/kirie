import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Scripted streaming-input SDK mock for account rotation and model fallback.
 * The account is read from options.env: "ambient" (no env), "default" (env
 * without CLAUDE_CONFIG_DIR) or the config dir. Keywords in a pushed message:
 * LIMIT (returned limit result on a limited account), THROW (thrown limit on a
 * limited account), MODEL (model refused while the current model is
 * unavailable), TOOLONG (prompt too long on any fallback model), SLOW.
 */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown>; account: string }>,
  events: [] as string[],
  sent: [] as Array<{ account: string; model: string; text: string }>,
  setModel: [] as string[],
  limited: new Set<string>(),
  unavailable: new Set<string>(),
  counter: 0,
  /** Epoch seconds, two hours ahead (set per test) */
  resetsAt: 0,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const LIMIT = "You've hit your session limit · resets 4am (Africa/Cairo)";
  return {
    query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> & { resume?: string; env?: Record<string, string>; model?: string } }) => {
      const account = options.env ? (options.env.CLAUDE_CONFIG_DIR ?? "default") : "ambient";
      const n = sdk.calls.push({ options, account });
      sdk.events.push(`query:${n}:${account}`);
      const sessionId = options.resume ?? `00000000-0000-4000-8000-${String(++sdk.counter).padStart(12, "0")}`;
      let model = options.model ?? "?";
      const base = { session_id: sessionId, uuid: "m", parent_tool_use_id: null };
      const result = (text: string, isError = false, extra: Record<string, unknown> = {}) => ({
        type: "result", subtype: "success", result: text, is_error: isError, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, permission_denials: [], ...base, ...extra,
      });
      const assistant = (text: string) => ({ type: "assistant", message: { model, content: [{ type: "text", text }] }, ...base });

      const stream = (async function* () {
        for await (const raw of prompt) {
          const content = (raw as { message: { content: string } }).message.content;
          sdk.sent.push({ account, model, text: content });
          if (content.includes("SLOW")) await new Promise((r) => setTimeout(r, 150));
          if (content.includes("THROW") && sdk.limited.has(account)) {
            throw new Error(`Claude Code returned an error result: ${LIMIT}`);
          }
          if (content.includes("LIMIT") && sdk.limited.has(account)) {
            yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: sdk.resetsAt, rateLimitType: "five_hour" }, ...base };
            yield { type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT }] }, ...base };
            yield result(LIMIT, true, { api_error_status: 429 });
            continue;
          }
          if (content.includes("MODEL") && sdk.unavailable.has(model)) {
            yield result("API Error: 400 Claude Code 2.1.220 does not support this model", true, { api_error_status: 400 });
            continue;
          }
          if (content.includes("TOOLONG") && model !== "opus") {
            yield result("Prompt is too long", true, { terminal_reason: "prompt_too_long" });
            continue;
          }
          yield assistant(`ok from ${account}`);
          yield result(`ok from ${account}`);
        }
        sdk.events.push(`input-ended:${n}`);
      })();

      return Object.assign(stream, {
        interrupt: vi.fn(async () => undefined),
        setModel: vi.fn(async (m: string) => {
          sdk.setModel.push(m);
          model = m;
        }),
        close: vi.fn(() => {
          sdk.events.push(`close:${n}`);
          void stream.return(undefined);
        }),
      });
    }),
  };
});

import { SessionStore } from "./session-store.js";
import { V2SessionManager } from "./v2-session-manager.js";
import { TurnResilience } from "./resilience.js";
import { failureOf } from "./failure.js";
import { ACCOUNT_SWITCH_NOTE } from "./resilience.js";
import { AccountStore } from "../accounts/account-store.js";
import { AccountManager } from "../accounts/account-manager.js";
import { FallbackControl } from "../accounts/fallback-control.js";
import { AccountsConfigSchema, type AccountsConfig } from "../config/sections/accounts.js";
import { FallbackConfigSchema, type FallbackConfig } from "../config/sections/fallback.js";
import type { IncomingMessage } from "./agent-engine.js";
import type { SenderIdentity } from "./prompt-builder.js";

const owner: SenderIdentity = { name: "Owner", platformId: "1", role: "owner" };
const msg = (text: string, chatId = "1"): IncomingMessage => ({
  id: `m-${Math.random()}`, channel: "telegram", senderName: "Owner", senderId: "1", text, chatType: "dm", chatId,
});

function writeIdentity(file: string, uuid: string): void {
  writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.invalid` } }));
}

describe("V2SessionManager with account rotation and model fallback", () => {
  let root: string;
  let home: string;
  let sessions: SessionStore;
  let accountStore: AccountStore;
  let manager: AccountManager;
  let fallback: FallbackControl;
  let v2: V2SessionManager;
  let rotation: boolean;
  let accountsCfg: AccountsConfig;
  let fbCfg: FallbackConfig;
  let dir2: string;
  let dir3: string;
  const key = "telegram:dm:1";

  beforeEach(() => {
    sdk.calls.length = 0;
    sdk.events.length = 0;
    sdk.sent.length = 0;
    sdk.setModel.length = 0;
    sdk.limited.clear();
    sdk.unavailable.clear();
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-v2acc-")));
    home = join(root, "home");
    sdk.resetsAt = Math.floor(Date.now() / 1000) + 7200;
    // The owner's layout: every secondary dir symlinks projects/ to ~/.claude/projects.
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeIdentity(join(home, ".claude.json"), "uuid-main");
    dir2 = join(home, ".claude2");
    dir3 = join(home, ".claude3");
    for (const [d, u] of [[dir2, "uuid-2"], [dir3, "uuid-3"]] as const) {
      mkdirSync(d);
      symlinkSync(join(home, ".claude", "projects"), join(d, "projects"));
      writeIdentity(join(d, ".claude.json"), u);
    }
    rotation = true;
    accountsCfg = AccountsConfigSchema.parse({});
    fbCfg = FallbackConfigSchema.parse({});
    sessions = new SessionStore(join(root, "sessions.db"));
    accountStore = new AccountStore(join(root, "accounts.db"));
    manager = new AccountManager({
      store: accountStore,
      config: () => accountsCfg,
      rotationEnabled: () => rotation,
      home,
      baseEnv: () => ({ PATH: "/bin" }),
      runSecurity: () => 0,
      platform: "darwin",
    });
    fallback = new FallbackControl({ store: accountStore, config: () => fbCfg });
    v2 = new V2SessionManager(sessions, { workspacePath: root, model: "opus" });
    v2.setResilience(new TurnResilience({ accounts: manager, models: fallback }));
  });

  afterEach(async () => {
    await v2.shutdown();
    sessions.close();
    accountStore.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function importAccounts(...dirs: string[]): Promise<void> {
    for (const d of dirs) await manager.importDir(d, { actor: "owner:test", verify: false });
  }

  it("with zero imported accounts options.env is undefined and the configured model is used", async () => {
    const result = await v2.execute(msg("hello"), owner);
    expect(result.response).toBe("ok from ambient");
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0]!.options.env).toBeUndefined();
    expect(sdk.calls[0]!.options.model).toBe("opus");
    expect(sdk.calls[0]!.options.fallbackModel).toBeUndefined();
    expect(result.accountId).toBeNull();
  });

  it("a returned limit rotates: same session id, new CLAUDE_CONFIG_DIR, old input closed first, row rebound", async () => {
    await importAccounts("~/.claude", "~/.claude2");
    const rotated = vi.fn();
    manager.on("rotated", rotated);
    await v2.execute(msg("hello"), owner);
    const sid = sessions.get(key)!;
    expect(sessions.getAccountId(key)).toBe("main");

    sdk.limited.add("default");
    const result = await v2.execute(msg("LIMIT please"), owner);

    expect(result.isError).toBe(false);
    expect(result.response).toBe(`ok from ${dir2}`);
    expect(result.accountId).toBe("claude2");
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]!.account).toBe(dir2);
    expect(sdk.calls[1]!.options.resume).toBe(sid);
    // The first process's input ended before the second query started.
    expect(sdk.events.indexOf("input-ended:1")).toBeGreaterThan(-1);
    expect(sdk.events.indexOf("input-ended:1")).toBeLessThan(sdk.events.indexOf(`query:2:${dir2}`));
    // The session row is kept with the new account.
    expect(sessions.get(key)).toBe(sid);
    expect(sessions.getAccountId(key)).toBe("claude2");
    // The first account is benched until its reset; one rotation event.
    expect(manager.get("main")).toMatchObject({ status: "limited", limitedUntil: sdk.resetsAt * 1000 });
    expect(rotated).toHaveBeenCalledTimes(1);
    // The message was re-sent with the system note in front.
    const resent = sdk.sent.filter((s) => s.account === dir2).at(-1)!;
    expect(resent.text.startsWith(ACCOUNT_SWITCH_NOTE)).toBe(true);
    expect(resent.text).toContain("LIMIT please");
  });

  it("a thrown limit rotates the same way", async () => {
    await importAccounts("~/.claude", "~/.claude2");
    await v2.execute(msg("hello"), owner);
    const sid = sessions.get(key)!;
    sdk.limited.add("default");
    const result = await v2.execute(msg("THROW now"), owner);
    expect(result.response).toBe(`ok from ${dir2}`);
    expect(sdk.calls.at(-1)!.options.resume).toBe(sid);
    expect(sessions.getAccountId(key)).toBe("claude2");
  });

  it("a dir with its own projects/ store gets the transcript copied, then resumes the same id", async () => {
    await importAccounts("~/.claude", "~/.claude3");
    rmSync(join(dir3, "projects"));
    mkdirSync(join(dir3, "projects"));
    await v2.execute(msg("hello"), owner);
    const sid = sessions.get(key)!;
    mkdirSync(join(home, ".claude", "projects", "-work"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-work", `${sid}.jsonl`), "{}\n");
    sdk.limited.add("default");
    const result = await v2.execute(msg("LIMIT"), owner);
    expect(result.accountId).toBe("claude3");
    expect(sdk.calls.at(-1)!.options.resume).toBe(sid);
    expect(readFileSync(join(dir3, "projects", "-work", `${sid}.jsonl`), "utf8")).toBe("{}\n");
  });

  it("a transcript that cannot be carried starts a fresh session on the new account", async () => {
    await importAccounts("~/.claude", "~/.claude3");
    rmSync(join(dir3, "projects"));
    await v2.execute(msg("hello"), owner);
    sdk.limited.add("default");
    const result = await v2.execute(msg("LIMIT"), owner);
    expect(result.response).toBe(`ok from ${dir3}`);
    expect(sdk.calls.at(-1)!.options.resume).toBeUndefined();
  });

  it("carrySession off starts a fresh session on the new account", async () => {
    accountsCfg = AccountsConfigSchema.parse({ rotation: { carrySession: false } });
    await importAccounts("~/.claude", "~/.claude2");
    await v2.execute(msg("hello"), owner);
    sdk.limited.add("default");
    await v2.execute(msg("LIMIT"), owner);
    expect(sdk.calls.at(-1)!.options.resume).toBeUndefined();
  });

  it("rotation off: the classified failure comes back, the mapping is kept, nothing loops", async () => {
    rotation = false;
    await importAccounts("~/.claude", "~/.claude2");
    await v2.execute(msg("hello"), owner);
    const sid = sessions.get(key);
    sdk.limited.add("default");
    const result = await v2.execute(msg("LIMIT"), owner);
    expect(result.isError).toBe(true);
    expect(result.failure?.class).toBe("usage_limit_account");
    expect(sdk.calls).toHaveLength(1);
    expect(sessions.get(key)).toBe(sid);
  });

  it("every account limited: one attempt each, then the exhausted failure with the earliest reset", async () => {
    await importAccounts("~/.claude", "~/.claude2");
    sdk.limited.add("default");
    sdk.limited.add(dir2);
    const result = await v2.execute(msg("LIMIT"), owner);
    expect(result.isError).toBe(true);
    expect(sdk.calls).toHaveLength(2);
    expect(result.failure).toMatchObject({ class: "usage_limit_account", accountsExhausted: 2, resetAtMs: sdk.resetsAt * 1000 });
  });

  it("maxRotationsPerTurn is respected", async () => {
    accountsCfg = AccountsConfigSchema.parse({ rotation: { maxRotationsPerTurn: 1 } });
    await importAccounts("~/.claude", "~/.claude2", "~/.claude3");
    sdk.limited.add("default");
    sdk.limited.add(dir2);
    const result = await v2.execute(msg("LIMIT"), owner);
    expect(result.isError).toBe(true);
    expect(sdk.calls.map((c) => c.account)).toEqual(["default", dir2]);
  });

  it("another chat's idle session migrates on its next turn", async () => {
    await importAccounts("~/.claude", "~/.claude2");
    await v2.execute(msg("hello", "1"), owner);
    await v2.execute(msg("hello", "2"), owner);
    const sid2 = sessions.get("telegram:dm:2")!;
    sdk.limited.add("default");
    await v2.execute(msg("LIMIT", "1"), owner);
    const before = sdk.calls.length;
    expect(v2.hasSession("telegram:dm:2")).toBe(true);
    const result = await v2.execute(msg("next", "2"), owner);
    expect(result.response).toBe(`ok from ${dir2}`);
    expect(sdk.calls.length).toBe(before + 1);
    expect(sdk.calls.at(-1)!.options.resume).toBe(sid2);
    expect(sessions.getAccountId("telegram:dm:2")).toBe("claude2");
  });

  it("a session with a turn in flight is never closed by a rotation in another chat", async () => {
    await importAccounts("~/.claude", "~/.claude2");
    await v2.execute(msg("hello", "1"), owner);
    await v2.execute(msg("hello", "2"), owner);
    const closesBefore = sdk.events.filter((e) => e.startsWith("close:")).length;
    sdk.limited.add("default");
    const slow = v2.execute(msg("SLOW work", "2"), owner);
    await new Promise((r) => setTimeout(r, 10));
    expect(v2.isBusy("telegram:dm:2")).toBe(true);
    await v2.execute(msg("LIMIT", "1"), owner);
    const slowResult = await slow;
    expect(slowResult.response).toBe("ok from default");
    // Chat 2's process (query 2) was not closed by chat 1's rotation.
    expect(sdk.events).not.toContain("close:2");
    expect(sdk.events.filter((e) => e.startsWith("close:")).length).toBeGreaterThanOrEqual(closesBefore);
  });

  it("an unavailable model moves to setModel(next) in the same process, keeps the mapping, reports the model", async () => {
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet"] });
    await v2.execute(msg("hello"), owner);
    const sid = sessions.get(key);
    sdk.unavailable.add("opus");
    const result = await v2.execute(msg("MODEL check"), owner);
    expect(result.isError).toBe(false);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.setModel).toEqual(["sonnet"]);
    expect(result.model).toBe("sonnet");
    expect(result.notices).toEqual(["opus is unavailable. Answering with sonnet until it recovers."]);
    expect(sessions.get(key)).toBe(sid);
    expect(fallback.isBenched(null, "opus")).toBe(true);
  });

  it("the primary comes back with setModel once its bench is cleared", async () => {
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet"] });
    await v2.execute(msg("hello"), owner);
    sdk.unavailable.add("opus");
    await v2.execute(msg("MODEL"), owner);
    sdk.unavailable.clear();
    fallback.clearBenches();
    const result = await v2.execute(msg("again"), owner);
    expect(sdk.setModel).toEqual(["sonnet", "opus"]);
    expect(result.model).toBe("opus");
  });

  it("prompt_too_long on a fallback model stops the chain", async () => {
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet", "haiku"] });
    sdk.unavailable.add("opus");
    const result = await v2.execute(msg("MODEL TOOLONG"), owner);
    expect(result.isError).toBe(true);
    expect(result.failure?.class).toBe("prompt_too_long");
    expect(sdk.setModel).toEqual(["sonnet"]);
  });

  it("combined: account limit then model refusal -> (main, opus), (claude2, opus), (claude2, sonnet)", async () => {
    fbCfg = FallbackConfigSchema.parse({ enabled: true, models: ["sonnet"] });
    await importAccounts("~/.claude", "~/.claude2");
    sdk.limited.add("default");
    sdk.unavailable.add("opus");
    const result = await v2.execute(msg("LIMIT MODEL"), owner);
    expect(result.response).toBe(`ok from ${dir2}`);
    expect(sdk.sent.map((s) => [s.account, s.model])).toEqual([
      ["default", "opus"],
      [dir2, "opus"],
      [dir2, "sonnet"],
    ]);
  });

  it("an account whose login changed is never spawned: the turn returns an auth failure", async () => {
    rotation = false;
    await importAccounts("~/.claude");
    writeIdentity(join(home, ".claude.json"), "uuid-someone-else");
    // Force the pin to look again.
    const m = manager as unknown as { identityCheckedAt: Map<string, number> };
    m.identityCheckedAt.clear();
    const result = await v2.execute(msg("hello"), owner);
    expect(result.isError).toBe(true);
    expect(result.failure?.class).toBe("auth");
    expect(sdk.calls).toHaveLength(0);
  });

  it("a thrown limit with no account to move to rejects with the classification attached", async () => {
    await importAccounts("~/.claude");
    sdk.limited.add("default");
    const err = await v2.execute(msg("THROW"), owner).catch((e: unknown) => e);
    expect(failureOf(err)?.class).toBe("usage_limit_account");
  });
});
