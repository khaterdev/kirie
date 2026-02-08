/**
 * Audio transcription service with pluggable providers.
 * Supports OpenAI Whisper and Groq.
 */

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

export function createTranscriptionProvider(config: {
  provider: "openai" | "groq";
  apiKey: string;
  model?: string;
}): TranscriptionProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIWhisperProvider({ apiKey: config.apiKey, model: config.model });
    case "groq":
      return new GroqWhisperProvider({ apiKey: config.apiKey, model: config.model });
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
