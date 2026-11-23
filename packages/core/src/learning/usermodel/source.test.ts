/**
 * Deriver input source: forwarded messages are someone else's words and never
 * reach the user model; databases without the forwarded column still work.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { USER_MODEL_PERMANENT_REJECTIONS, classifyUserModelRow, openUserModelHistorySource, type UserModelHistoryRow } from "./source.js";
import { OWNER_DM, OWNER_ID, tempUserModelEnv, testOwners, type TempUserModelEnv } from "./usermodel.test-util.js";

let env: TempUserModelEnv | null = null;
let dir: string | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function row(over: Partial<UserModelHistoryRow> = {}): UserModelHistoryRow {
  return {
    id: 1, session_key: OWNER_DM, role: "user", sender_name: "Owner", sender_id: OWNER_ID,
    content: "I prefer tea", channel: "telegram", created_at: "2026-11-20 10:00:00", ...over,
  };
}

describe("user model source and forwarded messages", () => {
  it("refuses a forwarded owner message, permanently, and accepts the same text typed", () => {
    expect(classifyUserModelRow(row({ forwarded: 1 }), { owners: testOwners, origin: "owner_message" })).toEqual({ ok: false, reason: "forwarded" });
    expect(USER_MODEL_PERMANENT_REJECTIONS.has("forwarded")).toBe(true);
    expect(classifyUserModelRow(row({ forwarded: null }), { owners: testOwners, origin: "owner_message" })).toEqual({ ok: true, content: "I prefer tea" });
    expect(classifyUserModelRow(row(), { owners: testOwners, origin: "owner_message" }).ok).toBe(true);
  });

  it("reads the forwarded flag from chat history", () => {
    env = tempUserModelEnv();
    const typed = env.addRow({ content: "typed" });
    const fwd = env.addRow({ content: "forwarded" });
    env.history.prepare("UPDATE messages SET forwarded = 1 WHERE id = ?").run(fwd);
    const src = openUserModelHistorySource(env.historyPath);
    const rows = src.userRowsAfter(0, 10);
    expect(rows.map((r) => [r.id, r.forwarded])).toEqual([[typed, null], [fwd, 1]]);
    expect(src.byIds([fwd])[0]!.forwarded).toBe(1);
    src.close();
  });

  it("works on a chat-history database that has no forwarded column yet", () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-um-oldhist-"));
    const path = join(dir, "chat-history.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, role TEXT NOT NULL,
        sender_name TEXT, sender_id TEXT, content TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    old.prepare("INSERT INTO messages (session_key, role, sender_id, content, channel) VALUES (?, 'user', ?, 'old', 'telegram')").run(OWNER_DM, OWNER_ID);
    old.close();
    const src = openUserModelHistorySource(path);
    const rows = src.userRowsAfter(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.forwarded).toBeNull();
    src.close();
  });
});
