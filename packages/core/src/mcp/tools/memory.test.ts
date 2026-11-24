import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, createMemoryToolHandlers, type MemoryManagerLike } from "./memory.js";
import { createGatewayScrubber, createScrubApp, setRemoteScrubber } from "../../security/remote-scrub.js";
import { SecretScrubber } from "../../security/secret-scrubber.js";

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

  it("memory_store handler works", async () => {
    const handlers = createMemoryToolHandlers(store);
    const result = await handlers.memory_store.handler({
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

describe("secret scrubbing (memory sink)", () => {
  // Synthetic tokens assembled at run time.
  const token = (): string => ["gh", "p_", "Qw7Er6Ty5Ui4Op3As2Df1Gh0Jk9Lz8Xc7Vb6Nm"].join("");
  const body = (): string => token().slice(4);
  const MARK = "«redacted:github-token»";

  it("redacts content before it is stored and indexed", () => {
    const entry = store.store("api:notes", `use ${token()} for the CI`);
    expect(entry.content).toBe(`use ${MARK} for the CI`);
    expect(store.recall("api:notes")!.content).not.toContain(body());
    expect(store.search(token())).toEqual([]);
    expect(store.search(body())).toEqual([]);
    expect(store.search("CI")).toHaveLength(1);
  });

  it("redacts secrets in tags", () => {
    const entry = store.store("tagged", "plain", [`t:${token()}`]);
    expect(entry.tags).toEqual([`t:${MARK}`]);
  });

  it("rejects a key that looks like a secret", () => {
    expect(() => store.store(token(), "x")).toThrow(/looks like it contains a secret/);
    expect(store.list()).toEqual([]);
  });

  it("stores text without secrets unchanged", () => {
    const text = "SHA 3f786850e387550fdab836ed7e6dc881de23001b, max_tokens=4096, uuid 550e8400-e29b-41d4-a716-446655440000";
    expect(store.store("plain", text).content).toBe(text);
  });

  it("memory_store adds a notice when something was redacted", async () => {
    const handlers = createMemoryToolHandlers(store);
    const result = await handlers.memory_store.handler({ key: "k", content: `PASSWORD=Zx9Cv8Bn7Mq6 and ${token()}` });
    expect(result.content).not.toContain(body());
    expect(result.notice).toBe("2 secret(s) were redacted before storing. Store secrets with: kirie credentials set <key> <value>");
    const clean = await handlers.memory_store.handler({ key: "k2", content: "nothing secret" });
    expect(clean.notice).toBeUndefined();
  });

  it("memory_store passes scrubbed text to the MemoryManager", async () => {
    const manager = {
      store: vi.fn(async (key: string, content: string, tags?: string[]) => {
        store.store(key, content, tags);
      }),
      storeDocument: vi.fn(async () => ({ chunks: 2, skipped: 0 })),
    } as unknown as MemoryManagerLike;
    const handlers = createMemoryToolHandlers(store, manager);
    const result = await handlers.memory_store.handler({ key: "m", content: `x ${token()}` });
    expect((manager.store as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(`x ${MARK}`);
    expect(result.notice).toMatch(/^1 secret/);

    const doc = await handlers.memory_store_document.handler({ key: "d", content: `doc ${token()}` });
    expect((manager.storeDocument as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(`doc ${MARK}`);
    expect(doc.notice).toMatch(/^1 secret/);
  });

  it("memory_store_document fallback stores scrubbed text with a notice", async () => {
    const handlers = createMemoryToolHandlers(store);
    const result = await handlers.memory_store_document.handler({ key: "doc", content: `doc ${token()}` });
    expect(result.chunks).toBe(1);
    expect(result.notice).toMatch(/^1 secret/);
    expect(store.recall("doc")!.content).toBe(`doc ${MARK}`);
  });

  describe("known values held by the daemon (SCRUB-N1)", () => {
    // A bare Twilio-style auth token: no prefix, no label, so no pattern catches it.
    const KNOWN = ["9c1f", "0b7e", "44d2", "a8c3", "51e6", "f0d9", "2b74", "c6a1"].join("");
    afterEach(() => setRemoteScrubber(null));

    it("without the daemon's values a bare credential is not caught by patterns", async () => {
      const handlers = createMemoryToolHandlers(store);
      const r = await handlers.memory_store.handler({ key: "v1", content: `voice creds ${KNOWN}` });
      expect(r.content).toContain(KNOWN);
    });

    it("memory_store, memory_store_document and daily notes ask the daemon first and store its scrubbed text", async () => {
      const daemon = new SecretScrubber();
      daemon.addKnownSecret(KNOWN, "credential:voice.twilio.authToken");
      const app = createScrubApp({ scrubber: daemon, token: "t0k" });
      const fetchFn = (async (url: string, init: RequestInit) => app.request(new URL(url).pathname.replace(/^\/api\/scrub/, ""), init)) as unknown as typeof fetch;
      setRemoteScrubber(createGatewayScrubber("http://127.0.0.1:18789", "t0k", { fetchFn }));
      const manager = {
        store: vi.fn(async (key: string, content: string, tags?: string[]) => {
          store.store(key, content, tags);
        }),
        storeDocument: vi.fn(async () => ({ chunks: 1, skipped: 0 })),
      } as unknown as MemoryManagerLike;
      const handlers = createMemoryToolHandlers(store, manager);
      const r = await handlers.memory_store.handler({ key: "v2", content: `voice creds ${KNOWN}`, tags: [KNOWN] });
      // Scrubbed before the manager (and its embedder) ever saw it.
      expect((manager.store as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe("voice creds «redacted:known-secret»");
      expect(r.notice).toMatch(/^1 secret/);
      expect(store.recall("v2")!.tags).toEqual(["«redacted:known-secret»"]);
      await handlers.memory_store_document.handler({ key: "d2", content: `doc ${KNOWN}` });
      expect((manager.storeDocument as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe("doc «redacted:known-secret»");
      await expect(handlers.memory_store.handler({ key: `k-${KNOWN}`, content: "x" })).rejects.toThrow(/looks like it contains a secret/);
    });

    it("refuses the write when the daemon cannot be asked (fail closed)", async () => {
      setRemoteScrubber(createGatewayScrubber("http://127.0.0.1:9", "t0k", { fetchFn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch }));
      const handlers = createMemoryToolHandlers(store);
      await expect(handlers.memory_store.handler({ key: "v3", content: `x ${KNOWN}` })).rejects.toThrow(/known-secret check is unavailable/);
      expect(store.recall("v3")).toBeNull();
    });

    it("the route needs the token, a store sink and is rate limited", async () => {
      const daemon = new SecretScrubber();
      daemon.addKnownSecret(KNOWN, "k");
      let t = 0;
      const app = createScrubApp({ scrubber: daemon, token: "t0k", now: () => t });
      const post = (body: unknown, token = "t0k") =>
        app.request("/text", { method: "POST", headers: { "content-type": "application/json", "x-kirie-scrub-token": token }, body: JSON.stringify(body) });
      expect((await post({ text: KNOWN, sink: "memory" }, "nope")).status).toBe(403);
      expect((await post({ text: KNOWN, sink: "log" })).status).toBe(400);
      const ok = await post({ text: `a ${KNOWN}`, sink: "memory" });
      expect(await ok.json()).toEqual({ text: "a «redacted:known-secret»", count: 1 });
      for (let i = 0; i < 599; i++) await post({ text: "x", sink: "memory" });
      expect((await post({ text: "x", sink: "memory" })).status).toBe(429);
      t += 60_000;
      expect((await post({ text: "x", sink: "memory" })).status).toBe(200);
    });
  });
});
