import { sha256Hex } from './hash.js';
import { segmentFocus } from './reframe.js';
import type { FocusPathOptions, Tracks } from './tracks.js';
import { PRESETS } from './presets.js';
import type {
  Bgm, Caption, Chapter, Focus, FocusValue, Frame, Marker, Overlay, Point, Rect, Scene, Segment, Sfx, Timeline, VideoChoice,
} from './schema.js';
import { SCHEMA_VERSION } from './schema.js';
import { repackSegments, segmentLength, takeFps } from './timeline.js';
import { convertFrames } from './time.js';

/** JSON with sorted keys (stable across key order). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Hash of the parts of a main timeline that variants are made from (everything except outputs, review state and
 * meta.derivedFrom). Publishing status or review notes do not make variants stale.
 */
export function mainHash(main: Timeline): string {
  const { outputs: _o, review: _r, meta, ...rest } = main;
  const { derivedFrom: _d, ...m } = meta;
  return sha256Hex(stableJson({ ...rest, meta: m })).slice(0, 32);
}

/** True when the variant was derived from a different version of the main timeline (or has no derivedFrom). */
export function variantStale(main: Timeline, variant: Timeline): boolean {
  const d = variant.meta.derivedFrom;
  return !d || d.mainHash !== mainHash(main);
}

const ROLE_BONUS: Record<Segment['role'], number> = { hook: 0.3, summary: 0.25, explain: 0.15, demo: 0.15, example: 0.1, cta: -0.2, aside: -0.3 };
const IMPORTANCE: Record<Chapter['importance'], number> = { core: 0.6, support: 0.3, aside: 0 };

/** Default score of a segment for vertical highlights (0..~1): chapter importance + role. */
export function highlightScore(main: Timeline, seg: Segment): number {
  const ch = main.outline.find((c) => c.id === seg.chapter);
  return (ch ? IMPORTANCE[ch.importance] : 0.3) + ROLE_BONUS[seg.role];
}

/**
 * Pick segments for a vertical variant: the hook first (best-scoring 'hook' segment), then the highest-scoring other
 * segments that still fit `maxFrames`, in chronological order after the hook. `scores` (e.g. decision-model
 * "interesting on its own") replace the default score. Segments with role cta/aside are only used when scored.
 */
export function pickHighlights(main: Timeline, o: { maxFrames: number; scores?: Record<string, number> }): string[] {
  const score = (s: Segment) => o.scores?.[s.id] ?? highlightScore(main, s);
  const len = (s: Segment) => s.range.end - s.range.start;
  const hooks = main.segments.filter((s) => s.role === 'hook').sort((a, b) => score(b) - score(a));
  const hook = hooks[0];
  const picked = new Set<string>();
  let used = 0;
  if (hook) {
    picked.add(hook.id);
    used += len(hook);
  }
  const rest = main.segments
    .filter((s) => s !== hook && (o.scores?.[s.id] !== undefined || (s.role !== 'cta' && s.role !== 'aside')))
    .sort((a, b) => score(b) - score(a) || a.range.start - b.range.start);
  for (const s of rest) {
    if (used + len(s) > o.maxFrames) continue;
    picked.add(s.id);
    used += len(s);
  }
  const ordered = main.segments.filter((s) => picked.has(s.id) && s !== hook).map((s) => s.id);
  return hook ? [hook.id, ...ordered] : ordered;
}

export interface DeriveOptions {
  /** Main segment ids, in the order they appear in the variant. */
  selection: string[];
  /** Cap on the variant length (frames at the main fps). Later segments are dropped; a too-long first one is trimmed. */
  maxFrames?: number;
  /** Caption style id for the variant (default 'tiktok-bold'). */
  captionStyle?: string;
  /** Override the default layout conversion. */
  layoutMap?: Partial<Record<VideoChoice['layout'], VideoChoice['layout']>>;
  /** Vertical crop of camera shots: 'face' (upper-middle, x .5 / y .4) or 'center'. */
  reframe?: 'face' | 'center';
  /** Segment to start with (moved to the front of the selection). */
  hookSegment?: string;
  /** Crop focus for the screen per main segment (e.g. from the cursor log); default centre. */
  screenFocus?: Record<string, Focus>;
  /** Analysis tracks: faces drive the vertical crops of cameras, the cursor drives the screen crop in split-v. */
  tracks?: Tracks;
  smoothing?: Partial<Omit<FocusPathOptions, 'fromSec' | 'toSec' | 'fps'>>;
  /** ISO time for meta.derivedFrom.at (default now). */
  at?: string;
  /** Free text recorded in meta.derivedFrom.rules (e.g. the prompts/vertical.md rules used). */
  rules?: string;
}

const SUFFIX: Record<'tiktok' | 'youtube-shorts', string> = { tiktok: 'tt', 'youtube-shorts': 'ys' };
/** Safe area shared by TikTok and Shorts (docs/06), in 1080×1920 pixels. */
export const VERTICAL_SAFE = { left: 80, right: 1080 - 180, top: 220, bottom: 1920 - 440 };

interface Piece { mainStart: Frame; mainEnd: Frame; newStart: Frame; seg: string }

/**
 * Derive a 9:16 variant (TikTok / YouTube Shorts) from the main timeline (pure). Selected segments are copied with new
 * ids and converted layouts; captions, overlays, scenes, sfx, bgm, markers and chapters are re-timed onto the new
 * cut; masks are kept (source coordinates). The result validates as a normal Timeline.
 */
export function deriveVariant(main: Timeline, target: 'tiktok' | 'youtube-shorts', opts: DeriveOptions): Timeline {
  const sfx = `_${SUFFIX[target]}`;
  const order = [...opts.selection];
  if (opts.hookSegment) {
    const i = order.indexOf(opts.hookSegment);
    if (i > 0) order.splice(i, 1);
    if (i !== 0) order.unshift(opts.hookSegment);
  }
  if (order.length === 0) throw new Error('deriveVariant: empty selection');
  if (new Set(order).size !== order.length) throw new Error('deriveVariant: a segment is selected twice');
  const byId = new Map(main.segments.map((s) => [s.id, s]));
  for (const id of order) if (!byId.has(id)) throw new Error(`deriveVariant: unknown segment ${id}`);

  const W = 1080;
  const H = 1920;
  const canvas = { ...main.canvas, width: W, height: H };
  const focus: Focus = opts.reframe === 'center' ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.4 };
  const cameraOfTake = (take: string): string | undefined => {
    const ids = Object.keys(main.sources).sort();
    return ids.find((id) => { const s = main.sources[id]!; return s.kind === 'camera' && s.take === take && s.role === 'front'; })
      ?? ids.find((id) => { const s = main.sources[id]!; return s.kind === 'camera' && s.take === take; });
  };

  const convert = (seg: Segment): VideoChoice => {
    const v = seg.video;
    const want = opts.layoutMap?.[v.layout];
    const tr = opts.tracks;
    const face = (cam: string, region: { width: number; height: number }): FocusValue =>
      (tr && opts.reframe !== 'center' ? segmentFocus(main, seg, cam, 'face', tr, region, opts.smoothing) : null) ?? focus;
    const half = { width: W, height: H / 2 };
    const split = (screen: string, camera: string): VideoChoice => {
      const screenFocus = opts.screenFocus?.[seg.id] ?? (tr ? segmentFocus(main, seg, screen, 'cursor', tr, half, opts.smoothing) : null);
      return { layout: 'split-v', top: screen, bottom: camera, ...(screenFocus ? { topFocus: screenFocus } : {}), bottomFocus: face(camera, half) };
    };
    switch (v.layout) {
      case 'camera-full':
        return want === 'split-v' ? v : { layout: 'camera-full', camera: v.camera, focus: face(v.camera, { width: W, height: H }) };
      case 'screen-with-wipe':
        if (want === 'screen-with-wipe') return v;
        if (want === 'screen-full') return { layout: 'screen-full', screen: v.screen };
        return split(v.screen, v.camera);
      case 'screen-full': {
        const cam = cameraOfTake(seg.src.take);
        if (want === 'screen-full' || !cam) return v;
        return split(v.screen, cam);
      }
      case 'split-v':
        return v;
      case 'scene':
        return v; // the pattern re-lays itself for 9:16
    }
  };

  // segments: copy, convert, fit maxFrames
  const max = opts.maxFrames ?? Number.POSITIVE_INFINITY;
  const segs: Segment[] = [];
  const selection: NonNullable<Timeline['meta']['derivedFrom']>['selection'] = [];
  let used = 0;
  for (const id of order) {
    const s = byId.get(id)!;
    let len = s.range.end - s.range.start;
    let src = { ...s.src };
    if (used + len > max) {
      if (segs.length > 0) continue; // drop: later ones may still fit
      // the first (hook) alone is too long: trim its end
      const keepTake = convertFrames(max, main.canvas.fps, takeFps(main, s.src.take));
      src = { ...src, to: src.from + Math.max(1, keepTake) };
      len = segmentLength(main, { src });
    }
    used += len;
    const copy: Segment = { ...structuredClone(s), id: `${s.id}${sfx}`, src, video: convert({ ...s, src }) };
    delete copy.checks;
    segs.push(copy);
    selection.push(src.to !== s.src.to ? { segment: s.id, from: src.from, to: src.to } : { segment: s.id });
  }
  const packed = repackSegments(main, segs);

  // main frame → variant frame
  const pieces: Piece[] = packed.map((ns, i) => {
    const orig = byId.get(selection[i]!.segment)!;
    return { mainStart: orig.range.start, mainEnd: orig.range.start + (ns.range.end - ns.range.start), newStart: ns.range.start, seg: ns.id };
  });
  const mapFrame = (f: Frame): Frame | null => {
    for (const p of pieces) if (f >= p.mainStart && f < p.mainEnd) return p.newStart + (f - p.mainStart);
    return null;
  };
  const mapRange = (r: { start: Frame; end: Frame }): { start: Frame; end: Frame; seg: string }[] => {
    const out: { start: Frame; end: Frame; seg: string }[] = [];
    for (const p of pieces) {
      const a = Math.max(r.start, p.mainStart);
      const b = Math.min(r.end, p.mainEnd);
      if (b > a) out.push({ start: p.newStart + (a - p.mainStart), end: p.newStart + (b - p.mainStart), seg: p.seg });
    }
    return out.sort((x, y) => x.start - y.start);
  };
  const span = (r: { start: Frame; end: Frame }) => {
    const parts = mapRange(r);
    return parts.length ? { start: parts[0]!.start, end: parts[parts.length - 1]!.end } : null;
  };
  const pieceId = (id: string, i: number) => (i === 0 ? `${id}${sfx}` : `${id}${sfx}${i + 1}`);

  // geometry: 16:9 canvas pixels → 9:16, clamped into the shared safe area
  const sx = W / main.canvas.width;
  const sy = H / main.canvas.height;
  const k = Math.min(sx, sy);
  const clampPoint = (p: Point): Point => ({
    x: Math.min(VERTICAL_SAFE.right, Math.max(VERTICAL_SAFE.left, Math.round(p.x * sx))),
    y: Math.min(VERTICAL_SAFE.bottom, Math.max(VERTICAL_SAFE.top, Math.round(p.y * sy))),
  });
  const mapRect = (r: Rect): Rect => {
    const w = Math.round(r.w * k);
    const h = Math.round(r.h * k);
    const c = clampPoint({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    return { x: Math.max(0, Math.min(W - w, c.x - w / 2)), y: Math.max(0, Math.min(H - h, c.y - h / 2)), w, h };
  };

  // captions: clipped to the selected parts, words re-timed, vertical style in the safe area
  const captions: Caption[] = [];
  const capY = Math.min((VERTICAL_SAFE.bottom - 10) / H, 0.72);
  for (const c of main.captions) {
    mapRange(c.range).forEach((part, i) => {
      const words = c.words.flatMap((w) => {
        const s = mapFrame(w.start);
        if (s === null || s < part.start || s >= part.end) return [];
        return [{ text: w.text, start: s, end: Math.min(part.end, Math.max(s, s + (w.end - w.start))) }];
      });
      const partial = part.end - part.start < c.range.end - c.range.start;
      const text = partial && words.length ? words.map((w) => w.text).join(main.meta.language === 'ja' ? '' : ' ') : c.text;
      captions.push({
        ...structuredClone(c), id: pieceId(c.id, i), range: { start: part.start, end: part.end }, words, text,
        lines: partial ? [text] : c.lines, // re-wrap with @video/captions layoutLines for the vertical style
        style: opts.captionStyle ?? 'tiktok-bold', position: { anchor: 'bottom', y: capY },
      });
    });
  }

  const overlays: Overlay[] = [];
  for (const o of main.overlays) {
    if (o.kind === 'click-ring') {
      const at = mapFrame(o.at);
      if (at !== null) overlays.push({ ...o, id: `${o.id}${sfx}`, at, position: clampPoint(o.position) });
      continue;
    }
    mapRange(o.range).forEach((part, i) => {
      const range = { start: part.start, end: part.end };
      const id = pieceId(o.id, i);
      if (o.kind === 'telop') overlays.push({ ...structuredClone(o), id, range, position: clampPoint(o.position) });
      else if (o.kind === 'image') overlays.push({ ...structuredClone(o), id, range, position: mapRect(o.position) });
      else overlays.push({ ...structuredClone(o), id, range });
    });
  }

  const scenes: Scene[] = [];
  for (const sc of main.scenes) {
    mapRange(sc.range).forEach((part, i) => {
      const copy: Scene = { ...structuredClone(sc), id: pieceId(sc.id, i), range: { start: part.start, end: part.end } };
      delete copy.anchor;
      if (sc.anchor && byId.has(sc.anchor.segment)) {
        const seg = packed.find((p) => p.id === `${sc.anchor!.segment}${sfx}`);
        if (seg && part.seg === seg.id) copy.anchor = { segment: seg.id, offset: part.start - seg.range.start };
      }
      scenes.push(copy);
    });
  }
  // segments with a 'scene' layout point at the scene's variant copy (added over the segment if it did not overlap)
  for (const seg of packed) {
    if (seg.video.layout !== 'scene') continue;
    const orig = seg.video.scene;
    let copy = scenes.find((x) => x.id === `${orig}${sfx}` || x.id.startsWith(`${orig}${sfx}`));
    if (!copy) {
      const src = main.scenes.find((x) => x.id === orig);
      if (!src) continue;
      copy = { ...structuredClone(src), id: `${orig}${sfx}`, range: { start: seg.range.start, end: seg.range.end } };
      delete copy.anchor;
      scenes.push(copy);
    }
    seg.video = { layout: 'scene', scene: copy.id };
  }

  const sfxOut: Sfx[] = [];
  for (const e of main.audio.sfx) {
    const at = mapFrame(e.at);
    if (at !== null) sfxOut.push({ ...structuredClone(e), id: `${e.id}${sfx}`, at });
  }
  const bgm: Bgm[] = [];
  for (const b of main.audio.bgm) {
    const r = span(b.range);
    if (r) bgm.push({ ...structuredClone(b), id: `${b.id}${sfx}`, range: r, fadeIn: Math.min(b.fadeIn, r.end - r.start), fadeOut: Math.min(b.fadeOut, r.end - r.start) });
  }
  const markers: Marker[] = [];
  for (const m of main.markers) {
    const at = mapFrame(m.at);
    if (at !== null) markers.push({ ...structuredClone(m), at });
  }
  const outline: Chapter[] = [];
  for (const c of main.outline) {
    const r = span(c);
    if (r) outline.push({ ...structuredClone(c), start: r.start, end: r.end });
  }
  // every selected segment's chapter must exist (an inconsistent main outline would otherwise break validation)
  for (const seg of packed) {
    if (main.outline.some((c) => c.id === seg.chapter) && !outline.some((c) => c.id === seg.chapter)) {
      const c = main.outline.find((x) => x.id === seg.chapter)!;
      outline.push({ ...structuredClone(c), start: seg.range.start, end: seg.range.end });
    }
  }
  outline.sort((a, b) => a.start - b.start);
  const shown = new Set(packed.flatMap((s) => videoIds(s.video)));
  const masks = main.masks.filter((m) => shown.has(m.source)).map((m) => structuredClone(m));

  const preset = PRESETS[target];
  const derived: Timeline = {
    schema: SCHEMA_VERSION,
    meta: {
      ...structuredClone(main.meta),
      targets: [target],
      derivedFrom: { variantOf: 'main', at: opts.at ?? new Date().toISOString(), mainHash: mainHash(main), selection, rules: opts.rules ?? '' },
    },
    canvas,
    sources: structuredClone(main.sources),
    outline,
    segments: packed,
    scenes,
    captions,
    overlays,
    audio: { voice: { ...main.audio.voice, loudness: preset.loudness.integrated, truePeak: preset.loudness.truePeak }, bgm, sfx: sfxOut },
    masks,
    markers,
    outputs: [{
      target, canvas, preset: target,
      metadata: { title: main.meta.title, titleCandidates: [], description: '', tags: [], chapters: false },
    }],
    review: { openItems: [], feedback: [] },
  };
  if (main.transcript) derived.transcript = structuredClone(main.transcript);
  return derived;
}

function videoIds(v: VideoChoice): string[] {
  switch (v.layout) {
    case 'camera-full': return [v.camera];
    case 'screen-full': return [v.screen];
    case 'screen-with-wipe': return [v.screen, v.camera];
    case 'split-v': return [v.top, v.bottom];
    case 'scene': return [];
  }
}
