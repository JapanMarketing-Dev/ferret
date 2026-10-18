// Cut proposal (docs/05 「カットの採否」): mechanical candidates from silence, fillers, retakes and NG markers, then
// the kept ranges between them. Pure; times are seconds in the take clock.

export type RemovalKind = 'silence' | 'filler' | 'retake' | 'ng-marker';

export interface Removal {
  start: number;
  end: number;
  kind: RemovalKind;
  reason: string;
  by: 'rule' | 'decision-model';
  confidence?: number;
  needsReview?: boolean;
  /** Text that was spoken in the removed range (fillers, retakes), for the decision model and the log. */
  text?: string;
}

export interface CutRules {
  silence: { minMs: number; padMs: number };
  retakes: 'keep-last' | 'keep-first' | 'ask' | 'off';
  ngMarkers: 'cut' | 'mark' | 'off';
  minKeepMs: number;
}

export interface CandidateInput {
  durationSec: number;
  silences: { start: number; end: number }[];
  fillers: { start: number; end: number; text: string }[];
  retakes: { first: [number, number]; second: [number, number]; score: number }[];
  ngMarkers: number[];
  rules: CutRules;
  lang: 'ja' | 'en';
}

const L = (lang: 'ja' | 'en', ja: string, en: string) => (lang === 'ja' ? ja : en);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Mechanical removal candidates (unmerged, clipped to the take). */
export function cutCandidates(i: CandidateInput): Removal[] {
  const out: Removal[] = [];
  const dur = i.durationSec;
  const pad = i.rules.silence.padMs / 1000;
  const minSil = i.rules.silence.minMs / 1000;
  const clip = (s: number, e: number) => [Math.max(0, s), Math.min(dur, e)] as const;

  for (const s of i.silences) {
    if (s.end - s.start < minSil) continue;
    // leading/trailing silence of the take goes completely (only the pad next to speech stays)
    const start = s.start <= 0.01 ? 0 : s.start + pad;
    const end = s.end >= dur - 0.01 ? dur : s.end - pad;
    const [a, b] = clip(start, end);
    if (b - a > 0.001) out.push({ start: a, end: b, kind: 'silence', by: 'rule', reason: L(i.lang, `${r3(s.end - s.start)} 秒の無音`, `${r3(s.end - s.start)}s of silence`) });
  }
  for (const f of i.fillers) {
    const [a, b] = clip(f.start, f.end);
    if (b - a > 0.001) out.push({ start: a, end: b, kind: 'filler', by: 'rule', text: f.text, reason: L(i.lang, `言いよどみ「${f.text}」`, `filler "${f.text}"`) });
  }
  if (i.rules.retakes !== 'off') {
    for (const r of i.retakes) {
      const range = i.rules.retakes === 'keep-first' ? r.second : r.first;
      const [a, b] = clip(range[0], range[1]);
      if (b - a <= 0.001) continue;
      out.push({
        start: a, end: b, kind: 'retake', by: 'rule', confidence: Math.max(0, Math.min(1, r.score)),
        ...(i.rules.retakes === 'ask' ? { needsReview: true } : {}),
        reason: i.rules.retakes === 'keep-first'
          ? L(i.lang, '言い直し（前のテイクを残す）', 'retake (keeping the first take)')
          : L(i.lang, '言い直しの前半（後のテイクを残す）', 'first half of a retake (keeping the later take)'),
      });
    }
  }
  if (i.rules.ngMarkers === 'cut') {
    const sil = i.silences.filter((s) => s.end - s.start >= minSil).sort((a, b) => a.start - b.start);
    for (const m of i.ngMarkers) {
      if (!(m >= 0 && m <= dur)) continue;
      // from the end of the last pause before the marker (the start of the failed sentence) up to the marker
      const prev = sil.filter((s) => s.end <= m).at(-1);
      const start = prev ? prev.end - pad : 0;
      const [a, b] = clip(start, m);
      if (b - a > 0.001) out.push({ start: a, end: b, kind: 'ng-marker', by: 'rule', reason: L(i.lang, '撮影時の NG の目印', 'NG marker pressed while recording') });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

const PRIORITY: Record<RemovalKind, number> = { 'ng-marker': 4, retake: 3, filler: 2, silence: 1 };

/** Union of overlapping removals; the merged range takes the strongest kind and all reasons. */
export function mergeRemovals(list: Removal[], gap = 0.001): Removal[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Removal[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + gap) {
      last.end = Math.max(last.end, r.end);
      if (PRIORITY[r.kind] > PRIORITY[last.kind]) last.kind = r.kind;
      if (!last.reason.split(' / ').includes(r.reason)) last.reason = `${last.reason} / ${r.reason}`;
      if (r.needsReview) last.needsReview = true;
      if (r.by === 'decision-model') {
        last.by = 'decision-model';
        if (r.confidence !== undefined) last.confidence = r.confidence;
      }
      if (r.text) last.text = last.text ? `${last.text} ${r.text}` : r.text;
    } else out.push({ ...r });
  }
  return out;
}

export interface Keep { start: number; end: number; removedBefore: Removal[] }

/**
 * Kept ranges between removals. Keeps shorter than minKeepMs are dropped (absorbed into the removal before them) —
 * unless a transcribed word sits in them right after a short pause (whisper squeezes the last words of a sentence
 * into a few ms after a pause): then that pause is not cut and the fragment joins the keep before it. A short
 * fragment after a long silence is still dropped (whisper invents words in long silences: 「ご視聴ありがとうございました」).
 */
export function planKeeps(durationSec: number, removals: Removal[], minKeepMs: number, lang: 'ja' | 'en' = 'ja', o: { words?: { start: number; end: number }[]; maxBridgeSec?: number } = {}): { keeps: Keep[]; trailing: Removal[] } {
  const merged = mergeRemovals(removals);
  const minKeep = minKeepMs / 1000;
  const keeps: Keep[] = [];
  let pending: Removal[] = [];
  let at = 0;
  const pushRemoval = (r: Removal) => pending.push(r);
  /** The removals since the last keep are one short pause right after it. */
  const bridges = () => {
    const last = keeps.at(-1);
    const gap = pending.length === 1 && pending[0]!.kind === 'silence' ? pending[0]! : null;
    return !!last && !!gap && gap.start <= last.end + 1e-6 && gap.end - gap.start <= (o.maxBridgeSec ?? 1.5);
  };
  const hasWord = (a: number, b: number) => (o.words ?? []).some((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= a && mid < b;
  });
  for (const r of merged) {
    if (r.start > at) {
      if (r.start - at >= minKeep - 1e-9) {
        keeps.push({ start: at, end: r.start, removedBefore: pending });
        pending = [];
      } else if (r.start - at > 0.001 && hasWord(at, r.start) && bridges()) {
        keeps.at(-1)!.end = r.start; // keep the short pause: the sentence goes on
        pending = [];
      } else if (r.start - at > 0.001) {
        pushRemoval({ start: at, end: r.start, kind: 'silence', by: 'rule', reason: L(lang, `短すぎる断片（${r3(r.start - at)} 秒）`, `fragment too short (${r3(r.start - at)}s)`) });
      }
    }
    pushRemoval(r);
    at = Math.max(at, r.end);
  }
  if (durationSec - at >= minKeep - 1e-9) {
    keeps.push({ start: at, end: durationSec, removedBefore: pending });
    pending = [];
  } else if (durationSec - at > 0.001 && hasWord(at, durationSec) && bridges()) {
    keeps.at(-1)!.end = durationSec;
    pending = [];
  } else if (durationSec - at > 0.001) {
    pushRemoval({ start: at, end: durationSec, kind: 'silence', by: 'rule', reason: L(lang, `短すぎる断片（${r3(durationSec - at)} 秒）`, `fragment too short (${r3(durationSec - at)}s)`) });
  }
  return { keeps, trailing: pending };
}

/** Words whose middle falls inside [start, end), joined for the language. */
export function textIn(words: { w: string; start: number; end: number }[], start: number, end: number, lang: 'ja' | 'en'): string {
  const ws = words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= start && mid < end;
  });
  return lang === 'ja' ? ws.map((w) => w.w.trim()).join('') : ws.map((w) => w.w.trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1');
}
