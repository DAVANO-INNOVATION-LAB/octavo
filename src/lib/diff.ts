/**
 * Line diff for change requests.
 *
 * Page content is block JSON, which diffs badly — a reader cannot see what
 * changed in a wall of braces and regenerated ids. Both sides are rendered to
 * Markdown first and compared as prose, so the diff shows the writing rather
 * than the storage.
 *
 * Zero dependencies, in keeping with the rest of the library.
 */

export type Row =
  | { kind: "same"; a: string; b: string; aNo: number; bNo: number }
  | { kind: "del"; a: string; aNo: number }
  | { kind: "add"; b: string; bNo: number };

/**
 * Above this many lines on either side the quadratic table stops being
 * reasonable, and the diff degrades to whole-document replacement rather
 * than hanging the request. A page that long is not being reviewed line by
 * line anyway.
 */
const MAX_LINES = 3000;

/** Longest common subsequence over lines, after trimming shared ends. */
export function diffLines(aText: string, bText: string): Row[] {
  const a = aText.split("\n");
  const b = bText.split("\n");

  // Identical documents produce no work at all.
  if (aText === bText) {
    return a.map((line, i) => ({
      kind: "same" as const,
      a: line,
      b: line,
      aNo: i + 1,
      bNo: i + 1,
    }));
  }

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((line, i) => ({ kind: "del" as const, a: line, aNo: i + 1 })),
      ...b.map((line, i) => ({ kind: "add" as const, b: line, bNo: i + 1 })),
    ];
  }

  // Shared prefix and suffix are the bulk of most edits; excluding them keeps
  // the table small enough that the simple algorithm stays fast.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  // lcs[i][j] = length of the longest common subsequence of midA[i:], midB[j:]
  const lcs: number[][] = Array.from({ length: midA.length + 1 }, () =>
    new Array<number>(midB.length + 1).fill(0)
  );
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i][j] =
        midA[i] === midB[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: Row[] = [];
  for (let k = 0; k < head; k++) {
    rows.push({ kind: "same", a: a[k], b: b[k], aNo: k + 1, bNo: k + 1 });
  }

  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      rows.push({
        kind: "same",
        a: midA[i],
        b: midB[j],
        aNo: head + i + 1,
        bNo: head + j + 1,
      });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: "del", a: midA[i], aNo: head + i + 1 });
      i++;
    } else {
      rows.push({ kind: "add", b: midB[j], bNo: head + j + 1 });
      j++;
    }
  }
  while (i < midA.length) {
    rows.push({ kind: "del", a: midA[i], aNo: head + i + 1 });
    i++;
  }
  while (j < midB.length) {
    rows.push({ kind: "add", b: midB[j], bNo: head + j + 1 });
    j++;
  }

  for (let k = 0; k < tail; k++) {
    const ai = a.length - tail + k;
    const bi = b.length - tail + k;
    rows.push({ kind: "same", a: a[ai], b: b[bi], aNo: ai + 1, bNo: bi + 1 });
  }

  return rows;
}

export type DiffStat = { added: number; removed: number };

export function diffStat(rows: Row[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Drop long stretches of unchanged text, keeping a few lines of context
 * around each change. A reviewer wants the edit, not the whole document.
 * Returns groups so the view can print a gap marker between them.
 */
export function collapseUnchanged(rows: Row[], context = 3): Row[][] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });
  const groups: Row[][] = [];
  let current: Row[] = [];
  rows.forEach((r, i) => {
    if (keep[i]) {
      current.push(r);
    } else if (current.length) {
      groups.push(current);
      current = [];
    }
  });
  if (current.length) groups.push(current);
  return groups;
}
