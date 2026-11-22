import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { noToolsOptions, runOneShot, parseJsonText, OneShotError, defaultOneShotCwd } from "./oneshot.js";
import { SdkOptionsPipeline, type SdkStreamEvent } from "./sdk-options.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;

function stream(messages: Array<Record<string, unknown>>, throwAfter?: Error) {
  return (async function* () {
    for (const m of messages) yield m;
    if (throwAfter) throw throwAfter;
  })();
}

function success(result: string, extra: Record<string, unknown> = {}) {
  return { type: "result", subtype: "success", result, is_error: false, total_cost_usd: 0.002, num_turns: 1, ...extra };
}

describe("noToolsOptions", () => {
  it("removes every tool, server, setting source and transcript, and denies any tool request", async () => {
    const options = noToolsOptions({ model: "claude-haiku-4-5", systemPrompt: "judge", cwd: "/tmp/x" });
    expect(options).toMatchObject({
      model: "claude-haiku-4-5",
      systemPrompt: "judge",
      cwd: "/tmp/x",
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      allowedTools: [],
      permissionMode: "default",
      persistSession: false,
      maxTurns: 3,
    });
    const verdict = (await options.canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "t",
      requestId: "r",
    })) as PermissionResult;
    expect(verdict.behavior).toBe("deny");
    // E7: the SDK's own StructuredOutput tool is the one exception.
    const structured = (await options.canUseTool!("StructuredOutput", { done: true }, {
      signal: new AbortController().signal,
      toolUseID: "t2",
      requestId: "r2",
    })) as PermissionResult;
    expect(structured).toEqual({ behavior: "allow", updatedInput: { done: true } });
    expect(options.disallowedTools).toBeUndefined();
    expect(noToolsOptions({ model: "m", systemPrompt: "s", cwd: "/c", maxTurns: 1 }).maxTurns).toBe(1);
  });
});

describe("parseJsonText", () => {
  it("parses plain, fenced and embedded JSON", () => {
    expect(parseJsonText('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseJsonText('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonText("```\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonText('Here you go: {"done":false} thanks')).toEqual({ done: false });
    expect(() => parseJsonText("no json here")).toThrow(SyntaxError);
    expect(() => parseJsonText("")).toThrow(SyntaxError);
  });
});

describe("runOneShot", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "kirie-oneshot-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes no-tools options to query() in an empty 0700 directory", async () => {
    mockQuery.mockReturnValue(stream([success('{"verdict":"done"}')]));
    const cwd = join(dir, "tmp", "oneshot");
    const { value, costUsd } = await runOneShot({
      kind: "judge",
      model: "claude-haiku-4-5",
      system: "You judge.",
      prompt: "Is it done?",
      parse: (v) => v as { verdict: string },
      cwd,
      maxBudgetUsd: 0.05,
    });
    expect(value).toEqual({ verdict: "done" });
    expect(costUsd).toBe(0.002);
    expect(existsSync(cwd)).toBe(true);
    expect(statSync(cwd).mode & 0o777).toBe(0o700);

    const { prompt, options } = mockQuery.mock.calls[0]![0];
    expect(prompt).toBe("Is it done?");
    expect(options).toMatchObject({
      tools: [],
      mcpServers: {},
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      permissionMode: "default",
      cwd,
      maxBudgetUsd: 0.05,
      systemPrompt: "You judge.",
    });
    expect(options.outputFormat).toBeUndefined();
    expect(options.hooks).toBeUndefined();
    expect(options.abortController).toBeInstanceOf(AbortController);
  });

  it("uses structured_output when a schema is given", async () => {
    const schema = { type: "object", properties: { done: { type: "boolean" } } };
    mockQuery.mockReturnValue(stream([success("ignored text", { structured_output: { done: true } })]));
    const parse = vi.fn((v: unknown) => v as { done: boolean });
    const { value } = await runOneShot({ kind: "judge", model: "m", system: "s", prompt: "p", schema, parse, cwd: dir });
    expect(value).toEqual({ done: true });
    expect(parse).toHaveBeenCalledWith({ done: true });
    expect(mockQuery.mock.calls[0]![0].options.outputFormat).toEqual({ type: "json_schema", schema });
  });

  it("falls back to fenced JSON in the text when there is no structured_output", async () => {
    mockQuery.mockReturnValue(
      stream([
        { type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "```json\n[1]\n```" }] } },
        success(""),
      ]),
    );
    const { value, model } = await runOneShot({ kind: "oneshot", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir });
    expect(value).toEqual([1]);
    expect(model).toBe("claude-haiku-4-5");
  });

  it("applies the pipeline with the call kind and installs no hook", async () => {
    mockQuery.mockReturnValue(stream([success("[]")]));
    const pipeline = new SdkOptionsPipeline();
    const kinds: string[] = [];
    pipeline.registerContributor("account-env", (_o, ctx) => kinds.push(ctx.kind), 20);
    const events: string[] = [];
    pipeline.registerStreamObserver("t", (ev: SdkStreamEvent) => events.push(ev.type));
    await runOneShot({ kind: "triage", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir, sdkOptions: pipeline });
    expect(kinds).toEqual(["triage"]);
    const { options } = mockQuery.mock.calls[0]![0];
    expect(options.hooks).toBeUndefined();
    expect(options.permissionMode).toBe("default");
    expect(events).toEqual(["turn_start", "message", "turn_end"]);
  });

  it("an error result throws a OneShotError carrying the classified failure", async () => {
    mockQuery.mockReturnValue(
      stream([
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "You've hit your weekly limit · resets 5pm (Africa/Cairo)",
          total_cost_usd: 0,
          num_turns: 1,
        },
      ]),
    );
    const err = await runOneShot({ kind: "triage", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneShotError);
    expect((err as OneShotError).reason).toBe("failed");
    expect((err as OneShotError).failure?.class).toBe("usage_limit_account");
    expect((err as OneShotError).failure?.resetHint).toBe("5pm (Africa/Cairo)");
  });

  it("a thrown limit error is classified too", async () => {
    mockQuery.mockReturnValue(
      stream([], new Error("Claude Code returned an error result: You've hit your session limit · resets 4am (Africa/Cairo)")),
    );
    const err = (await runOneShot({ kind: "triage", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir }).catch((e: unknown) => e)) as OneShotError;
    expect(err.failure?.class).toBe("usage_limit_account");
  });

  it("times out by aborting the query", async () => {
    mockQuery.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        await new Promise<void>((_, reject) => {
          options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })(),
    );
    const err = (await runOneShot({ kind: "judge", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir, timeoutMs: 20 }).catch((e: unknown) => e)) as OneShotError;
    expect(err.reason).toBe("timeout");
  });

  it("unparseable text and a rejecting parse are 'parse' errors; no result is 'no_result'", async () => {
    mockQuery.mockReturnValue(stream([success("sure thing")]));
    const a = (await runOneShot({ kind: "oneshot", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir }).catch((e: unknown) => e)) as OneShotError;
    expect(a.reason).toBe("parse");

    mockQuery.mockReturnValue(stream([success("{}")]));
    const b = (await runOneShot({
      kind: "oneshot",
      model: "m",
      system: "s",
      prompt: "p",
      parse: () => {
        throw new Error("schema mismatch");
      },
      cwd: dir,
    }).catch((e: unknown) => e)) as OneShotError;
    expect(b.reason).toBe("parse");

    mockQuery.mockReturnValue(stream([]));
    const c = (await runOneShot({ kind: "oneshot", model: "m", system: "s", prompt: "p", parse: (v) => v, cwd: dir }).catch((e: unknown) => e)) as OneShotError;
    expect(c.reason).toBe("no_result");
  });

  it("defaults the working directory to <dataDir>/tmp/oneshot", () => {
    expect(defaultOneShotCwd("/data")).toBe("/data/tmp/oneshot");
  });
});
