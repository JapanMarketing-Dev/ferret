import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  concatLine, crossCorrelateOffset, defaultFontsDir, hwEncodeArgs, killTree, parseEncoders, renderConcurrency, withEncoder, withFontsDir, fft, inputsOf, loudnessFinding, measuredLoudnorm, nextPow2, onsetEnvelope, parseBlackLog, parseFreezeLog,
  parseEbur128Integrated, parseLoudnormLog, parseProbe, parseProgressLine, parseRational, parseSilenceLog, previewGainFilter, robustLine, specFinding, xcorr,
} from '@video/media';
import type { ProbeResult } from '@video/media';

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Gated noise like speech: bursts of noise with an aperiodic on/off pattern. */
function speechLike(n: number, sr: number, seed: number): Float32Array {
  const r = prng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const gate = Math.sin(5.3 * t) + Math.sin(2.17 * t + 1) + Math.sin(11.1 * t + 2) + Math.sin(0.71 * t + 3) > 1.4 ? 1 : 0.03;
    x[i] = (r() * 2 - 1) * gate;
  }
  return x;
}

function shift(x: Float32Array, k: number, len = x.length): Float32Array {
  // y[n] = x[n - k]
  const y = new Float32Array(len);
  for (let n = 0; n < len; n++) {
    const j = n - k;
    y[n] = j >= 0 && j < x.length ? x[j]! : 0;
  }
  return y;
}

describe('fft', () => {
  it('matches a naive DFT and inverts', () => {
    const n = 64;
    const r = prng(1);
    const re = new Float64Array(n).map(() => r() - 0.5);
    const im = new Float64Array(n).map(() => r() - 0.5);
    const [re0, im0] = [re.slice(), im.slice()];
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += re0[t]! * Math.cos(a) - im0[t]! * Math.sin(a);
        si += re0[t]! * Math.sin(a) + im0[t]! * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(re0[i]!, 12);
      expect(im[i]).toBeCloseTo(im0[i]!, 12);
    }
  });
  it('handles trivial sizes and rejects non powers of two', () => {
    const a = new Float64Array([3]);
    const b = new Float64Array([0]);
    fft(a, b);
    expect(a[0]).toBe(3);
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow(RangeError);
    expect(() => fft(new Float64Array(4), new Float64Array(8))).toThrow(RangeError);
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(1024)).toBe(1024);
  });
  it('xcorr equals the naive linear correlation', () => {
    const r = prng(7);
    const a = Array.from({ length: 37 }, () => r() - 0.5);
    const b = Array.from({ length: 23 }, () => r() - 0.5);
    const L = 30;
    const c = xcorr(a, b, L);
    for (let lag = -L; lag <= L; lag++) {
      let s = 0;
      for (let n = 0; n < a.length; n++) {
        const j = n + lag;
        if (j >= 0 && j < b.length) s += a[n]! * b[j]!;
      }
      expect(c[lag + L]).toBeCloseTo(s, 9);
    }
  });
});

describe('crossCorrelateOffset (synthetic)', () => {
  const sr = 8000;
  const ref = speechLike(sr * 20, sr, 42);
  it('recovers sample offsets in both directions', () => {
    for (const k of [0, 1, 7, 267, -267, 8000 * 3 + 13, -(8000 * 4 + 5)]) {
      const r = crossCorrelateOffset(ref, shift(ref, k), sr);
      expect(Math.abs(r.offsetSec - k / sr), `k=${k}`).toBeLessThan(1.5 / sr);
      expect(r.confidence, `k=${k}`).toBeGreaterThan(0.9);
      expect(r.ratio).toBeGreaterThan(3);
      expect(r.correlation).toBeGreaterThan(0.5);
    }
  });
  it('recovers sub-sample offsets roughly (parabolic interpolation)', () => {
    // other = ref at half-sample delay via linear interpolation
    const other = new Float32Array(ref.length);
    for (let i = 1; i < ref.length; i++) other[i] = (ref[i]! + ref[i - 1]!) / 2;
    const r = crossCorrelateOffset(ref, other, sr);
    expect(Math.abs(r.offsetSec * sr - 0.5)).toBeLessThan(0.5);
  });
  it('works when other is a short excerpt and with level differences and noise', () => {
    const k = sr * 6 + 123;
    const r0 = prng(9);
    const excerpt = new Float32Array(sr * 5);
    for (let i = 0; i < excerpt.length; i++) excerpt[i] = 0.2 * ref[i + k]! + 0.01 * (r0() - 0.5);
    // excerpt[i] = ref[i + k] → event at ref time t appears at t − k: offset = −k
    const r = crossCorrelateOffset(ref, excerpt, sr);
    expect(Math.abs(r.offsetSec + k / sr)).toBeLessThan(2 / sr);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  it('gives low confidence for unrelated noise', () => {
    const r = prng(5);
    const a = new Float32Array(sr * 10).map(() => r() - 0.5);
    const b = new Float32Array(sr * 10).map(() => r() - 0.5);
    const res = crossCorrelateOffset(a, b, sr);
    expect(res.confidence).toBeLessThan(0.3);
    expect(res.ratio).toBeLessThan(2);
  });
  it('gives zero confidence for silence and tiny inputs', () => {
    expect(crossCorrelateOffset(new Float32Array(sr), new Float32Array(sr), sr)).toEqual({ offsetSec: 0, confidence: 0, ratio: 0, correlation: 0 });
    expect(crossCorrelateOffset(new Float32Array(1), ref, sr).confidence).toBe(0);
    expect(crossCorrelateOffset(ref, new Float32Array(0), sr).confidence).toBe(0);
    expect(() => crossCorrelateOffset(ref, ref, 0)).toThrow(RangeError);
  });
  it('a periodic signal is ambiguous (low ratio)', () => {
    const p = new Float32Array(sr * 10);
    for (let i = 0; i < p.length; i++) p[i] = (i % 4000) < 400 ? Math.sin(i) : 0; // a click every 0.5 s
    const res = crossCorrelateOffset(p, shift(p, 1234), sr);
    expect(res.ratio).toBeLessThan(1.5);
    expect(res.confidence).toBeLessThan(0.3);
  });
  it('respects maxLagSec', () => {
    const k = sr * 5;
    const res = crossCorrelateOffset(ref, shift(ref, k), sr, { maxLagSec: 2 });
    expect(Math.abs(res.offsetSec - k / sr)).toBeGreaterThan(1);
  });
  it('onsetEnvelope is non-negative and zero for silence', () => {
    const e = onsetEnvelope(ref, sr);
    expect(e.length).toBe(ref.length);
    expect(Math.min(...e.subarray(0, 5000))).toBeGreaterThanOrEqual(0);
    expect(onsetEnvelope(new Float32Array(100), sr).every((v) => v === 0)).toBe(true);
  });
});

describe('robustLine', () => {
  it('fits through outliers', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i * 60, y: 0.5 + 0.0001 * i * 60 }));
    pts[3]!.y += 0.4;
    pts[7]!.y -= 1;
    const f = robustLine(pts, 0.005)!;
    expect(f.inliers).toBe(8);
    expect(f.b).toBeCloseTo(0.0001, 8);
    expect(f.a).toBeCloseTo(0.5, 6);
  });
  it('returns null for degenerate input', () => {
    expect(robustLine([], 1)).toBeNull();
    expect(robustLine([{ x: 1, y: 1 }], 1)).toBeNull();
    expect(robustLine([{ x: 1, y: 1 }, { x: 1, y: 2 }], 0.1)).toBeNull();
  });
});

describe('log parsers', () => {
  it('silence: pairs starts/ends and closes a trailing start at the duration', () => {
    const log = '[silencedetect @ 0x1] silence_start: 1.0005\n[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1.4995\n[silencedetect @ 0x1] silence_start: 3.5\n';
    expect(parseSilenceLog(log, 4.1)).toEqual([{ start: 1.0005, end: 2.5 }, { start: 3.5, end: 4.1 }]);
    expect(parseSilenceLog(log, null)).toEqual([{ start: 1.0005, end: 2.5 }]);
    expect(parseSilenceLog('', 3)).toEqual([]);
    expect(parseSilenceLog('silence_start: -0.01\nsilence_end: 0.6 |', 3)).toEqual([{ start: 0, end: 0.6 }]);
    expect(parseSilenceLog('silence_end: 2 |\nsilence_start: 1e-05\n', 3)).toEqual([{ start: 1e-5, end: 3 }]);
  });
  it('black and freeze', () => {
    expect(parseBlackLog('[blackdetect @ 0x] black_start:1 black_end:2.5 black_duration:1.5\nblack_start:3.2 black_end:4 black_duration:0.8')).toEqual([
      { start: 1, end: 2.5 }, { start: 3.2, end: 4 },
    ]);
    expect(parseFreezeLog('lavfi.freezedetect.freeze_start: 1.03\nlavfi.freezedetect.freeze_duration: 2.9\nlavfi.freezedetect.freeze_end: 3.93\nlavfi.freezedetect.freeze_start: 5', 6)).toEqual([
      { start: 1.03, end: 3.93 }, { start: 5, end: 6 },
    ]);
  });
  it('loudnorm JSON, including -inf', () => {
    const log = 'junk {not json}\n[Parsed_loudnorm_0 @ 0x]\n{\n\t"input_i" : "-23.04",\n\t"input_tp" : "-20.00",\n\t"input_lra" : "0.10",\n\t"input_thresh" : "-33.1"\n}\n';
    expect(parseLoudnormLog(log)).toEqual({ integrated: -23.04, truePeak: -20, lra: 0.1, threshold: -33.1, offset: 0 });
    expect(parseLoudnormLog('{"input_i":"-20","input_tp":"-3","input_lra":"4","input_thresh":"-30","target_offset":"0.42"}').offset).toBe(0.42);
    const silent = '{\n"input_i" : "-inf",\n"input_tp" : "-inf",\n"input_lra" : "0.00",\n"input_thresh" : "-70.00"\n}';
    expect(parseLoudnormLog(silent).integrated).toBe(Number.NEGATIVE_INFINITY);
    expect(() => parseLoudnormLog('nothing here')).toThrow(/did not print/);
    expect(() => parseLoudnormLog('{"input_i" : "abc", "input_tp": "1", "input_lra": "1", "input_thresh": "1"}')).toThrow(/not a number/);
  });
  it('measuredLoudnorm builds a linear second pass, or falls back when silent', () => {
    const t = { I: -14, TP: -1, LRA: 11 };
    expect(measuredLoudnorm({ integrated: -23.041, truePeak: -20, lra: 0.1, threshold: -33.1, offset: 0.333 }, t))
      .toBe('loudnorm=I=-14:TP=-1:LRA=11:measured_I=-23.04:measured_TP=-20:measured_LRA=0.1:measured_thresh=-33.1:offset=0.33:linear=true');
    expect(measuredLoudnorm({ integrated: Number.NEGATIVE_INFINITY, truePeak: Number.NEGATIVE_INFINITY, lra: 0, threshold: -70, offset: 0 }, t)).toBe('loudnorm=I=-14:TP=-1:LRA=11');
  });
  it('progress lines', () => {
    expect(parseProgressLine('out_time_us=1500000')).toBe(1.5);
    expect(parseProgressLine('out_time_ms=2000000')).toBe(2);
    expect(parseProgressLine('out_time=00:01:02.500000')).toBe(62.5);
    expect(parseProgressLine('out_time=-00:00:00.100000')).toBeNull();
    expect(parseProgressLine('out_time_us=N/A')).toBeNull();
    expect(parseProgressLine('progress=end')).toBeNull();
    expect(parseProgressLine('garbage')).toBeNull();
  });
});

describe('probe parsing', () => {
  const raw = {
    format: { duration: '10.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', bit_rate: '1000', tags: {} },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '60/1', avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', tags: { timecode: '01:00:00:00' } },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '10.4' },
      { index: 2, codec_type: 'attachment', codec_name: 'ttf' },
    ],
  };
  it('maps streams, fps, vfr and timecode', () => {
    const p = parseProbe(raw);
    expect(p.durationSec).toBe(10.5);
    expect(p.timecode).toBe('01:00:00:00');
    expect(p.streams[0]).toMatchObject({ type: 'video', codec: 'h264', width: 1920, fps: { num: 30000, den: 1001 }, vfr: true });
    expect(p.streams[1]).toMatchObject({ type: 'audio', sampleRate: 48000, channels: 2, durationSec: 10.4 });
    expect(p.streams[2]!.type).toBe('data');
  });
  it('falls back to stream duration and rejects junk', () => {
    const p = parseProbe({ format: { format_name: 'wav' }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', duration: '3.25' }] });
    expect(p.durationSec).toBe(3.25);
    expect(() => parseProbe({})).toThrow();
    expect(() => parseProbe(null)).toThrow();
  });
  it('parseRational', () => {
    expect(parseRational('30/1')).toEqual({ num: 30, den: 1 });
    expect(parseRational('60000/2002')).toEqual({ num: 30000, den: 1001 });
    expect(parseRational('25')).toEqual({ num: 25, den: 1 });
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational('x')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });
});

describe('findings', () => {
  const base: ProbeResult = {
    durationSec: 30, formatName: 'mov,mp4',
    streams: [
      { index: 0, type: 'video', codec: 'h264', width: 1080, height: 1920, fps: { num: 30, den: 1 }, pixFmt: 'yuv420p', vfr: false },
      { index: 1, type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2 },
    ],
  };
  it('spec passes for a compliant vertical video and fails on each deviation', () => {
    expect(specFinding(base, 'tiktok').status).toBe('pass');
    expect(specFinding(base).status).toBe('pass');
    expect(specFinding({ ...base, durationSec: 181 }, 'youtube-shorts').note).toMatch(/limit of 180/);
    expect(specFinding({ ...base, durationSec: 181 }, 'tiktok').status).toBe('pass');
    const wrong = structuredClone(base);
    wrong.streams[0] = { ...wrong.streams[0]!, codec: 'hevc', width: 720, pixFmt: 'yuv444p' };
    wrong.streams[1] = { ...wrong.streams[1]!, sampleRate: 44100, channels: 1, codec: 'mp3' };
    const f = specFinding(wrong, 'tiktok');
    expect(f.status).toBe('fail');
    expect(f.note).toMatch(/hevc.*yuv444p.*720x1920.*mp3.*44100.*1 audio channels/);
    expect(specFinding({ ...base, streams: [] }).note).toMatch(/no video stream; no audio stream/);
  });
  it('loudness within ±1 LU passes; peaks and silence fail', () => {
    expect(loudnessFinding({ integrated: -14.6, truePeak: -1.2, lra: 5 }).status).toBe('pass');
    expect(loudnessFinding({ integrated: -16, truePeak: -2, lra: 5 }).status).toBe('fail');
    expect(loudnessFinding({ integrated: -14, truePeak: 0.2, lra: 5 }).note).toMatch(/true peak/);
    expect(loudnessFinding({ integrated: Number.NEGATIVE_INFINITY, truePeak: Number.NEGATIVE_INFINITY, lra: 0 })).toMatchObject({ status: 'fail', note: 'audio is silent' });
  });
});

describe('render helpers', () => {
  it('inputsOf and concatLine', () => {
    expect(inputsOf(['-ss', '1', '-i', 'a.mp4', '-loop', '1', '-i', 'b.png', '-map', '[v]'])).toEqual(['a.mp4', 'b.png']);
    expect(inputsOf(['-i'])).toEqual([]);
    expect(concatLine("/tmp/it's here.mp4")).toBe("file '/tmp/it'\\''s here.mp4'");
  });
});

describe('process and font helpers', () => {
  it('killTree falls back when there is no pid or taskkill is unavailable', async () => {
    let calls = 0;
    killTree(undefined, () => calls++);
    expect(calls).toBe(1);
    if (process.platform !== 'win32') {
      await new Promise<void>((resolve) => killTree(999999, () => { calls++; resolve(); }, 'win32')); // no taskkill here → fallback
      expect(calls).toBe(2);
    }
  });
  it('withFontsDir adds fontsdir only where missing', () => {
    const args = ['-i', 'a.mp4', '-filter_complex', '[0:v]setpts=PTS+1/TB,subtitles=filename=a.ass:original_size=1920x1080,subtitles=filename=b.ass:fontsdir=/x:original_size=1920x1080,setpts=PTS-STARTPTS[v]', '-map', '[v]'];
    const out = withFontsDir(args, '/fonts dir');
    expect(out[3]).toBe('[0:v]setpts=PTS+1/TB,subtitles=filename=a.ass:fontsdir=/fonts dir:original_size=1920x1080,subtitles=filename=b.ass:fontsdir=/x:original_size=1920x1080,setpts=PTS-STARTPTS[v]');
    expect(args[3]).not.toContain('/fonts dir'); // not mutated
    expect(withFontsDir(['-i', 'a'], '/f')).toEqual(['-i', 'a']);
    const noSubs = ['-filter_complex', '[0:v]null[v]'];
    expect(withFontsDir(noSubs, '/f')).toBe(noSubs);
  });
  it('defaultFontsDir finds the folder with the font files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ferret-video-fonts-'));
    const saved = { fonts: process.env.FERRET_VIDEO_FONTS, home: process.env.FERRET_VIDEO_HOME };
    try {
      mkdirSync(join(root, 'home', 'tools', 'fonts', 'noto', 'ttf'), { recursive: true });
      writeFileSync(join(root, 'home', 'tools', 'fonts', 'noto', 'ttf', 'NotoSansJP-Bold.ttf'), '');
      writeFileSync(join(root, 'home', 'tools', 'fonts', 'noto', 'ttf', 'NotoSansJP-Black.otf'), '');
      writeFileSync(join(root, 'home', 'tools', 'fonts', 'OFL.txt'), '');
      delete process.env.FERRET_VIDEO_FONTS;
      process.env.FERRET_VIDEO_HOME = join(root, 'home');
      expect(defaultFontsDir()).toBe(join(root, 'home', 'tools', 'fonts', 'noto', 'ttf'));
      process.env.FERRET_VIDEO_FONTS = join(root, 'nope');
      expect(defaultFontsDir()).toBeNull();
      process.env.FERRET_VIDEO_FONTS = join(root, 'home', 'tools', 'fonts', 'noto');
      expect(defaultFontsDir()).toBe(join(root, 'home', 'tools', 'fonts', 'noto', 'ttf'));
      delete process.env.FERRET_VIDEO_FONTS;
      process.env.FERRET_VIDEO_HOME = join(root, 'empty');
      expect(defaultFontsDir()).toBeNull();
    } finally {
      if (saved.fonts === undefined) delete process.env.FERRET_VIDEO_FONTS; else process.env.FERRET_VIDEO_FONTS = saved.fonts;
      if (saved.home === undefined) delete process.env.FERRET_VIDEO_HOME; else process.env.FERRET_VIDEO_HOME = saved.home;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hardware encoders', () => {
  it('parseEncoders reads `ffmpeg -encoders`', () => {
    const text = 'Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n A....D aac                  AAC\n';
    expect([...parseEncoders(text)]).toEqual(['libx264', 'h264_videotoolbox', 'aac']);
  });
  it('withEncoder swaps the x264 block and disables B-frames', () => {
    const args = ['-i', 'a.mp4', '-map', '[v]', '-frames:v', '30', '-r', '30/1', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '28',
      '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '2', '-flags', '+cgop', '-an', '-f', 'mp4', '{out}'];
    const out = withEncoder(args, 'h264_videotoolbox');
    expect(out).toEqual(['-i', 'a.mp4', '-map', '[v]', '-frames:v', '30', '-r', '30/1', ...hwEncodeArgs('h264_videotoolbox'),
      '-g', '30', '-keyint_min', '30', '-bf', '0', '-flags', '+cgop', '-an', '-f', 'mp4', '{out}']);
    expect(withEncoder(['-c:v', 'copy'], 'h264_nvenc')).toEqual(['-c:v', 'copy']);
    for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const) expect(hwEncodeArgs(e).slice(0, 2)).toEqual(['-c:v', e]);
  });
  it('renderConcurrency splits cores between chunks and threads', () => {
    expect(renderConcurrency({ hardware: false, cpus: 14 })).toEqual({ chunks: 4, threads: 4 });
    expect(renderConcurrency({ hardware: false, cpus: 32 })).toEqual({ chunks: 6, threads: 6 });
    expect(renderConcurrency({ hardware: true, cpus: 14 })).toEqual({ chunks: 4, threads: 4 });
    expect(renderConcurrency({ hardware: true, cpus: 32 })).toEqual({ chunks: 4, threads: 8 });
    expect(renderConcurrency({ hardware: false, cpus: 1 })).toEqual({ chunks: 1, threads: 1 });
  });
});

describe('fast preview audio helpers', () => {
  const summary = (i: string) => `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         ${i} LUFS\n    Threshold: -31.8 LUFS\n\n  Loudness range:\n    LRA:         0.0 LU\n`;
  it('parseEbur128Integrated reads the summary, gates silence and rejects garbage', () => {
    expect(parseEbur128Integrated(summary('-21.8'))).toBe(-21.8);
    expect(parseEbur128Integrated(summary('-5'))).toBe(-5);
    expect(parseEbur128Integrated(summary('-70.0'))).toBeNull();
    expect(parseEbur128Integrated(summary('-inf'))).toBeNull();
    expect(parseEbur128Integrated(summary('nan'))).toBeNull();
    expect(parseEbur128Integrated('no summary here')).toBeNull();
    expect(parseEbur128Integrated('')).toBeNull();
    // the last summary wins (several ebur128 instances)
    expect(parseEbur128Integrated(summary('-30') + summary('-18.5'))).toBe(-18.5);
  });
  it('previewGainFilter: duration-weighted energy, silent stems ignored, clamped, limiter at TP', () => {
    expect(previewGainFilter([{ lufs: -20, durationSec: 10 }], { I: -14, TP: -1 })).toBe('volume=6.00dB,alimiter=limit=0.8913:level=0');
    // equal loudness → same gain regardless of split
    expect(previewGainFilter([{ lufs: -20, durationSec: 3 }, { lufs: -20, durationSec: 7 }], { I: -14, TP: -1 })).toContain('volume=6.00dB');
    // a long quiet stem dominates a short loud one
    const g = Number(/volume=(-?[\d.]+)dB/.exec(previewGainFilter([{ lufs: -30, durationSec: 100 }, { lufs: -10, durationSec: 1 }], { I: -14, TP: -1 }))![1]);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(16);
    expect(previewGainFilter([{ lufs: null, durationSec: 5 }, { lufs: -20, durationSec: 5 }], { I: -14, TP: -1 })).toContain('volume=6.00dB');
    expect(previewGainFilter([{ lufs: null, durationSec: 5 }], { I: -14, TP: -1 })).toContain('volume=0.00dB');
    expect(previewGainFilter([], { I: -14, TP: -1 })).toContain('volume=0.00dB');
    expect(previewGainFilter([{ lufs: -20, durationSec: 0 }], { I: -14, TP: -1 })).toContain('volume=0.00dB');
    expect(previewGainFilter([{ lufs: -69, durationSec: 1 }], { I: -14, TP: -1 })).toContain('volume=30.00dB');
    expect(previewGainFilter([{ lufs: 0, durationSec: 1 }], { I: -40, TP: -1 })).toContain('volume=-30.00dB');
    expect(previewGainFilter([], { I: -14, TP: 3 })).toContain('limit=1.0000');
    expect(previewGainFilter([], { I: -14, TP: -40 })).toContain('limit=0.0625');
  });
  it('inputsOf skips lavfi sources', () => {
    expect(inputsOf(['-f', 'lavfi', '-i', 'anullsrc', '-i', 'a.wav', '-f', 'concat', '-safe', '0', '-i', 'list.txt'])).toEqual(['a.wav', 'list.txt']);
  });
});
