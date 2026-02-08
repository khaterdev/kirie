/**
 * OpenAI Batch API for bulk embedding processing.
 * Uses async batch jobs for cost-effective bulk embedding.
 */

export interface BatchEmbeddingRequest {
  customId: string;
  text: string;
}

export interface BatchEmbeddingResult {
  customId: string;
  embedding: number[];
  error?: string;
}

export interface BatchEmbeddingOptions {
  pollIntervalMs?: number;      // default 5000
  timeoutMs?: number;           // default 300000 (5 min)
  maxRequestsPerBatch?: number; // default 50000
}

export class OpenAIBatchEmbeddings {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  }

  private headers(json = true): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async submitBatch(requests: BatchEmbeddingRequest[], agentId?: string): Promise<string> {
    // 1. Build JSONL content
    const jsonl = requests.map(r => JSON.stringify({
      custom_id: r.customId,
      method: "POST",
      url: "/v1/embeddings",
      body: { model: this.model, input: r.text },
    })).join("\n");

    // 2. Upload file
    const formData = new FormData();
    formData.append("purpose", "batch");
    formData.append("file", new Blob([jsonl], { type: "application/jsonl" }), "embeddings.jsonl");

    const fileRes = await fetch(`${this.baseUrl}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });
    if (!fileRes.ok) throw new Error(`File upload failed: ${fileRes.status} ${await fileRes.text()}`);
    const fileData = await fileRes.json() as { id: string };

    // 3. Create batch
    const batchRes = await this.retryFetch(`${this.baseUrl}/batches`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        input_file_id: fileData.id,
        endpoint: "/v1/embeddings",
        completion_window: "24h",
        metadata: { source: "kirie-memory", ...(agentId ? { agent: agentId } : {}) },
      }),
    });
    if (!batchRes.ok) throw new Error(`Batch create failed: ${batchRes.status} ${await batchRes.text()}`);
    const batch = await batchRes.json() as { id: string };
    return batch.id;
  }

  async waitForBatch(batchId: string, opts?: BatchEmbeddingOptions): Promise<BatchEmbeddingResult[]> {
    const pollInterval = opts?.pollIntervalMs ?? 5000;
    const timeout = opts?.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/batches/${batchId}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`Batch status failed: ${res.status}`);
      const status = await res.json() as { status: string; output_file_id?: string; error_file_id?: string };

      switch (status.status) {
        case "completed": {
          if (!status.output_file_id) throw new Error("Batch completed but no output file");
          const content = await this.fetchFileContent(status.output_file_id);
          return this.parseBatchOutput(content);
        }
        case "failed":
        case "expired":
        case "cancelled":
          throw new Error(`Batch ${status.status}${status.error_file_id ? " (check error file)" : ""}`);
        default:
          // in_progress, validating, finalizing — keep polling
          await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
    throw new Error(`Batch timed out after ${timeout}ms`);
  }

  async embedBatch(requests: BatchEmbeddingRequest[], opts?: BatchEmbeddingOptions): Promise<BatchEmbeddingResult[]> {
    const maxPerBatch = opts?.maxRequestsPerBatch ?? 50_000;
    const allResults: BatchEmbeddingResult[] = [];

    for (let i = 0; i < requests.length; i += maxPerBatch) {
      const chunk = requests.slice(i, i + maxPerBatch);
      const batchId = await this.submitBatch(chunk);
      const results = await this.waitForBatch(batchId, opts);
      allResults.push(...results);
    }
    return allResults;
  }

  private async fetchFileContent(fileId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}/content`, { headers: this.headers() });
    if (!res.ok) throw new Error(`File fetch failed: ${res.status}`);
    return res.text();
  }

  parseBatchOutput(text: string): BatchEmbeddingResult[] {
    return text.trim().split("\n").filter(Boolean).map(line => {
      const parsed = JSON.parse(line) as {
        custom_id?: string;
        response?: { body?: { data?: Array<{ embedding?: number[] }>; error?: { message?: string } } };
        error?: { message?: string };
      };
      const embedding = parsed.response?.body?.data?.[0]?.embedding;
      return {
        customId: parsed.custom_id ?? "",
        embedding: embedding ?? [],
        error: parsed.error?.message || parsed.response?.body?.error?.message,
      };
    });
  }

  private async retryFetch(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(url, init);
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      const delay = Math.min(300 * Math.pow(2, i), 2000) * (1 + Math.random() * 0.2);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return fetch(url, init); // Final attempt
  }
}
