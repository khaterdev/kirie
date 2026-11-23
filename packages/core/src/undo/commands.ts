/**
 * /undo (PLAN C.11, B.12): revert file edits from my last turn.
 *
 * Owner-only, DM-only (checked by the registry). Two steps: a dry run whose
 * preview is the body of a Confirm / Cancel prompt in the owner's DM, then the
 * real rewind on Confirm, if nothing ran since. There is no agent tool for
 * undo. Previews are scrubbed. Ships off: `/undo on` sets the runtime
 * override `undo.enabled` and closes idle sessions so the next turn is
 * checkpointed.
 */

import { homedir } from "node:os";
import { relative, isAbsolute, sep } from "node:path";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { parseIntInRange } from "../commands/parse.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { UndoConfig } from "../config/sections/undo.js";
import type { UndoCheckpoint } from "./checkpoint-store.js";
import {
  formatUndoTime,
  UNDO_NEEDS_V2_TEXT,
  type UndoApplyOutcome,
  type UndoPlan,
  type UndoPreviewOutcome,
  type UndoScope,
  type UndoService,
} from "./undo-service.js";

export const UNDO_ENABLED_SETTING = "undo.enabled";
/** Paths listed per section of a preview */
const MAX_LISTED = 15;

export interface UndoCommandDeps {
  /** Null in v1 mode: every form but help answers "needs v2" */
  service: Pick<UndoService, "preview" | "apply" | "list" | "resolveTaskId"> | null;
  config: () => UndoConfig;
  isEnabled: () => boolean;
  /** Persist the `undo.enabled` override (null drops it) */
  setEnabled: (on: boolean | null, by: string) => void;
  /** Close idle sessions so the next turn spawns with the new setting */
  closeIdleSessions: () => void;
  /** Confirm / Cancel in the owner's DM with the undo timeout. Defaults to ctx.confirm */
  confirm?: (title: string, body: string) => Promise<boolean>;
  audit?: (action: string, actor: string, detail?: Record<string, unknown>) => void;
  timezone?: string;
  now?: () => number;
}

export const UNDO_HELP_TEXT = [
  "/undo - preview undoing the file edits of my last turn, then Confirm or Cancel",
  "/undo <n> - the same for the last n turns that edited files",
  "/undo preview [n] - only show what an undo would do",
  "/undo list - recent turns: time, prompt, files, shell commands, undone or not",
  "/undo task <id> - undo a finished background task's file edits",
  "/undo on | off | reset - turn undo on or off (applies from the next session)",
  "",
  "Undo restores files that I changed with my file tools (Write, Edit, NotebookEdit) to their content before the turn, and deletes files the turn created. The conversation itself is not rewound.",
  "",
  "It cannot undo:",
  "- anything done through Bash: deletes, moves, sed -i, redirects, git commit/reset/push, installs, builds",
  "- anything outside this computer: remote hosts, Kubernetes, pushed commits, sent messages",
  "- effects of MCP tools: memories, schedules, daily notes, channel actions",
  "- creating, deleting or moving directories",
  "- files reached through symlinks or hard links (reported as skipped)",
  "- edits made by subagents, if the SDK did not track them (the preview names them)",
  "- turns from before undo was on, and turns whose backups Claude Code already cleaned up",
  "- several turns at once when they span an account switch or a /clear (undo them one at a time, newest first)",
  "- a background task's edits from the chat's /undo (use /undo task <id>)",
  "Edits that you or another agent made to the same files after my turn are overwritten; the preview warns when a file changed since.",
].join("\n");

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function scrub(text: string): string {
  return scrubSecrets(text, { sink: "prompt-card" });
}

/** A path as the owner reads it: relative to the turn's cwd when inside it, else with ~ for home. */
export function displayUndoPath(path: string, cwd: string): string {
  if (isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
    const home = homedir();
    if (path === home || path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  }
  return path;
}

function listPaths(paths: readonly string[], cwd: string, marks?: ReadonlySet<string>): string[] {
  const out = paths.slice(0, MAX_LISTED).map((p) => `  ${displayUndoPath(p, cwd)}${marks?.has(p) ? " (changed since; will be overwritten)" : ""}`);
  if (paths.length > MAX_LISTED) out.push(`  ... and ${paths.length - MAX_LISTED} more`);
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function shellLine(plan: Pick<UndoPlan, "bashCount" | "bashSamples" | "rows">): string {
  const span = plan.rows.length === 1 ? "that turn" : "those turns";
  if (plan.bashCount === 0) return `Not reverted: anything done through Bash (no shell commands ran in ${span}).`;
  const samples = plan.bashSamples.length > 0 ? ` (${plan.bashSamples.join("; ")}${plan.bashCount > plan.bashSamples.length ? "; ..." : ""})` : "";
  return `Not reverted: ${plural(plan.bashCount, "shell command")} in ${span}${samples}.`;
}

/** The title of the confirm prompt for a plan. */
export function undoPreviewTitle(plan: UndoPlan, timezone?: string, now?: number): string {
  const when = formatUndoTime(plan.target.createdAt, timezone, now);
  const prompt = plan.target.promptPreview ? `, "${plan.target.promptPreview}"` : "";
  if (plan.scope.kind === "task") return `Undo the file edits of task ${plan.scope.taskId.slice(0, 8)} (${when}${prompt})?`;
  if (plan.rows.length === 1) return `Undo the last turn (${when}${prompt})?`;
  return `Undo the last ${plan.rows.length} turns (since ${when}${prompt})?`;
}

/** The preview body (scrubbed). */
export function renderUndoPreview(plan: UndoPlan): string {
  const cwd = plan.target.cwd;
  const changedSince = new Set(plan.modifiedAfter);
  const lines: string[] = [];
  if (plan.restore.length > 0) {
    lines.push(`Will restore ${plural(plan.restore.length, "file")} (+${plan.dryRun.insertions} -${plan.dryRun.deletions}):`);
    lines.push(...listPaths(plan.restore, cwd, changedSince));
  }
  if (plan.remove.length > 0) {
    lines.push(`Will delete ${plural(plan.remove.length, "file")} created in ${plan.rows.length === 1 ? "that turn" : "those turns"} (no earlier version exists):`);
    lines.push(...listPaths(plan.remove, cwd, changedSince));
  }
  lines.push(shellLine(plan));
  if (plan.notCovered.length > 0) {
    lines.push(`Not restorable: ${plural(plan.notCovered.length, "file")} edited by a subagent, which the SDK did not track:`);
    lines.push(...listPaths(plan.notCovered, cwd));
  }
  if (plan.modifiedAfter.length > 0) {
    lines.push(`Warning: ${plural(plan.modifiedAfter.length, "file")} changed after that turn; undo will overwrite those changes.`);
  }
  return scrub(lines.join("\n"));
}

/** The reply after a real undo (scrubbed). */
export function renderUndoApplied(outcome: Extract<UndoApplyOutcome, { status: "applied" }>): string {
  const { plan, result } = outcome;
  const restored = plan.restore.length;
  const deleted = plan.remove.length;
  const parts = [`Undone. Restored ${plural(restored, "file")}${deleted > 0 ? ` and deleted ${plural(deleted, "created file")}` : ""}:`];
  parts.push(...listPaths([...plan.restore, ...plan.remove], plan.target.cwd));
  if (result.skippedLinks > 0) parts.push(`Skipped ${plural(result.skippedLinks, "file")} (symlink, hard link or moved path): not restored.`);
  parts.push(shellLine(plan));
  if (plan.notCovered.length > 0) parts.push(`Not restored: ${plural(plan.notCovered.length, "file")} edited by a subagent.`);
  parts.push("The conversation was not rewound; I will be told about this undo on your next message.");
  return scrub(parts.join("\n"));
}

function renderList(rows: readonly UndoCheckpoint[], timezone: string | undefined, now: number): string {
  if (rows.length === 0) return "No recorded turns in this chat yet. Turns are recorded while undo is on.";
  const lines = ["Recent turns, newest first:"];
  for (const r of rows) {
    const when = formatUndoTime(r.createdAt, timezone, now);
    const who = r.source === "chat" ? "" : ` [task ${r.source.slice("task:".length, "task:".length + 8)}]`;
    const prompt = r.promptPreview ? ` "${r.promptPreview}"` : "";
    const files = r.filesChanged.length + r.subagentFiles.length;
    const what = files > 0 ? plural(files, "file") : "no file edits";
    const shell = r.bashCount > 0 ? `, ${plural(r.bashCount, "shell command")}` : "";
    const state = r.undoneAt !== null ? " (undone)" : r.completedAt === null ? " (running or interrupted)" : "";
    lines.push(`${when}${who}${prompt}: ${what}${shell}${state}`);
  }
  return scrub(lines.join("\n"));
}

export function createUndoCommands(deps: UndoCommandDeps): CommandDefinition[] {
  const now = deps.now ?? Date.now;

  async function previewAndConfirm(ctx: CommandContext, scope: UndoScope, turns: number, confirm: boolean): Promise<string> {
    const service = deps.service!;
    const by = actor(ctx);
    const pre: UndoPreviewOutcome = await service.preview(scope, turns);
    if (pre.status !== "ready") {
      deps.audit?.("refused", by, { scope: scope.kind, turns, reason: pre.status });
      return scrub(pre.message);
    }
    const { plan } = pre;
    const title = scrub(undoPreviewTitle(plan, deps.timezone, now()));
    const body = renderUndoPreview(plan);
    deps.audit?.("previewed", by, { scope: scope.kind, rows: plan.rows.map((r) => r.id), files: plan.restore.length + plan.remove.length });
    if (!confirm) return `${title}\n${body}\nSend /undo${scope.kind === "task" ? ` task ${scope.taskId}` : turns > 1 ? ` ${turns}` : ""} to apply it.`;

    const ok = await (deps.confirm ? deps.confirm(title, body) : ctx.confirm(title, body));
    if (!ok) {
      deps.audit?.("cancelled", by, { scope: scope.kind, rows: plan.rows.map((r) => r.id) });
      return "Undo cancelled. Nothing was changed.";
    }
    const applied = await service.apply(plan);
    if (applied.status === "applied") {
      deps.audit?.("applied", by, {
        scope: scope.kind,
        rows: plan.rows.map((r) => r.id),
        restored: plan.restore.length,
        deleted: plan.remove.length,
        skippedLinks: applied.result.skippedLinks,
        via: applied.result.via,
      });
      return renderUndoApplied(applied);
    }
    deps.audit?.(applied.status === "failed" ? "failed" : "refused", by, { scope: scope.kind, rows: plan.rows.map((r) => r.id) });
    return scrub(applied.message);
  }

  return [
    {
      name: "undo",
      description: "Revert file edits from my last turn: preview, list, task, on, off, help",
      category: "security",
      ownerOnly: true,
      scope: "dm",
      args: "[n | preview [n] | list | task <id> | on | off | reset | help]",
      usage: UNDO_HELP_TEXT,
      subcommands: {
        preview: { args: "[n]", description: "Show what undoing the last n turns would do" },
        list: { description: "Recent turns and their file edits" },
        task: { args: "<id>", description: "Undo a finished background task's file edits" },
        on: { description: "Turn undo on" },
        off: { description: "Turn undo off" },
        reset: { description: "Drop the on/off override (back to the config value)" },
        help: { description: "What undo covers and what it does not" },
      },
      handler: async (ctx) => {
        const sub = (ctx.argv[0] ?? "").toLowerCase();
        const by = actor(ctx);
        const max = deps.config().maxTurnsPerUndo;

        if (sub === "help") return UNDO_HELP_TEXT;
        if (sub === "on" || sub === "off" || sub === "reset") {
          if (!deps.service) return UNDO_NEEDS_V2_TEXT;
          deps.setEnabled(sub === "reset" ? null : sub === "on", by);
          deps.closeIdleSessions();
          const on = deps.isEnabled();
          if (on) return "Undo is on. File edits from turns starting now are recorded; send /undo after a turn to revert them. Shell commands are never reverted.";
          return "Undo is off. New turns are not recorded.";
        }
        if (!deps.service) return UNDO_NEEDS_V2_TEXT;

        if (sub === "list") return renderList(deps.service.list(ctx.sessionKey, 10), deps.timezone, now());
        if (sub === "task") {
          const id = ctx.argv[1];
          if (!id) return "Usage: /undo task <id>";
          const resolved = deps.service.resolveTaskId(id);
          if ("message" in resolved) return scrub(resolved.message);
          return previewAndConfirm(ctx, { kind: "task", taskId: resolved.taskId }, 1, true);
        }
        let confirm = true;
        let countArg: string | undefined = ctx.argv[0];
        if (sub === "preview") {
          confirm = false;
          countArg = ctx.argv[1];
        }
        let turns = 1;
        if (countArg !== undefined) {
          const n = parseIntInRange(countArg, 1, max);
          if (n === null) return `Usage: /undo [1-${max}], /undo preview [n], /undo list, /undo task <id>, /undo on|off, /undo help`;
          turns = n;
        }
        return previewAndConfirm(ctx, { kind: "chat", sessionKey: ctx.sessionKey }, turns, confirm);
      },
    },
  ];
}
