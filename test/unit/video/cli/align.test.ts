import { describe, expect, it } from 'vitest';
import { alignWordsToSpeech, speechRegions } from '@video/cli/align.js';
import { planKeeps, cutCandidates, textIn } from '@video/cli/cuts.js';

const w = (text: string, start: number, end: number) => ({ w: text, start, end });

// Real whisper.cpp (ggml-small, -ml 1 -sow) output for a macOS `say` clip, and ffmpeg silencedetect on the same audio.
const WORDS = [
  w('今日は、', 0.97, 1.87), w('ですね、', 2.19, 2.9), w('クロード', 2.93, 3.68), w('コード', 3.68, 4.17), w('の', 4.26, 4.45), w('設定', 4.45, 4.83),
  w('に', 4.83, 4.94), w('つ', 5.02, 5.03), w('いて', 5.31, 5.6), w('話', 5.6, 5.79), w('します。', 6.44, 6.46),
  w('まず、', 6.48, 7.36), w('設定', 7.36, 7.65), w('ファイル', 7.88, 8.68), w('を', 8.68, 8.9), w('開', 8.9, 9.06), w('きます。', 9.16, 9.9),
  w('あの', 9.92, 10.13), w('ー、', 10.13, 10.37), w('次', 10.93, 11.04), w('に、', 11.04, 11.38),
];
const SIL = [{ start: 4.965, end: 6.519 }, { start: 8.699, end: 9.946 }];

describe('speechRegions', () => {
  it('complements silences within the duration', () => {
    expect(speechRegions(SIL, 13.4)).toEqual([[0, 4.965], [6.519, 8.699], [9.946, 13.4]]);
    expect(speechRegions([{ start: 0, end: 1 }, { start: 0.5, end: 2 }], 3)).toEqual([[2, 3]]);
    expect(speechRegions([], 2)).toEqual([[0, 2]]);
    expect(speechRegions([{ start: 0, end: 5 }], 5)).toEqual([]);
  });
});

describe('alignWordsToSpeech', () => {
  const out = alignWordsToSpeech(WORDS, SIL, 13.4);
  const inRegion = (x: { start: number; end: number }) => speechRegions(SIL, 13.4).some(([a, b]) => x.start >= a - 1e-6 && x.end <= b + 1e-6);

  it('moves every word into speech, keeps order and text', () => {
    expect(out.map((x) => x.w)).toEqual(WORDS.map((x) => x.w));
    for (const x of out) expect(inRegion(x), `${x.w} ${x.start}-${x.end}`).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start);
  });

  it('a sentence end inside a pause stays with the sentence before it', () => {
    expect(out.find((x) => x.w === 'します。')!.end).toBeLessThanOrEqual(4.965);
    expect(out.find((x) => x.w === 'きます。')!.end).toBeLessThanOrEqual(8.699);
    expect(out.find((x) => x.w === 'まず、')!.start).toBeGreaterThanOrEqual(6.519);
  });

  it('words well inside a region move only slightly', () => {
    const x = out.find((y) => y.w === '次')!;
    expect(Math.abs(x.start - 10.93)).toBeLessThan(0.02);
    expect(Math.abs(x.end - 11.04)).toBeLessThan(0.02);
    expect(alignWordsToSpeech([w('a', 1, 2)], SIL, 13.4)).toEqual([w('a', 1, 2)]);
  });

  it('after aligning, cutting the silences keeps every word of the kept speech', () => {
    const cands = cutCandidates({ durationSec: 13.4, silences: SIL, fillers: [], retakes: [], ngMarkers: [], lang: 'ja', rules: { silence: { minMs: 400, padMs: 100 }, retakes: 'off', ngMarkers: 'off', minKeepMs: 250 } });
    const { keeps } = planKeeps(13.4, cands, 250);
    const text = keeps.map((k) => textIn(out, k.start, k.end, 'ja')).join('');
    expect(text).toBe(WORDS.map((x) => x.w).join(''));
    // without alignment, words are lost in the cut pauses
    const raw = keeps.map((k) => textIn(WORDS, k.start, k.end, 'ja')).join('');
    expect(raw.length).toBeLessThan(text.length);
  });

  it('no punctuation: nearer side of the pause decides', () => {
    const r = alignWordsToSpeech([w('a', 0, 1), w('b', 2.1, 2.3), w('c', 3.7, 3.9), w('d', 4.5, 5)], [{ start: 2, end: 4 }], 5);
    expect(r[1]!.end).toBeLessThanOrEqual(2);
    expect(r[2]!.start).toBeGreaterThanOrEqual(4);
  });

  it('the word after a sentence end goes after the pause', () => {
    const r = alignWordsToSpeech([w('終わり。', 0, 1.9), w('次', 2.1, 2.3)], [{ start: 2, end: 4 }], 5);
    expect(r[1]!.start).toBeGreaterThanOrEqual(4);
  });

  it('edge cases: empty, all silence, leading pause, words past the end', () => {
    expect(alignWordsToSpeech([], SIL, 10)).toEqual([]);
    expect(alignWordsToSpeech([w('x', 1, 2)], [{ start: 0, end: 5 }], 5)).toEqual([w('x', 1, 2)]);
    const lead = alignWordsToSpeech([w('a', 0.2, 0.5)], [{ start: 0, end: 1 }], 3);
    expect(lead[0]!.start).toBeGreaterThanOrEqual(1);
    const tail = alignWordsToSpeech([w('a', 1, 1.5), w('b', 2.8, 3.5)], [], 3);
    expect(tail[1]!.end).toBeLessThanOrEqual(3);
  });
});
