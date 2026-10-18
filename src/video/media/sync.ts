import { xcorr } from './fft.js';
import { probe } from './probe.js';
import { ffmpegStdout, MediaError } from './run.js';

/** Decode the first audio stream to mono float32 PCM at `sampleRate`. */
export async function extractAudioPcm(path: string, o: { sampleRate: number; mono: true; fromSec?: number; durSec?: number }): Promise<Float32Array> {
  if (!Number.isInteger(o.sampleRate) || o.sampleRate < 1000 || o.sampleRate > 384000) throw new RangeError(`invalid sampleRate ${o.sampleRate}`);
  if (o.fromSec !== undefined && !(o.fromSec >= 0)) throw new RangeError('fromSec must be >= 0');
  if (o.durSec !== undefined && !(o.durSec > 0)) throw new RangeError('durSec must be > 0');
  const p = await probe(path);
  if (!p.streams.some((s) => s.type === 'audio')) throw new MediaError(`${path} has no audio stream`);
  const args: string[] = [];
  if (o.fromSec) args.push('-ss', String(o.fromSec));
  args.push('-i', path);
  if (o.durSec !== undefined) args.push('-t', String(o.durSec));
  args.push('-map', '0:a:0', '-vn', '-sn', '-ac', '1', '-ar', String(o.sampleRate), '-f', 'f32le', 'pipe:1');
  const buf = await ffmpegStdout(args);
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  out.set(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
  return out;
}

function movingAverage(x: Float64Array, w: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const half = Math.floor(w / 2);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i]! + x[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (cs[b]! - cs[a]!) / (b - a);
  }
  return out;
}

/**
 * Onset strength: pre-emphasis (high-frequency emphasis) → rectify → 2 ms smoothing → log compression →
 * subtract the 100 ms local mean and keep the positive part. Speech attacks (consonants, claps) become sharp peaks.
 */
export function onsetEnvelope(x: ArrayLike<number>, sampleRate: number): Float64Array {
  const n = x.length;
  const y = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    y[i] = Math.abs(v - 0.97 * prev);
    prev = v;
  }
  const env = movingAverage(y, Math.max(1, Math.round(sampleRate * 0.002)));
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, env[i]!);
  if (peak <= 0) return new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.log1p((env[i]! / peak) * 1000);
  const slow = movingAverage(env, Math.max(3, Math.round(sampleRate * 0.1)));
  for (let i = 0; i < n; i++) env[i] = Math.max(0, env[i]! - slow[i]!);
  return env;
}

function decimate(x: Float64Array, factor: number): Float64Array {
  if (factor <= 1) return x;
  const n = Math.floor(x.length / factor);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += x[i * factor + k]!;
    out[i] = s / factor;
  }
  return out;
}

function zscore(x: Float64Array): { z: Float64Array; ok: boolean } {
  const n = x.length;
  if (n === 0) return { z: x, ok: false };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i]! - mean) ** 2;
  const sd = Math.sqrt(v / n);
  const z = new Float64Array(n);
  if (!(sd > 1e-12)) return { z, ok: false };
  for (let i = 0; i < n; i++) z[i] = (x[i]! - mean) / sd;
  return { z, ok: true };
}

function cumsq(x: Float64Array): Float64Array {
  const c = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) c[i + 1] = c[i]! + x[i]! * x[i]!;
  return c;
}

export interface XcorrResult {
  /** Seconds: `other` is `ref` delayed by offsetSec (an event at ref time t appears at t + offsetSec in other). */
  offsetSec: number;
  /** 0..1: min(1, (ratio−1)/2) · min(1, correlation/0.5). 1 ⇔ ratio ≥ 3 and correlation ≥ 0.5 (auto-accept band). */
  confidence: number;
  /** Highest peak ÷ highest other peak at least 0.5 s away (capped at 1000). */
  ratio: number;
  /** Normalized correlation of the onset envelopes over the overlap at the peak (−1..1). */
  correlation: number;
}

const COARSE_RATE = 500;

/**
 * FFT cross-correlation of onset envelopes: coarse search at ~500 Hz over ±maxLagSec, then a fine search at the full
 * rate around the coarse peak with parabolic interpolation.
 */
export function crossCorrelateOffset(ref: Float32Array, other: Float32Array, sampleRate: number, o: { maxLagSec?: number } = {}): XcorrResult {
  if (!(sampleRate > 0)) throw new RangeError('sampleRate must be > 0');
  const none: XcorrResult = { offsetSec: 0, confidence: 0, ratio: 0, correlation: 0 };
  if (ref.length < 2 || other.length < 2) return none;
  const envR = onsetEnvelope(ref, sampleRate);
  const envO = onsetEnvelope(other, sampleRate);
  const D = Math.max(1, Math.floor(sampleRate / COARSE_RATE));
  const rateC = sampleRate / D;
  const cr = zscore(decimate(envR, D));
  const co = zscore(decimate(envO, D));
  if (!cr.ok || !co.ok) return none;
  const maxLagSec = o.maxLagSec ?? 600;
  const maxLagC = Math.min(Math.round(maxLagSec * rateC), cr.z.length + co.z.length);
  const c = xcorr(cr.z, co.z, maxLagC);

  // Require a minimum overlap so edge lags with a handful of samples cannot win.
  const minOverlap = Math.max(4, Math.round(Math.min(cr.z.length, co.z.length) * 0.2));
  const overlap = (lag: number) => Math.min(cr.z.length, co.z.length - lag) - Math.max(0, -lag);
  let best = -1;
  let bestV = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < c.length; i++) {
    const lag = i - maxLagC;
    if (overlap(lag) < minOverlap) continue;
    if (c[i]! > bestV) {
      bestV = c[i]!;
      best = i;
    }
  }
  if (best < 0 || !(bestV > 0)) return none;
  const excl = Math.round(0.5 * rateC);
  let second = 0;
  for (let i = 0; i < c.length; i++) {
    if (Math.abs(i - best) < excl) continue;
    if (overlap(i - maxLagC) < minOverlap) continue;
    if (c[i]! > second) second = c[i]!;
  }
  const ratio = second > 0 ? Math.min(1000, bestV / second) : 1000;
  const lagC = best - maxLagC;
  // Overlap-normalized correlation at the peak.
  const sqR = cumsq(cr.z);
  const sqO = cumsq(co.z);
  const lo = Math.max(0, -lagC);
  const hi = Math.min(cr.z.length, co.z.length - lagC);
  const eR = sqR[hi]! - sqR[lo]!;
  const eO = sqO[hi + lagC]! - sqO[lo + lagC]!;
  const correlation = eR > 0 && eO > 0 ? Math.max(-1, Math.min(1, bestV / Math.sqrt(eR * eO))) : 0;

  // Fine search at full rate around the coarse peak.
  const center = lagC * D;
  const W = 2 * D + 2;
  const zr = zscore(envR).z;
  const zo = zscore(envO).z;
  // Limit the summed span to ~60 s around the middle of the overlap.
  const oLo = Math.max(0, -center);
  const oHi = Math.min(zr.length, zo.length - center);
  const span = Math.min(oHi - oLo, Math.round(sampleRate * 60));
  const s0 = oLo + Math.max(0, Math.floor((oHi - oLo - span) / 2));
  const fine = new Float64Array(2 * W + 1);
  for (let k = -W; k <= W; k++) {
    const lag = center + k;
    const a = Math.max(s0, -lag);
    const b = Math.min(s0 + span, zr.length, zo.length - lag);
    let s = 0;
    for (let n = a; n < b; n++) s += zr[n]! * zo[n + lag]!;
    fine[k + W] = s;
  }
  let fb = 0;
  for (let i = 1; i < fine.length; i++) if (fine[i]! > fine[fb]!) fb = i;
  let delta = 0;
  if (fb > 0 && fb < fine.length - 1) {
    const y0 = fine[fb - 1]!;
    const y1 = fine[fb]!;
    const y2 = fine[fb + 1]!;
    const den = y0 - 2 * y1 + y2;
    if (den < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  const offsetSec = (center + (fb - W) + delta) / sampleRate;
  const confidence = Math.min(1, Math.max(0, (ratio - 1) / 2)) * Math.min(1, Math.max(0, correlation / 0.5));
  return { offsetSec, confidence, ratio, correlation };
}

/** Robust line fit y = a + b·x: exhaustive-pair RANSAC, then least squares on the inliers. */
export function robustLine(points: { x: number; y: number }[], tol: number): { a: number; b: number; inliers: number } | null {
  if (points.length < 2) return null;
  let bestSet: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const p = points[i]!;
      const q = points[j]!;
      if (q.x === p.x) continue;
      const b = (q.y - p.y) / (q.x - p.x);
      const a = p.y - b * p.x;
      const set = points.map((r, k) => (Math.abs(r.y - (a + b * r.x)) <= tol ? k : -1)).filter((k) => k >= 0);
      if (set.length > bestSet.length) bestSet = set;
    }
  }
  if (bestSet.length < 2) return null;
  const pts = bestSet.map((k) => points[k]!);
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b, inliers: n };
}

export interface SyncResult {
  /** Offset of `other` relative to `ref` in seconds (at ref time 0 when `drift` is given). */
  offsetSec: number;
  confidence: number;
  ratio: number;
  correlation: number;
  /** Clock rate of other relative to ref (other time = drift · ref time + offset). */
  drift?: number;
  windows?: { atSec: number; offsetSec: number; confidence: number }[];
  method: 'xcorr';
}

const SYNC_RATE = 8000;
const MAX_SEC = 3600;

/**
 * Find the offset of `otherPath` against `refPath` by audio cross-correlation (8 kHz mono, onset envelopes).
 * Drift is estimated from windowed offsets when `driftWindows` is true, or automatically for ≥ 10 min inputs.
 */
export async function syncFiles(refPath: string, otherPath: string, o: { maxLagSec?: number; driftWindows?: boolean; windowSec?: number } = {}): Promise<SyncResult> {
  const [ref, other] = await Promise.all([
    extractAudioPcm(refPath, { sampleRate: SYNC_RATE, mono: true, durSec: MAX_SEC }),
    extractAudioPcm(otherPath, { sampleRate: SYNC_RATE, mono: true, durSec: MAX_SEC }),
  ]);
  const xo: { maxLagSec?: number } = {};
  if (o.maxLagSec !== undefined) xo.maxLagSec = o.maxLagSec;
  const g = crossCorrelateOffset(ref, other, SYNC_RATE, xo);
  const result: SyncResult = { offsetSec: g.offsetSec, confidence: g.confidence, ratio: g.ratio, correlation: g.correlation, method: 'xcorr' };
  const doDrift = o.driftWindows ?? other.length / SYNC_RATE >= 600;
  if (!doDrift || g.confidence <= 0) return result;
  const win = o.windowSec ?? 60;
  const margin = 1;
  const windows: NonNullable<SyncResult['windows']> = [];
  for (let s = 0; s + win <= other.length / SYNC_RATE + 1e-9; s += win) {
    const r0 = Math.max(0, s - g.offsetSec - margin);
    const r1 = Math.min(ref.length / SYNC_RATE, s - g.offsetSec + win + margin);
    if (r1 - r0 < win / 2) continue;
    const oi0 = Math.round(s * SYNC_RATE);
    const ri0 = Math.round(r0 * SYNC_RATE);
    const ow = other.subarray(oi0, Math.round((s + win) * SYNC_RATE));
    const rw = ref.subarray(ri0, Math.round(r1 * SYNC_RATE));
    const w = crossCorrelateOffset(rw, ow, SYNC_RATE, { maxLagSec: 2 * margin });
    if (w.confidence < 0.2) continue;
    // An event at rw time τ is at ow time τ + w → absolute offset = (oi0 − ri0) / rate + w.
    windows.push({ atSec: s + win / 2, offsetSec: (oi0 - ri0) / SYNC_RATE + w.offsetSec, confidence: w.confidence });
  }
  result.windows = windows;
  if (windows.length >= 3) {
    // Fit offset against ref time so the slope is exactly drift − 1.
    const fit = robustLine(windows.map((w) => ({ x: w.atSec - w.offsetSec, y: w.offsetSec })), 2 / SYNC_RATE + 0.004);
    if (fit && fit.inliers >= 3) {
      result.drift = 1 + fit.b;
      result.offsetSec = fit.a;
    }
  }
  return result;
}

