import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { defaultModelsDir, modelDir, isModelDownloaded, ARCTIC_MODEL_NAME } from "./model-downloader.js";

describe("model-downloader", () => {
  const tmp = join(tmpdir(), `kirie-model-test-${Date.now()}`);

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("defaultModelsDir() returns ~/.kirie/models", () => {
    expect(defaultModelsDir()).toBe(join(homedir(), ".kirie", "models"));
  });

  it("modelDir() returns correct path with default modelsDir", () => {
    expect(modelDir()).toBe(join(homedir(), ".kirie", "models", ARCTIC_MODEL_NAME));
  });

  it("modelDir() returns correct path with custom modelsDir", () => {
    expect(modelDir("/custom/path")).toBe(join("/custom/path", ARCTIC_MODEL_NAME));
  });

  it("isModelDownloaded() returns false when files don't exist", () => {
    expect(isModelDownloaded(tmp)).toBe(false);
  });

  it("isModelDownloaded() returns false when only some files exist", () => {
    const dir = join(tmp, ARCTIC_MODEL_NAME);
    mkdirSync(join(dir, "onnx"), { recursive: true });
    writeFileSync(join(dir, "tokenizer.json"), "{}");
    // onnx/model.onnx is missing
    expect(isModelDownloaded(tmp)).toBe(false);
  });

  it("isModelDownloaded() returns true when all files exist", () => {
    const dir = join(tmp, ARCTIC_MODEL_NAME);
    mkdirSync(join(dir, "onnx"), { recursive: true });
    writeFileSync(join(dir, "onnx", "model.onnx"), "fake-onnx-data");
    writeFileSync(join(dir, "tokenizer.json"), "{}");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "tokenizer_config.json"), "{}");
    writeFileSync(join(dir, "special_tokens_map.json"), "{}");
    expect(isModelDownloaded(tmp)).toBe(true);
  });
});
