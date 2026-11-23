import { describe, it, expect, vi } from "vitest";
import { LocalEmbeddings, NoopEmbeddings, OpenAIEmbeddings } from "@kirie/memory";
import { embedUserModelTexts, selectUserModelEmbedder } from "./embedder.js";

// Synthetic, never sent anywhere: no embed() call happens on the remote provider in these tests.
const remote = (): OpenAIEmbeddings => new OpenAIEmbeddings({ apiKey: ["test", "key", "not", "real"].join("-") });

describe("selectUserModelEmbedder", () => {
  it("reuses the daemon's provider only when it is the local ONNX model", () => {
    const local = new LocalEmbeddings();
    expect(selectUserModelEmbedder({ allowRemote: false, shared: local })).toEqual({ provider: local, source: "shared-local" });
  });

  it("never uses a remote provider unless allowRemoteEmbeddings; builds its own local model only when it is on disk", () => {
    const shared = remote();
    const own = new LocalEmbeddings();
    const createLocal = vi.fn(() => own);
    expect(selectUserModelEmbedder({ allowRemote: false, shared, localAvailable: () => true, createLocal })).toEqual({ provider: own, source: "own-local" });
    expect(selectUserModelEmbedder({ allowRemote: false, shared, localAvailable: () => false, createLocal })).toEqual({ provider: null, source: "none" });
    expect(createLocal).toHaveBeenCalledTimes(1);
    expect(selectUserModelEmbedder({ allowRemote: true, shared })).toEqual({ provider: shared, source: "shared-remote" });
  });

  it("noop memory embeddings mean no embeddings", () => {
    const createLocal = vi.fn(() => new LocalEmbeddings());
    expect(selectUserModelEmbedder({ allowRemote: true, shared: new NoopEmbeddings(), localAvailable: () => true, createLocal })).toEqual({ provider: null, source: "none" });
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("embedUserModelTexts never throws and maps zero vectors to null", async () => {
    expect(await embedUserModelTexts(null, ["a"])).toEqual([null]);
    expect(await embedUserModelTexts(new NoopEmbeddings(4), ["a"])).toEqual([null]);
    const failing = { model: "x", dimensions: 2, embed: async () => { throw new Error("down"); } };
    expect(await embedUserModelTexts(failing, ["a", "b"])).toEqual([null, null]);
  });
});
