/**
 * Telegram auth - bot token validation and sender verification.
 */

import { Bot } from "grammy";

/**
 * Validate a bot token by calling getMe().
 * @param apiRoot - Optional custom Bot API root (self-hosted telegram-bot-api server).
 * @returns The bot's user info if valid.
 * @throws If the token is invalid or the API is unreachable.
 */
export async function validateBotToken(token: string, apiRoot?: string): Promise<{
  id: number;
  username: string;
  firstName: string;
}> {
  const bot = apiRoot ? new Bot(token, { client: { apiRoot } }) : new Bot(token);
  const me = await bot.api.getMe();
  return {
    id: me.id,
    username: me.username ?? "",
    firstName: me.first_name,
  };
}

/**
 * Build a sender ID string from a Telegram user ID.
 * This is the canonical format used across Kirie for Telegram identities.
 */
export function makeSenderId(userId: number): string {
  return String(userId);
}

/**
 * Build a human-readable display name from Telegram user fields.
 */
export function makeDisplayName(firstName: string, lastName?: string, username?: string): string {
  if (firstName && lastName) {
    return `${firstName} ${lastName}`;
  }
  if (firstName) {
    return firstName;
  }
  if (username) {
    return `@${username}`;
  }
  return "Unknown";
}
