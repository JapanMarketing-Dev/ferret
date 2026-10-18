import { wipeGeometry } from './compile.js';
import type { PatternDef } from './patterns/defs.js';
import { textWidthEm } from './patterns/draw.js';
import { renderScene } from './patterns/render.js';
import { focusAt } from './tracks.js';
import type { Canvas, Focus, FocusValue, Frame, Mask, Rect, Segment, Source, Timeline } from './schema.js';
import { fpsValue } from './time.js';
import { sourceLocalSeconds, takeFrameToSeconds, timelineFrameToTake } from './timeline.js';

/** Something visible at a frame, with its on-screen rectangle (for mapping pen strokes to timeline elements). */
export interface LayoutItem {
  kind: 'caption' | 'overlay' | 'scene-slot' | 'scene' | 'mask' | 'wipe' | 'video';
  /** Element id (caption / overlay / scene / mask id, or the segment id for video and wipe). */
  id: string;
  /** Scene slot name (scene-slot). */
  slot?: string;
  /** Source shown (video, wipe, mask). */
  source?: string;
  /** Segment the frame belongs to (video, wipe, mask). */
  segment?: string;
  rect: Rect;
}

export interface LayoutOptions {
  /** Output size to express rects in (default: the timeline canvas). */
  canvas?: { width: number; height: number };
  /** Caption font size as a fraction of the canvas short side (default 0.06). Captions are estimated from their lines. */
  captionSize?: number;
  patterns?: Record<string, PatternDef>;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function clip(r: Rect, to: Rect): Rect | null {
  const x1 = Math.max(r.x, to.x);
  const y1 = Math.max(r.y, to.y);
  const x2 = Math.min(r.x + r.w, to.x + to.w);
  const y2 = Math.min(r.y + r.h, to.y + to.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

type Fit = 'cover' | 'fit';
interface Region { source: string; rect: Rect; fit: Fit; kind: 'video' | 'wipe'; focus?: FocusValue; /** cover-crop magnification (≥ 1) */ scale?: number }

/** Regions of the canvas filled by each source for a segment's layout (same geometry as compile). */
export function videoRegions(seg: Segment, canvas: { width: number; height: number }): Region[] {
  const W = canvas.width;
  const H = canvas.height;
  const full: Rect = { x: 0, y: 0, w: W, h: H };
  const v = seg.video;
  switch (v.layout) {
    case 'camera-full': return [{ source: v.camera, rect: full, fit: 'cover', kind: 'video', ...(v.focus ? { focus: v.focus } : {}), ...(v.scale && v.scale > 1 ? { scale: v.scale } : {}) }];
    case 'screen-full': return [{ source: v.screen, rect: full, fit: 'fit', kind: 'video' }];
    case 'screen-with-wipe': {
      const { d, x, y } = wipeGeometry(v.wipe, W, H);
      return [
        { source: v.camera, rect: { x, y, w: d, h: d }, fit: 'cover', kind: 'wipe', ...(v.cameraFocus ? { focus: v.cameraFocus } : {}), ...(v.cameraScale && v.cameraScale > 1 ? { scale: v.cameraScale } : {}) },
        { source: v.screen, rect: full, fit: 'fit', kind: 'video' },
      ];
    }
    case 'split-v': {
      const th = even(H / 2);
      return [
        { source: v.top, rect: { x: 0, y: 0, w: W, h: th }, fit: 'cover', kind: 'video', ...(v.topFocus ? { focus: v.topFocus } : {}) },
        { source: v.bottom, rect: { x: 0, y: th, w: W, h: H - th }, fit: 'cover', kind: 'video', ...(v.bottomFocus ? { focus: v.bottomFocus } : {}) },
      ];
    }
    case 'scene': return [];
  }
}

/** Map a rect in source pixels into a region (cover = centre crop, fit = letterbox). */
export function sourceRectToCanvas(box: Rect, size: { width: number; height: number }, region: Rect, fit: Fit, focus?: Focus, scale = 1): Rect | null {
  const k = fit === 'cover' ? Math.max(region.w / size.width, region.h / size.height) * Math.max(1, scale) : Math.min(region.w / size.width, region.h / size.height);
  const fx = fit === 'cover' ? focus?.x ?? 0.5 : 0.5;
  const fy = fit === 'cover' ? focus?.y ?? 0.5 : 0.5;
  const ox = region.x + (region.w - size.width * k) * fx;
  const oy = region.y + (region.h - size.height * k) * fy;
  return clip({ x: ox + box.x * k, y: oy + box.y * k, w: box.w * k, h: box.h * k }, region);
}

/** Zoom (scale, focus) of a segment at a frame relative to its start; mirrors compile's punch-in. */
function zoomAt(seg: Segment, rel: number, W: number, H: number, canvas: Canvas): { s: number; fx: number; fy: number } {
  const keys = [...(seg.zoom ?? [])].sort((a, b) => a.at - b.at);
  const focus = (f: NonNullable<Segment['zoom']>[number]['value']['focus']) => (f === 'face' ? { x: W / 2, y: H * 0.4 }
    : f === 'cursor' ? { x: W / 2, y: H / 2 } : { x: (f.x * W) / canvas.width, y: (f.y * H) / canvas.height });
  let s = 1;
  let p = { x: W / 2, y: H / 2 };
  if (keys.length) {
    const i = keys.findIndex((k) => k.at > rel);
    const a = i === -1 ? keys[keys.length - 1]! : keys[Math.max(0, i - 1)]!;
    if (i <= 0 || a.ease === 'hold') {
      // before the first key, after the last, or holding: the nearest key's value (compile clamps the same way)
      const k = i === 0 ? keys[0]! : a;
      s = k.value.scale;
      p = focus(k.value.focus);
    } else {
      const b = keys[i]!;
      const w = (rel - a.at) / (b.at - a.at);
      const pa = focus(a.value.focus);
      const pb = focus(b.value.focus);
      s = a.value.scale + (b.value.scale - a.value.scale) * w;
      p = { x: pa.x + (pb.x - pa.x) * w, y: pa.y + (pb.y - pa.y) * w };
    }
  }
  if (seg.transitionIn?.kind === 'jump-zoom' && rel < seg.transitionIn.frames) s *= 1.12;
  return { s, fx: p.x, fy: p.y };
}

function zoomRect(r: Rect, z: { s: number; fx: number; fy: number }, W: number, H: number): Rect | null {
  if (z.s <= 1) return r;
  const cw = W / z.s;
  const ch = H / z.s;
  const x0 = Math.min(Math.max(0, z.fx - cw / 2), W - cw);
  const y0 = Math.min(Math.max(0, z.fy - ch / 2), H - ch);
  return clip({ x: (r.x - x0) * z.s, y: (r.y - y0) * z.s, w: r.w * z.s, h: r.h * z.s }, { x: 0, y: 0, w: W, h: H });
}

/** Interpolated mask box at a source frame, or null when the mask is not active. */
export function maskBoxAt(m: Mask, sourceFrame: number): Rect | null {
  const keys = [...m.track].sort((a, b) => a.frame - b.frame);
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (sourceFrame < first.frame || sourceFrame > last.frame + 1) return null;
  if (sourceFrame >= last.frame) return last.box;
  const i = keys.findIndex((k) => k.frame > sourceFrame);
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const u = (sourceFrame - a.frame) / (b.frame - a.frame);
  const cx = a.box.x + a.box.w / 2 + (b.box.x + b.box.w / 2 - a.box.x - a.box.w / 2) * u;
  const cy = a.box.y + a.box.h / 2 + (b.box.y + b.box.h / 2 - a.box.y - a.box.h / 2) * u;
  const w = Math.max(...keys.map((k) => k.box.w));
  const h = Math.max(...keys.map((k) => k.box.h));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Visible elements at a timeline frame with on-screen rects, topmost first: captions, text/image overlays, scene slots,
 * scenes, masks, the wipe, and the segment's video regions. Caption and telop rects are estimates from their text.
 */
export function layoutAt(t: Timeline, frame: Frame, o: LayoutOptions = {}): LayoutItem[] {
  const W = t.canvas.width;
  const H = t.canvas.height;
  const u = Math.min(W, H);
  const fps = fpsValue(t.canvas.fps);
  const items: LayoutItem[] = [];
  const at = (r: { start: number; end: number }) => frame >= r.start && frame < r.end;

  // captions
  for (const c of t.captions) {
    if (!at(c.range)) continue;
    const size = u * (o.captionSize ?? 0.06);
    const lines = c.lines.length ? c.lines : [c.text];
    const w = Math.min(W, Math.max(...lines.map(textWidthEm)) * size + size * 0.4);
    const h = lines.length * size * 1.25;
    const y = c.position.y * H;
    const top = c.position.anchor === 'bottom' ? y - h : c.position.anchor === 'top' ? y : y - h / 2;
    items.push({ kind: 'caption', id: c.id, rect: { x: (W - w) / 2, y: top, w, h } });
  }
  // overlays: later ones are drawn on top
  for (const ov of [...t.overlays].reverse()) {
    if (ov.kind === 'click-ring') {
      if (frame >= ov.at && frame < ov.at + Math.max(1, Math.round(fps * 0.4))) {
        const r = u * 0.03 * 1.4;
        items.push({ kind: 'overlay', id: ov.id, rect: { x: ov.position.x - r, y: ov.position.y - r, w: 2 * r, h: 2 * r } });
      }
      continue;
    }
    if (!at(ov.range)) continue;
    if (ov.kind === 'telop') {
      const size = u * 0.07;
      const lines = ov.text.split('\n');
      const w = Math.max(...lines.map(textWidthEm)) * size;
      const h = lines.length * size * 1.25;
      items.push({ kind: 'overlay', id: ov.id, rect: { x: ov.position.x - w / 2, y: ov.position.y - h / 2, w, h } });
    } else if (ov.kind === 'keystroke') {
      const size = u * 0.045;
      const w = textWidthEm(ov.keys.join(' + ')) * size + size;
      items.push({ kind: 'overlay', id: ov.id, rect: { x: (W - w) / 2, y: H * 0.94 - size * 1.4, w, h: size * 1.4 } });
    } else if (ov.kind === 'image') {
      items.push({ kind: 'overlay', id: ov.id, rect: { ...ov.position } });
    } else {
      const lw = even(u * 0.14);
      const m = Math.round(u * 0.04);
      items.push({ kind: 'overlay', id: ov.id, rect: { x: ov.corner.endsWith('l') ? m : W - lw - m, y: ov.corner.startsWith('t') ? m : H - lw - m, w: lw, h: lw } });
    }
  }
  // scenes
  for (const s of t.scenes) {
    if (!at(s.range)) continue;
    const r = renderScene(s, t, o.patterns);
    if (r) {
      for (const m of [...r.media].reverse()) items.push({ kind: 'scene-slot', id: s.id, slot: m.slot, source: m.source, rect: m.rect });
      for (const g of r.regions) items.push({ kind: 'scene-slot', id: s.id, slot: g.slot, rect: g.rect });
    }
    items.push({ kind: 'scene', id: s.id, rect: { x: 0, y: 0, w: W, h: H } });
  }
  // segment video, wipe, masks
  const hit = timelineFrameToTake(t, frame);
  if (hit) {
    const seg = hit.segment;
    const z = zoomAt(seg, frame - seg.range.start, W, H, t.canvas);
    const regions = videoRegions(seg, t.canvas);
    const takeSec = takeFrameToSeconds(t, hit.take, hit.frame);
    const masks: LayoutItem[] = [];
    const videos: LayoutItem[] = [];
    for (const rg of regions) {
      const src = t.sources[rg.source];
      if (src && (src.kind === 'screen' || src.kind === 'camera')) {
        const localFrame = sourceLocalSeconds(t, src as Source, takeSec) * fpsValue(src.fps);
        for (const m of t.masks) {
          if (m.source !== rg.source) continue;
          const box = maskBoxAt(m, localFrame);
          const onCanvas = box && sourceRectToCanvas(box, src.size, rg.rect, rg.fit, rg.focus === undefined ? undefined : Array.isArray(rg.focus) ? focusAt(rg.focus, frame - seg.range.start) : rg.focus, rg.scale);
          const zr = onCanvas && zoomRect(onCanvas, z, W, H);
          if (zr) masks.push({ kind: 'mask', id: m.id, source: rg.source, segment: seg.id, rect: zr });
        }
      }
      const zr = zoomRect(rg.rect, z, W, H);
      if (zr) videos.push({ kind: rg.kind, id: seg.id, source: rg.source, segment: seg.id, rect: zr });
    }
    items.push(...masks, ...videos);
  }
  // scale to the requested canvas
  const sx = (o.canvas?.width ?? W) / W;
  const sy = (o.canvas?.height ?? H) / H;
  return items.map((it) => ({
    ...it,
    rect: { x: Math.round(it.rect.x * sx), y: Math.round(it.rect.y * sy), w: Math.round(it.rect.w * sx), h: Math.round(it.rect.h * sy) },
  }));
}

/**
 * Where a box in source pixels appears on the canvas at a timeline frame (one rect per region showing the source,
 * after the cover/fit crop, focus and zoom), clipped to the region. Empty when the source is not shown then.
 * Also returns the source-local frame used (for looking up tracks at the same moment).
 */
export function sourceBoxToCanvasAt(t: Timeline, frame: Frame, sourceId: string, box: Rect | ((sourceFrame: number) => Rect | null)):
  { rects: Rect[]; sourceFrame: number | null } {
  const hit = timelineFrameToTake(t, frame);
  const src = t.sources[sourceId];
  if (!hit || !src || (src.kind !== 'screen' && src.kind !== 'camera')) return { rects: [], sourceFrame: null };
  const seg = hit.segment;
  const W = t.canvas.width;
  const H = t.canvas.height;
  const rel = frame - seg.range.start;
  const z = zoomAt(seg, rel, W, H, t.canvas);
  const sourceFrame = sourceLocalSeconds(t, src, takeFrameToSeconds(t, hit.take, hit.frame)) * fpsValue(src.fps);
  const b = typeof box === 'function' ? box(sourceFrame) : box;
  if (!b) return { rects: [], sourceFrame };
  const rects: Rect[] = [];
  for (const rg of videoRegions(seg, t.canvas)) {
    if (rg.source !== sourceId) continue;
    const f = rg.focus === undefined ? undefined : Array.isArray(rg.focus) ? focusAt(rg.focus, rel) : rg.focus;
    const r = sourceRectToCanvas(b, src.size, rg.rect, rg.fit, f, rg.scale);
    const zr = r && zoomRect(r, z, W, H);
    if (zr) rects.push(zr);
  }
  return { rects, sourceFrame };
}

/** Items whose rect contains the point (topmost first). */
export function hitTest(items: LayoutItem[], x: number, y: number): LayoutItem[] {
  return items.filter((i) => x >= i.rect.x && x < i.rect.x + i.rect.w && y >= i.rect.y && y < i.rect.y + i.rect.h);
}
