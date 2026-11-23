/**
 * Platform command menus (PLAN B.4 rule 6): the default scope gets the public
 * menu; each configured owner's own chat gets the full menu. Re-run on every
 * channel "started" event so a channel that reconnects gets its menu again.
 */

import { createModuleLogger, type ChannelAdapter, type CommandRegistry, type KirieConfig } from "@kirie/core";

const log = createModuleLogger("command-menus");

type OwnerIdentityLists = KirieConfig["security"]["owner"]["identities"];

export async function registerCommandMenus(
  adapter: Pick<ChannelAdapter, "id" | "registerCommands">,
  commands: Pick<CommandRegistry, "menu">,
  ownerIds: OwnerIdentityLists,
): Promise<void> {
  if (typeof adapter.registerCommands !== "function") return;
  try {
    await adapter.registerCommands(commands.menu({ forOwner: false }));
    const ids = (ownerIds as Record<string, ReadonlyArray<string | number> | undefined>)[adapter.id] ?? [];
    const ownerMenu = commands.menu({ forOwner: true });
    for (const id of ids) {
      const chatId = String(id).trim();
      if (chatId) await adapter.registerCommands(ownerMenu, { chatId });
    }
  } catch (err) {
    log.warn({ channel: adapter.id, err: err instanceof Error ? err.message : String(err) }, "failed to register command menus");
  }
}
