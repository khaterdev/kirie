/**
 * Image MCP tool — analyze images with AI vision or generate images with DALL-E 3.
 *
 * Actions:
 * - analyze: Read an image (file path or URL) and answer questions about it
 * - generate: Create an image from a text prompt using DALL-E 3
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ── Constants ───────────────────────────────────────────────────────────────

const MEDIA_DIR = join(homedir(), ".kirie", "media");

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
async function generateImage(
  prompt: string,
  size: string,
  model: string,
): Promise<{
  path: string;
  revisedPrompt?: string;
  model: string;
}> {
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

  // Save to media directory
  if (!existsSync(MEDIA_DIR)) {
    await mkdir(MEDIA_DIR, { recursive: true });
  }

  const timestamp = Date.now();
  const safeName = prompt
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();
  const filename = `gen_${timestamp}_${safeName}.png`;
  const filepath = join(MEDIA_DIR, filename);

  const buffer = Buffer.from(imageData.b64_json, "base64");
  await writeFile(filepath, buffer);

  return {
    path: filepath,
    revisedPrompt: imageData.revised_prompt,
    model: resolvedModel,
  };
}

// ── Tool handler ────────────────────────────────────────────────────────────

export function createImageToolHandlers() {
  return {
    image: {
      description:
        "Analyze images with AI vision or generate images. Requires OPENAI_API_KEY env var.",
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
        size?: string;
      }): Promise<Record<string, unknown>> {
        const { action, input, prompt, model, size } = params;

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
            );
            return {
              action: "generate",
              path: result.path,
              revisedPrompt: result.revisedPrompt,
              model: result.model,
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
