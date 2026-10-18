import type { Frame, Rational } from './schema.js';

export function fpsValue(fps: Rational): number {
  return fps.num / fps.den;
}

/** Nominal integer rate used for timecode labels (29.97 → 30). */
export function nominalFps(fps: Rational): number {
  return Math.max(1, Math.round(fps.num / fps.den));
}

export function frameToSeconds(f: number, fps: Rational): number {
  return (f * fps.den) / fps.num;
}

export function secondsToFrame(sec: number, fps: Rational): Frame {
  // Small epsilon so 1.0000000001 * 30 does not round down after float noise.
  return Math.round((sec * fps.num) / fps.den + 1e-9);
}

/** Convert a frame count between two rates (rounded to the nearest frame). */
export function convertFrames(f: number, from: Rational, to: Rational): number {
  // f * (to.num/to.den) / (from.num/from.den), done in integers where possible.
  const n = f * to.num * from.den;
  const d = to.den * from.num;
  return Math.round(n / d + 1e-9);
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** "HH:MM:SS:FF" (non-drop, nominal rate). */
export function frameToTimecode(f: Frame, fps: Rational): string {
  if (!Number.isFinite(f) || !Number.isInteger(f) || f < 0) throw new RangeError(`frame must be a non-negative integer: ${f}`);
  const r = nominalFps(fps);
  const ff = f % r;
  const totalSec = Math.floor(f / r);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/** "MM:SS.mmm" style label for humans (real seconds). */
export function frameToClock(f: Frame, fps: Rational): string {
  const sec = frameToSeconds(f, fps);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${pad(m)}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * Parse a time into a timeline frame.
 * - "HH:MM:SS:FF" (or ";" before FF): non-drop timecode at the nominal rate
 * - "HH:MM:SS(.sss)", "MM:SS(.sss)": clock time in real seconds
 * - "SS(.sss)" or "12.5s": seconds
 * - "123f": frame number
 */
export function timecodeToFrame(tc: string, fps: Rational): Frame {
  const s = tc.trim();
  if (s === '') throw new SyntaxError('empty timecode');
  let m = /^(\d+)f$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d+):(\d{1,2}):(\d{1,2})[:;](\d{1,3})$/.exec(s);
  if (m) {
    const [h, mi, se, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const r = nominalFps(fps);
    if (mi >= 60 || se >= 60) throw new SyntaxError(`invalid timecode: ${tc}`);
    if (ff >= r) throw new SyntaxError(`frame field ${ff} out of range for ${r} fps: ${tc}`);
    return ((h * 60 + mi) * 60 + se) * r + ff;
  }
  m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (m) {
    const h = m[1] ? Number(m[1]) : 0;
    const mi = Number(m[2]);
    const se = Number(m[3]);
    if (m[1] !== undefined && mi >= 60) throw new SyntaxError(`invalid time: ${tc}`);
    if (se >= 60) throw new SyntaxError(`invalid time: ${tc}`);
    return secondsToFrame(h * 3600 + mi * 60 + se, fps);
  }
  m = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  if (m) return secondsToFrame(Number(m[1]), fps);
  throw new SyntaxError(`unrecognized time: ${tc}`);
}

/** Parse "A-B" (either side any format accepted by timecodeToFrame). */
export function parseFrameRange(spec: string, fps: Rational): [Frame, Frame] {
  // Split on a dash that is not part of a number sign; times never contain '-'.
  const parts = spec.split('-');
  if (parts.length !== 2) throw new SyntaxError(`range must be "start-end": ${spec}`);
  const a = timecodeToFrame(parts[0]!, fps);
  const b = timecodeToFrame(parts[1]!, fps);
  if (b < a) throw new RangeError(`range end before start: ${spec}`);
  return [a, b];
}
