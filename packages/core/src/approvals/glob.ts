/**
 * Small, linear-time glob matchers for the approval gate (PLAN C.9).
 *
 * No regular expressions are built from patterns: both matchers are
 * hand-written so a pattern or an input chosen by the model can never cause
 * catastrophic backtracking.
 */

/**
 * Match `text` against a glob where `*` is any run of characters (including
 * spaces and slashes) and `?` is exactly one character. Everything else is
 * literal. Classic two-pointer wildcard matching: O(text * stars) in the worst
 * case, linear in practice.
 */
export function matchApprovalGlob(pattern: string, text: string, opts: { caseInsensitive?: boolean } = {}): boolean {
  const p = opts.caseInsensitive ? pattern.toLowerCase() : pattern;
  const t = opts.caseInsensitive ? text.toLowerCase() : text;
  let pi = 0;
  let ti = 0;
  let starP = -1;
  let starT = 0;
  while (ti < t.length) {
    const pc = p[pi];
    if (pi < p.length && (pc === "?" || (pc !== "*" && pc === t[ti]))) {
      pi++;
      ti++;
    } else if (pi < p.length && pc === "*") {
      starP = pi++;
      starT = ti;
    } else if (starP !== -1) {
      pi = starP + 1;
      ti = ++starT;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Match an absolute, normalized path against a path glob, case-insensitively
 * (APFS default). `**` as a whole segment matches zero or more segments, `*`
 * matches within one segment, `?` one character. A pattern that starts with
 * `**` matches at any depth.
 */
export function matchApprovalPathGlob(pattern: string, path: string): boolean {
  const pSegs = splitPath(pattern.toLowerCase());
  const tSegs = splitPath(path.toLowerCase());
  // memo[i][j]: pattern from i matches path from j. Sizes are tiny (path depth).
  const memo = new Map<number, boolean>();
  const width = tSegs.length + 1;
  const walk = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === pSegs.length) {
      result = j === tSegs.length;
    } else if (pSegs[i] === "**") {
      result = walk(i + 1, j) || (j < tSegs.length && walk(i, j + 1));
    } else {
      result = j < tSegs.length && matchApprovalGlob(pSegs[i]!, tSegs[j]!) && walk(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

/** True when `segment` contains an unescaped glob metacharacter. */
export function hasGlobChars(segment: string): boolean {
  for (const ch of segment) {
    if (ch === "*" || ch === "?" || ch === "[") return true;
  }
  return false;
}
