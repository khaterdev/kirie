/**
 * Extracts reply tags from message text.
 * Pattern: @tag:<value> at the start of a message.
 */

export interface ReplyTag {
  tag: string;
  rest: string;
}

const TAG_PATTERN = /^@tag:(\S+)\s*(.*)/s;

export function extractReplyTag(text: string): ReplyTag | null {
  const match = text.match(TAG_PATTERN);
  if (!match) return null;
  return { tag: match[1], rest: match[2] };
}
