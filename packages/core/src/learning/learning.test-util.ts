/**
 * Test-only helpers for the learning tests (not exported, not bundled).
 * Everything lives in fresh temp directories; nothing touches ~/.kirie.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditRecord } from "../security/audit-trail.js";
import { openLearningDb, type LearningDb } from "./learning-db.js";
import type { LearningIntakeConfig } from "./intake.js";

export const OWNER_ID = "1001";
export const STRANGER_ID = "2002";
export const OWNER_DM_KEY = `telegram:dm:${OWNER_ID}`;

export interface TempLearningEnv {
  dir: string;
  db: LearningDb;
  cleanup(): void;
}

export function tempLearningEnv(prefix = "kirie-learning-"): TempLearningEnv {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = openLearningDb(join(dir, "learning.db"));
  return {
    dir,
    db,
    cleanup() {
      try { db.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FakeAudit {
  records: Array<Omit<AuditRecord, "ts">>;
  record(rec: Omit<AuditRecord, "ts">): void;
  recent(filter?: { feature?: string; action?: string; limit?: number }): AuditRecord[];
  actions(): string[];
}

export function fakeAudit(): FakeAudit {
  const records: Array<Omit<AuditRecord, "ts">> = [];
  return {
    records,
    record(rec) { records.push(rec); },
    recent(filter = {}) {
      return records
        .filter((r) => (!filter.feature || r.feature === filter.feature) && (!filter.action || r.action === filter.action))
        .slice(-(filter.limit ?? 50))
        .reverse()
        .map((r) => ({ ts: "2026-11-23T10:00:00.000Z", ...r }));
    },
    actions() { return records.map((r) => r.action); },
  };
}

export const fakeOwners = {
  isOwner: (channel: string, senderId: string): boolean => channel === "telegram" && senderId === OWNER_ID,
};

export function intakeConfig(over: Partial<LearningIntakeConfig> = {}): LearningIntakeConfig {
  return { maxPending: 20, maxProposalsPerDay: 6, rejectMemoryDays: 30, expiryDays: 14, allowUntrustedSkillProposals: false, ...over };
}

export function skillMd(name: string, description = `How to ${name}`, body = "1. Do the thing.\n2. Check it worked.\n"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`;
}

// Synthetic secrets are built at run time from fragments (PLAN B.15 rule 4).
let seed = 7;
export function synthToken(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let x = (seed++ * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    s += alphabet[x % alphabet.length];
  }
  return s;
}

export function fakeAnthropicKey(): string {
  return ["sk", "-ant-", "api03-", synthToken(40)].join("");
}
