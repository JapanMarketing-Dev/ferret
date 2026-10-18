import type { Canvas, Overlay, Rational } from './schema.js';
import { frameToSeconds } from './time.js';

// Minimal ASS (Advanced SubStation Alpha) helpers shared with @video/captions.

/** "h:mm:ss.cc" (centiseconds) for a timeline frame. */
export function assTime(frame: number, fps: Rational): string {
  const cs = Math.round(frameToSeconds(frame, fps) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * Escape plain text for an ASS Dialogue Text field: `{`/`}` become libass escapes, a backslash is followed by
 * U+2060 (word joiner) so sequences like `\N` or `\h` in user text stay literal, newlines become `\N`.
 */
export function assEscape(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\\{}]/g, (c) => (c === '\\' ? '\\\u2060' : `\\${c}`))
    .replace(/\n/g, '\\N');
}

/** "#RRGGBB" or "#RRGGBBAA" (AA = opacity, FF opaque) → "&HAABBGGRR" (ASS alpha: 00 opaque). */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`invalid color: ${hex}`);
  const rgb = m[1]!;
  const opacity = m[2] ? parseInt(m[2], 16) : 255;
  const a = (255 - opacity).toString(16).padStart(2, '0');
  return `&H${a}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
}

/** Override-tag form of a color ("&HBBGGRR&"). */
export function assTagColor(hex: string): string {
  return `&H${assColor(hex).slice(4)}&`;
}

export function assHeader(canvas: { width: number; height: number }, styles: string[]): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

export function assStyleLine(s: {
  name: string; font: string; size: number; primary: string; secondary?: string; outline: string; back?: string;
  bold?: boolean; borderStyle?: 1 | 3; outlineWidth: number; shadow?: number; alignment: number; marginL?: number;
  marginR?: number; marginV?: number; spacing?: number;
}): string {
  return `Style: ${[
    s.name, s.font, Math.round(s.size), assColor(s.primary), assColor(s.secondary ?? s.primary), assColor(s.outline),
    assColor(s.back ?? '#00000080'), s.bold ? -1 : 0, 0, 0, 0, 100, 100, s.spacing ?? 0, 0, s.borderStyle ?? 1,
    +s.outlineWidth.toFixed(1), +(s.shadow ?? 0).toFixed(1), s.alignment, s.marginL ?? 0, s.marginR ?? 0, s.marginV ?? 0, 1,
  ].join(',')}`;
}

export function assDialogue(layer: number, start: number, end: number, fps: Rational, style: string, text: string): string {
  return `Dialogue: ${layer},${assTime(start, fps)},${assTime(end, fps)},${style},,0,0,0,,${text}`;
}

/**
 * ASS for text-like overlays (telop, keystroke, click-ring), rendered with the same libass pass as captions.
 * Returns null when the timeline has none.
 */
export function overlaysToAss(overlays: Overlay[], canvas: Canvas, fps: Rational, o?: { font?: string }): string | null {
  const items = overlays.filter((x) => x.kind === 'telop' || x.kind === 'keystroke' || x.kind === 'click-ring');
  if (items.length === 0) return null;
  const font = o?.font ?? 'Noto Sans JP';
  const u = Math.min(canvas.width, canvas.height);
  const styles = [
    assStyleLine({ name: 'Telop', font, size: u * 0.07, primary: '#FFFFFF', outline: '#000000', bold: true, outlineWidth: u * 0.006, shadow: 0, alignment: 5 }),
    assStyleLine({ name: 'Keys', font, size: u * 0.045, primary: '#FFFFFF', outline: '#000000', back: '#000000B0', bold: true, borderStyle: 3, outlineWidth: u * 0.01, alignment: 2, marginV: Math.round(canvas.height * 0.06) }),
    assStyleLine({ name: 'Ring', font, size: 20, primary: '#FFD400', outline: '#FFD400', outlineWidth: 0, alignment: 7 }),
  ];
  const events: string[] = [];
  for (const ov of items) {
    if (ov.kind === 'telop') {
      const x = Math.round(ov.position.x);
      const y = Math.round(ov.position.y);
      events.push(assDialogue(1, ov.range.start, ov.range.end, fps, 'Telop', `{\\an5\\pos(${x},${y})\\fad(120,120)}${assEscape(ov.text)}`));
    } else if (ov.kind === 'keystroke') {
      const keys = ov.keys.map((k) => assEscape(k)).join(' + ');
      events.push(assDialogue(1, ov.range.start, ov.range.end, fps, 'Keys', keys));
    } else if (ov.kind === 'click-ring') {
      // A ring drawn with ASS vector drawing, growing and fading over ~0.4 s.
      const r = Math.round(u * 0.03);
      const end = ov.at + Math.max(1, Math.round((fps.num / fps.den) * 0.4));
      const x = Math.round(ov.position.x);
      const y = Math.round(ov.position.y);
      const circle = (rad: number) => {
        const k = Math.round(rad * 0.5523);
        return `m ${rad} 0 b ${rad} ${k} ${k} ${rad} 0 ${rad} b ${-k} ${rad} ${-rad} ${k} ${-rad} 0 b ${-rad} ${-k} ${-k} ${-rad} 0 ${-rad} b ${k} ${-rad} ${rad} ${-k} ${rad} 0`;
      };
      // Transparent fill + thick outline = ring. Drawing coordinates are centred on (0,0), so \an7 + \pos centres it.
      const bord = Math.max(2, Math.round(r * 0.25));
      events.push(assDialogue(2, ov.at, end, fps, 'Ring',
        `{\\an7\\pos(${x},${y})\\1a&HFF&\\3c${assTagColor('#FFD400')}\\bord${bord}\\shad0\\fscx60\\fscy60\\t(\\fscx140\\fscy140)\\fad(0,250)\\p1}${circle(r)}{\\p0}`));
    }
  }
  return `${assHeader(canvas, styles)}\n${events.join('\n')}\n`;
}
