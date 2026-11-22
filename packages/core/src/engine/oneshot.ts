/**
 * No-tools model calls: triage, judges and other one-shot classifications
 * (PLAN B.3).
 *
 * `noToolsOptions` removes every way the model could act: no built-in tools,
 * no MCP servers, no settings files (so no user-scope MCP servers or hooks),
 * a deny-all `canUseTool`, and no persisted transcript. The call runs in an
 * empty directory under `<dataDir>/tmp/oneshot`.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { classifyFailure, feedTurnSignals, logSdkSignal, newTurnSignals, type FailureInfo } from "./failure.js";
import type { SdkCallContext, SdkOptionsPipeline } from "./sdk-options.js";

const log = pino({ name: "oneshot" });

const DEFAULT_MAX_TURNS = 3;

/**
 * The SDK adds its own `StructuredOutput` tool when `outputFormat` is set
 * (experiment E7); that is how `structured_output` is delivered. It is the
 * one tool a no-tools call may use. The SDK handles it internally today, so
 * this exception only matters if that ever routes through canUseTool.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const denyAllTools: CanUseTool = async (toolName, input) =>
  toolName === STRUCTURED_OUTPUT_TOOL
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "No tools are available for this call." };

export function noToolsOptions(base: { model: string; systemPrompt: string; cwd: string; maxTurns?: number }): Options {
  return {
    model: base.model,
    systemPrompt: base.systemPrompt,
    cwd: base.cwd,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    allowedTools: [],
    permissionMode: "default",
    canUseTool: denyAllTools,
    persistSession: false,
    maxTurns: base.maxTurns ?? DEFAULT_MAX_TURNS,
  };
}

/** `<dataDir>/tmp/oneshot`; dataDir defaults to ~/.kirie. */
export function defaultOneShotCwd(dataDir: string = join(homedir(), ".kirie")): string {
  return join(dataDir, "tmp", "oneshot");
}

/** Create the one-shot directory (0700) if needed and return it. */
export function ensureOneShotCwd(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    log.warn({ dir, err }, "could not set one-shot directory mode");
  }
  return dir;
}

export type OneShotErrorReason = "failed" | "timeout" | "no_result" | "parse";

/** A one-shot call that did not produce a usable value. */
export class OneShotError extends Error {
  readonly reason: OneShotErrorReason;
  readonly failure: FailureInfo | undefined;
  readonly costUsd: number;

  constructor(message: string, reason: OneShotErrorReason, failure?: FailureInfo, costUsd = 0, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OneShotError";
    this.reason = reason;
    this.failure = failure;
    this.costUsd = costUsd;
  }
}

/**
 * Read JSON out of model text: the whole text, then with code fences
 * stripped, then the outermost [...] or {...}. Throws when none parses.
 */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const attempts = [trimmed];
  if (trimmed.startsWith("```")) {
    attempts.push(trimmed.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim());
  }
  const firstBracket = trimmed.search(/[[{]/);
  const lastBracket = Math.max(trimmed.lastIndexOf("]"), trimmed.lastIndexOf("}"));
  if (firstBracket >= 0 && lastBracket > firstBracket) attempts.push(trimmed.slice(firstBracket, lastBracket + 1));

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next shape
    }
  }
  throw new SyntaxError("model response is not valid JSON");
}

export async function runOneShot<T>(opts: {
  kind: "judge" | "triage" | "oneshot";
  model: string;
  system: string;
  prompt: string;
  /** JSON schema -> outputFormat json_schema */
  schema?: Record<string, unknown>;
  /** Zod parse. Text fallback: strip code fences, JSON.parse */
  parse: (value: unknown) => T;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  label?: string;
  sdkOptions?: SdkOptionsPipeline;
  /** Addition to PLAN B.3: working directory. Default `~/.kirie/tmp/oneshot`. */
  cwd?: string;
  /** Addition to PLAN B.3: turn cap. Default 3. */
  maxTurns?: number;
}): Promise<{ value: T; costUsd: number; model?: string }> {
  const label = opts.label ?? opts.kind;
  const cwd = ensureOneShotCwd(opts.cwd ?? defaultOneShotCwd());
  const options = noToolsOptions({
    model: opts.model,
    systemPrompt: opts.system,
    cwd,
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  });
  if (opts.schema) options.outputFormat = { type: "json_schema", schema: opts.schema };
  if (opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = opts.maxBudgetUsd;
  const abortController = new AbortController();
  options.abortController = abortController;

  const ctx: SdkCallContext = { kind: opts.kind, ownerDm: false, interactive: false, label, cwd };
  opts.sdkOptions?.apply(options, ctx);

  const signals = newTurnSignals();
  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, opts.timeoutMs)
      : undefined;

  let assistantText = "";
  let resultText: string | undefined;
  let structured: unknown;
  let costUsd = 0;
  let numTurns = 0;
  let isError = false;
  let gotResult = false;

  const endTurn = (failed: boolean, aborted: boolean): void => {
    opts.sdkOptions?.observe({
      type: "turn_end",
      ctx,
      accountId: null,
      result: {
        isError: failed,
        wasAborted: aborted,
        costUsd,
        numTurns,
        ...(signals.model ? { model: signals.model } : {}),
      },
    });
  };

  opts.sdkOptions?.observe({ type: "turn_start", ctx, accountId: null });

  try {
    const stream = query({ prompt: opts.prompt, options });
    for await (const msg of stream) {
      opts.sdkOptions?.observe({ type: "message", ctx, message: msg });
      feedTurnSignals(signals, msg);
      logSdkSignal(log, label, msg);

      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (msg.type === "result") {
        gotResult = true;
        costUsd = msg.total_cost_usd ?? 0;
        numTurns = msg.num_turns ?? 0;
        isError = msg.is_error === true;
        if (msg.subtype === "success") {
          resultText = msg.result;
          structured = msg.structured_output;
        } else {
          resultText = msg.errors?.join("\n");
        }
      }
    }
  } catch (err) {
    endTurn(true, timedOut);
    if (timedOut) {
      throw new OneShotError(`${label} timed out after ${opts.timeoutMs} ms`, "timeout", undefined, costUsd, err);
    }
    const failure = classifyFailure({ error: err, signals, ...(resultText ? { text: resultText } : {}) }) ?? undefined;
    throw new OneShotError(`${label} failed (${failure?.class ?? "unknown"})`, "failed", failure, costUsd, err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  endTurn(isError || !gotResult, false);

  if (!gotResult) {
    throw new OneShotError(`${label} ended without a result`, "no_result", undefined, costUsd);
  }
  if (isError) {
    const failure = classifyFailure({ text: resultText || assistantText, signals }) ?? {
      class: "unknown",
      message: "error result",
    };
    throw new OneShotError(`${label} returned an error result (${failure.class})`, "failed", failure, costUsd);
  }

  let raw: unknown;
  if (structured !== undefined) {
    raw = structured;
  } else {
    try {
      raw = parseJsonText(resultText || assistantText);
    } catch (err) {
      throw new OneShotError(`${label} response was not valid JSON`, "parse", undefined, costUsd, err);
    }
  }

  let value: T;
  try {
    value = opts.parse(raw);
  } catch (err) {
    throw new OneShotError(`${label} response did not match the expected shape`, "parse", undefined, costUsd, err);
  }

  return {
    value,
    costUsd,
    ...(signals.model ? { model: signals.model } : {}),
  };
}
