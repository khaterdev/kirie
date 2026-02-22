/**
 * Audio transcription service with pluggable providers.
 * Supports OpenAI Whisper, Groq, and local whisper-cpp.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export interface TranscriptionProvider {
  transcribe(audio: Buffer, opts?: { mime?: string; language?: string }): Promise<string>;
}

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "whisper-1";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  }

  async transcribe(audio: Buffer, opts?: { mime?: string; language?: string }): Promise<string> {
    const formData = new FormData();
    const ext = mimeToExt(opts?.mime ?? "audio/ogg");
    formData.append("file", new Blob([audio], { type: opts?.mime ?? "audio/ogg" }), `audio.${ext}`);
    formData.append("model", this.model);
    if (opts?.language) formData.append("language", opts.language);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Whisper API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { text: string };
    return data.text;
  }
}

export class GroqWhisperProvider implements TranscriptionProvider {
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "whisper-large-v3";
  }

  async transcribe(audio: Buffer, opts?: { mime?: string; language?: string }): Promise<string> {
    const formData = new FormData();
    const ext = mimeToExt(opts?.mime ?? "audio/ogg");
    formData.append("file", new Blob([audio], { type: opts?.mime ?? "audio/ogg" }), `audio.${ext}`);
    formData.append("model", this.model);
    if (opts?.language) formData.append("language", opts.language);

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { text: string };
    return data.text;
  }
}

export interface LocalWhisperConfig {
  whisperBinary?: string;
  modelPath: string;
  language?: string;
  threads?: number;
}

export class LocalWhisperProvider implements TranscriptionProvider {
  private whisperBinary: string;
  private modelPath: string;
  private language: string;
  private threads: number;

  constructor(opts: LocalWhisperConfig) {
    this.whisperBinary = opts.whisperBinary ?? "whisper-cli";
    this.modelPath = opts.modelPath;
    this.language = opts.language ?? "auto";
    this.threads = opts.threads ?? 4;
  }

  async transcribe(audio: Buffer, opts?: { mime?: string; language?: string }): Promise<string> {
    // Create a temporary directory for working files
    const tmpDir = await mkdtemp(join(tmpdir(), "kirie-whisper-"));
    const ext = mimeToExt(opts?.mime ?? "audio/ogg");
    const inputPath = join(tmpDir, `input.${ext}`);
    const wavPath = join(tmpDir, "input.wav");

    try {
      // 1. Write audio buffer to temp file
      await writeFile(inputPath, audio);

      // 2. Convert to 16kHz WAV mono using ffmpeg
      await execFileAsync("ffmpeg", [
        "-i", inputPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        "-y",
        wavPath,
      ]);

      // 3. Run whisper-cli
      const lang = opts?.language ?? this.language;
      const args: string[] = [
        "-m", this.modelPath,
        "-f", wavPath,
        "-t", String(this.threads),
        "--no-timestamps",
      ];
      if (lang && lang !== "auto") {
        args.push("-l", lang);
      }

      const { stdout } = await execFileAsync(this.whisperBinary, args, {
        maxBuffer: 10 * 1024 * 1024, // 10 MB output buffer
        timeout: 120_000, // 2 minute timeout
      });

      // 4. Parse output — whisper-cli prints log lines to stderr and
      //    transcription text to stdout. Lines starting with "[" are
      //    timestamp markers; strip those plus any blank lines.
      const text = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith("["))
        .join(" ")
        .trim();

      return text;
    } finally {
      // 5. Clean up temp files (best-effort)
      await unlink(inputPath).catch(() => {});
      await unlink(wavPath).catch(() => {});
      // Remove the temp dir itself
      const { rmdir } = await import("node:fs/promises");
      await rmdir(tmpDir).catch(() => {});
    }
  }
}

export function createTranscriptionProvider(config: {
  provider: "openai" | "groq" | "local";
  apiKey?: string;
  model?: string;
  local?: LocalWhisperConfig;
}): TranscriptionProvider {
  switch (config.provider) {
    case "openai":
      if (!config.apiKey) throw new Error("OpenAI transcription provider requires an API key");
      return new OpenAIWhisperProvider({ apiKey: config.apiKey, model: config.model });
    case "groq":
      if (!config.apiKey) throw new Error("Groq transcription provider requires an API key");
      return new GroqWhisperProvider({ apiKey: config.apiKey, model: config.model });
    case "local":
      if (!config.local?.modelPath) throw new Error("Local whisper provider requires a modelPath");
      return new LocalWhisperProvider(config.local);
    default:
      throw new Error(`Unknown transcription provider: ${config.provider}`);
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };
  return map[mime] ?? "ogg";
}
