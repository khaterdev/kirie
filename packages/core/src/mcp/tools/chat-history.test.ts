import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ChatHistoryStore, createChatHistoryToolHandlers } from "./chat-history.js";

const TEST_DIR = `/tmp/kirie-chat-history-test-${process.pid}`;
const TEST_DB = join(TEST_DIR, "chat-history.db");

let store: ChatHistoryStore;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  store = new ChatHistoryStore(TEST_DB);
});

afterEach(() => {
  store.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ChatHistoryStore", () => {
  describe("append", () => {
    it("stores a message retrievable via recent()", () => {
      store.append("session-1", "user", "Hello there!", {
        senderName: "Alice",
        senderId: "alice-123",
        channel: "telegram",
      });

      const messages = store.recent("session-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe("user");
      expect(messages[0]!.content).toBe("Hello there!");
      expect(messages[0]!.sender_name).toBe("Alice");
      expect(messages[0]!.sender_id).toBe("alice-123");
      expect(messages[0]!.channel).toBe("telegram");
      expect(messages[0]!.session_key).toBe("session-1");
    });

    it("stores with default channel when not provided", () => {
      store.append("session-1", "assistant", "Hi!");

      const messages = store.recent("session-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.channel).toBe("unknown");
      expect(messages[0]!.sender_name).toBeNull();
      expect(messages[0]!.sender_id).toBeNull();
    });
  });

  describe("recent", () => {
    it("returns messages in chronological order", () => {
      store.append("session-1", "user", "First message");
      store.append("session-1", "assistant", "Second message");
      store.append("session-1", "user", "Third message");

      const messages = store.recent("session-1");
      expect(messages).toHaveLength(3);
      expect(messages[0]!.content).toBe("First message");
      expect(messages[1]!.content).toBe("Second message");
      expect(messages[2]!.content).toBe("Third message");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.append("session-1", "user", `Message ${i}`);
      }

      const messages = store.recent("session-1", 3);
      expect(messages).toHaveLength(3);
    });

    it("is scoped to session key", () => {
      store.append("session-1", "user", "Session 1 message");
      store.append("session-2", "user", "Session 2 message");
      store.append("session-1", "assistant", "Session 1 reply");

      const session1 = store.recent("session-1");
      expect(session1).toHaveLength(2);
      expect(session1.every((m) => m.session_key === "session-1")).toBe(true);

      const session2 = store.recent("session-2");
      expect(session2).toHaveLength(1);
      expect(session2[0]!.content).toBe("Session 2 message");
    });

    it("returns empty array for unknown session", () => {
      expect(store.recent("nonexistent")).toEqual([]);
    });
  });

  describe("search", () => {
    it("finds messages by content", () => {
      store.append("session-1", "user", "I need help with my Python project");
      store.append("session-1", "assistant", "Sure, I can help with Python");
      store.append("session-2", "user", "What is the weather today?");

      const results = store.search("Python");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes("Python"))).toBe(true);
    });

    it("filters by sessionKey when provided", () => {
      store.append("session-1", "user", "Topic about databases");
      store.append("session-2", "user", "Topic about databases too");

      const results = store.search("databases", { sessionKey: "session-1" });
      expect(results).toHaveLength(1);
      expect(results[0]!.session_key).toBe("session-1");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.append("session-1", "user", `Discussion about topic ${i}`);
      }

      const results = store.search("topic", { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("returns empty array for no matches", () => {
      store.append("session-1", "user", "Hello");
      const results = store.search("xyznonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("semanticSearch", () => {
    it("falls back to FTS5 when no embedding provider is set", async () => {
      store.append("session-1", "user", "I need help with my Python project");
      store.append("session-1", "assistant", "Sure, I can help with Python");
      store.append("session-2", "user", "What is the weather today?");

      const results = await store.semanticSearch("Python");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes("Python"))).toBe(true);
    });

    it("falls back to FTS5 when embedding provider model is noop", async () => {
      // Create a store with a noop embedding provider
      const noopStore = new ChatHistoryStore(TEST_DB.replace(".db", "-noop.db"), {
        embed: async () => [],
        model: "noop",
        dimensions: 0,
      });
      noopStore.append("session-1", "user", "Testing noop fallback");

      const results = await noopStore.semanticSearch("noop");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain("noop");
      noopStore.close();
    });
  });

  describe("close", () => {
    it("closes gracefully without error", () => {
      store.append("session-1", "user", "test");
      expect(() => store.close()).not.toThrow();
    });
  });
});

describe("createChatHistoryToolHandlers", () => {
  it("creates all expected tool handlers", () => {
    const handlers = createChatHistoryToolHandlers(store);
    expect(handlers).toHaveProperty("chat_history_recent");
    expect(handlers).toHaveProperty("chat_history_search");
    expect(handlers).toHaveProperty("chat_history_semantic_search");
  });

  it("chat_history_recent handler works", () => {
    const handlers = createChatHistoryToolHandlers(store);
    store.append("session-1", "user", "Hello from tool test");
    store.append("session-1", "assistant", "Reply from tool test");

    const result = handlers.chat_history_recent.handler({ sessionKey: "session-1" });
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("Hello from tool test");
    expect(result[1]!.content).toBe("Reply from tool test");
  });

  it("chat_history_search handler works", () => {
    const handlers = createChatHistoryToolHandlers(store);
    store.append("session-1", "user", "My favorite programming language is Rust");

    const result = handlers.chat_history_search.handler({ query: "Rust" });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.content).toContain("Rust");
  });

  it("chat_history_semantic_search handler falls back to FTS5", async () => {
    const handlers = createChatHistoryToolHandlers(store);
    store.append("session-1", "user", "Working on TypeScript code today");

    const result = await handlers.chat_history_semantic_search.handler({
      query: "TypeScript",
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.content).toContain("TypeScript");
  });
});
