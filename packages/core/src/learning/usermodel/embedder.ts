/**
 * Which embedding model the user model may use (PLAN C.5: "Embeddings are
 * always the local ONNX model unless userModel.allowRemoteEmbeddings").
 *
 * - The daemon's provider is reused only when it is the local ONNX model.
 * - A remote provider (OpenAI) is used only with `allowRemoteEmbeddings`.
 *   Otherwise the user model builds its own local model, and only when the
 *   model files are already on disk, so enabling the feature never triggers a
 *   download or any network call.
 * - With `memory.embeddings.provider: noop`, or with no local model on disk,
 *   there are no embeddings: dedupe and tombstones fall back to hash matches
 *   and the query tool to keyword search.
 */

import { LocalEmbeddings, NoopEmbeddings, isModelDownloaded, type EmbeddingProvider } from "@kirie/memory";

export type UserModelEmbedderSource = "shared-local" | "own-local" | "shared-remote" | "none";

export interface UserModelEmbedderChoice {
  provider: EmbeddingProvider | null;
  source: UserModelEmbedderSource;
}

export interface UserModelEmbedderOptions {
  allowRemote: boolean;
  /** The daemon's embedding provider (memory.embeddings), if any */
  shared: EmbeddingProvider | null;
  /** Test seam. Default: `isModelDownloaded()` */
  localAvailable?: () => boolean;
  /** Test seam. Default: `new LocalEmbeddings()` */
  createLocal?: () => EmbeddingProvider;
}

export function isLocalUserModelEmbedder(p: EmbeddingProvider | null | undefined): boolean {
  return p instanceof LocalEmbeddings;
}

export function selectUserModelEmbedder(opts: UserModelEmbedderOptions): UserModelEmbedderChoice {
  const shared = opts.shared;
  if (shared instanceof LocalEmbeddings) return { provider: shared, source: "shared-local" };
  if (shared instanceof NoopEmbeddings) return { provider: null, source: "none" };
  if (shared && opts.allowRemote) return { provider: shared, source: "shared-remote" };
  const available = opts.localAvailable ?? (() => isModelDownloaded());
  if (!available()) return { provider: null, source: "none" };
  return { provider: (opts.createLocal ?? (() => new LocalEmbeddings()))(), source: "own-local" };
}

/** Embed texts; null entries for a failure or a zero vector. Never throws. */
export async function embedUserModelTexts(provider: EmbeddingProvider | null, texts: readonly string[]): Promise<Array<number[] | null>> {
  if (!provider || texts.length === 0) return texts.map(() => null);
  try {
    const vectors = await provider.embed([...texts]);
    return texts.map((_, i) => {
      const v = vectors[i];
      return Array.isArray(v) && v.length > 0 && v.some((x) => x !== 0) ? v : null;
    });
  } catch {
    return texts.map(() => null);
  }
}
