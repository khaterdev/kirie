import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { MediaAttachment, MediaKind } from "./types.js";

const DEFAULT_MEDIA_DIR = join(homedir(), ".kirie", "media");

/**
 * SQLite-backed media metadata store with local file caching.
 */
export class MediaStore {
  private readonly db: Database.Database;
  private readonly cacheDir: string;

  constructor(opts?: { dbPath?: string; cacheDir?: string }) {
    const mediaDir = opts?.cacheDir ?? DEFAULT_MEDIA_DIR;
    this.cacheDir = join(mediaDir, "files");
    mkdirSync(this.cacheDir, { recursive: true });

    const dbPath = opts?.dbPath ?? join(mediaDir, "media.db");
    mkdirSync(join(dbPath, ".."), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        mime_type     TEXT NOT NULL,
        url           TEXT,
        local_path    TEXT,
        filename      TEXT,
        size_bytes    INTEGER,
        width         INTEGER,
        height        INTEGER,
        duration_ms   INTEGER,
        is_voice      INTEGER DEFAULT 0,
        transcript    TEXT,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
  }

  /** Store a media entry. If `buffer` is provided, cache the file locally. */
  save(
    attachment: Omit<MediaAttachment, "id"> & { id?: string },
    buffer?: Buffer,
  ): MediaAttachment {
    const id = attachment.id ?? randomUUID();

    let localPath = attachment.localPath;
    if (buffer && !localPath) {
      const ext = attachment.filename?.includes(".")
        ? attachment.filename.slice(attachment.filename.lastIndexOf("."))
        : "";
      const cacheFile = join(this.cacheDir, `${id}${ext}`);
      writeFileSync(cacheFile, buffer);
      localPath = cacheFile;
    }

    const entry: MediaAttachment = { ...attachment, id, localPath };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO media
         (id, kind, mime_type, url, local_path, filename, size_bytes, width, height, duration_ms, is_voice, transcript)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.kind,
        entry.mimeType,
        entry.url ?? null,
        entry.localPath ?? null,
        entry.filename ?? null,
        entry.sizeBytes ?? null,
        entry.width ?? null,
        entry.height ?? null,
        entry.durationMs ?? null,
        entry.isVoice ? 1 : 0,
        entry.transcript ?? null,
      );

    return entry;
  }

  /** Retrieve a media entry by ID. */
  get(id: string): MediaAttachment | undefined {
    const row = this.db
      .prepare("SELECT * FROM media WHERE id = ?")
      .get(id) as MediaRow | undefined;

    if (!row) return undefined;
    return rowToAttachment(row);
  }

  /** Read the cached file bytes for a media entry. */
  readCachedFile(id: string): Buffer | undefined {
    const entry = this.get(id);
    if (!entry?.localPath || !existsSync(entry.localPath)) return undefined;
    return readFileSync(entry.localPath);
  }

  /** List media entries, newest first. */
  list(opts?: { limit?: number; kind?: MediaKind }): MediaAttachment[] {
    let sql = "SELECT * FROM media";
    const params: unknown[] = [];

    if (opts?.kind) {
      sql += " WHERE kind = ?";
      params.push(opts.kind);
    }

    sql += " ORDER BY created_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as MediaRow[];
    return rows.map(rowToAttachment);
  }

  /** Delete a media entry and its cached file. */
  delete(id: string): boolean {
    const entry = this.get(id);
    if (!entry) return false;

    if (entry.localPath && existsSync(entry.localPath)) {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      unlinkSync(entry.localPath);
    }

    return this.db.prepare("DELETE FROM media WHERE id = ?").run(id).changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

interface MediaRow {
  id: string;
  kind: string;
  mime_type: string;
  url: string | null;
  local_path: string | null;
  filename: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  is_voice: number;
  transcript: string | null;
  created_at: number;
}

function rowToAttachment(row: MediaRow): MediaAttachment {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    mimeType: row.mime_type,
    url: row.url ?? undefined,
    localPath: row.local_path ?? undefined,
    filename: row.filename ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    isVoice: row.is_voice === 1 ? true : undefined,
    transcript: row.transcript ?? undefined,
  };
}
