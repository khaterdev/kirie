/**
 * Webhook handler for Telegram bot updates.
 * Provides a request handler that verifies the secret_token header
 * and passes updates to the Grammy bot.
 */

import type { Bot } from "grammy";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Webhook configuration */
export interface WebhookConfig {
  /** Public URL where the webhook is accessible */
  url: string;
  /** Secret token for header verification */
  secretToken: string;
  /** Port to listen on (if running standalone) */
  port?: number;
}

/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifySecretToken(received: string | null | undefined, expected: string): boolean {
  if (!received) return false;

  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Generate a random secret token for webhook verification.
 */
export function generateSecretToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Set the webhook on the Telegram API.
 *
 * @param bot - Grammy Bot instance
 * @param config - Webhook configuration
 */
export async function setWebhook(bot: Bot, config: WebhookConfig): Promise<void> {
  await bot.api.setWebhook(config.url, {
    secret_token: config.secretToken,
    allowed_updates: ["message", "edited_message", "message_reaction"],
  });
}

/**
 * Remove the webhook from the Telegram API.
 */
export async function deleteWebhook(bot: Bot): Promise<void> {
  await bot.api.deleteWebhook();
}

/**
 * Create a webhook update handler function.
 * This can be used as middleware in Hono, Express, etc.
 *
 * @param bot - Grammy Bot instance
 * @param secretToken - Expected secret token
 * @returns A handler function that processes incoming webhook requests
 */
export function createWebhookHandler(
  bot: Bot,
  secretToken: string,
): (body: unknown, secretHeader: string | null | undefined) => Promise<boolean> {
  return async (body: unknown, secretHeader: string | null | undefined): Promise<boolean> => {
    if (!verifySecretToken(secretHeader, secretToken)) {
      return false;
    }

    try {
      const update = typeof body === "string" ? JSON.parse(body) : body;
      await bot.handleUpdate(update);
      return true;
    } catch {
      return false;
    }
  };
}
