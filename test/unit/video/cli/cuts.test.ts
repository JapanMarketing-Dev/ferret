import { describe, expect, it } from 'vitest';
import { cutCandidates, mergeRemovals, planKeeps, textIn, type CandidateInput, type Removal } from '@video/cli/cuts.js';
import { parseFlags, parseQuery } from '@video/cli/commands/edit.js';

const rules: CandidateInput['rules'] = { silence: { minMs: 400, padMs: 100 }, retakes: 'keep-last', ngMarkers: 'cut', minKeepMs: 300 };
const base = (o: Partial<CandidateInput> = {}): CandidateInput => ({ durationSec: 20, silences: [], fillers: [], retakes: [], ngMarkers: [], rules, lang: 'ja', ...o });
const rm = (start: number, end: number, kind: Removal['kind'] = 'silence'): Removal => ({ start, end, kind, by: 'rule', reason: kind });

describe('cutCandidates', () => {
  it('pads inner silences, removes leading/trailing silence entirely, ignores short ones', () => {
    const c = cutCandidates(base({ silences: [{ start: 0, end: 1.5 }, { start: 5, end: 6 }, { start: 8, end: 8.3 }, { start: 19, end: 20 }] }));
    expect(c.map((x) => [x.start, x.end])).toEqual([[0, 1.4], [5.1, 5.9], [19.1, 20]]);
    expect(c[0]!.reason).toBe('1.5 秒の無音');
  });

  it('a silence exactly at the minimum counts; padding larger than the silence drops it', () => {
    expect(cutCandidates(base({ silences: [{ start: 5, end: 5.4 }] }))).toHaveLength(1);
    const wide = cutCandidates(base({ silences: [{ start: 5, end: 5.4 }], rules: { ...rules, silence: { minMs: 400, padMs: 300 } } }));
    expect(wide).toHaveLength(0);
  });

  it('clips fillers to the take and drops empty ones', () => {
    const c = cutCandidates(base({ fillers: [{ start: -1, end: 0.5, text: 'えー' }, { start: 3, end: 3, text: 'x' }, { start: 19.5, end: 25, text: 'あの' }] }));
    expect(c.map((x) => [x.start, x.end, x.kind])).toEqual([[0, 0.5, 'filler'], [19.5, 20, 'filler']]);
    expect(c[0]!.text).toBe('えー');
  });

  it('retakes follow the template policy', () => {
    const retakes = [{ first: [2, 4] as [number, number], second: [4.5, 6.5] as [number, number], score: 0.9 }];
    expect(cutCandidates(base({ retakes }))[0]).toMatchObject({ start: 2, end: 4, kind: 'retake', confidence: 0.9 });
    expect(cutCandidates(base({ retakes, rules: { ...rules, retakes: 'keep-first' } }))[0]).toMatchObject({ start: 4.5, end: 6.5 });
    expect(cutCandidates(base({ retakes, rules: { ...rules, retakes: 'ask' } }))[0]!.needsReview).toBe(true);
    expect(cutCandidates(base({ retakes, rules: { ...rules, retakes: 'off' } }))).toEqual([]);
    expect(cutCandidates(base({ retakes: [{ ...retakes[0]!, score: 3 }] }))[0]!.confidence).toBe(1);
  });

  it('NG markers cut from the last pause before the marker; ignored when off or out of range', () => {
    const silences = [{ start: 2, end: 3 }, { start: 9, end: 10 }];
    const ng = cutCandidates(base({ silences, ngMarkers: [7, 25, -1] })).filter((x) => x.kind === 'ng-marker');
    expect(ng.map((x) => [x.start, x.end])).toEqual([[2.9, 7]]);
    expect(cutCandidates(base({ ngMarkers: [1] })).find((x) => x.kind === 'ng-marker')).toMatchObject({ start: 0, end: 1 });
    expect(cutCandidates(base({ silences, ngMarkers: [7], rules: { ...rules, ngMarkers: 'off' } })).some((x) => x.kind === 'ng-marker')).toBe(false);
  });

  it('English reasons', () => {
    expect(cutCandidates(base({ lang: 'en', silences: [{ start: 5, end: 6 }] }))[0]!.reason).toBe('1s of silence');
  });
});

describe('mergeRemovals', () => {
  it('unions overlaps, keeps the strongest kind and all reasons', () => {
    const m = mergeRemovals([rm(1, 2), rm(1.5, 3, 'filler'), rm(5, 6), rm(2.9, 3.5, 'ng-marker')]);
    expect(m.map((x) => [x.start, x.end, x.kind])).toEqual([[1, 3.5, 'ng-marker'], [5, 6, 'silence']]);
    expect(m[0]!.reason).toBe('silence / filler / ng-marker');
  });

  it('touching ranges merge; a gap does not', () => {
    expect(mergeRemovals([rm(1, 2), rm(2, 3)])).toHaveLength(1);
    expect(mergeRemovals([rm(1, 2), rm(2.01, 3)])).toHaveLength(2);
  });

  it('carries review flags and decision-model confidence', () => {
    const m = mergeRemovals([rm(1, 2), { ...rm(1.5, 2.5, 'filler'), by: 'decision-model', confidence: 0.8, needsReview: true }]);
    expect(m[0]).toMatchObject({ by: 'decision-model', confidence: 0.8, needsReview: true });
  });

  it('does not mutate its input', () => {
    const input = [rm(1, 2), rm(1.5, 3)];
    mergeRemovals(input);
    expect(input[0]!.end).toBe(2);
  });
});

describe('planKeeps', () => {
  it('complements removals and attaches each removal to the following keep', () => {
    const { keeps, trailing } = planKeeps(10, [rm(0, 1), rm(4, 5, 'filler'), rm(9, 10)], 300);
    expect(keeps.map((k) => [k.start, k.end])).toEqual([[1, 4], [5, 9]]);
    expect(keeps[0]!.removedBefore.map((r) => r.kind)).toEqual(['silence']);
    expect(keeps[1]!.removedBefore.map((r) => r.kind)).toEqual(['filler']);
    expect(trailing.map((r) => [r.start, r.end])).toEqual([[9, 10]]);
  });

  it('no removals → one keep covering everything', () => {
    expect(planKeeps(10, [], 300).keeps).toEqual([{ start: 0, end: 10, removedBefore: [] }]);
  });

  it('everything removed → no keeps', () => {
    const r = planKeeps(10, [rm(0, 10)], 300);
    expect(r.keeps).toEqual([]);
    expect(r.trailing).toHaveLength(1);
  });

  it('fragments shorter than minKeepMs are absorbed, at the boundary exactly kept', () => {
    const r = planKeeps(10, [rm(0, 2), rm(2.2, 5), rm(5.3, 10)], 300);
    expect(r.keeps.map((k) => [k.start, k.end])).toEqual([[5, 5.3]]);
    expect(r.keeps[0]!.removedBefore.some((x) => x.reason.includes('短すぎる'))).toBe(true);
    const tail = planKeeps(10, [rm(0, 9.8)], 300);
    expect(tail.keeps).toEqual([]);
    expect(tail.trailing.at(-1)!.reason).toMatch(/短すぎる/);
  });
});

describe('textIn', () => {
  const words = [{ w: 'これは', start: 0, end: 0.4 }, { w: 'テスト', start: 0.4, end: 0.9 }, { w: 'です', start: 1.0, end: 1.2 }];
  it('joins by word middle', () => {
    expect(textIn(words, 0, 1, 'ja')).toBe('これはテスト');
    expect(textIn(words, 0.95, 2, 'ja')).toBe('です');
    expect(textIn([{ w: 'Hello', start: 0, end: 1 }, { w: ' world', start: 1, end: 2 }, { w: ' .', start: 2, end: 2.1 }], 0, 3, 'en')).toBe('Hello world.');
  });
});

describe('edit flag parsing', () => {
  it('parses --k v, --k=v, booleans and JSON values', () => {
    const { flags, positionals } = parseFlags(['removeSegment', '--id', 'seg_1', '--to=1840', '--needs-review', '--reason', '123', '--patch', '{"text":"x"}', '--dry-run']);
    expect(positionals).toEqual(['removeSegment']);
    expect(flags).toEqual({ id: 'seg_1', to: 1840, 'needs-review': true, reason: '123', patch: { text: 'x' }, 'dry-run': true });
  });
  it('keeps negative numbers as values and stops at --', () => {
    expect(parseFlags(['x', '--gainDb', '-3', '--', '--not-a-flag']).flags.gainDb).toBe(-3);
    expect(parseFlags(['x', '--', '--not-a-flag']).positionals).toEqual(['x', '--not-a-flag']);
  });
  it('rejects prototype keys and empty names', () => {
    expect(() => parseFlags(['x', '--__proto__', '1'])).toThrow();
    expect(() => parseFlags(['x', '--=1'])).toThrow();
  });
});

describe('tl query parsing', () => {
  it('parses kinds and conditions', () => {
    expect(parseQuery('segments[role=demo]')).toEqual({ kind: 'segments', role: 'demo' });
    expect(parseQuery('captions')).toEqual({ kind: 'captions' });
    expect(parseQuery("[id='seg_1']")).toEqual({ id: 'seg_1' });
    expect(parseQuery('segment[role=demo, id=seg_2]')).toEqual({ kind: 'segment', role: 'demo', id: 'seg_2' });
    expect(() => parseQuery('segments[foo=bar]')).toThrow(/unsupported/);
    expect(() => parseQuery('a b c')).toThrow();
  });
});

describe('planKeeps keeps short fragments that hold words (regression: the real take lost 「定を行う。」)', () => {
  const sil = (start: number, end: number): Removal => ({ start, end, kind: 'silence', by: 'rule', reason: 's' });
  // speech 8.8–9.47, a 0.63 s pause, the last words squeezed into 9.95–9.99, then silence to the end
  const removals = [sil(0, 8.8), sil(9.474, 9.8), sil(10.14, 40)];
  const words = [{ start: 8.92, end: 9.32 }, { start: 9.95, end: 9.99 }];

  it('without words the 0.34 s fragment is dropped (as before)', () => {
    const { keeps } = planKeeps(40, removals, 400);
    expect(keeps.map((k) => [k.start, k.end])).toEqual([[8.8, 9.474]]);
  });

  it('with words the pause before it is not cut: one keep up to the end of the fragment', () => {
    const { keeps } = planKeeps(40, removals, 400, 'ja', { words });
    expect(keeps.map((k) => [k.start, k.end])).toEqual([[8.8, 10.14]]);
  });

  it('after a long silence a short fragment is still dropped (whisper invents words there: 「ご視聴ありがとうございました」)', () => {
    const { keeps } = planKeeps(40, [sil(0, 8.8), sil(9.474, 35.87), sil(36.2, 40)], 400, 'ja', { words: [{ start: 36.02, end: 36.05 }], maxBridgeSec: 1.5 });
    expect(keeps.map((k) => [k.start, k.end])).toEqual([[8.8, 9.474]]);
  });

  it('a fragment without a word in it is still dropped; a short tail after a short pause joins the last keep', () => {
    expect(planKeeps(40, removals, 400, 'ja', { words: [{ start: 9.0, end: 9.1 }] }).keeps).toHaveLength(1);
    const tail = planKeeps(10, [sil(0, 5), sil(9.3, 9.8)], 400, 'ja', { words: [{ start: 9.85, end: 9.95 }] });
    expect(tail.keeps.map((k) => [k.start, k.end])).toEqual([[5, 10]]);
    expect(tail.trailing).toEqual([]);
  });
});
