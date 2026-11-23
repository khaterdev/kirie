/**
 * SdkOptionsPipeline: the one place that shapes SDK `Options` and gates tool
 * calls, for every `query()` call site (PLAN B.1).
 *
 * Each call site builds its base options, then calls `apply(options, ctx)`
 * immediately before `query()`, and feeds every SDK message to `observe(...)`.
 *
 * `apply` installs exactly one PreToolUse hook and one canUseTool for every
 * tool-capable call, even with no gates registered: a v2 session's options are
 * fixed when its subprocess starts, so the closures read the gate list at call
 * time. With only the built-in gates registered and nothing reserved being
 * called, the hook returns `{}` and the tool call is neither delayed nor altered.
 *
 * Only type imports from the SDK: engine tests mock the SDK module with `query`
 * alone, and a value import here would break them.
 */

import { randomUUID } from "node:crypto";
import { createModuleLogger } from "../logging/logger.js";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const log = createModuleLogger("sdk-options");

// ---------------------------------------------------------------------------
// Contract types (PLAN B.1)
// ---------------------------------------------------------------------------

export type SdkCallKind =
  | "chat"        // a conversation turn (v1 or v2), including injected schedule/loop turns
  | "background"  // background task, scheduled payload job, proactive escalation
  | "goal"        // goal worker (a background task with a goal controller)
  | "webhook"     // background task created by a webhook
  | "judge" | "triage" | "oneshot"   // no-tools model calls (always built with noToolsOptions)
  | "utility";    // a query opened by daemon code itself; never carries user or external content

export interface SdkCallContext {
  readonly kind: SdkCallKind;
  /** chat: channel:chatType:chatId. Task kinds: the originating chat's key. */
  readonly sessionKey?: string;
  readonly taskId?: string;
  readonly goalId?: string;
  readonly channel?: string;
  readonly chatType?: "dm" | "group" | "channel" | string;
  /** Role of the sender whose message opened the session (chat only). */
  readonly senderRole?: string;
  /** Chat session in a configured owner's DM. */
  readonly ownerDm: boolean;
  /** True only for kind "chat". */
  readonly interactive: boolean;
  /** For prompts and audit: 'chat telegram:dm', 'task 4682ecc4 "..."', 'goal g-ab12cd'. */
  readonly label: string;
  readonly cwd: string;
  /**
   * Addition to PLAN B.1: the task's `TaskProfile.toolAllowlist`, carried on
   * the context so the built-in `task-profile` gate can enforce it on every
   * call of that query, subagents included.
   */
  readonly toolAllowlist?: readonly string[];
}

/** Runs once per query() spawn. Synchronous. Mutates options in place. Must read live state itself. */
export type SdkOptionsContributor = (options: Options, ctx: SdkCallContext) => void;

export interface ToolGateCall {
  /** "Bash", "Write", "mcp__kirie-tools__send_message", ... */
  readonly tool: string;
  /** After updatedInput from earlier gates. */
  readonly input: Record<string, unknown>;
  readonly toolUseId: string;
  readonly cwd: string;
  readonly ctx: SdkCallContext;
  /** Set for subagent calls. */
  readonly agentId?: string;
  readonly agentType?: string;
}

export type ToolGateVerdict =
  | { decision: "pass"; updatedInput?: Record<string, unknown> }
  /** reason is shown to the model */
  | { decision: "deny"; reason: string }
  | {
      decision: "ask";
      summary: string;
      /** Called later from canUseTool. Waits for the owner. Must resolve, never reject. */
      resolve(signal: AbortSignal): Promise<{ approved: boolean; reason: string; interrupt?: boolean }>;
    };

export interface ToolGate {
  readonly name: string;
  /** Fixed numbers, see TOOL_GATE_ORDERS. */
  readonly order: number;
  /** Optional regex on tool name; gate is skipped when it does not match. */
  readonly matcher?: RegExp;
  check(call: ToolGateCall): ToolGateVerdict | Promise<ToolGateVerdict>;
}

/** Fire-and-forget. Can never change a verdict or delay a tool call. */
export interface ToolObserver {
  readonly name: string;
  pre?(call: ToolGateCall, verdict: "allowed" | "denied" | "asked"): void;
  post?(call: ToolGateCall, output: unknown): void;
}

export interface SdkTurnEndResult {
  isError: boolean;
  wasAborted: boolean;
  costUsd: number;
  numTurns: number;
  model?: string;
}

export type SdkStreamEvent =
  | { type: "turn_start"; ctx: SdkCallContext; userMessageUuid?: string; sdkSessionId?: string; accountId: string | null }
  | { type: "message"; ctx: SdkCallContext; message: SDKMessage }
  | {
      type: "turn_end";
      ctx: SdkCallContext;
      userMessageUuid?: string;
      sdkSessionId?: string;
      accountId: string | null;
      result: SdkTurnEndResult;
    };

/** Synchronous; a throw is caught and logged. */
export type SdkStreamObserver = (ev: SdkStreamEvent) => void;

// ---------------------------------------------------------------------------
// Fixed orders (PLAN B.1 tables). No other values may be used.
// ---------------------------------------------------------------------------

export const TOOL_GATE_ORDERS: Readonly<Record<string, number>> = {
  "reserved-mcp": 50,
  "task-profile": 60,
  "skill-write-guard": 100,
  "sandbox-path-guard": 200,
  "computer-use": 300,
  approvals: 900,
};

export const CONTRIBUTOR_ORDERS: Readonly<Record<string, number>> = {
  "core-defaults": 10,
  "account-env": 20,
  "fallback-model": 30,
  checkpointing: 40,
  sandbox: 50,
  "computer-use": 60,
  "voice-profile": 70,
};

/** External MCP server prefixes that are denied unless a feature claims them. */
export const RESERVED_MCP_PREFIXES: readonly string[] = ["mcp__cua-driver", "mcp__cua-computer-use"];

/** A gate chain that takes longer than this is a deny. */
export const GATE_CHAIN_TIMEOUT_MS = 10_000;
/** SDK-side timeout of the PreToolUse matcher, in seconds (a timed-out hook fails closed). */
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 30;
/** Reason given to the model when a gate throws or the chain times out. */
export const GATE_ERROR_REASON = "tool gate error";
/** Reason for refusing a permission request that no Kirie gate raised (see canUseTool). */
export const UNASKED_PERMISSION_REASON =
  "This action needs interactive permission, which is not available in this session.";

const NO_TOOL_KINDS: ReadonlySet<SdkCallKind> = new Set<SdkCallKind>(["judge", "triage", "oneshot"]);
const PENDING_ASK_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a hook matcher without overwriting what is already in options.hooks. */
export function addHook(options: Options, event: HookEvent, matcher: HookCallbackMatcher): void {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...(options.hooks ?? {}) };
  hooks[event] = [...(hooks[event] ?? []), matcher];
  options.hooks = hooks;
}

/** Context for a chat turn (v1 or v2). */
export function chatCallContext(input: {
  sessionKey: string;
  channel: string;
  chatType: string;
  senderRole?: string;
  cwd: string;
}): SdkCallContext {
  return {
    kind: "chat",
    sessionKey: input.sessionKey,
    channel: input.channel,
    chatType: input.chatType,
    ...(input.senderRole !== undefined ? { senderRole: input.senderRole } : {}),
    ownerDm: input.senderRole === "owner" && input.chatType === "dm",
    interactive: true,
    label: `chat ${input.channel}:${input.chatType}`,
    cwd: input.cwd,
  };
}

/**
 * The subagent tool has two names: the init message lists it as "Task", tool
 * calls and hook input use "Agent" (experiment E5). Anything that matches the
 * subagent tool must accept both.
 */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ["Agent", "Task"];

export function isSubagentTool(tool: string): boolean {
  return SUBAGENT_TOOL_NAMES.includes(tool);
}

/**
 * True when `tool` is on an allowlist of exact names or "prefix*" entries.
 * "Agent" and "Task" are treated as the same tool.
 */
export function toolMatchesAllowlist(tool: string, allowlist: readonly string[]): boolean {
  const names = isSubagentTool(tool) ? SUBAGENT_TOOL_NAMES : [tool];
  return allowlist.some((entry) =>
    names.some((name) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function gateMatches(gate: ToolGate, tool: string): boolean {
  if (!gate.matcher) return true;
  gate.matcher.lastIndex = 0;
  return gate.matcher.test(tool);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CollectedAsk {
  gate: string;
  summary: string;
  resolve(signal: AbortSignal): Promise<{ approved: boolean; reason: string; interrupt?: boolean }>;
}

type ChainOutcome =
  | { kind: "deny"; gate: string; reason: string }
  | { kind: "pass"; input: Record<string, unknown>; changed: boolean; asks: CollectedAsk[] };

interface PendingAsk {
  asks: CollectedAsk[];
  input: Record<string, unknown>;
  createdAt: number;
}

class ChainTimeout extends Error {}

export interface SdkOptionsPipelineOptions {
  /** Live value of `agent.strictMcpConfig`. Read at every spawn. Default: never strict. */
  strictMcpConfig?: () => boolean;
  /** Override the 10 s chain timeout (tests). */
  chainTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export class SdkOptionsPipeline {
  private readonly contributors: Array<{ name: string; fn: SdkOptionsContributor; order: number }> = [];
  private gates: ToolGate[] = [];
  private readonly toolObservers: ToolObserver[] = [];
  private readonly streamObservers = new Map<string, SdkStreamObserver>();
  private readonly reservedPrefixes = new Set<string>();
  private readonly claims = new Map<string, (ctx: SdkCallContext) => boolean>();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private readonly chainTimeoutMs: number;
  private readonly strictMcpConfig: () => boolean;

  constructor(opts: SdkOptionsPipelineOptions = {}) {
    this.chainTimeoutMs = opts.chainTimeoutMs ?? GATE_CHAIN_TIMEOUT_MS;
    this.strictMcpConfig = opts.strictMcpConfig ?? (() => false);

    for (const prefix of RESERVED_MCP_PREFIXES) this.reserveMcpPrefix(prefix);

    this.registerContributor("core-defaults", (options) => this.applyCoreDefaults(options), 10);
    this.registerGate({
      name: "reserved-mcp",
      order: 50,
      check: (call) => this.checkReservedMcp(call),
    });
    this.registerGate({
      name: "task-profile",
      order: 60,
      check: (call) => {
        const allowlist = call.ctx.toolAllowlist;
        if (!allowlist || toolMatchesAllowlist(call.tool, allowlist)) return { decision: "pass" };
        return { decision: "deny", reason: `The tool ${call.tool} is not allowed for this task.` };
      },
    });
  }

  // ── Registration ────────────────────────────────────────────────────────

  registerContributor(name: string, fn: SdkOptionsContributor, order: number): void {
    if (this.contributors.some((c) => c.name === name)) {
      throw new Error(`SDK options contributor "${name}" is already registered`);
    }
    if (CONTRIBUTOR_ORDERS[name] !== order) {
      throw new Error(`SDK options contributor "${name}" must use its fixed order from PLAN B.1 (got ${order})`);
    }
    this.contributors.push({ name, fn, order });
    this.contributors.sort((a, b) => a.order - b.order);
  }

  registerGate(gate: ToolGate): void {
    if (this.gates.some((g) => g.name === gate.name)) {
      throw new Error(`tool gate "${gate.name}" is already registered`);
    }
    if (TOOL_GATE_ORDERS[gate.name] !== gate.order) {
      throw new Error(`tool gate "${gate.name}" must use its fixed order from PLAN B.1 (got ${gate.order})`);
    }
    // Replace the array so a chain already running keeps its own snapshot.
    this.gates = [...this.gates, gate].sort((a, b) => a.order - b.order);
  }

  unregisterGate(name: string): void {
    this.gates = this.gates.filter((g) => g.name !== name);
  }

  registerToolObserver(obs: ToolObserver): void {
    if (this.toolObservers.some((o) => o.name === obs.name)) {
      throw new Error(`tool observer "${obs.name}" is already registered`);
    }
    this.toolObservers.push(obs);
  }

  registerStreamObserver(name: string, fn: SdkStreamObserver): void {
    if (this.streamObservers.has(name)) {
      throw new Error(`stream observer "${name}" is already registered`);
    }
    this.streamObservers.set(name, fn);
  }

  /** Reserve an external MCP server prefix ("mcp__cua-driver"). Calls to it are denied unless a claim callback says yes. */
  reserveMcpPrefix(prefix: string): void {
    this.reservedPrefixes.add(prefix);
  }

  /** Allow calls to a reserved prefix for the contexts `allowed` accepts. Also reserves the prefix. */
  claimMcpPrefix(prefix: string, allowed: (ctx: SdkCallContext) => boolean): void {
    if (this.claims.has(prefix)) throw new Error(`MCP prefix "${prefix}" is already claimed`);
    this.reservedPrefixes.add(prefix);
    this.claims.set(prefix, allowed);
  }

  /** Names of the registered gates, in chain order. */
  gateNames(): string[] {
    return this.gates.map((g) => g.name);
  }

  // ── apply / observe / evaluate ─────────────────────────────────────────

  apply(options: Options, ctx: SdkCallContext): Options {
    for (const c of this.contributors) {
      try {
        c.fn(options, ctx);
      } catch (err) {
        log.error({ contributor: c.name, label: ctx.label, err }, "SDK options contributor failed");
        throw new Error(`SDK options contributor "${c.name}" failed: ${errorMessage(err)}`);
      }
    }

    if (NO_TOOL_KINDS.has(ctx.kind)) return options;

    if (options.canUseTool) {
      log.warn({ label: ctx.label }, "replacing a canUseTool set by the call site; the pipeline owns canUseTool");
    }
    addHook(options, "PreToolUse", {
      hooks: [this.preToolUseHook(ctx)],
      timeout: PRE_TOOL_USE_TIMEOUT_SECONDS,
    });
    options.canUseTool = this.canUseToolFor(ctx);

    if (this.toolObservers.some((o) => o.post)) {
      addHook(options, "PostToolUse", { hooks: [this.postToolUseHook(ctx)] });
    }
    return options;
  }

  observe(ev: SdkStreamEvent): void {
    for (const [name, fn] of this.streamObservers) {
      try {
        fn(ev);
      } catch (err) {
        log.error({ observer: name, event: ev.type, err }, "stream observer threw");
      }
    }
  }

  /**
   * Run the gate chain for a call that daemon code is about to make itself.
   * Never prompts: an "ask" is reported, not resolved.
   */
  async evaluate(call: Omit<ToolGateCall, "toolUseId">): Promise<{ decision: "pass" | "deny" | "ask"; reasons: string[] }> {
    const outcome = await this.runChain({ ...call, toolUseId: `evaluate-${randomUUID()}` });
    if (outcome.kind === "deny") return { decision: "deny", reasons: [outcome.reason] };
    if (outcome.asks.length > 0) return { decision: "ask", reasons: outcome.asks.map((a) => a.summary) };
    return { decision: "pass", reasons: [] };
  }

  // ── Built-ins ──────────────────────────────────────────────────────────

  private reservedPrefixOf(tool: string): string | undefined {
    for (const prefix of this.reservedPrefixes) {
      if (tool === prefix || tool.startsWith(`${prefix}__`)) return prefix;
    }
    return undefined;
  }

  private claimAllows(prefix: string, ctx: SdkCallContext): boolean {
    const claim = this.claims.get(prefix);
    if (!claim) return false;
    try {
      return claim(ctx) === true;
    } catch (err) {
      log.error({ prefix, label: ctx.label, err }, "MCP prefix claim callback threw; treating as not allowed");
      return false;
    }
  }

  private checkReservedMcp(call: ToolGateCall): ToolGateVerdict {
    const prefix = this.reservedPrefixOf(call.tool);
    if (!prefix || this.claimAllows(prefix, call.ctx)) return { decision: "pass" };
    return { decision: "deny", reason: `The tool ${call.tool} is not available in this session.` };
  }

  /**
   * Only `strictMcpConfig`. Reserved MCP prefixes are not appended to
   * `disallowedTools`: experiment E8 showed a server-level name there hides
   * nothing, so the `reserved-mcp` gate is the binding control.
   */
  private applyCoreDefaults(options: Options): void {
    if (this.strictMcpConfig()) options.strictMcpConfig = true;
  }

  // ── The gate chain ─────────────────────────────────────────────────────

  /**
   * Gates run in ascending order. The first deny ends the chain. A pass with
   * updatedInput replaces the input for later gates. Asks are collected.
   * A throwing gate or a chain over the time limit is a deny.
   */
  private async runChain(call: ToolGateCall): Promise<ChainOutcome> {
    const gates = this.gates;
    const deadline = Date.now() + this.chainTimeoutMs;
    let input = call.input;
    let changed = false;
    const asks: CollectedAsk[] = [];

    for (const gate of gates) {
      if (!gateMatches(gate, call.tool)) continue;

      let verdict: ToolGateVerdict;
      try {
        const result = gate.check({ ...call, input });
        verdict = isPromiseLike(result) ? await withDeadline(result, deadline) : result;
        if (Date.now() > deadline) throw new ChainTimeout();
      } catch (err) {
        if (err instanceof ChainTimeout) {
          log.error({ gate: gate.name, tool: call.tool, label: call.ctx.label }, "tool gate chain timed out; denying");
        } else {
          log.error({ gate: gate.name, tool: call.tool, label: call.ctx.label, err }, "tool gate threw; denying");
        }
        return { kind: "deny", gate: gate.name, reason: GATE_ERROR_REASON };
      }

      if (verdict.decision === "deny") return { kind: "deny", gate: gate.name, reason: verdict.reason };
      if (verdict.decision === "ask") {
        asks.push({ gate: gate.name, summary: verdict.summary, resolve: verdict.resolve });
      } else if (verdict.updatedInput) {
        input = verdict.updatedInput;
        changed = true;
      }
    }

    return { kind: "pass", input, changed, asks };
  }

  private preToolUseHook(ctx: SdkCallContext): HookCallback {
    return async (hookInput, toolUseID): Promise<HookJSONOutput> => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};

      const call: ToolGateCall = {
        tool: hookInput.tool_name,
        input: isRecord(hookInput.tool_input) ? hookInput.tool_input : {},
        toolUseId: hookInput.tool_use_id || toolUseID || "",
        cwd: hookInput.cwd || ctx.cwd,
        ctx,
        ...(hookInput.agent_id ? { agentId: hookInput.agent_id } : {}),
        ...(hookInput.agent_type ? { agentType: hookInput.agent_type } : {}),
      };

      const outcome = await this.runChain(call);

      if (outcome.kind === "deny") {
        this.notifyPre(call, "denied");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: outcome.reason,
          },
        };
      }

      const finalCall = outcome.changed ? { ...call, input: outcome.input } : call;

      if (outcome.asks.length > 0) {
        this.storeAsk(call.toolUseId, { asks: outcome.asks, input: outcome.input, createdAt: Date.now() });
        this.notifyPre(finalCall, "asked");
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: outcome.asks.map((a) => a.summary).join("; "),
            ...(outcome.changed ? { updatedInput: outcome.input } : {}),
          },
        };
      }

      this.notifyPre(finalCall, "allowed");
      if (outcome.changed) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: outcome.input,
          },
        };
      }
      return {};
    };
  }

  private canUseToolFor(ctx: SdkCallContext): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      const pending = this.takeAsk(opts.toolUseID);
      let asks: CollectedAsk[];
      let finalInput: Record<string, unknown>;

      if (pending) {
        asks = pending.asks;
        finalInput = pending.input;
      } else {
        // No gate asked for this call, so the request comes from the CLI
        // itself (a settings ask rule, a safety check, a tool that always
        // asks). Re-run the chain so a deny or an ask still applies; a plain
        // pass is refused, which is what a headless session without
        // canUseTool did before the pipeline existed.
        const outcome = await this.runChain({
          tool: toolName,
          input,
          toolUseId: opts.toolUseID,
          cwd: ctx.cwd,
          ctx,
          ...(opts.agentID ? { agentId: opts.agentID } : {}),
        });
        if (outcome.kind === "deny") return { behavior: "deny", message: outcome.reason };
        if (outcome.asks.length === 0) {
          log.info(
            { tool: toolName, label: ctx.label, decisionReason: opts.decisionReason },
            "permission request not raised by a Kirie gate; refusing as before",
          );
          return { behavior: "deny", message: UNASKED_PERMISSION_REASON };
        }
        asks = outcome.asks;
        finalInput = outcome.input;
      }

      for (const ask of asks) {
        let answer: { approved: boolean; reason: string; interrupt?: boolean };
        try {
          answer = await ask.resolve(opts.signal);
        } catch (err) {
          log.error({ gate: ask.gate, tool: toolName, label: ctx.label, err }, "ask resolver rejected; denying");
          answer = { approved: false, reason: GATE_ERROR_REASON };
        }
        if (!answer.approved) {
          return {
            behavior: "deny",
            message: answer.reason,
            ...(answer.interrupt ? { interrupt: true } : {}),
          };
        }
      }

      return { behavior: "allow", updatedInput: finalInput };
    };
  }

  private postToolUseHook(ctx: SdkCallContext): HookCallback {
    return async (hookInput, toolUseID): Promise<HookJSONOutput> => {
      if (hookInput.hook_event_name !== "PostToolUse") return {};
      const call: ToolGateCall = {
        tool: hookInput.tool_name,
        input: isRecord(hookInput.tool_input) ? hookInput.tool_input : {},
        toolUseId: hookInput.tool_use_id || toolUseID || "",
        cwd: hookInput.cwd || ctx.cwd,
        ctx,
        ...(hookInput.agent_id ? { agentId: hookInput.agent_id } : {}),
        ...(hookInput.agent_type ? { agentType: hookInput.agent_type } : {}),
      };
      const output = hookInput.tool_response;
      for (const obs of this.toolObservers) {
        if (!obs.post) continue;
        const post = obs.post.bind(obs);
        setImmediate(() => runObserver(obs.name, () => post(call, output)));
      }
      return {};
    };
  }

  private notifyPre(call: ToolGateCall, verdict: "allowed" | "denied" | "asked"): void {
    for (const obs of this.toolObservers) {
      if (!obs.pre) continue;
      const pre = obs.pre.bind(obs);
      setImmediate(() => runObserver(obs.name, () => pre(call, verdict)));
    }
  }

  private storeAsk(toolUseId: string, ask: PendingAsk): void {
    const cutoff = Date.now() - PENDING_ASK_TTL_MS;
    for (const [id, entry] of this.pendingAsks) {
      if (entry.createdAt < cutoff) this.pendingAsks.delete(id);
    }
    this.pendingAsks.set(toolUseId, ask);
  }

  private takeAsk(toolUseId: string): PendingAsk | undefined {
    const ask = this.pendingAsks.get(toolUseId);
    if (ask) this.pendingAsks.delete(toolUseId);
    return ask;
  }
}

function runObserver(name: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      result.then(undefined, (err: unknown) => log.error({ observer: name, err }, "tool observer rejected"));
    }
  } catch (err) {
    log.error({ observer: name, err }, "tool observer threw");
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ChainTimeout());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChainTimeout()), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// The SDK's canUseTool-shadowed warning
// ---------------------------------------------------------------------------

/**
 * Code of the Node warning the SDK prints whenever `canUseTool` is set under
 * `bypassPermissions`. The pipeline sets it on purpose (an "ask" from the
 * PreToolUse hook still reaches it), so the warning is noise on every spawn.
 */
export const CAN_USE_TOOL_SHADOWED_WARNING = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";

const FILTER_MARK = Symbol.for("kirie.canUseToolWarningFilter");

interface WarningTarget {
  emitWarning: (...args: never[]) => void;
}

function isShadowedWarning(args: readonly unknown[]): boolean {
  const [warning, second, third] = args;
  if (warning instanceof Error && (warning as Error & { code?: unknown }).code === CAN_USE_TOOL_SHADOWED_WARNING) {
    return true;
  }
  if (typeof second === "object" && second !== null && (second as { code?: unknown }).code === CAN_USE_TOOL_SHADOWED_WARNING) {
    return true;
  }
  return third === CAN_USE_TOOL_SHADOWED_WARNING;
}

/**
 * Wrap `process.emitWarning` so it drops exactly the
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning and passes everything else through.
 * Installing twice is a no-op. Returns a function that removes the wrapper.
 */
export function installCanUseToolWarningFilter(target: WarningTarget = process as unknown as WarningTarget): () => void {
  const current = target.emitWarning as WarningTarget["emitWarning"] & { [FILTER_MARK]?: () => void };
  const existing = current[FILTER_MARK];
  if (existing) return existing;

  const original = current;
  const filtered = function (this: unknown, ...args: unknown[]): void {
    if (isShadowedWarning(args)) return;
    (original as (...a: unknown[]) => void).apply(this, args);
  } as WarningTarget["emitWarning"] & { [FILTER_MARK]?: () => void };

  const uninstall = (): void => {
    if (target.emitWarning === filtered) target.emitWarning = original;
  };
  filtered[FILTER_MARK] = uninstall;
  target.emitWarning = filtered;
  return uninstall;
}
