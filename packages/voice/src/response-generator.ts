/**
 * Voice response generator.
 *
 * Uses the agent engine to generate text responses for voice calls,
 * which are then converted to speech via TTS.
 */

export interface VoiceResponseOptions {
  /** Phone number of the caller (used for session key) */
  callerPhone: string;
  /** Model override for voice responses */
  model?: string;
  /** Custom system prompt additions for voice context */
  systemPromptAppend?: string;
  /** Maximum response length in characters (voice responses should be concise) */
  maxResponseLength?: number;
}

/**
 * Build a session key for a voice call based on the caller's phone number.
 * Normalizes the phone number to remove formatting.
 */
export function buildVoiceSessionKey(phone: string): string {
  const normalized = phone.replace(/[\s\-()]+/g, "").replace(/^00/, "+");
  return `voice:${normalized}`;
}

/**
 * Truncate a response to be suitable for voice output.
 * Strips markdown, URLs, and long passages that don't work well in speech.
 */
export function prepareForSpeech(text: string, maxLength = 500): string {
  let cleaned = text
    // Remove markdown links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove markdown bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    // Remove markdown headers
    .replace(/^#{1,6}\s+/gm, "")
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, "")
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove URLs
    .replace(/https?:\/\/\S+/g, "")
    // Collapse multiple newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length > maxLength) {
    // Truncate at sentence boundary
    const truncated = cleaned.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf(".");
    const lastQuestion = truncated.lastIndexOf("?");
    const lastExclaim = truncated.lastIndexOf("!");
    const bestBreak = Math.max(lastPeriod, lastQuestion, lastExclaim);

    if (bestBreak > maxLength * 0.5) {
      cleaned = truncated.slice(0, bestBreak + 1);
    } else {
      cleaned = truncated + "...";
    }
  }

  return cleaned;
}

/**
 * Build a voice-specific system prompt addition that instructs the agent
 * to respond in a voice-friendly manner.
 */
export function buildVoiceSystemPrompt(callerPhone: string): string {
  return `
## Voice Call Context
You are speaking on a phone call with the user at ${callerPhone}.
Keep your responses concise and conversational — suitable for spoken speech.
Avoid markdown formatting, code blocks, URLs, and long lists.
Use short sentences. Pause naturally between ideas.
If asked something that requires a long answer, summarize the key points
and offer to send details via text message.
`.trim();
}
