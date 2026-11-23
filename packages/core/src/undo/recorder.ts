/**
 * Recording side of undo (PLAN C.11): the `checkpointing` options
 * contributor (order 40) and a stream observer that writes the ledger.
 *
 * The contributor turns on SDK file checkpointing for chat spawns and (with
 * `undo.backgroundTasks`) task spawns while undo is effective-on, and
 * remembers, per call context, the config dir the process is spawned under
 * (from `options.env`, set by the engine's account lease before `apply`).
 * Engines hand the same context object to `apply` and to every stream event
 * of that process, so the observer knows whether a turn has checkpoints and
 * where its backups live. A turn from a process spawned with checkpointing off
 * is never recorded: it has nothing to rewind.
 *
 * Per turn the observer records the client-stamped user message uuid (the
 * rewind target, E3), the SDK session id, the account, the paths written by
 * Write / Edit / NotebookEdit (subagent edits kept apart: the SDK may not
 * track them), which of those files the turn created (a rewind deletes them),
 * and the shell commands it ran (count plus three scrubbed samples).
 */

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { SdkCallContext, SdkCallKind, SdkStreamEvent } from "../engine/sdk-options.js";
import { UNDO_MAX_BASH_SAMPLES, UNDO_MAX_PATHS_PER_ROW, type UndoCheckpointStore } from "./checkpoint-store.js";

const log = createModuleLogger("undo-recorder");

export const UNDO_CONTRIBUTOR_NAME = "checkpointing";
export const UNDO_CONTRIBUTOR_ORDER = 40;
export const UNDO_OBSERVER_NAME = "undo-ledger";

/** Tools whose edits SDK checkpointing tracks */
export const UNDO_FILE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Task kinds checkpointed when `undo.backgroundTasks` is on */
export const UNDO_TASK_KINDS: ReadonlySet<SdkCallKind> = new Set<SdkCallKind>(["background", "goal", "webhook"]);
const PREVIEW_CHARS = 80;
const BASH_SAMPLE_CHARS = 80;
/** In-flight turns remembered by uuid; a turn that never ends is dropped after this many newer ones */
const MAX_OPEN_TURNS = 500;
/** The Write tool's result text for a file that did not exist before */
const CREATED_RESULT_RE = /^\s*File created successfully/i;

/** What the contributor saw when a process was spawned with checkpointing on. */
interface SpawnInfo {
  configDir: string | null;
  /** Latest SDK session id seen on this process's stream */
  sdkSessionId: string | null;
}

interface OpenTurn {
  rowId: number;
  uuid: string;
  hasSessionId: boolean;
  files: Set<string>;
  created: Set<string>;
  subagent: Set<string>;
  /** Write tool_use id -> path, to read the "created" marker from its result */
  writes: Map<string, string>;
  bashCount: number;
  bashSamples: string[];
}

/** Per process: whether its stream is between turns, and whether an unsolicited turn is running. */
interface ProcessState {
  ended: boolean;
  unsolicited: boolean;
}

/** The binding of a chat's live process, as its latest turn reported it. */
export interface UndoLiveBinding {
  /** False when the process was spawned with checkpointing off */
  checkpointing: boolean;
  sdkSessionId: string | null;
  configDir: string | null;
}

export interface UndoRecorderDeps {
  store: UndoCheckpointStore;
  /** undo.enabled with its runtime override */
  isEnabled: () => boolean;
  /** undo.backgroundTasks */
  backgroundTasks: () => boolean;
  /** Owner text preview of the chat turn now starting (from TurnContextRegistry), already scrubbed */
  chatPreview?: (sessionKey: string) => string | undefined;
  /** Description of a background task */
  taskPreview?: (taskId: string) => string | undefined;
  /** The daemon's own environment (decides the config dir of a spawn that sets no env) */
  baseEnv?: () => NodeJS.ProcessEnv;
  now?: () => number;
}

/** The config dir a process spawned with these options runs under (null = default login). */
export function undoConfigDirOf(env: Options["env"], baseEnv: NodeJS.ProcessEnv = process.env): string | null {
  const source = env ?? baseEnv;
  const dir = source.CLAUDE_CONFIG_DIR;
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The ledger key of a call: chat turns by session key, task turns by task id. */
export function undoSourceOf(ctx: SdkCallContext): string | null {
  if (ctx.kind === "chat") return "chat";
  if (UNDO_TASK_KINDS.has(ctx.kind) && ctx.taskId) return `task:${ctx.taskId}`;
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export class UndoRecorder {
  private readonly deps: UndoRecorderDeps;
  private readonly now: () => number;
  private readonly spawns = new WeakMap<SdkCallContext, SpawnInfo>();
  /** The turn whose stream messages are arriving, per process */
  private readonly current = new WeakMap<SdkCallContext, OpenTurn>();
  private readonly openByUuid = new Map<string, OpenTurn>();
  /** Latest chat process per session key */
  private readonly liveChat = new Map<string, SdkCallContext>();
  private readonly procs = new WeakMap<SdkCallContext, ProcessState>();
  /** Turns started per chat session key, counting the chat's own turns, its tasks' turns and unsolicited turns */
  private readonly epochs = new Map<string, number>();
  private stopped = false;

  constructor(deps: UndoRecorderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Stop recording (the feature stopped; the pipeline has no unregister). */
  stop(): void {
    this.stopped = true;
    this.openByUuid.clear();
    this.liveChat.clear();
  }

  /** The `checkpointing` contributor. */
  readonly contributor = (options: Options, ctx: SdkCallContext): void => {
    // A throw here would fail every chat and task spawn: log and leave the options alone.
    try {
      if (this.stopped || !this.deps.isEnabled()) return;
      const isChat = ctx.kind === "chat";
      const isTask = UNDO_TASK_KINDS.has(ctx.kind);
      if (!isChat && !(isTask && this.deps.backgroundTasks())) return;
      const configDir = undoConfigDirOf(options.env, this.deps.baseEnv?.() ?? process.env);
      options.enableFileCheckpointing = true;
      this.spawns.set(ctx, { configDir, sdkSessionId: typeof options.resume === "string" ? options.resume : null });
    } catch (err) {
      log.warn({ label: ctx.label, err: err instanceof Error ? err.message : String(err) }, "checkpointing contributor failed; spawning without checkpoints");
    }
  };

  /** The stream observer. Never throws (the pipeline would log it anyway). */
  readonly observer = (ev: SdkStreamEvent): void => {
    if (this.stopped || this.deps.store.isClosed) return;
    try {
      if (ev.type === "turn_start") this.onTurnStart(ev);
      else if (ev.type === "message") this.onMessage(ev.ctx, ev.message);
      else this.onTurnEnd(ev);
    } catch (err) {
      log.warn({ event: ev.type, label: ev.ctx.label, err: err instanceof Error ? err.message : String(err) }, "undo ledger write failed");
    }
  };

  /**
   * Turns started so far for a chat session key: its own turns, turns of tasks
   * it started, and unsolicited turns (an async subagent's result after the
   * turn ended). A confirm is refused when this moved since the preview.
   */
  turnEpoch(sessionKey: string): number {
    return this.epochs.get(sessionKey) ?? 0;
  }

  /** True while the chat's live process is running a turn nobody asked for (no turn_start, so not "busy"). */
  isStreamActive(sessionKey: string): boolean {
    const ctx = this.liveChat.get(sessionKey);
    return ctx ? this.procs.get(ctx)?.unsolicited === true : false;
  }

  private bump(sessionKey: string): void {
    this.epochs.set(sessionKey, (this.epochs.get(sessionKey) ?? 0) + 1);
  }

  /** What the chat's live process was spawned with, per its latest turn. Undefined when no turn was seen. */
  liveBinding(sessionKey: string): UndoLiveBinding | undefined {
    const ctx = this.liveChat.get(sessionKey);
    if (!ctx) return undefined;
    const spawn = this.spawns.get(ctx);
    if (!spawn) return { checkpointing: false, sdkSessionId: null, configDir: null };
    return { checkpointing: true, sdkSessionId: spawn.sdkSessionId, configDir: spawn.configDir };
  }

  // ── events ──────────────────────────────────────────────────────────────

  private onTurnStart(ev: Extract<SdkStreamEvent, { type: "turn_start" }>): void {
    const { ctx } = ev;
    const source = undoSourceOf(ctx);
    if (!source || !ctx.sessionKey) return;
    this.bump(ctx.sessionKey);
    this.procs.set(ctx, { ended: false, unsolicited: false });
    if (source === "chat") this.liveChat.set(ctx.sessionKey, ctx);

    this.current.delete(ctx);
    const spawn = this.spawns.get(ctx);
    if (!ev.userMessageUuid) return;
    if (!spawn) {
      // A turn without checkpoints in a session with undo history: leave a gap
      // marker so a multi-turn undo never silently rewinds across it.
      if (this.deps.store.hasRows(ctx.sessionKey)) {
        this.deps.store.insert({
          sessionKey: ctx.sessionKey,
          sdkSessionId: ev.sdkSessionId ?? null,
          userMessageUuid: ev.userMessageUuid,
          accountId: ev.accountId,
          configDir: null,
          cwd: ctx.cwd,
          source,
          promptPreview: null,
          createdAt: this.now(),
          checkpointed: false,
        });
      }
      return;
    }
    if (ev.sdkSessionId) spawn.sdkSessionId = ev.sdkSessionId;

    const rawPreview = source === "chat"
      ? this.deps.chatPreview?.(ctx.sessionKey)
      : ctx.taskId ? this.deps.taskPreview?.(ctx.taskId) : undefined;
    const preview = rawPreview ? clip(scrubSecrets(rawPreview, { sink: "prompt-card" }), PREVIEW_CHARS) : null;
    const sdkSessionId = ev.sdkSessionId ?? spawn.sdkSessionId;
    const rowId = this.deps.store.insert({
      sessionKey: ctx.sessionKey,
      sdkSessionId,
      userMessageUuid: ev.userMessageUuid,
      accountId: ev.accountId,
      configDir: spawn.configDir,
      cwd: ctx.cwd,
      source,
      promptPreview: preview,
      createdAt: this.now(),
    });
    const turn: OpenTurn = {
      rowId,
      uuid: ev.userMessageUuid,
      hasSessionId: sdkSessionId !== null,
      files: new Set(),
      created: new Set(),
      subagent: new Set(),
      writes: new Map(),
      bashCount: 0,
      bashSamples: [],
    };
    this.current.set(ctx, turn);
    this.openByUuid.set(turn.uuid, turn);
    if (this.openByUuid.size > MAX_OPEN_TURNS) {
      const oldest = this.openByUuid.keys().next().value;
      if (oldest !== undefined) this.openByUuid.delete(oldest);
    }
  }

  private onMessage(ctx: SdkCallContext, msg: SDKMessage): void {
    const proc = this.procs.get(ctx);
    if (proc?.ended && ctx.sessionKey) {
      if (msg.type === "result") proc.unsolicited = false;
      else if ((msg.type === "assistant" || msg.type === "user") && !proc.unsolicited) {
        proc.unsolicited = true;
        this.bump(ctx.sessionKey);
      }
    }
    const spawn = this.spawns.get(ctx);
    if (!spawn) return;
    const sid = (msg as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && sid.length > 0) spawn.sdkSessionId = sid;
    const turn = this.current.get(ctx);
    if (!turn) return;
    if (!turn.hasSessionId && spawn.sdkSessionId) {
      this.deps.store.setSdkSessionId(turn.rowId, spawn.sdkSessionId);
      turn.hasSessionId = true;
    }

    let changed = false;
    if (msg.type === "assistant") {
      const fromSubagent = msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined;
      const content = msg.message.content as unknown;
      if (!Array.isArray(content)) return;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (UNDO_FILE_TOOLS.has(block.name)) {
          const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
          if (!path) continue;
          const target = fromSubagent ? turn.subagent : turn.files;
          if (target.size < UNDO_MAX_PATHS_PER_ROW) target.add(path);
          if (block.name === "Write" && typeof block.id === "string") turn.writes.set(block.id, path);
          changed = true;
        } else if (block.name === "Bash") {
          turn.bashCount += 1;
          if (turn.bashSamples.length < UNDO_MAX_BASH_SAMPLES && typeof input.command === "string") {
            turn.bashSamples.push(clip(scrubSecrets(input.command, { sink: "prompt-card" }), BASH_SAMPLE_CHARS));
          }
          changed = true;
        }
      }
    } else if (msg.type === "user" && turn.writes.size > 0) {
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const path = turn.writes.get(block.tool_use_id);
        if (!path) continue;
        turn.writes.delete(block.tool_use_id);
        if (block.is_error !== true && CREATED_RESULT_RE.test(toolResultText(block.content))) {
          // Created in this turn unless an earlier turn of the same row already wrote it
          turn.created.add(path);
          changed = true;
        }
      }
    }
    if (changed) this.persist(turn);
  }

  private onTurnEnd(ev: Extract<SdkStreamEvent, { type: "turn_end" }>): void {
    const proc = this.procs.get(ev.ctx);
    if (proc) {
      proc.ended = true;
      proc.unsolicited = false;
    }
    const spawn = this.spawns.get(ev.ctx);
    if (spawn && ev.sdkSessionId) spawn.sdkSessionId = ev.sdkSessionId;
    if (!ev.userMessageUuid) return;
    const turn = this.openByUuid.get(ev.userMessageUuid);
    if (!turn) return;
    this.openByUuid.delete(ev.userMessageUuid);
    // The engine's own session id at turn end wins over ids read from the
    // stream (a closed process's late messages can carry an older one).
    if (ev.sdkSessionId) {
      this.deps.store.correctSdkSessionId(turn.rowId, ev.sdkSessionId);
      turn.hasSessionId = true;
    } else if (!turn.hasSessionId && spawn?.sdkSessionId) {
      this.deps.store.setSdkSessionId(turn.rowId, spawn.sdkSessionId);
      turn.hasSessionId = true;
    }
    this.persist(turn);
    this.deps.store.complete(turn.rowId, this.now());
  }

  private persist(turn: OpenTurn): void {
    this.deps.store.setActivity(turn.rowId, {
      filesChanged: [...turn.files],
      filesCreated: [...turn.created],
      subagentFiles: [...turn.subagent],
      bashCount: turn.bashCount,
      bashSamples: turn.bashSamples,
    });
  }
}
