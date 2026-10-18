import type { Rational } from '@video/core';
import { ffprobeJson, MediaError } from './run.js';

export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data';
  codec: string;
  width?: number;
  height?: number;
  fps?: Rational;
  sampleRate?: number;
  channels?: number;
  /** Variable frame rate suspected (r_frame_rate and avg_frame_rate disagree by more than 1%). */
  vfr?: boolean;
  pixFmt?: string;
  profile?: string;
  bitRate?: number;
  durationSec?: number;
}

export interface ProbeResult {
  durationSec: number;
  streams: ProbeStream[];
  timecode?: string;
  formatName: string;
  bitRate?: number;
}

/** "30000/1001" → { num, den } (reduced); null for 0/0 or garbage. */
export function parseRational(s: unknown): Rational | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!num || !den) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

interface RawStream {
  index?: number; codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string;
  avg_frame_rate?: string; sample_rate?: string; channels?: number; pix_fmt?: string; profile?: string; bit_rate?: string;
  duration?: string; tags?: Record<string, string>;
}
interface RawProbe { format?: { duration?: string; format_name?: string; bit_rate?: string; tags?: Record<string, string> }; streams?: RawStream[] }

/** Convert raw ffprobe JSON (-show_format -show_streams) into a ProbeResult. Exported for tests. */
export function parseProbe(raw: unknown): ProbeResult {
  const r = raw as RawProbe;
  if (!r || typeof r !== 'object' || !r.format) throw new MediaError('ffprobe output has no format section');
  const streams: ProbeStream[] = [];
  let timecode = r.format.tags?.timecode;
  let maxStreamDur = 0;
  for (const s of r.streams ?? []) {
    const type = s.codec_type === 'video' || s.codec_type === 'audio' || s.codec_type === 'subtitle' ? s.codec_type : 'data';
    // Cover art is reported as a video stream with an image codec; keep it but it has no fps.
    const out: ProbeStream = { index: s.index ?? streams.length, type, codec: s.codec_name ?? 'unknown' };
    if (type === 'video') {
      if (s.width) out.width = s.width;
      if (s.height) out.height = s.height;
      const rf = parseRational(s.r_frame_rate);
      const af = parseRational(s.avg_frame_rate);
      const fps = af ?? rf;
      if (fps) out.fps = fps;
      if (rf && af) out.vfr = Math.abs(rf.num / rf.den - af.num / af.den) / (rf.num / rf.den) > 0.01;
      if (s.pix_fmt) out.pixFmt = s.pix_fmt;
      if (s.profile) out.profile = s.profile;
      timecode ??= s.tags?.timecode;
    }
    if (type === 'audio') {
      const sr = num(s.sample_rate);
      if (sr) out.sampleRate = sr;
      if (s.channels) out.channels = s.channels;
    }
    const br = num(s.bit_rate);
    if (br) out.bitRate = br;
    const d = num(s.duration);
    if (d !== undefined) {
      out.durationSec = d;
      maxStreamDur = Math.max(maxStreamDur, d);
    }
    streams.push(out);
  }
  const result: ProbeResult = {
    durationSec: num(r.format.duration) ?? maxStreamDur,
    streams,
    formatName: r.format.format_name ?? 'unknown',
  };
  if (timecode) result.timecode = timecode;
  const br = num(r.format.bit_rate);
  if (br) result.bitRate = br;
  return result;
}

export async function probe(path: string): Promise<ProbeResult> {
  const raw = await ffprobeJson(['-show_format', '-show_streams', '-i', path]).catch((e: unknown) => {
    throw new MediaError(`cannot read media: ${path}`, e instanceof Error ? e.message : String(e));
  });
  return parseProbe(raw);
}
