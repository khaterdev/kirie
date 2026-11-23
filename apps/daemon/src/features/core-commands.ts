import { createCoreCommands } from "@kirie/core";
import type { CommandRegistry, PromptAddendumContext } from "@kirie/core";
import type { FeatureSetup } from "./types.js";

/**
 * The slash-command hint in the system prompt, built from the registry, so a
 * feature's commands appear as soon as it registers them. The owner's DM lists
 * everything; any other chat lists only the public commands. Background
 * prompts get nothing.
 */
export function renderCommandsAddendum(commands: CommandRegistry, ctx: PromptAddendumContext): string | null {
  if (ctx.kind !== "chat") return null;
  const menu = commands.menu({ forOwner: ctx.ownerDm });
  if (menu.length === 0) return null;
  const lines = menu.map((m) => `/${m.command} - ${m.description}`);
  return ["<slash_commands>", ...lines, "</slash_commands>"].join("\n");
}

/** Built-in core commands (PLAN B.12, W1B): /help, /status, /stop, ... and the prompt text fallback. */
export const setupCoreCommands: FeatureSetup = (ctx) => {
  ctx.commands.registerAll(createCoreCommands({
    help: ctx.commands,
    channelRegistry: ctx.channelRegistry,
    sessionStore: ctx.sessionStore,
    pipeline: ctx.pipeline,
    backgroundTaskManager: ctx.backgroundTaskManager,
    onRestart: () => ctx.restart(),
    chatHistoryStore: ctx.chatHistoryStore,
    usageDashboard: ctx.usageDashboard,
    prompts: ctx.ownerPrompts,
  }));
  ctx.promptAddenda.register("commands", (p) => renderCommandsAddendum(ctx.commands, p));
  return { name: "core-commands" };
};
