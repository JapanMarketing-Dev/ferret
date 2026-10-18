import { describe, expect, it } from 'vitest';
import type { Segment, Timeline } from '@video/core';
import {
  allIds, applyOp, applyOps, compile, deriveVariant, emptyTimeline, highlightScore, layoutAt, mainHash, pickHighlights,
  validateTimeline, variantStale, VERTICAL_SAFE,
} from '@video/core';
import { D } from './fixtures.js';
import { SAMPLE_SLOTS } from './pattern-samples.js';

const seg = (id: string, from: number, to: number, role: Segment['role'], chapter: string, video: Segment['video']): Segment => ({
  id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: id, chapter, role, video, decided: D,
});
const wipe = { layout: 'screen-with-wipe' as const, screen: 'scr', camera: 'cam', wipe: { shape: 'circle' as const, corner: 'br' as const, style: 'ring-gradient' } };
const cam = { layout: 'camera-full' as const, camera: 'cam' };

/** A tech main timeline: intro (aside), hook, explain (core), demo (core), aside, summary, cta. 30 fps, take frames = timeline frames. */
function main(): Timeline {
  const e = emptyTimeline({ title: 'Claude Code の設定', kind: 'tech', template: { id: 'tech', version: '1' }, canvas: { width: 1920, height: 1080, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube', 'tiktok', 'youtube-shorts'] });
  return applyOps({
    ...e,
    sources: {
      cam: { kind: 'camera', path: 'media/cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 },
      scr: { kind: 'screen', path: 'media/scr.mp4', take: 'take_1', display: 'main', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 },
      mic: { kind: 'mic', path: 'media/mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
      pop: { kind: 'asset', path: 'assets/pop.wav', assetId: 'pop', license: { id: 'CC0-1.0' } },
      music: { kind: 'asset', path: 'assets/bgm.mp3', assetId: 'bgm', license: { id: 'CC0-1.0' } },
      logo: { kind: 'asset', path: 'assets/logo.png', assetId: 'logo', license: { id: 'CC0-1.0' } },
      ill: { kind: 'asset', path: 'assets/ill.png', assetId: 'ill', license: { id: 'CC0-1.0' } },
    },
    outline: [
      { id: 'ch_intro', title: '導入', start: 0, end: 150, points: [], importance: 'aside' },
      { id: 'ch_main', title: '設定', start: 150, end: 600, points: ['3つのコツ'], importance: 'core' },
      { id: 'ch_end', title: 'まとめ', start: 600, end: 840, points: [], importance: 'support' },
    ],
  }, [
    { op: 'setSegments', segments: [
      seg('seg_intro', 0, 90, 'aside', 'ch_intro', cam), // 0..90
      seg('seg_hook', 90, 150, 'hook', 'ch_intro', cam), // 90..150
      seg('seg_explain', 150, 330, 'explain', 'ch_main', wipe), // 150..330
      seg('seg_demo', 330, 600, 'demo', 'ch_main', { layout: 'screen-full', screen: 'scr' }), // 330..600
      seg('seg_side', 600, 690, 'aside', 'ch_end', cam), // 600..690
      seg('seg_sum', 690, 780, 'summary', 'ch_end', cam), // 690..780
      seg('seg_cta', 780, 840, 'cta', 'ch_end', cam), // 780..840
    ] },
    { op: 'setCaptions', captions: [
      { id: 'cap_1', range: { start: 95, end: 140 }, text: '結論から言います', spoken: '結論から言います', words: [{ text: '結論', start: 95, end: 110 }, { text: 'から', start: 110, end: 120 }, { text: '言います', start: 120, end: 140 }], lines: ['結論から言います'], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.92 }, decided: D },
      { id: 'cap_2', range: { start: 320, end: 345 }, text: 'ここで画面', spoken: 'ここで画面', words: [{ text: 'ここで', start: 320, end: 330 }, { text: '画面', start: 330, end: 345 }], lines: ['ここで画面'], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.92 }, decided: D },
      { id: 'cap_3', range: { start: 10, end: 60 }, text: 'こんにちは', spoken: 'こんにちは', words: [], lines: ['こんにちは'], emphasis: [], style: 'youtube-clean', position: { anchor: 'bottom', y: 0.92 }, decided: D },
    ] },
    { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_t', range: { start: 100, end: 140 }, text: '3つのコツ', style: 'big', position: { x: 1800, y: 1000 }, decided: D } },
    { op: 'addOverlay', overlay: { kind: 'image', id: 'ov_i', range: { start: 160, end: 200 }, asset: 'logo', position: { x: 100, y: 100, w: 400, h: 200 }, decided: D } },
    { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_r', at: 400, position: { x: 960, y: 540 } } },
    { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 150, gainDb: -6, trigger: 'cut', decided: D } },
    { op: 'addSfx', sfx: { id: 'sfx_2', asset: 'pop', at: 50, gainDb: -6, trigger: 'cut', decided: D } },
    { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 840 }, gainDb: -20, duckDb: -10, fadeIn: 30, fadeOut: 60, decided: D }] },
    { op: 'addMarker', marker: { kind: 'chapter', at: 150, label: '設定' } },
    { op: 'addMask', mask: { id: 'mask_1', kind: 'pixelate', source: 'scr', reason: 'pii:email', track: [{ frame: 0, box: { x: 10, y: 10, w: 100, h: 30 }, confidence: 1 }, { frame: 900, box: { x: 10, y: 10, w: 100, h: 30 }, confidence: 1 }], decided: D } },
    { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'explain-illust-bubbles', version: '1' }, range: { start: 160, end: 220 }, anchor: { segment: 'seg_explain', offset: 10 }, slots: SAMPLE_SLOTS['explain-illust-bubbles']!, decided: D } },
  ]).timeline;
}

describe('pickHighlights', () => {
  it('starts with the hook, then the best segments in chronological order, within maxFrames', () => {
    const m = main();
    expect(validateTimeline(m).ok).toBe(true);
    // hook 60 + explain 180 + sum 90 = 330 ≤ 360; demo (270) does not fit after explain
    expect(pickHighlights(m, { maxFrames: 360 })).toEqual(['seg_hook', 'seg_explain', 'seg_sum']);
    expect(pickHighlights(m, { maxFrames: 60 })).toEqual(['seg_hook']);
    expect(pickHighlights(m, { maxFrames: 10 })).toEqual(['seg_hook']); // hook always first (trimmed by deriveVariant)
    const all = pickHighlights(m, { maxFrames: 10_000 });
    expect(all).toEqual(['seg_hook', 'seg_explain', 'seg_demo', 'seg_sum']); // cta and aside excluded by default
  });
  it('scores override the defaults and can bring in cta/aside', () => {
    const m = main();
    expect(pickHighlights(m, { maxFrames: 360, scores: { seg_demo: 2, seg_cta: 1.5 } })).toEqual(['seg_hook', 'seg_demo']);
    expect(pickHighlights(m, { maxFrames: 400, scores: { seg_demo: 2, seg_cta: 1.5 } })).toEqual(['seg_hook', 'seg_demo', 'seg_cta']);
    expect(highlightScore(m, m.segments[2]!)).toBeCloseTo(0.75, 5);
  });
  it('without a hook it is just the best segments in order', () => {
    const m = applyOp(main(), { op: 'removeSegment', id: 'seg_hook', decided: D }).timeline;
    expect(pickHighlights(m, { maxFrames: 300 })[0]).toBe('seg_explain');
  });
});

describe('deriveVariant', () => {
  const m = main();
  const v = deriveVariant(m, 'tiktok', { selection: ['seg_hook', 'seg_explain', 'seg_demo'], at: '2026-10-11T00:00:00Z' });
  it('validates as a 1080x1920 timeline with unique, suffixed ids', () => {
    const r = validateTimeline(v);
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(v.canvas).toMatchObject({ width: 1080, height: 1920, fps: { num: 30, den: 1 } });
    expect(v.segments.map((s) => [s.id, s.range.start, s.range.end])).toEqual([
      ['seg_hook_tt', 0, 60], ['seg_explain_tt', 60, 240], ['seg_demo_tt', 240, 510],
    ]);
    const ids = [...allIds(v)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) if (!id.startsWith('ch_') && !id.startsWith('mask_')) expect(id).toMatch(/_tt\d*$/); // masks keep their ids
    expect(v.meta.targets).toEqual(['tiktok']);
    expect(v.outputs.map((o) => o.target)).toEqual(['tiktok']);
    expect(v.meta.derivedFrom).toEqual({ variantOf: 'main', at: '2026-10-11T00:00:00Z', mainHash: mainHash(m), selection: [{ segment: 'seg_hook' }, { segment: 'seg_explain' }, { segment: 'seg_demo' }], rules: '' });
  });
  it('converts layouts for 9:16', () => {
    expect(v.segments[0]!.video).toEqual({ layout: 'camera-full', camera: 'cam', focus: { x: 0.5, y: 0.4 } });
    expect(v.segments[1]!.video).toEqual({ layout: 'split-v', top: 'scr', bottom: 'cam', bottomFocus: { x: 0.5, y: 0.4 } });
    expect(v.segments[2]!.video).toMatchObject({ layout: 'split-v', top: 'scr', bottom: 'cam' }); // screen-full + camera of the take
    const c = deriveVariant(m, 'tiktok', { selection: ['seg_explain', 'seg_hook'], reframe: 'center', screenFocus: { seg_explain: { x: 0.2, y: 0.7 } }, layoutMap: { 'camera-full': 'camera-full' } });
    expect(c.segments[0]!.video).toEqual({ layout: 'split-v', top: 'scr', bottom: 'cam', topFocus: { x: 0.2, y: 0.7 }, bottomFocus: { x: 0.5, y: 0.5 } });
    expect(c.segments[1]!.video).toMatchObject({ focus: { x: 0.5, y: 0.5 } });
    const keep = deriveVariant(m, 'tiktok', { selection: ['seg_explain', 'seg_demo'], layoutMap: { 'screen-with-wipe': 'screen-with-wipe', 'screen-full': 'screen-full' } });
    expect(keep.segments[0]!.video.layout).toBe('screen-with-wipe');
    expect(keep.segments[1]!.video.layout).toBe('screen-full');
  });
  it('re-times captions, overlays, sfx, bgm, markers, scenes and chapters onto the new cut', () => {
    // cap_1 95..140 in hook (main 90) → 5..50; vertical style in the safe area
    const c1 = v.captions.find((c) => c.id === 'cap_1_tt')!;
    expect(c1.range).toEqual({ start: 5, end: 50 });
    expect(c1.words.map((w) => w.start)).toEqual([5, 20, 30]);
    expect(c1.style).toBe('tiktok-bold');
    expect(c1.position.y * 1920).toBeLessThanOrEqual(VERTICAL_SAFE.bottom);
    // cap_2 spans explain/demo, which stay adjacent → two pieces
    expect(v.captions.filter((c) => c.id.startsWith('cap_2')).map((c) => [c.id, c.range.start, c.range.end, c.text])).toEqual([
      ['cap_2_tt', 230, 240, 'ここで'], ['cap_2_tt2', 240, 255, '画面'],
    ]);
    expect(v.captions.some((c) => c.id.startsWith('cap_3'))).toBe(false); // intro not selected
    const t = v.overlays.find((o) => o.id === 'ov_t_tt')!;
    expect(t).toMatchObject({ range: { start: 10, end: 50 }, position: { x: VERTICAL_SAFE.right, y: VERTICAL_SAFE.bottom } });
    const img = v.overlays.find((o) => o.id === 'ov_i_tt')!;
    expect(img).toMatchObject({ range: { start: 70, end: 110 }, position: { w: 225, h: 113 } });
    expect(v.overlays.find((o) => o.id === 'ov_r_tt')).toMatchObject({ at: 310 });
    expect(v.audio.sfx.map((s) => [s.id, s.at])).toEqual([['sfx_1_tt', 60]]);
    expect(v.audio.bgm).toEqual([expect.objectContaining({ id: 'bgm_1_tt', range: { start: 0, end: 510 } })]);
    expect(v.audio.voice.loudness).toBe(-14);
    expect(v.markers).toEqual([{ kind: 'chapter', at: 60, label: '設定' }]);
    expect(v.outline.map((c) => [c.id, c.start, c.end])).toEqual([['ch_intro', 0, 60], ['ch_main', 60, 510]]);
    // anchored scene follows its (renamed) segment
    expect(v.scenes).toEqual([expect.objectContaining({ id: 'scn_1_tt', range: { start: 70, end: 130 }, anchor: { segment: 'seg_explain_tt', offset: 10 } })]);
    expect(v.masks.map((x) => x.id)).toEqual(['mask_1']); // kept, source coordinates
  });
  it('fits maxFrames: drops later segments, trims a too-long first one', () => {
    const a = deriveVariant(m, 'youtube-shorts', { selection: ['seg_hook', 'seg_demo', 'seg_sum'], maxFrames: 160 });
    expect(a.segments.map((s) => s.id)).toEqual(['seg_hook_ys', 'seg_sum_ys']);
    const b = deriveVariant(m, 'youtube-shorts', { selection: ['seg_demo'], maxFrames: 100 });
    expect(b.segments[0]!.range).toEqual({ start: 0, end: 100 });
    expect(b.meta.derivedFrom!.selection).toEqual([{ segment: 'seg_demo', from: 330, to: 430 }]);
    expect(validateTimeline(b).ok).toBe(true);
  });
  it('hookSegment goes first; bad selections throw', () => {
    expect(deriveVariant(m, 'tiktok', { selection: ['seg_explain', 'seg_hook'], hookSegment: 'seg_hook' }).segments[0]!.id).toBe('seg_hook_tt');
    expect(deriveVariant(m, 'tiktok', { selection: ['seg_explain'], hookSegment: 'seg_sum' }).segments.map((s) => s.id)).toEqual(['seg_sum_tt', 'seg_explain_tt']);
    expect(() => deriveVariant(m, 'tiktok', { selection: [] })).toThrow(/empty/);
    expect(() => deriveVariant(m, 'tiktok', { selection: ['seg_nope'] })).toThrow(/unknown segment/);
    expect(() => deriveVariant(m, 'tiktok', { selection: ['seg_hook', 'seg_hook'] })).toThrow(/twice/);
  });
  it('a scene-layout segment points at the scene copy', () => {
    const withScene = applyOp(m, { op: 'setVideo', id: 'seg_sum', video: { layout: 'scene', scene: 'scn_1' }, decided: D }).timeline;
    const d = deriveVariant(withScene, 'tiktok', { selection: ['seg_sum'] });
    expect(d.segments[0]!.video).toEqual({ layout: 'scene', scene: 'scn_1_tt' });
    expect(d.scenes[0]).toMatchObject({ id: 'scn_1_tt', range: { start: 0, end: 90 } });
    expect(validateTimeline(d).ok).toBe(true);
  });
  it('variantStale tracks main changes that matter', () => {
    expect(variantStale(m, v)).toBe(false);
    expect(variantStale(applyOp(m, { op: 'setReview', patch: { openItems: [{ ref: 'x', kind: 'check', summary: 's' }] } }).timeline, v)).toBe(false);
    expect(variantStale(applyOp(m, { op: 'setOutput', output: { target: 'youtube', canvas: m.canvas, preset: 'youtube', metadata: { title: 't', titleCandidates: [], description: '', tags: [], chapters: true } } }).timeline, v)).toBe(false);
    expect(variantStale(applyOp(m, { op: 'trimSegment', id: 'seg_hook', from: 95, decided: D }).timeline, v)).toBe(true);
    expect(variantStale(m, m)).toBe(true); // not a variant
    expect(mainHash(JSON.parse(JSON.stringify(m)) as Timeline)).toBe(mainHash(m));
  });
});

describe('vertical variants compile', () => {
  const v = deriveVariant(main(), 'tiktok', { selection: ['seg_hook', 'seg_explain'] });
  it('final tiktok renders at 1080x1920 with focus crops and split screens', () => {
    const p = compile(v, { quality: 'final', target: 'tiktok', projectDir: '/p' });
    expect(p.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(p.warnings).toEqual([]);
    const fc = (i: number) => p.chunks[i]!.args[p.chunks[i]!.args.indexOf('-filter_complex') + 1]!;
    expect(fc(0)).toContain('crop=1080:1920:(iw-ow)*0.5:(ih-oh)*0.4');
    expect(fc(1)).toMatch(/crop=1080:960.*vstack=inputs=2/);
    expect(p.chunks[0]!.args).toEqual(expect.arrayContaining(['-b:v', '10000k']));
  });
  it('layoutAt maps masks through the focus crop', () => {
    expect(layoutAt(v, 70).some((i) => i.kind === 'mask')).toBe(false); // top-left box is outside the vertical centre crop
    const centred = applyOp(v, { op: 'addMask', mask: { id: 'mask_c', kind: 'blur', source: 'scr', reason: 'manual', track: [{ frame: 0, box: { x: 900, y: 500, w: 120, h: 80 }, confidence: 1 }, { frame: 900, box: { x: 900, y: 500, w: 120, h: 80 }, confidence: 1 }], decided: D } }).timeline;
    const items = layoutAt(centred, 70); // explain: split-v, screen on top
    const k = 960 / 1080;
    expect(items.find((i) => i.id === 'mask_c')!.rect).toEqual({ x: Math.round(540 - 1920 * k / 2 + 900 * k), y: Math.round(500 * k), w: Math.round(120 * k), h: Math.round(80 * k) });
    expect(items.filter((i) => i.kind === 'video').map((i) => i.rect)).toEqual([{ x: 0, y: 0, w: 1080, h: 960 }, { x: 0, y: 960, w: 1080, h: 960 }]);
  });
});
