// Benchmark style profiles (docs/09): per-second measurements of a reference video → numbers → template patch.
// The desktop measures while the user plays the video; only these numbers are kept.
import type { SfxRule } from './sfx.js';

/** One second of measurements. Boxes are normalized to the video frame (0..1). Times in seconds. */
export interface BenchmarkSample {
  t: number;
  captionBoxes: { x: number; y: number; w: number; h: number; chars?: number; lines?: number; text?: string }[];
  captionColors?: {
    fill?: string; stroke?: string; strokeWidthRatio?: number; box?: boolean; emphasisColor?: string; emphasisScale?: number;
    reveal?: 'block' | 'word' | 'word-highlight';
  };
  cutTimes: number[];
  /** Momentary loudness of the whole mix (LUFS). */
  loudness: number;
  speechLufs?: number;
  /** BGM level relative to speech (dB), when separated. */
  bgmRelDb?: number;
  sfxOnsets: number[];
  /** Library category per onset (same order), when classified. */
  sfxKinds?: string[];
  charsPerMin: number;
  /** Punch-in scale when a zoom-in happened in this second. */
  punchIn?: number;
}

export interface StyleProfile {
  source?: { url?: string; platform?: string; analyzed?: string };
  durationSec: number;
  captions: {
    present: boolean; anchorY: number; heightRatio: number; charsPerLine: { p50: number; p90: number }; lines: number;
    fill?: string; stroke?: { color: string; widthRatio: number }; box: boolean;
    reveal: 'block' | 'word' | 'word-highlight'; emphasis: { rate: number; color?: string; scale?: number };
  };
  cuts: { avgShotSec: number; jumpCutsPerMin: number; punchIn: { perMin: number; scale: number } };
  audio: { speechLufs: number; bgm: { present: boolean; relDb: number } };
  sfx: { perMin: number; on: { cut: number; captionIn: number; emphasis: number; section: number }; kinds: Record<string, number> };
  speech: { charsPerMin: number };
}

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (v: number[], q: number): number => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
function mode<T>(v: T[]): T | undefined {
  const m = new Map<T, number>();
  for (const x of v) m.set(x, (m.get(x) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [k, c] of m) if (c > n) [best, n] = [k, c];
  return best;
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const near = (times: number[], at: number, tol: number) => times.some((x) => Math.abs(x - at) <= tol);

/** Summarize per-second samples into a style profile (pure). Throws on no samples. */
export function benchmarkProfile(samples: BenchmarkSample[], o: { source?: StyleProfile['source']; tolSec?: number } = {}): StyleProfile {
  if (!samples.length) throw new Error('benchmarkProfile: no samples');
  const ss = [...samples].sort((a, b) => a.t - b.t);
  const tol = o.tolSec ?? 0.3;
  const durationSec = Math.max(1, ss[ss.length - 1]!.t - ss[0]!.t + 1);
  const minutes = durationSec / 60;

  // captions
  const withCaps = ss.filter((s) => s.captionBoxes.length);
  const bottoms = withCaps.map((s) => Math.max(...s.captionBoxes.map((b) => b.y + b.h)));
  const lineH = withCaps.flatMap((s) => s.captionBoxes.map((b) => b.h / Math.max(1, b.lines ?? 1)));
  const cpl = withCaps.flatMap((s) => s.captionBoxes.filter((b) => b.chars !== undefined).map((b) => b.chars! / Math.max(1, b.lines ?? 1)));
  const lines = withCaps.map((s) => s.captionBoxes.reduce((n, b) => n + Math.max(1, b.lines ?? 1), 0));
  const colors = withCaps.map((s) => s.captionColors).filter((c): c is NonNullable<BenchmarkSample['captionColors']> => !!c);
  const fill = mode(colors.map((c) => c.fill).filter((x): x is string => !!x));
  const strokeColor = mode(colors.map((c) => c.stroke).filter((x): x is string => !!x));
  const strokeW = median(colors.map((c) => c.strokeWidthRatio).filter((x): x is number => x !== undefined));
  const boxVotes = colors.map((c) => c.box).filter((x): x is boolean => x !== undefined);
  const emph = colors.filter((c) => c.emphasisColor);
  const emphColor = mode(emph.map((c) => c.emphasisColor!));
  const emphScale = median(colors.map((c) => c.emphasisScale).filter((x): x is number => x !== undefined));
  const reveal = mode(colors.map((c) => c.reveal).filter((x): x is NonNullable<typeof x> => !!x)) ?? 'block';
  // caption appearances: a caption shows up or its text changes
  const capIn: number[] = [];
  ss.forEach((s, i) => {
    if (!s.captionBoxes.length) return;
    const prev = ss[i - 1];
    const text = s.captionBoxes.map((b) => b.text ?? '').join('|');
    const prevText = prev ? prev.captionBoxes.map((b) => b.text ?? '').join('|') : '';
    if (!prev || !prev.captionBoxes.length || (text !== '' && text !== prevText)) capIn.push(s.t);
  });
  const emphasisTimes = ss.filter((s) => s.captionColors?.emphasisColor).map((s) => s.t);

  // cuts, punch-ins
  const cuts = ss.flatMap((s) => s.cutTimes);
  const punch = ss.filter((s) => s.punchIn !== undefined && s.punchIn > 1);

  // audio
  const speech = ss.map((s) => s.speechLufs).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const loud = ss.map((s) => s.loudness).filter((x) => Number.isFinite(x) && x > -70);
  const bgm = ss.map((s) => s.bgmRelDb).filter((x): x is number => x !== undefined && Number.isFinite(x));

  // sfx
  const onsets = ss.flatMap((s) => s.sfxOnsets);
  const kinds = ss.flatMap((s) => s.sfxKinds ?? []);
  const kindShare: Record<string, number> = {};
  for (const k of kinds) kindShare[k] = (kindShare[k] ?? 0) + 1;
  for (const k of Object.keys(kindShare)) kindShare[k] = r2(kindShare[k]! / kinds.length);
  const share = (times: number[]) => (onsets.length ? r2(onsets.filter((x) => near(times, x, tol)).length / onsets.length) : 0);

  const profile: StyleProfile = {
    durationSec,
    captions: {
      present: withCaps.length / ss.length >= 0.2,
      anchorY: r3(median(bottoms)),
      heightRatio: r3(median(lineH)),
      charsPerLine: { p50: Math.round(median(cpl)), p90: Math.round(quantile(cpl, 0.9)) },
      lines: Math.max(1, Math.round(median(lines))),
      box: boxVotes.filter(Boolean).length > boxVotes.length / 2,
      reveal,
      emphasis: { rate: withCaps.length ? r2(emph.length / withCaps.length) : 0, ...(emphColor ? { color: emphColor } : {}), ...(emphScale ? { scale: r2(emphScale) } : {}) },
      ...(fill ? { fill } : {}),
      ...(strokeColor ? { stroke: { color: strokeColor, widthRatio: r3(strokeW) } } : {}),
    },
    cuts: {
      avgShotSec: r2(durationSec / (cuts.length + 1)),
      jumpCutsPerMin: r2(cuts.length / minutes),
      punchIn: { perMin: r2(punch.length / minutes), scale: punch.length ? r2(median(punch.map((p) => p.punchIn!))) : 1 },
    },
    audio: {
      speechLufs: r2(speech.length ? median(speech) : median(loud)),
      bgm: { present: bgm.length / ss.length >= 0.2, relDb: bgm.length ? r2(median(bgm)) : 0 },
    },
    sfx: {
      perMin: r2(onsets.length / minutes),
      on: { cut: share(cuts), captionIn: share(capIn), emphasis: share(emphasisTimes), section: 0 },
      kinds: kindShare,
    },
    speech: { charsPerMin: Math.round(median(ss.map((s) => s.charsPerMin).filter((x) => x > 0))) },
  };
  if (o.source) profile.source = o.source;
  return profile;
}

/** The template fields a profile can set (structural subset of @video/templates Template; deep-merge it). */
export interface TemplatePatch {
  captions?: {
    style?: string; highlight?: 'word' | 'line' | 'none'; maxCharsPerLine?: number; maxLines?: number;
    position?: { anchor: 'bottom' | 'top' | 'center'; y: number }; emphasis?: 'auto' | 'off';
  };
  cut?: { jumpZoom?: { every: number; scale: number } };
  audio?: { loudness?: number; bgm?: { gainDb: number }; sfx?: { maxPerMinute: number; gainDb: number } };
  /** docs/09 sfx rules (templates store them under `sfx`). */
  sfx?: { rules: SfxRule[]; maxPerMin: number };
  /** Look for building a caption style (ASS) close to the reference. */
  captionLook?: { size: number; fill?: string; stroke?: { color: string; widthRatio: number }; box: boolean; emphasisColor?: string; emphasisScale?: number };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Turn a style profile into a template patch (captions, cut pacing, sfx rules, bgm gain). Pure. */
export function profileToTemplatePatch(p: StyleProfile): TemplatePatch {
  const patch: TemplatePatch = {};
  if (p.captions.present) {
    patch.captions = {
      // 16:9 styles only (one YouTube-style video): big text → the heavy tech style, small → the clean one
      style: p.captions.heightRatio >= 0.045 ? 'tech-bold' : 'youtube-clean',
      highlight: p.captions.reveal === 'block' ? 'line' : 'word',
      // characters per line are only known when the measurement read the text (OCR); otherwise keep the template's
      ...(p.captions.charsPerLine.p90 || p.captions.charsPerLine.p50
        ? { maxCharsPerLine: clamp(Math.round(p.captions.charsPerLine.p90 || p.captions.charsPerLine.p50), 8, 30) } : {}),
      maxLines: clamp(p.captions.lines, 1, 3),
      position: { anchor: 'bottom', y: clamp(r3(p.captions.anchorY), 0.5, 0.95) },
      emphasis: p.captions.emphasis.rate >= 0.05 ? 'auto' : 'off',
    };
    patch.captionLook = {
      size: p.captions.heightRatio, box: p.captions.box,
      ...(p.captions.fill ? { fill: p.captions.fill } : {}),
      ...(p.captions.stroke ? { stroke: p.captions.stroke } : {}),
      ...(p.captions.emphasis.color ? { emphasisColor: p.captions.emphasis.color } : {}),
      ...(p.captions.emphasis.scale ? { emphasisScale: p.captions.emphasis.scale } : {}),
    };
  } else {
    patch.captions = { highlight: 'none' };
  }
  if (p.cuts.punchIn.perMin > 0 && p.cuts.jumpCutsPerMin > 0) {
    patch.cut = { jumpZoom: { every: Math.max(1, Math.round(p.cuts.jumpCutsPerMin / p.cuts.punchIn.perMin)), scale: clamp(p.cuts.punchIn.scale, 1, 2) } };
  }
  const audio: NonNullable<TemplatePatch['audio']> = {};
  if (p.audio.bgm.present) audio.bgm = { gainDb: clamp(Math.round(p.audio.bgm.relDb), -40, 0) };
  // a tasteful cap even when the reference is busier (4–8 a minute)
  if (p.sfx.perMin > 0) audio.sfx = { maxPerMinute: clamp(Math.ceil(p.sfx.perMin), 1, 8), gainDb: -18 };
  if (Object.keys(audio).length) patch.audio = audio;
  if (p.sfx.perMin > 0) {
    const kind = Object.entries(p.sfx.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'pop';
    const rules: SfxRule[] = [];
    const add = (on: SfxRule['on'], prob: number) => {
      if (prob >= 0.05) rules.push({ on, kind, probability: r2(clamp(prob, 0, 1)) });
    };
    add('emphasis', p.sfx.on.emphasis);
    add('caption-in', p.sfx.on.captionIn);
    add('cut', p.sfx.on.cut);
    if (p.cuts.punchIn.perMin > 0) rules.push({ on: 'zoom-in', kind: 'swoosh-in', probability: 0.7 });
    rules.push({ on: 'section', kind: p.sfx.kinds.whoosh !== undefined ? 'whoosh' : kind, probability: p.sfx.on.section > 0 ? r2(p.sfx.on.section) : 1 });
    patch.sfx = { rules, maxPerMin: clamp(Math.ceil(p.sfx.perMin), 1, 8) };
  }
  return patch;
}
