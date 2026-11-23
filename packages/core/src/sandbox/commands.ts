/**
 * `/sandbox` (PLAN B.12, C.10). Owner-only, DM-only, category `security`.
 * The registry enforces the owner check; this file never does its own.
 *
 * Every change is a `RuntimeSettings` override; config.yaml is never
 * rewritten. `native` and `docker` are accepted only after their self-test.
 * Loosening (`off`, and a `reset` that changes the mode) asks for a
 * confirmation first (B.4 rule 10).
 */

import type { CommandContext, CommandDefinition, CommandResult } from "../commands/types.js";
import type { SandboxController } from "./controller.js";

export interface SandboxCommandDeps {
  controller: SandboxController;
}

const HELP_TEXT =
  "Choose where my shell commands run. off: directly on this Mac (default). native: macOS sandbox, I can only write inside my workspace and folders you allow. docker: inside an isolated container with no network and no access to your files. Example: /sandbox native, then /sandbox allow-write ~/dev";

const USAGE = [
  "/sandbox: where my shell commands run.",
  "/sandbox                         status",
  "/sandbox off                     run on this Mac (asks you to confirm)",
  "/sandbox native                  macOS sandbox (runs a short self-test first)",
  "/sandbox docker                  isolated container (checks Docker, the image and the container first)",
  "/sandbox allow-write <path>      let native mode write in a folder",
  "/sandbox disallow-write <path>   remove a folder you added",
  "/sandbox recreate                rebuild the docker container",
  "/sandbox reset                   drop every override made here",
].join("\n");

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

/** Text after the subcommand word, with one pair of surrounding quotes removed. */
function restAfterSubcommand(ctx: CommandContext): string {
  const args = ctx.args.trimStart();
  const sub = ctx.argv[0] ?? "";
  let rest = args.startsWith(sub) ? args.slice(sub.length) : args.replace(/^\S+/, "");
  rest = rest.trim();
  if (rest.length >= 2 && ((rest.startsWith("\"") && rest.endsWith("\"")) || (rest.startsWith("'") && rest.endsWith("'")))) {
    rest = rest.slice(1, -1);
  }
  return rest;
}

export function createSandboxCommands(deps: SandboxCommandDeps): CommandDefinition[] {
  const c = deps.controller;

  const handler = async (ctx: CommandContext): Promise<CommandResult> => {
    const sub = (ctx.argv[0] ?? "").toLowerCase();
    switch (sub) {
      case "":
      case "status":
        return c.statusText();
      case "help":
        return `${HELP_TEXT}\n\n${USAGE}`;
      case "off": {
        if (c.mode() === "off") return "The sandbox is already off.";
        const ok = await ctx.confirm("Turn the sandbox off?", "Shell commands will run directly on this Mac, with access to everything your user can reach.");
        if (!ok) return "Cancelled. The sandbox is unchanged.";
        return (await c.switchMode("off", actor(ctx))).text;
      }
      case "native":
        if (c.mode() !== "native") await ctx.reply("Testing the macOS sandbox first (one short model turn)...");
        return (await c.switchMode("native", actor(ctx))).text;
      case "docker":
        if (c.mode() !== "docker") await ctx.reply("Checking Docker, the image and the container first...");
        return (await c.switchMode("docker", actor(ctx))).text;
      case "allow-write": {
        const path = restAfterSubcommand(ctx);
        if (!path) return "Usage: /sandbox allow-write <path>";
        return (await c.addAllowWrite(path, actor(ctx))).text;
      }
      case "disallow-write": {
        const path = restAfterSubcommand(ctx);
        if (!path) return "Usage: /sandbox disallow-write <path>";
        return (await c.removeAllowWrite(path, actor(ctx))).text;
      }
      case "recreate":
        return (await c.recreate(actor(ctx))).text;
      case "reset": {
        const current = c.mode();
        const target = c.configuredMode();
        if (target !== current) {
          const ok = await ctx.confirm("Reset the sandbox?", `The mode goes from ${current} to ${target} (config.yaml), and folders added with allow-write are dropped.`);
          if (!ok) return "Cancelled. The sandbox is unchanged.";
        }
        return (await c.reset(actor(ctx))).text;
      }
      default:
        return `Unknown subcommand "${sub}".\n\n${USAGE}`;
    }
  };

  return [
    {
      name: "sandbox",
      description: "Choose where my shell commands run: status, off, native, docker, allow-write, disallow-write, recreate, reset",
      category: "security",
      ownerOnly: true,
      scope: "dm",
      args: "[off|native|docker|allow-write <path>|disallow-write <path>|recreate|reset]",
      usage: `${HELP_TEXT}\n\n${USAGE}`,
      subcommands: {
        status: { description: "Mode, readiness and what is confined" },
        off: { description: "Run shell commands on this Mac (asks to confirm)" },
        native: { description: "macOS sandbox, after a self-test" },
        docker: { description: "Isolated container, after readiness checks" },
        "allow-write": { args: "<path>", description: "Let native mode write in a folder" },
        "disallow-write": { args: "<path>", description: "Remove a folder you added" },
        recreate: { description: "Rebuild the docker container" },
        reset: { description: "Drop every override" },
      },
      handler,
    },
  ];
}
