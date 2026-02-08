/**
 * Hybrid search combining FTS5 keyword results with vector similarity results
 * using Reciprocal Rank Fusion (RRF).
 */

export interface HybridSearchOptions {
  /** Weight for keyword (FTS5) results. Default 0.5 */
  keywordWeight?: number;
  /** Weight for vector similarity results. Default 0.5 */
  vectorWeight?: number;
  /** Maximum results to return. Default 20 */
  topK?: number;
}

export interface HybridSearchResult {
  key: string;
  content: string;
  score: number;
  source: "keyword" | "vector" | "both";
}

interface KeywordResult {
  key: string;
  content: string;
  rank: number;
}

interface VectorResult {
  key: string;
  score: number;
}

/**
 * Merge keyword and vector search results using Reciprocal Rank Fusion.
 *
 * RRF score = sum(weight / (k + rank)) where k = 60 (standard constant).
 * Results appearing in both lists get scores from both sources.
 *
 * @param keywordResults - Results from FTS5 search, ordered by rank (0 = best)
 * @param vectorResults - Results from vector similarity search, ordered by score descending
 * @param memoryLookup - Function to retrieve full memory content by key
 * @param options - Optional weights and limits
 */
export function mergeResults(
  keywordResults: KeywordResult[],
  vectorResults: VectorResult[],
  memoryLookup: (key: string) => { content: string } | null,
  options?: HybridSearchOptions,
): HybridSearchResult[] {
  const keywordWeight = options?.keywordWeight ?? 0.5;
  const vectorWeight = options?.vectorWeight ?? 0.5;
  const topK = options?.topK ?? 20;
  const k = 60; // RRF constant

  const merged = new Map<string, { score: number; content: string; sources: Set<"keyword" | "vector"> }>();

  // Score keyword results by rank position
  for (let i = 0; i < keywordResults.length; i++) {
    const result = keywordResults[i]!;
    const rrfScore = keywordWeight / (k + i + 1);
    const existing = merged.get(result.key);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.add("keyword");
    } else {
      merged.set(result.key, {
        score: rrfScore,
        content: result.content,
        sources: new Set(["keyword"]),
      });
    }
  }

  // Score vector results by rank position (already sorted by score desc)
  for (let i = 0; i < vectorResults.length; i++) {
    const result = vectorResults[i]!;
    const rrfScore = vectorWeight / (k + i + 1);
    const existing = merged.get(result.key);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.add("vector");
    } else {
      // Look up content from the memory store
      const memory = memoryLookup(result.key);
      if (memory) {
        merged.set(result.key, {
          score: rrfScore,
          content: memory.content,
          sources: new Set(["vector"]),
        });
      }
    }
  }

  // Convert to sorted array
  const results: HybridSearchResult[] = [];

  for (const [key, entry] of merged) {
    let source: HybridSearchResult["source"];
    if (entry.sources.has("keyword") && entry.sources.has("vector")) {
      source = "both";
    } else if (entry.sources.has("keyword")) {
      source = "keyword";
    } else {
      source = "vector";
    }

    results.push({
      key,
      content: entry.content,
      score: entry.score,
      source,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
