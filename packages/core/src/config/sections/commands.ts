import { z } from "zod/v3";

/** `commands` (PLAN B.11, R2 section 1): the slash-command framework. */
export const CommandsConfigSchema = z.object({
  /** What to do with "/name" that is not a registered command. "agent" keeps today's behaviour. */
  unknownCommand: z.enum(["agent", "reply"]).default("agent"),
  /** Register the command menu with platforms that support it. */
  registerMenu: z.boolean().default(true),
  /** Default lifetime for owner prompts that do not set one. */
  promptTimeoutSeconds: z.number().int().min(5).max(86_400).default(300),
  /** Max owner prompts pending at once. Extra requests resolve to their safe default. */
  maxPendingPrompts: z.number().int().min(1).max(50).default(10),
}).default({});

export type CommandsConfig = z.infer<typeof CommandsConfigSchema>;
