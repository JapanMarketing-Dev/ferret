import { endsSentence } from './build.js';
import type { Word } from './whisper.js';

/** Default filler words per language (candidates; the decision model / template decides what to cut). */
export const DEFAULT_FILLERS: Record<'ja' | 'en', string[]> = {
  ja: ['えー', 'ええと', 'えっと', 'えーっと', 'えーと', 'あのー', 'あの〜', 'まあ', 'その', 'うーん', 'んー', 'あー'],
  en: ['um', 'uh', 'erm', 'uhm', 'hmm', 'like', 'you know'],
};

/** Normalize for matching: NFKC, lowercase, drop punctuation/space, "〜"/"～" → "ー", collapse repeated "ー". */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[〜~]/g, 'ー')
    .replace(/[\s\p{P}\p{S}]/gu, '') // "ー" is a letter (Lm), so it stays
    .replace(/ー{2,}/g, 'ー');
}

/**
 * Filler occurrences: a word, or up to 4 consecutive words joined, that equals a filler after normalization.
 * Longer matches win; matches do not overlap. Times in seconds.
 */
export function findFillers(words: Word[], fillers: string[]): { start: number; end: number; text: string }[] {
  const targets = new Set(fillers.map(normalizeForMatch).filter((f) => f !== ''));
  if (targets.size === 0) return [];
  const norm = words.map((w) => normalizeForMatch(w.w));
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < words.length; ) {
    let matched = 0;
    for (let n = Math.min(4, words.length - i); n >= 1; n--) {
      const joined = norm.slice(i, i + n).join('');
      if (joined !== '' && targets.has(joined)) {
        matched = n;
        break;
      }
    }
    if (matched) {
      const ws = words.slice(i, i + matched);
      out.push({ start: ws[0]!.start, end: ws[ws.length - 1]!.end, text: ws.map((w) => w.w).join(/[a-z]/i.test(ws[0]!.w) ? ' ' : '') });
      i += matched;
    } else i++;
  }
  return out;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const chars = [...s];
  for (let i = 0; i + 1 < chars.length; i++) {
    const b = chars[i]! + chars[i + 1]!;
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of character bigrams (0..1). */
export function dice(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let na = 0;
  let nb = 0;
  let both = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) both += Math.min(v, B.get(k) ?? 0);
  return na + nb === 0 ? 0 : (2 * both) / (na + nb);
}

interface Sentence { start: number; end: number; text: string; norm: string }

/** Split words into sentences at sentence-final punctuation or pauses longer than `pauseSec`. */
export function sentences(words: Word[], pauseSec = 0.7): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.w).join(/[a-z]/i.test(cur[0]!.w) ? ' ' : '');
    out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text, norm: normalizeForMatch(text) });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > pauseSec) flush();
    cur.push(w);
    const next = words[i + 1]?.w;
    if (endsSentence(w.w, next, /[a-z]/i.test(cur[0]!.w) ? 'en' : 'ja')) flush();
  });
  flush();
  return out;
}

/**
 * Retakes: a sentence followed (within `windowSec`) by a similar one — the speaker said it again. The first attempt is
 * often cut short, so it is also compared with the start of the second. Times in seconds.
 */
export function findRetakes(words: Word[], o: { windowSec?: number; similarity?: number } = {}): { first: [number, number]; second: [number, number]; score: number }[] {
  const windowSec = o.windowSec ?? 20;
  const threshold = o.similarity ?? 0.6;
  const ss = sentences(words);
  const out: { first: [number, number]; second: [number, number]; score: number }[] = [];
  for (let i = 0; i < ss.length; i++) {
    const a = ss[i]!;
    if ([...a.norm].length < 4) continue;
    let best: { j: number; score: number } | null = null;
    for (let j = i + 1; j < ss.length && j <= i + 2; j++) {
      const b = ss[j]!;
      if (b.start - a.end > windowSec) break;
      if ([...b.norm].length < 4) continue;
      const bChars = [...b.norm];
      const aLen = [...a.norm].length;
      const prefix = bChars.slice(0, Math.min(bChars.length, Math.ceil(aLen * 1.15))).join('');
      const score = Math.max(dice(a.norm, b.norm), aLen < bChars.length ? dice(a.norm, prefix) : 0);
      if (score >= threshold && (!best || score > best.score)) best = { j, score };
    }
    if (best) {
      const b = ss[best.j]!;
      out.push({ first: [a.start, a.end], second: [b.start, b.end], score: Math.round(best.score * 1000) / 1000 });
    }
  }
  return out;
}
