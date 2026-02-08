import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./session-store.js";

describe("SessionStore", () => {
  let store: SessionStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kirie-session-test-"));
    store = new SessionStore(join(tempDir, "test-sessions.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("get / set", () => {
    it("returns null for a key that does not exist", () => {
      expect(store.get("telegram:dm:123")).toBeNull();
    });

    it("stores and retrieves a session ID", () => {
      store.set("telegram:dm:123", "sdk-session-abc");
      expect(store.get("telegram:dm:123")).toBe("sdk-session-abc");
    });

    it("returns null for a different key", () => {
      store.set("telegram:dm:123", "sdk-session-abc");
      expect(store.get("discord:dm:456")).toBeNull();
    });
  });

  describe("upsert on conflict", () => {
    it("overwrites the session ID when setting the same key twice", () => {
      store.set("telegram:dm:123", "session-v1");
      store.set("telegram:dm:123", "session-v2");
      expect(store.get("telegram:dm:123")).toBe("session-v2");
    });

    it("does not create duplicate rows on upsert", () => {
      store.set("telegram:dm:123", "session-v1");
      store.set("telegram:dm:123", "session-v2");
      expect(store.count()).toBe(1);
    });
  });

  describe("has", () => {
    it("returns false for non-existent key", () => {
      expect(store.has("no:such:key")).toBe(false);
    });

    it("returns true for existing key", () => {
      store.set("discord:group:abc", "sdk-123");
      expect(store.has("discord:group:abc")).toBe(true);
    });
  });

  describe("delete", () => {
    it("returns false when deleting a non-existent key", () => {
      expect(store.delete("no:such:key")).toBe(false);
    });

    it("removes an existing key and returns true", () => {
      store.set("telegram:dm:123", "sdk-session-abc");
      expect(store.delete("telegram:dm:123")).toBe(true);
      expect(store.get("telegram:dm:123")).toBeNull();
    });

    it("returns false on second delete of same key", () => {
      store.set("telegram:dm:123", "sdk-session-abc");
      store.delete("telegram:dm:123");
      expect(store.delete("telegram:dm:123")).toBe(false);
    });
  });

  describe("count", () => {
    it("returns 0 for an empty store", () => {
      expect(store.count()).toBe(0);
    });

    it("returns the correct count after inserts", () => {
      store.set("telegram:dm:1", "s1");
      store.set("discord:dm:2", "s2");
      store.set("slack:group:3", "s3");
      expect(store.count()).toBe(3);
    });

    it("decrements after delete", () => {
      store.set("telegram:dm:1", "s1");
      store.set("discord:dm:2", "s2");
      store.delete("telegram:dm:1");
      expect(store.count()).toBe(1);
    });
  });

  describe("clear", () => {
    it("removes all sessions", () => {
      store.set("telegram:dm:1", "s1");
      store.set("discord:dm:2", "s2");
      store.set("slack:group:3", "s3");
      store.clear();
      expect(store.count()).toBe(0);
    });

    it("is safe to call on an empty store", () => {
      store.clear();
      expect(store.count()).toBe(0);
    });
  });

  describe("listByChannel", () => {
    it("returns empty array when no sessions exist for the channel", () => {
      expect(store.listByChannel("telegram")).toEqual([]);
    });

    it("returns only sessions for the specified channel", () => {
      store.set("telegram:dm:1", "s1");
      store.set("telegram:group:2", "s2");
      store.set("discord:dm:3", "s3");
      store.set("slack:dm:4", "s4");

      const telegramKeys = store.listByChannel("telegram");
      expect(telegramKeys).toHaveLength(2);
      expect(telegramKeys).toContain("telegram:dm:1");
      expect(telegramKeys).toContain("telegram:group:2");
    });

    it("does not return sessions from channels with similar prefixes", () => {
      store.set("slack:dm:1", "s1");
      store.set("slackbot:dm:2", "s2");

      const slackKeys = store.listByChannel("slack");
      expect(slackKeys).toEqual(["slack:dm:1"]);
    });

    it("returns empty array after clearing channel sessions", () => {
      store.set("telegram:dm:1", "s1");
      store.delete("telegram:dm:1");
      expect(store.listByChannel("telegram")).toEqual([]);
    });
  });

  describe("persistence across instances", () => {
    it("data persists when opening a new store on the same path", () => {
      const dbPath = join(tempDir, "persist-test.db");
      const store1 = new SessionStore(dbPath);
      store1.set("telegram:dm:1", "sdk-abc");
      store1.close();

      const store2 = new SessionStore(dbPath);
      expect(store2.get("telegram:dm:1")).toBe("sdk-abc");
      store2.close();
    });
  });
});
