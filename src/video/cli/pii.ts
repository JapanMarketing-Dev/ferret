import type { Mask, Op } from '@video/core';

// PII masks from derived/analysis/pii.<sourceId>.json. The desktop app owns these masks (it adds them after OCR);
// this is the same recipe as apps/desktop/src/shared/analysis.ts `piiMaskOps`, so the ids are identical and either
// side skips what the other already added.

export type PiiKind = 'email' | 'phone' | 'token';
interface NBox { x: number; y: number; w: number; h: number }
export interface PiiFile {
  schema?: 1;
  source?: string;
  /** Analysis samples per second, and the source frame rate (`f` is a source frame). */
  fps?: number;
  sourceFps?: number;
  width?: number;
  height?: number;
  frames: { f: number; t?: number; changed?: boolean; boxes: (NBox & { kind: string; label?: string; text?: string })[] }[];
}

const MASK_REASON: Record<PiiKind, Mask['reason']> = { email: 'pii:email', phone: 'pii:phone', token: 'pii:token' };
const isKind = (k: string): k is PiiKind => k === 'email' || k === 'phone' || k === 'token';

function iou(a: NBox, b: NBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

interface Track { kind: PiiKind; label: string; points: { f: number; box: NBox }[] }

/** A hit continues a same-kind track whose last box overlaps it (IoU ≥ 0.3) within `maxGapFrames`. */
export function trackHits(frames: PiiFile['frames'], maxGapFrames: number): Track[] {
  const tracks: Track[] = [];
  for (const fr of frames) {
    for (const b of fr.boxes) {
      if (!isKind(b.kind)) continue;
      const box = { x: b.x, y: b.y, w: b.w, h: b.h };
      const t = tracks.find((tr) => {
        const last = tr.points[tr.points.length - 1]!;
        return tr.kind === b.kind && fr.f - last.f <= maxGapFrames && fr.f > last.f && iou(last.box, box) >= 0.3;
      });
      if (t) t.points.push({ f: fr.f, box });
      else tracks.push({ kind: b.kind, label: b.label ?? b.kind, points: [{ f: fr.f, box }] });
    }
  }
  return tracks;
}

/** FNV-1a 32-bit, base 36. */
export function fnv36(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function piiMaskId(sourceId: string, kind: string, firstFrame: number, firstBox: { x: number; y: number }): string {
  return `mask_pii_${fnv36(`${sourceId}:${kind}:${firstFrame}:${Math.round(firstBox.x * 100)}:${Math.round(firstBox.y * 100)}`)}`;
}

/**
 * addMask ops (source pixels at source frames, needsReview); ids already in `existing` are skipped. The last point
 * is held until the next sample. `size` / `sourceFps` fill in what an older file lacks.
 */
export function piiMaskOps(file: PiiFile, sourceId: string, existing: Set<string>, o: { size: { width: number; height: number }; sourceFps: number; kinds?: string[]; maskKind?: Mask['kind'] }): Op[] {
  const width = file.width ?? o.size.width;
  const height = file.height ?? o.size.height;
  const sourceFps = file.sourceFps ?? o.sourceFps;
  const step = Math.max(1, Math.round(sourceFps / Math.max(0.1, file.fps ?? sourceFps)));
  const frames = o.kinds ? file.frames.map((fr) => ({ ...fr, boxes: fr.boxes.filter((b) => o.kinds!.includes(b.kind)) })) : file.frames;
  const ops: Op[] = [];
  for (const tr of trackHits(frames, step * 2)) {
    const first = tr.points[0]!;
    const id = piiMaskId(sourceId, tr.kind, first.f, first.box);
    if (existing.has(id)) continue;
    existing.add(id);
    const px = (b: NBox) => ({ x: Math.round(b.x * width), y: Math.round(b.y * height), w: Math.max(1, Math.round(b.w * width)), h: Math.max(1, Math.round(b.h * height)) });
    const pts = [...tr.points];
    const last = pts[pts.length - 1]!;
    pts.push({ f: last.f + step - 1, box: last.box });
    ops.push({
      op: 'addMask',
      mask: {
        id, kind: o.maskKind ?? 'pixelate', source: sourceId, reason: MASK_REASON[tr.kind],
        track: pts.map((pt) => ({ frame: pt.f, box: px(pt.box), confidence: 0.8 })),
        decided: { by: 'rule', reason: `OCR found ${tr.label} on screen`, confidence: 0.8, needsReview: true },
      },
    });
  }
  return ops;
}
