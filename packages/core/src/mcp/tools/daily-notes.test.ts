import { describe, it, expect, vi, beforeEach } from "vitest";
import { todayKey, createDailyNoteToolHandlers } from "./daily-notes.js";

describe("todayKey", () => {
  it("returns daily:YYYY-MM-DD format", () => {
    const key = todayKey();
    expect(key).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today's date", () => {
    const key = todayKey();
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    expect(key).toBe(`daily:${yyyy}-${mm}-${dd}`);
  });
});

describe("createDailyNoteToolHandlers", () => {
  let memoryStore: {
    recall: ReturnType<typeof vi.fn>;
    store: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    memoryStore = {
      recall: vi.fn(),
      store: vi.fn(),
    };
  });

  describe("daily_note_append", () => {
    it("creates a new note with timestamp when none exists", async () => {
      memoryStore.recall.mockReturnValue(null);

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = await handlers.daily_note_append.handler({
        content: "Started the project",
      });

      expect(result.updated).toBe(true);
      expect(result.key).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);

      // Verify store was called with the right key and content shape
      expect(memoryStore.store).toHaveBeenCalledTimes(1);
      const [key, content, tags] = memoryStore.store.mock.calls[0]!;
      expect(key).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);
      expect(content).toMatch(/^# Daily Note — \d{4}-\d{2}-\d{2}\n\n- \[\d{2}:\d{2}\] Started the project$/);
      expect(tags).toEqual(["daily-note"]);
    });

    it("appends to an existing note", async () => {
      memoryStore.recall.mockReturnValue({
        content: "# Daily Note — 2026-02-07\n\n- [09:00] First entry",
        tags: ["daily-note"],
      });

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = await handlers.daily_note_append.handler({
        content: "Second entry",
      });

      expect(result.updated).toBe(true);

      const [, content] = memoryStore.store.mock.calls[0]!;
      expect(content).toContain("# Daily Note — 2026-02-07");
      expect(content).toContain("- [09:00] First entry");
      expect(content).toMatch(/- \[\d{2}:\d{2}\] Second entry$/);
    });

    it("uses custom date parameter", async () => {
      memoryStore.recall.mockReturnValue(null);

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = await handlers.daily_note_append.handler({
        content: "Backdated note",
        date: "2026-01-15",
      });

      expect(result.key).toBe("daily:2026-01-15");
      expect(memoryStore.recall).toHaveBeenCalledWith("daily:2026-01-15");

      const [, content] = memoryStore.store.mock.calls[0]!;
      expect(content).toContain("# Daily Note — 2026-01-15");
    });

    it("uses memoryManager when provided", async () => {
      memoryStore.recall.mockReturnValue(null);
      const memoryManager = { store: vi.fn().mockResolvedValue(undefined) };

      const handlers = createDailyNoteToolHandlers(memoryStore, memoryManager);
      await handlers.daily_note_append.handler({
        content: "Managed note",
      });

      // Should use memoryManager.store instead of memoryStore.store
      expect(memoryManager.store).toHaveBeenCalledTimes(1);
      expect(memoryStore.store).not.toHaveBeenCalled();

      const [key, content, tags] = memoryManager.store.mock.calls[0]!;
      expect(key).toMatch(/^daily:\d{4}-\d{2}-\d{2}$/);
      expect(content).toContain("Managed note");
      expect(tags).toEqual(["daily-note"]);
    });
  });

  describe("daily_note_read", () => {
    it("returns null message when no note exists", () => {
      memoryStore.recall.mockReturnValue(null);

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = handlers.daily_note_read.handler({});

      expect(result).toHaveProperty("content", null);
      expect(result).toHaveProperty("message", "No daily note for this date");
      expect(result).toHaveProperty("key");
    });

    it("returns existing note", () => {
      const note = {
        content: "# Daily Note — 2026-02-07\n\n- [09:00] Some entry",
        tags: ["daily-note"],
      };
      memoryStore.recall.mockReturnValue(note);

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = handlers.daily_note_read.handler({});

      expect(result).toEqual(note);
    });

    it("reads note for a custom date", () => {
      const note = {
        content: "# Daily Note — 2026-01-10\n\n- [10:00] Old entry",
        tags: ["daily-note"],
      };
      memoryStore.recall.mockReturnValue(note);

      const handlers = createDailyNoteToolHandlers(memoryStore);
      const result = handlers.daily_note_read.handler({ date: "2026-01-10" });

      expect(memoryStore.recall).toHaveBeenCalledWith("daily:2026-01-10");
      expect(result).toEqual(note);
    });
  });
});
