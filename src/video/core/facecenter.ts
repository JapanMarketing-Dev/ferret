import type { Focus, Segment, Timeline } from './schema.js';
import { fpsValue } from './time.js';
import { sourceLocalSeconds, takeFrameToSeconds } from './timeline.js';
import type { FaceBox, FaceTrack, FocusKey, FocusPathOptions, Tracks, TrackSample } from './tracks.js';
import { faceFrameSec, focusPath } from './tracks.js';

// Person centring (request 10): keep the person's face in the middle of the camera's frame — the full-screen camera
// and the round wipe — with a smoothed, face-tracked cover crop. Pure: the CLI loads the face tracks
// (derived/analysis/faces.<source>.json) and records the result with setSegments.
//
// Geometry of one axis: the cover crop shows a window of `v` (fraction of the source, 0 < v ≤ 1) starting at
// `a` ∈ [0, 1 − v]. Plain cover gives v0 = region / (source · k); an extra magnification s gives v = v0 / s, which
// lets the window move even on an axis the aspect ratio does not crop (16:9 camera in a 16:9 frame).

export interface CenterOptions {
  /** Largest extra magnification for a full-screen camera (default 1.35: still sharp from a 1080p camera). */
  maxScale?: number;
  /** Largest extra magnification inside the wipe (default 1.6: the wipe is small, so a tighter crop stays sharp). */
  maxWipeScale?: number;
  /** Where the face centre should sit in a full-screen camera (default x 0.5, y 0.45: a little above the middle). */
  target?: { x: number; y: number };
  /** … and in the round wipe (default x 0.5, y 0.55: a circle crops its top, and the face box starts at the brows). */
  wipeTarget?: { x: number; y: number };
  /** Faces below this detector score are ignored (default 0.3). */
  minScore?: number;
  /** Smoothing of the moving crop (one-euro; defaults of focusPath). */
  smoothing?: Partial<Omit<FocusPathOptions, 'fromSec' | 'toSec' | 'fps'>>;
}

export interface CenterReport {
  /** Segments whose camera crop now follows the face. */
  centered: string[];
  /** Segments that show a camera with a face track but no face in their time range (left as they were). */
  noFace: string[];
  /** Segments that show a camera without a face track. */
  noTrack: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Visible fraction of the source on each axis for a plain cover crop of `source` into `region`. */
export function coverVisible(source: { width: number; height: number }, region: { width: number; height: number }): { x: number; y: number } {
  const k = Math.max(region.width / source.width, region.height / source.height);
  return { x: Math.min(1, region.width / (source.width * k)), y: Math.min(1, region.height / (source.height * k)) };
}

/**
 * Extra magnification (≥ 1) so that point `c` (0..1) can sit at `target` (0..1) of a window whose plain-cover width is
 * `v0`: the window must stay inside the source, so v ≤ c / target and v ≤ (1 − c) / (1 − target).
 * Infinity when the point is on the edge itself (it can never be centred).
 */
export function scaleToPlace(c: number, v0: number, target = 0.5): number {
  const cc = clamp(c, 0, 1);
  const t = clamp(target, 0.01, 0.99);
  const vmax = Math.min(v0, cc / t, (1 - cc) / (1 - t));
  if (vmax <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, v0 / vmax);
}

/**
 * Cover-crop focus on one axis (fraction of the cropped-away margin, as compile's `(iw-ow)*f`) that puts `c` at
 * `target` of a window of width `v`; clamped at the source edges. 0.5 when nothing is cropped.
 */
export function axisFocus(c: number, v: number, target = 0.5): number {
  if (v >= 0.9999) return 0.5;
  const a = clamp(c - target * v, 0, 1 - v);
  return round4(a / (1 - v));
}

/** Where `c` ends up in the frame (0..1) for a window of width `v` with focus `f` (the inverse of axisFocus). */
export function placedAt(c: number, v: number, f: number): number {
  const a = v >= 0.9999 ? (1 - v) / 2 : f * (1 - v);
  return (c - a) / v;
}

/**
 * The person's face per analysed frame (centre of the box, source seconds). Several faces: the biggest confident
 * one, but the face picked before keeps the role while it stays nearly as big (no jumping between people).
 */
export function personFaceSamples(track: FaceTrack, o: { minScore?: number } = {}): TrackSample[] {
  const min = o.minScore ?? 0.3;
  const frames = [...track.frames].sort((p, q) => faceFrameSec(track, p) - faceFrameSec(track, q));
  const out: TrackSample[] = [];
  let prev: { x: number; y: number } | null = null;
  const centre = (f: FaceBox) => ({ x: clamp(f.x + f.w / 2, 0, 1), y: clamp(f.y + f.h / 2, 0, 1) });
  for (const fr of frames) {
    const faces = (fr.faces ?? []).filter((f) => f && f.score >= min && f.w > 0 && f.h > 0
      && [f.x, f.y, f.w, f.h].every((n) => Number.isFinite(n)));
    if (!faces.length) continue;
    const size = (f: FaceBox) => f.score * f.w * f.h;
    let best = faces.reduce((a, b) => (size(b) > size(a) ? b : a));
    if (prev) {
      const near = faces
        .filter((f) => Math.hypot(centre(f).x - prev!.x, centre(f).y - prev!.y) <= 0.15)
        .sort((a, b) => size(b) - size(a))[0];
      if (near && size(near) >= 0.5 * size(best)) best = near;
    }
    const c = centre(best);
    out.push({ t: faceFrameSec(track, fr), ...c });
    prev = c;
  }
  return out;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface FaceCrop { focus: Focus | FocusKey[]; scale: number }

/**
 * The crop that keeps the face at `target` over a stretch of samples: one magnification for the whole stretch (the
 * median need, clamped — no breathing zoom) and a smoothed focus path. `fromSec`/`toSec` are in the samples' clock;
 * keyframe `at` counts output frames at `fps` from `fromSec`. Null when no face is seen in the stretch.
 */
export function faceCrop(samples: TrackSample[], o: {
  fromSec: number; toSec: number; fps: number; visible: { x: number; y: number }; maxScale: number;
  target?: { x: number; y: number }; smoothing?: CenterOptions['smoothing'];
}): FaceCrop | null {
  const inRange = samples.filter((s) => s.t >= o.fromSec - 0.5 && s.t <= o.toSec + 0.5);
  if (!inRange.length) return null;
  const target = o.target ?? { x: 0.5, y: 0.45 };
  const need = inRange.map((s) => Math.max(scaleToPlace(s.x, o.visible.x, target.x), scaleToPlace(s.y, o.visible.y, target.y)));
  const finite = need.filter((n) => Number.isFinite(n));
  const scale = round4(clamp(finite.length ? median(finite) : o.maxScale, 1, Math.max(1, o.maxScale)));
  const vx = o.visible.x / scale;
  const vy = o.visible.y / scale;
  const path = focusPath(inRange, { ...o.smoothing, fromSec: o.fromSec, toSec: o.toSec, fps: o.fps });
  const keys = path.map((k) => ({ at: k.at, x: axisFocus(k.x, vx, target.x), y: axisFocus(k.y, vy, target.y) }));
  const dedup = keys.filter((k, i) => i === 0 || i === keys.length - 1 || k.x !== keys[i - 1]!.x || k.y !== keys[i - 1]!.y);
  const still = dedup.every((k) => k.x === dedup[0]!.x && k.y === dedup[0]!.y);
  return { focus: still ? { x: dedup[0]!.x, y: dedup[0]!.y } : dedup, scale };
}

/** Wipe region size on the timeline canvas (same as layout.wipeGeometry: a square of `size` × the short side). */
function wipeSide(t: Timeline, size?: number): number {
  return Math.max(2, Math.round((Math.min(t.canvas.width, t.canvas.height) * (size ?? 0.3)) / 2) * 2);
}

/**
 * Keep the person's face centred in every camera-full shot and every wipe (pure). Segments showing a camera with a
 * face track get `focus` + `scale` (camera-full) or `cameraFocus` + `cameraScale` (wipe); segments without a face in
 * range are left as they are. Screen-only, split and scene segments are untouched.
 */
export function centerPerson(t: Timeline, tracks: Pick<Tracks, 'faces'>, o: CenterOptions = {}): { segments: Segment[]; report: CenterReport } {
  const report: CenterReport = { centered: [], noFace: [], noTrack: [] };
  const F = fpsValue(t.canvas.fps);
  const samplesBySource = new Map<string, TrackSample[]>();
  const samplesOf = (id: string): TrackSample[] | null => {
    const tr = tracks.faces?.[id];
    if (!tr || !Array.isArray(tr.frames)) return null;
    if (!samplesBySource.has(id)) samplesBySource.set(id, personFaceSamples(tr, { minScore: o.minScore }));
    return samplesBySource.get(id)!;
  };
  const segments = t.segments.map((seg) => {
    const v = seg.video;
    if (v.layout !== 'camera-full' && v.layout !== 'screen-with-wipe') return seg;
    const src = t.sources[v.camera];
    if (!src || src.kind !== 'camera') return seg;
    const samples = samplesOf(v.camera);
    if (!samples) {
      report.noTrack.push(seg.id);
      return seg;
    }
    const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
    const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
    const fromSec = sourceLocalSeconds(t, src, a);
    const toSec = sourceLocalSeconds(t, src, b);
    const region = v.layout === 'camera-full'
      ? { width: t.canvas.width, height: t.canvas.height }
      : { width: wipeSide(t, v.wipe.size), height: wipeSide(t, v.wipe.size) };
    const crop = faceCrop(samples, {
      fromSec, toSec, fps: F, visible: coverVisible(src.size, region),
      maxScale: v.layout === 'camera-full' ? o.maxScale ?? 1.35 : o.maxWipeScale ?? 1.6,
      target: v.layout === 'camera-full' ? o.target ?? { x: 0.5, y: 0.45 } : o.wipeTarget ?? { x: 0.5, y: 0.55 },
      ...(o.smoothing ? { smoothing: o.smoothing } : {}),
    });
    if (!crop) {
      report.noFace.push(seg.id);
      return seg;
    }
    report.centered.push(seg.id);
    if (v.layout === 'camera-full') {
      const { focus: _f, scale: _s, ...rest } = v;
      return { ...seg, video: { ...rest, focus: crop.focus, ...(crop.scale > 1 ? { scale: crop.scale } : {}) } };
    }
    const { cameraFocus: _f, cameraScale: _s, ...rest } = v;
    return { ...seg, video: { ...rest, cameraFocus: crop.focus, ...(crop.scale > 1 ? { cameraScale: crop.scale } : {}) } };
  });
  return { segments, report };
}
