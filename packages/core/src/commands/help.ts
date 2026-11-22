/**
 * /help text and the platform command menu, generated from the registry.
 */

import { COMMAND_CATEGORIES, type CommandCategory, type CommandDefinition } from "./types.js";

const CATEGORY_TITLES: Record<CommandCategory, string> = {
  core: "Core",
  accounts: "Accounts",
  automation: "Automation",
  learning: "Learning",
  security: "Security",
  integrations: "Integrations",
  media: "Media",
};

/** Telegram allows at most 100 menu entries. */
export const COMMAND_MENU_MAX = 100;
/** Warn when the menu reaches this size. */
export const COMMAND_MENU_WARN_AT = 80;

/** Owner-only is the default: only an explicit false makes a command public. */
export function isOwnerOnlyCommand(def: Pick<CommandDefinition, "ownerOnly">): boolean {
  return def.ownerOnly !== false;
}

function visibleTo(def: CommandDefinition, isOwner: boolean): boolean {
  return isOwner || !isOwnerOnlyCommand(def);
}

function line(def: CommandDefinition): string {
  return `/${def.name}${def.args ? ` ${def.args}` : ""} - ${def.description}`;
}

function byCategory(defs: readonly CommandDefinition[]): CommandDefinition[] {
  const out: CommandDefinition[] = [];
  for (const cat of COMMAND_CATEGORIES) {
    for (const d of defs) if (d.category === cat) out.push(d);
  }
  return out;
}

/**
 * The /help text. Owner-only commands are hidden from non-owners, and
 * `/help <name>` for such a command answers as if it did not exist.
 */
export function renderCommandHelp(
  defs: readonly CommandDefinition[],
  opts: { isOwner: boolean; topic?: string },
): string {
  const topic = opts.topic?.trim().replace(/^\//, "").split("@")[0]?.toLowerCase();
  if (topic) {
    const def = defs.find((d) => d.name === topic || (d.aliases ?? []).includes(topic));
    if (!def || !visibleTo(def, opts.isOwner)) {
      return `Unknown command: /${topic}. Send /help for the list.`;
    }
    const parts = [line(def)];
    if (def.aliases && def.aliases.length > 0) {
      parts.push(`Aliases: ${def.aliases.map((a) => `/${a}`).join(", ")}`);
    }
    if (def.usage) parts.push(def.usage);
    const subs = Object.entries(def.subcommands ?? {});
    if (subs.length > 0) {
      parts.push(
        ["Subcommands:", ...subs.map(([name, s]) => `  ${name}${s.args ? ` ${s.args}` : ""} - ${s.description}`)].join("\n"),
      );
    }
    return parts.join("\n\n");
  }

  const sections: string[] = [];
  for (const cat of COMMAND_CATEGORIES) {
    const lines = defs.filter((d) => d.category === cat && visibleTo(d, opts.isOwner)).map(line);
    if (lines.length > 0) sections.push([CATEGORY_TITLES[cat], ...lines].join("\n"));
  }
  if (sections.length === 0) return "No commands available.";
  sections.push("Send /help <command> for details.");
  return sections.join("\n\n");
}

/**
 * Menu entries for the platform (Telegram setMyCommands). Hidden commands
 * are left out; owner-only ones only when `forOwner`. Capped at 100.
 */
export function buildCommandMenu(
  defs: readonly CommandDefinition[],
  opts: { forOwner: boolean },
): Array<{ command: string; description: string }> {
  return byCategory(defs)
    .filter((d) => !d.hidden && visibleTo(d, opts.forOwner))
    .slice(0, COMMAND_MENU_MAX)
    .map((d) => ({ command: d.name, description: d.description.slice(0, 256) }));
}
