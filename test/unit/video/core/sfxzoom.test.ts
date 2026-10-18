import { describe, expect, it } from 'vitest';
import { applyOps, sfxEvents, sfxFromRules, validateTimeline, type SfxLibraryItem, type Timeline } from '@video/core';
import { fixture } from './fixtures.js';

const lib: SfxLibraryItem[] = [{ id: 'sfx_swoosh-in_builtin_1', kind: 'swoosh-in', durationMs: 500, path: 'assets/library/sw.wav', license: { id: 'CC0-1.0' } }];

function zoomed(zoom: Timeline['segments'][number]['zoom'], extra: Partial<Timeline['segments'][number]> = {}): Timeline {
  const t = fixture();
  return { ...t, segments: t.segments.map((s) => (s.id === 'seg_a' ? { ...s, zoom, ...extra } : s)) };
}

describe('zoom-in sfx events', () => {
  it('a keyframe that scales up is a zoom-in; holding or zooming out is not', () => {
    const t = zoomed([{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 30, value: { scale: 1.4, focus: 'face' } }, { at: 60, value: { scale: 1.4, focus: 'face' } }, { at: 80, value: { scale: 1, focus: 'face' } }]);
    expect(sfxEvents(t).filter((e) => e.on === 'zoom-in').map((e) => e.at)).toEqual([30]);
  });
  it('a segment that starts zoomed in counts at its start; tiny changes (≤ 0.05) do not; a jump-zoom without keys does', () => {
    expect(sfxEvents(zoomed([{ at: 0, value: { scale: 1.3, focus: 'face' } }])).filter((e) => e.on === 'zoom-in').map((e) => e.at)).toEqual([0]);
    expect(sfxEvents(zoomed([{ at: 0, value: { scale: 1.04, focus: 'face' } }])).filter((e) => e.on === 'zoom-in')).toEqual([]);
    expect(sfxEvents(zoomed(undefined, { transitionIn: { kind: 'jump-zoom', frames: 6 } })).filter((e) => e.on === 'zoom-in')).toHaveLength(1);
  });
  it('a zoom-in rule places a swoosh-in with the zoom-in trigger; the result validates', () => {
    const t = zoomed([{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 30, value: { scale: 1.5, focus: 'face' } }]);
    const ops = sfxFromRules(t, { rules: [{ on: 'zoom-in', kind: 'swoosh-in' }] }, lib, { words: [] });
    const sfx = ops.filter((o) => o.op === 'addSfx');
    expect(sfx).toHaveLength(1);
    expect(sfx[0]).toMatchObject({ sfx: { at: 30, trigger: 'zoom-in' } });
    const v = validateTimeline(applyOps(t, ops).timeline);
    expect(v.ok, JSON.stringify(v.issues)).toBe(true);
  });
});
