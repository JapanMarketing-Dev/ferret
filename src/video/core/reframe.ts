import { allIds, freshId, sourceLocalSeconds, takeFrameToSeconds, videoSources } from './timeline.js';
import { sourceRectToCanvas, videoRegions } from './layout.js';
import type { Focus, FocusValue, Overlay, Point, Segment, Timeline, ZoomKeyframe } from './schema.js';
import { fpsValue } from './time.js';
import type { CursorEvent, FocusKey, FocusPathOptions, Tracks, TrackSample } from './tracks.js';
import { cursorSamples, faceSamples, focusAt, focusForPoint, focusPath, isShortcut, sampleAt } from './tracks.js';

type Smoothing = Partial<Omit<FocusPathOptions, 'fromSec' | 'toSec' | 'fps'>>;

/** Time range of a segment in the clock of a track: source-local seconds (faces) or take seconds (cursor). */
function segmentClock(t: Timeline, seg: Segment, sourceId: string, kind: 'face' | 'cursor'): { from: number; to: number } | null {
  const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
  const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
  if (kind === 'cursor') return { from: a, to: b };
  const src = t.sources[sourceId];
  if (!src) return null;
  return { from: sourceLocalSeconds(t, src, a), to: sourceLocalSeconds(t, src, b) };
}

/** Samples for a source (face) or take (cursor), or null when no track was loaded. */
function samplesFor(tracks: Tracks, _t: Timeline, seg: Segment, sourceId: string, kind: 'face' | 'cursor'): TrackSample[] | null {
  if (kind === 'face') {
    const tr = tracks.faces?.[sourceId];
    return tr ? faceSamples(tr) : null;
  }
  const ev = tracks.cursor?.[seg.src.take];
  return ev ? cursorSamples(ev) : null;
}

/** The followed point (normalized source coordinates) over a segment, as segment-relative keyframes; null without a track. */
export function segmentPointPath(t: Timeline, seg: Segment, sourceId: string, kind: 'face' | 'cursor', tracks: Tracks, smoothing: Smoothing = {}): FocusKey[] | null {
  const samples = samplesFor(tracks, t, seg, sourceId, kind);
  const clock = segmentClock(t, seg, sourceId, kind);
  if (!samples || !samples.length || !clock) return null;
  const cuts = kind === 'face' ? tracks.cuts?.[sourceId] : undefined;
  return focusPath(samples, { ...smoothing, fromSec: clock.from, toSec: clock.to, fps: fpsValue(t.canvas.fps), ...(cuts ? { cuts } : {}) });
}

/** Cover-crop focus over a segment that keeps the tracked subject centred in a region of the given size. */
export function segmentFocus(t: Timeline, seg: Segment, sourceId: string, kind: 'face' | 'cursor', tracks: Tracks,
  region: { width: number; height: number }, smoothing: Smoothing = {}): FocusValue | null {
  const src = t.sources[sourceId];
  if (!src || (src.kind !== 'screen' && src.kind !== 'camera')) return null;
  const path = segmentPointPath(t, seg, sourceId, kind, tracks, smoothing);
  if (!path) return null;
  const keys = path.map((k) => ({ at: k.at, ...focusForPoint(k, src.size, region) }));
  // collapse keyframes that do not move the crop
  const dedup = keys.filter((k, i) => i === 0 || k.x !== keys[i - 1]!.x || k.y !== keys[i - 1]!.y || i === keys.length - 1);
  const still = dedup.every((k) => k.x === dedup[0]!.x && k.y === dedup[0]!.y);
  return still ? ({ x: dedup[0]!.x, y: dedup[0]!.y } satisfies Focus) : dedup;
}

/** Canvas pixel position of a normalized source point inside the segment's layout (null when not visible). */
function canvasPoint(t: Timeline, seg: Segment, sourceId: string, p: { x: number; y: number }, rel: number): Point | null {
  const src = t.sources[sourceId];
  if (!src || (src.kind !== 'screen' && src.kind !== 'camera')) return null;
  const region = videoRegions(seg, t.canvas).find((r) => r.source === sourceId && r.kind === 'video');
  if (!region) return null;
  const f = region.focus === undefined ? undefined : Array.isArray(region.focus) ? focusAt(region.focus, rel) : region.focus;
  const r = sourceRectToCanvas({ x: p.x * src.size.width - 0.5, y: p.y * src.size.height - 0.5, w: 1, h: 1 }, src.size, region.rect, region.fit, f, region.scale);
  return r ? { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) } : null;
}

export interface FollowClicksOptions {
  /** Punch-in scale (default 1.6). */
  scale?: number;
  /** Seconds to stay zoomed after a click (default 1.5); clicks closer than this keep the zoom and move the focus. */
  holdSec?: number;
  /** Seconds to ramp in before the click and out after the hold (default 0.35). */
  rampSec?: number;
}

/** Zoom keyframes that punch in toward each click of the take while a screen is shown (segment-relative frames). */
export function clickZoom(t: Timeline, seg: Segment, tracks: Tracks, o: FollowClicksOptions = {}): ZoomKeyframe[] {
  const screen = videoSources(seg.video).find((id) => t.sources[id]?.kind === 'screen');
  const events = tracks.cursor?.[seg.src.take];
  if (!screen || !events) return [];
  const F = fpsValue(t.canvas.fps);
  const len = seg.range.end - seg.range.start;
  const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
  const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
  const scale = o.scale ?? 1.6;
  const hold = Math.round((o.holdSec ?? 1.5) * F);
  const ramp = Math.max(1, Math.round((o.rampSec ?? 0.35) * F));
  const clicks = events.filter((e) => e.click && e.t_ms / 1000 >= a && e.t_ms / 1000 < b)
    .map((e) => ({ at: Math.round((e.t_ms / 1000 - a) * F), x: e.x, y: e.y }))
    .sort((p, q) => p.at - q.at);
  if (!clicks.length) return [];
  // group clicks closer than hold + ramps (zooming out and straight back in looks jittery)
  const groups: (typeof clicks)[] = [];
  for (const c of clicks) {
    const g = groups[groups.length - 1];
    if (g && c.at - g[g.length - 1]!.at <= hold + 2 * ramp) g.push(c); // would land in the zoom-out/in ramps: stay zoomed
    else groups.push([c]);
  }
  const keys: ZoomKeyframe[] = [];
  const add = (at: number, s: number, focus: ZoomKeyframe['value']['focus']) => {
    const f = Math.min(len - 1, Math.max(0, at));
    const prev = keys[keys.length - 1];
    if (prev && prev.at >= f) {
      if (prev.at === f) prev.value = { scale: s, focus };
      return;
    }
    keys.push({ at: f, value: { scale: s, focus } });
  };
  for (const g of groups) {
    const pts = g.map((c) => ({ at: c.at, p: canvasPoint(t, seg, screen, c, c.at) }));
    const first = pts.find((x) => x.p);
    if (!first) continue;
    add(g[0]!.at - ramp, 1, first.p!);
    for (const x of pts) if (x.p) add(x.at, scale, x.p);
    const lastP = [...pts].reverse().find((x) => x.p)!.p!;
    add(g[g.length - 1]!.at + hold, scale, lastP);
    add(g[g.length - 1]!.at + hold + ramp, 1, lastP);
  }
  return keys;
}

export interface ApplyTracksOptions {
  /** Auto punch-in toward clicks on screen segments without a hand-made zoom (template `zoom.followClicks`). */
  followClicks?: boolean | FollowClicksOptions;
  smoothing?: Smoothing;
}

/**
 * Resolve tracked focus in a timeline (pure): zoom keyframes whose focus is 'face' / 'cursor' follow the tracks
 * (re-sampled as moving canvas points), and screen segments get click punch-ins when `followClicks` is on.
 * Returns the new segments; record them with `{ op: 'setSegments', segments }`.
 */
export function applyTracks(t: Timeline, tracks: Tracks, o: ApplyTracksOptions = {}): Segment[] {
  return t.segments.map((seg) => {
    const zoom = seg.zoom ?? [];
    if (zoom.some((k) => k.value.focus === 'face' || k.value.focus === 'cursor')) {
      const kind = zoom.find((k) => k.value.focus === 'face' || k.value.focus === 'cursor')!.value.focus as 'face' | 'cursor';
      const sourceId = videoSources(seg.video).find((id) => t.sources[id]?.kind === (kind === 'face' ? 'camera' : 'screen'));
      const path = sourceId ? segmentPointPath(t, seg, sourceId, kind, tracks, o.smoothing) : null;
      if (sourceId && path) {
        const sorted = [...zoom].sort((a, b) => a.at - b.at);
        const scaleAt = (at: number) => {
          const i = sorted.findIndex((k) => k.at > at);
          if (i === 0) return sorted[0]!.value.scale;
          const prev = sorted[i === -1 ? sorted.length - 1 : i - 1]!;
          if (i === -1 || prev.ease === 'hold') return prev.value.scale;
          const next = sorted[i]!;
          return prev.value.scale + (next.value.scale - prev.value.scale) * ((at - prev.at) / (next.at - prev.at));
        };
        const times = [...new Set([...sorted.map((k) => k.at), ...path.map((k) => k.at)])].sort((a, b) => a - b);
        const len = seg.range.end - seg.range.start;
        const tracked = (at: number): ZoomKeyframe['value']['focus'] => {
          const gov = [...sorted].reverse().find((k) => k.at <= at) ?? sorted[0]!;
          if (gov.value.focus !== kind) return gov.value.focus;
          const p = sampleAt(path.map((k) => ({ t: k.at, x: k.x, y: k.y })), at)!;
          return canvasPoint(t, seg, sourceId, p, at) ?? gov.value.focus;
        };
        const keys: ZoomKeyframe[] = times.filter((at) => at < Math.max(1, len)).map((at) => ({ at, value: { scale: scaleAt(at), focus: tracked(at) } }));
        return { ...seg, zoom: keys };
      }
    }
    if (o.followClicks && !(seg.zoom && seg.zoom.length)) {
      const keys = clickZoom(t, seg, tracks, typeof o.followClicks === 'object' ? o.followClicks : {});
      if (keys.length) return { ...seg, zoom: keys };
    }
    return seg;
  });
}

export interface InputOverlayOptions {
  /** Only show shortcuts (a modifier + key), not plain typing. Default true. */
  shortcutsOnly?: boolean;
  /** How long a keystroke badge stays (seconds, default 1.2). Key presses closer than this are merged. */
  keyHoldSec?: number;
  /** Add click rings (default true) and keystroke badges (default true). */
  clicks?: boolean;
  keys?: boolean;
}

/**
 * Click-ring and keystroke overlays from the cursor and key logs, for the parts of each take that are on screen
 * (screen-full, screen-with-wipe, split-v). Positions follow the layout (including vertical crops). New ids avoid
 * existing ones; add them with `addOverlay` ops.
 */
export function overlaysFromInputLogs(t: Timeline, tracks: Pick<Tracks, 'cursor' | 'keys'>, o: InputOverlayOptions = {}): Overlay[] {
  const F = fpsValue(t.canvas.fps);
  const taken = allIds(t);
  const out: Overlay[] = [];
  const hold = Math.max(1, Math.round((o.keyHoldSec ?? 1.2) * F));
  const nextId = (base: string) => {
    const id = taken.has(base) ? freshId(`${base}_`, taken) : base;
    taken.add(id);
    return id;
  };
  let nClick = 0;
  let nKey = 0;
  for (const seg of t.segments) {
    const screen = videoSources(seg.video).find((id) => t.sources[id]?.kind === 'screen');
    if (!screen) continue;
    const a = takeFrameToSeconds(t, seg.src.take, seg.src.from);
    const b = takeFrameToSeconds(t, seg.src.take, seg.src.to);
    const toFrame = (ms: number) => seg.range.start + Math.round((ms / 1000 - a) * F);
    if (o.clicks !== false) {
      for (const e of tracks.cursor?.[seg.src.take] ?? []) {
        if (!e.click || e.t_ms / 1000 < a || e.t_ms / 1000 >= b) continue;
        const at = Math.min(seg.range.end - 1, toFrame(e.t_ms));
        const p = canvasPoint(t, seg, screen, e, at - seg.range.start);
        if (!p) continue;
        out.push({ kind: 'click-ring', id: nextId(`ov_click_${++nClick}`), at, position: p });
      }
    }
    if (o.keys !== false) {
      const presses = (tracks.keys?.[seg.src.take] ?? [])
        .filter((k) => k.keys.length && k.t_ms / 1000 >= a && k.t_ms / 1000 < b && (o.shortcutsOnly === false || isShortcut(k.keys)))
        .sort((x, y) => x.t_ms - y.t_ms);
      let cur: { start: number; end: number; keys: string[] } | null = null;
      const flush = () => {
        if (!cur) return;
        out.push({ kind: 'keystroke', id: nextId(`ov_key_${++nKey}`), range: { start: cur.start, end: Math.min(seg.range.end, cur.end) }, keys: cur.keys });
        cur = null;
      };
      for (const k of presses) {
        const at = toFrame(k.t_ms);
        if (cur && at < cur.end && k.keys.join('+') === cur.keys.join('+')) {
          cur.end = at + hold; // the same shortcut again: extend
          continue;
        }
        if (cur) {
          cur.end = Math.min(cur.end, at); // a new one replaces it
          flush();
        }
        cur = { start: at, end: at + hold, keys: [...k.keys] };
      }
      flush();
    }
  }
  return out.filter((ov) => ov.kind !== 'keystroke' || ov.range.end > ov.range.start);
}

/**
 * Static screen-crop focus per segment from a cursor log, ready for `deriveVariant({ screenFocus })`: the median
 * cursor position while each segment's screen is shown, converted to the cover-crop focus of the region the screen
 * gets in the vertical layout (default the split-v top half, 1080×960). Accepts one take's events or a map by take id.
 * Segments without a screen or without cursor events are left out. (For a moving crop, pass `tracks` instead.)
 */
export function cursorFocusForSegments(t: Timeline, cursorLog: CursorEvent[] | Record<string, CursorEvent[]>,
  o: { region?: { width: number; height: number } } = {}): Record<string, Focus> {
  const region = o.region ?? { width: 1080, height: 960 };
  const byTake = (take: string): CursorEvent[] => (Array.isArray(cursorLog) ? cursorLog : cursorLog[take] ?? []);
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const out: Record<string, Focus> = {};
  for (const seg of t.segments) {
    const screen = videoSources(seg.video).find((id) => t.sources[id]?.kind === 'screen');
    const src = screen ? t.sources[screen] : undefined;
    if (!src || src.kind !== 'screen') continue;
    const a = takeFrameToSeconds(t, seg.src.take, seg.src.from) * 1000;
    const b = takeFrameToSeconds(t, seg.src.take, seg.src.to) * 1000;
    const ev = cursorSamples(byTake(seg.src.take).filter((e) => e.t_ms >= a && e.t_ms < b));
    if (!ev.length) continue;
    out[seg.id] = focusForPoint({ x: median(ev.map((e) => e.x)), y: median(ev.map((e) => e.y)) }, src.size, region);
  }
  return out;
}
