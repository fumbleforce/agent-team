// A line diff between two revisions of a page, written the way git writes one so the same view can show it.
// Revisions are whole texts, so the diff is computed here on read; nothing about it is stored.
type Op = { sign: ' ' | '-' | '+'; text: string };
const CONTEXT = 3;
// Above this many cell comparisons the changed middle is shown as removed then added, rather than aligned line by line.
const LCS_BUDGET = 4_000_000;
const NEWLINE = String.fromCharCode(10);

function operations(before: string[], after: string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const middle: Op[] = [];
  if (a.length * b.length > LCS_BUDGET) middle.push(...a.map(text => ({ sign: '-' as const, text })), ...b.map(text => ({ sign: '+' as const, text })));
  else {
    // Longest common subsequence, filled from the end so the walk forward reads removals before additions.
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { middle.push({ sign: ' ', text: a[i]! }); i++; j++; }
      else if (i < a.length && (j >= b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) middle.push({ sign: '-', text: a[i++]! });
      else middle.push({ sign: '+', text: b[j++]! });
    }
  }
  return [...before.slice(0, head).map(text => ({ sign: ' ' as const, text })), ...middle, ...after.slice(after.length - tail).map(text => ({ sign: ' ' as const, text }))];
}

export function lineDiff(path: string, before: string, after: string): { text: string; added: number; removed: number } {
  const ops = operations(before.split(NEWLINE), after.split(NEWLINE));
  const changed = ops.flatMap((op, index) => (op.sign === ' ' ? [] : [index]));
  if (changed.length === 0) return { text: '', added: 0, removed: 0 };
  // Changes closer than two contexts apart share a hunk.
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last && index - last[1] <= CONTEXT * 2) last[1] = index; else hunks.push([index, index]);
  }
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const [first, last] of hunks) {
    const from = Math.max(0, first - CONTEXT), to = Math.min(ops.length - 1, last + CONTEXT), part = ops.slice(from, to + 1);
    const beforeStart = ops.slice(0, from).filter(op => op.sign !== '+').length + 1, afterStart = ops.slice(0, from).filter(op => op.sign !== '-').length + 1;
    lines.push(`@@ -${beforeStart},${part.filter(op => op.sign !== '+').length} +${afterStart},${part.filter(op => op.sign !== '-').length} @@`, ...part.map(op => `${op.sign}${op.text}`));
  }
  return { text: lines.join(NEWLINE), added: ops.filter(op => op.sign === '+').length, removed: ops.filter(op => op.sign === '-').length };
}
