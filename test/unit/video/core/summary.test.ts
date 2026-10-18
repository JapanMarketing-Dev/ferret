import { describe, expect, it } from 'vitest';
import {
  applyOps, durationFrames, query, summarize, takeFps, takeFrameToTimeline, timelineFrameToTake,
} from '@video/core';
import { D, fixture } from './fixtures.js';

describe('summarize', () => {
  it('reports structure, counts, roles and review flags', () => {
    const t = applyOps(fixture(), [
      { op: 'setVideo', id: 'seg_b', video: { layout: 'screen-full', screen: 'scr' }, decided: { ...D, needsReview: true, reason: '画面の切り替えが早い' } },
      { op: 'setReview', patch: { openItems: [{ ref: 'seg_b', kind: 'decision', summary: '確認' }] } },
    ]).timeline;
    const s = summarize(t);
    expect(s.durationFrames).toBe(330);
    expect(s.duration).toBe('00:00:11:00');
    expect(s.canvas).toBe('1920x1080@30');
    expect(s.counts.segments).toBe(3);
    expect(s.chapters[0]).toMatchObject({ id: 'ch_1', segments: 3 });
    expect(s.roles.explain).toEqual({ segments: 3, frames: 330 });
    expect(s.needsReview).toEqual([{ ref: 'seg_b', reason: '画面の切り替えが早い' }]);
    expect(s.openItems.length).toBe(1);
    expect(s.template).toBe('talk-youtube@1');
  });
  it('labels NTSC rates', () => {
    expect(summarize(fixture({ fps: { num: 30000, den: 1001 } })).canvas).toBe('1920x1080@29.970');
  });
});

describe('query', () => {
  const t = applyOps(fixture(), [
    { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_1', range: { start: 100, end: 150 }, text: 'A', style: 's', position: { x: 0, y: 0 }, decided: D } },
    { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 95, gainDb: 0, trigger: 'cut', decided: D } },
    { op: 'addMarker', marker: { kind: 'chapter', at: 90, label: 'x' } },
  ]).timeline;
  it('filters by kind (aliases accepted)', () => {
    expect(query(t, { kind: 'segments' }).map((e) => e.id)).toEqual(['seg_a', 'seg_b', 'seg_c']);
    expect(query(t, { kind: 'overlay' }).map((e) => e.id)).toEqual(['ov_1']);
    expect(() => query(t, { kind: 'banana' })).toThrow(/unknown kind/);
  });
  it('filters by half-open range overlap', () => {
    const ids = query(t, { range: [90, 100] }).map((e) => `${e.kind}:${e.id ?? ''}`);
    expect(ids).toEqual(expect.arrayContaining(['segment:seg_b', 'sfx:sfx_1', 'marker:', 'chapter:ch_1']));
    expect(ids).not.toContain('segment:seg_a');
    expect(ids).not.toContain('overlay:ov_1');
    // point query
    expect(query(t, { range: [89, 89], kind: 'segment' }).map((e) => e.id)).toEqual(['seg_a']);
    expect(query(t, { range: [10_000, 20_000] }).filter((e) => e.kind !== 'source')).toEqual([]);
  });
  it('filters by id and role', () => {
    expect(query(t, { id: 'seg_c' })).toHaveLength(1);
    expect(query(t, { role: 'explain' })).toHaveLength(3);
    expect(query(t, { role: 'cta' })).toHaveLength(0);
  });
});

describe('time mapping', () => {
  it('maps take frames to timeline frames and back', () => {
    const t = fixture();
    expect(takeFps(t, 'take_1')).toEqual({ num: 30, den: 1 });
    expect(takeFps(t, 'take_x')).toEqual(t.canvas.fps);
    expect(takeFrameToTimeline(t, 'take_1', 0)).toBe(0);
    expect(takeFrameToTimeline(t, 'take_1', 120)).toBe(90);
    expect(takeFrameToTimeline(t, 'take_1', 100)).toBeNull(); // cut
    expect(takeFrameToTimeline(t, 'take_1', 459)).toBe(329);
    expect(takeFrameToTimeline(t, 'take_1', 460)).toBeNull();
    expect(timelineFrameToTake(t, 90)).toMatchObject({ take: 'take_1', frame: 120 });
    expect(timelineFrameToTake(t, durationFrames(t))).toBeNull();
    for (let f = 0; f < durationFrames(t); f++) {
      const m = timelineFrameToTake(t, f)!;
      expect(takeFrameToTimeline(t, m.take, m.frame)).toBe(f);
    }
  });
});
