/**
 * Embedding provider abstraction for vector memory search.
 *
 * Providers convert text into high-dimensional vectors for semantic similarity.
 */

import { join } from "node:path";
import { homedir } from "node:os";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  batchEmbed?(requests: Array<{ id: string; text: string }>): Promise<Map<string, number[]>>;
  readonly dimensions: number;
  readonly model: string;
}

/**
 * OpenAI embeddings provider using the /v1/embeddings API.
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly model: string;
  private apiKey: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!resp.ok) throw new Error(`OpenAI embeddings error: ${resp.statusText}`);
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}

/** Model name → dimension mapping for fastembed models */
const LOCAL_MODEL_DIMS: Record<string, number> = {
  "snowflake-arctic-embed-s": 384,
  "fast-all-MiniLM-L6-v2": 384,
  "fast-bge-base-en": 768,
  "fast-bge-base-en-v1.5": 768,
  "fast-bge-small-en": 384,
  "fast-bge-small-en-v1.5": 384,
  "fast-bge-small-zh-v1.5": 512,
  "fast-multilingual-e5-large": 1024,
};

/**
 * Local embeddings using fastembed (ONNX-based, no external API).
 * Downloads the model on first use and caches it locally.
 */
export class LocalEmbeddings implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  private cacheDir: string;
  private modelDir: string | undefined;
  private instance: unknown | null = null;
  private initPromise: Promise<void> | null = null;
  private _fallback: NoopEmbeddings | null = null;

  constructor(opts?: { model?: string; cacheDir?: string; modelDir?: string }) {
    this.model = opts?.model ?? "snowflake-arctic-embed-s";
    this.cacheDir = opts?.cacheDir ?? join(homedir(), ".kirie", "models", "embeddings");
    this.dimensions = LOCAL_MODEL_DIMS[this.model] ?? 384;

    if (opts?.modelDir) {
      this.modelDir = opts.modelDir;
    } else if (this.model === "snowflake-arctic-embed-s") {
      this.modelDir = join(homedir(), ".kirie", "models", "snowflake-arctic-embed-s");
    }
  }

  private async init(): Promise<void> {
    if (this.instance || this._fallback) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
        const modelEnum = Object.values(EmbeddingModel).find((v) => v === this.model);

        if (modelEnum) {
          // Built-in fastembed model
          this.instance = await FlagEmbedding.init({
            model: modelEnum as Exclude<typeof modelEnum, "custom">,
            cacheDir: this.cacheDir,
            showDownloadProgress: true,
          });
        } else if (this.modelDir) {
          // Custom ONNX model loaded from a local directory
          this.instance = await FlagEmbedding.init({
            model: EmbeddingModel.CUSTOM,
            modelAbsoluteDirPath: this.modelDir,
            modelName: "onnx/model.onnx",
            cacheDir: this.cacheDir,
            showDownloadProgress: true,
          });
        } else {
          throw new Error(
            `Unknown local embedding model: ${this.model}. Supported: ${Object.keys(LOCAL_MODEL_DIMS).join(", ")}`,
          );
        }
      } catch (err) {
        console.warn(`[embeddings] Failed to initialize local ONNX model: ${(err as Error).message}`);
        console.warn("[embeddings] Falling back to NoopEmbeddings. Semantic search disabled.");
        console.warn('[embeddings] To fix: run "kirie embeddings download" or switch to OpenAI embeddings.');
        this._fallback = new NoopEmbeddings(this.dimensions);
      }
    })();

    return this.initPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init();
    if (this._fallback) {
      return this._fallback.embed(texts);
    }
    const fe = this.instance as import("fastembed").FlagEmbedding;
    const results: number[][] = [];
    for await (const batch of fe.embed(texts, 64)) {
      results.push(...batch);
    }
    return results;
  }
}

/**
 * No-op embeddings for when no API key is configured.
 * Returns zero vectors so the system can still operate without vector search.
 */
export class NoopEmbeddings implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model = "noop";

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(this.dimensions).fill(0));
  }
}
