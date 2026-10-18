import { describe, expect, it } from 'vitest';
import type { CursorEvent, FaceTrack, Segment, Timeline, TrackSample } from '@video/core';
import {
  applyOp, applyOps, applyTracks, clickZoom, compile, cursorFocusForSegments, cursorSamples, deriveVariant, emptyTimeline, faceSamples, fitBubble,
  focusAt, focusForPoint, focusPath, isShortcut, layoutAt, overlaysFromInputLogs, parseJsonl, sampleAt, segmentFocus,
  textWidthEm, validateTimeline,
} from '@video/core';
import { D } from './fixtures.js';

const F30 = { num: 30, den: 1 };
const seg = (id: string, from: number, to: number, video: Segment['video'], extra: Partial<Segment> = {}): Segment => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video, decided: D, ...extra,
});

/** 1920x1080@30: camera + screen of take_1 (take frames = timeline frames). */
function tl(segments: Segment[]): Timeline {
  const e = emptyTimeline({ title: 't', kind: 'tech', template: { id: 'tech', version: '1' }, canvas: { width: 1920, height: 1080, fps: F30 }, language: 'ja', targets: ['youtube'] });
  return applyOps({
    ...e,
    sources: {
      cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
      scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'main', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
    },
  }, [{ op: 'setSegments', segments }]).timeline;
}

/** A face that moves linearly in x over `sec` seconds (source frames at 30 fps). */
function movingFace(x0: number, x1: number, sec: number, jitter = 0): FaceTrack {
  const frames = [];
  for (let f = 0; f <= sec * 30; f++) {
    const u = f / (sec * 30);
    const j = jitter ? Math.sin(f * 1.7) * jitter : 0;
    frames.push({ f, faces: [{ x: x0 + (x1 - x0) * u - 0.05 + j, y: 0.2, w: 0.1, h: 0.15, score: 0.9 }] });
  }
  return { fps: 30, frames };
}

describe('track parsing and samples', () => {
  it('parseJsonl skips blank and torn lines', () => {
    expect(parseJsonl<CursorEvent>('{"t_ms":1,"x":0.1,"y":0.2}\n\n{"t_ms":2,"x":0.3,"y":0.4,"click":true}\n{"t_ms":3,"x"')).toEqual([
      { t_ms: 1, x: 0.1, y: 0.2 }, { t_ms: 2, x: 0.3, y: 0.4, click: true },
    ]);
  });
  it('faceSamples picks the strongest face per frame and adds headroom', () => {
    const s = faceSamples({ fps: 30, frames: [
      { f: 30, faces: [{ x: 0.1, y: 0.1, w: 0.05, h: 0.05, score: 0.9 }, { x: 0.5, y: 0.2, w: 0.2, h: 0.2, score: 0.8 }] },
      { f: 0, faces: [] },
      { f: 60, faces: [{ x: 0.4, y: 0.2, w: 0.1, h: 0.1, score: 0.1 }] }, // below minScore
    ] });
    expect(s).toEqual([{ t: 1, x: 0.6, y: 0.2 + 0.1 + 0.12 }]);
  });
  it('cursorSamples clamps and sorts; sampleAt interpolates and holds ends', () => {
    const s = cursorSamples([{ t_ms: 2000, x: 1.2, y: 0.5 }, { t_ms: 1000, x: 0, y: -1 }, { t_ms: Number.NaN, x: 0, y: 0 }]);
    expect(s).toEqual([{ t: 1, x: 0, y: 0 }, { t: 2, x: 1, y: 0.5 }]);
    expect(sampleAt(s, 1.5)).toEqual({ x: 0.5, y: 0.25 });
    expect(sampleAt(s, 0)).toEqual({ x: 0, y: 0 });
    expect(sampleAt(s, 9)).toEqual({ x: 1, y: 0.5 });
    expect(sampleAt([], 1)).toBeNull();
  });
  it('isShortcut', () => {
    expect(isShortcut(['⌘', 'K'])).toBe(true);
    expect(isShortcut(['Ctrl', 'Shift', 'P'])).toBe(true);
    expect(isShortcut(['a'])).toBe(false);
    expect(isShortcut(['Shift'])).toBe(false);
  });
});

describe('focusPath', () => {
  const steady = (fn: (t: number) => number, sec: number, rate = 30): TrackSample[] =>
    Array.from({ length: sec * rate + 1 }, (_, i) => ({ t: i / rate, x: fn(i / rate), y: 0.5 }));
  it('holds still inside the dead zone (one keyframe for a jittery static subject)', () => {
    const p = focusPath(steady((t) => 0.5 + Math.sin(t * 40) * 0.01, 4), { fromSec: 0, toSec: 4, fps: 30 });
    expect(p.length).toBeLessThanOrEqual(2);
    for (const k of p) expect(Math.abs(k.x - 0.5)).toBeLessThan(0.02);
  });
  it('smooths noise but follows a step move within about a second', () => {
    const noisy = steady((t) => (t < 2 ? 0.3 : 0.7) + Math.sin(t * 53) * 0.03, 4);
    const p = focusPath(noisy, { fromSec: 0, toSec: 4, fps: 30 });
    expect(focusAt(p, 50).x).toBeLessThan(0.36);
    expect(focusAt(p, 60 + 36).x).toBeGreaterThan(0.6); // 1.2 s after the move
    // no overshoot beyond the target and never outside 0..1
    for (const k of p) expect(k.x).toBeLessThanOrEqual(0.75);
  });
  it('jumps at a cut instead of panning across it', () => {
    const p = focusPath(steady((t) => (t < 2 ? 0.2 : 0.8), 4), { fromSec: 0, toSec: 4, fps: 30, cuts: [2] });
    expect(focusAt(p, 59).x).toBeCloseTo(0.2, 2);
    expect(focusAt(p, 60).x).toBeCloseTo(0.8, 2);
  });
  it('reduces linear motion to few keyframes and respects the range', () => {
    const p = focusPath(steady((t) => 0.2 + t * 0.1, 6), { fromSec: 1, toSec: 5, fps: 30, deadZone: 0 });
    expect(p.length).toBeLessThan(20);
    expect(p[0]!.at).toBe(0);
    expect(p[p.length - 1]!.at).toBe(119);
    expect(focusAt(p, 119).x).toBeGreaterThan(0.6);
  });
  it('falls back without samples in range', () => {
    expect(focusPath([], { fromSec: 0, toSec: 1, fps: 30 })).toEqual([{ at: 0, x: 0.5, y: 0.5 }]);
    expect(focusPath([{ t: 100, x: 0.1, y: 0.1 }], { fromSec: 0, toSec: 1, fps: 30, fallback: { x: 0.2, y: 0.3 } })).toEqual([{ at: 0, x: 0.2, y: 0.3 }]);
  });
  it('focusForPoint centres a point in a cover crop', () => {
    const f = focusForPoint({ x: 0.8, y: 0.5 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    const vw = 1080 / (1920 * (1920 / 1080));
    expect(f.x).toBeCloseTo((0.8 - vw / 2) / (1 - vw), 3);
    expect(f.y).toBe(0.5); // not cropped vertically
    expect(focusForPoint({ x: 0.99, y: 0.5 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }).x).toBe(1);
    expect(focusForPoint({ x: 0.3, y: 0.3 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('tracked reframing', () => {
  const t = tl([seg('seg_cam', 0, 120, { layout: 'camera-full', camera: 'cam' }, { role: 'hook' }), seg('seg_scr', 120, 240, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } })]);
  it('segmentFocus follows a moving face (keyframes) and collapses a still one', () => {
    const moving = segmentFocus(t, t.segments[0]!, 'cam', 'face', { faces: { cam: movingFace(0.2, 0.8, 8) } }, { width: 1080, height: 1920 });
    expect(Array.isArray(moving)).toBe(true);
    const keys = moving as { at: number; x: number }[];
    expect(keys[keys.length - 1]!.x).toBeGreaterThan(keys[0]!.x);
    const still = segmentFocus(t, t.segments[0]!, 'cam', 'face', { faces: { cam: movingFace(0.5, 0.5, 8, 0.004) } }, { width: 1080, height: 1920 });
    expect(Array.isArray(still)).toBe(false);
    expect(segmentFocus(t, t.segments[0]!, 'cam', 'face', {}, { width: 1080, height: 1920 })).toBeNull();
  });
  it('deriveVariant uses face tracks for camera crops and the cursor for the screen crop', () => {
    const cursor: CursorEvent[] = Array.from({ length: 81 }, (_, i) => ({ t_ms: 4000 + i * 50, x: 0.1 + i * 0.01, y: 0.2 }));
    const v = deriveVariant(t, 'tiktok', { selection: ['seg_cam', 'seg_scr'], tracks: { faces: { cam: movingFace(0.2, 0.8, 8) }, cursor: { take_1: cursor } } });
    expect(validateTimeline(v).ok).toBe(true);
    const camV = v.segments[0]!.video as { focus: unknown };
    expect(Array.isArray(camV.focus)).toBe(true);
    const split = v.segments[1]!.video as { topFocus: unknown; bottomFocus: unknown };
    expect(Array.isArray(split.topFocus)).toBe(true); // cursor moves right
    // compile turns the moving focus into per-frame crop expressions
    const p = compile(v, { quality: 'preview', projectDir: '/p' });
    const fc = (i: number) => p.chunks[i]!.args[p.chunks[i]!.args.indexOf('-filter_complex') + 1]!;
    expect(fc(0)).toMatch(/crop=w=\d+:h=\d+:x='\(iw-ow\)\*\(if\(lt\(\(n\+0\)/);
    // layoutAt follows the moving crop (mask position changes over time is covered in layout tests); regions exist
    expect(layoutAt(v, 10).some((i) => i.kind === 'video')).toBe(true);
    // reframe 'center' ignores tracks
    const c = deriveVariant(t, 'tiktok', { selection: ['seg_cam'], reframe: 'center', tracks: { faces: { cam: movingFace(0.2, 0.8, 8) } } });
    expect((c.segments[0]!.video as { focus: unknown }).focus).toEqual({ x: 0.5, y: 0.5 });
  });
  it('applyTracks makes a face/cursor zoom follow the track', () => {
    const z = applyOp(t, { op: 'setSegments', segments: t.segments.map((s) => s.id === 'seg_cam'
      ? { ...s, zoom: [{ at: 0, value: { scale: 1.5, focus: 'face' as const } }] } : s) }).timeline;
    const segs = applyTracks(z, { faces: { cam: movingFace(0.2, 0.8, 8) } });
    const keys = segs[0]!.zoom!;
    expect(keys.length).toBeGreaterThanOrEqual(2); // linear motion reduces to its end keyframes
    expect(keys.every((k) => k.value.scale === 1.5)).toBe(true);
    const xs = keys.map((k) => (k.value.focus as { x: number }).x);
    expect(xs[xs.length - 1]!).toBeGreaterThan(xs[0]! + 300);
    expect(segs[1]).toBe(z.segments[1]); // untouched
    // without the track: unchanged
    expect(applyTracks(z, {})[0]).toBe(z.segments[0]);
  });
  it('followClicks punches in toward clicks on screen segments, grouping close clicks', () => {
    const cursor: CursorEvent[] = [
      { t_ms: 5000, x: 0.25, y: 0.25, click: true },
      { t_ms: 5800, x: 0.3, y: 0.3, click: true }, // within the hold → same group
      { t_ms: 7500, x: 0.75, y: 0.75, click: true },
      { t_ms: 1000, x: 0.5, y: 0.5, click: true }, // during the camera segment → ignored
    ];
    const keys = clickZoom(t, t.segments[1]!, { cursor: { take_1: cursor } });
    // segment take time starts at 4 s; clicks at rel 30, 54, 105 → one group (gaps ≤ hold + 2 ramps); clamped to the segment
    expect(keys.map((k) => [k.at, k.value.scale])).toEqual([[19, 1], [30, 1.6], [54, 1.6], [105, 1.6], [119, 1]]);
    expect(keys[3]!.value.focus).toEqual({ x: 1440, y: 810 });
    expect(keys[1]!.value.focus).toEqual({ x: 480, y: 270 }); // screen-full fit: 0.25 × 1920, 0.25 × 1080
    const segs = applyTracks(t, { cursor: { take_1: cursor } }, { followClicks: true });
    expect(segs[1]!.zoom!.length).toBeGreaterThan(0);
    expect(segs[0]).toBe(t.segments[0]); // camera segment: no screen
    const v = applyOp(t, { op: 'setSegments', segments: segs }).timeline;
    expect(validateTimeline(v).ok).toBe(true);
    // a hand-made zoom is kept
    const manual = applyOp(t, { op: 'setSegments', segments: t.segments.map((s) => s.id === 'seg_scr' ? { ...s, zoom: [{ at: 0, value: { scale: 1.2, focus: { x: 1, y: 1 } } }] } : s) }).timeline;
    expect(applyTracks(manual, { cursor: { take_1: cursor } }, { followClicks: true })[1]!.zoom).toEqual(manual.segments[1]!.zoom);
  });
});

describe('overlaysFromInputLogs', () => {
  const t = applyOp(tl([
    seg('seg_scr', 0, 90, { layout: 'screen-full', screen: 'scr' }),
    seg('seg_cam', 90, 150, { layout: 'camera-full', camera: 'cam' }),
    seg('seg_scr2', 200, 260, { layout: 'split-v', top: 'scr', bottom: 'cam' }),
  ]), { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_click_1', at: 0, position: { x: 0, y: 0 } } }).timeline;
  const cursor: CursorEvent[] = [
    { t_ms: 1000, x: 0.5, y: 0.5, click: true }, // seg_scr frame 30
    { t_ms: 1500, x: 0.5, y: 0.5 }, // move, not a click
    { t_ms: 4000, x: 0.5, y: 0.5, click: true }, // camera segment: not shown
    { t_ms: 5000, x: 0.5, y: 0.5, click: true }, // cut (take 150..200)
    { t_ms: 7000, x: 0.5, y: 0.25, click: true }, // seg_scr2 (take 200 → timeline 150): frame 160
  ];
  const keys = [
    { t_ms: 500, keys: ['⌘', 'K'] }, { t_ms: 900, keys: ['⌘', 'K'] }, // repeated → one longer badge
    { t_ms: 1200, keys: ['h'] }, // typing: skipped
    { t_ms: 2000, keys: ['Ctrl', 'S'] },
    { t_ms: 3500, keys: ['⌘', 'Z'] }, // in seg_cam: not shown
  ];
  it('makes click rings at mapped frames and layout positions', () => {
    const o = overlaysFromInputLogs(t, { cursor: { take_1: cursor }, keys: { take_1: keys } });
    const rings = o.filter((x) => x.kind === 'click-ring');
    expect(rings).toEqual([
      { kind: 'click-ring', id: 'ov_click_1_2', at: 30, position: { x: 960, y: 540 } },
      { kind: 'click-ring', id: 'ov_click_2', at: 160, position: { x: 960, y: expect.any(Number) } },
    ]);
    const ks = o.filter((x) => x.kind === 'keystroke');
    expect(ks.map((k) => [k.kind === 'keystroke' && k.keys.join('+'), k.kind === 'keystroke' && k.range.start, k.kind === 'keystroke' && k.range.end])).toEqual([
      ['⌘+K', 15, 60], ['Ctrl+S', 60, 90], // the repeat extended ⌘K to 63; the next shortcut cuts it at 60
    ]);
    const all = applyOps(t, o.map((overlay) => ({ op: 'addOverlay' as const, overlay }))).timeline;
    expect(validateTimeline(all).ok).toBe(true);
  });
  it('options: all keys, no clicks, no keys', () => {
    expect(overlaysFromInputLogs(t, { keys: { take_1: keys } }, { shortcutsOnly: false }).filter((x) => x.kind === 'keystroke').length).toBe(3);
    expect(overlaysFromInputLogs(t, { cursor: { take_1: cursor } }, { clicks: false })).toEqual([]);
    expect(overlaysFromInputLogs(t, { keys: { take_1: keys } }, { keys: false })).toEqual([]);
    expect(overlaysFromInputLogs(t, {})).toEqual([]);
  });
});

describe('fitBubble', () => {
  it('uses the largest size up to the max with at most 3 lines and grows the bubble', () => {
    const short = fitBubble('AIに全部まかせたい', { w: 500, h: 150 }, { w: 650, h: 320 }, 62, 28);
    expect(short.size).toBe(62);
    expect(short.lines.length).toBeLessThanOrEqual(3);
    const long = fitBubble('動画編集をAIに全部まかせたいけど、本当に大丈夫？', { w: 500, h: 150 }, { w: 650, h: 320 }, 62, 28);
    expect(long.lines.length).toBeLessThanOrEqual(3);
    expect(long.h).toBeGreaterThan(150);
    expect(long.w).toBeLessThanOrEqual(650.5);
    expect(long.h).toBeLessThanOrEqual(320.5);
    for (const l of long.lines) expect(textWidthEm(l) * long.size).toBeLessThanOrEqual(650 * 0.84 + 1);
    const huge = fitBubble('あ'.repeat(200), { w: 500, h: 150 }, { w: 650, h: 320 }, 62, 28);
    expect(huge.size).toBe(28); // falls back to the smallest size
  });
});

describe('cursorFocusForSegments', () => {
  const t = tl([
    seg('seg_cam', 0, 60, { layout: 'camera-full', camera: 'cam' }),
    seg('seg_scr', 60, 120, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } }),
    seg('seg_scr2', 120, 180, { layout: 'screen-full', screen: 'scr' }),
  ]);
  const log: CursorEvent[] = [
    { t_ms: 500, x: 0.1, y: 0.1 }, // camera segment: ignored
    { t_ms: 2100, x: 0.8, y: 0.5 }, { t_ms: 2500, x: 0.82, y: 0.6 }, { t_ms: 3000, x: 0.05, y: 0.5 }, // median x .8
  ];
  it('returns the crop focus around the median cursor of each screen segment', () => {
    const f = cursorFocusForSegments(t, log);
    expect(Object.keys(f)).toEqual(['seg_scr']); // seg_scr2 has no events, seg_cam no screen
    expect(f.seg_scr).toEqual(focusForPoint({ x: 0.8, y: 0.5 }, { width: 1920, height: 1080 }, { width: 1080, height: 960 }));
    expect(f.seg_scr!.x).toBeGreaterThan(0.8);
    expect(cursorFocusForSegments(t, { take_1: log })).toEqual(f);
    expect(cursorFocusForSegments(t, { take_9: log })).toEqual({});
    // feeds deriveVariant directly
    const v = deriveVariant(t, 'tiktok', { selection: ['seg_scr'], screenFocus: f });
    expect(v.segments[0]!.video).toMatchObject({ layout: 'split-v', topFocus: f.seg_scr });
  });
});
