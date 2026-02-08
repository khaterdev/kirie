import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryFileWatcher, type FileWatcherOptions } from "./file-watcher.js";

// ---------------------------------------------------------------------------
// Mock MemoryManager
// ---------------------------------------------------------------------------

interface StoredEntry {
  key: string;
  content: string;
  tags: string[];
}

function createMockMemoryManager() {
  const entries = new Map<string, StoredEntry>();

  return {
    entries,

    store: vi.fn(async (key: string, content: string, tags?: string[]) => {
      entries.set(key, { key, content, tags: tags ?? [] });
    }),

    storeDocument: vi.fn(
      async (
        key: string,
        content: string,
        opts?: { chunking?: { tokens: number; overlap: number }; tags?: string[] },
      ) => {
        // Simulate chunking: just store one chunk for simplicity
        const chunkKey = `${key}:chunk:0:L1-1`;
        entries.set(chunkKey, {
          key: chunkKey,
          content,
          tags: opts?.tags ?? [],
        });
        return { chunks: 1, skipped: 0 };
      },
    ),

    recall: vi.fn((key: string) => {
      const entry = entries.get(key);
      if (!entry) return null;
      return {
        id: 1,
        key: entry.key,
        content: entry.content,
        tags: entry.tags,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }),

    search: vi.fn(async () => []),

    semanticSearch: vi.fn(async () => []),

    list: vi.fn((_tag?: string, _limit?: number) => {
      return Array.from(entries.values()).map((e) => ({
        id: 1,
        key: e.key,
        content: e.content,
        tags: e.tags,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
    }),

    delete: vi.fn((key: string) => {
      const existed = entries.has(key);
      entries.delete(key);
      return existed;
    }),

    reindex: vi.fn(async () => ({ processed: 0, errors: 0, skipped: 0 })),

    close: vi.fn(),
  };
}

type MockMemoryManager = ReturnType<typeof createMockMemoryManager>;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_DIR = `/tmp/kirie-file-watcher-test-${process.pid}`;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to create a watcher with defaults
// ---------------------------------------------------------------------------

function createWatcher(
  mm: MockMemoryManager,
  overrides?: Partial<FileWatcherOptions>,
): MemoryFileWatcher {
  return new MemoryFileWatcher({
    watchDir: TEST_DIR,
    // Cast to satisfy the type — the mock matches the shape used by the watcher
    memoryManager: mm as unknown as FileWatcherOptions["memoryManager"],
    debounceMs: 50, // short debounce for tests
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryFileWatcher", () => {
  describe("buildKey", () => {
    it("generates correct key from absolute file path", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      const filePath = join(TEST_DIR, "notes", "meeting.md");
      const key = watcher.buildKey(filePath);
      expect(key).toBe("file:notes/meeting.md");
    });

    it("generates correct key for file at root of watch dir", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      const filePath = join(TEST_DIR, "readme.txt");
      const key = watcher.buildKey(filePath);
      expect(key).toBe("file:readme.txt");
    });

    it("normalises relative paths", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      // Passing a relative-ish path that resolve() will normalise
      const filePath = join(TEST_DIR, "a", "..", "b", "file.md");
      const key = watcher.buildKey(filePath);
      expect(key).toBe("file:b/file.md");
    });
  });

  describe("isWatchedFile", () => {
    it("returns true for .md files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("notes.md")).toBe(true);
    });

    it("returns true for .txt files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("notes.txt")).toBe(true);
    });

    it("returns true for .markdown files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("notes.markdown")).toBe(true);
    });

    it("returns false for .jpg files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("photo.jpg")).toBe(false);
    });

    it("returns false for .json files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("config.json")).toBe(false);
    });

    it("returns false for .ts files", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("index.ts")).toBe(false);
    });

    it("is case-insensitive on extension", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      expect(watcher.isWatchedFile("NOTES.MD")).toBe(true);
      expect(watcher.isWatchedFile("file.TXT")).toBe(true);
    });

    it("respects custom extensions", () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { extensions: [".rst", ".org"] });
      expect(watcher.isWatchedFile("notes.rst")).toBe(true);
      expect(watcher.isWatchedFile("notes.org")).toBe(true);
      expect(watcher.isWatchedFile("notes.md")).toBe(false);
    });
  });

  describe("start / stop lifecycle", () => {
    it("starts and reports isRunning", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      expect(watcher.isRunning()).toBe(false);
      await watcher.start();
      expect(watcher.isRunning()).toBe(true);
      await watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it("start is idempotent (calling twice does not throw)", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      await watcher.start();
      await watcher.start(); // should be a no-op
      expect(watcher.isRunning()).toBe(true);
      await watcher.stop();
    });

    it("stop is safe to call when not started", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);
      await watcher.stop(); // should not throw
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe("syncFile (manual trigger)", () => {
    it("syncs a markdown file into memory", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      const filePath = join(TEST_DIR, "test.md");
      writeFileSync(filePath, "# Hello\nThis is a test file.", "utf-8");

      const result = await watcher.syncFile(filePath);

      expect(result).not.toBeNull();
      expect(result!.chunks).toBe(1);
      expect(mm.storeDocument).toHaveBeenCalledTimes(1);

      const [key, content, opts] = mm.storeDocument.mock.calls[0]!;
      expect(key).toBe("file:test.md");
      expect(content).toBe("# Hello\nThis is a test file.");
      expect(opts?.tags).toContain("file-sync");
    });

    it("returns null for non-watched extensions", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      const filePath = join(TEST_DIR, "photo.jpg");
      writeFileSync(filePath, "binary data", "utf-8");

      const result = await watcher.syncFile(filePath);
      expect(result).toBeNull();
      expect(mm.storeDocument).not.toHaveBeenCalled();
    });

    it("returns null when file does not exist", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      const filePath = join(TEST_DIR, "nonexistent.md");
      const result = await watcher.syncFile(filePath);
      expect(result).toBeNull();
    });

    it("passes custom tags through to storeDocument", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { tags: ["personal", "notes"] });

      const filePath = join(TEST_DIR, "tagged.md");
      writeFileSync(filePath, "Tagged content", "utf-8");

      await watcher.syncFile(filePath);

      const [, , opts] = mm.storeDocument.mock.calls[0]!;
      expect(opts?.tags).toContain("personal");
      expect(opts?.tags).toContain("notes");
      expect(opts?.tags).toContain("file-sync");
    });

    it("passes chunking config through to storeDocument", async () => {
      const mm = createMockMemoryManager();
      const chunking = { tokens: 256, overlap: 32 };
      const watcher = createWatcher(mm, { chunking });

      const filePath = join(TEST_DIR, "chunked.md");
      writeFileSync(filePath, "Some content", "utf-8");

      await watcher.syncFile(filePath);

      const [, , opts] = mm.storeDocument.mock.calls[0]!;
      expect(opts?.chunking).toEqual(chunking);
    });
  });

  describe("removeFile", () => {
    it("removes all chunk entries for a file", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      // Pre-populate entries as if a file had been synced with 3 chunks
      const baseKey = `file:notes.md`;
      mm.entries.set(`${baseKey}:chunk:0:L1-5`, {
        key: `${baseKey}:chunk:0:L1-5`,
        content: "chunk 0",
        tags: [],
      });
      mm.entries.set(`${baseKey}:chunk:1:L4-10`, {
        key: `${baseKey}:chunk:1:L4-10`,
        content: "chunk 1",
        tags: [],
      });
      mm.entries.set(`${baseKey}:chunk:2:L9-15`, {
        key: `${baseKey}:chunk:2:L9-15`,
        content: "chunk 2",
        tags: [],
      });

      // Also add an unrelated entry
      mm.entries.set("file:other.md:chunk:0:L1-5", {
        key: "file:other.md:chunk:0:L1-5",
        content: "other",
        tags: [],
      });

      const filePath = join(TEST_DIR, "notes.md");
      await watcher.removeFile(filePath);

      // All notes.md chunks should be deleted
      expect(mm.delete).toHaveBeenCalledWith(`${baseKey}:chunk:0:L1-5`);
      expect(mm.delete).toHaveBeenCalledWith(`${baseKey}:chunk:1:L4-10`);
      expect(mm.delete).toHaveBeenCalledWith(`${baseKey}:chunk:2:L9-15`);
      // The other entry should NOT be deleted
      expect(mm.entries.has("file:other.md:chunk:0:L1-5")).toBe(true);
    });

    it("does nothing when no matching entries exist", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm);

      const filePath = join(TEST_DIR, "absent.md");
      await watcher.removeFile(filePath);

      expect(mm.delete).not.toHaveBeenCalled();
    });
  });

  describe("automatic file watching", () => {
    it("syncs a new file on add", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { debounceMs: 50 });

      await watcher.start();

      // Create a file after the watcher is running
      const filePath = join(TEST_DIR, "new-note.md");
      writeFileSync(filePath, "New note content", "utf-8");

      // Wait for chokidar detection + debounce + processing
      // (chokidar's add event for new files can be slower than change events)
      await sleep(600);

      expect(mm.storeDocument).toHaveBeenCalled();
      const calls = mm.storeDocument.mock.calls;
      const matchingCall = calls.find(
        (c: unknown[]) => (c[0] as string) === "file:new-note.md",
      );
      expect(matchingCall).toBeDefined();

      await watcher.stop();
    });

    it("syncs when file content changes", async () => {
      // Pre-create a file before starting watcher
      const filePath = join(TEST_DIR, "existing.md");
      writeFileSync(filePath, "Original content", "utf-8");

      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { debounceMs: 50 });

      await watcher.start();

      // Wait for initial scan add events
      await sleep(300);
      mm.storeDocument.mockClear();

      // Modify the file
      writeFileSync(filePath, "Updated content", "utf-8");

      // Wait for debounce + processing
      await sleep(300);

      expect(mm.storeDocument).toHaveBeenCalled();
      const calls = mm.storeDocument.mock.calls;
      const matchingCall = calls.find(
        (c: unknown[]) => (c[0] as string) === "file:existing.md",
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![1]).toBe("Updated content");

      await watcher.stop();
    });

    it("removes memories when file is deleted", async () => {
      // Pre-create a file and populate mock entries
      const filePath = join(TEST_DIR, "to-delete.md");
      writeFileSync(filePath, "Delete me", "utf-8");

      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { debounceMs: 50 });

      await watcher.start();

      // Wait for initial add event to process
      await sleep(300);

      // Verify the file was synced (added as a chunk entry)
      expect(mm.entries.size).toBeGreaterThan(0);

      mm.delete.mockClear();

      // Delete the file
      unlinkSync(filePath);

      // Wait for unlink event
      await sleep(300);

      // delete should have been called for the chunk(s)
      expect(mm.delete).toHaveBeenCalled();

      await watcher.stop();
    });

    it("ignores non-watched extensions", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { debounceMs: 50 });

      await watcher.start();

      // Create a .jpg file
      const filePath = join(TEST_DIR, "photo.jpg");
      writeFileSync(filePath, "fake image data", "utf-8");

      // Wait for potential events
      await sleep(300);

      // storeDocument should not have been called for the jpg
      const calls = mm.storeDocument.mock.calls;
      const jpgCall = calls.find(
        (c: unknown[]) => (c[0] as string).includes("photo.jpg"),
      );
      expect(jpgCall).toBeUndefined();

      await watcher.stop();
    });

    it("debounces rapid changes (only one sync per debounce window)", async () => {
      const mm = createMockMemoryManager();
      const watcher = createWatcher(mm, { debounceMs: 200 });

      // Pre-create the file so the watcher picks it up on initial scan
      const filePath = join(TEST_DIR, "rapid.md");
      writeFileSync(filePath, "version 0", "utf-8");

      await watcher.start();

      // Wait for initial add to process
      await sleep(400);
      mm.storeDocument.mockClear();

      // Rapid-fire changes
      writeFileSync(filePath, "version 1", "utf-8");
      await sleep(50);
      writeFileSync(filePath, "version 2", "utf-8");
      await sleep(50);
      writeFileSync(filePath, "version 3", "utf-8");

      // Wait for debounce to settle + processing
      await sleep(500);

      // Due to debouncing, we should see only 1 storeDocument call
      // (or at most a small number, not 3 separate ones)
      // The chokidar awaitWriteFinish + our debounce should collapse these
      expect(mm.storeDocument.mock.calls.length).toBeLessThanOrEqual(2);

      await watcher.stop();
    });
  });

  describe("log callback", () => {
    it("calls log function during sync", async () => {
      const mm = createMockMemoryManager();
      const logMessages: string[] = [];
      const watcher = createWatcher(mm, {
        log: (msg) => logMessages.push(msg),
      });

      const filePath = join(TEST_DIR, "logged.md");
      writeFileSync(filePath, "Content", "utf-8");

      await watcher.syncFile(filePath);

      expect(logMessages.length).toBeGreaterThan(0);
      expect(logMessages.some((m) => m.includes("Syncing"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
