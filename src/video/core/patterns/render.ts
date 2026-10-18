import { assDialogue, assEscape, assHeader, assStyleLine, assTagColor } from '../ass.js';
import { sha256Hex } from '../hash.js';
import type { Canvas, Rect, Scene, SlotValue, Timeline } from '../schema.js';
import { fpsValue } from '../time.js';
import type { Issue } from '../validate.js';
import type { PatternDef, PatternTheme } from './defs.js';
import { resolvePattern } from './defs.js';
import {
  balanceLines, circlePath, drawing, drawingAt, fillTags, fitText, mixColor, polygonPath, rectPath, roundedRectPath, strokeTags, textAt,
  textWidthEm, waveBandPath, wrapText,
} from './draw.js';

/** Media a scene shows through ffmpeg (images and video slots), in timeline canvas pixels and absolute frames. */
export interface MediaPlacement {
  scene: string;
  slot: string;
  kind: 'image' | 'video';
  source: string;
  rect: Rect;
  shape: 'rect' | 'circle' | 'rounded';
  fit: 'contain' | 'cover';
  /** Crop in source pixels before fitting (video callouts). */
  crop?: Rect;
  /** Video: source frame at `start` (source's own clock), or 'sync' = the camera synced to the take being shown. */
  from?: number | 'sync';
  start: number;
  end: number;
  fadeInFrames: number;
}

export interface SceneRender {
  back: string[];
  front: string[];
  media: MediaPlacement[];
  /** On-screen areas of non-media slots (text, lists, code) in canvas pixels, for hit-testing feedback. */
  regions: { slot: string; rect: Rect }[];
}

function region(c: { out: SceneRender }, slot: string, rect: Rect): void {
  c.out.regions.push({ slot, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) } });
}

/** Validate a scene's slots against its pattern. Unknown patterns are a warning (they may live in the project folder). */
export function validateSceneSlots(scene: Scene, t: Pick<Timeline, 'sources' | 'canvas'>, path: string, custom?: Record<string, PatternDef>): Issue[] {
  const issues: Issue[] = [];
  const r = resolvePattern(scene.pattern.id, custom);
  if (!r) {
    issues.push({ level: 'warning', path: `${path}.pattern`, message: `unknown pattern "${scene.pattern.id}"; it cannot be rendered` });
    return issues;
  }
  const def = r.def;
  if (def.version !== scene.pattern.version) {
    issues.push({ level: 'warning', path: `${path}.pattern.version`, message: `pattern ${def.id} is version ${def.version}, scene uses ${scene.pattern.version}` });
  }
  const aspect = t.canvas.width >= t.canvas.height ? '16:9' : '9:16';
  if (!def.aspect.includes(aspect)) issues.push({ level: 'warning', path: `${path}.pattern`, message: `pattern ${def.id} is not designed for ${aspect}` });
  for (const [name, sd] of Object.entries(def.slots)) {
    const v = scene.slots[name];
    if (!v) {
      if (sd.required && sd.default === undefined) issues.push({ level: 'error', path: `${path}.slots.${name}`, message: `required ${sd.kind} slot "${name}" is missing` });
      continue;
    }
    if (v.kind !== sd.kind) {
      issues.push({ level: 'error', path: `${path}.slots.${name}`, message: `slot "${name}" must be ${sd.kind}, got ${v.kind}` });
      continue;
    }
    const len = (s: string) => [...s].length;
    if (v.kind === 'text') {
      if (sd.required && v.text.trim() === '') issues.push({ level: 'error', path: `${path}.slots.${name}.text`, message: `slot "${name}" is empty` });
      if (sd.maxChars !== undefined && len(v.text) > sd.maxChars) {
        issues.push({ level: 'warning', path: `${path}.slots.${name}.text`, message: `${len(v.text)} characters; the pattern allows ${sd.maxChars}` });
      }
    }
    if (v.kind === 'list') {
      if (sd.required && v.items.length === 0) issues.push({ level: 'error', path: `${path}.slots.${name}.items`, message: `slot "${name}" has no items` });
      if (sd.maxItems !== undefined && v.items.length > sd.maxItems) {
        issues.push({ level: 'warning', path: `${path}.slots.${name}.items`, message: `${v.items.length} items; the pattern shows at most ${sd.maxItems}` });
      }
      v.items.forEach((it, i) => {
        if (sd.maxChars !== undefined && len(it) > sd.maxChars) {
          issues.push({ level: 'warning', path: `${path}.slots.${name}.items[${i}]`, message: `${len(it)} characters; the pattern allows ${sd.maxChars}` });
        }
      });
    }
    if (v.kind === 'code') {
      const lines = v.code.split('\n').length;
      if (sd.maxItems !== undefined && lines > sd.maxItems) {
        issues.push({ level: 'warning', path: `${path}.slots.${name}.code`, message: `${lines} lines; the pattern shows at most ${sd.maxItems}` });
      }
      v.highlight?.forEach((h, i) => {
        if (h < 1 || h > lines) issues.push({ level: 'error', path: `${path}.slots.${name}.highlight[${i}]`, message: `line ${h} does not exist (1..${lines})` });
      });
    }
    if (v.kind === 'image') {
      const s = t.sources[v.asset];
      if (!s) issues.push({ level: 'error', path: `${path}.slots.${name}.asset`, message: `unknown source "${v.asset}"` });
      else if (s.kind !== 'asset') issues.push({ level: 'error', path: `${path}.slots.${name}.asset`, message: `source "${v.asset}" is ${s.kind}, expected asset` });
    }
    if (v.kind === 'video') {
      const s = t.sources[v.source];
      if (!s) issues.push({ level: 'error', path: `${path}.slots.${name}.source`, message: `unknown source "${v.source}"` });
      else if (s.kind === 'mic') issues.push({ level: 'error', path: `${path}.slots.${name}.source`, message: `source "${v.source}" has no video` });
    }
  }
  for (const name of Object.keys(scene.slots)) {
    if (!def.slots[name]) issues.push({ level: 'error', path: `${path}.slots.${name}`, message: `pattern ${def.id} has no slot "${name}"` });
  }
  return issues;
}

interface Ctx {
  W: number;
  H: number;
  u: number;
  portrait: boolean;
  fps: number;
  scene: Scene;
  def: PatternDef;
  theme: PatternTheme;
  animIn: string;
  fadeOutMs: number;
  out: SceneRender;
  t: Pick<Timeline, 'sources' | 'canvas'>;
}

const sec = (c: Ctx, s: number) => Math.round(s * c.fps);

/** Add an event starting `delaySec` into the scene. */
function ev(c: Ctx, where: 'back' | 'front', layer: number, delaySec: number, body: string, fadeInMs = 0): void {
  const start = Math.min(c.scene.range.start + sec(c, delaySec), c.scene.range.end - 1);
  const fad = fadeInMs > 0 || c.fadeOutMs > 0 ? `{\\fad(${fadeInMs},${c.fadeOutMs})}` : '';
  c.out[where].push(assDialogue(layer, start, c.scene.range.end, c.t.canvas.fps, 'Scene', `${fad}${body}`));
}

function text(c: Ctx, name: string): string | undefined {
  const v = c.scene.slots[name];
  if (v?.kind === 'text') return v.text;
  const d = c.def.slots[name]?.default;
  return c.def.slots[name]?.kind === 'text' && d !== undefined ? d : undefined;
}
function list(c: Ctx, name: string, max?: number): string[] {
  const v = c.scene.slots[name];
  const items = v?.kind === 'list' ? v.items : [];
  return max === undefined ? items : items.slice(0, max);
}
function slotNumber(c: Ctx, name: string): Extract<SlotValue, { kind: 'number' }> | undefined {
  const v = c.scene.slots[name];
  return v?.kind === 'number' ? v : undefined;
}

// ---------- shared pieces ----------

function wavesBackground(c: Ctx): void {
  ev(c, 'back', 0, 0, drawing(fillTags(c.theme.background), rectPath(0, 0, c.W, c.H)));
  // Subtle thin wavy lines (reference: dark background with faint waves).
  const bands = [
    { y: 0.12, a: 0.03, l: 0.95, p: 0.3, th: 0.012, col: c.theme.wave2 },
    { y: 0.27, a: 0.045, l: 1.3, p: 1.7, th: 0.009, col: c.theme.wave },
    { y: 0.42, a: 0.035, l: 0.8, p: 2.9, th: 0.014, col: c.theme.wave2 },
    { y: 0.57, a: 0.05, l: 1.15, p: 4.1, th: 0.008, col: c.theme.wave },
    { y: 0.72, a: 0.04, l: 0.9, p: 5.3, th: 0.012, col: c.theme.wave2 },
    { y: 0.87, a: 0.035, l: 1.4, p: 0.9, th: 0.009, col: c.theme.wave },
  ];
  for (const b of bands) {
    ev(c, 'back', 1, 0, drawing(fillTags(b.col), waveBandPath(c.W, b.y * c.H, b.a * c.H, b.l * c.W, b.p, b.th * c.H)));
  }
}

/** Gradient (accentFrom → accentTo, left → right) stroke of a path, approximated with clipped vertical slices. */
function gradientStroke(c: Ctx, where: 'back' | 'front', layer: number, delay: number, path: string, bbox: Rect, width: number, fadeMs: number, slices = 14): void {
  const pad = width * 2;
  for (let i = 0; i < slices; i++) {
    const x1 = bbox.x - pad + ((bbox.w + 2 * pad) * i) / slices;
    const x2 = bbox.x - pad + ((bbox.w + 2 * pad) * (i + 1)) / slices + 1;
    const col = mixColor(c.theme.accentFrom, c.theme.accentTo, slices === 1 ? 0 : i / (slices - 1));
    const clip = `\\clip(${Math.floor(x1)},${Math.floor(bbox.y - pad)},${Math.ceil(x2)},${Math.ceil(bbox.y + bbox.h + pad)})`;
    ev(c, where, layer, delay, drawing(`${strokeTags(col, width)}${clip}`, path), fadeMs);
  }
}

function gradientFrame(c: Ctx, r: Rect, delay = 0, thickness = 0.011): void {
  const radius = c.u * 0.045;
  const width = Math.max(3, c.u * thickness);
  const fade = c.animIn === 'frame-draw' || c.def.animation.in.includes('frame-draw') ? 400 : 200;
  gradientStroke(c, 'back', 2, delay, roundedRectPath(r.x, r.y, r.w, r.h, radius), r, width, fade);
}

/** Speech bubble (rounded rect + tail) centred at (cx, cy) with text, popping in. */
export interface BubbleFit { size: number; lines: string[]; w: number; h: number }

/**
 * Fit bubble text: the largest size up to `maxSize` (≈ frame height / 14 in the reference) with at most `maxLines`
 * BudouX lines; the bubble grows from its base size to fit, up to maxW × maxH. Falls back to the smallest size.
 */
export function fitBubble(label: string, base: { w: number; h: number }, max: { w: number; h: number }, maxSize: number, minSize: number, maxLines = 3): BubbleFit {
  const padX = 0.16; // share of the bubble width kept free left + right
  const padY = 0.3; // share of the height kept free top + bottom
  const step = (sz: number) => Math.max(1, Math.round(sz * 0.05));
  let last: BubbleFit | null = null;
  for (let size = Math.round(maxSize); size >= Math.round(minSize); size -= step(size)) {
    const innerMax = (max.w * (1 - padX)) / size;
    const lines = balanceLines(label, wrapText(label, innerMax), innerMax);
    const textW = Math.max(0, ...lines.map(textWidthEm)) * size;
    const textH = lines.length * size * 1.25;
    const w = Math.max(base.w, textW / (1 - padX));
    const h = Math.max(base.h, textH / (1 - padY));
    last = { size, lines, w, h };
    if (lines.length <= maxLines && w <= max.w + 0.5 && h <= max.h + 0.5) return last;
  }
  return last ?? { size: Math.round(minSize), lines: [label], w: base.w, h: base.h };
}

/** Speech bubble (rounded rect / pill + tail) centred at (cx, cy) with auto-fitted text, popping in. */
function bubble(c: Ctx, slot: string, cx: number, cy: number, bw: number, bh: number, tail: 'down-left' | 'down-right', label: string, delay: number,
  pill = false, max?: { w: number; h: number }, maxSize?: number): void {
  const fit = fitBubble(label, { w: bw, h: bh }, max ?? { w: bw, h: bh }, maxSize ?? c.u * 0.06, c.u * 0.026);
  const { w, h } = fit;
  region(c, slot, { x: cx - w / 2, y: cy - h / 2, w, h: h * 1.32 });
  const r = pill && fit.lines.length === 1 ? h / 2 : Math.min(w, h) * (pill ? 0.4 : 0.3);
  const tailH = Math.min(h, bh * 1.2) * 0.32;
  // libass anchors drawings from their origin, so the path uses non-negative local coordinates (bbox w × (h + tailH)).
  const tx = tail === 'down-right' ? w * 0.68 : w * 0.32;
  const tip = tail === 'down-right' ? tx + w * 0.12 : tx - w * 0.12;
  const path = `${roundedRectPath(0, 0, w, h, r)} ${polygonPath([[tx - w * 0.07, h - 2], [tx + w * 0.07, h - 2], [tip, h + tailH]])}`;
  const pop = c.animIn === 'fade' ? '' : '\\fscx25\\fscy25\\t(0,170,\\fscx108\\fscy108)\\t(170,250,\\fscx100\\fscy100)';
  ev(c, 'front', 5, delay, drawingAt(cx, cy + tailH / 2, `${fillTags(c.theme.bubbleFill)}${pop}`, path), 120);
  ev(c, 'front', 6, delay, textAt(cx, cy, 5, { font: c.theme.font, size: fit.size, color: c.theme.bubbleText, weight: 900, extra: pop }, fit.lines), 120);
}

function title(c: Ctx, label: string | undefined, y: number, size = 0.07): number {
  if (!label) return y;
  const fit = fitText(label, c.W * 0.84, c.H * 0.14, c.u * size, c.u * 0.035);
  ev(c, 'front', 4, 0.1, textAt(c.W / 2, y, 8, { font: c.theme.font, size: fit.size, color: c.theme.text, bold: true }, fit.lines), 250);
  const bottom = y + fit.lines.length * fit.size * 1.25;
  region(c, 'title', { x: c.W * 0.08, y, w: c.W * 0.84, h: bottom - y });
  const barW = Math.min(c.W * 0.3, Math.max(...fit.lines.map(textWidthEm)) * fit.size);
  const bar: Rect = { x: c.W / 2 - barW / 2, y: bottom + c.u * 0.012, w: barW, h: Math.max(4, c.u * 0.008) };
  gradientFill(c, 'front', 4, 0.25, rectPath(bar.x, bar.y, bar.w, bar.h), bar, 300);
  return bar.y + bar.h + c.u * 0.04;
}

/** Gradient fill of a path (clipped slices). */
function gradientFill(c: Ctx, where: 'back' | 'front', layer: number, delay: number, path: string, bbox: Rect, fadeMs: number, slices = 10): void {
  for (let i = 0; i < slices; i++) {
    const x1 = bbox.x + (bbox.w * i) / slices;
    const x2 = bbox.x + (bbox.w * (i + 1)) / slices + 1;
    const col = mixColor(c.theme.accentFrom, c.theme.accentTo, slices === 1 ? 0 : i / (slices - 1));
    ev(c, where, layer, delay, drawing(`${fillTags(col)}\\clip(${Math.floor(x1)},${Math.floor(bbox.y - 2)},${Math.ceil(x2)},${Math.ceil(bbox.y + bbox.h + 2)})`, path), fadeMs);
  }
}

function media(c: Ctx, m: Omit<MediaPlacement, 'scene' | 'start' | 'end' | 'fadeInFrames'> & { delay?: number; fadeSec?: number }): void {
  const { delay, fadeSec, ...rest } = m;
  c.out.media.push({
    ...rest,
    scene: c.scene.id,
    start: Math.min(c.scene.range.start + sec(c, delay ?? 0), c.scene.range.end - 1),
    end: c.scene.range.end,
    fadeInFrames: sec(c, fadeSec ?? 0.25),
  });
}

/** Video slot → placement (explicit source/from, or the default synced camera). */
function videoSlot(c: Ctx, name: string): { source: string; from: number | 'sync' } | null {
  const v = c.scene.slots[name];
  if (v?.kind === 'video') return { source: v.source, from: v.from };
  const d = c.def.slots[name]?.default;
  if (!d?.startsWith('camera:')) return null;
  const role = d.slice('camera:'.length);
  const ids = Object.keys(c.t.sources).sort();
  const cam = ids.find((id) => { const s = c.t.sources[id]!; return s.kind === 'camera' && s.role === role; })
    ?? ids.find((id) => c.t.sources[id]!.kind === 'camera');
  return cam ? { source: cam, from: 'sync' } : null;
}

function circleWipe(c: Ctx, cx: number, cy: number, d: number, slotName: string, delay: number, ringFrac = 0.01): void {
  const vs = videoSlot(c, slotName);
  if (!vs) return;
  media(c, { slot: slotName, kind: 'video', source: vs.source, from: vs.from, rect: { x: cx - d / 2, y: cy - d / 2, w: d, h: d }, shape: 'circle', fit: 'cover', delay });
  const ring = Math.max(3, c.u * ringFrac);
  // libass borders grow outward from the path: a path on the wipe edge leaves no gap to the camera.
  gradientStroke(c, 'front', 3, delay, circlePath(cx, cy, d / 2 - 1), { x: cx - d / 2, y: cy - d / 2, w: d, h: d }, ring, 300, 10);
}

// ---------- patterns ----------

type Renderer = (c: Ctx) => void;

const RENDERERS: Record<string, Renderer> = {
  'explain-illust-bubbles': (c) => {
    // Reference look: black wavy background, thick orange→red rounded frame inset ~10%, centred line-art figure,
    // white pill bubbles upper-left / upper-right, round camera wipe overlapping the frame's bottom-left corner.
    const { W, H, portrait } = c;
    wavesBackground(c);
    const frame: Rect = portrait ? { x: 0.06 * W, y: 0.08 * H, w: 0.88 * W, h: 0.84 * H } : { x: 0.08 * W, y: 0.1 * H, w: 0.84 * W, h: 0.8 * H };
    gradientFrame(c, frame, 0, 0.018);
    const ill = c.scene.slots.illustration;
    if (ill?.kind === 'image') {
      const r: Rect = portrait ? { x: 0.18 * W, y: 0.34 * H, w: 0.64 * W, h: 0.42 * H } : { x: 0.35 * W, y: 0.22 * H, w: 0.3 * W, h: 0.66 * H };
      media(c, { slot: 'illustration', kind: 'image', source: ill.asset, rect: r, shape: 'rect', fit: 'contain', delay: 0.1 });
    }
    const left = text(c, 'bubbleLeft');
    const right = text(c, 'bubbleRight');
    const d = portrait ? 0.4 * W : 0.34 * H;
    if (portrait) {
      const max = { w: 0.6 * W, h: 0.13 * H };
      if (left) bubble(c, 'bubbleLeft', 0.36 * W, 0.17 * H, 0.52 * W, 0.075 * H, 'down-right', left, 0.25, true, max, frame.h / 22);
      if (right) bubble(c, 'bubbleRight', 0.64 * W, 0.3 * H, 0.52 * W, 0.075 * H, 'down-left', right, 0.55, true, max, frame.h / 22);
    } else {
      // reference: large text (≈ frame height / 14), up to 3 lines, bubble grows to fit
      const max = { w: 0.34 * W, h: 0.3 * H };
      if (left) bubble(c, 'bubbleLeft', 0.25 * W, 0.27 * H, 0.27 * W, 0.14 * H, 'down-right', left, 0.25, true, max, frame.h / 14);
      if (right) bubble(c, 'bubbleRight', 0.75 * W, 0.27 * H, 0.27 * W, 0.14 * H, 'down-left', right, 0.55, true, max, frame.h / 14);
    }
    const m = c.u * 0.036; // keep the ring (≈0.016 u) on screen
    const cx = Math.max(d / 2 + m, frame.x + d * 0.25);
    const cy = Math.min(H - d / 2 - m, frame.y + frame.h - d * 0.25);
    circleWipe(c, cx, cy, d, 'wipe', 0, 0.016);
  },

  'title-card': (c) => {
    wavesBackground(c);
    const n = slotNumber(c, 'number');
    const label = text(c, 'title') ?? '';
    const fit = fitText(label, c.W * 0.84, c.H * 0.34, c.u * 0.12, c.u * 0.05);
    const blockH = fit.lines.length * fit.size * 1.25;
    const y = c.H * 0.46 - blockH / 2;
    if (n) {
      const num = String(n.value).padStart(2, '0');
      ev(c, 'front', 4, 0, textAt(c.W / 2, y - c.u * 0.03, 2, { font: c.theme.font, size: c.u * 0.06, color: c.theme.accentFrom, bold: true }, [num]), 300);
    }
    region(c, 'title', { x: c.W * 0.08, y, w: c.W * 0.84, h: blockH });
    const rise = '\\fscx92\\fscy92\\t(0,350,\\fscx100\\fscy100)';
    ev(c, 'front', 4, 0.1, textAt(c.W / 2, y, 8, { font: c.theme.font, size: fit.size, color: c.theme.text, weight: 900, extra: rise }, fit.lines), 350);
    const barW = Math.min(c.W * 0.4, Math.max(...fit.lines.map(textWidthEm)) * fit.size * 0.8);
    const bar: Rect = { x: c.W / 2 - barW / 2, y: y + blockH + c.u * 0.025, w: barW, h: Math.max(4, c.u * 0.012) };
    gradientFill(c, 'front', 4, 0.35, rectPath(bar.x, bar.y, bar.w, bar.h), bar, 300);
    const sub = text(c, 'subtitle');
    if (sub) {
      const f2 = fitText(sub, c.W * 0.8, c.H * 0.14, c.u * 0.045, c.u * 0.028);
      ev(c, 'front', 4, 0.5, textAt(c.W / 2, bar.y + bar.h + c.u * 0.04, 8, { font: c.theme.font, size: f2.size, color: c.theme.subtext }, f2.lines), 300);
    }
  },

  'bullet-points': (c) => {
    wavesBackground(c);
    const items = list(c, 'items', c.def.slots.items?.maxItems);
    let y = title(c, text(c, 'title'), c.H * (c.portrait ? 0.12 : 0.08));
    const areaH = c.H * 0.9 - y;
    const longest = Math.max(1, ...items.map(textWidthEm));
    const size = Math.max(c.u * 0.03, Math.min(c.u * 0.065, (c.W * 0.74) / longest, areaH / (Math.max(1, items.length) * 1.7)));
    const dur = (c.scene.range.end - c.scene.range.start) / c.fps;
    const stagger = Math.min(0.9, (dur * 0.6) / Math.max(1, items.length));
    const x0 = c.W * 0.13;
    items.forEach((it, i) => {
      const cy = y + size * 0.66;
      const delay = 0.4 + i * stagger;
      const r = size * 0.22;
      gradientFill(c, 'front', 4, delay, circlePath(x0 - size * 0.6, cy, r), { x: x0 - size * 0.6 - r, y: cy - r, w: 2 * r, h: 2 * r }, 200, 2);
      const lines = wrapText(it, (c.W * 0.78) / size);
      ev(c, 'front', 4, delay, textAt(x0, y, 7, { font: c.theme.font, size, color: c.theme.text, bold: true, extra: `\\move(${Math.round(x0 + c.u * 0.03)},${Math.round(y)},${Math.round(x0)},${Math.round(y)},0,220)` }, lines), 200);
      region(c, 'items', { x: x0 - size, y, w: c.W * 0.82, h: lines.length * 1.25 * size });
      y += (lines.length * 1.25 + 0.45) * size;
    });
  },

  'compare-2col': (c) => {
    wavesBackground(c);
    const panels: Rect[] = c.portrait
      ? [{ x: 0.06 * c.W, y: 0.07 * c.H, w: 0.88 * c.W, h: 0.4 * c.H }, { x: 0.06 * c.W, y: 0.53 * c.H, w: 0.88 * c.W, h: 0.4 * c.H }]
      : [{ x: 0.05 * c.W, y: 0.12 * c.H, w: 0.42 * c.W, h: 0.76 * c.H }, { x: 0.53 * c.W, y: 0.12 * c.H, w: 0.42 * c.W, h: 0.76 * c.H }];
    const sides = [
      { t: text(c, 'leftTitle') ?? '', items: list(c, 'left', 4), head: '#3D7BFF', delay: 0.2 },
      { t: text(c, 'rightTitle') ?? '', items: list(c, 'right', 4), head: c.theme.accentFrom, delay: 0.7 },
    ];
    sides.forEach((s, i) => {
      const p = panels[i]!;
      region(c, i === 0 ? 'left' : 'right', p);
      const r = c.u * 0.03;
      ev(c, 'front', 3, s.delay, drawing(fillTags(c.theme.panel), roundedRectPath(p.x, p.y, p.w, p.h, r)), 250);
      const hh = Math.min(p.h * 0.2, c.u * 0.12);
      ev(c, 'front', 4, s.delay, drawing(fillTags(s.head), roundedRectPath(p.x, p.y, p.w, hh, r)), 250);
      const tf = fitText(s.t, p.w * 0.85, hh * 0.8, c.u * 0.055, c.u * 0.028);
      ev(c, 'front', 5, s.delay, textAt(p.x + p.w / 2, p.y + hh / 2, 5, { font: c.theme.font, size: tf.size, color: '#FFFFFF', bold: true }, tf.lines), 250);
      const longest = Math.max(1, ...s.items.map(textWidthEm));
      const size = Math.max(c.u * 0.026, Math.min(c.u * 0.05, (p.w * 0.85) / longest, (p.h - hh) / (Math.max(1, s.items.length) * 1.9)));
      s.items.forEach((it, k) => {
        const lines = wrapText(`・${it}`, (p.w * 0.88) / size);
        ev(c, 'front', 5, s.delay + 0.15 + k * 0.15, textAt(p.x + p.w * 0.06, p.y + hh + size * (0.6 + k * 1.75), 7, { font: c.theme.font, size, color: c.theme.text }, lines), 200);
      });
    });
    const cx = c.portrait ? c.W / 2 : c.W / 2;
    const cy = c.portrait ? c.H / 2 : c.H / 2;
    const rr = c.u * 0.065;
    const pop = '\\fscx20\\fscy20\\t(0,180,\\fscx110\\fscy110)\\t(180,260,\\fscx100\\fscy100)';
    ev(c, 'front', 6, 1.1, drawingAt(cx, cy, `${fillTags(c.theme.accentTo)}${pop}`, circlePath(rr, rr, rr)), 100);
    ev(c, 'front', 7, 1.1, textAt(cx, cy, 5, { font: c.theme.font, size: rr * 0.9, color: '#FFFFFF', bold: true, extra: pop }, ['VS']), 100);
  },

  ranking: (c) => {
    wavesBackground(c);
    const items = list(c, 'items', c.def.slots.items?.maxItems);
    const y0 = title(c, text(c, 'title'), c.H * (c.portrait ? 0.1 : 0.07));
    const n = Math.max(1, items.length);
    const rowH = Math.min(c.u * 0.16, (c.H * 0.93 - y0) / n);
    const medal = ['#FFC300', '#C0C7D0', '#CD7F32'];
    const dur = (c.scene.range.end - c.scene.range.start) / c.fps;
    const stagger = Math.min(1.2, (dur * 0.6) / n);
    items.forEach((it, i) => {
      const rank = i + 1;
      const delay = 0.4 + (n - rank) * stagger; // 3位から順に
      const y = y0 + i * rowH;
      const p: Rect = { x: c.W * 0.08, y, w: c.W * 0.84, h: rowH * 0.82 };
      region(c, 'items', p);
      ev(c, 'front', 3, delay, drawing(fillTags(c.theme.panel), roundedRectPath(p.x, p.y, p.w, p.h, p.h * 0.3)), 250);
      const br = p.h * 0.36;
      const bx = p.x + p.h * 0.55;
      ev(c, 'front', 4, delay, drawing(fillTags(medal[i] ?? '#5B6475'), circlePath(bx, p.y + p.h / 2, br)), 250);
      ev(c, 'front', 5, delay, textAt(bx, p.y + p.h / 2, 5, { font: c.theme.font, size: br * 1.15, color: rank <= 3 ? '#111111' : '#FFFFFF', bold: true }, [String(rank)]), 250);
      const f = fitText(it, p.w - p.h * 1.4, p.h * 0.8, p.h * 0.45, p.h * 0.22);
      ev(c, 'front', 5, delay, textAt(bx + br + p.h * 0.35, p.y + p.h / 2, 4, { font: c.theme.font, size: f.size, color: c.theme.text, bold: true }, f.lines), 250);
    });
  },

  'big-number': (c) => {
    wavesBackground(c);
    const v = slotNumber(c, 'value');
    const label = `${v ? (Number.isInteger(v.value) ? v.value.toLocaleString('en-US') : String(v.value)) : ''}${v?.unit ?? ''}`;
    const size = Math.min(c.u * 0.32, (c.W * 0.86) / Math.max(1, textWidthEm(label)));
    const cy = c.H * 0.44;
    const pop = '\\fscx40\\fscy40\\t(0,220,\\fscx110\\fscy110)\\t(220,320,\\fscx100\\fscy100)';
    const w = textWidthEm(label) * size;
    region(c, 'value', { x: c.W / 2 - w / 2, y: cy - size / 2, w, h: size });
    const slices = 8;
    for (let i = 0; i < slices; i++) {
      const x1 = c.W / 2 - w / 2 - size * 0.2 + ((w + size * 0.4) * i) / slices;
      const x2 = x1 + (w + size * 0.4) / slices + 1;
      const col = mixColor(c.theme.accentFrom, c.theme.accentTo, i / (slices - 1));
      ev(c, 'front', 4, 0.15, textAt(c.W / 2, cy, 5, { font: c.theme.font, size, color: col, weight: 900, extra: `${pop}\\clip(${Math.floor(x1)},0,${Math.ceil(x2)},${c.H})` }, [label]), 150);
    }
    const sub = text(c, 'label');
    if (sub) {
      const f = fitText(sub, c.W * 0.84, c.H * 0.16, c.u * 0.06, c.u * 0.03);
      ev(c, 'front', 4, 0.5, textAt(c.W / 2, cy + size * 0.65, 8, { font: c.theme.font, size: f.size, color: c.theme.text, bold: true }, f.lines), 300);
    }
  },

  quote: (c) => {
    wavesBackground(c);
    const body = text(c, 'text') ?? '';
    const f = fitText(body, c.W * 0.76, c.H * 0.5, c.u * 0.075, c.u * 0.032);
    const blockH = f.lines.length * f.size * 1.25;
    const top = c.H * 0.47 - blockH / 2;
    region(c, 'text', { x: c.W * 0.12, y: top, w: c.W * 0.76, h: blockH });
    ev(c, 'front', 3, 0, textAt(c.W * 0.12, top - c.u * 0.02, 1, { font: c.theme.font, size: c.u * 0.28, color: `${c.theme.accentFrom}B0`, bold: true }, ['“']), 300);
    ev(c, 'front', 4, 0.2, textAt(c.W / 2, top, 8, { font: c.theme.font, size: f.size, color: c.theme.text, bold: true }, f.lines), 500);
    const by = text(c, 'by');
    if (by) ev(c, 'front', 4, 0.8, textAt(c.W * 0.88, top + blockH + c.u * 0.05, 9, { font: c.theme.font, size: f.size * 0.6, color: c.theme.subtext }, [`— ${by}`]), 400);
  },

  'code-focus': (c) => {
    ev(c, 'back', 0, 0, drawing(fillTags('#0B0E14'), rectPath(0, 0, c.W, c.H)));
    const v = c.scene.slots.code;
    const code = v?.kind === 'code' ? v : { code: '', language: '', highlight: [] as number[] };
    const lines = code.code.replace(/\t/g, '    ').split('\n').slice(0, c.def.slots.code?.maxItems ?? 18);
    const ttl = text(c, 'title');
    const panel: Rect = { x: c.W * 0.05, y: c.H * (ttl ? 0.16 : 0.08), w: c.W * 0.9, h: c.H * (ttl ? 0.76 : 0.84) };
    region(c, 'code', panel);
    if (ttl) ev(c, 'front', 4, 0, textAt(c.W / 2, c.H * 0.05, 8, { font: c.theme.font, size: c.u * 0.05, color: c.theme.text, bold: true }, [ttl]), 250);
    ev(c, 'back', 1, 0, drawing(fillTags('#161B22'), roundedRectPath(panel.x, panel.y, panel.w, panel.h, c.u * 0.02)), 250);
    const longest = Math.max(10, ...lines.map((l) => [...l].length + 4));
    const size = Math.max(10, Math.min(c.u * 0.05, (panel.w * 0.92) / (longest * 0.6), (panel.h * 0.9) / (Math.max(1, lines.length) * 1.35)));
    const lh = size * 1.35;
    const x0 = panel.x + panel.w * 0.04;
    const y0 = panel.y + (panel.h - lines.length * lh) / 2;
    for (const h of code.highlight ?? []) {
      if (h < 1 || h > lines.length) continue;
      const y = y0 + (h - 1) * lh - size * 0.1;
      ev(c, 'back', 2, 0.5, drawing(fillTags(`${c.theme.accentFrom}40`), roundedRectPath(panel.x + panel.w * 0.015, y, panel.w * 0.97, lh, size * 0.2)), 300);
      ev(c, 'back', 2, 0.5, drawing(fillTags(c.theme.accentFrom), rectPath(panel.x + panel.w * 0.015, y, size * 0.18, lh)), 300);
    }
    const mono = (s: string) => assEscape(s).replace(/ /g, '\\h');
    lines.forEach((l, i) => {
      const y = y0 + i * lh;
      const num = String(i + 1).padStart(String(lines.length).length, ' ');
      const hi = code.highlight?.includes(i + 1);
      const body = `{\\an7\\pos(${Math.round(x0)},${Math.round(y)})\\fn${c.theme.mono}\\fs${Math.round(size)}\\b400\\bord0\\shad0\\q2\\1c${assTagColor('#5C6370')}}${mono(num)}\\h\\h{\\1c${assTagColor(hi ? '#FFFFFF' : '#C9D1D9')}${hi ? '\\b700' : ''}}${mono(l)}`;
      ev(c, 'front', 4, 0.1, body, 250);
    });
  },

  'terminal-typing': (c) => {
    ev(c, 'back', 0, 0, drawing(fillTags('#0B0E14'), rectPath(0, 0, c.W, c.H)));
    const p: Rect = c.portrait ? { x: c.W * 0.05, y: c.H * 0.25, w: c.W * 0.9, h: c.H * 0.5 } : { x: c.W * 0.08, y: c.H * 0.12, w: c.W * 0.84, h: c.H * 0.76 };
    region(c, 'command', p);
    const r = c.u * 0.02;
    const barH = c.u * 0.06;
    ev(c, 'back', 1, 0, drawing(fillTags('#0D1117'), roundedRectPath(p.x, p.y, p.w, p.h, r)), 200);
    ev(c, 'back', 2, 0, drawing(fillTags('#1F2430'), roundedRectPath(p.x, p.y, p.w, barH, r)), 200);
    ['#FF5F57', '#FEBC2E', '#28C840'].forEach((col, i) => {
      ev(c, 'back', 3, 0, drawing(fillTags(col), circlePath(p.x + barH * (0.6 + i * 0.55), p.y + barH / 2, barH * 0.17)), 200);
    });
    const v = c.scene.slots.command;
    const cmd = v?.kind === 'code' ? v.code : '';
    const out = text(c, 'output') ?? '';
    const cmdLines = cmd.split('\n').slice(0, c.def.slots.command?.maxItems ?? 3);
    const outLines = out === '' ? [] : out.split('\n');
    const longest = Math.max(20, ...cmdLines.map((l) => [...l].length + 2), ...outLines.map((l) => [...l].length));
    const total = cmdLines.length + outLines.length;
    const size = Math.max(10, Math.min(c.u * 0.045, (p.w * 0.92) / (longest * 0.6), ((p.h - barH) * 0.85) / (Math.max(1, total) * 1.35)));
    const lh = size * 1.35;
    const x0 = p.x + p.w * 0.04;
    let y = p.y + barH + size * 0.8;
    const mono = (s: string) => assEscape(s).replace(/ /g, '\\h');
    // Typing: each character is revealed by karaoke (\k) with an invisible "unsung" colour.
    const perChar = Math.max(2, Math.min(8, Math.round(120 / Math.max(1, [...cmdLines.join('')].length))));
    let delay = 0.4;
    for (const line of cmdLines) {
      const chars = [...line];
      const typed = chars.map((ch) => `{\\k${perChar}}${mono(ch)}`).join('');
      const body = `{\\an7\\pos(${Math.round(x0)},${Math.round(y)})\\fn${c.theme.mono}\\fs${Math.round(size)}\\b400\\bord0\\shad0\\q2\\2a&HFF&\\1c${assTagColor('#E6EDF3')}}{\\1c${assTagColor('#28C840')}\\k0}$\\h{\\1c${assTagColor('#E6EDF3')}}${typed}`;
      ev(c, 'front', 4, delay, body);
      delay += (chars.length * perChar) / 100 + 0.25;
      y += lh;
    }
    outLines.forEach((l) => {
      ev(c, 'front', 4, delay, `{\\an7\\pos(${Math.round(x0)},${Math.round(y)})\\fn${c.theme.mono}\\fs${Math.round(size)}\\b400\\bord0\\shad0\\q2\\1c${assTagColor('#8B949E')}}${mono(l)}`, 120);
      y += lh;
    });
  },

  'screen-zoom-callout': (c) => {
    wavesBackground(c);
    const box: Rect = c.portrait ? { x: 0.05 * c.W, y: 0.22 * c.H, w: 0.9 * c.W, h: 0.42 * c.H } : { x: 0.1 * c.W, y: 0.1 * c.H, w: 0.8 * c.W, h: 0.64 * c.H };
    const vs = videoSlot(c, 'screen');
    const n = (k: string) => slotNumber(c, k)?.value;
    const [x, y, w, h] = [n('x'), n('y'), n('w'), n('h')];
    if (vs && x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0) {
      media(c, { slot: 'screen', kind: 'video', source: vs.source, from: vs.from, rect: box, shape: 'rounded', fit: 'contain', crop: { x, y, w, h }, delay: 0 });
    }
    gradientStroke(c, 'front', 3, 0, roundedRectPath(box.x, box.y, box.w, box.h, c.u * 0.03), box, Math.max(3, c.u * 0.01), 300);
    const label = text(c, 'label');
    if (label) {
      const bw = c.portrait ? 0.8 * c.W : 0.5 * c.W;
      bubble(c, 'label', c.W / 2, box.y + box.h + (c.portrait ? 0.1 : 0.12) * c.H, bw, (c.portrait ? 0.08 : 0.13) * c.H, 'down-left', label, 0.4);
    }
  },

  'cta-subscribe': (c) => {
    const msg = text(c, 'text') ?? '';
    const btn = text(c, 'button') ?? '';
    const by = c.H * (c.portrait ? 0.68 : 0.8);
    const f = fitText(msg, c.W * 0.86, c.H * 0.12, c.u * 0.06, c.u * 0.03);
    ev(c, 'front', 4, 0.1, textAt(c.W / 2, by - c.u * 0.12, 2, { font: c.theme.font, size: f.size, color: '#FFFFFF', bold: true, outline: { color: '#000000', width: f.size * 0.12 } }, f.lines), 250);
    const bs = c.u * 0.055;
    const bw = Math.max(c.u * 0.4, textWidthEm(btn) * bs + bs * 2.4);
    const bh = bs * 2;
    region(c, 'button', { x: c.W / 2 - bw / 2, y: by - bh / 2, w: bw, h: bh });
    const pop = '\\fscx30\\fscy30\\t(0,200,\\fscx110\\fscy110)\\t(200,300,\\fscx100\\fscy100)\\t(1300,1400,\\fscx92\\fscy92)\\t(1400,1500,\\fscx100\\fscy100)';
    ev(c, 'front', 5, 0.3, drawingAt(c.W / 2, by, `${fillTags('#FF0033')}${pop}`, roundedRectPath(0, 0, bw, bh, bh / 2)), 100);
    ev(c, 'front', 6, 0.3, textAt(c.W / 2, by, 5, { font: c.theme.font, size: bs, color: '#FFFFFF', bold: true, extra: pop }, [btn]), 100);
  },
};

export const PATTERN_RENDERERS = Object.keys(RENDERERS);

/** Render one scene (pure). Returns null for an unknown pattern. */
export function renderScene(scene: Scene, t: Pick<Timeline, 'sources' | 'canvas'>, custom?: Record<string, PatternDef>): SceneRender | null {
  const r = resolvePattern(scene.pattern.id, custom);
  if (!r) return null;
  const fn = RENDERERS[r.renderer];
  if (!fn || scene.range.end <= scene.range.start) return null;
  const W = t.canvas.width;
  const H = t.canvas.height;
  const out: SceneRender = { back: [], front: [], media: [], regions: [] };
  const animIn = scene.animation?.in ?? r.def.animation.in[0] ?? 'fade';
  const animOut = scene.animation?.out ?? r.def.animation.out[0] ?? 'fade';
  fn({
    W, H, u: Math.min(W, H), portrait: H > W, fps: fpsValue(t.canvas.fps), scene, def: r.def, theme: r.theme, animIn,
    fadeOutMs: animOut === 'fade' ? 250 : 0, out, t,
  });
  return out;
}

export interface ScenesAss {
  /** Backgrounds and frames (under scene media). */
  back: string | null;
  /** Bubbles, texts, rings (over scene media). */
  front: string | null;
  media: MediaPlacement[];
  /** Scenes that could not be rendered (unknown pattern). */
  unknown: string[];
}

function assFile(canvas: Canvas, theme: { font: string }, events: string[]): string {
  const style = assStyleLine({ name: 'Scene', font: theme.font, size: 48, primary: '#FFFFFF', outline: '#000000', outlineWidth: 0, alignment: 7 });
  return `${assHeader(canvas, [style])}\n${events.join('\n')}\n`;
}

/** All scenes of a timeline as two ASS files plus media placements. */
export function renderScenes(t: Pick<Timeline, 'sources' | 'canvas' | 'scenes'>, custom?: Record<string, PatternDef>): ScenesAss {
  const back: string[] = [];
  const front: string[] = [];
  const media: MediaPlacement[] = [];
  const unknown: string[] = [];
  for (const s of t.scenes) {
    const r = renderScene(s, t, custom);
    if (!r) {
      unknown.push(s.id);
      continue;
    }
    back.push(...r.back);
    front.push(...r.front);
    media.push(...r.media);
  }
  const font = { font: 'Noto Sans JP' };
  return {
    back: back.length ? assFile(t.canvas, font, back) : null,
    front: front.length ? assFile(t.canvas, font, front) : null,
    media,
    unknown,
  };
}

/** Short content hash for generated file names. */
export function contentId(s: string): string {
  return sha256Hex(s).slice(0, 16);
}
