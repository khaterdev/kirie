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
/**
 * Case folding for path comparison on APFS (case-insensitive and
 * normalization-insensitive by default): NFD, then upper and lower case, which
 * also folds `ſ` to `s`, `ß` to `ss` and ligatures. Used on both the pattern
 * and the path, so every comparison folds the same way.
 */
export function foldApprovalCase(s: string): string {
  // Fast path: plain ASCII folds with toLowerCase alone.
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return s.normalize("NFD").toUpperCase().toLowerCase();
  }
  return s.toLowerCase();
}

export function matchApprovalGlob(pattern: string, text: string, opts: { caseInsensitive?: boolean } = {}): boolean {
  const p = opts.caseInsensitive ? foldApprovalCase(pattern) : pattern;
  const t = opts.caseInsensitive ? foldApprovalCase(text) : text;
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
  const pSegs = splitPath(foldApprovalCase(pattern));
  const tSegs = splitPath(foldApprovalCase(path));
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

/**
 * Could some path match both globs? Used when a command names a path with a
 * glob (`cat ~/.ssh/*`, `echo x >> ~/.zsh?c`) to decide whether it can reach a
 * protected path. `*` and `?` in a segment do not match a leading dot (shell
 * rule); `**` spans any number of segments; two globbed segments are assumed
 * to overlap. Case-insensitive.
 */
export function approvalPathGlobsIntersect(a: string, b: string): boolean {
  const as = foldApprovalCase(a).split("/").filter((x) => x.length > 0);
  const bs = foldApprovalCase(b).split("/").filter((x) => x.length > 0);
  const memo = new Map<number, boolean>();
  const width = bs.length + 1;
  const segOk = (x: string, y: string): boolean => {
    const gx = hasGlobChars(x);
    const gy = hasGlobChars(y);
    if (!gx && !gy) return x === y;
    if (gx && gy) {
      // Both globbed: overlap unless their literal prefixes or suffixes already disagree.
      const pre = (g: string): string => g.slice(0, g.search(/[*?[]/));
      const suf = (g: string): string => {
        let k = g.length;
        while (k > 0 && !"*?]".includes(g[k - 1]!)) k--;
        return g.slice(k);
      };
      const px = pre(x), py = pre(y), sx = suf(x), sy = suf(y);
      if ((px.startsWith(".") && py === "") || (py.startsWith(".") && px === "")) return false;
      return (px.startsWith(py) || py.startsWith(px)) && (sx.endsWith(sy) || sy.endsWith(sx));
    }
    const [glob, lit] = gx ? [x, y] : [y, x];
    if (lit.startsWith(".") && !glob.startsWith(".")) return false;
    return matchApprovalGlob(glob, lit);
  };
  const walk = (i: number, j: number): boolean => {
    const key = i * width + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === as.length && j === bs.length) r = true;
    else if (i < as.length && as[i] === "**") r = walk(i + 1, j) || (j < bs.length && walk(i, j + 1));
    else if (j < bs.length && bs[j] === "**") r = walk(i, j + 1) || (i < as.length && walk(i + 1, j));
    else if (i === as.length || j === bs.length) r = false;
    else r = segOk(as[i]!, bs[j]!) && walk(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return walk(0, 0);
}

/** True when `segment` contains an unescaped glob metacharacter. */
export function hasGlobChars(segment: string): boolean {
  for (const ch of segment) {
    if (ch === "*" || ch === "?" || ch === "[") return true;
  }
  return false;
}
