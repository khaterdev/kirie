/**
 * Owner commands /voice and /call (PLAN B.12). Owner-only and DM-only; the
 * registry checks the owner before a handler runs. Replies never contain a
 * credential, the PIN, or a full non-owner number.
 */

import type { CommandContext, CommandDefinition } from "@kirie/core";
import { isVoiceProviderName } from "@kirie/voice";
import type { VoiceService } from "./service.js";

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

export const VOICE_COMMAND_USAGE = [
  "/voice status - readiness of both providers, switch, caps, live and recent calls",
  "/voice on | off - runtime switch (off also ends live calls)",
  "/voice hangup - end all live calls now",
  "/voice provider [twilio|plivo|reset] - show or switch the active provider",
].join("\n");

export const CALL_COMMAND_USAGE = [
  "/call - list contact aliases",
  "/call <alias> <message> - phone the contact and speak the message; one spoken reply is captured and reported here",
  "/call <alias> --talk [goal] - a spoken conversation with Kirie (only to your own number, alias \"me\")",
].join("\n");

export function createVoiceCommand(service: VoiceService): CommandDefinition {
  return {
    name: "voice",
    description: "Phone calls: status, on, off, hangup, provider [twilio|plivo]",
    category: "media",
    ownerOnly: true,
    scope: "dm",
    args: "status | on | off | hangup | provider [twilio|plivo|reset]",
    usage: VOICE_COMMAND_USAGE,
    subcommands: {
      status: { description: "Show readiness and calls" },
      on: { description: "Switch voice on" },
      off: { description: "Switch voice off and end live calls" },
      hangup: { description: "End all live calls" },
      provider: { args: "[twilio|plivo|reset]", description: "Show or switch the active provider" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "status").toLowerCase();
      switch (sub) {
        case "status":
          await service.reload();
          return service.statusText();
        case "on":
          return (await service.switchOn(actor(ctx))).message;
        case "off":
          return (await service.switchOff(actor(ctx))).message;
        case "hangup": {
          const n = await service.hangupAll("hung-up");
          return n === 0 ? "No live calls." : `Ending ${n} call${n === 1 ? "" : "s"}.`;
        }
        case "provider": {
          const target = ctx.argv[1]?.toLowerCase();
          if (!target) {
            await service.reload();
            const lines = [`Active provider: ${service.activeProvider()}.`];
            for (const n of ["twilio", "plivo"] as const) {
              const r = service.readiness(n);
              lines.push(`  ${n}: ${r.ready ? "ready" : `missing ${r.missing.join(", ")}`}`);
            }
            lines.push("Switch with /voice provider twilio|plivo, or /voice provider reset for the config default.");
            return lines.join("\n");
          }
          if (target !== "reset" && !isVoiceProviderName(target)) return "Unknown provider. Use twilio or plivo.";
          return (await service.setProvider(target, actor(ctx))).message;
        }
        default:
          return `Unknown subcommand.\n${VOICE_COMMAND_USAGE}`;
      }
    },
  };
}

/** Parse "/call" arguments. Exported for tests. */
export function parseCallArgs(argv: readonly string[]):
  | { kind: "list" }
  | { kind: "call"; alias: string; mode: "say" | "talk"; text: string }
  | { kind: "error"; message: string } {
  if (argv.length === 0) return { kind: "list" };
  const [alias, ...rest] = argv;
  const talkIdx = rest.findIndex((a) => a === "--talk");
  if (talkIdx >= 0) {
    const text = [...rest.slice(0, talkIdx), ...rest.slice(talkIdx + 1)].join(" ").trim();
    return { kind: "call", alias: alias!, mode: "talk", text };
  }
  const text = rest.join(" ").trim();
  if (!text) return { kind: "error", message: `Say what to tell them: /call ${alias} <message>, or /call ${alias} --talk.` };
  return { kind: "call", alias: alias!, mode: "say", text };
}

export function createCallCommand(service: VoiceService): CommandDefinition {
  return {
    name: "call",
    description: "Phone an allowlisted contact: /call <alias> <message>, or /call <alias> --talk [goal]",
    category: "media",
    ownerOnly: true,
    scope: "dm",
    args: "<alias> <message> | <alias> --talk [goal]",
    usage: CALL_COMMAND_USAGE,
    async handler(ctx) {
      const parsed = parseCallArgs(ctx.argv);
      if (parsed.kind === "list") {
        return `Contacts you can call: ${service.aliases().join(", ")}.\n${CALL_COMMAND_USAGE}`;
      }
      if (parsed.kind === "error") return parsed.message;
      const res = await service.placeCall({
        alias: parsed.alias,
        text: parsed.text,
        mode: parsed.mode,
        requestedBy: "owner-command",
        actor: actor(ctx),
      });
      if (!res.ok) return res.reason;
      return `Calling ${parsed.alias.toLowerCase()} via ${res.provider} (call ${res.callId}). I will report back here.`;
    },
  };
}

export function createVoiceCommands(service: VoiceService, opts: { includeCall: boolean }): CommandDefinition[] {
  return opts.includeCall ? [createVoiceCommand(service), createCallCommand(service)] : [createVoiceCommand(service)];
}
