/**
 * Small unified line diff for proposal previews. Computed by code from the
 * current file and the proposed text; the model never supplies a diff.
 */

const MAX_CELLS = 4_000_000;

/** Unified-style diff (`-`, `+`, ` ` prefixes) with `context` lines around changes. */
export function unifiedLineDiff(before: string, after: string, context = 2): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return `(file too large to diff: ${a.length} lines before, ${b.length} lines after)`;
  }
  // LCS table, bottom-up.
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: " ", line: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ op: "-", line: a[i]! }); i++; }
    else { ops.push({ op: "+", line: b[j]! }); j++; }
  }
  while (i < n) ops.push({ op: "-", line: a[i++]! });
  while (j < m) ops.push({ op: "+", line: b[j++]! });

  if (!ops.some((o) => o.op !== " ")) return "(no changes)";
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.op === " ") return;
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { skipped = true; return; }
    if (skipped) { out.push("@@"); skipped = false; }
    out.push(`${o.op}${o.line}`);
  });
  return out.join("\n");
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of unifiedLineDiff(before, after, 0).split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
