// Analysis tracks (faces, cursor, keys) → smoothed focus paths and input overlays. Pure: callers read the files.
//   derived/analysis/faces.<sourceId>.json  = FaceTrack (source frames, normalized 0..1 boxes)
//   derived/analysis/cursor.<takeId>.jsonl  = CursorEvent per line (take time, normalized to the captured display)
//   derived/analysis/keys.<takeId>.jsonl    = KeyEvent per line (take time)

export interface FaceTrack {
  /** Samples per second of the analysis (the desktop samples at 5 fps). */
  fps: number;
  /** Frame rate of the source file: `f` counts source frames at this rate. */
  sourceFps?: number;
  /**
   * `f`: source frame; `t`: source seconds (when given, it is the time). `gaze` (0..1, looking at the lens) and `sharp`
   * (0..1 focus/exposure quality) are optional detector extras.
   */
  frames: { f: number; t?: number; faces: FaceBox[]; sharp?: number }[];
}
export interface FaceBox { x: number; y: number; w: number; h: number; score: number; gaze?: number }

/**
 * Source seconds of a face-track frame: its `t`, else `f` over the source frame rate. (`fps` is the sampling rate when
 * `sourceFps` is present — dividing `f` by it put every face 6× too late — and the frame rate in older files.)
 */
export function faceFrameSec(track: Pick<FaceTrack, 'fps' | 'sourceFps'>, fr: { f: number; t?: number }): number {
  if (typeof fr.t === 'number' && Number.isFinite(fr.t)) return fr.t;
  const rate = track.sourceFps && track.sourceFps > 0 ? track.sourceFps : track.fps > 0 ? track.fps : 30;
  return fr.f / rate;
}
export interface CursorEvent { t_ms: number; x: number; y: number; click?: boolean }
export interface KeyEvent { t_ms: number; keys: string[] }

/** Everything the CLI/desktop loaded for a project (keys: source id for faces/cuts, take id for cursor/keys). */
export interface Tracks {
  faces?: Record<string, FaceTrack>;
  cursor?: Record<string, CursorEvent[]>;
  keys?: Record<string, KeyEvent[]>;
  /** Shot changes inside a source (source seconds), e.g. from scene detection: smoothing restarts there. */
  cuts?: Record<string, number[]>;
}

/** A point to follow at time t (seconds in the track's clock), normalized 0..1. */
export interface TrackSample { t: number; x: number; y: number }

/** A focus keyframe: segment-relative frame and a normalized point. */
export interface FocusKey { at: number; x: number; y: number }

/** Parse a .jsonl file's text (blank and malformed lines are skipped). */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // a torn last line while recording: skip
    }
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Face centres per frame: the best face (score × area) per frame, with headroom (the point sits a little below the
 * eyes so a vertical crop keeps the head in the upper third). Frames without faces are skipped.
 */
export function faceSamples(track: FaceTrack, o: { headroom?: number; minScore?: number } = {}): TrackSample[] {
  const out: TrackSample[] = [];
  for (const fr of track.frames) {
    const faces = fr.faces.filter((f) => f.score >= (o.minScore ?? 0.3) && f.w > 0 && f.h > 0);
    if (!faces.length) continue;
    const best = faces.reduce((a, b) => (b.score * b.w * b.h > a.score * a.w * a.h ? b : a));
    out.push({ t: faceFrameSec(track, fr), x: clamp01(best.x + best.w / 2), y: clamp01(best.y + best.h / 2 + best.h * (o.headroom ?? 0.6)) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function cursorSamples(events: CursorEvent[]): TrackSample[] {
  return events
    .filter((e) => Number.isFinite(e.t_ms) && Number.isFinite(e.x) && Number.isFinite(e.y))
    .map((e) => ({ t: e.t_ms / 1000, x: clamp01(e.x), y: clamp01(e.y) }))
    .sort((a, b) => a.t - b.t);
}

/** Linear interpolation of samples at time t (holds the ends); null without samples. */
export function sampleAt(samples: TrackSample[], t: number): { x: number; y: number } | null {
  if (!samples.length) return null;
  if (t <= samples[0]!.t) return { x: samples[0]!.x, y: samples[0]!.y };
  const last = samples[samples.length - 1]!;
  if (t >= last.t) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/** One-euro filter (Casiez et al.): smooth when slow, responsive when fast. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  constructor(private minCutoff: number, private beta: number, private dCutoff = 1) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
  next(v: number, dt: number): number {
    if (this.x === null) {
      this.x = v;
      return v;
    }
    const d = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export interface FocusPathOptions {
  /** Time range in the samples' clock (seconds). */
  fromSec: number;
  toSec: number;
  /** Output frame rate (keyframe `at` is in frames from fromSec at this rate). */
  fps: number;
  /** Shot changes (seconds, samples' clock): the path jumps there instead of panning across. */
  cuts?: number[];
  /** One-euro parameters (defaults tuned for a calm virtual camera: 0.4 Hz, beta 0.6). */
  minCutoff?: number;
  beta?: number;
  /** Ignore movements smaller than this (normalized) — the camera holds still. Default 0.04. */
  deadZone?: number;
  /** Keyframe reduction tolerance (normalized). Default 0.01. */
  tolerance?: number;
  /** Used when there are no samples in the range. Default centre. */
  fallback?: { x: number; y: number };
}

/** Drop keyframes that linear interpolation between their neighbours reproduces within `tol` (keeps cut pairs). */
function reduce(keys: FocusKey[], tol: number, keep: Set<number>): FocusKey[] {
  if (keys.length <= 2) return keys;
  const out: FocusKey[] = [keys[0]!];
  for (let i = 1; i < keys.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const cur = keys[i]!;
    const next = keys[i + 1]!;
    if (keep.has(cur.at) || keep.has(next.at)) {
      out.push(cur);
      continue;
    }
    const u = (cur.at - prev.at) / (next.at - prev.at);
    const ex = prev.x + (next.x - prev.x) * u;
    const ey = prev.y + (next.y - prev.y) * u;
    if (Math.abs(ex - cur.x) > tol || Math.abs(ey - cur.y) > tol) out.push(cur);
  }
  out.push(keys[keys.length - 1]!);
  return out;
}

/**
 * A smoothed, cut-aware focus path over [fromSec, toSec): resample the track per output frame, hold within a dead
 * zone, one-euro smooth (restarting at cuts so the virtual camera cuts with the shot), then reduce to keyframes.
 */
export function focusPath(samples: TrackSample[], o: FocusPathOptions): FocusKey[] {
  const fps = o.fps > 0 ? o.fps : 30;
  const n = Math.max(1, Math.round((o.toSec - o.fromSec) * fps));
  const inRange = samples.filter((s) => s.t >= o.fromSec - 1 && s.t <= o.toSec + 1);
  const fb = o.fallback ?? { x: 0.5, y: 0.5 };
  if (!inRange.length) return [{ at: 0, x: fb.x, y: fb.y }];
  const fx = new OneEuro(o.minCutoff ?? 0.4, o.beta ?? 0.6);
  const fy = new OneEuro(o.minCutoff ?? 0.4, o.beta ?? 0.6);
  const dz = o.deadZone ?? 0.04;
  const cutFrames = new Set((o.cuts ?? []).filter((c) => c > o.fromSec && c < o.toSec).map((c) => Math.round((c - o.fromSec) * fps)));
  const keys: FocusKey[] = [];
  let held: { x: number; y: number } | null = null;
  for (let i = 0; i < n; i++) {
    const raw = sampleAt(inRange, o.fromSec + i / fps)!;
    if (cutFrames.has(i)) {
      fx.reset();
      fy.reset();
      held = null;
    }
    if (!held || Math.hypot(raw.x - held.x, raw.y - held.y) > dz) held = raw;
    const x = clamp01(fx.next(held.x, 1 / fps));
    const y = clamp01(fy.next(held.y, 1 / fps));
    if (cutFrames.has(i) && keys.length) {
      // hard cut: repeat the previous value on the frame before, then jump
      const prev = keys[keys.length - 1]!;
      if (prev.at !== i - 1) keys.push({ at: i - 1, x: prev.x, y: prev.y });
    }
    keys.push({ at: i, x, y });
  }
  const keep = new Set<number>();
  for (const c of cutFrames) {
    keep.add(c);
    keep.add(c - 1);
  }
  const r = reduce(keys, o.tolerance ?? 0.01, keep).map((k) => ({ at: k.at, x: round4(k.x), y: round4(k.y) }));
  return r;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Cover-crop focus (fraction of the cropped-away margin) that centres a normalized source point in a region, for a
 * cover crop magnified by `scale` (≥ 1). Returns 0.5 on an axis that is not cropped.
 */
export function focusForPoint(p: { x: number; y: number }, source: { width: number; height: number }, region: { width: number; height: number }, scale = 1): { x: number; y: number } {
  const k = Math.max(region.width / source.width, region.height / source.height) * Math.max(1, scale);
  const vw = region.width / (source.width * k); // visible fraction of the source width
  const vh = region.height / (source.height * k);
  const axis = (c: number, v: number) => (v >= 0.9999 ? 0.5 : clamp01((c - v / 2) / (1 - v)));
  return { x: round4(axis(p.x, vw)), y: round4(axis(p.y, vh)) };
}

/** Linear interpolation of focus keyframes at a frame (holds the ends). */
export function focusAt(keys: FocusKey[], at: number): { x: number; y: number } {
  if (keys.length === 0) return { x: 0.5, y: 0.5 };
  const s = keys.map((k) => ({ t: k.at, x: k.x, y: k.y }));
  return sampleAt(s, at)!;
}

const MODIFIERS = /^(⌘|cmd|command|ctrl|control|⌃|alt|option|⌥|shift|⇧|win|meta|super)$/i;

/** True for a shortcut (a modifier plus another key), not plain typing. */
export function isShortcut(keys: string[]): boolean {
  return keys.some((k) => MODIFIERS.test(k)) && keys.some((k) => !MODIFIERS.test(k));
}
