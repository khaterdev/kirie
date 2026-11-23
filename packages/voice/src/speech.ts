/**
 * Turning an agent reply into spoken chunks.
 */

/** Strip markdown, code, URLs and media markers that make no sense spoken. No truncation. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*MEDIA:\S+\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{2}([^_]+)_{2}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Split into sentences, keeping the punctuation. */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?。؟])\s+|\n+/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Cap the spoken text at `maxChars`, cutting at a sentence boundary when one
 * is in the second half. `truncated` says whether anything was dropped.
 */
export function capSpeech(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const best = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("\n"));
  const out = best > maxChars * 0.5 ? cut.slice(0, best + 1) : cut.replace(/\s+\S*$/, "");
  return { text: out.trim(), truncated: true };
}

/** Pack sentences into chunks of at most `maxChars`; a single longer sentence is split at word boundaries. */
export function chunkForSay(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const sentence of sentences(text)) {
    if (sentence.length > maxChars) {
      push();
      let rest = sentence;
      while (rest.length > maxChars) {
        let at = rest.lastIndexOf(" ", maxChars);
        if (at <= 0) at = maxChars;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + 1 + sentence.length > maxChars) push();
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  push();
  return chunks;
}
