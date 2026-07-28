/**
 * Parses MEDIA: <url> tokens from agent text output.
 * Used to extract media URLs that should be sent as files/images/voice to users.
 */

export interface MediaOutputParseResult {
  /** Cleaned text with MEDIA: lines removed */
  text: string;
  /** Extracted media URLs */
  mediaUrls?: string[];
  /** Whether the agent requested audio be sent as voice note */
  audioAsVoice?: boolean;
}

/**
 * Scan agent output for MEDIA: <url> tokens outside fenced code blocks.
 * Supports [[audio_as_voice]] tag for voice note mode.
 * URLs must be https:// or local file paths.
 */
export function splitMediaFromOutput(raw: string): MediaOutputParseResult {
  const lines = raw.split("\n");
  const mediaUrls: string[] = [];
  let audioAsVoice = false;
  const textLines: string[] = [];

  // Track fenced code block spans
  let inFence = false;

  const mediaRegex = /^\s*MEDIA:\s*`?([^\s`]+)`?\s*$/i;

  for (const line of lines) {
    // Toggle fence state on ``` lines
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      textLines.push(line);
      continue;
    }

    // Skip extraction inside fenced code blocks
    if (inFence) {
      textLines.push(line);
      continue;
    }

    // Check for [[audio_as_voice]] tag
    if (/\[\[audio_as_voice\]\]/i.test(line)) {
      audioAsVoice = true;
      // Don't include this line in output text
      continue;
    }

    // Check for MEDIA: token
    const match = line.match(mediaRegex);
    if (match) {
      const url = match[1]?.trim() ?? "";
      // Validate URL: must be https:// or local path
      if (url.startsWith("https://") || url.startsWith("/") || url.startsWith("~")) {
        mediaUrls.push(url);
      }
      // Don't include MEDIA: lines in output text
      continue;
    }

    textLines.push(line);
  }

  // Clean up text: remove leading/trailing empty lines caused by media extraction
  const text = textLines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trimEnd();

  return {
    text,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    audioAsVoice: audioAsVoice || undefined,
  };
}
