import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@video/core';
import { emptyTimeline, sha256Hex, timelineJsonSchema, TimelineSchema, validateTimeline } from '@video/core';
import { D, fixture } from './fixtures.js';

function errors(t: unknown) {
  return validateTimeline(t).issues.filter((i) => i.level === 'error');
}
function warnings(t: unknown) {
  const r = validateTimeline(t);
  return r.issues.filter((i) => i.level === 'warning');
}
const mutate = (f: (t: Timeline) => void): Timeline => {
  const t = structuredClone(fixture());
  f(t);
  return t;
};

describe('schema', () => {
  it('accepts the empty timeline and the fixture', () => {
    const e = emptyTimeline({ title: 'x', kind: 'tech', template: { id: 'a', version: '1' }, canvas: { width: 1080, height: 1920, fps: { num: 30, den: 1 } }, language: 'en', targets: ['tiktok'] });
    expect(validateTimeline(e)).toMatchObject({ ok: true, issues: [] });
    expect(e.canvas.colorSpace).toBe('bt709');
    const r = validateTimeline(fixture());
    expect(r.ok).toBe(true);
  });
  it('round-trips through JSON', () => {
    const t = fixture();
    const r = validateTimeline(JSON.parse(JSON.stringify(t)));
    expect(r.ok && r.timeline).toEqual(t);
  });
  it('fills defaults (colorSpace) on parse', () => {
    const t = JSON.parse(JSON.stringify(fixture()));
    delete t.canvas.colorSpace;
    const r = validateTimeline(t);
    expect(r.ok && r.timeline.canvas.colorSpace).toBe('bt709');
  });
  it('rejects bad id prefixes, unknown keys, float frames, odd canvas, wrong schema version', () => {
    expect(errors(mutate((t) => { t.segments[0]!.id = 'cap_1'; })).some((i) => i.path === 'segments[0].id')).toBe(true);
    expect(errors(mutate((t) => { t.segments[0]!.id = 'seg_'; })).length).toBeGreaterThan(0);
    expect(errors(mutate((t) => { (t.segments[0] as unknown as Record<string, unknown>).bogus = 1; })).length).toBeGreaterThan(0);
    expect(errors(mutate((t) => { t.segments[0]!.range.end = 89.5; })).some((i) => i.path === 'segments[0].range.end')).toBe(true);
    expect(errors(mutate((t) => { t.canvas.width = 1919; })).some((i) => i.path === 'canvas.width')).toBe(true);
    expect(errors({ ...fixture(), schema: 2 }).some((i) => i.path === 'schema')).toBe(true);
    expect(errors(null).length).toBeGreaterThan(0);
    expect(errors('nope').length).toBeGreaterThan(0);
  });
  it('rejects unknown discriminants', () => {
    expect(errors(mutate((t) => { (t.segments[0]!.video as unknown as { layout: string }).layout = 'pip'; })).length).toBeGreaterThan(0);
    expect(errors(mutate((t) => { (t.sources.cam as unknown as { kind: string }).kind = 'drone'; })).length).toBeGreaterThan(0);
  });
  it('generates a JSON Schema', () => {
    const js = timelineJsonSchema() as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    expect(js.type).toBe('object');
    expect(Object.keys(js.properties ?? {})).toEqual(expect.arrayContaining(['schema', 'meta', 'segments', 'captions', 'masks']));
    expect(JSON.stringify(js)).toContain('seg_');
  });
  it('TimelineSchema parse equals validate timeline', () => {
    expect(TimelineSchema.parse(fixture())).toEqual(fixture());
  });
});

describe('semantic validation', () => {
  it('catches overlapping and gapped segment ranges', () => {
    const overlap = mutate((t) => { t.segments[1]!.range = { start: 80, end: 260 }; });
    expect(errors(overlap).some((i) => /overlaps/.test(i.message))).toBe(true);
    const gap = mutate((t) => { t.segments[1]!.range = { start: 95, end: 275 }; t.segments[2]!.range = { start: 275, end: 335 }; });
    expect(errors(gap).some((i) => /gap/.test(i.message))).toBe(true);
    const notZero = mutate((t) => { for (const s of t.segments) { s.range.start += 1; s.range.end += 1; } });
    expect(errors(notZero).some((i) => i.path === 'segments[0].range.start')).toBe(true);
  });
  it('catches a range that does not match the source length', () => {
    const t = mutate((x) => { x.segments[2]!.range.end = 340; });
    expect(errors(t).some((i) => /does not match source length/.test(i.message))).toBe(true);
  });
  it('catches empty/reversed source ranges', () => {
    expect(errors(mutate((t) => { t.segments[0]!.src.to = 0; })).some((i) => i.path === 'segments[0].src')).toBe(true);
  });
  it('catches missing and wrong-kind source refs', () => {
    expect(errors(mutate((t) => { t.segments[0]!.video = { layout: 'camera-full', camera: 'ghost' }; }))
      .some((i) => i.path === 'segments[0].video.camera' && /unknown source/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.segments[0]!.video = { layout: 'camera-full', camera: 'scr' }; }))
      .some((i) => /expected camera/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.segments[0]!.video = { layout: 'scene', scene: 'scn_nope' }; }))
      .some((i) => /unknown scene/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.segments[0]!.chapter = 'ch_nope'; })).some((i) => /unknown chapter/.test(i.message))).toBe(true);
  });
  it('warns about a take no source belongs to', () => {
    expect(warnings(mutate((t) => { t.segments[0]!.src.take = 'take_9'; })).some((i) => /take_9/.test(i.message))).toBe(true);
  });
  it('checks source bounds when the duration is known', () => {
    const t = mutate((x) => { (x.sources.cam as { durationFrames?: number }).durationFrames = 460; });
    expect(errors(t)).toEqual([]);
    const t2 = mutate((x) => { (x.sources.cam as { durationFrames?: number }).durationFrames = 459; });
    expect(errors(t2).some((i) => i.path === 'segments[2].src' && /cam/.test(i.message))).toBe(true);
    const t3 = mutate((x) => { const c = x.sources.cam as { offset: number }; c.offset = -10; });
    expect(warnings(t3).some((i) => i.path === 'segments[0].src' && /before "cam" begins/.test(i.message))).toBe(true);
    expect(errors(t3)).toEqual([]);
  });
  it('catches captions and overlays outside the timeline', () => {
    const cap = {
      id: 'cap_1', range: { start: 300, end: 400 }, text: 'x', spoken: 'x', words: [], lines: ['x'], emphasis: [],
      style: 's', position: { anchor: 'bottom' as const, y: 0.9 }, decided: D,
    };
    expect(errors(mutate((t) => { t.captions = [cap]; })).some((i) => /after the timeline end 330/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.captions = [{ ...cap, range: { start: 10, end: 10 } }]; })).length).toBeGreaterThan(0);
    expect(errors(mutate((t) => { t.overlays = [{ kind: 'image', id: 'ov_1', range: { start: 0, end: 10 }, asset: 'nope', position: { x: 0, y: 0, w: 10, h: 10 }, decided: D }]; }))
      .some((i) => i.path === 'overlays[0].asset')).toBe(true);
    expect(errors(mutate((t) => { t.overlays = [{ kind: 'logo', id: 'ov_1', range: { start: 0, end: 10 }, asset: 'cam', corner: 'tr' }]; }))
      .some((i) => /expected asset/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.overlays = [{ kind: 'click-ring', id: 'ov_1', at: 330, position: { x: 0, y: 0 } }]; })).length).toBe(1);
  });
  it('warns on overlapping captions and words outside their caption', () => {
    const base = { text: 'x', spoken: 'x', lines: ['x'], emphasis: [], style: 's', position: { anchor: 'bottom' as const, y: 0.9 }, decided: D };
    const w = warnings(mutate((t) => {
      t.captions = [
        { ...base, id: 'cap_1', range: { start: 0, end: 50 }, words: [{ text: 'x', start: 40, end: 60 }] },
        { ...base, id: 'cap_2', range: { start: 40, end: 80 }, words: [] },
      ];
    }));
    expect(w.some((i) => /overlaps caption "cap_1"/.test(i.message))).toBe(true);
    expect(w.some((i) => /outside the caption range/.test(i.message))).toBe(true);
  });
  it('catches duplicate ids across element kinds', () => {
    const t = mutate((x) => { x.outline[0]!.id = 'ch_1'; x.outline.push({ ...x.outline[0]! }); });
    expect(errors(t).some((i) => /duplicate id "ch_1"/.test(i.message))).toBe(true);
    const t2 = mutate((x) => { x.segments[1]!.id = 'seg_a'; });
    expect(errors(t2).some((i) => /duplicate id "seg_a"/.test(i.message))).toBe(true);
  });
  it('checks masks: source ref, kind, increasing frames, box bounds', () => {
    const m = { id: 'mask_1', kind: 'blur' as const, source: 'scr', reason: 'manual' as const, decided: D, track: [{ frame: 0, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1 }] };
    expect(errors(mutate((t) => { t.masks = [m]; }))).toEqual([]);
    expect(errors(mutate((t) => { t.masks = [{ ...m, source: 'nope' }]; })).some((i) => i.path === 'masks[0].source')).toBe(true);
    expect(errors(mutate((t) => { t.masks = [{ ...m, source: 'mic' }]; })).some((i) => /expected screen or camera/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.masks = [{ ...m, track: [m.track[0]!, m.track[0]!] }]; })).some((i) => /strictly increasing/.test(i.message))).toBe(true);
    expect(warnings(mutate((t) => { t.masks = [{ ...m, track: [{ frame: 0, box: { x: 1915, y: 0, w: 10, h: 10 }, confidence: 1 }] }]; }))
      .some((i) => /outside the source frame/.test(i.message))).toBe(true);
    expect(errors(mutate((t) => { t.masks = [{ ...m, track: [] }]; })).length).toBeGreaterThan(0);
  });
  it('checks audio refs and ranges', () => {
    expect(errors(mutate((t) => { t.audio.sfx = [{ id: 'sfx_1', asset: 'pop', at: 400, gainDb: 0, trigger: 'cut', decided: D }]; }))
      .some((i) => i.path === 'audio.sfx[0].at')).toBe(true);
    expect(errors(mutate((t) => { t.audio.bgm = [{ id: 'bgm_1', asset: 'nope', range: { start: 0, end: 10 }, gainDb: 0, duckDb: -6, fadeIn: 0, fadeOut: 0, decided: D }]; }))
      .some((i) => i.path === 'audio.bgm[0].asset')).toBe(true);
    expect(errors(mutate((t) => { t.audio.bgm = [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 10 }, gainDb: 0, duckDb: 6, fadeIn: 0, fadeOut: 0, decided: D }]; })).length).toBeGreaterThan(0);
  });
  it('checks markers, outputs and license limits', () => {
    expect(errors(mutate((t) => { t.markers = [{ kind: 'chapter', at: 1000, label: 'x' }]; })).length).toBe(1);
    const out = { target: 'youtube' as const, canvas: fixture().canvas, preset: 'youtube', metadata: { title: '', titleCandidates: [], description: '', tags: [], chapters: false } };
    expect(errors(mutate((t) => { t.outputs = [out, out]; })).some((i) => /duplicate output/.test(i.message))).toBe(true);
    const limited = mutate((t) => {
      for (let i = 0; i < 21; i++) {
        t.sources[`ill${i}`] = { kind: 'asset', path: `a/${i}.png`, assetId: `i${i}`, license: { id: 'irasutoya', limitKey: 'irasutoya' } };
        t.overlays.push({ kind: 'image', id: `ov_${i}`, range: { start: 0, end: 10 }, asset: `ill${i}`, position: { x: 0, y: 0, w: 10, h: 10 }, decided: D });
      }
    });
    expect(errors(limited).some((i) => /allows 20/.test(i.message))).toBe(true);
    expect(warnings(mutate((t) => {
      t.sources.cc = { kind: 'asset', path: 'a.mp3', assetId: 'x', license: { id: 'CC-BY-4.0' } };
      t.audio.sfx = [{ id: 'sfx_1', asset: 'cc', at: 0, gainDb: 0, trigger: 'cut', decided: D }];
    })).some((i) => /credit/.test(i.message))).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto for assorted inputs', () => {
    const inputs = ['', 'abc', 'あいうえお', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)];
    for (const s of inputs) expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    const bytes = new Uint8Array(300).map((_, i) => i & 255);
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
