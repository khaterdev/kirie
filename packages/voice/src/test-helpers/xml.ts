/**
 * Test-only: a strict little XML reader, enough to prove the markup builders
 * emit well-formed documents and to inspect them. Not exported by the package.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  if (/&(?!(amp|lt|gt|quot|apos);)/.test(s)) throw new Error(`bad entity in ${JSON.stringify(s)}`);
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITY[e]!);
}

export function parseXml(xml: string): XmlNode {
  let i = 0;
  const decl = /^<\?xml[^?]*\?>/.exec(xml);
  if (decl) i = decl[0].length;
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  while (i < xml.length) {
    if (xml[i] === "<") {
      const end = xml.indexOf(">", i);
      if (end < 0) throw new Error("unterminated tag");
      const raw = xml.slice(i + 1, end);
      i = end + 1;
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim();
        const top = stack.pop();
        if (!top || top.name !== name) throw new Error(`mismatched </${name}>`);
        continue;
      }
      const selfClosing = raw.endsWith("/");
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^([A-Za-z][\w-]*)((?:\s+[A-Za-z][\w-]*="[^"<]*")*)\s*$/.exec(body);
      if (!m) throw new Error(`bad tag <${raw}>`);
      const node: XmlNode = { name: m[1]!, attrs: {}, children: [], text: "" };
      for (const a of m[2]!.matchAll(/([A-Za-z][\w-]*)="([^"<]*)"/g)) {
        if (a[1]! in node.attrs) throw new Error(`duplicate attribute ${a[1]}`);
        node.attrs[a[1]!] = decode(a[2]!);
      }
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
    } else {
      const next = xml.indexOf("<", i);
      const chunk = xml.slice(i, next < 0 ? xml.length : next);
      if (chunk.includes(">")) throw new Error("raw > in text");
      stack[stack.length - 1]!.text += decode(chunk);
      i = next < 0 ? xml.length : next;
    }
  }
  if (stack.length !== 1) throw new Error("unclosed element");
  if (root.children.length !== 1) throw new Error("expected one root element");
  return root.children[0]!;
}

export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    if (n.name === name) out.push(n);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}
