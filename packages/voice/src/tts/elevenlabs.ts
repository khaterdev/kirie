import type { TTSProvider, TTSOptions, Voice } from "./types.js";

export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  private apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const voiceId = options?.voice ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel default
    const model = options?.model ?? "eleven_multilingual_v2";

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!resp.ok) throw new Error(`ElevenLabs error: ${resp.statusText}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  async voices(): Promise<Voice[]> {
    const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        labels?: { language?: string; gender?: string };
      }>;
    };
    return data.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language,
      gender: v.labels?.gender,
    }));
  }
}
