import { describe, it, expect, vi } from "vitest";
import { NoopEmbeddings, LocalEmbeddings } from "./embeddings.js";

describe("NoopEmbeddings", () => {
  it("returns zero vectors with correct dimensions", async () => {
    const noop = new NoopEmbeddings(384);
    const result = await noop.embed(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(384);
    expect(result[1]).toHaveLength(384);
    expect(result[0]!.every((v) => v === 0)).toBe(true);
  });

  it("returns empty array for empty input", async () => {
    const noop = new NoopEmbeddings();
    const result = await noop.embed([]);
    expect(result).toHaveLength(0);
  });

  it("has model name 'noop'", () => {
    const noop = new NoopEmbeddings();
    expect(noop.model).toBe("noop");
  });

  it("defaults to 1536 dimensions", () => {
    const noop = new NoopEmbeddings();
    expect(noop.dimensions).toBe(1536);
  });
});

describe("LocalEmbeddings", () => {
  it("catches ONNX init failure and falls back to NoopEmbeddings", async () => {
    // Mock fastembed to throw on import
    vi.doMock("fastembed", () => {
      return {
        FlagEmbedding: {
          init: () => {
            throw new Error("ONNX runtime not available");
          },
        },
        EmbeddingModel: {
          AllMiniLML6V2: "fast-all-MiniLM-L6-v2",
          CUSTOM: "custom",
        },
      };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a fresh instance that will hit the mock
    const le = new LocalEmbeddings({ model: "fast-all-MiniLM-L6-v2" });

    // Should not throw
    const result = await le.embed(["test"]);

    // Should return noop zero vectors (384 dims for this model)
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(384);
    expect(result[0]!.every((v) => v === 0)).toBe(true);

    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[embeddings] Failed to initialize local ONNX model"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Falling back to NoopEmbeddings"),
    );

    warnSpy.mockRestore();
    vi.doUnmock("fastembed");
  });

  it("defaults to snowflake-arctic-embed-s model", () => {
    const le = new LocalEmbeddings();
    expect(le.model).toBe("snowflake-arctic-embed-s");
    expect(le.dimensions).toBe(384);
  });
});
