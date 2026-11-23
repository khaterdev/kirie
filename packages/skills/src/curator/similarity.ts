/**
 * Similarity helpers for the duplicate detectors (R4 item 4 D1 to D4).
 * Pure functions: no model, no network.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it", "of", "on", "or",
  "the", "this", "to", "use", "using", "when", "with", "you", "your",
]);

/** Lower-case word tokens of length 2+, stopwords removed. */
export function wordTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Tokens of a skill name: split on `-`, `_`, `.`, spaces and digits boundaries. */
export function nameTokens(name: string): Set<string> {
  return new Set((name.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []).filter((t) => t.length > 0));
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Cosine of two term-frequency vectors (lexical fallback when no embedder is available). */
export function termCosine(a: string, b: string): number {
  const ta = wordTokens(a);
  const tb = wordTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const fa = new Map<string, number>();
  const fb = new Map<string, number>();
  for (const t of ta) fa.set(t, (fa.get(t) ?? 0) + 1);
  for (const t of tb) fb.set(t, (fb.get(t) ?? 0) + 1);
  let dot = 0;
  for (const [t, n] of fa) dot += n * (fb.get(t) ?? 0);
  const norm = (m: Map<string, number>): number => Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  return dot / (norm(fa) * norm(fb));
}

/** Cosine of two dense vectors; 0 for empty, mismatched or zero vectors. */
export function vectorCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(c) ? c : 0;
}

export interface ScoredPair {
  a: string;
  b: string;
  score: number;
}

/**
 * Union-find clustering of candidate pairs, strongest pairs first. A union that
 * would make a cluster larger than `maxSize` is skipped. Returns clusters of
 * two or more members, each sorted, largest first.
 */
export function clusterPairs(pairs: readonly ScoredPair[], maxSize = 4): string[][] {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  const add = (x: string): void => {
    if (!parent.has(x)) { parent.set(x, x); size.set(x, 1); }
  };
  const sorted = [...pairs].sort((p, q) => q.score - p.score || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  for (const p of sorted) {
    add(p.a);
    add(p.b);
    const ra = find(p.a), rb = find(p.b);
    if (ra === rb) continue;
    const total = size.get(ra)! + size.get(rb)!;
    if (total > maxSize) continue;
    parent.set(rb, ra);
    size.set(ra, total);
  }
  const groups = new Map<string, string[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    groups.set(r, [...(groups.get(r) ?? []), x]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((x, y) => y.length - x.length || x[0]!.localeCompare(y[0]!));
}
