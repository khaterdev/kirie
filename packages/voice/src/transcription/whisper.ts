export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface TranscriptionOptions {
  language?: string;
  model?: string; // default "whisper-1"
}

export class WhisperTranscription {
  private apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  async transcribe(
    audioBuffer: Buffer,
    filename: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer]), filename);
    formData.append("model", options?.model ?? "whisper-1");
    if (options?.language) formData.append("language", options.language);

    const resp = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      },
    );

    if (!resp.ok) throw new Error(`Whisper API error: ${resp.statusText}`);

    const data = (await resp.json()) as {
      text: string;
      language?: string;
      duration?: number;
    };
    return {
      text: data.text,
      language: data.language,
      durationMs: data.duration ? data.duration * 1000 : undefined,
    };
  }
}
