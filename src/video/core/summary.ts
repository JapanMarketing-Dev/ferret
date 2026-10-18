import type { Decided, Frame, Segment, Target, Timeline } from './schema.js';
import { frameToTimecode } from './time.js';
import { durationFrames } from './timeline.js';

export interface TimelineSummary {
  title: string;
  kind: 'tech' | 'talk';
  template: string;
  language: 'ja' | 'en';
  targets: Target[];
  canvas: string; // "1080x1920@30"
  durationFrames: Frame;
  duration: string; // timecode
  counts: { sources: number; segments: number; captions: number; overlays: number; scenes: number; masks: number;
    bgm: number; sfx: number; markers: number };
  chapters: { id: string; title: string; start: string; end: string; importance: string; points: string[]; segments: number }[];
  roles: Record<string, { segments: number; frames: number }>;
  needsReview: { ref: string; reason: string }[];
  openItems: Timeline['review']['openItems'];
  lastCheck?: Timeline['review']['lastCheck'];
  outputs: { target: Target; rendered: boolean; publish?: string }[];
}

export function summarize(t: Timeline): TimelineSummary {
  const fps = t.canvas.fps;
  const dur = durationFrames(t);
  const roles: TimelineSummary['roles'] = {};
  for (const s of t.segments) {
    const r = (roles[s.role] ??= { segments: 0, frames: 0 });
    r.segments++;
    r.frames += s.range.end - s.range.start;
  }
  const needsReview: TimelineSummary['needsReview'] = [];
  const flag = (ref: string, d: Decided | undefined) => {
    if (d?.needsReview) needsReview.push({ ref, reason: d.reason });
  };
  t.segments.forEach((s) => flag(s.id, s.decided));
  t.scenes.forEach((s) => flag(s.id, s.decided));
  t.captions.forEach((c) => flag(c.id, c.decided));
  t.overlays.forEach((o) => flag(o.id, 'decided' in o ? o.decided : undefined));
  t.audio.bgm.forEach((b) => flag(b.id, b.decided));
  t.audio.sfx.forEach((s) => flag(s.id, s.decided));
  t.masks.forEach((m) => flag(m.id, m.decided));
  const fpsLabel = fps.den === 1 ? String(fps.num) : (fps.num / fps.den).toFixed(3);
  const summary: TimelineSummary = {
    title: t.meta.title,
    kind: t.meta.kind,
    template: `${t.meta.template.id}@${t.meta.template.version}`,
    language: t.meta.language,
    targets: t.meta.targets,
    canvas: `${t.canvas.width}x${t.canvas.height}@${fpsLabel}`,
    durationFrames: dur,
    duration: frameToTimecode(dur, fps),
    counts: {
      sources: Object.keys(t.sources).length, segments: t.segments.length, captions: t.captions.length,
      overlays: t.overlays.length, scenes: t.scenes.length, masks: t.masks.length, bgm: t.audio.bgm.length,
      sfx: t.audio.sfx.length, markers: t.markers.length,
    },
    chapters: t.outline.map((c) => ({
      id: c.id, title: c.title, start: frameToTimecode(c.start, fps), end: frameToTimecode(c.end, fps),
      importance: c.importance, points: c.points, segments: t.segments.filter((s) => s.chapter === c.id).length,
    })),
    roles,
    needsReview,
    openItems: t.review.openItems,
    outputs: t.outputs.map((o) => ({
      target: o.target, rendered: !!o.render, ...(o.publish ? { publish: o.publish.status } : {}),
    })),
  };
  if (t.review.lastCheck) summary.lastCheck = t.review.lastCheck;
  return summary;
}

export interface QueryResult {
  kind: 'segment' | 'caption' | 'overlay' | 'scene' | 'mask' | 'bgm' | 'sfx' | 'marker' | 'chapter' | 'source';
  id?: string;
  /** Timeline frames covered by the element (masks: the frames of segments showing the masked source). */
  range?: [Frame, Frame];
  item: unknown;
}

export interface Query {
  range?: [Frame, Frame];
  kind?: string;
  id?: string;
  role?: string;
}

const KIND_ALIASES: Record<string, QueryResult['kind']> = {
  segment: 'segment', segments: 'segment', caption: 'caption', captions: 'caption', overlay: 'overlay',
  overlays: 'overlay', scene: 'scene', scenes: 'scene', mask: 'mask', masks: 'mask', bgm: 'bgm', sfx: 'sfx',
  marker: 'marker', markers: 'marker', chapter: 'chapter', chapters: 'chapter', outline: 'chapter',
  source: 'source', sources: 'source',
};

/** All elements, each with its timeline extent. */
export function elements(t: Timeline): QueryResult[] {
  const out: QueryResult[] = [];
  for (const [id, s] of Object.entries(t.sources)) out.push({ kind: 'source', id, item: s });
  for (const c of t.outline) out.push({ kind: 'chapter', id: c.id, range: [c.start, c.end], item: c });
  for (const s of t.segments) out.push({ kind: 'segment', id: s.id, range: [s.range.start, s.range.end], item: s });
  for (const s of t.scenes) out.push({ kind: 'scene', id: s.id, range: [s.range.start, s.range.end], item: s });
  for (const c of t.captions) out.push({ kind: 'caption', id: c.id, range: [c.range.start, c.range.end], item: c });
  for (const o of t.overlays) {
    const range: [Frame, Frame] = o.kind === 'click-ring' ? [o.at, o.at + 1] : [o.range.start, o.range.end];
    out.push({ kind: 'overlay', id: o.id, range, item: o });
  }
  for (const b of t.audio.bgm) out.push({ kind: 'bgm', id: b.id, range: [b.range.start, b.range.end], item: b });
  for (const s of t.audio.sfx) out.push({ kind: 'sfx', id: s.id, range: [s.at, s.at + 1], item: s });
  for (const m of t.masks) {
    const segs = t.segments.filter((s) => segmentShows(s, m.source));
    const range: [Frame, Frame] | undefined = segs.length
      ? [Math.min(...segs.map((s) => s.range.start)), Math.max(...segs.map((s) => s.range.end))]
      : undefined;
    out.push(range ? { kind: 'mask', id: m.id, range, item: m } : { kind: 'mask', id: m.id, item: m });
  }
  for (const m of t.markers) out.push({ kind: 'marker', range: [m.at, m.at + 1], item: m });
  return out;
}

function segmentShows(s: Segment, source: string): boolean {
  const v = s.video;
  return (v.layout === 'camera-full' && v.camera === source) || (v.layout === 'screen-full' && v.screen === source)
    || (v.layout === 'screen-with-wipe' && (v.screen === source || v.camera === source))
    || (v.layout === 'split-v' && (v.top === source || v.bottom === source));
}

/** Filter elements: range overlap (half-open), kind, exact id, segment role. */
export function query(t: Timeline, q: Query): QueryResult[] {
  let kind: QueryResult['kind'] | undefined;
  if (q.kind !== undefined) {
    kind = KIND_ALIASES[q.kind];
    if (!kind) throw new Error(`unknown kind "${q.kind}" (expected one of ${[...new Set(Object.values(KIND_ALIASES))].join(', ')})`);
  }
  return elements(t).filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (q.id !== undefined && e.id !== q.id) return false;
    if (q.role !== undefined && !(e.kind === 'segment' && (e.item as Segment).role === q.role)) return false;
    if (q.range) {
      if (!e.range) return false;
      const a = q.range[0];
      const b = Math.max(q.range[1], a + 1); // a point query [f, f] means frame f
      if (!(e.range[0] < b && e.range[1] > a)) return false;
    }
    return true;
  });
}
