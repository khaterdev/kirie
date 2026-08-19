import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { writeFile } from "node:fs/promises";
import { createImageToolHandlers } from "./image-tool.js";

describe("image generation providers", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.ATLASCLOUD_API_KEY = "atlas-test-key";
    vi.mocked(writeFile).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ATLASCLOUD_API_KEY;
  });

  it("keeps OpenAI as the default generation provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("openai-image").toString("base64") }],
        }),
        { status: 200 },
      ),
    );

    const result = await createImageToolHandlers().image.handler({
      action: "generate",
      input: "a paper airplane",
    });

    expect(result.provider).toBe("openai");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://api.openai.com/v1/images/generations",
    );
  });

  it("submits Atlas once, polls the result, and downloads the output", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "prediction-123", status: "created", outputs: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "prediction-123",
            status: "completed",
            outputs: ["https://cdn.example.com/image.png"],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("atlas-image"), { status: 200 }),
      );

    const result = await createImageToolHandlers().image.handler({
      action: "generate",
      input: "a red paper airplane",
      provider: "atlas",
      size: "1792x1024",
    });

    expect(result).toMatchObject({
      provider: "atlas",
      model: "bytedance/seedream-v4",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://api.atlascloud.ai/api/v1/model/generateImage",
    );
    const submitBody = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(submitBody).toEqual({
      model: "bytedance/seedream-v4",
      prompt: "a red paper airplane",
      size: "1792*1024",
    });
    expect(fetchSpy.mock.calls[1]![0]).toBe(
      "https://api.atlascloud.ai/api/v1/model/result/prediction-123",
    );
    expect(fetchSpy.mock.calls[2]![0]).toBe(
      "https://cdn.example.com/image.png",
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/[.]png$/),
      Buffer.from("atlas-image"),
    );
  });

  it("does not retry a failed Atlas generation submission", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream unavailable", { status: 503 }),
    );

    await expect(
      createImageToolHandlers().image.handler({
        action: "generate",
        input: "a paper airplane",
        provider: "atlas",
      }),
    ).rejects.toThrow("Atlas image generation API error: HTTP 503");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
