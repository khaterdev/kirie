/**
 * Web Fetch MCP tool — fetches web pages and extracts content as markdown or text.
 *
 * Features:
 * - SSRF protection via SSRFGuard
 * - HTML-to-markdown conversion (lightweight, no external deps)
 * - In-memory response cache with 15-minute TTL
 * - 30s timeout and 5MB max response size
 */

import { SSRFGuard } from "../../security/ssrf-guard.js";

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  timestamp: number;
  result: { title?: string; content: string; url: string };
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const responseCache = new Map<string, CacheEntry>();

function getCached(key: string): CacheEntry["result"] | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: CacheEntry["result"]): void {
  responseCache.set(key, { timestamp: Date.now(), result });
  // Evict old entries periodically
  if (responseCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.timestamp > CACHE_TTL_MS) responseCache.delete(k);
    }
  }
}

// ── HTML extraction & conversion ────────────────────────────────────────────

/**
 * Extract the <title> content from HTML.
 */
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]!.trim()) : undefined;
}

/**
 * Strip specific block-level elements from HTML (script, style, nav, header, footer, aside, svg).
 */
function stripElements(html: string, tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    // Match opening tag through closing tag, non-greedy
    const re = new RegExp(
      `<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`,
      "gi",
    );
    result = result.replace(re, "");
    // Also match self-closing
    const selfClosing = new RegExp(`<${tag}[^>]*/\\s*>`, "gi");
    result = result.replace(selfClosing, "");
  }
  return result;
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

/**
 * Try to extract main content from HTML using common patterns.
 * Falls back to full body.
 */
function extractMainContent(html: string): string {
  // Try to find <main>, <article>, or role="main"
  const mainPatterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id=["']content["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of mainPatterns) {
    const match = html.match(pattern);
    if (match && match[1]!.trim().length > 200) {
      return match[1]!;
    }
  }

  // Fall back to body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1]! : html;
}

/**
 * Convert HTML to simplified markdown.
 */
function htmlToMarkdown(html: string): string {
  // Strip unwanted elements
  let content = stripElements(html, [
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "aside",
    "svg",
    "noscript",
    "iframe",
    "form",
  ]);

  content = extractMainContent(content);

  // Headings
  content = content.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, text) => {
      const hashes = "#".repeat(parseInt(level, 10));
      return `\n\n${hashes} ${stripTags(text).trim()}\n\n`;
    },
  );

  // Paragraphs
  content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, text) => {
    return `\n\n${stripTags(text).trim()}\n\n`;
  });

  // Line breaks
  content = content.replace(/<br\s*\/?>/gi, "\n");

  // Links
  content = content.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => {
      const linkText = stripTags(text).trim();
      if (!linkText) return "";
      return `[${linkText}](${href})`;
    },
  );

  // Images
  content = content.replace(
    /<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi,
    (_, alt, src) => `![${alt}](${src})`,
  );
  content = content.replace(
    /<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi,
    (_, src, alt) => `![${alt}](${src})`,
  );

  // Bold
  content = content.replace(
    /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    (_, text) => `**${stripTags(text).trim()}**`,
  );

  // Italic
  content = content.replace(
    /<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
    (_, text) => `*${stripTags(text).trim()}*`,
  );

  // Code blocks (pre > code)
  content = content.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, code) => `\n\n\`\`\`\n${decodeEntities(stripTags(code)).trim()}\n\`\`\`\n\n`,
  );

  // Pre blocks
  content = content.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, code) => `\n\n\`\`\`\n${decodeEntities(stripTags(code)).trim()}\n\`\`\`\n\n`,
  );

  // Inline code
  content = content.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_, code) => `\`${decodeEntities(stripTags(code)).trim()}\``,
  );

  // Unordered lists
  content = content.replace(
    /<ul[^>]*>([\s\S]*?)<\/ul>/gi,
    (_, items) => {
      return (
        "\n" +
        items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, item: string) => {
          return `- ${stripTags(item).trim()}\n`;
        }) +
        "\n"
      );
    },
  );

  // Ordered lists
  content = content.replace(
    /<ol[^>]*>([\s\S]*?)<\/ol>/gi,
    (_, items) => {
      let index = 1;
      return (
        "\n" +
        items.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, item: string) => {
          return `${index++}. ${stripTags(item).trim()}\n`;
        }) +
        "\n"
      );
    },
  );

  // Blockquotes
  content = content.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, text) => {
      const lines = stripTags(text)
        .trim()
        .split("\n")
        .map((l: string) => `> ${l.trim()}`);
      return `\n${lines.join("\n")}\n`;
    },
  );

  // Horizontal rules
  content = content.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  // Strip remaining tags
  content = stripTags(content);

  // Decode entities
  content = decodeEntities(content);

  // Collapse multiple blank lines
  content = content.replace(/\n{3,}/g, "\n\n");

  // Trim
  content = content.trim();

  return content;
}

/**
 * Strip all HTML tags from a string.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * Convert HTML to plain text.
 */
function htmlToText(html: string): string {
  let content = stripElements(html, [
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "aside",
    "svg",
    "noscript",
    "iframe",
  ]);
  content = extractMainContent(content);
  content = content.replace(/<br\s*\/?>/gi, "\n");
  content = content.replace(/<\/p>/gi, "\n\n");
  content = content.replace(/<\/div>/gi, "\n");
  content = content.replace(/<\/h[1-6]>/gi, "\n\n");
  content = content.replace(/<\/li>/gi, "\n");
  content = stripTags(content);
  content = decodeEntities(content);
  content = content.replace(/\n{3,}/g, "\n\n");
  return content.trim();
}

// ── Constants ───────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_CHARS = 50_000;

// ── Tool handler ────────────────────────────────────────────────────────────

const ssrfGuard = new SSRFGuard();

export function createWebFetchToolHandlers() {
  return {
    web_fetch: {
      description:
        "Fetch a web page and extract its content as markdown or text. Blocks internal/private URLs for security.",
      parameters: {
        type: "object" as const,
        properties: {
          url: {
            type: "string" as const,
            description: "URL to fetch",
          },
          extractMode: {
            type: "string" as const,
            description:
              "Extract as 'markdown' or 'text' (default: markdown)",
          },
          maxChars: {
            type: "number" as const,
            description:
              "Maximum characters to return (default: 50000)",
          },
        },
        required: ["url"] as const,
      },
      async handler(params: {
        url: string;
        extractMode?: string;
        maxChars?: number;
      }): Promise<{ title?: string; content: string; url: string }> {
        const mode =
          params.extractMode === "text" ? "text" : "markdown";
        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

        // Normalize URL
        let url = params.url;
        if (!/^https?:\/\//i.test(url)) {
          url = `https://${url}`;
        }

        // 1. SSRF validation (async — includes DNS resolution)
        await ssrfGuard.validateAsync(url);

        // 2. Check cache
        const cacheKey = `${mode}:${maxChars}:${url}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        // 3. Fetch with timeout and size limit
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          FETCH_TIMEOUT_MS,
        );

        let response: Response;
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent":
                "Kirie-Bot/1.0 (AI Assistant; +https://github.com/kirie-ai)",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            redirect: "follow",
          });
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
          }
          throw new Error(`Fetch failed for ${url}: ${(err as Error).message}`);
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} ${response.statusText} for ${url}`,
          );
        }

        // Check content-length if available
        const contentLength = response.headers.get("content-length");
        if (
          contentLength &&
          parseInt(contentLength, 10) > MAX_RESPONSE_BYTES
        ) {
          throw new Error(
            `Response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES}) for ${url}`,
          );
        }

        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error(`No response body for ${url}`);
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            reader.cancel();
            throw new Error(
              `Response too large (>${MAX_RESPONSE_BYTES} bytes) for ${url}`,
            );
          }
          chunks.push(value);
        }

        const rawHtml = new TextDecoder().decode(
          concatUint8Arrays(chunks, totalBytes),
        );

        // 4. Extract content
        const title = extractTitle(rawHtml);
        let content: string;

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/html") || contentType.includes("xhtml")) {
          content =
            mode === "markdown"
              ? htmlToMarkdown(rawHtml)
              : htmlToText(rawHtml);
        } else {
          // Non-HTML content: return raw text
          content = rawHtml;
        }

        // 5. Truncate
        if (content.length > maxChars) {
          content =
            content.slice(0, maxChars) +
            `\n\n[Content truncated at ${maxChars} characters]`;
        }

        // 6. Cache and return
        const result = { title, content, url };
        setCache(cacheKey, result);
        return result;
      },
    },
  };
}

/**
 * Concatenate Uint8Array chunks into a single array.
 */
function concatUint8Arrays(
  chunks: Uint8Array[],
  totalLength: number,
): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
