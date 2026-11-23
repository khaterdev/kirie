/**
 * The memory file watcher scrubs file text before it is chunked, stored and
 * embedded (W0S follow-up): a remote embedding provider never receives a
 * secret from a synced file. Runs against a real MemoryManager and stores.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, VectorStore, type EmbeddingProvider, type MemoryStore as MemoryStoreContract } from "@kirie/memory";
import { MemoryStore } from "../mcp/tools/memory.js";
import { MemoryFileWatcher } from "./file-watcher.js";

const token = (): string => ["gh", "p_", "Lp0Ko9Ji8Hu7Gy6Ft5Dr4Se3Aw2Qz1Xc0Vb9Nm8"].join("");

describe("MemoryFileWatcher scrubbing", () => {
  let dir: string;
  let watchDir: string;
  let memoryStore: MemoryStore;
  let vectorStore: VectorStore;
  let embedded: string[];
  let watcher: MemoryFileWatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-watch-scrub-"));
    watchDir = join(dir, "notes");
    mkdirSync(watchDir);
    memoryStore = new MemoryStore(join(dir, "memory.db"));
    vectorStore = new VectorStore(join(dir, "vectors.db"));
    embedded = [];
    const provider: EmbeddingProvider = {
      model: "stub",
      dimensions: 4,
      embed: async (texts: string[]) => {
        embedded.push(...texts);
        return texts.map(() => [1, 0, 0, 0]);
      },
    } as EmbeddingProvider;
    const manager = new MemoryManager({ memoryStore: memoryStore as unknown as MemoryStoreContract, vectorStore, embeddingProvider: provider });
    watcher = new MemoryFileWatcher({ watchDir, memoryManager: manager, debounceMs: 10 });
  });

  afterEach(() => {
    memoryStore.close();
    vectorStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("neither the embedding input nor the stored row contains the secret", async () => {
    const file = join(watchDir, "deploy.md");
    writeFileSync(file, `# Deploy\nThe token is ${token()} for the bot.\n`);
    const result = await watcher.syncFile(file);
    expect(result?.chunks).toBeGreaterThan(0);
    expect(embedded.length).toBeGreaterThan(0);
    for (const text of embedded) {
      expect(text).not.toContain(token());
      expect(text).toContain("«redacted:github-token»");
    }
    const rows = memoryStore.list(undefined, 100);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.content).not.toContain(token());
  });

  it("clean text is embedded unchanged", async () => {
    const file = join(watchDir, "plain.md");
    writeFileSync(file, "# Notes\nNothing secret here.\n");
    await watcher.syncFile(file);
    expect(embedded.join("\n")).toContain("Nothing secret here.");
  });
});
