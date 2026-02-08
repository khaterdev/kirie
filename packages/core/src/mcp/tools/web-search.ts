/**
 * Web Search MCP tool — searches the web using Brave Search API or Perplexity API.
 *
 * Features:
 * - Brave Search API as primary provider
 * - Perplexity API as fallback
 * - Result normalization
 * - In-memory cache with 5-minute TTL
 */

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  timestamp: number;
  result: SearchResult;
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResult {
  results: SearchResultItem[];
  provider: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const searchCache = new Map<string, CacheEntry>();

function getCached(key: string): SearchResult | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: SearchResult): void {
  searchCache.set(key, { timestamp: Date.now(), result });
  // Evict old entries
  if (searchCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of searchCache) {
      if (now - v.timestamp > CACHE_TTL_MS) searchCache.delete(k);
    }
  }
}

// ── Brave Search ────────────────────────────────────────────────────────────

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult> {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Brave Search API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  const results: SearchResultItem[] = (data.web?.results ?? []).map(
    (r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }),
  );

  return { results, provider: "brave" };
}

// ── Perplexity Search ───────────────────────────────────────────────────────

async function searchPerplexity(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult> {
  const response = await fetch(
    "https://api.perplexity.ai/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "user",
            content: `Search the web for: ${query}\n\nReturn the top ${count} results as a JSON array with objects having "title", "url", and "snippet" fields.`,
          },
        ],
        max_tokens: 2000,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Perplexity API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string };
    }>;
    citations?: string[];
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];

  // Try to parse JSON from the response
  let results: SearchResultItem[] = [];
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      results = JSON.parse(jsonMatch[0]) as SearchResultItem[];
    } catch {
      // If JSON parse fails, create results from citations
    }
  }

  // If no parsed results, use citations
  if (results.length === 0 && citations.length > 0) {
    results = citations.slice(0, count).map((url, i) => ({
      title: `Result ${i + 1}`,
      url,
      snippet: content.slice(0, 200),
    }));
  }

  // If still no results, return the text as a single result
  if (results.length === 0 && content) {
    results = [
      {
        title: "Search Summary",
        url: "",
        snippet: content.slice(0, 500),
      },
    ];
  }

  return { results: results.slice(0, count), provider: "perplexity" };
}

// ── Tool handler ────────────────────────────────────────────────────────────

export function createWebSearchToolHandlers() {
  return {
    web_search: {
      description:
        "Search the web and return results. Requires BRAVE_API_KEY or PERPLEXITY_API_KEY env var.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
            description: "Search query",
          },
          count: {
            type: "number" as const,
            description: "Number of results (1-10, default 5)",
          },
        },
        required: ["query"] as const,
      },
      async handler(params: {
        query: string;
        count?: number;
      }): Promise<SearchResult> {
        const count = Math.min(Math.max(params.count ?? 5, 1), 10);
        const query = params.query.trim();

        if (!query) {
          throw new Error("Search query cannot be empty");
        }

        // Check cache
        const cacheKey = `${query}:${count}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        const braveKey = process.env.BRAVE_API_KEY;
        const perplexityKey = process.env.PERPLEXITY_API_KEY;

        // Try Brave first
        if (braveKey) {
          try {
            const result = await searchBrave(query, count, braveKey);
            setCache(cacheKey, result);
            return result;
          } catch (err) {
            // If Perplexity is available, fall through
            if (!perplexityKey) {
              throw err;
            }
            // Log and try Perplexity
          }
        }

        // Try Perplexity
        if (perplexityKey) {
          const result = await searchPerplexity(
            query,
            count,
            perplexityKey,
          );
          setCache(cacheKey, result);
          return result;
        }

        throw new Error(
          "No search API key configured. Set BRAVE_API_KEY or PERPLEXITY_API_KEY environment variable.",
        );
      },
    },
  };
}
