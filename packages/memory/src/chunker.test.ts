import { describe, it, expect } from "vitest";
import { chunkMarkdown, DEFAULT_CHUNKING, type ChunkingConfig } from "./chunker.js";
import { createHash } from "node:crypto";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("chunkMarkdown", () => {
  it("returns a single chunk for short content", () => {
    const content = "Hello world\nThis is a small document.";
    const chunks = chunkMarkdown(content);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(content);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(2);
  });

  it("returns an empty array for empty content", () => {
    // content.split("\n") on "" returns [""], which has length 1,
    // so it should produce exactly one chunk with an empty string
    const chunks = chunkMarkdown("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("");
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(1);
  });

  it("produces multiple chunks for long content with correct line ranges", () => {
    // With tokens=10, maxChars = 40. Each line is ~20 chars, so ~2 lines per chunk
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} has content.`);
    const content = lines.join("\n");
    const config: ChunkingConfig = { tokens: 10, overlap: 0 };

    const chunks = chunkMarkdown(content, config);

    expect(chunks.length).toBeGreaterThan(1);

    // Verify line ranges don't have gaps (with overlap=0)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      expect(curr.startLine).toBeGreaterThanOrEqual(prev.endLine);
    }

    // The first chunk should start at line 1
    expect(chunks[0]!.startLine).toBe(1);
    // The last chunk should end at line 20
    expect(chunks[chunks.length - 1]!.endLine).toBe(20);

    // All chunk texts joined should cover all content
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("carries overlap between chunks", () => {
    // Use small tokens and some overlap
    const lines = Array.from({ length: 30 }, (_, i) => `Line number ${i + 1} here.`);
    const content = lines.join("\n");
    const config: ChunkingConfig = { tokens: 10, overlap: 4 };

    const chunks = chunkMarkdown(content, config);

    expect(chunks.length).toBeGreaterThan(2);

    // With overlap, consecutive chunks should share some text at the boundary.
    // Specifically, the end of chunk N should overlap with the beginning of chunk N+1
    for (let i = 1; i < chunks.length; i++) {
      const prevLines = chunks[i - 1]!.text.split("\n");
      const currLines = chunks[i]!.text.split("\n");

      // The start line of the current chunk should be <= the end line of the previous chunk
      // (because overlap carries trailing lines forward)
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine);

      // There should be at least one shared line between consecutive chunks
      const prevLastLines = new Set(prevLines.slice(-3));
      const currFirstLines = currLines.slice(0, 3);
      const hasOverlap = currFirstLines.some(line => prevLastLines.has(line));
      expect(hasOverlap).toBe(true);
    }
  });

  it("segments very long single lines correctly", () => {
    // A single line with 5000 characters, tokens=50 -> maxChars=200
    const longLine = "A".repeat(5000);
    const config: ChunkingConfig = { tokens: 50, overlap: 0 };

    const chunks = chunkMarkdown(longLine, config);

    // Should produce multiple chunks, each at most 200 chars
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk text should be at most maxChars (200)
      expect(chunk.text.length).toBeLessThanOrEqual(200);
    }

    // All chunks should reference line 1 since there is only one line
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(1);
      expect(chunk.endLine).toBe(1);
    }

    // Reassembled content should equal the original
    const reassembled = chunks.map(c => c.text).join("");
    expect(reassembled).toBe(longLine);
  });

  it("produces consistent hashes for the same text", () => {
    const content = "# Title\n\nSome paragraph text.\n\nAnother paragraph.";
    const chunks1 = chunkMarkdown(content);
    const chunks2 = chunkMarkdown(content);

    expect(chunks1).toHaveLength(chunks2.length);

    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i]!.hash).toBe(chunks2[i]!.hash);
      // Verify hash is actually a SHA-256 of the text
      expect(chunks1[i]!.hash).toBe(sha256(chunks1[i]!.text));
    }
  });

  it("produces different hashes for different text", () => {
    const chunks1 = chunkMarkdown("Hello world");
    const chunks2 = chunkMarkdown("Goodbye world");

    expect(chunks1[0]!.hash).not.toBe(chunks2[0]!.hash);
  });

  it("uses default config when none provided", () => {
    const content = "Short";
    const chunks = chunkMarkdown(content);

    // With default 512 tokens (2048 chars), "Short" fits in one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Short");
  });

  it("respects the DEFAULT_CHUNKING values", () => {
    expect(DEFAULT_CHUNKING.tokens).toBe(512);
    expect(DEFAULT_CHUNKING.overlap).toBe(64);
  });

  it("handles content with only newlines", () => {
    const content = "\n\n\n";
    const chunks = chunkMarkdown(content);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.startLine).toBe(1);
  });

  it("enforces minimum maxChars of 32", () => {
    // tokens=1 would give maxChars=4, but minimum is 32
    const lines = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join("\n");
    const config: ChunkingConfig = { tokens: 1, overlap: 0 };

    const chunks = chunkMarkdown(content, config);

    // Should still produce valid chunks (not crash)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(32 + 20); // some tolerance for line not being broken mid-line
    }
  });
});
