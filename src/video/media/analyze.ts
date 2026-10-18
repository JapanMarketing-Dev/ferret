import { probe } from './probe.js';
import { ffmpegStderr, MediaError } from './run.js';

export interface TimeRange {
  start: number;
  end: number;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)`;

/** Pair "start" and "end" events in log order; an unterminated start ends at `durationSec`. */
function pairEvents(log: string, startRe: RegExp, endRe: RegExp, durationSec: number | null): TimeRange[] {
  const events: { at: number; pos: number; kind: 's' | 'e' }[] = [];
  for (const m of log.matchAll(startRe)) events.push({ at: Number(m[1]), pos: m.index, kind: 's' });
  for (const m of log.matchAll(endRe)) events.push({ at: Number(m[1]), pos: m.index, kind: 'e' });
  events.sort((a, b) => a.pos - b.pos);
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === 's') open = Math.max(0, e.at);
    else if (open !== null) {
      if (e.at > open) out.push({ start: open, end: e.at });
      open = null;
    }
  }
  if (open !== null && durationSec !== null && durationSec > open) out.push({ start: open, end: durationSec });
  return out;
}

export function parseSilenceLog(log: string, durationSec: number | null): TimeRange[] {
  return pairEvents(log, new RegExp(`silence_start: ${NUM}`, 'g'), new RegExp(`silence_end: ${NUM}`, 'g'), durationSec);
}

export function parseBlackLog(log: string): TimeRange[] {
  const out: TimeRange[] = [];
  for (const m of log.matchAll(new RegExp(`black_start:\\s*${NUM}\\s+black_end:\\s*${NUM}`, 'g'))) {
    out.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return out;
}

export function parseFreezeLog(log: string, durationSec: number | null): TimeRange[] {
  return pairEvents(log, new RegExp(`freeze_start: ${NUM}`, 'g'), new RegExp(`freeze_end: ${NUM}`, 'g'), durationSec);
}

/** Parse the JSON block printed by `loudnorm=print_format=json`. "-inf" values become -Infinity. */
export function parseLoudnormLog(log: string): { integrated: number; truePeak: number; lra: number; threshold: number; offset: number } {
  const start = log.lastIndexOf('"input_i"');
  if (start < 0) throw new MediaError('loudnorm did not print a measurement');
  const open = log.lastIndexOf('{', start);
  const close = log.indexOf('}', start);
  if (open < 0 || close < 0) throw new MediaError('loudnorm output is incomplete');
  const raw = JSON.parse(log.slice(open, close + 1)) as Record<string, string>;
  const n = (k: string): number => {
    const v = raw[k];
    if (v === undefined) throw new MediaError(`loudnorm output lacks ${k}`);
    if (/^-inf/i.test(v)) return Number.NEGATIVE_INFINITY;
    if (/^\+?inf/i.test(v)) return Number.POSITIVE_INFINITY;
    const x = Number(v);
    if (!Number.isFinite(x)) throw new MediaError(`loudnorm value ${k} is not a number: ${v}`);
    return x;
  };
  const offset = raw.target_offset === undefined ? 0 : n('target_offset');
  return { integrated: n('input_i'), truePeak: n('input_tp'), lra: n('input_lra'), threshold: n('input_thresh'), offset };
}

async function hasStream(path: string, type: 'audio' | 'video'): Promise<number> {
  const p = await probe(path);
  if (!p.streams.some((s) => s.type === type)) throw new MediaError(`${path} has no ${type} stream`);
  return p.durationSec;
}

/**
 * Second-pass loudnorm filter from a first-pass measurement (linear mode). Falls back to single-pass dynamic loudnorm
 * when the input is silent.
 */
export function measuredLoudnorm(m: { integrated: number; truePeak: number; lra: number; threshold: number; offset: number }, target: { I: number; TP: number; LRA: number }): string {
  const base = `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}`;
  if (![m.integrated, m.truePeak, m.lra, m.threshold, m.offset].every(Number.isFinite)) return base;
  const f = (v: number) => String(Math.round(v * 100) / 100);
  return `${base}:measured_I=${f(m.integrated)}:measured_TP=${f(m.truePeak)}:measured_LRA=${f(m.lra)}:measured_thresh=${f(m.threshold)}:offset=${f(m.offset)}:linear=true`;
}

/** Silent ranges (seconds). Defaults: -35 dB for at least 400 ms. */
export async function detectSilence(path: string, o: { noiseDb?: number; minMs?: number } = {}): Promise<TimeRange[]> {
  const noise = o.noiseDb ?? -35;
  const min = (o.minMs ?? 400) / 1000;
  if (!(min > 0)) throw new RangeError('minMs must be > 0');
  const dur = await hasStream(path, 'audio');
  const log = await ffmpegStderr(['-i', path, '-vn', '-sn', '-af', `silencedetect=noise=${noise}dB:d=${min}`, '-f', 'null', '-']);
  return parseSilenceLog(log, dur);
}

/** Integrated loudness (LUFS), true peak (dBTP) and loudness range (LU) of the first audio stream. */
export async function measureLoudness(path: string): Promise<{ integrated: number; truePeak: number; lra: number }> {
  await hasStream(path, 'audio');
  const log = await ffmpegStderr(['-i', path, '-vn', '-sn', '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  const r = parseLoudnormLog(log);
  return { integrated: r.integrated, truePeak: r.truePeak, lra: r.lra };
}

/** Black ranges (seconds), at least `minSec` long (default 0.1 s). */
export async function detectBlack(path: string, o: { minSec?: number; pixelThreshold?: number } = {}): Promise<TimeRange[]> {
  await hasStream(path, 'video');
  const d = o.minSec ?? 0.1;
  const log = await ffmpegStderr(['-i', path, '-an', '-sn', '-vf', `blackdetect=d=${d}:pix_th=${o.pixelThreshold ?? 0.1}`, '-f', 'null', '-']);
  return parseBlackLog(log);
}

/** Frozen ranges (seconds), at least `minSec` long (default 2 s). */
export async function detectFreeze(path: string, o: { minSec?: number; noiseDb?: number } = {}): Promise<TimeRange[]> {
  const dur = await hasStream(path, 'video');
  const d = o.minSec ?? 2;
  const log = await ffmpegStderr(['-i', path, '-an', '-sn', '-vf', `freezedetect=n=${o.noiseDb ?? -60}dB:d=${d}`, '-f', 'null', '-']);
  return parseFreezeLog(log, dur);
}
