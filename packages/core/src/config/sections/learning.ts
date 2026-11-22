import { z } from "zod/v3";

/**
 * `learning` (PLAN B.11, R4 item 3): reflection files proposals only; nothing
 * self-initiated is written or activated without the owner's approval. There is
 * deliberately no auto-approve key. Runtime override: `learning.enabled`.
 */
export const LearningConfigSchema = z.object({
  /** Automatic post-turn reflection. Off by default; /learn on. */
  enabled: z.boolean().default(false),
  /** Reflection model. Unset = the utility model (proactive.tier2Model). */
  model: z.string().optional(),
  scope: z.enum(["owner-dm"]).default("owner-dm"),
  minTurns: z.number().int().min(1).default(8),
  idleMinutes: z.number().int().min(1).default(20),
  complexTurnThreshold: z.number().int().min(1).default(15),
  maxInputChars: z.number().int().min(2000).default(60_000),
  maxReflectionsPerDay: z.number().int().min(0).default(12),
  maxCostUsdPerDay: z.number().min(0).default(0.5),
  maxProposalsPerDay: z.number().int().min(0).default(6),
  maxPending: z.number().int().min(1).default(20),
  expiryDays: z.number().int().min(1).default(14),
  rejectMemoryDays: z.number().int().min(0).default(30),
  dedupeThreshold: z.number().min(0).max(1).default(0.92),
  digestIntervalMinutes: z.number().int().min(5).default(180),
  /** "direct": the agent keeps saving facts to the memory DB itself. "propose": self-initiated saves become proposals. */
  memoryPolicy: z.enum(["direct", "propose"]).default("direct"),
  memoryMdMaxBytes: z.number().int().min(1024).default(16_384),
  skillWriteGuard: z.enum(["enforce", "audit", "off"]).default("enforce"),
  allowUntrustedSkillProposals: z.boolean().default(false),
  allowRemoteEmbeddings: z.boolean().default(false),
  /** Tools whose output counts as untrusted input for the turn (content not written by the owner). */
  untrustedTools: z.array(z.string()).default([
    "WebFetch", "WebSearch",
    "mcp__kirie-tools__web_fetch", "mcp__kirie-tools__web_search",
    "mcp__kirie-tools__browser", "mcp__kirie-tools__image",
    "mcp__playwright__*", "mcp__*",
  ]),
}).default({});

export type LearningConfig = z.infer<typeof LearningConfigSchema>;
