export interface VoiceWakeConfig {
  triggerWords: string[];
  enabled: boolean;
}

/**
 * Voice Wake - listens for configurable trigger words.
 * This is a placeholder for integration with companion apps
 * that do local wake word detection and forward events.
 */
export class VoiceWake {
  private config: VoiceWakeConfig;
  private listeners: Array<(word: string) => void> = [];

  constructor(config?: Partial<VoiceWakeConfig>) {
    this.config = {
      triggerWords: config?.triggerWords ?? ["hey kirie", "kirie"],
      enabled: config?.enabled ?? false,
    };
  }

  onWake(listener: (word: string) => void): void {
    this.listeners.push(listener);
  }

  /** Called by companion apps via WebSocket/HTTP when wake word detected */
  trigger(word: string): void {
    if (!this.config.enabled) return;
    for (const listener of this.listeners) {
      listener(word);
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}
