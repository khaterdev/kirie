/**
 * The chat-history `forwarded` column: additive and nullable, so a database
 * from before it still opens, keeps its rows, and gains the column.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ChatHistoryStore } from "./chat-history.js";

describe("ChatHistoryStore forwarded flag", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-chat-fwd-"));
    path = join(dir, "chat-history.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an old database (no forwarded column) opens, keeps its rows as null, and gains the column", () => {
    const old = new Database(path);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, role TEXT NOT NULL,
        sender_name TEXT, sender_id TEXT, content TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages (session_key, role, sender_id, content, channel) VALUES ('telegram:dm:1', 'user', '1', 'old row', 'telegram');
    `);
    old.close();

    const store = new ChatHistoryStore(path);
    const rows = store.recent("telegram:dm:1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("old row");
    expect(rows[0]!.forwarded).toBeNull();

    store.append("telegram:dm:1", "user", "passed on", { senderId: "1", channel: "telegram", forwarded: true });
    store.append("telegram:dm:1", "user", "typed", { senderId: "1", channel: "telegram" });
    const after = store.recent("telegram:dm:1");
    expect(after.map((r) => [r.content, r.forwarded])).toEqual([["old row", null], ["passed on", 1], ["typed", null]]);
    expect(store.search("passed")[0]!.forwarded).toBe(1);
    store.close();

    // Opening again (the column now exists) is a no-op.
    const again = new ChatHistoryStore(path);
    expect(again.recent("telegram:dm:1")).toHaveLength(3);
    again.close();
  });

  it("two stores opening the same new file both work (the second sees the column)", () => {
    const a = new ChatHistoryStore(path);
    const b = new ChatHistoryStore(path);
    a.append("k", "user", "x", { forwarded: true });
    expect(b.recent("k")[0]!.forwarded).toBe(1);
    a.close();
    b.close();
  });
});
