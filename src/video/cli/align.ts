// whisper.cpp word timestamps drift (typically late, up to ~1 s at the end of an utterance), while ffmpeg's
// silencedetect is reliable. Fit the words into the detected speech regions so cuts and captions agree with the audio.

export interface TimedWord { w: string; start: number; end: number; conf?: number; speaker?: string }

const SENTENCE_END = /[。．.!?！？]$/;

/** Speech regions = [0, duration] minus silences (sorted, merged). */
export function speechRegions(silences: { start: number; end: number }[], durationSec: number): [number, number][] {
  const sil = [...silences].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: [number, number][] = [];
  let at = 0;
  for (const s of sil) {
    const a = Math.max(0, s.start);
    if (a > at + 1e-6) out.push([at, Math.min(a, durationSec)]);
    at = Math.max(at, s.end);
  }
  if (durationSec > at + 1e-6) out.push([at, durationSec]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

/**
 * Assign each word to a speech region (monotonic) and map each region's words linearly into it.
 * A word whose middle falls in a pause goes to the region before the pause when it, or a later word in the same
 * pause, ends a sentence; otherwise to the nearer side.
 */
export function alignWordsToSpeech<W extends TimedWord>(words: W[], silences: { start: number; end: number }[], durationSec: number): W[] {
  if (!words.length) return [];
  const regions = speechRegions(silences, durationSec);
  if (!regions.length) return words.map((w) => ({ ...w }));
  const regionAt = (t: number) => regions.findIndex(([a, b]) => t >= a && t < b);
  const assign: number[] = new Array(words.length).fill(-1);

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const mid = (w.start + w.end) / 2;
    const r = regionAt(mid);
    if (r >= 0) {
      assign[i] = r;
      continue;
    }
    // in a pause: the regions around it
    const after = regions.findIndex(([a]) => a >= mid);
    const before = after === -1 ? regions.length - 1 : after - 1;
    if (before < 0) {
      assign[i] = Math.max(0, after);
      continue;
    }
    if (after === -1) {
      assign[i] = before;
      continue;
    }
    // words sharing this pause
    let j = i;
    while (j + 1 < words.length && regionAt((words[j + 1]!.start + words[j + 1]!.end) / 2) === -1 && (words[j + 1]!.start + words[j + 1]!.end) / 2 < regions[after]![0]) j++;
    let lastEnd = -1;
    for (let k = i; k <= j; k++) if (SENTENCE_END.test(words[k]!.w.trim())) lastEnd = k;
    const prevEndsSentence = i > 0 && SENTENCE_END.test(words[i - 1]!.w.trim());
    for (let k = i; k <= j; k++) {
      if (lastEnd >= 0) assign[k] = k <= lastEnd ? before : after;
      else if (prevEndsSentence) assign[k] = after;
      else {
        const m = (words[k]!.start + words[k]!.end) / 2;
        const gapMid = (regions[before]![1] + regions[after]![0]) / 2;
        assign[k] = m < gapMid ? before : after;
      }
    }
    i = j;
  }
  // monotonic: never go back to an earlier region
  for (let i = 1; i < assign.length; i++) if (assign[i]! < assign[i - 1]!) assign[i] = assign[i - 1]!;

  const out = words.map((w) => ({ ...w }));
  for (let r = 0; r < regions.length; r++) {
    const idx = assign.map((a, i) => (a === r ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const [ra, rb] = regions[r]!;
    const ws = Math.min(...idx.map((i) => words[i]!.start));
    const we = Math.max(...idx.map((i) => words[i]!.end));
    if (ws >= ra - 1e-6 && we <= rb + 1e-6) continue; // already inside
    let ts = Math.min(Math.max(ws, ra), rb);
    let te = Math.max(Math.min(we, rb), ra);
    const minSpan = Math.min(rb - ra, 0.06 * idx.length);
    if (te - ts < minSpan) {
      if (we > rb) ts = Math.max(ra, te - minSpan);
      else te = Math.min(rb, ts + minSpan);
    }
    const span = we - ws;
    const map = (t: number) => (span > 1e-9 ? ts + ((t - ws) / span) * (te - ts) : ts);
    for (const i of idx) {
      out[i]!.start = round(map(words[i]!.start));
      out[i]!.end = round(Math.max(map(words[i]!.end), out[i]!.start));
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
