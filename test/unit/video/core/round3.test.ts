import { describe, expect, it } from 'vitest';
import type { Scene, Timeline } from '@video/core';
import { applyOp, applyOps, compile, layoutAt, PATTERNS, renderScene, validateTimeline, wipeGeometry } from '@video/core';
import { D, fixture } from './fixtures.js';
import { SAMPLE_SLOTS } from './pattern-samples.js';

const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;
const opts = { quality: 'preview' as const, projectDir: '/p' };
const sc = (id: string, range: { start: number; end: number }, anchor?: Scene['anchor']): Scene => ({
  id, pattern: { id: 'quote', version: '1' }, range, slots: SAMPLE_SLOTS.quote!, decided: D, ...(anchor ? { anchor } : {}),
});
const undo = (t: Timeline, op: Parameters<typeof applyOp>[1]) => {
  const r = applyOp(t, op);
  expect(applyOps(r.timeline, r.inverse).timeline).toEqual(t);
  return r.timeline;
};

describe('scene anchors', () => {
  const base = applyOps(fixture(), [
    { op: 'addScene', scene: sc('scn_a', { start: 0, end: 30 }, { segment: 'seg_b', offset: 10 }) },
    { op: 'addScene', scene: sc('scn_free', { start: 5, end: 25 }) },
  ]).timeline;
  it('addScene places an anchored scene relative to its segment (length kept)', () => {
    expect(base.scenes[0]!.range).toEqual({ start: 100, end: 130 }); // seg_b starts at 90
    expect(base.scenes[1]!.range).toEqual({ start: 5, end: 25 });
    expect(validateTimeline(base).issues.filter((i) => i.path.startsWith('scenes'))).toEqual([]);
  });
  it('moves with segment moves, trims and removals of earlier segments; undo restores', () => {
    let t = undo(base, { op: 'moveSegment', id: 'seg_b', index: 0 });
    expect(t.scenes[0]!.range).toEqual({ start: 10, end: 40 });
    expect(t.scenes[1]!.range).toEqual({ start: 5, end: 25 }); // unanchored stays
    t = undo(base, { op: 'trimSegment', id: 'seg_a', from: 30, decided: D });
    expect(t.scenes[0]!.range.start).toBe(70);
    t = undo(base, { op: 'removeSegment', id: 'seg_a', decided: D });
    expect(t.scenes[0]!.range.start).toBe(10);
    t = undo(base, { op: 'cutText', from: 0, to: 30, take: 'take_1', decided: D });
    expect(t.scenes[0]!.range.start).toBe(70);
  });
  it('a removed anchor segment leaves the scene in place and warns', () => {
    const t = undo(base, { op: 'removeSegment', id: 'seg_b', decided: D });
    expect(t.scenes[0]!.range).toEqual({ start: 100, end: 130 });
    const w = validateTimeline(t).issues;
    expect(w.some((i) => /anchor segment "seg_b" does not exist/.test(i.message))).toBe(true);
  });
  it('validation warns when an anchored range was edited by hand', () => {
    const t = structuredClone(base);
    t.scenes[0]!.range = { start: 0, end: 30 };
    expect(validateTimeline(t).issues.some((i) => /does not follow its anchor \(expected start 100\)/.test(i.message))).toBe(true);
  });
});

describe('wipe size and style', () => {
  const withWipe = (wipe: Record<string, unknown>) => applyOp(fixture(), {
    op: 'setVideo', id: 'seg_a', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'bl', style: 'plain', ...wipe } as never }, decided: D,
  }).timeline;
  it('size scales the wipe (schema 0.15–0.5)', () => {
    expect(wipeGeometry({ corner: 'bl', size: 0.5 }, 1920, 1080)).toEqual({ d: 540, x: 43, y: 1080 - 540 - 43 });
    expect(wipeGeometry({ corner: 'tr' }, 1920, 1080)).toEqual({ d: 324, x: 1920 - 324 - 43, y: 43 });
    expect(fc(compile(withWipe({ size: 0.2 }), opts).chunks[0]!.args)).toContain('crop=108:108');
    expect(layoutAt(withWipe({ size: 0.2 }), 0)[0]).toMatchObject({ kind: 'wipe', rect: { w: 216, h: 216 } });
    expect(validateTimeline(withWipe({ size: 0.6 })).ok).toBe(false);
    expect(validateTimeline(withWipe({ size: 0.1 })).ok).toBe(false);
  });
  it('ring-gradient draws an orange→red ring over the camera; shadow goes under it; plain adds nothing', () => {
    const ring = fc(compile(withWipe({ style: 'ring-gradient' }), opts).chunks[0]!.args);
    expect(ring).toMatch(/color=c=black@0:s=\d+x\d+.*geq=r='255':g='138-93\*X\/W':b='85\*X\/W'/);
    expect(ring).toMatch(/\[c\d+\]\[wd\d+\]overlay=x=16:y=350/); // ring over the composited camera
    const shadow = fc(compile(withWipe({ style: 'shadow' }), opts).chunks[0]!.args);
    expect(shadow).toContain("geq=r='0':g='0':b='0':a='150*clip(1-");
    expect(shadow).toMatch(/\[s0\]\[wd\d+\]overlay/); // shadow onto the screen, before the camera
    const rounded = fc(compile(withWipe({ style: 'ring-gradient', shape: 'rounded' }), opts).chunks[0]!.args);
    expect(rounded).toContain('abs(X-');
    const plain = fc(compile(withWipe({}), opts).chunks[0]!.args);
    expect(plain).not.toContain('color=c=black@0');
    expect(fc(compile(withWipe({ style: 'whatever' }), opts).chunks[0]!.args)).toBe(plain);
  });
});

describe('audio drift resampling', () => {
  it('resamples the voice from a drifting camera and re-times its video', () => {
    const t = structuredClone(fixture());
    delete (t.sources as Record<string, unknown>).mic;
    (t.sources.cam as { drift?: number }).drift = 1.001;
    const p = compile(t, opts);
    const a = fc(p.audio.args);
    expect(a).toContain(`aresample=192000,asetrate=${Math.round(192000 * 1.001)},aresample=48000`);
    expect(a).not.toContain('atempo');
    expect(fc(p.chunks[0]!.args)).toContain('setpts=(PTS-STARTPTS)/1.001');
    // no drift → no resampling
    expect(fc(compile(fixture(), opts).audio.args)).not.toContain('asetrate');
  });
  it('synced scene wipes of a drifting camera are re-timed too', () => {
    let t = applyOp(fixture(), { op: 'addSource', id: 'ill', source: { kind: 'asset', path: 'i.png', assetId: 'i', license: { id: 'CC0-1.0' } } }).timeline;
    t = applyOp(t, { op: 'updateSource', id: 'cam', patch: { drift: 1.002 } }).timeline;
    t = applyOp(t, { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'explain-illust-bubbles', version: '1' }, range: { start: 0, end: 60 }, slots: SAMPLE_SLOTS['explain-illust-bubbles']!, decided: D } }).timeline;
    const g = fc(compile(t, opts).chunks[0]!.args);
    expect(g.match(/setpts=\(PTS-STARTPTS\)\/1\.002/g)!.length).toBeGreaterThanOrEqual(2); // segment camera + wipe
  });
});

describe('scene media fades across chunks', () => {
  const t = applyOps(fixture(), [
    { op: 'addSource', id: 'ill', source: { kind: 'asset', path: 'i.png', assetId: 'i', license: { id: 'CC0-1.0' } } },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'explain-illust-bubbles', version: '1' }, range: { start: 20, end: 90 }, slots: SAMPLE_SLOTS['explain-illust-bubbles']!, decided: D } },
  ]).timeline;
  const p = compile(t, { ...opts, maxChunkFrames: 10 });
  const g = (i: number) => fc(p.chunks[i]!.args);
  it('fades in only where the media starts, continues a ramp mid-fade, and does nothing later', () => {
    // illustration starts at 23 (0.1 s delay), fade 0.25 s (8 frames) → frames 23..31
    expect(g(2)).toContain('fade=t=in:st=0.1:d=0.266667:alpha=1'); // chunk 20..30
    expect(g(3)).toMatch(/a='alpha\(X,Y\)\*clip\(\(T-\(-0\.233333\)\)\/0\.266667,0,1\)'/); // chunk 30..40 continues
    expect(g(4)).not.toMatch(/fade=t=in|clip\(\(T-/); // chunk 40..50: already visible
  });
});

describe('fonts', () => {
  it('pattern text uses Noto Sans JP with heavy weights and JetBrains Mono for code', () => {
    const t = fixture();
    const bubbles = renderScene({ id: 'scn_1', pattern: { id: 'explain-illust-bubbles', version: '1' }, range: { start: 0, end: 60 }, slots: { ...SAMPLE_SLOTS['explain-illust-bubbles']!, illustration: { kind: 'image', asset: 'logo' } }, decided: D }, t)!;
    expect(bubbles.front.join('\n')).toContain('\\fnNoto Sans JP\\fs');
    expect(bubbles.front.join('\n')).toContain('\\b900');
    const code = renderScene({ id: 'scn_2', pattern: { id: 'code-focus', version: '1' }, range: { start: 0, end: 60 }, slots: SAMPLE_SLOTS['code-focus']!, decided: D }, t)!;
    expect(code.front.join('\n')).toContain('\\fnJetBrains Mono');
    expect(PATTERNS['code-focus']).toBeDefined();
  });
  it('compile passes fontsDir to every libass pass', () => {
    const t = applyOp(fixture(), { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'quote', version: '1' }, range: { start: 0, end: 60 }, slots: SAMPLE_SLOTS.quote!, decided: D } }).timeline;
    const g = fc(compile(t, { ...opts, fontsDir: '/fonts' }).chunks[0]!.args);
    expect(g.match(/subtitles=filename=[^,]*:fontsdir=\/fonts:original_size=/g)).toHaveLength(2); // back + front
  });
});
