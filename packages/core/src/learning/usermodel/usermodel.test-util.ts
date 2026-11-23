/**
 * Test-only helpers for the user model tests (not exported, not bundled).
 * Everything lives in fresh temp directories; nothing touches ~/.kirie.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@kirie/memory";
import { ChatHistoryStore } from "../../mcp/tools/chat-history.js";
import { UserModelConfigSchema, type UserModelConfig } from "../../config/sections/usermodel.js";
import { openLearningDb, type LearningDb } from "../learning-db.js";

export const OWNER_ID = "1001";
export const STRANGER_ID = "2002";
export const OWNER_DM = `telegram:dm:${OWNER_ID}`;
export const STRANGER_DM = `telegram:dm:${STRANGER_ID}`;
export const GROUP_KEY = "telegram:group:-500";

export const testOwners = {
  isOwner: (channel: string, senderId: string): boolean => channel === "telegram" && senderId === OWNER_ID,
};

export function userModelConfig(over: Partial<UserModelConfig> = {}): UserModelConfig {
  return { ...UserModelConfigSchema.parse({}), ...over };
}

export interface TempUserModelEnv {
  dir: string;
  db: LearningDb;
  historyPath: string;
  history: Database.Database;
  /** Insert a chat-history row directly (bypassing the store's own scrubbing). Returns its id. */
  addRow(row: { sessionKey?: string; role?: "user" | "assistant"; senderId?: string | null; senderName?: string | null; content: string; channel?: string; createdAt?: string }): number;
  /** A turn_log row for a stored user message. */
  addTurn(userMsgId: number, origin: string, sessionKey?: string): void;
  cleanup(): void;
}

export function tempUserModelEnv(prefix = "kirie-usermodel-"): TempUserModelEnv {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = openLearningDb(join(dir, "learning.db"));
  const historyPath = join(dir, "chat-history.db");
  new ChatHistoryStore(historyPath).close();
  const history = new Database(historyPath);
  return {
    dir,
    db,
    historyPath,
    history,
    addRow(row) {
      const res = history
        .prepare("INSERT INTO messages (session_key, role, sender_name, sender_id, content, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          row.sessionKey ?? OWNER_DM,
          row.role ?? "user",
          row.senderName === undefined ? "Owner" : row.senderName,
          row.senderId === undefined ? OWNER_ID : row.senderId,
          row.content,
          row.channel ?? "telegram",
          row.createdAt ?? "2026-11-20 10:00:00",
        );
      return Number(res.lastInsertRowid);
    },
    addTurn(userMsgId, origin, sessionKey = OWNER_DM) {
      db.prepare(
        `INSERT INTO turn_log (session_key, source, origin, user_msg_id, started_at, ended_at) VALUES (?, 'main', ?, ?, ?, ?)`,
      ).run(sessionKey, origin, userMsgId, "2026-11-20T10:00:00.000Z", "2026-11-20T10:00:05.000Z");
    },
    cleanup() {
      try { history.close(); } catch { /* closed */ }
      try { db.close(); } catch { /* closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const DIMS = 64;

function hashWord(w: string): number {
  let h = 2166136261;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
  return h % DIMS;
}

/** Deterministic bag-of-words vectors: same words, same vector. `overrides` maps exact texts to vectors. */
export function stubEmbedder(overrides: Record<string, number[]> = {}): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "stub-local",
    dimensions: DIMS,
    calls,
    async embed(texts: string[]) {
      calls.push([...texts]);
      return texts.map((t) => {
        if (overrides[t]) return overrides[t]!;
        const v = new Array<number>(DIMS).fill(0);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[hashWord(w)]! += 1;
        return v;
      });
    },
  };
}

/** A unit vector along one axis, plus a small offset on another (for cosine tests). */
export function axisVector(axis: number, tilt = 0, tiltAxis = (axis + 1) % DIMS): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = 1;
  v[tiltAxis] = tilt;
  return v;
}
