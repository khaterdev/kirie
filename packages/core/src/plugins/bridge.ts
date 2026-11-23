/**
 * Plugin hook dispatch through the shared seams (PLAN C.15, B.1, B.14).
 * No pipeline or engine code knows about plugins.
 *
 * | Event                 | Seam                                                   | Awaited |
 * |-----------------------|--------------------------------------------------------|---------|
 * | beforeMessage         | pipeline.setMessageTransform (text only, budgeted)     | yes, at most hookTimeoutMs |
 * | afterMessage          | pipeline.onTurnComplete                                | no      |
 * | onError               | pipeline.onTurnError ({ name, message })               | no      |
 * | beforeToolUse/after…  | one ToolObserver on the SdkOptionsPipeline             | no      |
 * | onChannelConnect/Disc | channelRegistry "started" / "stopped" / "error"        | no      |
 *
 * The tool observer runs after the gate chain's verdict and cannot change it,
 * delay it, or rewrite the input: ToolObserver is fire-and-forget by contract,
 * and the registry hands plugins frozen copies.
 */

import type { ChannelRegistryEvents } from "../channels/registry.js";
import type { ToolGateCall, ToolObserver } from "../engine/sdk-options.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { BeforeMessageEvent } from "../hooks/types.js";
import { createModuleLogger } from "../logging/logger.js";
import type { MessageTransform, TurnCompleteEvent, TurnErrorEvent } from "../routing/pipeline.js";
import { parseSessionKey } from "../routing/session-key.js";

const log = createModuleLogger("plugin-bridge");

/** Name of the one tool observer plugins get. */
export const PLUGIN_TOOL_OBSERVER_NAME = "plugins";

const MAX_TRACKED_INPUTS = 500;
const MAX_TRACKED_TOOL_CALLS = 1_000;
/** Slack on top of the registry's own budget before the outer guard gives up. */
const TRANSFORM_GUARD_SLACK_MS = 250;

export interface PluginBridgeDeps {
  registry: HookRegistry;
  pipeline: {
    setMessageTransform(fn: MessageTransform | null): void;
    onTurnComplete(listener: (ev: TurnCompleteEvent) => void): () => void;
    onTurnError(listener: (ev: TurnErrorEvent) => void): () => void;
  };
  channelRegistry: {
    on<K extends keyof ChannelRegistryEvents>(event: K, listener: ChannelRegistryEvents[K]): void;
    off<K extends keyof ChannelRegistryEvents>(event: K, listener: ChannelRegistryEvents[K]): void;
  };
  sdkOptions: { registerToolObserver(obs: ToolObserver): void };
  hookTimeoutMs: number;
}

export class PluginHookBridge {
  private active = false;
  private observerRegistered = false;
  private unsubscribers: Array<() => void> = [];
  private readonly inputs = new Map<string, string>();
  private readonly toolStarts = new Map<string, number>();

  readonly toolObserver: ToolObserver = {
    name: PLUGIN_TOOL_OBSERVER_NAME,
    pre: (call, verdict) => this.onToolPre(call, verdict),
    post: (call, output) => this.onToolPost(call, output),
  };

  private readonly transform: MessageTransform = (text, meta) => this.runTransform(text, meta);
  private readonly onStarted = (id: string): void => this.emitSafe(() => this.deps.registry.emit({ type: "onChannelConnect", channel: id }));
  private readonly onStopped = (id: string): void => this.emitSafe(() => this.deps.registry.emit({ type: "onChannelDisconnect", channel: id }));
  private readonly onChannelError = (id: string, error: Error): void =>
    this.emitSafe(() => this.deps.registry.emit({ type: "onChannelDisconnect", channel: id, reason: error?.message ?? "error" }));

  constructor(private readonly deps: PluginBridgeDeps) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Register the tool observer if it is not registered yet. Returns true when
   * it was added now: v2 sessions started before this only get the PostToolUse
   * hook after they restart (close idle sessions).
   */
  ensureToolObserver(): boolean {
    if (this.observerRegistered) return false;
    this.deps.sdkOptions.registerToolObserver(this.toolObserver);
    this.observerRegistered = true;
    return true;
  }

  /** Start routing seam events into the registry. Idempotent. */
  activate(): { observerAdded: boolean } {
    const observerAdded = this.ensureToolObserver();
    if (this.active) return { observerAdded };
    this.active = true;
    this.deps.pipeline.setMessageTransform(this.transform);
    this.unsubscribers.push(this.deps.pipeline.onTurnComplete((ev) => this.onTurnComplete(ev)));
    this.unsubscribers.push(this.deps.pipeline.onTurnError((ev) => this.onTurnError(ev)));
    this.deps.channelRegistry.on("started", this.onStarted);
    this.deps.channelRegistry.on("stopped", this.onStopped);
    this.deps.channelRegistry.on("error", this.onChannelError);
    this.unsubscribers.push(() => {
      this.deps.channelRegistry.off("started", this.onStarted);
      this.deps.channelRegistry.off("stopped", this.onStopped);
      this.deps.channelRegistry.off("error", this.onChannelError);
    });
    return { observerAdded };
  }

  /** Stop routing. The tool observer stays registered (the seam has no removal) but does nothing. */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.deps.pipeline.setMessageTransform(null);
    for (const u of this.unsubscribers.splice(0)) {
      try {
        u();
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message : String(err) }, "unsubscribe failed (ignored)");
      }
    }
    this.inputs.clear();
    this.toolStarts.clear();
  }

  /** The beforeMessage transform. Never throws, never takes much longer than the hook budget. */
  private async runTransform(text: string, meta: { sessionKey: string; channel: string; senderId: string }): Promise<string> {
    if (!this.active) return text;
    const registry = this.deps.registry;
    let out = text;
    if (registry.hasSubscribers("beforeMessage")) {
      const event: BeforeMessageEvent = {
        type: "beforeMessage",
        sessionKey: meta.sessionKey,
        channel: meta.channel,
        senderId: meta.senderId,
        ...chatIdOf(meta.sessionKey),
        text,
        timestamp: Date.now(),
      };
      try {
        const result = await guard(registry.dispatch(event), this.deps.hookTimeoutMs + TRANSFORM_GUARD_SLACK_MS);
        out = result === null ? text : result.text;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "beforeMessage dispatch failed (text unchanged)");
        out = text;
      }
    }
    if (registry.hasSubscribers("afterMessage")) this.trackInput(meta.sessionKey, out);
    return out;
  }

  private onTurnComplete(ev: TurnCompleteEvent): void {
    const inputText = this.inputs.get(ev.sessionKey);
    this.inputs.delete(ev.sessionKey);
    if (!this.active || !this.deps.registry.hasSubscribers("afterMessage")) return;
    this.emitSafe(() => this.deps.registry.emit({
      type: "afterMessage",
      sessionKey: ev.sessionKey,
      channel: ev.channel,
      senderId: ev.senderId,
      ...chatIdOf(ev.sessionKey),
      origin: ev.origin,
      ...(inputText !== undefined ? { inputText } : {}),
      responseText: ev.result.response,
      isError: ev.result.isError,
      durationMs: ev.durationMs,
    }));
  }

  private onTurnError(ev: TurnErrorEvent): void {
    this.inputs.delete(ev.sessionKey);
    if (!this.active) return;
    this.emitSafe(() => this.deps.registry.emit({
      type: "onError",
      source: "pipeline",
      sessionKey: ev.sessionKey,
      name: ev.name,
      message: ev.message,
    }));
  }

  private onToolPre(call: ToolGateCall, verdict: "allowed" | "denied" | "asked"): void {
    if (!this.active) return;
    const registry = this.deps.registry;
    if (verdict !== "denied" && registry.hasSubscribers("afterToolUse") && call.toolUseId) {
      if (this.toolStarts.size >= MAX_TRACKED_TOOL_CALLS) {
        const oldest = this.toolStarts.keys().next().value;
        if (oldest !== undefined) this.toolStarts.delete(oldest);
      }
      this.toolStarts.set(call.toolUseId, Date.now());
    }
    if (!registry.hasSubscribers("beforeToolUse")) return;
    registry.emit({
      type: "beforeToolUse",
      toolName: call.tool,
      params: call.input,
      verdict,
      toolUseId: call.toolUseId,
      kind: call.ctx.kind,
      ...(call.ctx.sessionKey ? { sessionKey: call.ctx.sessionKey } : {}),
    });
  }

  private onToolPost(call: ToolGateCall, output: unknown): void {
    const started = call.toolUseId ? this.toolStarts.get(call.toolUseId) : undefined;
    if (call.toolUseId) this.toolStarts.delete(call.toolUseId);
    if (!this.active || !this.deps.registry.hasSubscribers("afterToolUse")) return;
    this.deps.registry.emit({
      type: "afterToolUse",
      toolName: call.tool,
      params: call.input,
      result: output,
      toolUseId: call.toolUseId,
      kind: call.ctx.kind,
      ...(call.ctx.sessionKey ? { sessionKey: call.ctx.sessionKey } : {}),
      ...(started !== undefined ? { durationMs: Date.now() - started } : {}),
    });
  }

  private trackInput(sessionKey: string, text: string): void {
    this.inputs.delete(sessionKey);
    if (this.inputs.size >= MAX_TRACKED_INPUTS) {
      const oldest = this.inputs.keys().next().value;
      if (oldest !== undefined) this.inputs.delete(oldest);
    }
    this.inputs.set(sessionKey, text);
  }

  private emitSafe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "plugin event dispatch failed (ignored)");
    }
  }
}

function chatIdOf(sessionKey: string): { chatId?: string } {
  const parts = parseSessionKey(sessionKey);
  return parts ? { chatId: parts.chatId } : {};
}

/** Resolve with the value, or null when it takes longer than ms. */
function guard<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}
