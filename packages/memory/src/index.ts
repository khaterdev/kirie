export type { EmbeddingProvider } from "./embeddings.js";
export { OpenAIEmbeddings, NoopEmbeddings, LocalEmbeddings } from "./embeddings.js";

export type { BatchEmbeddingRequest, BatchEmbeddingResult, BatchEmbeddingOptions } from "./batch-embeddings.js";
export { OpenAIBatchEmbeddings } from "./batch-embeddings.js";

export type { VectorSearchResult } from "./vector-store.js";
export { VectorStore } from "./vector-store.js";

export type { HybridSearchOptions, HybridSearchResult } from "./hybrid-search.js";
export { mergeResults } from "./hybrid-search.js";

export type { MemoryManagerOptions } from "./memory-manager.js";
export { MemoryManager, hashContent } from "./memory-manager.js";

export type { ChunkingConfig, MemoryChunk } from "./chunker.js";
export { chunkMarkdown, DEFAULT_CHUNKING } from "./chunker.js";

export type { EmbeddingCacheOptions, EmbeddingCacheStats } from "./embedding-cache.js";
export { CachedEmbeddingProvider } from "./embedding-cache.js";

export type { MemoryEntry, MemoryStore } from "./types.js";

export { ensureModelDownloaded, isModelDownloaded, modelDir, defaultModelsDir, ARCTIC_MODEL_NAME, ARCTIC_DIMENSIONS } from "./model-downloader.js";
