/**
 * MemoryFileWatcher — monitors a directory for markdown/text file changes
 * and automatically syncs them into the memory system via MemoryManager.
 *
 * Uses chokidar for recursive directory watching with debounced change
 * handling to avoid redundant syncs during rapid save-while-typing.
 */

import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { MemoryManager } from "@kirie/memory";
import type { ChunkingConfig } from "@kirie/memory";

export interface FileWatcherOptions {
  /** Directory to watch for file changes */
  watchDir: string;
  /** The MemoryManager to sync files into */
  memoryManager: MemoryManager;
  /** File extensions to watch (default: [".md", ".txt", ".markdown"]) */
  extensions?: string[];
  /** Chunking config for large files (uses MemoryManager defaults if not set) */
  chunking?: ChunkingConfig;
  /** Tags to add to all file-sourced memories */
  tags?: string[];
  /** Debounce delay in ms for file changes (default: 500) */
  debounceMs?: number;
  /** Logger function (optional) */
  log?: (msg: string) => void;
}

const DEFAULT_EXTENSIONS = [".md", ".txt", ".markdown"];
const DEFAULT_DEBOUNCE_MS = 500;

export class MemoryFileWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly extensions: string[];
  private readonly debounceMs: number;
  private readonly tags: string[];
  private readonly log: (msg: string) => void;

  constructor(private readonly options: FileWatcherOptions) {
    this.extensions = options.extensions ?? DEFAULT_EXTENSIONS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.tags = options.tags ?? [];
    this.log = options.log ?? (() => {});
  }

  /**
   * Start watching the directory for file changes.
   * Emits add/change/unlink events through chokidar.
   */
  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }

    const dir = resolve(this.options.watchDir);
    this.log(`Starting file watcher on ${dir}`);

    this.watcher = watch(dir, {
      persistent: false,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath: string) => {
      if (this.isWatchedFile(filePath)) {
        this.handleChange(filePath);
      }
    });

    this.watcher.on("change", (filePath: string) => {
      if (this.isWatchedFile(filePath)) {
        this.handleChange(filePath);
      }
    });

    this.watcher.on("unlink", (filePath: string) => {
      if (this.isWatchedFile(filePath)) {
        this.handleUnlink(filePath);
      }
    });

    // Wait for the initial scan to complete
    await new Promise<void>((res) => {
      this.watcher!.on("ready", () => res());
    });

    this.log("File watcher ready");
  }

  /**
   * Stop watching and clean up all pending timers.
   */
  async stop(): Promise<void> {
    // Clear all pending debounce timers
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.log("File watcher stopped");
  }

  /**
   * Manually trigger sync for a single file.
   * Reads the file and stores it as a chunked document in memory.
   */
  async syncFile(filePath: string): Promise<{ chunks: number; skipped: number } | null> {
    const absPath = resolve(filePath);

    if (!this.isWatchedFile(absPath)) {
      this.log(`Skipping non-watched file: ${absPath}`);
      return null;
    }

    try {
      const content = await readFile(absPath, "utf-8");
      const key = this.buildKey(absPath);
      this.log(`Syncing file: ${key}`);

      const result = await this.options.memoryManager.storeDocument(key, content, {
        chunking: this.options.chunking,
        tags: [...this.tags, "file-sync"],
      });

      this.log(`Synced ${key}: ${result.chunks} chunks, ${result.skipped} skipped`);
      return result;
    } catch (err) {
      this.log(`Error syncing file ${absPath}: ${err}`);
      return null;
    }
  }

  /**
   * Remove all memory entries associated with a file.
   * Finds all chunk keys matching the file key prefix and deletes them.
   */
  async removeFile(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    const key = this.buildKey(absPath);
    this.log(`Removing memories for file: ${key}`);

    // Delete any entries whose key starts with the file key.
    // Chunks are stored as `<key>:chunk:<index>:L<start>-<end>`
    // We also try deleting the exact key in case it was stored as a single entry.
    const allEntries = this.options.memoryManager.list(undefined, 10000);
    let deleted = 0;

    for (const entry of allEntries) {
      if (entry.key === key || entry.key.startsWith(`${key}:chunk:`)) {
        this.options.memoryManager.delete(entry.key);
        deleted++;
      }
    }

    this.log(`Removed ${deleted} memory entries for ${key}`);
  }

  /**
   * Check if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }

  /**
   * Build the memory key from an absolute file path.
   * Format: `file:<relative-path>` where relative-path is relative to the watch dir.
   */
  buildKey(filePath: string): string {
    const dir = resolve(this.options.watchDir);
    const rel = relative(dir, resolve(filePath));
    return `file:${rel}`;
  }

  /**
   * Check if a file has a watched extension.
   */
  isWatchedFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return this.extensions.includes(ext);
  }

  /**
   * Handle file add/change with debouncing.
   * Rapid successive changes within the debounce window are collapsed into one sync.
   */
  private handleChange(filePath: string): void {
    // Clear any existing pending timer for this file
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      void this.syncFile(filePath);
    }, this.debounceMs);

    this.pending.set(filePath, timer);
  }

  /**
   * Handle file removal. Cancels any pending sync and removes memories.
   */
  private handleUnlink(filePath: string): void {
    // Cancel any pending sync for this file
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(filePath);
    }

    void this.removeFile(filePath);
  }
}
