import type { Canvas, Frame, Rational, Segment, Source, Target, Timeline } from './schema.js';
import { SCHEMA_VERSION } from './schema.js';
import { convertFrames, frameToSeconds } from './time.js';

export function emptyTimeline(init: {
  title: string;
  kind: 'tech' | 'talk';
  template: { id: string; version: string };
  canvas: Canvas | Omit<Canvas, 'colorSpace'>;
  language: 'ja' | 'en';
  targets: Target[];
}): Timeline {
  return {
    schema: SCHEMA_VERSION,
    meta: {
      title: init.title,
      kind: init.kind,
      template: { ...init.template },
      audience: '',
      goal: '',
      language: init.language,
      targets: [...init.targets],
      glossary: [],
      references: [],
    },
    canvas: { colorSpace: 'bt709', ...init.canvas, fps: { ...init.canvas.fps } },
    sources: {},
    outline: [],
    segments: [],
    scenes: [],
    captions: [],
    overlays: [],
    audio: { voice: { denoise: 'light', eq: 'voice-default', loudness: -14, truePeak: -1 }, bgm: [], sfx: [] },
    masks: [],
    markers: [],
    outputs: [],
    review: { openItems: [], feedback: [] },
  };
}

export function durationFrames(t: Timeline): Frame {
  let end = 0;
  for (const s of t.segments) end = Math.max(end, s.range.end);
  return end;
}

/** The rate of a source's own clock: video fps, or the mic sample rate (1 "frame" = 1 sample). Assets: canvas fps. */
export function sourceRate(t: Timeline, src: Source): Rational {
  if (src.kind === 'screen' || src.kind === 'camera') return src.fps;
  if (src.kind === 'mic') return { num: src.sampleRate, den: 1 };
  return t.canvas.fps;
}

/**
 * The clock of a take, in which `segment.src.from/to` are counted: the fps of the take's screen source
 * (first by id), else of its first camera, else the canvas fps.
 */
export function takeFps(t: Timeline, take: string): Rational {
  const ids = Object.keys(t.sources).sort();
  for (const kind of ['screen', 'camera'] as const) {
    for (const id of ids) {
      const s = t.sources[id]!;
      if (s.kind === kind && s.take === take) return s.fps;
    }
  }
  return t.canvas.fps;
}

/** Timeline length (frames) of a segment derived from its source range. Never 0 for a non-empty range. */
export function segmentLength(t: Timeline, seg: Pick<Segment, 'src'>): number {
  const len = seg.src.to - seg.src.from;
  if (len <= 0) return 0;
  return Math.max(1, convertFrames(len, takeFps(t, seg.src.take), t.canvas.fps));
}

/** Re-pack segment ranges contiguously from 0 in array order. Returns a new array (segments copied when changed). */
export function repackSegments(t: Timeline, segments: Segment[]): Segment[] {
  let at = 0;
  return segments.map((s) => {
    const len = segmentLength(t, s);
    const range = { start: at, end: at + len };
    at += len;
    return s.range.start === range.start && s.range.end === range.end ? s : { ...s, range };
  });
}

/** Seconds in the take's clock for a take frame. */
export function takeFrameToSeconds(t: Timeline, take: string, f: number): number {
  return frameToSeconds(f, takeFps(t, take));
}

/**
 * Local time (seconds) inside a source's file for a take time (seconds).
 * local = takeSec * drift + offset / rate  (offset in the source's own units).
 */
export function sourceLocalSeconds(t: Timeline, src: Source, takeSec: number): number {
  if (src.kind === 'asset') return takeSec;
  const drift = src.kind === 'camera' && src.drift ? src.drift : 1;
  return takeSec * drift + frameToSeconds(src.offset, sourceRate(t, src));
}

/** Map a take frame of a segment's take to the timeline frame (null when that moment was cut). */
export function takeFrameToTimeline(t: Timeline, take: string, f: number): Frame | null {
  for (const s of t.segments) {
    if (s.src.take !== take) continue;
    if (f >= s.src.from && f < s.src.to) {
      const rel = convertFrames(f - s.src.from, takeFps(t, take), t.canvas.fps);
      return Math.min(s.range.end - 1, s.range.start + rel);
    }
  }
  return null;
}

/** Map a timeline frame back to (segment, take frame). */
export function timelineFrameToTake(t: Timeline, f: Frame): { segment: Segment; take: string; frame: number } | null {
  for (const s of t.segments) {
    if (f >= s.range.start && f < s.range.end) {
      const rel = convertFrames(f - s.range.start, t.canvas.fps, takeFps(t, s.src.take));
      return { segment: s, take: s.src.take, frame: Math.min(s.src.to - 1, s.src.from + rel) };
    }
  }
  return null;
}

/** Source ids a video choice depends on. */
export function videoSources(v: Segment['video']): string[] {
  switch (v.layout) {
    case 'camera-full': return [v.camera];
    case 'screen-full': return [v.screen];
    case 'screen-with-wipe': return [v.screen, v.camera];
    case 'split-v': return [v.top, v.bottom];
    case 'scene': return [];
  }
}

/** Every element id in the timeline (for uniqueness and new-id generation). */
export function allIds(t: Timeline): Set<string> {
  const ids = new Set<string>();
  for (const c of t.outline) ids.add(c.id);
  for (const s of t.segments) ids.add(s.id);
  for (const s of t.scenes) ids.add(s.id);
  for (const c of t.captions) ids.add(c.id);
  for (const o of t.overlays) ids.add(o.id);
  for (const b of t.audio.bgm) ids.add(b.id);
  for (const s of t.audio.sfx) ids.add(s.id);
  for (const m of t.masks) ids.add(m.id);
  return ids;
}

/** A fresh id `${base}${n}` not in `taken`. */
export function freshId(base: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const id = `${base}${n}`;
    if (!taken.has(id)) return id;
  }
}
