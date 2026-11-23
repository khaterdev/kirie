// Not used by the webhook call path (PLAN C.14).
export interface TTSProvider {
  synthesize(text: string, options?: TTSOptions): Promise<Buffer>;
  voices(): Promise<Voice[]>;
  readonly name: string;
}

export interface TTSOptions {
  voice?: string;
  format?: "mp3" | "opus" | "pcm" | "wav";
  speed?: number;
  model?: string;
}

export interface Voice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  preview_url?: string;
}
