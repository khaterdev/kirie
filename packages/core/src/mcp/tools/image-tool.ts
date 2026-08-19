/**
 * Image MCP tool — analyze images with AI vision or generate images with OpenAI/Atlas.
 *
 * Actions:
 * - analyze: Read an image (file path or URL) and answer questions about it
 * - generate: Create an image from a text prompt using OpenAI or Atlas
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ── Constants ───────────────────────────────────────────────────────────────

const MEDIA_DIR = join(homedir(), ".kirie", "media");
const ATLAS_API_BASE = "https://api.atlascloud.ai/api/v1/model";
const ATLAS_DEFAULT_MODEL = "bytedance/seedream-v4";
const ATLAS_MAX_POLL_ATTEMPTS = 60;
const ATLAS_POLL_INTERVAL_MS = 2_000;

const IMAGE_PROVIDERS = ["openai", "atlas"] as const;
type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

type GeneratedImage = {
  path: string;
  revisedPrompt?: string;
  model: string;
  provider: ImageProvider;
};

type AtlasPrediction = {
  id?: string;
  status?: string;
  outputs?: string[];
  error?: string;
  message?: string;
};

type AtlasResponse = AtlasPrediction & { data?: AtlasPrediction };

function resolveImageProvider(provider?: string): ImageProvider {
  const resolved = (provider ?? "openai").toLowerCase();
  if (IMAGE_PROVIDERS.includes(resolved as ImageProvider)) {
    return resolved as ImageProvider;
  }
  throw new Error(
    `Unknown image provider: "${resolved}". Valid providers: ${IMAGE_PROVIDERS.join(", ")}`,
  );
}

function unwrapAtlasResponse(response: AtlasResponse): AtlasPrediction {
  return response.data ?? response;
}

function atlasSize(size: string): string {
  const supported = ["1024x1024", "1792x1024", "1024x1792"];
  return (supported.includes(size) ? size : "1024x1024").replace("x", "*");
}

function pollDelay(attempt: number): number {
  return Math.min(ATLAS_POLL_INTERVAL_MS * (attempt + 1), 10_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveGeneratedImage(prompt: string, image: Buffer): Promise<string> {
  if (!existsSync(MEDIA_DIR)) {
    await mkdir(MEDIA_DIR, { recursive: true });
  }

  const timestamp = Date.now();
  const safeName = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
  const filepath = join(MEDIA_DIR, `gen_${timestamp}_${safeName}.png`);
  await writeFile(filepath, image);
  return filepath;
}

// ── Image Analysis ──────────────────────────────────────────────────────────

/**
 * Analyze an image using OpenAI's vision API.
 */
async function analyzeImage(
  input: string,
  prompt: string,
  model: string,
): Promise<{ description: string; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for image analysis",
    );
  }

  // Determine if input is a URL or file path
  let imageContent: {
    type: "image_url";
    image_url: { url: string };
  };

  if (/^https?:\/\//i.test(input)) {
    imageContent = {
      type: "image_url",
      image_url: { url: input },
    };
  } else {
    // Read file and encode as base64 data URL
    const fileData = await readFile(input);
    const ext = extname(input).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    const mime = mimeMap[ext] ?? "image/png";
    const base64 = fileData.toString("base64");
    imageContent = {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    };
  }

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt || "Describe this image in detail." },
              imageContent,
            ],
          },
        ],
        max_tokens: 2000,
      }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `OpenAI Vision API error: HTTP ${response.status} — ${errText}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const description = data.choices?.[0]?.message?.content ?? "";

  return { description, model: model || "gpt-4o" };
}

// ── Image Generation ────────────────────────────────────────────────────────

/**
 * Generate an image using OpenAI DALL-E 3.
 */
async function generateOpenAIImage(
  prompt: string,
  size: string,
  model: string,
): Promise<GeneratedImage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for image generation",
    );
  }

  const validSizes = ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"];
  const resolvedSize = validSizes.includes(size) ? size : "1024x1024";
  const resolvedModel = model || "dall-e-3";

  const response = await fetch(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        prompt,
        n: 1,
        size: resolvedSize,
        response_format: "b64_json",
      }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `OpenAI Image Generation API error: HTTP ${response.status} — ${errText}`,
    );
  }

  const data = (await response.json()) as {
    data?: Array<{
      b64_json?: string;
      revised_prompt?: string;
    }>;
  };

  const imageData = data.data?.[0];
  if (!imageData?.b64_json) {
    throw new Error("No image data returned from DALL-E API");
  }

  const buffer = Buffer.from(imageData.b64_json, "base64");
  const filepath = await saveGeneratedImage(prompt, buffer);

  return {
    path: filepath,
    revisedPrompt: imageData.revised_prompt,
    model: resolvedModel,
    provider: "openai",
  };
}

async function pollAtlasPrediction(
  apiKey: string,
  predictionId: string,
  initial: AtlasPrediction,
): Promise<string> {
  let prediction = initial;

  for (let attempt = 0; attempt < ATLAS_MAX_POLL_ATTEMPTS; attempt += 1) {
    const status = prediction.status?.toLowerCase();
    if ((status === "completed" || status === "succeeded") && prediction.outputs?.[0]) {
      return prediction.outputs[0];
    }
    if (status === "failed") {
      throw new Error(
        `Atlas image generation failed: ${prediction.error ?? prediction.message ?? "unknown error"}`,
      );
    }

    const response = await fetch(
      `${ATLAS_API_BASE}/result/${encodeURIComponent(predictionId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (response.ok) {
      prediction = unwrapAtlasResponse((await response.json()) as AtlasResponse);
      const nextStatus = prediction.status?.toLowerCase();
      if (
        nextStatus === "completed" ||
        nextStatus === "succeeded" ||
        nextStatus === "failed"
      ) {
        continue;
      }
    } else if (attempt === ATLAS_MAX_POLL_ATTEMPTS - 1) {
      const detail = await response.text();
      throw new Error(
        `Atlas result API error: HTTP ${response.status} — ${detail}`,
      );
    }

    if (attempt < ATLAS_MAX_POLL_ATTEMPTS - 1) {
      await sleep(pollDelay(attempt));
    }
  }

  throw new Error(
    `Atlas image generation timed out after ${ATLAS_MAX_POLL_ATTEMPTS} result checks`,
  );
}

async function generateAtlasImage(
  prompt: string,
  size: string,
  model: string,
): Promise<GeneratedImage> {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ATLASCLOUD_API_KEY environment variable is required for Atlas image generation",
    );
  }

  const resolvedModel = model || ATLAS_DEFAULT_MODEL;
  const response = await fetch(`${ATLAS_API_BASE}/generateImage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      prompt,
      size: atlasSize(size),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Atlas image generation API error: HTTP ${response.status} — ${detail}`,
    );
  }

  const prediction = unwrapAtlasResponse((await response.json()) as AtlasResponse);
  if (!prediction.id) {
    throw new Error("Atlas image generation response did not include a prediction ID");
  }

  const outputUrl = await pollAtlasPrediction(apiKey, prediction.id, prediction);
  const imageResponse = await fetch(outputUrl);
  if (!imageResponse.ok) {
    throw new Error(
      `Atlas image download error: HTTP ${imageResponse.status} — ${imageResponse.statusText}`,
    );
  }

  const filepath = await saveGeneratedImage(
    prompt,
    Buffer.from(await imageResponse.arrayBuffer()),
  );
  return { path: filepath, model: resolvedModel, provider: "atlas" };
}

async function generateImage(
  prompt: string,
  size: string,
  model: string,
  provider?: string,
): Promise<GeneratedImage> {
  const resolvedProvider = resolveImageProvider(provider);
  return resolvedProvider === "atlas"
    ? generateAtlasImage(prompt, size, model)
    : generateOpenAIImage(prompt, size, model);
}

// ── Tool handler ────────────────────────────────────────────────────────────

export function createImageToolHandlers() {
  return {
    image: {
      description:
        "Analyze images with OpenAI vision or generate images with OpenAI (default) or Atlas.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description: "Action: 'analyze' or 'generate'",
          },
          input: {
            type: "string" as const,
            description:
              "File path or URL (for analyze) or text prompt (for generate)",
          },
          prompt: {
            type: "string" as const,
            description: "Analysis prompt (for analyze action)",
          },
          model: {
            type: "string" as const,
            description: "Model to use (default: auto-detect)",
          },
          provider: {
            type: "string" as const,
            description:
              "Generation provider: openai (default, requires OPENAI_API_KEY) or atlas (requires ATLASCLOUD_API_KEY). Analysis uses OpenAI.",
          },
          size: {
            type: "string" as const,
            description:
              "Image size for generation (default: 1024x1024)",
          },
        },
        required: ["action", "input"] as const,
      },
      async handler(params: {
        action: string;
        input: string;
        prompt?: string;
        model?: string;
        provider?: string;
        size?: string;
      }): Promise<Record<string, unknown>> {
        const { action, input, prompt, model, provider, size } = params;

        switch (action) {
          case "analyze": {
            const result = await analyzeImage(
              input,
              prompt ?? "Describe this image in detail.",
              model ?? "",
            );
            return {
              action: "analyze",
              description: result.description,
              model: result.model,
            };
          }

          case "generate": {
            const result = await generateImage(
              input,
              size ?? "1024x1024",
              model ?? "",
              provider,
            );
            return {
              action: "generate",
              path: result.path,
              revisedPrompt: result.revisedPrompt,
              model: result.model,
              provider: result.provider,
            };
          }

          default:
            throw new Error(
              `Unknown image action: "${action}". Valid actions: analyze, generate`,
            );
        }
      },
    },
  };
}
