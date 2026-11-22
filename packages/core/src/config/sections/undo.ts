import { z } from "zod/v3";

/** `undo` (PLAN B.11, R1 item 11): per-turn file checkpoints and /undo. Runtime override: `undo.enabled`. */
export const UndoConfigSchema = z.object({
  /** Record per-turn file checkpoints (SDK file checkpointing) and allow /undo. */
  enabled: z.boolean().default(false),
  /** Also checkpoint background tasks. */
  backgroundTasks: z.boolean().default(true),
  /** Ledger rows kept per session. */
  maxTurnsPerSession: z.number().int().min(1).max(500).default(50),
  /** Ledger rows older than this are pruned. */
  retentionDays: z.number().int().min(1).default(14),
  /** How long a /undo preview stays confirmable. */
  confirmTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  /** Largest number of turns one /undo may cover. */
  maxTurnsPerUndo: z.number().int().min(1).max(20).default(5),
}).default({});

export type UndoConfig = z.infer<typeof UndoConfigSchema>;
