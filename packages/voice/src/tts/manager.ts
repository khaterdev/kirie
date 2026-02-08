import type { TTSProvider, TTSOptions, Voice } from "./types.js";
import { ElevenLabsTTS } from "./elevenlabs.js";
import { OpenAITTS } from "./openai-tts.js";
import { EdgeTTS } from "./edge-tts.js";

const MAX_TEXT_LENGTH = 1500;

export interface TTSManagerConfig {
  preferredProvider?: string;
  elevenLabsApiKey?: string;
  openaiApiKey?: string;
}

export class TTSManager {
  private providers: TTSProvider[] = [];

  constructor(config?: TTSManagerConfig) {
    // Initialize providers based on available API keys
    if (config?.elevenLabsApiKey) {
      this.providers.push(
        new ElevenLabsTTS({ apiKey: config.elevenLabsApiKey }),
      );
    }
    if (config?.openaiApiKey) {
      this.providers.push(new OpenAITTS({ apiKey: config.openaiApiKey }));
    }
    // Edge TTS as free fallback
    this.providers.push(new EdgeTTS());

    // Reorder if preferred provider specified
    if (config?.preferredProvider) {
      const idx = this.providers.findIndex(
        (p) => p.name === config.preferredProvider,
      );
      if (idx > 0) {
        const [preferred] = this.providers.splice(idx, 1);
        this.providers.unshift(preferred!);
      }
    }
  }

  async synthesize(
    text: string,
    options?: TTSOptions,
  ): Promise<{ buffer: Buffer; provider: string }> {
    // Truncate long text
    const truncated =
      text.length > MAX_TEXT_LENGTH
        ? text.slice(0, MAX_TEXT_LENGTH) + "..."
        : text;

    // Try providers in order (fallback chain)
    for (const provider of this.providers) {
      try {
        const buffer = await provider.synthesize(truncated, options);
        return { buffer, provider: provider.name };
      } catch {
        continue; // try next provider
      }
    }

    throw new Error("All TTS providers failed");
  }

  async listVoices(): Promise<Array<Voice & { provider: string }>> {
    const all: Array<Voice & { provider: string }> = [];
    for (const provider of this.providers) {
      try {
        const voices = await provider.voices();
        all.push(...voices.map((v) => ({ ...v, provider: provider.name })));
      } catch {
        /* skip */
      }
    }
    return all;
  }

  getProviders(): string[] {
    return this.providers.map((p) => p.name);
  }
}
