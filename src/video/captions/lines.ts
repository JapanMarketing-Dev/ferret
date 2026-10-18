import { loadDefaultJapaneseParser } from 'budoux';

type Parser = ReturnType<typeof loadDefaultJapaneseParser>;
let parser: Parser | null = null;

/** Display length used for line limits (code points). */
export function charLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** BudouX phrases (Japanese). Concatenating them gives back the input. */
export function phrases(text: string): string[] {
  if (text === '') return [];
  parser ??= loadDefaultJapaneseParser();
  return parser.parse(text);
}

function hardSplit(s: string, max: number): string[] {
  const chars = [...s];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  return out;
}

/**
 * Character ranges [start, end) of glossary terms in `text` (case-insensitive, longest term first, no overlaps).
 * Terms are atomic: nothing may break inside them.
 */
export function glossaryRanges(text: string, glossary: readonly string[] = []): [number, number][] {
  const lower = text.toLowerCase();
  const taken: [number, number][] = [];
  const terms = [...new Set(glossary.map((g) => g.trim()).filter((g) => g !== ''))].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const t = term.toLowerCase();
    for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + 1)) {
      const r: [number, number] = [at, at + t.length];
      if (!taken.some(([s, e]) => r[0] < e && s < r[1])) taken.push(r);
    }
  }
  return taken.sort((a, b) => a[0] - b[0]);
}

/**
 * Atoms that lines may break between: BudouX phrases (ja) or space-separated words (en). Over-long atoms are split,
 * except across a glossary term: atoms overlapping a term are merged and kept whole (a line may overflow then).
 */
export function breakAtoms(text: string, language: 'ja' | 'en', maxChars: number, glossary: readonly string[] = []): string[] {
  let raw = language === 'ja' ? phrases(text) : text.split(/(?<=\s)/).filter((w) => w !== '');
  const ranges = glossaryRanges(text, glossary);
  const isProtected = new Set<number>();
  if (ranges.length) {
    const merged: string[] = [];
    let at = 0;
    for (const a of raw) {
      const inside = ranges.some(([s, e]) => at > s && at < e); // boundary before `a` falls inside a term
      if (inside && merged.length) merged[merged.length - 1] += a;
      else merged.push(a);
      at += a.length;
    }
    raw = merged;
    at = 0;
    raw.forEach((a, i) => {
      if (ranges.some(([s, e]) => s < at + a.length && at < e)) isProtected.add(i);
      at += a.length;
    });
  }
  const atoms: string[] = [];
  raw.forEach((a, i) => {
    if (charLen(a.trimEnd()) > maxChars && !isProtected.has(i)) atoms.push(...hardSplit(a, maxChars));
    else atoms.push(a);
  });
  return atoms;
}

/**
 * Break text into lines of at most `maxChars` without splitting a phrase (unless the phrase itself is longer than a
 * line) or a glossary term (never; a term longer than a line gets a line of its own). Uses the fewest lines
 * possible, then balances their lengths.
 */
export function layoutLines(text: string, maxChars: number, language: 'ja' | 'en', glossary: readonly string[] = []): string[] {
  if (!(maxChars >= 1)) throw new RangeError('maxChars must be >= 1');
  const t = text.trim();
  if (t === '') return [];
  const atoms = breakAtoms(t, language, maxChars, glossary);
  const n = atoms.length;
  const len = (i: number, j: number) => charLen(atoms.slice(i, j).join('').trim());
  // Fewest lines: greedy is optimal for line count.
  let count = 0;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && len(i, j + 1) <= maxChars) j++;
    count++;
    i = j;
  }
  // DP: split into exactly `count` lines minimizing the sum of squared slack (balanced lines).
  const INF = Number.POSITIVE_INFINITY;
  const cost: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(INF));
  const back: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
  cost[0]![0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const l = len(i, j);
        if (l > maxChars && i < j - 1) break; // a single over-long atom (a glossary term) stands alone on its line
        const prev = cost[k - 1]![i]!;
        if (prev === INF) continue;
        const c = prev + Math.max(0, maxChars - l) ** 2;
        if (c < cost[k]![j]!) {
          cost[k]![j] = c;
          back[k]![j] = i;
        }
      }
    }
  }
  if (cost[count]![n] === INF) {
    // Should not happen (atoms ≤ maxChars), fall back to greedy.
    return hardSplit(t, maxChars);
  }
  const lines: string[] = [];
  for (let k = count, j = n; k > 0; k--) {
    const i = back[k]![j]!;
    lines.unshift(atoms.slice(i, j).join('').trim());
    j = i;
  }
  return lines;
}
