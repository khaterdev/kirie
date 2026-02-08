import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function createTTSToolHandlers() {
  return {
    tts: {
      description:
        "Convert text to speech audio. Returns path to generated audio file. Requires OPENAI_API_KEY or ELEVENLABS_API_KEY env var.",
      parameters: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Text to convert to speech",
          },
          voice: {
            type: "string",
            description: "Voice name/ID (default: auto-select)",
          },
          provider: {
            type: "string",
            description:
              "TTS provider: openai, elevenlabs, edge-tts (default: auto)",
          },
          format: {
            type: "string",
            description: "Audio format: mp3, opus, wav (default: mp3)",
          },
          speed: {
            type: "number",
            description: "Speech speed multiplier (default: 1.0)",
          },
        },
        required: ["text"] as const,
      },
      async handler(params: {
        text: string;
        voice?: string;
        provider?: string;
        format?: string;
        speed?: number;
      }) {
        const mediaDir = join(homedir(), ".kirie", "media", "tts");
        if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

        const format = params.format ?? "mp3";
        const outputPath = join(mediaDir, `${randomUUID()}.${format}`);

        // Try providers based on available API keys
        const openaiKey = process.env.OPENAI_API_KEY;
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY;

        if (params.provider === "openai" || (!params.provider && openaiKey)) {
          if (!openaiKey) return { error: "OPENAI_API_KEY not set" };

          const resp = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: "tts-1",
              input: params.text.slice(0, 4096),
              voice: params.voice ?? "nova",
              response_format: format,
              speed: params.speed ?? 1.0,
            }),
          });

          if (!resp.ok)
            return { error: `OpenAI TTS error: ${resp.statusText}` };

          const buffer = Buffer.from(await resp.arrayBuffer());
          writeFileSync(outputPath, buffer);

          return {
            path: outputPath,
            format,
            provider: "openai",
            voice: params.voice ?? "nova",
            sizeBytes: buffer.length,
            isVoice: true,
          };
        }

        if (
          params.provider === "elevenlabs" ||
          (!params.provider && elevenLabsKey)
        ) {
          if (!elevenLabsKey)
            return { error: "ELEVENLABS_API_KEY not set" };

          const voiceId = params.voice ?? "21m00Tcm4TlvDq8ikWAM";
          const resp = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "xi-api-key": elevenLabsKey,
              },
              body: JSON.stringify({
                text: params.text.slice(0, 4096),
                model_id: "eleven_multilingual_v2",
              }),
            },
          );

          if (!resp.ok)
            return { error: `ElevenLabs error: ${resp.statusText}` };

          const buffer = Buffer.from(await resp.arrayBuffer());
          writeFileSync(outputPath, buffer);

          return {
            path: outputPath,
            format: "mp3",
            provider: "elevenlabs",
            voice: voiceId,
            sizeBytes: buffer.length,
            isVoice: true,
          };
        }

        return {
          error:
            "No TTS provider available. Set OPENAI_API_KEY or ELEVENLABS_API_KEY, or install edge-tts (pip install edge-tts).",
        };
      },
    },
  };
}
