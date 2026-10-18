import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncFiles } from '@video/media';
import { ff, gatedNoiseExpr, HAVE_FFMPEG, tempDir } from './helpers.js';

const FRAME = 1 / 30;

describe.skipIf(!HAVE_FFMPEG)('syncFiles', () => {
  const { dir, cleanup } = tempDir('sync');
  const p = (n: string) => join(dir, n);
  /** other = ref delayed by `off` seconds (negative = other starts later in the event stream), plus independent noise. */
  function makeOther(name: string, off: number, o: { video?: boolean; gain?: number } = {}) {
    const shift = off >= 0
      ? `adelay=delays=${Math.round(off * 48000)}S:all=1`
      : `atrim=start_sample=${Math.round(-off * 48000)},asetpts=PTS-STARTPTS`;
    const graph = `[0:a]${shift},volume=${o.gain ?? 0.6}[s];anoisesrc=r=48000:a=0.01:c=brown:seed=7:d=30[n];[s][n]amix=inputs=2:duration=first:normalize=0[a]`;
    const args = ['-i', p('ref.wav'), '-filter_complex', graph, '-map', '[a]'];
    if (o.video) {
      ff([...args.slice(0, 2), '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=20', '-filter_complex', graph, '-map', '[a]', '-map', '1:v', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', p(name)]);
    } else {
      ff([...args, '-t', '20', p(name)]);
    }
  }
  beforeAll(() => {
    ff(['-f', 'lavfi', '-i', `aevalsrc='${gatedNoiseExpr(0)}':s=48000:d=20`, p('ref.wav')]);
    ff(['-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.5:seed=1:d=20', p('noise1.wav')]);
    ff(['-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.5:seed=2:d=20', p('noise2.wav')]);
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '10', p('silence.wav')]);
  });
  afterAll(cleanup);

  for (const off of [0, FRAME, -FRAME, 2.5, -3.7, 7.25]) {
    it(`recovers an offset of ${off.toFixed(4)} s within one frame`, async () => {
      const name = `other_${String(off).replace(/[.-]/g, '_')}.wav`;
      makeOther(name, off);
      const r = await syncFiles(p('ref.wav'), p(name));
      expect(Math.abs(r.offsetSec - off)).toBeLessThan(FRAME / 2);
      expect(r.confidence).toBeGreaterThan(0.8);
      expect(r.ratio).toBeGreaterThan(3);
      expect(r.method).toBe('xcorr');
      expect(r.drift).toBeUndefined(); // short inputs: no drift estimation
    });
  }

  it('reads the audio track of a video file (AAC, quieter)', async () => {
    makeOther('cam.mp4', 1.2, { video: true, gain: 0.2 });
    const r = await syncFiles(p('ref.wav'), p('cam.mp4'));
    expect(Math.abs(r.offsetSec - 1.2)).toBeLessThan(FRAME / 2);
  });

  it('reports low confidence for unrelated noise and zero for silence', async () => {
    const n = await syncFiles(p('noise1.wav'), p('noise2.wav'));
    expect(n.confidence).toBeLessThan(0.3);
    const s = await syncFiles(p('ref.wav'), p('silence.wav'));
    expect(s.confidence).toBe(0);
  });

  it('fails clearly without audio', async () => {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', p('noaudio.mp4')]);
    await expect(syncFiles(p('ref.wav'), p('noaudio.mp4'))).rejects.toThrow(/no audio stream/);
  });

  it('estimates drift from windowed offsets', async () => {
    // 120 s reference; other runs 0.1% fast (asetrate) and starts 0.5 s late.
    ff(['-f', 'lavfi', '-i', `aevalsrc='${gatedNoiseExpr(3)}':s=48000:d=120`, p('long.wav')]);
    ff(['-i', p('long.wav'), '-af', 'asetrate=48048,aresample=48000,adelay=delays=24000S:all=1', p('long-fast.wav')]);
    const r = await syncFiles(p('long.wav'), p('long-fast.wav'), { driftWindows: true, windowSec: 10 });
    // other time = ref time / 1.001 + 0.5
    expect(r.drift).toBeDefined();
    expect(r.drift!).toBeCloseTo(1 / 1.001, 4);
    expect(Math.abs(r.offsetSec - 0.5)).toBeLessThan(0.01);
    expect(r.windows!.length).toBeGreaterThanOrEqual(10);
  });
});
