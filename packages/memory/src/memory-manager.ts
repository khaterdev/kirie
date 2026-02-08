/**
 * High-level memory manager that coordinates FTS5 keyword search,
 * vector embeddings, and hybrid search.
 */

import { createHash } from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./types.js";
import type { VectorStore } from "./vector-store.js";
import type { VectorSearchResult } from "./vector-store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { mergeResults, type HybridSearchResult } from "./hybrid-search.js";
import { chunkMarkdown, DEFAULT_CHUNKING, type ChunkingConfig } from "./chunker.js";

/**
 * Compute a SHA-256 hex digest of the given content string.
 * Used to detect unchanged content and skip redundant embedding calls.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface MemoryManagerOptions {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
}

export class MemoryManager {
  private memoryStore: MemoryStore;
  private vectorStore: VectorStore;
  private embeddingProvider: EmbeddingProvider;

  constructor(opts: MemoryManagerOptions) {
    this.memoryStore = opts.memoryStore;
    this.vectorStore = opts.vectorStore;
    this.embeddingProvider = opts.embeddingProvider;
  }

  /**
   * Store a memory with both FTS5 indexing and vector embedding.
   * Skips the embedding API call if the content hash is unchanged.
   */
  async store(key: string, content: string, tags?: string[]): Promise<void> {
    const newHash = hashContent(content);

    // Check whether the existing vector entry already has this content hash
    const existingMeta = this.vectorStore.getMetadata(key);
    if (existingMeta?.contentHash === newHash) {
      // Content unchanged — still update FTS5 (tags may differ) but skip embedding
      this.memoryStore.store(key, content, tags);
      return;
    }

    // Save to FTS5-backed memory store
    this.memoryStore.store(key, content, tags);

    // Compute and store embedding with content hash in metadata
    const [embedding] = await this.embeddingProvider.embed([content]);
    if (embedding) {
      this.vectorStore.upsert(key, embedding, { tags: tags ?? [], contentHash: newHash });
    }
  }

  /**
   * Recall a memory by its exact key.
   */
  recall(key: string): MemoryEntry | null {
    return this.memoryStore.recall(key);
  }

  /**
   * Hybrid search combining FTS5 keyword search and vector similarity.
   */
  async search(query: string, topK = 20): Promise<HybridSearchResult[]> {
    // Run FTS5 keyword search
    const keywordResults = this.memoryStore.search(query, topK);
    const keywordRanked = keywordResults.map((entry, index) => ({
      key: entry.key,
      content: entry.content,
      rank: index,
    }));

    // Run vector search
    let vectorResults: VectorSearchResult[] = [];
    if (this.embeddingProvider.model !== "noop") {
      const [queryEmbedding] = await this.embeddingProvider.embed([query]);
      if (queryEmbedding) {
        vectorResults = this.vectorStore.search(queryEmbedding, topK);
      }
    }

    // Merge with RRF
    return mergeResults(
      keywordRanked,
      vectorResults,
      (key) => this.memoryStore.recall(key),
    );
  }

  /**
   * Pure vector similarity search (no keyword component).
   */
  async semanticSearch(query: string, topK = 10, minScore = 0.5): Promise<VectorSearchResult[]> {
    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    if (!queryEmbedding) return [];
    return this.vectorStore.search(queryEmbedding, topK, minScore);
  }

  /**
   * List memories, optionally filtered by tag.
   */
  list(tag?: string, limit?: number): MemoryEntry[] {
    return this.memoryStore.list(tag, limit);
  }

  /**
   * Delete a memory from both FTS5 store and vector store.
   */
  delete(key: string): boolean {
    const deleted = this.memoryStore.delete(key);
    this.vectorStore.delete(key);
    return deleted;
  }

  /**
   * Recompute embeddings for all existing memories.
   * Skips entries whose content hash hasn't changed since last indexing.
   *
   * When the embedding provider supports batchEmbed(), uses the OpenAI Batch
   * API for cost-effective bulk processing. Otherwise falls back to
   * individual embed() calls.
   */
  async reindex(): Promise<{ processed: number; errors: number; skipped: number }> {
    const memories = this.memoryStore.list(undefined, 10000);

    // Separate memories that need re-embedding from those that can be skipped
    const toEmbed: MemoryEntry[] = [];
    let skipped = 0;

    for (const memory of memories) {
      const newHash = hashContent(memory.content);
      const existingMeta = this.vectorStore.getMetadata(memory.key);

      if (existingMeta?.contentHash === newHash) {
        skipped++;
      } else {
        toEmbed.push(memory);
      }
    }

    // Use batch embedding when available and there are items to process
    if (this.embeddingProvider.batchEmbed && toEmbed.length > 0) {
      try {
        const requests = toEmbed.map((m) => ({ id: m.key, text: m.content }));
        const resultMap = await this.embeddingProvider.batchEmbed(requests);
        let processed = 0;
        let errors = 0;

        for (const memory of toEmbed) {
          const embedding = resultMap.get(memory.key);
          if (embedding) {
            const newHash = hashContent(memory.content);
            this.vectorStore.upsert(memory.key, embedding, {
              tags: memory.tags,
              contentHash: newHash,
            });
            processed++;
          } else {
            errors++;
          }
        }

        return { processed, errors, skipped };
      } catch {
        // Batch failed entirely — fall back to individual calls
        return this.reindexIndividual(toEmbed, skipped);
      }
    }

    return this.reindexIndividual(toEmbed, skipped);
  }

  /**
   * Fallback: reindex memories one at a time using embed().
   */
  private async reindexIndividual(
    memories: MemoryEntry[],
    skipped: number,
  ): Promise<{ processed: number; errors: number; skipped: number }> {
    let processed = 0;
    let errors = 0;

    for (const memory of memories) {
      try {
        const newHash = hashContent(memory.content);
        const [embedding] = await this.embeddingProvider.embed([memory.content]);
        if (embedding) {
          this.vectorStore.upsert(memory.key, embedding, {
            tags: memory.tags,
            contentHash: newHash,
          });
          processed++;
        }
      } catch {
        errors++;
      }
    }

    return { processed, errors, skipped };
  }

  /**
   * Store a large document as chunked memory entries with overlap.
   * Each chunk is stored as a separate memory entry with a key like
   * `key:chunk:0:L1-10`. Returns the number of chunks stored and skipped.
   */
  async storeDocument(key: string, content: string, opts?: {
    chunking?: ChunkingConfig;
    tags?: string[];
  }): Promise<{ chunks: number; skipped: number }> {
    const config = opts?.chunking ?? DEFAULT_CHUNKING;
    const chunks = chunkMarkdown(content, config);
    let stored = 0;
    const skipped = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkKey = `${key}:chunk:${i}:L${chunk.startLine}-${chunk.endLine}`;
      await this.store(chunkKey, chunk.text, opts?.tags);
      stored++;
    }
    return { chunks: stored, skipped };
  }

  close(): void {
    this.memoryStore.close();
    this.vectorStore.close();
  }
}
