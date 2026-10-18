import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffFilterValue } from '@video/core';
import {
  detectBlack, detectFreeze, detectSilence, extractAudioPcm, extractFrame, FfmpegError, makeCfrProxy, measureLoudness, MediaError,
  probe, runFfmpeg, runMachineChecks,
} from '@video/media';
import { countFrames, ff, HAVE_FFMPEG, tempDir } from './helpers.js';

describe.skipIf(!HAVE_FFMPEG)('ffmpeg tools', () => {
  const { dir, cleanup } = tempDir('tools');
  const p = (n: string) => join(dir, n);
  beforeAll(() => {
    // 3 s 320x240@30 with a 440 Hz tone
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('av.mp4')]);
    // tone 1 s, silence 1.5 s, tone 1 s, silence 0.6 s
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)*(lt(t,1)+between(t,2.5,3.5))':s=48000:d=4.1", p('gaps.wav')]);
    // video: pattern 1 s, black 1.5 s, pattern 1 s
    ff(['-filter_complex', 'testsrc2=s=160x120:r=30:d=1[a];color=black:s=160x120:r=30:d=1.5[b];testsrc2=s=160x120:r=30:d=1[c];[a][b][c]concat=n=3[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('black.mp4')]);
    // video: moving 1 s, frozen 3 s, moving 1 s
    ff(['-filter_complex', 'testsrc2=s=160x120:r=30:d=1,tpad=stop_mode=clone:stop_duration=3[a];testsrc2=s=160x120:r=30:d=1[b];[a][b]concat=n=2[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('freeze.mp4')]);
    // 1 kHz sine at amplitude 0.1 (≈ -20 dBFS peak) for 5 s
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*1000*t)':s=48000:d=5", p('tone.wav')]);
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', p('silence.wav')]);
    writeFileSync(p('junk.mp4'), 'not a video');
  });
  afterAll(cleanup);

  it('probe reads streams, fps and duration', async () => {
    const r = await probe(p('av.mp4'));
    expect(r.durationSec).toBeCloseTo(3, 1);
    const v = r.streams.find((s) => s.type === 'video')!;
    expect(v).toMatchObject({ codec: 'h264', width: 320, height: 240, fps: { num: 30, den: 1 }, vfr: false, pixFmt: 'yuv420p' });
    expect(r.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 1 });
    expect(r.formatName).toContain('mp4');
  });
  it('probe fails clearly on missing and invalid files', async () => {
    await expect(probe(p('nope.mp4'))).rejects.toBeInstanceOf(MediaError);
    await expect(probe(p('junk.mp4'))).rejects.toThrow(/cannot read media/);
  });

  it('runFfmpeg reports progress and errors', async () => {
    const seen: number[] = [];
    await runFfmpeg(['-i', p('av.mp4'), '-f', 'null', '-'], { onProgress: (s) => seen.push(s) });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(2.5);
    const err = await runFfmpeg(['-i', p('nope.mp4'), '-f', 'null', '-']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).code).not.toBe(0);
    expect((err as Error).message).toMatch(/nope\.mp4/);
  });
  it('runFfmpeg can be aborted', async () => {
    const ac = new AbortController();
    const pr = runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30', '-f', 'null', '-'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(pr).rejects.toMatchObject({ name: 'AbortError' });
    const ac2 = new AbortController();
    ac2.abort();
    await expect(runFfmpeg(['-version'], { signal: ac2.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('filter values escaped by core survive real ffmpeg parsing (movie= with odd characters)', async () => {
    const odd = join(dir, "we'ird, [name]; a:b.mp4");
    ff(['-i', p('av.mp4'), '-c', 'copy', odd]);
    const out = p('movie-out.mp4');
    await runFfmpeg(['-filter_complex', `movie=filename=${ffFilterValue(odd)},trim=end_frame=5[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', out]);
    expect(countFrames(out)).toBe(5);
  });

  it('detectSilence finds the gaps (including a trailing one)', async () => {
    const r = await detectSilence(p('gaps.wav'), { noiseDb: -40, minMs: 300 });
    expect(r).toHaveLength(2);
    expect(r[0]!.start).toBeCloseTo(1, 1);
    expect(r[0]!.end).toBeCloseTo(2.5, 1);
    expect(r[1]!.start).toBeCloseTo(3.5, 1);
    expect(r[1]!.end).toBeCloseTo(4.1, 1);
    // minimum duration filters the short trailing gap
    expect(await detectSilence(p('gaps.wav'), { noiseDb: -40, minMs: 1000 })).toHaveLength(1);
    expect(await detectSilence(p('tone.wav'))).toEqual([]);
    await expect(detectSilence(p('black.mp4'))).rejects.toThrow(/no audio stream/);
    await expect(detectSilence(p('gaps.wav'), { minMs: 0 })).rejects.toThrow(RangeError);
  });
  it('detectBlack', async () => {
    const r = await detectBlack(p('black.mp4'), { minSec: 0.5 });
    expect(r).toHaveLength(1);
    expect(r[0]!.start).toBeCloseTo(1, 1);
    expect(r[0]!.end).toBeCloseTo(2.5, 1);
    expect(await detectBlack(p('black.mp4'), { minSec: 2 })).toEqual([]);
    await expect(detectBlack(p('tone.wav'))).rejects.toThrow(/no video stream/);
  });
  it('detectFreeze', async () => {
    const r = await detectFreeze(p('freeze.mp4'), { minSec: 1 });
    expect(r).toHaveLength(1);
    expect(r[0]!.start).toBeGreaterThan(0.9);
    expect(r[0]!.start).toBeLessThan(1.3);
    expect(r[0]!.end).toBeCloseTo(4, 0);
    expect(await detectFreeze(p('freeze.mp4'), { minSec: 3.5 })).toEqual([]);
  });
  it('measureLoudness of a known tone and of silence', async () => {
    const r = await measureLoudness(p('tone.wav'));
    expect(r.integrated).toBeGreaterThan(-25);
    expect(r.integrated).toBeLessThan(-21);
    expect(r.truePeak).toBeCloseTo(-20, 0);
    const s = await measureLoudness(p('silence.wav'));
    expect(s.integrated).toBeLessThan(-69);
  });

  it('extractAudioPcm decodes mono float PCM with offsets', async () => {
    const all = await extractAudioPcm(p('gaps.wav'), { sampleRate: 8000, mono: true });
    expect(all.length).toBeGreaterThan(8000 * 4.05);
    expect(all.length).toBeLessThan(8000 * 4.15);
    const part = await extractAudioPcm(p('gaps.wav'), { sampleRate: 8000, mono: true, fromSec: 1.2, durSec: 1 });
    expect(part.length).toBe(8000);
    expect(Math.max(...part.map(Math.abs))).toBeLessThan(0.01); // inside the silent gap
    const tone = await extractAudioPcm(p('gaps.wav'), { sampleRate: 8000, mono: true, durSec: 0.5 });
    expect(Math.max(...tone)).toBeGreaterThan(0.45);
    await expect(extractAudioPcm(p('black.mp4'), { sampleRate: 8000, mono: true })).rejects.toThrow(/no audio stream/);
    await expect(extractAudioPcm(p('gaps.wav'), { sampleRate: 10, mono: true })).rejects.toThrow(RangeError);
    await expect(extractAudioPcm(p('gaps.wav'), { sampleRate: 8000, mono: true, durSec: 0 })).rejects.toThrow(RangeError);
  });

  it('makeCfrProxy makes a CFR proxy at the requested rate and height', async () => {
    const out = p('proxies/av-proxy.mp4');
    await makeCfrProxy(p('av.mp4'), out, { fps: { num: 25, den: 1 }, height: 120 });
    const r = await probe(out);
    expect(r.streams.find((s) => s.type === 'video')).toMatchObject({ width: 160, height: 120, fps: { num: 25, den: 1 } });
    expect(r.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', sampleRate: 48000 });
    expect(countFrames(out)).toBe(75);
    // no temp files left behind
    expect(readdirSync(p('proxies')).filter((f) => f.includes('.tmp-'))).toEqual([]);
    // video-only input still works (audio map is optional)
    await makeCfrProxy(p('black.mp4'), p('proxies/black.mp4'), { fps: { num: 30, den: 1 } });
    expect((await probe(p('proxies/black.mp4'))).streams.some((s) => s.type === 'audio')).toBe(false);
    await expect(makeCfrProxy(p('nope.mp4'), p('proxies/x.mp4'), { fps: { num: 30, den: 1 } })).rejects.toBeInstanceOf(FfmpegError);
    expect(existsSync(p('proxies/x.mp4'))).toBe(false);
  });

  it('extractFrame writes an image; past the end fails', async () => {
    await extractFrame(p('av.mp4'), 1.5, p('f.png'), { width: 100 });
    const r = await probe(p('f.png'));
    expect(r.streams[0]).toMatchObject({ width: 100, height: 76 });
    await expect(extractFrame(p('av.mp4'), 99, p('late.png'))).rejects.toBeInstanceOf(MediaError);
    expect(existsSync(p('late.png'))).toBe(false);
    await expect(extractFrame(p('av.mp4'), -1, p('neg.png'))).rejects.toThrow(RangeError);
  });

  it('runMachineChecks flags black frames and spec problems', async () => {
    // black.mp4 has black frames and no audio
    const f = await runMachineChecks(p('black.mp4'), { target: 'tiktok' });
    const by = Object.fromEntries(f.map((x) => [x.check, x]));
    expect(by['black-frames']!.status).toBe('needs-human');
    expect(by['black-frames']!.ranges![0]!.start).toBeCloseTo(1, 1);
    expect(by.freeze!.status).toBe('pass'); // the 1.5 s black part is shorter than the 2 s freeze minimum
    expect(by.loudness).toMatchObject({ status: 'fail', note: 'no audio stream' });
    expect(by.spec!.status).toBe('fail');
    expect(by.spec!.note).toMatch(/160x120 \(expected 1080x1920\)/);
    const g = await runMachineChecks(p('av.mp4'));
    const gy = Object.fromEntries(g.map((x) => [x.check, x]));
    expect(gy['black-frames']!.status).toBe('pass');
    expect(gy.freeze!.status).toBe('pass');
    expect(gy.loudness!.status).toBe('fail'); // the test tone is not at -14 LUFS
    expect(gy.spec!.note).toMatch(/1 audio channels/);
  });
});

describe.skipIf(!HAVE_FFMPEG)('detectHwEncoder', () => {
  it('honours FERRET_VIDEO_HWENC, probes once and caches on disk', async () => {
    const { detectHwEncoder, resetHwEncoderCache } = await import('@video/media');
    const saved = { enc: process.env.FERRET_VIDEO_HWENC, home: process.env.FERRET_VIDEO_HOME };
    const { dir, cleanup } = tempDir('hwenc');
    try {
      process.env.FERRET_VIDEO_HWENC = 'off';
      expect(await detectHwEncoder()).toBeNull();
      process.env.FERRET_VIDEO_HWENC = 'h264_nvenc';
      expect(await detectHwEncoder()).toBe('h264_nvenc');
      delete process.env.FERRET_VIDEO_HWENC;
      process.env.FERRET_VIDEO_HOME = dir;
      resetHwEncoderCache();
      const first = await detectHwEncoder({ refresh: true });
      expect(first === null || ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(first)).toBe(true);
      if (process.platform === 'darwin') expect(first).toBe('h264_videotoolbox');
      const { readFileSync } = await import('node:fs');
      expect(Object.values(JSON.parse(readFileSync(join(dir, 'cache', 'hwenc.json'), 'utf8')))).toEqual([first]);
      resetHwEncoderCache();
      expect(await detectHwEncoder()).toBe(first); // from the disk cache
      expect(await detectHwEncoder({ platform: 'aix' as NodeJS.Platform, refresh: true })).toBeNull(); // no candidates
    } finally {
      if (saved.enc === undefined) delete process.env.FERRET_VIDEO_HWENC; else process.env.FERRET_VIDEO_HWENC = saved.enc;
      if (saved.home === undefined) delete process.env.FERRET_VIDEO_HOME; else process.env.FERRET_VIDEO_HOME = saved.home;
      resetHwEncoderCache();
      cleanup();
    }
  });
});
