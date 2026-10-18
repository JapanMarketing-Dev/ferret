import type { Caption, Decided, Frame, Rational } from '@video/core';
import { secondsToFrame } from '@video/core';
import { glossaryRanges, layoutLines, phrases } from './lines.js';
import { pickEmphasis } from './emphasis.js';
import { CAPTION_STYLES } from './styles.js';
import type { Word } from './whisper.js';

export interface BuildOptions {
  fps: Rational;
  maxCharsPerLine: number;
  maxLines: number;
  language: 'ja' | 'en';
  /** A pause longer than this starts a new caption (default 600 ms). */
  minGapMs?: number;
  style: string;
  /** Map a take time (seconds) to a timeline frame; null = cut (the word is dropped). Default: seconds → frames. */
  mapTime?: (sec: number) => Frame | null;
  /** Minimum caption duration in frames when the next caption leaves room (default 0.6 s). */
  minFrames?: number;
  /** Id prefix (default "cap_"). Ids are `${prefix}${n}` with a 4-digit counter. */
  idPrefix?: string;
  decided?: Decided;
  /** Terms never split across captions or lines ("Claude Code", "CLAUDE.md"); matched case-insensitively. */
  glossary?: string[];
  /** A caption never spans more than this from its first to its last word (ms); longer ones are split between words. */
  maxDurationMs?: number;
  /** Timeline length: captions never run past it (the minimum duration is cut short at the end). */
  endFrame?: Frame;
  /** Color 1–2 key terms per caption (pickEmphasis). */
  emphasis?: { auto: boolean; max?: number };
}

interface MWord { w: string; start: number; end: number; s: Frame; e: Frame; i: number }

const SENTENCE_END = /[。．！？!?.…]$/u;
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|ca|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|Fig|Vol|Inc|Ltd|Co)\.$/i;

/**
 * Does `prev` end a sentence before `next`? Sentence punctuation does, except an ASCII period that is part of a
 * token: followed directly by a letter/digit (file names "CLAUDE.md", domains, versions "2.1.296"; in English only a
 * lowercase letter/digit, since words are space-separated there) or closing a known abbreviation ("e.g.").
 */
export function endsSentence(prev: string, next: string | undefined, language: 'ja' | 'en'): boolean {
  if (!SENTENCE_END.test(prev)) return false;
  if (!prev.endsWith('.') || prev.endsWith('..')) return true;
  if (ABBREVIATION.test(prev)) return false;
  if (next === undefined) return true;
  return !(language === 'ja' ? /^[A-Za-z0-9]/ : /^[a-z0-9]/).test(next);
}

const JA_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;
const JA_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const LATIN_END = /[A-Za-z0-9]$/;
const LATIN_START = /^[A-Za-z0-9]/;

/** Join words: spaces in English; in Japanese only between two Latin/digit words ("Claude Code"). Also returns each word's end offset. */
function joinWithEnds(words: { w: string }[], language: 'ja' | 'en'): { text: string; ends: number[] } {
  let text = '';
  const ends: number[] = [];
  for (const w of words) {
    if (text !== '' && (language === 'en' || (LATIN_END.test(text) && LATIN_START.test(w.w)))) text += ' ';
    text += w.w;
    ends.push(text.length);
  }
  return { text, ends };
}

function joinWords(words: { w: string }[], language: 'ja' | 'en'): string {
  return joinWithEnds(words, language).text;
}

/** Split a sentence group into units that end on both a word boundary and a phrase boundary (ja), or words (en). */
function units(words: MWord[], language: 'ja' | 'en'): MWord[][] {
  if (language === 'en') return words.map((w) => [w]);
  const { text, ends } = joinWithEnds(words, 'ja');
  const bounds = new Set<number>();
  let at = 0;
  for (const p of phrases(text)) {
    at += p.length;
    bounds.add(at);
    // a phrase ending right before a joining space also ends at the word
    if (text[at] === ' ') bounds.add(at + 1);
  }
  const out: MWord[][] = [];
  let cur: MWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (bounds.has(ends[i]!) || (text[ends[i]!] === ' ' && bounds.has(ends[i]! + 1))) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Build captions from words: sentence groups → phrase-aligned units → captions of at most maxLines lines. */
export function buildCaptions(words: Word[], o: BuildOptions): Caption[] {
  if (!(o.maxCharsPerLine >= 1)) throw new RangeError('maxCharsPerLine must be >= 1');
  if (!(o.maxLines >= 1)) throw new RangeError('maxLines must be >= 1');
  const fpsN = o.fps.num / o.fps.den;
  const map = o.mapTime ?? ((sec: number) => secondsToFrame(sec, o.fps));
  const gap = (o.minGapMs ?? 600) / 1000;
  const decided: Decided = o.decided ?? { by: 'rule', reason: 'built from the transcript' };
  const position = CAPTION_STYLES[o.style]?.position ?? { anchor: 'bottom' as const, y: 0.85 };

  // 1. map to frames, drop cut words
  const mapped: MWord[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const text = w.w.trim();
    if (text === '') continue;
    const s = map(w.start);
    if (s === null) continue;
    let e = map(w.end);
    if (e === null || e < s) e = s + Math.max(1, Math.round((w.end - w.start) * fpsN));
    mapped.push({ w: text, start: w.start, end: w.end, s, e: Math.max(e, s + 1), i: mapped.length });
  }
  // glued[i]: no break allowed after word i (inside a glossary term)
  const glued: boolean[] = new Array<boolean>(mapped.length).fill(false);
  if (o.glossary?.length) {
    const { text, ends } = joinWithEnds(mapped, o.language);
    const ranges = glossaryRanges(text, o.glossary);
    ends.forEach((end, i) => {
      if (ranges.some(([s, e]) => end > s && end < e)) glued[i] = true;
    });
  }

  // 2. sentence groups
  const groups: MWord[][] = [];
  let cur: MWord[] = [];
  for (const w of mapped) {
    const prev = cur[cur.length - 1];
    // whisper can split a word ("設|定") around a pause; a pause inside one phrase does not start a new caption
    const inPhrase = !!prev && o.language === 'ja' && JA_END.test(prev.w) && JA_START.test(w.w) && phrases(prev.w + w.w).length === 1;
    if (prev && !glued[prev.i] && ((w.start - prev.end > gap && !inPhrase) || w.s < prev.s || endsSentence(prev.w, w.w, o.language))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  // 3. pack units into captions
  const glossary = o.glossary ?? [];
  const maxSpan = o.maxDurationMs ? Math.max(1, Math.round((o.maxDurationMs / 1000) * fpsN)) : Number.POSITIVE_INFINITY;
  const fits = (ws: MWord[]) => (ws.length <= 1 || ws[ws.length - 1]!.e - ws[0]!.s <= maxSpan)
    && layoutLines(joinWords(ws, o.language), o.maxCharsPerLine, o.language, glossary).length <= o.maxLines;
  // units never end inside a glossary term
  const atomic = (us: MWord[][]): MWord[][] => {
    const out: MWord[][] = [];
    for (const u of us) {
      const last = out[out.length - 1];
      if (last && glued[last[last.length - 1]!.i]) last.push(...u);
      else out.push([...u]);
    }
    return out;
  };
  const chunks: MWord[][] = [];
  for (const g of groups) {
    let acc: MWord[] = [];
    const push = (u: MWord[]) => {
      if (fits([...acc, ...u])) {
        acc.push(...u);
        return;
      }
      if (acc.length) chunks.push(acc);
      acc = [];
      if (fits(u) || u.length === 1) {
        acc = [...u];
        return;
      }
      // a unit too long on its own: fall back to single words (glossary terms stay together)
      const pieces = atomic(u.map((w) => [w]));
      if (pieces.length === 1) {
        acc = [...u];
        return;
      }
      for (const piece of pieces) push(piece);
    };
    for (const u of atomic(units(g, o.language))) push(u);
    if (acc.length) chunks.push(acc);
  }

  // 4. captions
  const prefix = o.idPrefix ?? 'cap_';
  const caps: Caption[] = chunks.map((ws, i) => {
    const text = joinWords(ws, o.language);
    return {
      id: `${prefix}${String(i + 1).padStart(4, '0')}`,
      range: { start: ws[0]!.s, end: Math.max(...ws.map((w) => w.e)) },
      text,
      spoken: text,
      words: ws.map((w) => ({ text: w.w, start: w.s, end: w.e })),
      lines: layoutLines(text, o.maxCharsPerLine, o.language, glossary),
      emphasis: o.emphasis?.auto
        ? pickEmphasis(text, { language: o.language, glossary, ...(o.emphasis.max !== undefined ? { max: o.emphasis.max } : {}) }).map((word) => ({ word, style: 'color' as const }))
        : [],
      style: o.style,
      position: { ...position },
      decided: { ...decided },
    };
  });

  // 5. timing: no overlaps, bridge short gaps, minimum duration where there is room
  const bridge = Math.round(fpsN * 0.25);
  const minFrames = o.minFrames ?? Math.round(fpsN * 0.6);
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i]!;
    const next = caps[i + 1];
    if (c.range.end - c.range.start < minFrames) c.range.end = c.range.start + minFrames;
    if (next) {
      if (next.range.start - c.range.end <= bridge) c.range.end = next.range.start;
      if (c.range.end > next.range.start) c.range.end = Math.max(c.range.start + 1, next.range.start);
      if (c.range.end > next.range.start) {
        // two captions start on the same frame: push the next one
        next.range.start = c.range.end;
        next.range.end = Math.max(next.range.end, next.range.start + 1);
      }
    }
    if (o.endFrame !== undefined && c.range.end > o.endFrame) c.range.end = o.endFrame;
    for (const w of c.words) {
      w.start = Math.min(Math.max(w.start, c.range.start), c.range.end);
      w.end = Math.min(Math.max(w.end, w.start), c.range.end);
    }
  }
  return o.endFrame === undefined ? caps : caps.filter((c) => c.range.start < o.endFrame! && c.range.end > c.range.start);
}

