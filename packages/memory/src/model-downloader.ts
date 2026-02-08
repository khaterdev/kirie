import { existsSync, mkdirSync, createWriteStream, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const ARCTIC_MODEL_NAME = "snowflake-arctic-embed-s";
export const ARCTIC_DIMENSIONS = 384;

const HF_BASE = "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main";
const MODEL_FILES = [
  { remote: `${HF_BASE}/onnx/model.onnx`, local: "onnx/model.onnx" },
  { remote: `${HF_BASE}/tokenizer.json`, local: "tokenizer.json" },
  // Required by fastembed's FlagEmbedding.init() for custom models:
  { remote: `${HF_BASE}/config.json`, local: "config.json" },
  { remote: `${HF_BASE}/tokenizer_config.json`, local: "tokenizer_config.json" },
  { remote: `${HF_BASE}/special_tokens_map.json`, local: "special_tokens_map.json" },
];

export interface ModelDownloadOptions {
  modelsDir?: string;
  onProgress?: (file: string, receivedBytes: number, totalBytes: number | null) => void;
}

export function defaultModelsDir(): string {
  return join(homedir(), ".kirie", "models");
}

export function modelDir(modelsDir?: string): string {
  return join(modelsDir ?? defaultModelsDir(), ARCTIC_MODEL_NAME);
}

export function isModelDownloaded(modelsDir?: string): boolean {
  const dir = modelDir(modelsDir);
  return MODEL_FILES.every((f) => existsSync(join(dir, f.local)));
}

export async function ensureModelDownloaded(opts?: ModelDownloadOptions): Promise<string> {
  const dir = modelDir(opts?.modelsDir);
  if (isModelDownloaded(opts?.modelsDir)) return dir;

  for (const file of MODEL_FILES) {
    const target = join(dir, file.local);
    const targetDir = join(target, "..");
    mkdirSync(targetDir, { recursive: true });

    const tmp = target + ".tmp";
    try {
      const res = await fetch(file.remote, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${file.remote}`);

      const totalBytes = res.headers.get("content-length") ? Number(res.headers.get("content-length")) : null;
      let receivedBytes = 0;

      const body = res.body;
      if (!body) throw new Error(`No response body for ${file.remote}`);

      const nodeStream = Readable.fromWeb(body as any);

      if (opts?.onProgress) {
        nodeStream.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          opts.onProgress!(file.local, receivedBytes, totalBytes);
        });
      }

      const ws = createWriteStream(tmp);
      await pipeline(nodeStream, ws);
      renameSync(tmp, target);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  return dir;
}
