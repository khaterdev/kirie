import type { TTSProvider, TTSOptions, Voice } from "./types.js";

const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

export class OpenAITTS implements TTSProvider {
  readonly name = "openai";
  private apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const voice = options?.voice ?? "nova";
    const model = options?.model ?? "tts-1";
    const format = options?.format ?? "mp3";
    const speed = options?.speed ?? 1.0;

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
        speed,
      }),
    });

    if (!resp.ok) throw new Error(`OpenAI TTS error: ${resp.statusText}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  async voices(): Promise<Voice[]> {
    return OPENAI_VOICES.map((v) => ({ id: v, name: v }));
  }
}
