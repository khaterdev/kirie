/**
 * Per-turn context: who or what started the turn that a tool call or stream
 * event belongs to (PLAN B.2).
 *
 * The message pipeline is the only writer: it calls `begin` before
 * `agentEngine.execute()` and `end` in `finally`. Gates and observers read it
 * through `originOf`, which also covers task kinds that have no chat turn.
 */

import type { SdkCallContext } from "./sdk-options.js";

export type TurnOrigin =
  | "owner_message" | "other_user" | "schedule" | "loop" | "webhook" | "goal" | "background" | "system";

export interface TurnInfo {
  origin: TurnOrigin;
  senderId?: string;
  senderRole?: string;
  startedAt: number;
  /** First 80 chars of the owner's text, scrubbed. */
  textPreview?: string;
}

export class TurnContextRegistry {
  private readonly turns = new Map<string, TurnInfo>();

  /** The pipeline calls this before execute(). A newer turn for the same key replaces the older one. */
  begin(sessionKey: string, info: TurnInfo): void {
    this.turns.set(sessionKey, { ...info });
  }

  /** The pipeline calls this in finally. */
  end(sessionKey: string): void {
    this.turns.delete(sessionKey);
  }

  get(sessionKey: string | undefined): TurnInfo | undefined {
    if (sessionKey === undefined) return undefined;
    const info = this.turns.get(sessionKey);
    return info ? { ...info } : undefined;
  }
}

/**
 * Origin for a tool call or a stream event. Task kinds map to their own
 * origin; chat reads the registry; anything unknown is "system".
 */
export function originOf(ctx: SdkCallContext, turns: TurnContextRegistry): TurnOrigin {
  switch (ctx.kind) {
    case "chat":
      return turns.get(ctx.sessionKey)?.origin ?? "system";
    case "background":
      return "background";
    case "goal":
      return "goal";
    case "webhook":
      return "webhook";
    case "judge":
    case "triage":
    case "oneshot":
    case "utility":
      return "system";
  }
}
