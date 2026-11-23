/**
 * `user_fact.add` proposal handler (PLAN B.7, C.5): used only with
 * `userModel.requireApproval: true`, when the deriver files new or changed
 * facts as proposals. The applier calls it after the owner approved
 * (`/proposals approve`, or the Approve button); nothing else reaches it.
 *
 * At apply time the statement is checked again (sensitive, secret, injection,
 * instruction), a statement forgotten since the proposal was filed is refused,
 * a fact the proposal replaces must still be active and unpinned, and the
 * confidence is assigned here by code.
 */

import { z } from "zod/v3";
import type { EmbeddingProvider } from "@kirie/memory";
import type { UserModelConfig } from "../../config/sections/usermodel.js";
import { ProposalApplyError, type ProposalKindHandler } from "../applier.js";
import { USER_MODEL_TOMBSTONE_COSINE, checkUserFactStatement } from "./checks.js";
import { userModelConfirmation, userModelInitialConfidence } from "./deriver.js";
import { embedUserModelTexts } from "./embedder.js";
import { USER_FACT_CATEGORIES, userFactEvidenceDays, userModelCosine, type UserFactEvidenceRef, type UserFactStore } from "./fact-store.js";
import { userModelExcludedCategories } from "./sensitive.js";

export const USER_FACT_PROPOSAL_KIND = "user_fact.add" as const;

const EvidenceSchema = z.union([
  z.object({ t: z.literal("chat"), id: z.number().int(), ts: z.string().max(40).optional() }),
  z.object({ t: z.literal("command"), at: z.string().max(40) }),
]);

export const UserFactProposalPayloadSchema = z.object({
  op: z.enum(["add", "update", "contradict"]).default("add"),
  category: z.enum(USER_FACT_CATEGORIES),
  statement: z.string().min(1).max(240),
  kind: z.enum(["explicit", "inferred"]),
  evidence: z.array(EvidenceSchema).min(1).max(50),
  replaces: z.number().int().positive().optional(),
});
export type UserFactProposalPayload = z.infer<typeof UserFactProposalPayloadSchema>;

export interface UserFactApplyDeps {
  store: UserFactStore;
  config: () => UserModelConfig;
  embedder: () => EmbeddingProvider | null;
  /** Called after a fact was written or removed (card re-render). */
  onChanged?: () => void;
  now?: () => Date;
}

function parsePayload(payload: unknown): UserFactProposalPayload {
  const parsed = UserFactProposalPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ProposalApplyError("invalid", "the profile fact proposal is malformed");
  return parsed.data;
}

export function createUserFactApplyHandler(deps: UserFactApplyDeps): ProposalKindHandler {
  const now = (): Date => deps.now?.() ?? new Date();
  return {
    async apply(payload) {
      const p = parsePayload(payload);
      const checked = checkUserFactStatement(p.statement, p.category, p.kind, userModelExcludedCategories(deps.config().excludeCategories));
      if (!checked.ok) throw new ProposalApplyError("invalid", `the statement was refused (${checked.reason})`);
      const [vector] = await embedUserModelTexts(deps.embedder(), [checked.statement]);
      const tombstoned = deps.store.isTombstoned(checked.hash) ||
        deps.store.tombstones().some((t) => userModelCosine(vector ?? null, t.embedding) >= USER_MODEL_TOMBSTONE_COSINE);
      if (tombstoned) throw new ProposalApplyError("stale", "you asked me to forget this fact");
      const at = now();
      const refs = p.evidence as UserFactEvidenceRef[];

      let replaced: number | null = null;
      if (p.replaces !== undefined) {
        const target = deps.store.get(p.replaces);
        if (!target || target.status !== "active") throw new ProposalApplyError("stale", `fact #${p.replaces} is no longer active`);
        if (target.pinned) throw new ProposalApplyError("conflict", `fact #${p.replaces} is pinned`);
        replaced = target.id;
      }

      const existing = deps.store.findActiveByHash(checked.hash);
      if (existing && existing.id !== replaced) {
        deps.store.confirm(existing.id, { ...userModelConfirmation(existing, refs, p.kind), now: at });
        deps.onChanged?.();
        return { factId: existing.id, confirmed: true };
      }

      const fact = deps.store.insert({
        category: p.category,
        statement: checked.statement,
        kind: p.kind,
        confidence: userModelInitialConfidence(p.op, p.kind),
        evidence: refs,
        evidenceDays: userFactEvidenceDays(refs).size,
        embedding: vector ?? null,
        now: at,
      });
      if (replaced !== null) deps.store.supersede(replaced, fact.id, at);
      deps.onChanged?.();
      return { factId: fact.id, replaced };
    },

    async undo(applyResult) {
      const factId = typeof applyResult.factId === "number" ? applyResult.factId : null;
      if (factId === null || applyResult.confirmed === true) return;
      const at = now();
      deps.store.delete(factId);
      const replaced = typeof applyResult.replaced === "number" ? applyResult.replaced : null;
      if (replaced !== null) {
        const old = deps.store.get(replaced);
        if (old && old.status === "superseded" && old.supersededBy === factId) deps.store.reactivate(replaced, at);
      }
      deps.onChanged?.();
    },

    preview(payload) {
      const p = parsePayload(payload);
      const refs = p.evidence.map((e) => (e.t === "chat" ? `c:${e.id}` : "command")).join(", ");
      const verb = p.op === "add" ? "New profile fact" : p.op === "update" ? `Update fact #${p.replaces}` : `Correct fact #${p.replaces}`;
      return `${verb} (${p.category}, ${p.kind}):\n${p.statement}\nEvidence: ${refs}`;
    },
  };
}
