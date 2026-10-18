import type { BenchmarkSample } from '@video/core';
import { probe } from './probe.js';
import { MediaError, ffmpegStderr, ffmpegStdout } from './run.js';
import { extractAudioPcm } from './sync.js';

// `ferret-video bench analyze` (docs/09): measure a reference ("お手本") video that is already a LOCAL file — one the user
// picked, or a recording the app made while the video played in its browser window. Nothing is downloaded. Per second
// of the video: shot changes (scene score), loudness (EBU R128 momentary), sound-effect-like transients, and where a
// caption band sits (bright text with a dark outline, from small grayscale frames). The numbers go into
// core.benchmarkProfile; no picture or sound of the reference is kept.

export interface AnalyzeOptions {
  fromSec?: number;
  toSec?: number;
  /** Scene-change threshold (0..1, default 0.3). */
  sceneThreshold?: number;
  /** Called between the measurement passes: fraction 0..1 and the pass name. */
  onProgress?: (fraction: number, stage: 'cuts' | 'loudness' | 'sfx' | 'captions' | 'done') => void;
}

/** Shot changes from ffmpeg `select='gt(scene,x)',showinfo` stderr: pts_time of each selected frame (seconds). */
export function parseSceneTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([0-9.]+)/g)) out.push(Number(m[1]));
  return out.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

/** Momentary loudness per second from ffmpeg `ebur128` stderr lines ("t: 1.2  … M: -20.3 …"): median per whole second. */
export function parseMomentary(stderr: string): Map<number, number> {
  const bySec = new Map<number, number[]>();
  for (const m of stderr.matchAll(/t:\s*([0-9.]+)\s+TARGET:[^\n]*?M:\s*(-?[0-9.]+|-inf)/g)) {
    const t = Number(m[1]);
    const v = m[2] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[2]);
    if (!Number.isFinite(t)) continue;
    const s = Math.floor(t - 1e-9);
    (bySec.get(s) ?? bySec.set(s, []).get(s)!).push(v);
  }
  const out = new Map<number, number>();
  for (const [s, v] of bySec) {
    const sorted = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    out.set(s, sorted.length ? sorted[sorted.length >> 1]! : -70);
  }
  return out;
}

/**
 * Sound-effect-like transients: 10 ms frames of the pre-emphasized signal whose energy jumps by at least `riseDb`
 * over the median of the previous 150 ms and is loud enough (`floorDb` under the file's peak). Speech syllables rise
 * more slowly; a pop, click or hit jumps within one or two frames. An estimate, not a classifier.
 */
export function detectTransients(x: ArrayLike<number>, sampleRate: number, o: { riseDb?: number; floorDb?: number; minGapSec?: number } = {}): number[] {
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const frames = Math.floor(x.length / hop);
  if (frames < 2) return [];
  const e = new Float64Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const v = (x[i] ?? 0) - 0.95 * prev;
      prev = x[i] ?? 0;
      s += v * v;
    }
    e[f] = 10 * Math.log10(s / hop + 1e-12);
  }
  let peak = Number.NEGATIVE_INFINITY;
  for (const v of e) peak = Math.max(peak, v);
  const floor = peak - (o.floorDb ?? 30);
  const rise = o.riseDb ?? 15;
  const back = 15;
  const gap = Math.round((o.minGapSec ?? 0.5) * 100);
  const out: number[] = [];
  let last = -Infinity;
  for (let f = back; f < frames; f++) {
    if (e[f]! < floor) continue;
    const win = Array.from(e.subarray(f - back, f)).sort((a, b) => a - b);
    const base = win[win.length >> 1]!;
    if (e[f]! - base >= rise && f - last >= gap) {
      out.push(Math.round((f * hop / sampleRate) * 1000) / 1000);
      last = f;
    }
  }
  return out;
}

export interface CaptionBand { y: number; h: number; lines: number; fill: 'light' | 'dark' }

/**
 * A caption band in a small grayscale frame (w×h, row-major): rows in the lower 45 % (or the top 20 %) where many
 * very bright pixels sit right next to very dark ones (white text with a dark outline), grouped into one band.
 * Returns normalized y/h of the band, an estimated line count, or null without one.
 */
export function captionBand(px: Uint8Array, w: number, h: number, o: { minRowShare?: number } = {}): CaptionBand | null {
  if (px.length < w * h || w < 8 || h < 8) return null;
  const share = o.minRowShare ?? 0.04;
  const rowScore = (y: number) => {
    let edges = 0;
    for (let x = 1; x < w; x++) {
      const a = px[y * w + x - 1]!;
      const b = px[y * w + x]!;
      if ((a > 200 && b < 60) || (a < 60 && b > 200)) edges++;
    }
    return edges / w;
  };
  const textRows: boolean[] = Array.from({ length: h }, (_, y) => (y >= h * 0.55 || y < h * 0.2) && rowScore(y) >= share);
  // the longest run of text rows (holes of up to 4 rows — the gap between two lines — are allowed)
  let best: { a: number; b: number; rows: number } | null = null;
  for (let y = 0; y < h; y++) {
    if (!textRows[y]) continue;
    let b = y;
    let rows = 0;
    let holes = 0;
    while (b < h && holes <= 4) {
      if (textRows[b]) {
        rows++;
        holes = 0;
      } else holes++;
      b++;
    }
    const end = b - holes;
    if (!best || rows > best.rows) best = { a: y, b: end, rows };
    y = end;
  }
  if (!best || best.rows < Math.max(2, Math.round(h * 0.03))) return null;
  // lines: runs of text rows separated by a gap
  let lines = 0;
  for (let y = best.a; y < best.b; y++) if (textRows[y] && !textRows[y - 1]) lines++;
  return { y: best.a / h, h: (best.b - best.a) / h, lines: Math.max(1, Math.min(3, lines)), fill: 'light' };
}

/** Mean absolute difference of two bands (change of caption text). */
function bandDiff(a: Uint8Array, b: Uint8Array, w: number, y0: number, y1: number): number {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    s += Math.abs(a[y * w + x]! - b[y * w + x]!);
    n++;
  }
  return n ? s / n : 0;
}

/** Per-second samples of a reference video (core BenchmarkSample), measured with ffmpeg. */
export async function analyzeReference(file: string, o: AnalyzeOptions = {}): Promise<{ samples: BenchmarkSample[]; durationSec: number; warnings: string[] }> {
  const pr = await probe(file);
  const hasVideo = pr.streams.some((s) => s.type === 'video');
  const hasAudio = pr.streams.some((s) => s.type === 'audio');
  if (!hasVideo) throw new MediaError(`${file} has no video stream`);
  const from = Math.max(0, o.fromSec ?? 0);
  const to = Math.min(pr.durationSec, o.toSec ?? pr.durationSec);
  if (!(to - from >= 1)) throw new MediaError(`the analysed range is shorter than 1 s (${from}–${to} of ${pr.durationSec.toFixed(1)} s)`);
  const dur = to - from;
  const range = ['-ss', String(from), '-t', String(dur), '-i', file];
  const warnings: string[] = [];

  const step = o.onProgress ?? (() => undefined);
  // shot changes
  step(0.05, 'cuts');
  const sceneLog = await ffmpegStderr([...range, '-map', '0:v:0', '-vf', `select='gt(scene,${o.sceneThreshold ?? 0.3})',showinfo`, '-an', '-f', 'null', '-']);
  const cuts = parseSceneTimes(sceneLog);

  // loudness and transients
  let momentary = new Map<number, number>();
  let onsets: number[] = [];
  if (hasAudio) {
    step(0.35, 'loudness');
    const log = await ffmpegStderr([...range, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-']);
    momentary = parseMomentary(log);
    step(0.55, 'sfx');
    const pcm = await extractAudioPcm(file, { sampleRate: 16000, mono: true, fromSec: from, durSec: dur });
    onsets = detectTransients(pcm, 16000);
  } else warnings.push('no audio: loudness and sound effects are not measured');

  // caption band at 1 frame a second, 160×90 grayscale
  step(0.75, 'captions');
  const W = 160;
  const H = 90;
  const raw = await ffmpegStdout([...range, '-map', '0:v:0', '-vf', `fps=1,scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1']);
  const frames = Math.floor(raw.length / (W * H));
  const bands: (CaptionBand | null)[] = [];
  const pix: Uint8Array[] = [];
  for (let i = 0; i < frames; i++) {
    const f = new Uint8Array(raw.subarray(i * W * H, (i + 1) * W * H));
    pix.push(f);
    bands.push(captionBand(f, W, H));
  }

  const seconds = Math.max(1, Math.floor(dur));
  const samples: BenchmarkSample[] = [];
  let textId = 0;
  for (let s = 0; s < seconds; s++) {
    const band = bands[s] ?? null;
    const prevBand = s > 0 ? bands[s - 1] ?? null : null;
    if (band) {
      const changed = !prevBand || bandDiff(pix[s]!, pix[s - 1]!, W, Math.floor(band.y * H), Math.ceil((band.y + band.h) * H)) > 12;
      if (changed) textId++;
    }
    samples.push({
      t: s,
      captionBoxes: band ? [{ x: 0.1, y: band.y, w: 0.8, h: band.h, lines: band.lines, text: `c${textId}` }] : [],
      ...(band ? { captionColors: { fill: '#FFFFFF', stroke: '#000000', box: false } } : {}),
      cutTimes: cuts.filter((c) => c >= s && c < s + 1),
      loudness: momentary.get(s) ?? -70,
      sfxOnsets: onsets.filter((c) => c >= s && c < s + 1),
      charsPerMin: 0,
    });
  }
  step(1, 'done');
  return { samples, durationSec: dur, warnings };
}
