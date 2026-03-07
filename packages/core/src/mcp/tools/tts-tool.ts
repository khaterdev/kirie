import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Resolve which TTS provider to use.
 *
 * Priority when no explicit provider is requested:
 *   1. KIRIE_TTS_PROVIDER env (the configured default)
 *   2. edge-tts (free, always available)
 *   3. kokoro  (if enabled)
 *   4. openai  (if API key present)
 *   5. elevenlabs (if API key present)
 */
function resolveProvider(explicit?: string): string {
  if (explicit) return explicit;
  const configured = process.env.KIRIE_TTS_PROVIDER;
  if (configured) return configured;
  // Fallback order
  if (process.env.KIRIE_KOKORO_ENABLED === "1") return "kokoro";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ELEVENLABS_API_KEY) return "elevenlabs";
  return "edge-tts";
}

// ── Edge TTS via CLI ────────────────────────────────────────────────────────

async function synthesizeEdge(
  text: string,
  voice: string,
  format: string,
  outputPath: string,
): Promise<{ path: string; format: string; provider: string; voice: string; sizeBytes: number; isVoice: boolean } | { error: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "kirie-tts-"));
  // edge-tts always produces mp3 when writing via --write-media
  const tmpFile = join(tmpDir, `output.${format}`);
  try {
    execFileSync("edge-tts", ["--voice", voice, "--text", text, "--write-media", tmpFile], {
      timeout: 60_000,
    });
    const buffer = readFileSync(tmpFile);
    writeFileSync(outputPath, buffer);
    return { path: outputPath, format, provider: "edge-tts", voice, sizeBytes: buffer.length, isVoice: true };
  } catch (err) {
    return {
      error: `Edge TTS failed: ${err instanceof Error ? err.message : String(err)}. Is edge-tts installed? (pip install edge-tts)`,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ── Kokoro via local HTTP daemon ────────────────────────────────────────────

async function synthesizeKokoro(
  text: string,
  voice: string,
  speed: number,
  outputPath: string,
): Promise<{ path: string; format: string; provider: string; voice: string; sizeBytes: number; isVoice: boolean } | { error: string }> {
  const port = process.env.KIRIE_KOKORO_PORT ?? "18790";
  const url = `http://127.0.0.1:${port}/v1/audio/speech`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, voice, speed }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { error: `Kokoro daemon error (${resp.status}): ${body || resp.statusText}` };
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    // Kokoro daemon returns WAV
    const wavPath = outputPath.replace(/\.[^.]+$/, ".wav");
    writeFileSync(wavPath, buffer);
    return { path: wavPath, format: "wav", provider: "kokoro", voice, sizeBytes: buffer.length, isVoice: true };
  } catch (err) {
    return {
      error: `Kokoro daemon unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}. Is the Kokoro daemon running?`,
    };
  }
}

// ── OpenAI TTS ──────────────────────────────────────────────────────────────

async function synthesizeOpenAI(
  text: string,
  voice: string,
  format: string,
  speed: number,
  outputPath: string,
): Promise<{ path: string; format: string; provider: string; voice: string; sizeBytes: number; isVoice: boolean } | { error: string }> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return { error: "OPENAI_API_KEY not set" };

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text.slice(0, 4096),
      voice,
      response_format: format,
      speed,
    }),
  });

  if (!resp.ok) return { error: `OpenAI TTS error: ${resp.statusText}` };

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(outputPath, buffer);
  return { path: outputPath, format, provider: "openai", voice, sizeBytes: buffer.length, isVoice: true };
}

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function synthesizeElevenLabs(
  text: string,
  voice: string,
  outputPath: string,
): Promise<{ path: string; format: string; provider: string; voice: string; sizeBytes: number; isVoice: boolean } | { error: string }> {
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsKey) return { error: "ELEVENLABS_API_KEY not set" };

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": elevenLabsKey,
    },
    body: JSON.stringify({
      text: text.slice(0, 4096),
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!resp.ok) return { error: `ElevenLabs error: ${resp.statusText}` };

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(outputPath, buffer);
  return { path: outputPath, format: "mp3", provider: "elevenlabs", voice, sizeBytes: buffer.length, isVoice: true };
}

// ── Tool export ─────────────────────────────────────────────────────────────

export function createTTSToolHandlers() {
  return {
    tts: {
      description:
        "Convert text to speech audio. Returns path to generated audio file. " +
        "Providers: edge-tts (default, free, Microsoft voices), kokoro (local, high quality), " +
        "openai (requires OPENAI_API_KEY), elevenlabs (requires ELEVENLABS_API_KEY).",
      parameters: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Text to convert to speech",
          },
          voice: {
            type: "string",
            description: "Voice name/ID (default: auto-select based on provider)",
          },
          provider: {
            type: "string",
            description:
              "TTS provider: edge-tts (default, free), kokoro (local, high quality), openai, elevenlabs. " +
              "Omit to use the configured default.",
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
        const speed = params.speed ?? 1.0;
        const outputPath = join(mediaDir, `${randomUUID()}.${format}`);

        const provider = resolveProvider(params.provider);

        switch (provider) {
          case "edge-tts":
          case "edge": {
            const voice = params.voice ?? process.env.KIRIE_EDGE_VOICE ?? "en-US-AriaNeural";
            return synthesizeEdge(params.text, voice, format, outputPath);
          }

          case "kokoro": {
            const voice = params.voice ?? process.env.KIRIE_KOKORO_VOICE ?? "af_heart";
            const kokoroSpeed = params.speed ?? Number(process.env.KIRIE_KOKORO_SPEED || "1.0");
            return synthesizeKokoro(params.text, voice, kokoroSpeed, outputPath);
          }

          case "openai": {
            const voice = params.voice ?? "nova";
            return synthesizeOpenAI(params.text, voice, format, speed, outputPath);
          }

          case "elevenlabs": {
            const voice = params.voice ?? "21m00Tcm4TlvDq8ikWAM";
            return synthesizeElevenLabs(params.text, voice, outputPath);
          }

          default:
            return { error: `Unknown TTS provider: ${provider}. Supported: edge-tts, kokoro, openai, elevenlabs.` };
        }
      },
    },
  };
}
