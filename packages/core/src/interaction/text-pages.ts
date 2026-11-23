/**
 * Long text shown to the owner in full, over as many messages as needed
 * (learning proposals, goal and loop Start cards). Nothing is cut.
 */

/** Content characters per message; with a short header each message stays under Telegram's 4096. */
export const FULL_TEXT_PAGE_CHARS = 3000;

/** Split text into chunks of at most `max` characters, at a line break when one is near. */
export function splitPages(text: string, max: number = FULL_TEXT_PAGE_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  out.push(rest);
  return out;
}
