/**
 * PromptAddenda - the one place features add text to the system prompt
 * (PLAN B.10 seam 7). `prompt-builder.ts` appends `render(...)` at the end of
 * the appended prompt for chat sessions and for the background task prompt.
 *
 * A v2 session's prompt is fixed when its subprocess starts, so a change to an
 * addendum applies from the next session; a feature that needs it sooner calls
 * `v2Sessions.closeIdleSessions()`.
 */

import { createModuleLogger } from "../logging/logger.js";

const log = createModuleLogger("prompt-addenda");

export interface PromptAddendumContext {
  kind: "chat" | "background";
  channel?: string;
  chatType?: string;
  senderRole?: string;
  /** Chat session in a configured owner's DM */
  ownerDm: boolean;
}

/** Returns the text to append, or null to add nothing for this context. */
export type PromptAddendumFn = (ctx: PromptAddendumContext) => string | null;

/** The part of PromptAddenda the prompt builder needs. */
export interface PromptAddendaRenderer {
  render(ctx: PromptAddendumContext): string;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;

export class PromptAddenda implements PromptAddendaRenderer {
  private readonly fns = new Map<string, PromptAddendumFn>();

  /** Throws on a duplicate or invalid name. Names are lowercase, e.g. "accounts" or "voice-style". */
  register(name: string, fn: PromptAddendumFn): void {
    if (!NAME_RE.test(name)) throw new Error(`Invalid prompt addendum name "${name}"`);
    if (this.fns.has(name)) throw new Error(`Prompt addendum "${name}" is already registered`);
    this.fns.set(name, fn);
  }

  unregister(name: string): void {
    this.fns.delete(name);
  }

  names(): string[] {
    return [...this.fns.keys()].sort();
  }

  /** Non-empty addenda sorted by name, joined with blank lines. A throwing addendum is skipped and logged. */
  render(ctx: PromptAddendumContext): string {
    const parts: string[] = [];
    for (const name of this.names()) {
      const fn = this.fns.get(name);
      if (!fn) continue;
      try {
        const text = fn(ctx);
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
      } catch (err) {
        log.warn({ addendum: name, err: err instanceof Error ? err.message : String(err) }, "prompt addendum failed (skipped)");
      }
    }
    return parts.join("\n\n");
  }
}

/** `base` plus the rendered addenda, separated by a blank line. Returns `base` when nothing renders. */
export function appendPromptAddenda(
  base: string,
  addenda: PromptAddendaRenderer | undefined,
  ctx: PromptAddendumContext,
): string {
  if (!addenda) return base;
  const extra = addenda.render(ctx);
  return extra ? `${base}\n\n${extra}` : base;
}
