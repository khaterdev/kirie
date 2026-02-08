import { Client, GatewayIntentBits } from "discord.js";

/**
 * Bot information returned after token validation.
 */
export interface DiscordBotInfo {
  /** Bot's user ID (snowflake) */
  id: string;
  /** Bot's username */
  username: string;
  /** Bot's discriminator */
  discriminator: string;
}

/**
 * Validate a Discord bot token by performing a login/logout cycle.
 * Returns basic bot info on success, throws on failure.
 *
 * @param token - The bot token to validate
 * @returns Bot info on success
 */
export async function validateBotToken(token: string): Promise<DiscordBotInfo> {
  if (!token || typeof token !== "string") {
    throw new Error("Discord bot token is required");
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(token);

    const user = client.user;
    if (!user) {
      throw new Error("Failed to retrieve bot user after login");
    }

    const info: DiscordBotInfo = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
    };

    client.destroy();
    return info;
  } catch (err) {
    client.destroy();

    if (err instanceof Error && err.message.includes("TOKEN_INVALID")) {
      throw new Error("Invalid Discord bot token");
    }
    throw err;
  }
}
