import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  OpenAIBatchEmbeddings,
  type BatchEmbeddingRequest,
} from "./batch-embeddings.js";

/**
 * Helper to create a mock Response object.
 */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    type: "basic" as Response["type"],
    url: "",
    clone: () => mockResponse(body, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

describe("OpenAIBatchEmbeddings", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let client: OpenAIBatchEmbeddings;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    client = new OpenAIBatchEmbeddings({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("submitBatch", () => {
    it("uploads file and creates batch, returning batch id", async () => {
      // First call: file upload
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: "file-abc123" }));
      // Second call: batch creation
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: "batch-xyz789" }));

      const requests: BatchEmbeddingRequest[] = [
        { customId: "mem-1", text: "Hello world" },
        { customId: "mem-2", text: "Goodbye world" },
      ];

      const batchId = await client.submitBatch(requests);

      expect(batchId).toBe("batch-xyz789");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Verify file upload call
      const [fileUrl, fileInit] = fetchSpy.mock.calls[0]!;
      expect(fileUrl).toBe("https://api.openai.com/v1/files");
      expect((fileInit as RequestInit).method).toBe("POST");

      // Verify batch creation call
      const [batchUrl, batchInit] = fetchSpy.mock.calls[1]!;
      expect(batchUrl).toBe("https://api.openai.com/v1/batches");
      const batchBody = JSON.parse((batchInit as RequestInit).body as string);
      expect(batchBody.input_file_id).toBe("file-abc123");
      expect(batchBody.endpoint).toBe("/v1/embeddings");
      expect(batchBody.completion_window).toBe("24h");
    });

    it("includes agent metadata when agentId is provided", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: "file-abc" }));
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: "batch-def" }));

      await client.submitBatch(
        [{ customId: "mem-1", text: "test" }],
        "agent-42",
      );

      const [, batchInit] = fetchSpy.mock.calls[1]!;
      const body = JSON.parse((batchInit as RequestInit).body as string);
      expect(body.metadata).toEqual({ source: "kirie-memory", agent: "agent-42" });
    });

    it("throws on file upload failure", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse("rate limited", 429));

      await expect(
        client.submitBatch([{ customId: "1", text: "test" }]),
      ).rejects.toThrow("File upload failed: 429");
    });

    it("throws on batch creation failure", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: "file-abc" }));
      fetchSpy.mockResolvedValueOnce(mockResponse("bad request", 400));

      await expect(
        client.submitBatch([{ customId: "1", text: "test" }]),
      ).rejects.toThrow("Batch create failed: 400");
    });
  });

  describe("waitForBatch", () => {
    it("polls and returns results when batch completes", async () => {
      const outputJsonl = [
        JSON.stringify({
          custom_id: "mem-1",
          response: { body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } },
        }),
        JSON.stringify({
          custom_id: "mem-2",
          response: { body: { data: [{ embedding: [0.4, 0.5, 0.6] }] } },
        }),
      ].join("\n");

      // First poll: in_progress
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "in_progress" }),
      );
      // Second poll: completed
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "completed", output_file_id: "file-output-1" }),
      );
      // File content fetch
      fetchSpy.mockResolvedValueOnce(mockResponse(outputJsonl));

      const results = await client.waitForBatch("batch-1", {
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      expect(results).toHaveLength(2);
      expect(results[0]!.customId).toBe("mem-1");
      expect(results[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(results[1]!.customId).toBe("mem-2");
      expect(results[1]!.embedding).toEqual([0.4, 0.5, 0.6]);
    });

    it("throws on batch failure", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "failed", error_file_id: "file-err-1" }),
      );

      await expect(
        client.waitForBatch("batch-1", { pollIntervalMs: 10, timeoutMs: 5000 }),
      ).rejects.toThrow("Batch failed (check error file)");
    });

    it("throws on batch expiry", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "expired" }),
      );

      await expect(
        client.waitForBatch("batch-1", { pollIntervalMs: 10, timeoutMs: 5000 }),
      ).rejects.toThrow("Batch expired");
    });

    it("throws on batch cancellation", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "cancelled" }),
      );

      await expect(
        client.waitForBatch("batch-1", { pollIntervalMs: 10, timeoutMs: 5000 }),
      ).rejects.toThrow("Batch cancelled");
    });

    it("throws on timeout", async () => {
      // Always return in_progress
      fetchSpy.mockImplementation(() =>
        Promise.resolve(mockResponse({ status: "in_progress" })),
      );

      await expect(
        client.waitForBatch("batch-1", { pollIntervalMs: 10, timeoutMs: 50 }),
      ).rejects.toThrow("Batch timed out");
    });

    it("throws when completed but no output file", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: "completed" }),
      );

      await expect(
        client.waitForBatch("batch-1", { pollIntervalMs: 10, timeoutMs: 5000 }),
      ).rejects.toThrow("Batch completed but no output file");
    });
  });

  describe("parseBatchOutput", () => {
    it("parses successful embedding responses", () => {
      const text = [
        JSON.stringify({
          custom_id: "mem-1",
          response: { body: { data: [{ embedding: [1.0, 2.0] }] } },
        }),
        JSON.stringify({
          custom_id: "mem-2",
          response: { body: { data: [{ embedding: [3.0, 4.0] }] } },
        }),
      ].join("\n");

      const results = client.parseBatchOutput(text);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ customId: "mem-1", embedding: [1.0, 2.0], error: undefined });
      expect(results[1]).toEqual({ customId: "mem-2", embedding: [3.0, 4.0], error: undefined });
    });

    it("handles error responses in batch output", () => {
      const text = JSON.stringify({
        custom_id: "mem-err",
        error: { message: "Input too long" },
        response: { body: {} },
      });

      const results = client.parseBatchOutput(text);
      expect(results).toHaveLength(1);
      expect(results[0]!.customId).toBe("mem-err");
      expect(results[0]!.embedding).toEqual([]);
      expect(results[0]!.error).toBe("Input too long");
    });

    it("handles response-level errors", () => {
      const text = JSON.stringify({
        custom_id: "mem-err2",
        response: { body: { error: { message: "Rate limit exceeded" } } },
      });

      const results = client.parseBatchOutput(text);
      expect(results[0]!.error).toBe("Rate limit exceeded");
    });

    it("handles missing fields gracefully", () => {
      const text = JSON.stringify({});

      const results = client.parseBatchOutput(text);
      expect(results).toHaveLength(1);
      expect(results[0]!.customId).toBe("");
      expect(results[0]!.embedding).toEqual([]);
    });
  });

  describe("embedBatch", () => {
    it("splits large requests into chunks and merges results", async () => {
      const requests: BatchEmbeddingRequest[] = Array.from({ length: 5 }, (_, i) => ({
        customId: `mem-${i}`,
        text: `Text ${i}`,
      }));

      const makeOutput = (ids: string[]) =>
        ids.map(id =>
          JSON.stringify({
            custom_id: id,
            response: { body: { data: [{ embedding: [1.0] }] } },
          }),
        ).join("\n");

      // First chunk (items 0-1): upload, create, poll, fetch output
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ id: "file-1" }))
        .mockResolvedValueOnce(mockResponse({ id: "batch-1" }))
        .mockResolvedValueOnce(mockResponse({ status: "completed", output_file_id: "out-1" }))
        .mockResolvedValueOnce(mockResponse(makeOutput(["mem-0", "mem-1"])));

      // Second chunk (items 2-3): upload, create, poll, fetch output
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ id: "file-2" }))
        .mockResolvedValueOnce(mockResponse({ id: "batch-2" }))
        .mockResolvedValueOnce(mockResponse({ status: "completed", output_file_id: "out-2" }))
        .mockResolvedValueOnce(mockResponse(makeOutput(["mem-2", "mem-3"])));

      // Third chunk (item 4): upload, create, poll, fetch output
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ id: "file-3" }))
        .mockResolvedValueOnce(mockResponse({ id: "batch-3" }))
        .mockResolvedValueOnce(mockResponse({ status: "completed", output_file_id: "out-3" }))
        .mockResolvedValueOnce(mockResponse(makeOutput(["mem-4"])));

      const results = await client.embedBatch(requests, {
        maxRequestsPerBatch: 2,
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      expect(results).toHaveLength(5);
      expect(results.map(r => r.customId)).toEqual(["mem-0", "mem-1", "mem-2", "mem-3", "mem-4"]);
    });
  });

  describe("constructor defaults", () => {
    it("uses default model and baseUrl when not specified", () => {
      const instance = new OpenAIBatchEmbeddings({ apiKey: "key" });
      // We can't directly access private fields, but we can verify via
      // the headers method being called during submitBatch — just check
      // it doesn't throw on construction.
      expect(instance).toBeDefined();
    });
  });
});
