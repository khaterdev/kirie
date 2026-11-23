/**
 * Deriver input: messages the owner wrote in their own DM, and nothing else
 * (PLAN C.5 "Inputs are owner-authored only").
 *
 * A chat-history row is used only when all of these hold:
 * - `role = 'user'` (assistant text is model output and can echo tool or web content);
 * - its session key is a DM (`<channel>:dm:<chatId>`) on the row's own channel, not the voice channel;
 * - its `sender_id` is a configured owner on that channel (for Telegram the DM chat id is the sender);
 * - it is not a command (`/...`), a reaction record (`[reacted ...]`, `[removed ...]`) or empty;
 * - it was not forwarded: a forward (chat-history `forwarded = 1`) is someone else's words;
 * - it did not come from a schedule, loop, webhook or goal turn: when `turn_log` has a row for
 *   it, that turn's origin must be `owner_message`. A row stored after turn logging started
 *   with no turn row is of unknown provenance and refused; history from before the turn log
 *   is accepted unless it carries a synthetic sender name those turns use.
 *
 * Other people's messages, group chats, tool output, web content, webhook
 * payloads and scheduled text therefore never reach the model.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import type { ChannelName } from "../../channels/normalizer.js";
import { parseSessionKey } from "../../routing/session-key.js";
import type { LearningDb } from "../learning-db.js";

export interface UserModelHistoryRow {
  id: number;
  session_key: string;
  role: string;
  sender_name: string | null;
  sender_id: string | null;
  content: string;
  channel: string;
  created_at: string;
  /** 1 when the owner forwarded it from someone else; null or absent otherwise (and on older databases) */
  forwarded?: number | null;
}

/** Read-only view of chat history for the deriver and `/profile why`. */
export interface UserModelHistorySource {
  /** User-role DM rows with id > afterId, ascending. */
  userRowsAfter(afterId: number, limit: number): UserModelHistoryRow[];
  byIds(ids: readonly number[]): UserModelHistoryRow[];
  close(): void;
}

/** Sender names `injectMessage` gives synthetic turns (routing/pipeline.ts SENDER_NAMES). */
export const USER_MODEL_SYNTHETIC_SENDER_NAMES: ReadonlySet<string> = new Set(["Schedule", "Loop", "Webhook", "Goal"]);

/** Longer messages are cut: long pastes are logs, not self-description. */
export const USER_MODEL_MAX_MESSAGE_CHARS = 1200;

/**
 * Opens `chat-history.db` read-only on first use. A missing file means no
 * input yet (checked again on the next call).
 */
export function openUserModelHistorySource(path: string): UserModelHistorySource {
  let db: Database.Database | null = null;
  const handle = (): Database.Database | null => {
    if (db) return db;
    if (!existsSync(path)) return null;
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    return db;
  };
  const base = "id, session_key, role, sender_name, sender_id, content, channel, created_at";
  // The column is added by ChatHistoryStore on open; a database it has not opened yet has none.
  const columns = (d: Database.Database): string => {
    const names = (d.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    return names.includes("forwarded") ? `${base}, forwarded` : `${base}, NULL AS forwarded`;
  };
  return {
    userRowsAfter(afterId, limit) {
      const d = handle();
      if (!d) return [];
      return d
        .prepare(`SELECT ${columns(d)} FROM messages WHERE id > ? AND role = 'user' AND session_key LIKE '%:dm:%' ORDER BY id ASC LIMIT ?`)
        .all(afterId, limit) as UserModelHistoryRow[];
    },
    byIds(ids) {
      const d = handle();
      if (!d || ids.length === 0) return [];
      const list = ids.filter(Number.isInteger).slice(0, 200);
      return d.prepare(`SELECT ${columns(d)} FROM messages WHERE id IN (${list.map(() => "?").join(",")})`).all(...list) as UserModelHistoryRow[];
    },
    close() {
      db?.close();
      db = null;
    },
  };
}

/** Origins of the turns that stored these user messages, from `turn_log`. */
export function userModelTurnOrigins(db: LearningDb, msgIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  const ids = msgIds.filter(Number.isInteger);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT user_msg_id, origin FROM turn_log WHERE user_msg_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id ASC`)
      .all(...chunk) as Array<{ user_msg_id: number; origin: string }>;
    for (const r of rows) {
      const prev = out.get(r.user_msg_id);
      // Any non-owner turn on the row wins: fail closed.
      if (prev === undefined || prev === "owner_message") out.set(r.user_msg_id, r.origin);
    }
  }
  return out;
}

export type UserModelRowVerdict =
  | { ok: true; content: string }
  | {
      ok: false;
      reason: "not_user" | "not_dm" | "voice" | "not_owner" | "forwarded" | "synthetic" | "origin" | "no_turn" | "command" | "reaction" | "empty";
    };

/** Rejections that do not depend on timing (a turn row that is not written yet): safe to skip for good. */
export const USER_MODEL_PERMANENT_REJECTIONS: ReadonlySet<string> = new Set(["not_user", "not_dm", "voice", "not_owner", "forwarded"]);

/** Whether a history row is an owner-authored DM message the deriver may read. */
export function classifyUserModelRow(
  row: UserModelHistoryRow,
  ctx: {
    owners: { isOwner(channel: ChannelName, senderId: string): boolean };
    origin: string | undefined;
    /** Turn logging was already running when this row was stored, so it must have a turn row. */
    turnLogRequired?: boolean;
  },
): UserModelRowVerdict {
  if (row.role !== "user") return { ok: false, reason: "not_user" };
  const key = parseSessionKey(row.session_key);
  if (!key || key.chatType !== "dm" || key.channel !== row.channel) return { ok: false, reason: "not_dm" };
  if (key.channel === "voice") return { ok: false, reason: "voice" };
  const sender = row.sender_id ?? "";
  if (!sender || !ctx.owners.isOwner(key.channel as ChannelName, sender)) return { ok: false, reason: "not_owner" };
  if (key.channel === "telegram" && key.chatId !== sender) return { ok: false, reason: "not_owner" };
  if (row.forwarded === 1) return { ok: false, reason: "forwarded" };
  if (ctx.origin !== undefined) {
    if (ctx.origin !== "owner_message") return { ok: false, reason: "origin" };
  } else if (ctx.turnLogRequired) {
    return { ok: false, reason: "no_turn" };
  } else if (row.sender_name && USER_MODEL_SYNTHETIC_SENDER_NAMES.has(row.sender_name)) {
    return { ok: false, reason: "synthetic" };
  }
  const text = row.content.replace(/^\[edited\]\s*/, "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.startsWith("/")) return { ok: false, reason: "command" };
  if (/^\[(reacted|removed)\b/.test(text)) return { ok: false, reason: "reaction" };
  return { ok: true, content: text };
}

/** SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO to epoch ms; NaN when unparseable. */
export function parseUserModelHistoryTime(text: string): number {
  if (!text) return Number.NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
  return Date.parse(iso);
}
