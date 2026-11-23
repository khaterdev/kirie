/**
 * Keep `user_fact.add` proposals in step with `/profile forget` and
 * `/profile wipe` (only used with `userModel.requireApproval`).
 *
 * A forgotten statement must not survive anywhere in the user model, and a
 * wipe must not leave approvable facts behind. So the matching proposals are
 * retired: a pending one is dropped (status `rejected`, decided by `system`,
 * which can never apply anything), and every matching row of this kind has
 * its title, rationale and payload replaced by a fixed placeholder. Only rows
 * of kind `user_fact.add` are touched.
 */

import { ProposalStore } from "../proposal-store.js";
import type { LearningDb } from "../learning-db.js";
import { userFactStatementHash } from "./fact-store.js";

const REDACTED_TITLE = "Profile fact (removed by /profile)";
const REDACTED_PAYLOAD = JSON.stringify({ redacted: true });

export interface UserFactProposalRetirement {
  dropped: number;
  redacted: number;
}

/** Retire the `user_fact.add` proposals whose statement hash is in `hashes`, or all of them with "all". */
export function retireUserFactProposals(db: LearningDb, hashes: ReadonlySet<string> | "all", now: Date): UserFactProposalRetirement {
  const store = new ProposalStore(db);
  const rows = db.prepare("SELECT id, status, payload FROM proposals WHERE kind = 'user_fact.add'").all() as Array<{ id: number; status: string; payload: string }>;
  const result: UserFactProposalRetirement = { dropped: 0, redacted: 0 };
  const redact = db.prepare("UPDATE proposals SET title = ?, rationale = '', payload = ? WHERE id = ? AND kind = 'user_fact.add'");
  for (const row of rows) {
    let statement = "";
    try {
      const p = JSON.parse(row.payload) as { statement?: unknown; redacted?: unknown };
      if (p.redacted === true) continue;
      statement = typeof p.statement === "string" ? p.statement : "";
    } catch {
      // unreadable payload: redact it with the rest only on "all"
    }
    if (hashes !== "all" && !hashes.has(userFactStatementHash(statement))) continue;
    if (row.status === "pending" && store.markDroppedBySystem(row.id, "removed by /profile", now.toISOString())) result.dropped++;
    if (row.status === "applying") continue;
    redact.run(REDACTED_TITLE, REDACTED_PAYLOAD, row.id);
    result.redacted++;
  }
  return result;
}
