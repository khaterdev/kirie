import type Database from "better-sqlite3";

export interface ConversationLabel {
  sessionKey: string;
  label: string;
  createdAt: string;
}

export class LabelStore {
  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_labels (
        session_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_labels_label ON session_labels(label);
    `);
  }

  setLabel(sessionKey: string, label: string): void {
    this.db.prepare(`
      INSERT INTO session_labels (session_key, label)
      VALUES (?, ?)
      ON CONFLICT(session_key) DO UPDATE SET label = excluded.label
    `).run(sessionKey, label);
  }

  getByLabel(label: string): string | null {
    const row = this.db.prepare(
      "SELECT session_key FROM session_labels WHERE label = ?"
    ).get(label) as { session_key: string } | undefined;
    return row?.session_key ?? null;
  }

  getLabel(sessionKey: string): string | null {
    const row = this.db.prepare(
      "SELECT label FROM session_labels WHERE session_key = ?"
    ).get(sessionKey) as { label: string } | undefined;
    return row?.label ?? null;
  }

  listLabels(): ConversationLabel[] {
    return this.db.prepare(
      "SELECT session_key as sessionKey, label, created_at as createdAt FROM session_labels ORDER BY created_at DESC"
    ).all() as ConversationLabel[];
  }

  deleteLabel(sessionKey: string): boolean {
    const result = this.db.prepare("DELETE FROM session_labels WHERE session_key = ?").run(sessionKey);
    return result.changes > 0;
  }
}
