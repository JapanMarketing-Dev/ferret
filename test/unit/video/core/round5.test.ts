import { describe, expect, it } from 'vitest';
import type { BenchmarkSample, Caption, Segment, SfxLibraryItem, Timeline } from '@video/core';
import {
  applyOp, applyOps, benchmarkProfile, cameraMaterial, checkCameraSwitches, checkCaptionFaceOverlap, checkCaptionSafeArea,
  checkMosaicTracking, compile, deriveVariant, emptyTimeline, masksFromPii, profileToTemplatePatch, safeRect, sfxFromRules,
  splitForSwitch, takenIds, validateTimeline, voiceChain,
} from '@video/core';
import { D } from './fixtures.js';

const F30 = { num: 30, den: 1 };
const seg = (id: string, from: number, to: number, video: Segment['video'], extra: Partial<Segment> = {}): Segment => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video, decided: D, ...extra,
});
const cam = { layout: 'camera-full' as const, camera: 'cam' };
const side = { layout: 'camera-full' as const, camera: 'side' };
const cap = (id: string, start: number, end: number, extra: Partial<Caption> = {}): Caption => ({
  id, range: { start, end }, text: 'テスト', spoken: 'テスト', words: [], lines: ['テスト'], emphasis: [], style: 'tiktok-bold',
  position: { anchor: 'bottom', y: 0.9 }, decided: D, ...extra,
});

function tl(segments: Segment[], canvas = { width: 1920, height: 1080 }): Timeline {
  const e = emptyTimeline({ title: 't', kind: 'talk', template: { id: 'talk', version: '1' }, canvas: { ...canvas, fps: F30 }, language: 'ja', targets: ['youtube'] });
  return applyOps({
    ...e,
    sources: {
      cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
      side: { kind: 'camera', path: 'side.mp4', take: 'take_1', role: 'side', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
      imp: { kind: 'camera', path: 'imp.mp4', role: 'wide', fps: F30, size: { width: 1920, height: 1080 }, offset: 30 },
      other: { kind: 'camera', path: 'o.mp4', take: 'take_2', role: 'close', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
      scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'main', fps: F30, size: { width: 1920, height: 1080 }, offset: 0 },
      pop1: { kind: 'asset', path: 'sfx/pop1.wav', assetId: 'pop1', license: { id: 'CC0-1.0' } },
    },
    outline: [
      { id: 'ch_1', title: 'a', start: 0, end: 300, points: [], importance: 'core' },
      { id: 'ch_2', title: 'b', start: 300, end: 3600 * 30, points: [], importance: 'core' },
    ],
  }, [{ op: 'setSegments', segments }]).timeline;
}

describe('voice chain', () => {
  it('preview is cheap, final adds compressor and de-ess EQ', () => {
    expect(voiceChain({ denoise: 'light', eq: 'voice-default' }, 'preview')).toEqual(['highpass=f=80', 'afftdn=nr=8:nf=-45']);
    const f = voiceChain({ denoise: 'strong', eq: 'voice-default' }, 'final');
    expect(f).toEqual(['highpass=f=80', 'afftdn=nr=20:nf=-40:tn=1', 'acompressor=threshold=0.1:ratio=2.5:attack=10:release=150:knee=4:makeup=1.5', 'equalizer=f=6500:t=q:w=1.5:g=-3']);
    expect(voiceChain({ denoise: 'off', eq: 'off' }, 'final')).toEqual(['acompressor=threshold=0.1:ratio=2.5:attack=10:release=150:knee=4:makeup=1.5']);
    expect(voiceChain({ denoise: 'off', eq: 'off' }, 'preview')).toEqual([]);
    expect(voiceChain({ denoise: 'off', eq: 'voice-bright' }, 'final').at(-1)).toBe('equalizer=f=3500:t=q:w=1:g=3');
    expect(voiceChain({ denoise: 'off', eq: 'voice-warm' }, 'final')[0]).toBe('highpass=f=70');
  });
  it('compile uses it per quality', () => {
    const t = tl([seg('seg_a', 0, 90, cam)]);
    const fc = (q: 'preview' | 'final') => { const a = compile(t, { quality: q, target: 'youtube', projectDir: '/p' }).audio.args; return a[a.indexOf('-filter_complex') + 1]!; };
    expect(fc('final')).toContain('acompressor=');
    expect(fc('preview')).not.toContain('acompressor=');
  });
});

describe('sfxFromRules', () => {
  const lib: SfxLibraryItem[] = [
    { id: 'pop1', kind: 'pop', durationMs: 200 },
    { id: 'pop2', kind: 'pop', durationMs: 200, path: 'sfx/pop2.wav', license: { id: 'CC0-1.0' } },
    { id: 'whoosh1', kind: 'whoosh', durationMs: 500, path: 'sfx/whoosh1.wav', license: { id: 'CC0-1.0' } },
    { id: 'nofile', kind: 'ding', durationMs: 300 },
  ];
  const base = applyOps(tl([seg('seg_a', 0, 300, cam), seg('seg_b', 300, 600, side), seg('seg_c', 600, 900, cam)]), [
    { op: 'setCaptions', captions: [
      cap('cap_1', 30, 90, { emphasis: [{ word: '大事', style: 'color' }], words: [{ text: 'これが', start: 30, end: 50 }, { text: '大事', start: 50, end: 70 }] }),
      cap('cap_2', 400, 460, { emphasis: [{ word: '結論', style: 'scale' }] }),
    ] },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 620, end: 700 }, slots: { title: { kind: 'text', text: 'x' } }, decided: D } },
  ]).timeline;
  const rules = { rules: [
    { on: 'emphasis' as const, kind: 'pop' }, { on: 'section' as const, kind: 'whoosh' }, { on: 'cut' as const, kind: 'none' },
    { on: 'scene-in' as const, kind: 'ding' },
  ], gainDb: -9 };
  it('places sfx on events by rule, adds missing library sources, is deterministic and valid', () => {
    const ops = sfxFromRules(base, rules, lib, { words: [] });
    expect(ops).toEqual(sfxFromRules(base, rules, lib, { words: [] }));
    const sfx = ops.filter((o) => o.op === 'addSfx').map((o) => (o.op === 'addSfx' ? [o.sfx.at, o.sfx.trigger, o.sfx.gainDb] : []));
    expect(sfx).toEqual([[50, 'emphasis', -9], [300, 'section', -9], [400, 'emphasis', -9]]); // ding has no file → skipped; cut 'none'
    expect(ops.some((o) => o.op === 'addSource' && o.id === 'whoosh1')).toBe(true);
    const v = applyOps(base, ops).timeline;
    expect(validateTimeline(v).ok).toBe(true);
    expect(v.audio.sfx.every((s) => s.decided.by === 'template' && s.ruleRef?.startsWith('sfx.rules['))).toBe(true);
  });
  it('probability is a seeded, stable roll', () => {
    const many = applyOp(base, { op: 'setCaptions', captions: Array.from({ length: 60 }, (_, i) => cap(`cap_${i}`, i * 30, i * 30 + 20, { emphasis: [{ word: 'x', style: 'color' }] })) }).timeline;
    const r = (seed: string) => sfxFromRules(many, { rules: [{ on: 'emphasis', kind: 'pop', probability: 0.5 }], seed, minSpacingMs: 0 }, lib, { words: [] }).filter((o) => o.op === 'addSfx').length;
    expect(r('a')).toBe(r('a'));
    // 30 captions fall inside the 900-frame timeline → about 15 pass a 0.5 roll
    expect(r('a')).toBeGreaterThan(6);
    expect(r('a')).toBeLessThan(24);
    expect([r('a'), r('b'), r('c')].some((n) => n !== r('a'))).toBe(true);
  });
  it('respects maxPerMin (counting existing sfx), spacing and priority', () => {
    const many = applyOps(base, [
      { op: 'setCaptions', captions: Array.from({ length: 40 }, (_, i) => cap(`cap_${i}`, i * 45, i * 45 + 20, { emphasis: [{ word: 'x', style: 'color' }] })) },
      { op: 'addSfx', sfx: { id: 'sfx_manual', asset: 'pop1', at: 10, gainDb: 0, trigger: 'manual', decided: D } },
    ]).timeline;
    const ops = sfxFromRules(many, { rules: [{ on: 'emphasis', kind: 'pop' }, { on: 'section', kind: 'whoosh' }], maxPerMin: 5 }, lib, { words: [] });
    const at = [10, ...ops.flatMap((o) => (o.op === 'addSfx' ? [o.sfx.at] : []))].sort((a, b) => a - b);
    for (const s of at) expect(at.filter((x) => x >= s && x < s + 1800).length).toBeLessThanOrEqual(5);
    expect(at).toContain(300); // the section won its slot (priority over emphasis)
    // spacing: an emphasis 10 frames after the section is dropped
    const close = applyOp(base, { op: 'setCaptions', captions: [cap('cap_x', 305, 330, { emphasis: [{ word: 'x', style: 'color' }] })] }).timeline;
    const o2 = sfxFromRules(close, rules, lib, { words: [] }).filter((o) => o.op === 'addSfx');
    expect(o2.map((o) => o.op === 'addSfx' && o.sfx.trigger)).toEqual(['section']);
  });
  it('moves section/cut sfx before a speech onset, or lowers them when they cannot move', () => {
    const r = { rules: [{ on: 'section' as const, kind: 'whoosh' }, { on: 'cut' as const, kind: 'pop' }] };
    // whoosh = 500 ms = 15 frames; an onset at 312 needs a 5-frame move (≤ 250 ms) → ends 2 frames before it
    const shifted = sfxFromRules(base, r, lib, { words: [{ start: 312, end: 330 }] }).find((o) => o.op === 'addSfx' && o.sfx.trigger === 'section');
    expect(shifted && shifted.op === 'addSfx' && [shifted.sfx.at, shifted.sfx.gainDb]).toEqual([295, -8]);
    // an onset at 302 would need 15 frames (> 250 ms): stays, 6 dB quieter
    const quiet = sfxFromRules(base, r, lib, { words: [{ start: 302, end: 330 }] }).find((o) => o.op === 'addSfx' && o.sfx.trigger === 'section');
    expect(quiet && quiet.op === 'addSfx' && [quiet.sfx.at, quiet.sfx.gainDb]).toEqual([300, -14]);
  });
});

describe('multicam', () => {
  const t = tl([seg('seg_a', 0, 150, cam), seg('seg_b', 150, 300, cam), seg('seg_c', 300, 330, side), seg('seg_d', 330, 450, side)]);
  const tracks = {
    faces: {
      cam: { fps: 30, frames: Array.from({ length: 450 }, (_, f) => ({ f, faces: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.3, score: 0.9, gaze: 0.8 }], sharp: 0.9 })) },
      side: { fps: 30, frames: Array.from({ length: 450 }, (_, f) => ({ f, faces: f < 200 ? [] : [{ x: 0.4, y: 0.2, w: 0.2, h: 0.3, score: 0.9 }] })) },
    },
  };
  const words = [{ w: 'こんにちは', start: 0.5, end: 1.5 }, { w: '結論', start: 9.8, end: 10.4 }];
  it('cameraMaterial measures faces, gaze, speech and emphasis per segment', () => {
    const t2 = applyOp(t, { op: 'setCaptions', captions: [cap('cap_1', 10, 40, { emphasis: [{ word: '大事', style: 'color' }] })] }).timeline;
    const m = cameraMaterial(t2, tracks, words);
    expect(m.map((x) => x.segment)).toEqual(['seg_a', 'seg_b', 'seg_c', 'seg_d']);
    expect(m[0]).toMatchObject({ take: 'take_1', durationSec: 5, current: 'cam', speaking: true, words: 1, emphasisWords: ['大事'] });
    expect(m[0]!.speechRatio).toBeCloseTo(0.2, 3);
    expect(m[0]!.cameras.map((c) => c.id)).toEqual(['cam', 'imp', 'side']); // other take excluded, imported included
    expect(m[0]!.cameras[0]).toEqual({ id: 'cam', role: 'front', faceVisible: 1, faceArea: 0.06, lookingAtCamera: 0.8, sharp: 0.9 });
    expect(m[0]!.cameras[1]).toEqual({ id: 'imp', role: 'wide', faceVisible: null, faceArea: null });
    expect(m[0]!.cameras[2]!.faceArea).toBeNull(); // side: no face in these frames
    expect(m[0]!.cameras[2]!.faceVisible).toBe(0);
    expect(m[2]!.speaking).toBe(true); // "結論" spans 9.8–10.4 s, seg_c is 10–11 s
    expect(m[3]!.speaking).toBe(false);
    expect(cameraMaterial(t, {}, undefined)[0]!.cameras[0]!.faceVisible).toBeNull();
  });
  it('splitForSwitch produces chained splits that apply cleanly', () => {
    const ops = splitForSwitch(t.segments[0]!, [100, 40, 40, 0, 150, 200], { taken: takenIds(t) });
    expect(ops).toEqual([
      { op: 'splitSegment', id: 'seg_a', atSource: 40, newId: 'seg_a_s1' },
      { op: 'splitSegment', id: 'seg_a_s1', atSource: 100, newId: 'seg_a_s2' },
    ]);
    const v = applyOps(t, ops).timeline;
    expect(v.segments.slice(0, 3).map((s) => [s.id, s.src.from, s.src.to])).toEqual([['seg_a', 0, 40], ['seg_a_s1', 40, 100], ['seg_a_s2', 100, 150]]);
    const taken = new Set(['seg_a_s1']);
    expect(splitForSwitch(t.segments[0]!, [50], { taken })[0]).toMatchObject({ newId: 'seg_a_s1_2' });
    expect(splitForSwitch(t.segments[0]!, [])).toEqual([]);
    // by id, against the timeline's ids
    expect(splitForSwitch(t, 'seg_a', [100, 40])).toEqual(ops);
    expect(() => splitForSwitch(t, 'seg_nope', [10])).toThrow(/unknown segment/);
  });
  it('checkCameraSwitches: long runs and switches inside words fail; short shots need a human', () => {
    const r = checkCameraSwitches(t, { words, maxShotSec: 8, minShotSec: 1.5 });
    expect(r.status).toBe('fail');
    expect(r.items!.map((i) => [i.ref, i.note])).toEqual([
      ['seg_a', 'same shot for 10.0 s (max 8.0 s)'],
      ['seg_c', 'switch inside the word "結論"'],
    ]);
    const ok = checkCameraSwitches(t, { maxShotSec: 12, minShotSec: 0.5 });
    expect(ok.status).toBe('pass');
    const short = checkCameraSwitches(tl([seg('seg_a', 0, 150, cam), seg('seg_b', 150, 165, side), seg('seg_c', 165, 300, cam)]), { maxShotSec: 12 });
    expect(short).toMatchObject({ status: 'needs-human', items: [{ ref: 'seg_b', note: 'very short shot (0.50 s)' }] });
  });
});

describe('track-based checks', () => {
  const faceAt = (y: number) => ({ cam: { fps: 30, frames: Array.from({ length: 90 }, (_, f) => ({ f, faces: [{ x: 0.4, y, w: 0.2, h: 0.2, score: 0.9 }] })) } });
  it('caption-face-overlap flags captions over a face', () => {
    const t = applyOp(tl([seg('seg_a', 0, 90, cam)]), { op: 'setCaptions', captions: [cap('cap_1', 0, 60, { position: { anchor: 'bottom', y: 0.9 } })] }).timeline;
    const low = checkCaptionFaceOverlap(t, { faces: faceAt(0.75) });
    expect(low).toMatchObject({ check: 'caption-face-overlap', status: 'needs-human', items: [{ ref: 'cap_1', frame: 0 }] });
    expect(checkCaptionFaceOverlap(t, { faces: faceAt(0.1) }).status).toBe('pass');
    expect(checkCaptionFaceOverlap(t, {}).status).toBe('pass');
  });
  it('caption-safe-area per target preset', () => {
    expect(safeRect('tiktok', { width: 1080, height: 1920 })).toEqual({ x: 80, y: 220, w: 820, h: 1260 });
    expect(safeRect('youtube', { width: 1920, height: 1080 })).toEqual({ x: 96, y: 54, w: 1728, h: 972 });
    const v = tl([seg('seg_a', 0, 90, cam)], { width: 1080, height: 1920 });
    const bad = applyOp(v, { op: 'setCaptions', captions: [cap('cap_1', 0, 30, { position: { anchor: 'bottom', y: 0.95 } })] }).timeline;
    expect(checkCaptionSafeArea(bad, 'tiktok')).toMatchObject({ status: 'fail', items: [{ ref: 'cap_1', note: expect.stringContaining('bottom') }] });
    const good = applyOp(v, { op: 'setCaptions', captions: [cap('cap_1', 0, 30, { position: { anchor: 'bottom', y: 0.7 } })] }).timeline;
    expect(checkCaptionSafeArea(good, 'tiktok').status).toBe('pass');
    expect(checkCaptionSafeArea(good, 'youtube-shorts').status).toBe('pass');
    const wide = applyOp(v, { op: 'setCaptions', captions: [cap('cap_1', 0, 30, { position: { anchor: 'bottom', y: 0.7 }, lines: ['あ'.repeat(20)] })] }).timeline;
    expect(checkCaptionSafeArea(wide, 'tiktok').items![0]!.note).toMatch(/left, right/);
  });
  it('mosaic-tracking: visible PII must be covered by a mask', () => {
    const t = tl([seg('seg_s', 0, 90, { layout: 'screen-full', screen: 'scr' })]);
    const pii = { scr: { frames: [{ f: 30, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05, kind: 'email', text: 'a@b.c' }] }] } };
    const fail = checkMosaicTracking(t, pii);
    expect(fail).toMatchObject({ status: 'fail', items: [{ frame: 30, ref: 'scr', note: 'email "a@b.c" is visible without a mask' }] });
    const masked = applyOps(t, masksFromPii(pii.scr, 'scr', { size: { width: 1920, height: 1080 } })).timeline;
    expect(checkMosaicTracking(masked, pii).status).toBe('pass');
    // in a vertical variant whose crop cuts the box away, it is not visible
    const v = deriveVariant(tl([seg('seg_c', 0, 90, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } })]), 'tiktok', { selection: ['seg_c'] });
    expect(checkMosaicTracking(v, pii).status).toBe('fail'); // x 0.1–0.3 is partly inside the centre crop (≈0.18–0.82)
    const edge = { scr: { frames: [{ f: 30, boxes: [{ x: 0.02, y: 0.1, w: 0.1, h: 0.05, kind: 'email' }] }] } };
    expect(checkMosaicTracking(v, edge).status).toBe('pass'); // cropped away in 9:16
    expect(checkMosaicTracking(t, edge).status).toBe('fail'); // but visible in 16:9
    expect(checkMosaicTracking(t, {}).status).toBe('pass');
  });
  it('masksFromPii links boxes into padded tracks with needsReview', () => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => ({ f: i, boxes: [{ x: 0.1 + i * 0.01, y: 0.1, w: 0.2, h: 0.05, kind: 'email', text: 'a@b.c' }, { x: 0.6, y: 0.8, w: 0.1, h: 0.05, kind: 'phone' }] })),
      { f: 60, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05, kind: 'email', text: 'a@b.c' }] }, // after a long gap: a new track
    ];
    const ops = masksFromPii({ frames }, 'scr', { size: { width: 1000, height: 1000 } });
    expect(ops).toHaveLength(3);
    const masks = ops.map((o) => (o.op === 'addMask' ? o.mask : null)!);
    expect(masks.map((m) => [m.id, m.reason, m.track.length])).toEqual([['mask_pii_1', 'pii:email', 2], ['mask_pii_2', 'pii:phone', 2], ['mask_pii_3', 'pii:email', 1]]);
    expect(masks[0]!.track[0]!.box).toEqual({ x: 70, y: 93, w: 260, h: 65 }); // 15 % padding each side (92.5–157.5)
    expect(masks.every((m) => m.decided.needsReview)).toBe(true);
    expect(masksFromPii({ frames }, 'scr', { size: { width: 1000, height: 1000 }, kinds: ['phone'] })).toHaveLength(1);
    const t = tl([seg('seg_s', 0, 90, { layout: 'screen-full', screen: 'scr' })]);
    expect(validateTimeline(applyOps(t, ops).timeline).ok).toBe(true);
    // edges are clipped to the frame
    const edge = masksFromPii({ frames: [{ f: 0, boxes: [{ x: 0.95, y: 0.97, w: 0.05, h: 0.03, kind: 'token' }] }] }, 'scr', { size: { width: 1000, height: 1000 } });
    const box = edge[0]!.op === 'addMask' ? edge[0]!.mask.track[0]!.box : null;
    expect(box!.x + box!.w).toBeLessThanOrEqual(1000);
    expect(box!.y + box!.h).toBeLessThanOrEqual(1000);
  });
});

describe('benchmark profile', () => {
  // 60 s: captions bottom at 0.8 (h 0.05, 14–18 chars), a cut every 2.5 s, sfx on every other cut and on caption
  // changes, bgm −20 dB, a punch-in (1.1) every 10 s, 380 chars/min
  const samples: BenchmarkSample[] = Array.from({ length: 60 }, (_, t) => {
    const cuts = [t, t + 0.5].filter((x) => Math.round(x * 2) % 5 === 0);
    const capText = `cap${Math.floor(t / 3)}`;
    return {
      t,
      captionBoxes: [{ x: 0.2, y: 0.75, w: 0.6, h: 0.05, chars: 14 + (t % 5), lines: 1, text: capText }],
      captionColors: { fill: '#FFFFFF', stroke: '#000000', strokeWidthRatio: 0.12, box: false, reveal: 'word-highlight', ...(t % 5 === 0 ? { emphasisColor: '#FFE14D', emphasisScale: 1.15 } : {}) },
      cutTimes: cuts,
      loudness: -14,
      speechLufs: -15,
      bgmRelDb: -20,
      sfxOnsets: [...(t % 5 === 0 ? [t] : []), ...(t % 3 === 0 ? [t + 0.1] : [])],
      sfxKinds: [...(t % 5 === 0 ? ['pop'] : []), ...(t % 3 === 0 ? ['whoosh'] : [])],
      charsPerMin: 380,
      ...(t % 10 === 0 ? { punchIn: 1.1 } : {}),
    };
  });
  it('summarizes captions, cuts, audio, sfx and speech', () => {
    const p = benchmarkProfile(samples, { source: { platform: 'youtube', analyzed: '00:00-01:00' } });
    expect(p.durationSec).toBe(60);
    expect(p.captions).toMatchObject({ present: true, anchorY: 0.8, heightRatio: 0.05, lines: 1, fill: '#FFFFFF', box: false, reveal: 'word-highlight', stroke: { color: '#000000', widthRatio: 0.12 } });
    expect(p.captions.charsPerLine).toEqual({ p50: 16, p90: 18 });
    expect(p.captions.emphasis).toEqual({ rate: 0.2, color: '#FFE14D', scale: 1.15 });
    expect(p.cuts.jumpCutsPerMin).toBe(24);
    expect(p.cuts.avgShotSec).toBeCloseTo(60 / 25, 2);
    expect(p.cuts.punchIn).toEqual({ perMin: 6, scale: 1.1 });
    expect(p.audio).toEqual({ speechLufs: -15, bgm: { present: true, relDb: -20 } });
    expect(p.sfx.perMin).toBe(32);
    expect(p.sfx.kinds).toEqual({ pop: 0.38, whoosh: 0.63 });
    expect(p.sfx.on.cut).toBeGreaterThan(0.3);
    expect(p.sfx.on.captionIn).toBeGreaterThan(0.3);
    expect(p.speech.charsPerMin).toBe(380);
    expect(() => benchmarkProfile([])).toThrow(/no samples/);
  });
  it('turns a profile into a template patch', () => {
    const patch = profileToTemplatePatch(benchmarkProfile(samples));
    // one 16:9 video: the heavy tech style (never the vertical tiktok one)
    expect(patch.captions).toEqual({ style: 'tech-bold', highlight: 'word', maxCharsPerLine: 18, maxLines: 1, position: { anchor: 'bottom', y: 0.8 }, emphasis: 'auto' });
    expect(patch.cut).toEqual({ jumpZoom: { every: 4, scale: 1.1 } });
    // a busy reference (32 a minute) is capped to a tasteful 8
    expect(patch.audio).toEqual({ bgm: { gainDb: -20 }, sfx: { maxPerMinute: 8, gainDb: -18 } });
    expect(patch.sfx!.maxPerMin).toBe(8);
    expect(patch.sfx!.rules).toContainEqual({ on: 'zoom-in', kind: 'swoosh-in', probability: 0.7 });
    expect(patch.sfx!.rules.map((r) => r.on)).toEqual(expect.arrayContaining(['section']));
    expect(patch.sfx!.rules.every((r) => r.kind === 'whoosh' || r.on === 'section' || r.on === 'zoom-in')).toBe(true);
    // characters per line unknown (no OCR): the template's value is kept
    const noChars = profileToTemplatePatch(benchmarkProfile(samples.map((s) => ({ ...s, captionBoxes: s.captionBoxes.map(({ chars: _c, ...b }) => b) }))));
    expect(noChars.captions!.maxCharsPerLine).toBeUndefined();
    expect(patch.captionLook).toMatchObject({ size: 0.05, fill: '#FFFFFF', emphasisColor: '#FFE14D' });
    const quiet = profileToTemplatePatch(benchmarkProfile(samples.map((s) => ({ ...s, captionBoxes: [], sfxOnsets: [], sfxKinds: [], bgmRelDb: undefined, punchIn: undefined }) as BenchmarkSample)));
    expect(quiet).toEqual({ captions: { highlight: 'none' } });
  });
});
