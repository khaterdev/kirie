import { z } from "zod/v3";

/**
 * `userModel` (PLAN B.11, R4 item 5): a local model of the owner, built from
 * owner-authored DM messages only. Runtime overrides: `userModel.enabled`, `userModel.inject`.
 */
export const UserModelConfigSchema = z.object({
  /** Derive and maintain a local user model. Off by default; /profile on. */
  enabled: z.boolean().default(false),
  /** Inject the generated card (USER.md) into the owner's DM prompt. Only meaningful when enabled. */
  inject: z.boolean().default(true),
  injectBackground: z.boolean().default(false),
  /** Unset = the utility model (proactive.tier2Model). */
  model: z.string().optional(),
  promptBudgetChars: z.number().int().min(200).max(6000).default(1500),
  minNewMessages: z.number().int().min(1).default(30),
  minHoursBetweenRuns: z.number().min(0).default(12),
  batchMaxChars: z.number().int().min(2000).default(40_000),
  maxBatchesPerRun: z.number().int().min(1).default(4),
  maxCostUsdPerDay: z.number().min(0).default(0.3),
  /**
   * Reserved, not read: facts are derived only from messages the owner wrote in
   * their DM. Agent-written memory entries can carry tool or web content, so
   * they are not an input (W3-UM handoff).
   */
  memoryPrefixes: z.array(z.string()).default(["owner:", "person:", "rule:"]),
  /** Route new or changed facts through the proposals store. */
  requireApproval: z.boolean().default(false),
  excludeCategories: z.array(z.string()).default([
    "health", "sexuality", "religion", "politics", "ethnicity", "legal_status",
    "finances", "government_id", "credentials", "home_address", "third_party_private",
  ]),
  /** Use the daemon's remote embedding provider (OpenAI) for fact statements. Off: local ONNX model or none. */
  allowRemoteEmbeddings: z.boolean().default(false),
}).default({});

export type UserModelConfig = z.infer<typeof UserModelConfigSchema>;
