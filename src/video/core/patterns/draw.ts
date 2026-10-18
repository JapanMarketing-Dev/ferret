import { loadDefaultJapaneseParser } from 'budoux';
// ASS vector-drawing helpers for scene patterns. Coordinates are canvas pixels (PlayRes = canvas size).
import { assColor, assEscape, assTagColor } from '../ass.js';

const r1 = (n: number) => String(Math.round(n));

export function rectPath(x: number, y: number, w: number, h: number): string {
  return `m ${r1(x)} ${r1(y)} l ${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + h)} ${r1(x)} ${r1(y + h)}`;
}

/** Rounded rectangle (clockwise) with cubic corners. */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = rr * 0.5523;
  const [x2, y2] = [x + w, y + h];
  return [
    `m ${r1(x + rr)} ${r1(y)}`,
    `l ${r1(x2 - rr)} ${r1(y)}`, `b ${r1(x2 - rr + k)} ${r1(y)} ${r1(x2)} ${r1(y + rr - k)} ${r1(x2)} ${r1(y + rr)}`,
    `l ${r1(x2)} ${r1(y2 - rr)}`, `b ${r1(x2)} ${r1(y2 - rr + k)} ${r1(x2 - rr + k)} ${r1(y2)} ${r1(x2 - rr)} ${r1(y2)}`,
    `l ${r1(x + rr)} ${r1(y2)}`, `b ${r1(x + rr - k)} ${r1(y2)} ${r1(x)} ${r1(y2 - rr + k)} ${r1(x)} ${r1(y2 - rr)}`,
    `l ${r1(x)} ${r1(y + rr)}`, `b ${r1(x)} ${r1(y + rr - k)} ${r1(x + rr - k)} ${r1(y)} ${r1(x + rr)} ${r1(y)}`,
  ].join(' ');
}

export function circlePath(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  return [
    `m ${r1(cx + r)} ${r1(cy)}`,
    `b ${r1(cx + r)} ${r1(cy + k)} ${r1(cx + k)} ${r1(cy + r)} ${r1(cx)} ${r1(cy + r)}`,
    `b ${r1(cx - k)} ${r1(cy + r)} ${r1(cx - r)} ${r1(cy + k)} ${r1(cx - r)} ${r1(cy)}`,
    `b ${r1(cx - r)} ${r1(cy - k)} ${r1(cx - k)} ${r1(cy - r)} ${r1(cx)} ${r1(cy - r)}`,
    `b ${r1(cx + k)} ${r1(cy - r)} ${r1(cx + r)} ${r1(cy - k)} ${r1(cx + r)} ${r1(cy)}`,
  ].join(' ');
}

export function polygonPath(points: [number, number][]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  return `m ${r1(first[0])} ${r1(first[1])} l ${rest.map(([x, y]) => `${r1(x)} ${r1(y)}`).join(' ')}`;
}

/** A sine-shaped band across the width: top edge y0 + A·sin(2πx/λ + φ), `thickness` tall. */
export function waveBandPath(width: number, y0: number, amp: number, wavelength: number, phase: number, thickness: number, steps = 48): string {
  const top: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (width * i) / steps;
    top.push([x, y0 + amp * Math.sin((2 * Math.PI * x) / wavelength + phase)]);
  }
  const bottom = top.map(([x, y]) => [x, y + thickness] as [number, number]).reverse();
  return polygonPath([...top, ...bottom]);
}

/** Linear interpolation between two #RRGGBB colors. */
export function mixColor(a: string, b: string, t: number): string {
  const pa = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(a);
  const pb = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(b);
  if (!pa || !pb) throw new Error(`invalid color: ${a} / ${b}`);
  const c = [1, 2, 3].map((i) => Math.round(parseInt(pa[i]!, 16) * (1 - t) + parseInt(pb[i]!, 16) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Override tags for a filled drawing with color (#RRGGBB or #RRGGBBAA). */
export function fillTags(color: string): string {
  const alpha = assColor(color).slice(2, 4);
  return `\\1c${assTagColor(color)}\\1a&H${alpha}&\\bord0\\shad0`;
}

/** Override tags for an outline-only drawing (transparent fill, border = stroke). */
export function strokeTags(color: string, width: number): string {
  const alpha = assColor(color).slice(2, 4);
  return `\\1a&HFF&\\3c${assTagColor(color)}\\3a&H${alpha}&\\bord${(Math.round(width * 10) / 10).toString()}\\shad0`;
}

/** Drawing event body: absolute coordinates via \an7\pos(0,0). */
export function drawing(tags: string, path: string): string {
  return `{\\an7\\pos(0,0)${tags}\\p1}${path}{\\p0}`;
}

/**
 * Drawing whose bounding box is centred at (cx, cy) (\an5), so \fscx/\fscy scale around its centre. libass anchors
 * drawings from the path origin, so `path` must use non-negative coordinates starting at (0, 0).
 */
export function drawingAt(cx: number, cy: number, tags: string, path: string): string {
  return `{\\an5\\pos(${r1(cx)},${r1(cy)})${tags}\\p1}${path}{\\p0}`;
}

/** Visual width of text in ems: CJK/full-width = 1, others ≈ 0.56. */
export function textWidthEm(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x2e80 || (c >= 0x1100 && c <= 0x11ff) || (c >= 0xff00 && c <= 0xffef) ? 1 : ch === ' ' ? 0.3 : 0.56;
  }
  return w;
}

const NO_LINE_START = /^[、。，．・：；？！ー）」』】〉》〕｝”’,.!?)\]}…]/u;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;

type Parser = ReturnType<typeof loadDefaultJapaneseParser>;
let parser: Parser | null = null;

/** BudouX phrases for Japanese text (concatenation gives back the input). */
export function jaPhrases(text: string): string[] {
  if (text === '') return [];
  parser ??= loadDefaultJapaneseParser();
  return parser.parse(text);
}

/**
 * Greedy wrap to `maxEm` per line. Japanese breaks only between BudouX phrases (a phrase wider than a line is split by
 * characters, keeping closing punctuation off line starts); other text breaks at spaces.
 */
export function wrapText(text: string, maxEm: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const p = para.trim();
    if (p === '') {
      out.push('');
      continue;
    }
    const ja = CJK.test(p);
    let atoms: string[] = ja ? jaPhrases(p) : p.split(/(?<=\s)/);
    atoms = atoms.flatMap((a) => (textWidthEm(a.trim()) > maxEm ? [...a] : [a]));
    let line = '';
    for (const a of atoms) {
      if (line !== '' && textWidthEm((line + a).trimEnd()) > maxEm) {
        if (NO_LINE_START.test(a)) {
          line += a; // keep closing punctuation on the previous line
          continue;
        }
        out.push(line.trimEnd());
        line = a.trimStart();
      } else line += a;
    }
    out.push(line.trimEnd());
  }
  return out.filter((l, i, arr) => l !== '' || (i > 0 && i < arr.length - 1));
}

/** Re-wrap to the same number of lines with the narrowest width that still fits (avoids a lone last word). */
export function balanceLines(text: string, lines: string[], maxEm: number): string[] {
  if (lines.length < 2) return lines;
  const total = textWidthEm(text.replace(/\s+/g, ' '));
  for (let em = Math.max(1, total / lines.length); em < maxEm; em += 0.5) {
    const l = wrapText(text, em);
    if (l.length <= lines.length) return l;
  }
  return lines;
}

/** Largest font size (≤ max, ≥ min) whose wrapped lines fit the box (line height 1.25 em). */
export function fitText(text: string, boxW: number, boxH: number, maxSize: number, minSize: number): { size: number; lines: string[] } {
  for (let size = Math.round(maxSize); size >= Math.round(minSize); size -= Math.max(1, Math.round(size * 0.06))) {
    const lines = wrapText(text, boxW / size);
    const widest = Math.max(0, ...lines.map(textWidthEm));
    if (lines.length * size * 1.25 <= boxH && widest * size <= boxW) return { size, lines: balanceLines(text, lines, boxW / size) };
  }
  const size = Math.round(minSize);
  return { size, lines: wrapText(text, boxW / size) };
}

/** Text event body. */
export function textAt(x: number, y: number, align: number, o: { font: string; size: number; color: string; bold?: boolean; weight?: number;
  outline?: { color: string; width: number }; extra?: string }, lines: string[]): string {
  const bord = o.outline ? `\\3c${assTagColor(o.outline.color)}\\bord${Math.round(o.outline.width)}` : '\\bord0';
  return `{\\an${align}\\pos(${r1(x)},${r1(y)})\\fn${o.font}\\fs${Math.round(o.size)}\\b${o.weight ?? (o.bold ? 700 : 400)}\\1c${assTagColor(o.color)}\\1a&H00&${bord}\\shad0\\q2${o.extra ?? ''}}${lines.map(assEscape).join('\\N')}`;
}
