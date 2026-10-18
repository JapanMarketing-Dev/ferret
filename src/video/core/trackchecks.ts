import { layoutAt, maskBoxAt, sourceBoxToCanvasAt } from './layout.js';
import type { Op } from './ops.js';
import { PRESETS } from './presets.js';
import type { CheckFinding, Mask, Rect, Target, Timeline } from './schema.js';
import { fpsValue } from './time.js';
import { allIds, freshId, sourceLocalSeconds, takeFrameToSeconds, videoSources } from './timeline.js';
import { faceFrameSec, type Tracks } from './tracks.js';

/** derived/analysis/pii.<sourceId>.json: detected private text per source frame (normalized boxes). */
export interface PiiAnalysis {
  frames: { f: number; t?: number; boxes: { x: number; y: number; w: number; h: number; kind: string; text?: string }[] }[];
  /** Frames per second of `f` in older files; samples per second when `sourceFps` is given. */
  fps?: number;
  /** Frame rate of the source file: `f` counts source frames at this rate. */
  sourceFps?: number;
}

function intersect(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Caption frames to sample: start, middle, last frame. */
function sampleFrames(r: { start: number; end: number }): number[] {
  return [...new Set([r.start, Math.floor((r.start + r.end) / 2), r.end - 1])].filter((f) => f >= r.start && f < r.end);
}

/**
 * caption-face-overlap: caption rects (layoutAt estimates) against face boxes from face tracks mapped onto the canvas
 * (layout, crop focus and zoom). A caption covering more than `minOverlap` (default 15 %) of a face is reported;
 * whether it actually hurts (mouth vs forehead) is for a human / the decision model → needs-human.
 */
export function checkCaptionFaceOverlap(t: Timeline, tracks: Tracks, o: { minOverlap?: number; captionSize?: number } = {}): CheckFinding {
  const items: NonNullable<CheckFinding['items']> = [];
  const lo = o.captionSize !== undefined ? { captionSize: o.captionSize } : {};
  for (const c of t.captions) {
    for (const frame of sampleFrames(c.range)) {
      const capRect = layoutAt(t, frame, lo).find((i) => i.kind === 'caption' && i.id === c.id)?.rect;
      if (!capRect) continue;
      const hit = t.segments.find((s) => frame >= s.range.start && frame < s.range.end);
      if (!hit) continue;
      let worst = 0;
      for (const id of videoSources(hit.video)) {
        const src = t.sources[id];
        const track = tracks.faces?.[id];
        if (!src || src.kind !== 'camera' || !track) continue;
        const { rects } = sourceBoxToCanvasAt(t, frame, id, (sf) => {
          const at = sf / fpsValue(src.fps);
          const dist = (fr: { f: number; t?: number }) => Math.abs(faceFrameSec(track, fr) - at);
          const near = track.frames.reduce<typeof track.frames[number] | null>((best, fr) => (dist(fr) < 0.5 && (!best || dist(fr) < dist(best)) ? fr : best), null);
          const face = near?.faces.filter((x) => x.score >= 0.3).sort((p, q) => q.w * q.h - p.w * p.h)[0];
          return face ? { x: face.x * src.size.width, y: face.y * src.size.height, w: face.w * src.size.width, h: face.h * src.size.height } : null;
        });
        for (const r of rects) worst = Math.max(worst, intersect(r, capRect) / (r.w * r.h));
      }
      if (worst > (o.minOverlap ?? 0.15)) {
        items.push({ frame, ref: c.id, note: `caption covers ${Math.round(worst * 100)}% of a face` });
        break;
      }
    }
  }
  return {
    check: 'caption-face-overlap',
    status: items.length ? 'needs-human' : 'pass',
    note: items.length ? `${items.length} caption(s) over a face` : 'no caption covers a face',
    items,
  };
}

/** The safe rectangle of a target preset at an output size. */
export function safeRect(target: Target | 'preview', size: { width: number; height: number }): Rect {
  const sa = PRESETS[target].safeArea;
  if ('titleSafe' in sa) {
    const mx = (size.width * (1 - sa.titleSafe)) / 2;
    const my = (size.height * (1 - sa.titleSafe)) / 2;
    return { x: Math.round(mx), y: Math.round(my), w: Math.round(size.width - 2 * mx), h: Math.round(size.height - 2 * my) };
  }
  // insets are defined for 1080×1920; scale to the output
  const kx = size.width / 1080;
  const ky = size.height / 1920;
  return { x: Math.round(sa.left * kx), y: Math.round(sa.top * ky), w: Math.round(size.width - (sa.left + sa.right) * kx), h: Math.round(size.height - (sa.top + sa.bottom) * ky) };
}

/** caption-safe-area for one target: every caption rect (estimated) must lie inside the preset's safe area. */
export function checkCaptionSafeArea(t: Timeline, target: Target, o: { captionSize?: number } = {}): CheckFinding {
  const preset = PRESETS[target];
  const out = preset.size ?? { width: t.canvas.width, height: t.canvas.height };
  const safe = safeRect(target, out);
  const sx = out.width / t.canvas.width;
  const sy = out.height / t.canvas.height;
  const items: NonNullable<CheckFinding['items']> = [];
  const lo = o.captionSize !== undefined ? { captionSize: o.captionSize } : {};
  for (const c of t.captions) {
    const r = layoutAt(t, c.range.start, lo).find((i) => i.kind === 'caption' && i.id === c.id)?.rect;
    if (!r) continue;
    const x1 = r.x * sx;
    const y1 = r.y * sy;
    const x2 = (r.x + r.w) * sx;
    const y2 = (r.y + r.h) * sy;
    const out1 = [x1 < safe.x - 0.5 && 'left', x2 > safe.x + safe.w + 0.5 && 'right', y1 < safe.y - 0.5 && 'top', y2 > safe.y + safe.h + 0.5 && 'bottom'].filter(Boolean);
    if (out1.length) items.push({ frame: c.range.start, ref: c.id, note: `outside the ${preset.label} safe area (${out1.join(', ')})` });
  }
  return {
    check: 'caption-safe-area',
    status: items.length ? 'fail' : 'pass',
    note: items.length ? `${items.length} caption(s) outside the ${preset.label} safe area` : `all captions inside the ${preset.label} safe area`,
    items,
  };
}

/**
 * mosaic-tracking: every detected private-text box that is visible on screen must be covered by a mask of the same
 * source at that moment (box inside the mask box, 2 px tolerance). Uncovered visible boxes fail.
 */
export function checkMosaicTracking(t: Timeline, pii: Record<string, PiiAnalysis>): CheckFinding {
  const items: NonNullable<CheckFinding['items']> = [];
  const F = fpsValue(t.canvas.fps);
  for (const [sourceId, analysis] of Object.entries(pii)) {
    const src = t.sources[sourceId];
    if (!src || (src.kind !== 'screen' && src.kind !== 'camera')) continue;
    const sfps = src.fps.num / src.fps.den;
    // `f` counts source frames when the file names the source rate (the desktop writes fps = samples per second)
    const afps = analysis.sourceFps ?? analysis.fps ?? sfps;
    const drift = src.kind === 'camera' && src.drift ? src.drift : 1;
    const masks = t.masks.filter((m) => m.source === sourceId);
    for (const seg of t.segments) {
      if (!videoSources(seg.video).includes(sourceId)) continue;
      const la = sourceLocalSeconds(t, src, takeFrameToSeconds(t, seg.src.take, seg.src.from));
      const lb = sourceLocalSeconds(t, src, takeFrameToSeconds(t, seg.src.take, seg.src.to));
      for (const fr of analysis.frames) {
        const sec = typeof fr.t === 'number' && Number.isFinite(fr.t) ? fr.t : fr.f / afps;
        if (sec < la || sec >= lb) continue;
        const frame = Math.min(seg.range.end - 1, seg.range.start + Math.round(((sec - la) / drift) * F));
        const sourceFrame = sec * sfps;
        for (const b of fr.boxes) {
          const box: Rect = { x: b.x * src.size.width, y: b.y * src.size.height, w: b.w * src.size.width, h: b.h * src.size.height };
          if (!sourceBoxToCanvasAt(t, frame, sourceId, box).rects.length) continue; // cropped away: not visible
          const covered = masks.some((m) => {
            const mb = maskBoxAt(m, sourceFrame);
            return mb && mb.x <= box.x + 2 && mb.y <= box.y + 2 && mb.x + mb.w >= box.x + box.w - 2 && mb.y + mb.h >= box.y + box.h - 2;
          });
          if (!covered) items.push({ frame, ref: sourceId, note: `${b.kind}${b.text ? ` "${b.text}"` : ''} is visible without a mask` });
        }
      }
    }
  }
  // report each uncovered item once (its first frame)
  items.sort((p, q) => p.frame - q.frame);
  const seen = new Set<string>();
  const dedup = items.filter((i) => {
    const k = `${i.ref}:${i.note}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    check: 'mosaic-tracking',
    status: dedup.length ? 'fail' : 'pass',
    note: dedup.length ? `${dedup.length} visible private text item(s) without a mask` : 'all detected private text is masked',
    items: dedup,
  };
}

const REASONS: Record<string, Mask['reason']> = {
  email: 'pii:email', 'pii:email': 'pii:email', phone: 'pii:phone', 'pii:phone': 'pii:phone', token: 'pii:token', apikey: 'pii:token',
  'api-key': 'pii:token', 'pii:token': 'pii:token', address: 'pii:address', 'pii:address': 'pii:address', notification: 'notification',
  face: 'face', plate: 'plate',
};

/**
 * Masks from a PII analysis: boxes are linked across frames into tracks (same kind and text, overlapping or near),
 * a track ends after `maxGapFrames` without a match, boxes are padded (default 15 % each side, clipped to the
 * frame), redundant keyframes dropped. Every mask is marked needsReview. Returns addMask ops.
 */
export function masksFromPii(analysis: PiiAnalysis, sourceId: string, o: { size: { width: number; height: number }; sourceFps?: number;
  pad?: number; maxGapFrames?: number; kinds?: string[]; kind?: Mask['kind']; taken?: Set<string> }): Op[] {
  const pad = o.pad ?? 0.15;
  const gap = o.maxGapFrames ?? 15;
  const W = o.size.width;
  const H = o.size.height;
  const scale = o.sourceFps && analysis.fps ? o.sourceFps / analysis.fps : 1;
  type Tr = { kind: string; text?: string; last: number; keys: { frame: number; box: Rect }[] };
  const tracks: Tr[] = [];
  const frames = [...analysis.frames].sort((a, b) => a.f - b.f);
  for (const fr of frames) {
    const f = Math.round(fr.f * scale);
    for (const b of fr.boxes) {
      if (o.kinds && !o.kinds.includes(b.kind)) continue;
      const px: Rect = { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H };
      const live = tracks.filter((tr) => tr.kind === b.kind && f - tr.last <= gap && f > tr.last && (tr.text === undefined || b.text === undefined || tr.text === b.text));
      const near = live
        .map((tr) => {
          const lb = tr.keys[tr.keys.length - 1]!.box;
          const d = Math.hypot(lb.x + lb.w / 2 - (px.x + px.w / 2), lb.y + lb.h / 2 - (px.y + px.h / 2));
          return { tr, d, ok: intersect(lb, px) > 0 || d < Math.max(lb.w, lb.h, px.w, px.h) };
        })
        .filter((x) => x.ok)
        .sort((p, q) => p.d - q.d)[0];
      if (near) {
        near.tr.keys.push({ frame: f, box: px });
        near.tr.last = f;
      } else {
        tracks.push({ kind: b.kind, ...(b.text !== undefined ? { text: b.text } : {}), last: f, keys: [{ frame: f, box: px }] });
      }
    }
  }
  const padBox = (r: Rect): Rect => {
    const x = Math.max(0, r.x - r.w * pad);
    const y = Math.max(0, r.y - r.h * pad);
    const x2 = Math.min(W, r.x + r.w * (1 + pad));
    const y2 = Math.min(H, r.y + r.h * (1 + pad));
    // round outward but never past the frame
    const xi = Math.max(0, Math.round(x));
    const yi = Math.max(0, Math.round(y));
    return { x: xi, y: yi, w: Math.max(1, Math.min(W, Math.round(x2)) - xi), h: Math.max(1, Math.min(H, Math.round(y2)) - yi) };
  };
  const taken = new Set(o.taken ?? []);
  const ops: Op[] = [];
  tracks.forEach((tr, i) => {
    // keep the first, the last, and any key whose box differs from linear interpolation by > 2 px
    const keys = tr.keys.map((k) => ({ frame: k.frame, box: padBox(k.box) }));
    const kept = keys.filter((k, j) => {
      if (j === 0 || j === keys.length - 1) return true;
      const a = keys[j - 1]!;
      const b = keys[j + 1]!;
      const u = (k.frame - a.frame) / (b.frame - a.frame);
      const lerp = (p: number, q: number) => p + (q - p) * u;
      return Math.abs(lerp(a.box.x, b.box.x) - k.box.x) > 2 || Math.abs(lerp(a.box.y, b.box.y) - k.box.y) > 2
        || k.box.w !== a.box.w || k.box.h !== a.box.h || b.frame - a.frame > gap;
    });
    const base = `mask_pii_${i + 1}`;
    const id = taken.has(base) ? freshId(`${base}_`, taken) : base;
    taken.add(id);
    const mask: Mask = {
      id, kind: o.kind ?? 'pixelate', source: sourceId, reason: REASONS[tr.kind.toLowerCase()] ?? 'manual',
      track: kept.map((k) => ({ frame: k.frame, box: k.box, confidence: 0.8 })),
      decided: { by: 'rule', reason: `detected ${tr.kind}${tr.text ? ` (${tr.text.slice(0, 3)}…)` : ''}; padded ${Math.round(pad * 100)}%`, needsReview: true },
    };
    ops.push({ op: 'addMask', mask });
  });
  return ops;
}

/** Ids in use, for masksFromPii({ taken }). */
export function maskIdsTaken(t: Timeline): Set<string> {
  return allIds(t);
}

