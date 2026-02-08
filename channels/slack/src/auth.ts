/**
 * Slack auth - bot token and app token validation, user ID verification.
 */

import { type webApi } from "@slack/bolt";

/**
 * Validate Slack tokens by calling auth.test.
 * @returns Bot user info if valid
 */
export async function validateSlackTokens(
  client: webApi.WebClient,
): Promise<{ botUserId: string; teamId: string; teamName: string }> {
  const result = await client.auth.test();
  if (!result.ok) {
    throw new Error(`Slack auth.test failed: ${result.error}`);
  }
  return {
    botUserId: result.user_id as string,
    teamId: result.team_id as string,
    teamName: (result.team as string) ?? "",
  };
}

/**
 * Build a sender ID string from a Slack user ID.
 */
export function makeSenderId(userId: string): string {
  return userId;
}

/**
 * Build a display name from Slack user profile fields.
 */
export function makeDisplayName(
  realName?: string,
  displayName?: string,
  username?: string,
): string {
  if (displayName) return displayName;
  if (realName) return realName;
  if (username) return username;
  return "Unknown";
}
