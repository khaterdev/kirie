import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, createMemoryToolHandlers } from "./memory.js";

const TEST_DIR = `/tmp/kirie-memory-test-${process.pid}`;
const TEST_DB = join(TEST_DIR, "memory.db");

let store: MemoryStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new MemoryStore(TEST_DB);
});

afterEach(() => {
  store.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  describe("store and recall", () => {
    it("stores and recalls a memory", () => {
      const entry = store.store("greeting", "Hello, world!");
      expect(entry.key).toBe("greeting");
      expect(entry.content).toBe("Hello, world!");
      expect(entry.tags).toEqual([]);

      const recalled = store.recall("greeting");
      expect(recalled).not.toBeNull();
      expect(recalled!.content).toBe("Hello, world!");
    });

    it("stores with tags", () => {
      const entry = store.store("tagged", "Some content", ["personal", "note"]);
      expect(entry.tags).toEqual(["personal", "note"]);

      const recalled = store.recall("tagged");
      expect(recalled!.tags).toEqual(["personal", "note"]);
    });

    it("upserts on same key", () => {
      store.store("key1", "original");
      store.store("key1", "updated", ["new-tag"]);

      const recalled = store.recall("key1");
      expect(recalled!.content).toBe("updated");
      expect(recalled!.tags).toEqual(["new-tag"]);
    });

    it("returns null for non-existent key", () => {
      expect(store.recall("nonexistent")).toBeNull();
    });
  });

  describe("search", () => {
    it("finds memories by content", () => {
      store.store("weather", "It will be sunny tomorrow in San Francisco");
      store.store("todo", "Buy groceries from the store");
      store.store("recipe", "Sunny side up eggs recipe");

      const results = store.search("sunny");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.key === "weather")).toBe(true);
    });

    it("finds memories by key", () => {
      store.store("weather-forecast", "Rain expected");
      store.store("todo-list", "Important tasks");

      const results = store.search("weather");
      expect(results.some((r) => r.key === "weather-forecast")).toBe(true);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.store(`item-${i}`, `Content about topic ${i}`);
      }

      const results = store.search("topic", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("returns empty array for no matches", () => {
      store.store("key", "value");
      const results = store.search("xyznonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("list", () => {
    it("lists all memories ordered by updated_at desc", () => {
      store.store("first", "content1");
      store.store("second", "content2");
      store.store("third", "content3");

      const list = store.list();
      expect(list).toHaveLength(3);
    });

    it("filters by tag", () => {
      store.store("tagged1", "content", ["important"]);
      store.store("tagged2", "content", ["important", "urgent"]);
      store.store("untagged", "content");

      const results = store.list("important");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.tags.includes("important"))).toBe(true);
    });

    it("respects limit", () => {
      for (let i = 0; i < 20; i++) {
        store.store(`item-${i}`, `content-${i}`);
      }

      const results = store.list(undefined, 5);
      expect(results).toHaveLength(5);
    });

    it("returns empty array for empty store", () => {
      expect(store.list()).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes an existing memory and returns true", () => {
      store.store("to-delete", "content");
      expect(store.delete("to-delete")).toBe(true);
      expect(store.recall("to-delete")).toBeNull();
    });

    it("returns false for non-existent key", () => {
      expect(store.delete("nonexistent")).toBe(false);
    });
  });
});

describe("createMemoryToolHandlers", () => {
  it("creates all expected tool handlers", () => {
    const handlers = createMemoryToolHandlers(store);
    expect(handlers).toHaveProperty("memory_store");
    expect(handlers).toHaveProperty("memory_recall");
    expect(handlers).toHaveProperty("memory_search");
    expect(handlers).toHaveProperty("memory_list");
    expect(handlers).toHaveProperty("memory_delete");
  });

  it("memory_store handler works", () => {
    const handlers = createMemoryToolHandlers(store);
    const result = handlers.memory_store.handler({
      key: "test",
      content: "test content",
      tags: ["tag1"],
    });
    expect(result.key).toBe("test");
    expect(result.content).toBe("test content");
    expect(result.tags).toEqual(["tag1"]);
  });

  it("memory_recall handler works", () => {
    const handlers = createMemoryToolHandlers(store);
    store.store("recall-test", "recall content");
    const result = handlers.memory_recall.handler({ key: "recall-test" });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("recall content");
  });

  it("memory_delete handler works", () => {
    const handlers = createMemoryToolHandlers(store);
    store.store("del-test", "content");
    const result = handlers.memory_delete.handler({ key: "del-test" });
    expect(result.deleted).toBe(true);
  });
});
