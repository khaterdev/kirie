import { createHash } from "node:crypto";

export interface ChunkingConfig {
  /** Approximate max tokens per chunk (default 512) */
  tokens: number;
  /** Approximate overlap tokens between chunks (default 64) */
  overlap: number;
}

export interface MemoryChunk {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export const DEFAULT_CHUNKING: ChunkingConfig = { tokens: 512, overlap: 64 };

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Chunk markdown/text content into overlapping segments.
 * Line-aware: won't break mid-line. Uses token approximation (4 chars per token).
 */
export function chunkMarkdown(content: string, config: ChunkingConfig = DEFAULT_CHUNKING): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, config.tokens * 4);
  const overlapChars = Math.max(0, config.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const text = current.map(e => e.line).join("\n");
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: typeof current = [];
    for (let i = current.length - 1; i >= 0; i--) {
      const entry = current[i]!;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments = line.length === 0
      ? [""]
      : Array.from({ length: Math.ceil(line.length / maxChars) }, (_, j) =>
          line.slice(j * maxChars, (j + 1) * maxChars));

    for (const segment of segments) {
      const segSize = segment.length + 1;
      if (currentChars + segSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += segSize;
    }
  }
  flush();
  return chunks;
}
