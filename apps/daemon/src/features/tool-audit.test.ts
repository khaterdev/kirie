/**
 * MCP tool audit (W4-INT item 8, PLAN B.13 and E.4).
 *
 * Lists every agent-facing tool from both registries: the daemon's in-process
 * registry (`mcp/server.ts`) and the stdio server the agent actually talks to
 * (`mcp/stdio-server.ts`, the built file, spawned with a temp HOME and data
 * dir). Both get the kirie-tools env that the feature modules set up with
 * every feature on. Checks:
 * - both registries expose exactly the same feature tools, and no feature tool
 *   is shadowed by a built-in of the same name;
 * - no tool name in either registry is a mutation the agent must not have.
 *
 * Names are checked by rule, so tools that sandbox and computer use add later
 * are covered without editing this file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ARCTIC_MODEL_NAME } from "@kirie/memory";
import { ChannelRegistry, VOICE_TOOLS_ENV_FLAG, createMcpToolRegistry, featureToolNames, type FeatureToolContext } from "@kirie/core";
import { FEATURES, runFeatureSetups, stopFeatures, type FeatureHandle } from "./index.js";
import type { FeatureFailure } from "./runner.js";
import { buildAuditContext } from "./audit-context.test-util.js";

/**
 * Mutations PLAN B.13 and E.4 keep away from the agent. A tool name matching
 * any of these fails the audit.
 */
const FORBIDDEN_TOOL_NAMES: ReadonlyArray<{ what: string; re: RegExp }> = [
  { what: "approve anything", re: /(^|_)approve(_|$)/ },
  { what: "proposal apply, reject or undo", re: /(proposal|learning).*_(apply|reject|undo|approve)|(apply|reject|undo)_.*proposal/ },
  { what: "approvals mode or lists", re: /^approvals?_(mode|scope|allow|deny|unallow|undeny|rules?|hardline|set|reset|add|remove)/ },
  { what: "plugins enable, approve or disable", re: /^plugins?_(enable|approve|disable|trust|install)/ },
  { what: "computer-use arming", re: /(^|_)(arm|unarm|disarm)(_|$)|computer.*_(on|enable|grant)/ },
  { what: "sandbox mode", re: /^sandbox_(mode|set|off|on|native|docker|allow|disallow|recreate|reset)/ },
  { what: "undo", re: /(^|_)(undo|rewind)(_|$)/ },
  { what: "webhook secret reveal", re: /webhooks?_.*(secret|reveal|rotate)/ },
  { what: "secrets redact or reveal", re: /(^|_)(redact|reveal)(_|$)/ },
  { what: "accounts remove or add-token", re: /^accounts?_(remove|delete|add|add_token|token|login|logout)/ },
];

const require = createRequire(import.meta.url);
/** The built stdio server (`pnpm build` runs before the tests). */
const STDIO_SERVER = join(dirname(require.resolve("@kirie/core")), "mcp", "stdio-server.js");

let home: string;
let dataDir: string;
let prevHome: string | undefined;
let handles: FeatureHandle[] = [];
let failures: FeatureFailure[] = [];
let closeContext: () => void = () => {};
let toolEnv: Record<string, string> = {};
let inProcess: string[] = [];
let stdio: string[] = [];
let featureNames: string[] = [];

/** Speak just enough MCP over stdio to list the tools, then stop the child. */
async function listStdioTools(env: Record<string, string>): Promise<string[]> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [STDIO_SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const responses = new Map<number, unknown>();
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (typeof msg.id === "number") responses.set(msg.id, msg.result);
      } catch { /* not JSON-RPC */ }
    }
  });
  const send = (msg: unknown): void => { child.stdin.write(`${JSON.stringify(msg)}\n`); };
  const waitFor = async (id: number): Promise<unknown> => {
    const deadline = Date.now() + 8000;
    while (!responses.has(id)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`stdio server gave no response ${id}: ${stderr.slice(0, 500)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return responses.get(id);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kirie-tool-audit", version: "0" } } });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const result = (await waitFor(2)) as { tools: Array<{ name: string }> };
    return result.tools.map((t) => t.name);
  } finally {
    child.kill("SIGKILL");
  }
}

describe("MCP tool audit: both registries, every feature on", () => {
  beforeAll(async () => {
    expect(existsSync(STDIO_SERVER), `built stdio server at ${STDIO_SERVER}`).toBe(true);
    home = mkdtempSync(join(tmpdir(), "kirie-tool-audit-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    dataDir = join(home, ".kirie");
    mkdirSync(dataDir, { recursive: true });
    // An embedding model that "is downloaded", so the stdio server never fetches one.
    const modelDir = join(dataDir, "models", ARCTIC_MODEL_NAME);
    mkdirSync(join(modelDir, "onnx"), { recursive: true });
    for (const f of ["onnx/model.onnx", "tokenizer.json", "config.json", "tokenizer_config.json", "special_tokens_map.json"]) {
      writeFileSync(join(modelDir, f), "");
    }

    const built = buildAuditContext(dataDir);
    closeContext = built.close;
    failures = [];
    handles = await runFeatureSetups(FEATURES, built.ctx, { onFailure: (f) => failures.push(f) });
    // Voice tools exist only once voice is ready (credentials); turn them on for the audit.
    toolEnv = { ...built.ctx.kirieToolsEnv, [VOICE_TOOLS_ENV_FLAG]: "1" };
    const gatewayUrl = "http://127.0.0.1:9";
    const featureCtx: FeatureToolContext = { dbDir: dataDir, gatewayUrl, env: toolEnv };
    featureNames = featureToolNames(featureCtx);

    const registry = createMcpToolRegistry({
      channelRegistry: new ChannelRegistry(),
      memoryDbPath: join(dataDir, "memory.db"),
      scheduleDbPath: join(dataDir, "schedules.db"),
      chatHistoryDbPath: join(dataDir, "chat-history.db"),
      backgroundTasksDbPath: join(dataDir, "background-tasks.db"),
      heartbeatLogDbPath: join(dataDir, "heartbeat-logs.db"),
      featureTools: featureCtx,
    });
    inProcess = [...registry.tools.keys()];
    registry.shutdown();

    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      KIRIE_DB_DIR: dataDir,
      KIRIE_GATEWAY_URL: gatewayUrl,
      ...toolEnv,
    };
    stdio = await listStdioTools(childEnv);
  }, 30_000);

  afterAll(async () => {
    await stopFeatures(handles);
    closeContext();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("every feature set up, and both registries listed tools", () => {
    expect(failures).toEqual([]);
    expect(inProcess.length).toBeGreaterThan(10);
    expect(stdio.length).toBeGreaterThan(10);
    expect(featureNames.length).toBeGreaterThan(5);
  });

  it("both registries expose the same feature tools, all of them", () => {
    const feature = new Set(featureNames);
    const inProcessFeature = inProcess.filter((n) => feature.has(n)).sort();
    const stdioFeature = stdio.filter((n) => feature.has(n)).sort();
    expect(stdioFeature).toEqual([...feature].sort());
    expect(inProcessFeature).toEqual(stdioFeature);
  });

  it("the B.13 feature tools for the features that are on are present", () => {
    for (const name of ["learning_propose", "proposals_list", "curator_report", "user_model_query", "goal_create", "goal_stop", "loop_create", "loop_stop", "webhook_list", "approval_status", "secrets_scan", "plugins_list", "voice_call_initiate", "accounts_list"]) {
      expect(featureNames, name).toContain(name);
    }
  });

  it("no tool in either registry is a mutation the agent must not have", () => {
    const all = [...new Set([...inProcess, ...stdio])];
    const hits = all.flatMap((name) => FORBIDDEN_TOOL_NAMES.filter((f) => f.re.test(name)).map((f) => `${name} (${f.what})`));
    expect(hits).toEqual([]);
  });

  it("the rules do catch the names they are meant to catch", () => {
    const bad = ["proposals_approve", "learning_apply", "proposal_reject", "approvals_mode", "approvals_allow", "plugins_enable",
      "plugins_disable", "computer_arm", "computer_use_on", "sandbox_mode", "sandbox_off", "undo_last", "file_undo", "webhook_secret",
      "webhook_reveal_secret", "secrets_redact", "accounts_remove", "accounts_add_token"];
    for (const name of bad) expect(FORBIDDEN_TOOL_NAMES.some((f) => f.re.test(name)), name).toBe(true);
    const fine = ["approval_status", "proposals_list", "learning_propose", "plugins_list", "sandbox_status", "sandbox_bash",
      "computer_use_status", "webhook_list", "webhook_deliveries", "secrets_scan", "accounts_list", "accounts_import", "goal_stop"];
    for (const name of fine) expect(FORBIDDEN_TOOL_NAMES.some((f) => f.re.test(name)), name).toBe(false);
  });
});
