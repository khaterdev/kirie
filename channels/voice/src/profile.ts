/**
 * The reduced tool surface for phone calls (contributor "voice-profile",
 * order 70, PLAN B.1/C.14) and the voice style addendum.
 *
 * Speech recognition mishears; a misheard sentence must not become a shell
 * command. Profile "chat" (default) removes shell, file writes, subagents,
 * the browser, restarts, MCP-server edits, spawning, background tasks and
 * placing calls, plus every indirect route to a full-tool turn (relaying into
 * another session, scheduling, background-task messages, proactive triggers)
 * and every external MCP server configured for Kirie (only kirie-tools stays;
 * user-scope connectors are only excluded when agent.strictMcpConfig is on).
 * Profile "full" keeps the normal tools (the approvals gate
 * stays in charge) but still never places calls from a call. Computer use is
 * never available on a voice session: the cua-driver server and its tools are
 * removed whatever the profile.
 */

import type { PromptAddendumContext, SdkCallContext, SdkOptionsContributor } from "@kirie/core";

type Options = Parameters<SdkOptionsContributor>[0];

const K = "mcp__kirie-tools__";

export const VOICE_CHAT_PROFILE_DISALLOWED: readonly string[] = [
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Task", "Agent",
  `${K}browser`,
  `${K}voice_call_initiate`,
  `${K}gateway_restart`,
  `${K}gateway_config_reload`,
  `${K}mcp_servers_add`,
  `${K}mcp_servers_remove`,
  `${K}sessions_spawn`,
  `${K}background_task_create`,
  `${K}background_task_send_message`,
  `${K}sessions_send`,
  `${K}schedule_create`,
  `${K}schedule_webhook`,
  `${K}proactive_trigger`,
  `${K}channel_action`,
  `${K}sandbox_bash`,
];

const KIRIE_SERVER = "kirie-tools";

export const VOICE_ALWAYS_DISALLOWED: readonly string[] = [`${K}voice_call_initiate`];

const CUA_SERVER = "cua-driver";
const CUA_PREFIX = "mcp__cua-driver";

export function isVoiceSession(ctx: Pick<SdkCallContext, "channel" | "sessionKey">): boolean {
  return ctx.channel === "voice" || (ctx.sessionKey?.startsWith("voice:") ?? false);
}

/**
 * Mutates `options` for voice sessions only. Never mutates shared arrays or
 * objects in place: allowedTools, disallowedTools and mcpServers are replaced.
 */
export function applyVoiceToolProfile(options: Options, ctx: SdkCallContext, profile: "chat" | "full"): void {
  if (!isVoiceSession(ctx)) return;
  const deny = new Set<string>(profile === "chat" ? VOICE_CHAT_PROFILE_DISALLOWED : VOICE_ALWAYS_DISALLOWED);
  options.disallowedTools = [...new Set([...(options.disallowedTools ?? []), ...deny])];
  const externalMcp = (t: string) => t.startsWith("mcp__") && !t.startsWith(K);
  if (options.allowedTools) {
    options.allowedTools = options.allowedTools.filter((t) =>
      !deny.has(t) && !t.startsWith(CUA_PREFIX) && !(profile === "chat" && externalMcp(t)));
  }
  if (options.mcpServers) {
    const kept = Object.entries(options.mcpServers).filter(([name]) =>
      name !== CUA_SERVER && (profile === "full" || name === KIRIE_SERVER));
    if (kept.length !== Object.keys(options.mcpServers).length) options.mcpServers = Object.fromEntries(kept);
  }
}

export const VOICE_PROMPT_ADDENDUM = [
  "<voice_call>",
  "You are speaking with the owner on a phone call. Your reply is read aloud by a text-to-speech voice.",
  "- Answer in a few short spoken sentences. No markdown, lists, code, tables, emoji or URLs.",
  "- The owner's words come from speech recognition and may be misheard. Before anything consequential (sending a message for them, changing a schedule or memory), repeat back what you understood and ask for a yes.",
  "- Slash commands do not work on calls, and shell, file edits and placing calls are not available here.",
  "- When an answer needs detail, give the gist and offer to send the full version on Telegram.",
  "</voice_call>",
].join("\n");

export function voicePromptAddendum(p: PromptAddendumContext): string | null {
  return p.channel === "voice" && p.kind === "chat" ? VOICE_PROMPT_ADDENDUM : null;
}
