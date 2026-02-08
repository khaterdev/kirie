import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "pairing.db");
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[bytes[i]! % CODE_CHARS.length];
  }
  return code;
}

export interface PairingRequest {
  code: string;
  channel: string;
  senderId: string;
  senderName: string;
  createdAt: string;
  expiresAt: string;
  approved: boolean;
}

export class PairingStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_requests (
        code       TEXT PRIMARY KEY,
        channel    TEXT NOT NULL,
        sender_id  TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        approved   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pairing_sender
        ON pairing_requests(channel, sender_id);
    `);
  }

  /** Generate a new pairing code for a DM request */
  createRequest(channel: string, senderId: string, senderName: string): string {
    const code = generateCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

    this.db.prepare(`
      INSERT INTO pairing_requests (code, channel, sender_id, sender_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, channel, senderId, senderName, now.toISOString(), expiresAt.toISOString());

    return code;
  }

  /** Look up a pairing request by code */
  getRequest(code: string): PairingRequest | null {
    const row = this.db.prepare(
      "SELECT * FROM pairing_requests WHERE code = ?"
    ).get(code) as { code: string; channel: string; sender_id: string; sender_name: string; created_at: string; expires_at: string; approved: number } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) return null; // expired

    return {
      code: row.code,
      channel: row.channel,
      senderId: row.sender_id,
      senderName: row.sender_name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approved: row.approved === 1,
    };
  }

  /** Approve a pairing request */
  approve(code: string): boolean {
    const result = this.db.prepare(
      "UPDATE pairing_requests SET approved = 1 WHERE code = ?"
    ).run(code);
    return result.changes > 0;
  }

  /** Clean up expired pairing requests */
  cleanExpired(): number {
    const result = this.db.prepare(
      "DELETE FROM pairing_requests WHERE expires_at < datetime('now')"
    ).run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
