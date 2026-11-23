/**
 * XML helpers shared by the TwiML and Plivo XML builders. Nothing outside the
 * markup builders writes XML.
 */

/** Characters that are not allowed anywhere in an XML 1.0 document. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escape text for an element body or an attribute value. */
export function escapeXml(text: string): string {
  return String(text)
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type XmlAttrs = Record<string, string | number | boolean | undefined>;

function renderAttrs(attrs: XmlAttrs | undefined): string {
  if (!attrs) return "";
  let out = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out += ` ${name}="${escapeXml(String(value))}"`;
  }
  return out;
}

/** One element. `children` is already-rendered XML; `text` is escaped. */
export function el(name: string, attrs?: XmlAttrs, body?: { text?: string; children?: string[] }): string {
  const a = renderAttrs(attrs);
  if (body?.text !== undefined) return `<${name}${a}>${escapeXml(body.text)}</${name}>`;
  if (body?.children && body.children.length > 0) return `<${name}${a}>${body.children.join("")}</${name}>`;
  return `<${name}${a}/>`;
}

export function xmlDocument(rootChildren: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${el("Response", undefined, { children: rootChildren })}`;
}
