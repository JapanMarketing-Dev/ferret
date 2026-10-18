import type { Canvas, Caption, Rational } from '@video/core';
import { assDialogue, assEscape, assHeader, assStyleLine, assTagColor, frameToSeconds } from '@video/core';
import type { CaptionStyle } from './styles.js';

interface Run {
  text: string;
  /** Karaoke duration (centiseconds) for this run, when karaoke applies. */
  k?: number;
  emphasis?: 'color' | 'scale' | 'box';
}

const ALIGN = { bottom: 2, center: 5, top: 8 } as const;

function compact(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Character → word index over the caption's lines (spaces excluded), or null when the words do not match the text. */
function wordIndexByChar(c: Caption): number[] | null {
  const linesText = compact(c.lines.join(''));
  const wordsText = compact(c.words.map((w) => w.text).join(''));
  if (c.words.length === 0 || linesText !== wordsText) return null;
  const out: number[] = [];
  c.words.forEach((w, i) => {
    for (const _ of compact(w.text)) out.push(i);
  });
  return out;
}

/** Emphasis style per non-space char of a line. */
function emphasisMarks(line: string, c: Caption): (Run['emphasis'] | undefined)[] {
  const chars = [...line];
  const marks: (Run['emphasis'] | undefined)[] = chars.map(() => undefined);
  for (const e of c.emphasis) {
    if (!e.word) continue;
    const target = [...e.word];
    for (let i = 0; i + target.length <= chars.length; i++) {
      if (target.every((ch, k) => chars[i + k] === ch)) for (let k = 0; k < target.length; k++) marks[i + k] = e.style;
    }
  }
  return marks;
}

/** Build runs for each line: split where the word (karaoke) or the emphasis changes. */
function lineRuns(c: Caption, fps: Rational, karaoke: boolean): Run[][] {
  const lines = c.lines.length ? c.lines : [c.text];
  const byChar = karaoke ? wordIndexByChar(c) : null;
  // Word karaoke spans in centiseconds from the caption start: word i lasts until word i+1 starts.
  const cs = (f: number) => Math.round(frameToSeconds(f - c.range.start, fps) * 100);
  const spans = byChar
    ? c.words.map((w, i) => {
        const a = i === 0 ? 0 : cs(w.start);
        const b = i + 1 < c.words.length ? cs(c.words[i + 1]!.start) : cs(w.end);
        return { a, b: Math.max(a, b) };
      })
    : [];
  const wordChars = byChar ? c.words.map((w) => [...compact(w.text)].length) : [];
  const usedChars = new Array<number>(wordChars.length).fill(0);
  const usedCs = new Array<number>(wordChars.length).fill(0);
  let ci = 0; // index into byChar (non-space chars)
  return lines.map((line) => {
    const chars = [...line];
    const marks = emphasisMarks(line, c);
    const runs: Run[] = [];
    let cur: Run | null = null;
    let curWord = -2;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const space = /\s/.test(ch);
      const word = byChar && !space ? byChar[ci] ?? -1 : curWord;
      const emph = marks[i];
      if (!cur || (!space && (word !== curWord || emph !== cur.emphasis))) {
        cur = { text: '' };
        if (emph) cur.emphasis = emph;
        runs.push(cur);
        curWord = word;
        if (byChar && word >= 0) cur.k = 0;
      }
      cur.text += ch;
      if (byChar && !space && word >= 0) {
        // give this char its share of the word's duration (last char takes the remainder)
        usedChars[word]! += 1;
        const span = spans[word]!;
        const total = span.b - span.a;
        const upTo = usedChars[word] === wordChars[word] ? total : Math.round((total * usedChars[word]!) / wordChars[word]!);
        cur.k = (cur.k ?? 0) + (upTo - usedCs[word]!);
        usedCs[word] = upTo;
        ci++;
      }
    }
    return runs;
  });
}

function renderRun(r: Run, s: CaptionStyle, sizePx: number): string {
  const open: string[] = [];
  const close: string[] = [];
  if (r.k !== undefined) open.push(`\\k${Math.max(0, r.k)}`);
  if (r.emphasis === 'color') {
    open.push(`\\1c${assTagColor(s.emphasis.color)}\\2c${assTagColor(s.emphasis.color)}`);
    close.push(`\\1c${assTagColor(s.karaoke ? s.highlight : s.color)}\\2c${assTagColor(s.color)}`);
  } else if (r.emphasis === 'scale') {
    const pct = Math.round(s.emphasis.scale * 100);
    open.push(`\\fscx${pct}\\fscy${pct}`);
    close.push('\\fscx100\\fscy100');
  } else if (r.emphasis === 'box') {
    open.push(`\\3c${assTagColor(s.emphasis.box)}\\bord${(sizePx * s.outlineWidth * 1.8).toFixed(1)}`);
    close.push(`\\3c${assTagColor(s.outline)}\\bord${(sizePx * s.outlineWidth).toFixed(1)}`);
  }
  const text = assEscape(r.text);
  return `${open.length ? `{${open.join('')}}` : ''}${text}${close.length ? `{${close.join('')}}` : ''}`;
}

/**
 * ASS subtitles for captions. Text is escaped; each caption is positioned by its anchor and `position.y`;
 * with a karaoke style, words light up with \k at their spoken times; emphasis words get color / scale / box.
 */
export function toAss(captions: Caption[], style: CaptionStyle, canvas: Canvas, fps: Rational): string {
  const short = Math.min(canvas.width, canvas.height);
  const sizePx = style.size * short;
  const styleLine = assStyleLine({
    name: 'Caption',
    font: style.font,
    size: sizePx,
    primary: style.karaoke ? style.highlight : style.color,
    secondary: style.color,
    outline: style.box ?? style.outline,
    back: style.box ?? '#00000080',
    bold: style.bold,
    borderStyle: style.box ? 3 : 1,
    outlineWidth: sizePx * style.outlineWidth,
    shadow: sizePx * style.shadow,
    alignment: 2,
    marginL: Math.round(canvas.width * 0.05),
    marginR: Math.round(canvas.width * 0.05),
    spacing: ((style.spacing ?? 0) * short) / 1080,
  });
  const events: string[] = [];
  const sorted = [...captions].sort((a, b) => a.range.start - b.range.start);
  for (const c of sorted) {
    if (c.range.end <= c.range.start) continue;
    if ((c.lines.length ? c.lines.join('') : c.text).trim() === '') continue;
    const align = ALIGN[c.position.anchor];
    const x = Math.round(canvas.width / 2);
    const y = Math.round(c.position.y * canvas.height);
    const runs = lineRuns(c, fps, style.karaoke);
    const body = runs.map((line) => line.map((r) => renderRun(r, style, sizePx)).join('')).join('\\N');
    const weight = style.weight ? `\\b${style.weight}` : '';
    events.push(assDialogue(0, c.range.start, c.range.end, fps, 'Caption', `{\\an${align}\\pos(${x},${y})${weight}}${body}`));
  }
  return `${assHeader(canvas, [styleLine])}\n${events.join('\n')}\n`;
}

function srtTime(frame: number, fps: Rational): string {
  const msTotal = Math.round(frameToSeconds(frame, fps) * 1000);
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor(msTotal / 60000) % 60;
  const s = Math.floor(msTotal / 1000) % 60;
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** SubRip text. Captions are sorted; empty ones are skipped; numbering starts at 1. */
export function toSrt(captions: Caption[], fps: Rational): string {
  const out: string[] = [];
  let n = 0;
  for (const c of [...captions].sort((a, b) => a.range.start - b.range.start)) {
    const lines = (c.lines.length ? c.lines : [c.text]).map((l) => l.replace(/\r/g, '').replace(/\n+/g, ' ').trim()).filter((l) => l !== '');
    if (lines.length === 0 || c.range.end <= c.range.start) continue;
    n++;
    // A blank line would end the cue early; lines are never blank here. "-->" inside text is harmless but confusing.
    out.push(`${n}\n${srtTime(c.range.start, fps)} --> ${srtTime(c.range.end, fps)}\n${lines.map((l) => l.split('-->').join('->')).join('\n')}\n`);
  }
  return out.join('\n');
}
