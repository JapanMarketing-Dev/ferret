import { describe, expect, it } from 'vitest';
import type { Caption, Op, Timeline } from '@video/core';
import { applyOp, applyOps, OpError, validateTimeline } from '@video/core';
import { D, fixture, rng, seg } from './fixtures.js';

const ranges = (t: Timeline) => t.segments.map((s) => [s.id, s.range.start, s.range.end]);

function cap(id: string, start: number, end: number): Caption {
  return {
    id, range: { start, end }, text: 'こんにちは', spoken: 'こんにちは', words: [], lines: ['こんにちは'], emphasis: [],
    style: 'tiktok-bold', position: { anchor: 'bottom', y: 0.85 }, decided: D,
  };
}

function expectUndo(t: Timeline, op: Op) {
  const before = structuredClone(t);
  const r = applyOp(t, op);
  expect(t).toEqual(before); // immutable
  const back = applyOps(r.timeline, r.inverse).timeline;
  expect(back).toEqual(before);
  return r.timeline;
}

describe('segment packing', () => {
  it('packs segments contiguously from source lengths', () => {
    const t = fixture();
    expect(ranges(t)).toEqual([['seg_a', 0, 90], ['seg_b', 90, 270], ['seg_c', 270, 330]]);
    expect(validateTimeline(t).ok).toBe(true);
  });
  it('converts source fps to timeline fps', () => {
    const t = fixture({ srcFps: { num: 60, den: 1 } }); // take frames at 60 fps → half as many timeline frames
    expect(ranges(t)).toEqual([['seg_a', 0, 45], ['seg_b', 45, 135], ['seg_c', 135, 165]]);
    const t2 = fixture({ fps: { num: 24, den: 1 } });
    expect(ranges(t2)).toEqual([['seg_a', 0, 72], ['seg_b', 72, 216], ['seg_c', 216, 264]]);
  });
  it('never gives a non-empty segment zero length', () => {
    const t = fixture({ srcFps: { num: 120, den: 1 } });
    const r = applyOp(t, { op: 'trimSegment', id: 'seg_a', from: 0, to: 1, decided: D });
    expect(r.timeline.segments[0]!.range).toEqual({ start: 0, end: 1 });
  });
});

describe('ops', () => {
  it('addSegment at an index and its inverse', () => {
    const t = expectUndo(fixture(), { op: 'addSegment', segment: seg('seg_x', 500, 530), index: 1 });
    expect(t.segments.map((s) => s.id)).toEqual(['seg_a', 'seg_x', 'seg_b', 'seg_c']);
    expect(ranges(t)[1]).toEqual(['seg_x', 90, 120]);
  });
  it('addSegment rejects duplicates and empty ranges', () => {
    expect(() => applyOp(fixture(), { op: 'addSegment', segment: seg('seg_a', 0, 10) })).toThrow(OpError);
    expect(() => applyOp(fixture(), { op: 'addSegment', segment: seg('seg_y', 10, 10) })).toThrow(/invalid source range/);
    expect(() => applyOp(fixture(), { op: 'addSegment', segment: seg('seg_y', 20, 10) })).toThrow(OpError);
  });
  it('addSegment clamps an out-of-range index', () => {
    const r = applyOp(fixture(), { op: 'addSegment', segment: seg('seg_x', 0, 10), index: 99 });
    expect(r.timeline.segments.at(-1)!.id).toBe('seg_x');
    const r2 = applyOp(fixture(), { op: 'addSegment', segment: seg('seg_x', 0, 10), index: -5 });
    expect(r2.timeline.segments[0]!.id).toBe('seg_x');
  });
  it('removeSegment re-packs and restores', () => {
    const t = expectUndo(fixture(), { op: 'removeSegment', id: 'seg_b', decided: D });
    expect(ranges(t)).toEqual([['seg_a', 0, 90], ['seg_c', 90, 150]]);
    expect(() => applyOp(fixture(), { op: 'removeSegment', id: 'seg_nope', decided: D })).toThrow(/not found/);
  });
  it('trimSegment changes one side only and records the decision', () => {
    const t = expectUndo(fixture(), { op: 'trimSegment', id: 'seg_a', from: 30, decided: { by: 'human', reason: 'late start' } });
    expect(t.segments[0]!.src).toMatchObject({ from: 30, to: 90 });
    expect(t.segments[0]!.decided.by).toBe('human');
    expect(ranges(t)[1]).toEqual(['seg_b', 60, 240]);
    expect(() => applyOp(fixture(), { op: 'trimSegment', id: 'seg_a', from: 90, decided: D })).toThrow(OpError);
    expect(() => applyOp(fixture(), { op: 'trimSegment', id: 'seg_a', to: -1, decided: D })).toThrow(OpError);
  });
  it('splitSegment requires a point strictly inside', () => {
    const t = expectUndo(fixture(), { op: 'splitSegment', id: 'seg_b', atSource: 200, newId: 'seg_b2' });
    expect(t.segments.map((s) => [s.id, s.src.from, s.src.to])).toEqual([
      ['seg_a', 0, 90], ['seg_b', 120, 200], ['seg_b2', 200, 300], ['seg_c', 400, 460],
    ]);
    for (const at of [120, 300, 50, 999]) {
      expect(() => applyOp(fixture(), { op: 'splitSegment', id: 'seg_b', atSource: at, newId: 'seg_z' })).toThrow(OpError);
    }
    expect(() => applyOp(fixture(), { op: 'splitSegment', id: 'seg_b', atSource: 200, newId: 'seg_c' })).toThrow(/already used/);
  });
  it('splitSegment carries zoom keyframes to the second part', () => {
    const base = applyOp(fixture(), {
      op: 'setSegments',
      segments: fixture().segments.map((s) => s.id === 'seg_b'
        ? { ...s, zoom: [{ at: 0, value: { scale: 1, focus: 'face' as const } }, { at: 100, value: { scale: 1.5, focus: 'face' as const } }] }
        : s),
    }).timeline;
    const t = applyOp(base, { op: 'splitSegment', id: 'seg_b', atSource: 180, newId: 'seg_b2' }).timeline;
    const b2 = t.segments.find((s) => s.id === 'seg_b2')!;
    expect(b2.zoom).toEqual([{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 40, value: { scale: 1.5, focus: 'face' } }]);
  });
  it('moveSegment and inverse', () => {
    const t = expectUndo(fixture(), { op: 'moveSegment', id: 'seg_c', index: 0 });
    expect(ranges(t)).toEqual([['seg_c', 0, 60], ['seg_a', 60, 150], ['seg_b', 150, 330]]);
  });
  it('setVideo / setCamera', () => {
    let t = expectUndo(fixture(), { op: 'setVideo', id: 'seg_a', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'default' } }, decided: D });
    t = expectUndo(t, { op: 'setCamera', id: 'seg_a', camera: 'cam2', decided: D });
    expect(t.segments[0]!.video).toMatchObject({ layout: 'screen-with-wipe', camera: 'cam2' });
    expect(() => applyOp(fixture(), { op: 'setCamera', id: 'seg_b', camera: 'cam', decided: D })).toThrow(/without a camera/);
  });
  it('cutText removes, trims and splits across segments', () => {
    const t0 = fixture();
    // remove 60..150: trims seg_a's tail and seg_b's head
    const t1 = expectUndo(t0, { op: 'cutText', from: 60, to: 150, take: 'take_1', decided: D, kind: 'filler' });
    expect(t1.segments.map((s) => [s.id, s.src.from, s.src.to])).toEqual([['seg_a', 0, 60], ['seg_b', 150, 300], ['seg_c', 400, 460]]);
    expect(t1.segments[0]!.removedNeighbors).toEqual([{ kind: 'filler', src: { from: 60, to: 150 }, decided: D }]);
    // strictly inside: split
    const t2 = expectUndo(t0, { op: 'cutText', from: 200, to: 210, take: 'take_1', decided: D });
    expect(t2.segments.map((s) => [s.id, s.src.from, s.src.to])).toEqual([
      ['seg_a', 0, 90], ['seg_b', 120, 200], ['seg_b_2', 210, 300], ['seg_c', 400, 460],
    ]);
    // fully covering: removed
    const t3 = expectUndo(t0, { op: 'cutText', from: 390, to: 999, take: 'take_1', decided: D });
    expect(t3.segments.map((s) => s.id)).toEqual(['seg_a', 'seg_b']);
    // another take: no-op with no inverse
    const r = applyOp(t0, { op: 'cutText', from: 0, to: 999, take: 'take_2', decided: D });
    expect(r.timeline).toBe(t0);
    expect(r.inverse).toEqual([]);
    expect(validateTimeline(t1).ok && validateTimeline(t2).ok && validateTimeline(t3).ok).toBe(true);
  });
  it('captions: set and update with undefined-key removal', () => {
    let t = expectUndo(fixture(), { op: 'setCaptions', captions: [cap('cap_1', 0, 30), cap('cap_2', 30, 60)] });
    t = expectUndo(t, { op: 'updateCaption', id: 'cap_1', patch: { text: '変更', corrections: [{ from: 'a', to: 'b', decided: D }] } });
    expect(t.captions[0]!.text).toBe('変更');
    t = expectUndo(t, { op: 'updateCaption', id: 'cap_1', patch: { corrections: undefined } });
    expect('corrections' in t.captions[0]!).toBe(false);
    expect(() => applyOp(t, { op: 'updateCaption', id: 'cap_1', patch: { id: 'cap_9' } })).toThrow(/caption id/);
    expect(() => applyOp(t, { op: 'updateCaption', id: 'cap_9', patch: {} })).toThrow(/not found/);
  });
  it('overlays, scenes, sfx, bgm, masks, markers, outputs, meta, review, voice, sources', () => {
    let t = fixture();
    t = expectUndo(t, { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_1', range: { start: 0, end: 30 }, text: 'A', style: 's', position: { x: 1, y: 2 }, decided: D } });
    expect(() => applyOp(t, { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_1', at: 3, position: { x: 1, y: 1 } } })).toThrow(/duplicate/);
    t = expectUndo(t, { op: 'removeOverlay', id: 'ov_1' });
    t = expectUndo(t, { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 0, end: 30 }, slots: { title: { kind: 'text', text: 'x' } }, decided: D } });
    t = expectUndo(t, { op: 'removeScene', id: 'scn_1' });
    t = expectUndo(t, { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 10, gainDb: -6, trigger: 'cut', decided: D } });
    t = expectUndo(t, { op: 'removeSfx', id: 'sfx_1' });
    t = expectUndo(t, { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 300 }, gainDb: -18, duckDb: -10, fadeIn: 15, fadeOut: 30, decided: D }] });
    t = expectUndo(t, { op: 'addMask', mask: { id: 'mask_1', kind: 'pixelate', source: 'scr', reason: 'pii:email', track: [{ frame: 0, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1 }], decided: D } });
    t = expectUndo(t, { op: 'removeMask', id: 'mask_1' });
    t = expectUndo(t, { op: 'addMarker', marker: { kind: 'note', at: 5, text: 'memo', by: 'human' } });
    t = expectUndo(t, { op: 'setOutput', output: { target: 'youtube', canvas: t.canvas, preset: 'youtube', metadata: { title: 't', titleCandidates: [], description: '', tags: [], chapters: true } } });
    t = expectUndo(t, { op: 'setOutput', output: { ...t.outputs[0]!, preset: 'youtube-4k' } });
    t = expectUndo(t, { op: 'removeOutput', target: 'youtube' });
    expect(() => applyOp(t, { op: 'removeOutput', target: 'tiktok' })).toThrow(OpError);
    t = expectUndo(t, { op: 'setMeta', patch: { goal: '登録につなげる', audience: 'エンジニア' } });
    t = expectUndo(t, { op: 'setReview', patch: { openItems: [{ ref: 'seg_a', kind: 'decision', summary: '?' }] } });
    t = expectUndo(t, { op: 'setVoice', patch: { loudness: -16 } });
    t = expectUndo(t, { op: 'setOutline', outline: [] });
    t = expectUndo(t, { op: 'addSource', id: 'cam2', source: { kind: 'camera', path: 'x.mp4', role: 'side', fps: { num: 30, den: 1 }, size: { width: 1280, height: 720 }, offset: -3 } });
    t = expectUndo(t, { op: 'addSource', id: 'cam', source: { ...(t.sources.cam as Extract<Timeline['sources'][string], { kind: 'camera' }>), offset: 5 } });
    expectUndo(t, { op: 'removeSource', id: 'cam2' });
    expect(() => applyOp(t, { op: 'removeSource', id: 'nope' })).toThrow(OpError);
  });
  it('does not alias op payloads into the timeline', () => {
    const s = seg('seg_x', 0, 10);
    const t = applyOp(fixture(), { op: 'addSegment', segment: s }).timeline;
    s.text = 'mutated';
    expect(t.segments.at(-1)!.text).toBe('');
  });
  it('applyOps is all-or-nothing and inverts in reverse order', () => {
    const t = fixture();
    expect(() => applyOps(t, [
      { op: 'removeSegment', id: 'seg_a', decided: D },
      { op: 'removeSegment', id: 'seg_a', decided: D },
    ])).toThrow(OpError);
    expect(t.segments.length).toBe(3);
    const r = applyOps(t, [
      { op: 'moveSegment', id: 'seg_a', index: 2 },
      { op: 'trimSegment', id: 'seg_a', to: 45, decided: D },
      { op: 'removeSegment', id: 'seg_b', decided: D },
    ]);
    expect(applyOps(r.timeline, r.inverse).timeline).toEqual(t);
  });
  it('rejects non-op input', () => {
    expect(() => applyOp(fixture(), null as unknown as Op)).toThrow(OpError);
    expect(() => applyOp(fixture(), { op: 'explode' } as unknown as Op)).toThrow(OpError);
  });
});

describe('property: random op sequences are undone by their inverses', () => {
  const genOp = (t: Timeline, r: () => number, n: number): Op => {
    const ids = t.segments.map((s) => s.id);
    const pick = () => ids[Math.floor(r() * ids.length)]!;
    const k = Math.floor(r() * 7);
    if (ids.length === 0 || k === 0) {
      const from = Math.floor(r() * 500);
      return { op: 'addSegment', segment: seg(`seg_r${n}`, from, from + 1 + Math.floor(r() * 100)), index: Math.floor(r() * (ids.length + 1)) };
    }
    const id = pick();
    const s = t.segments.find((x) => x.id === id)!;
    switch (k) {
      case 1: return { op: 'removeSegment', id, decided: D };
      case 2: return { op: 'moveSegment', id, index: Math.floor(r() * ids.length) };
      case 3: {
        const from = s.src.from + Math.floor(r() * Math.max(1, s.src.to - s.src.from - 1));
        return { op: 'trimSegment', id, from, decided: D };
      }
      case 4:
        if (s.src.to - s.src.from >= 2) {
          return { op: 'splitSegment', id, atSource: s.src.from + 1 + Math.floor(r() * (s.src.to - s.src.from - 1)), newId: `seg_s${n}` };
        }
        return { op: 'moveSegment', id, index: 0 };
      case 5: {
        const from = Math.floor(r() * 500);
        return { op: 'cutText', from, to: from + 1 + Math.floor(r() * 80), take: 'take_1', decided: D };
      }
      default:
        return { op: 'setVideo', id, video: { layout: 'split-v', top: 'scr', bottom: 'cam' }, decided: D };
    }
  };

  it('200 random sequences of 1..12 ops', () => {
    for (let trial = 0; trial < 200; trial++) {
      const r = rng(trial + 1);
      const start = fixture();
      let t = start;
      const inverses: Op[][] = [];
      const states: Timeline[] = [t];
      const len = 1 + Math.floor(r() * 12);
      for (let i = 0; i < len; i++) {
        const op = genOp(t, r, trial * 100 + i);
        const res = applyOp(t, op);
        inverses.push(res.inverse);
        t = res.timeline;
        states.push(t);
        const v = validateTimeline(t);
        expect(v.ok, JSON.stringify(v.ok ? [] : v.issues)).toBe(true);
      }
      // undo step by step and compare with each earlier state
      for (let i = inverses.length - 1; i >= 0; i--) {
        t = applyOps(t, inverses[i]!).timeline;
        expect(t).toEqual(states[i]);
      }
      expect(t).toEqual(start);
    }
  });
});

describe('setDecided / setTranscript / updateSource', () => {
  const human = { by: 'human' as const, reason: 'accepted in review', needsReview: false };
  it('setDecided replaces the decision on any element kind and inverts', () => {
    let t = applyOps(fixture(), [
      { op: 'setCaptions', captions: [cap('cap_1', 0, 30)] },
      { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_1', range: { start: 0, end: 30 }, text: 'A', style: 's', position: { x: 1, y: 2 }, decided: D } },
      { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 10, gainDb: -6, trigger: 'cut', decided: D } },
      { op: 'addMask', mask: { id: 'mask_1', kind: 'blur', source: 'scr', reason: 'manual', track: [{ frame: 0, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1 }], decided: D } },
      { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 30 }, gainDb: 0, duckDb: -6, fadeIn: 0, fadeOut: 0, decided: D }] },
      { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'title-card', version: '1' }, range: { start: 0, end: 30 }, slots: {}, decided: D } },
    ]).timeline;
    for (const id of ['seg_b', 'cap_1', 'ov_1', 'sfx_1', 'mask_1', 'bgm_1', 'scn_1']) {
      t = expectUndo(t, { op: 'setDecided', target: id, decided: human });
    }
    expect(t.segments[1]!.decided).toEqual(human);
    expect(t.audio.bgm[0]!.decided).toEqual(human);
    expect(() => applyOp(t, { op: 'setDecided', target: 'seg_zz', decided: human })).toThrow(OpError);
    const ring = applyOp(t, { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_r', at: 1, position: { x: 0, y: 0 } } }).timeline;
    expect(() => applyOp(ring, { op: 'setDecided', target: 'ov_r', decided: human })).toThrow(/no element with a decision/);
  });
  it('setTranscript sets and clears', () => {
    const tr = { path: 'derived/transcripts/main.json', engine: 'whisper.cpp', model: 'large-v3-turbo', summary: '' };
    const t = expectUndo(fixture(), { op: 'setTranscript', transcript: tr });
    expect(t.transcript).toEqual(tr);
    const cleared = expectUndo(t, { op: 'setTranscript', transcript: null });
    expect('transcript' in cleared).toBe(false);
    // the CLI may send no transcript at all (undefined) to clear
    const cleared2 = expectUndo(t, { op: 'setTranscript' });
    expect(cleared2.transcript).toBeUndefined();
  });
  it('updateSource patches sync results and re-packs when the take clock changes', () => {
    let t = expectUndo(fixture(), { op: 'updateSource', id: 'cam', patch: { offset: -12, drift: 1.00002, sync: { method: 'xcorr', confidence: 0.97 } } });
    expect(t.sources.cam).toMatchObject({ offset: -12, drift: 1.00002 });
    t = expectUndo(t, { op: 'updateSource', id: 'scr', patch: { fps: { num: 60, den: 1 } } });
    expect(t.segments[0]!.range).toEqual({ start: 0, end: 45 });
    expect(() => applyOp(t, { op: 'updateSource', id: 'cam', patch: { kind: 'screen' } })).toThrow(/kind/);
    expect(() => applyOp(t, { op: 'updateSource', id: 'nope', patch: {} })).toThrow(OpError);
  });
});
