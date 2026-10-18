import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SFX_CATEGORIES, SFX_RECIPES, analyzeReference, captionBand, detectTransients, ensureBuiltinSfx, parseMomentary, parseSceneTimes, probe, recipesVersion,
  sfxArgs, sfxSidecar,
} from '@video/media';
import { HAVE_FFMPEG, ff, tempDir } from './helpers.js';

describe('built-in sfx recipes (pure)', () => {
  it('seven categories, at least three variants each, unique names', () => {
    expect(SFX_CATEGORIES.sort()).toEqual(['click', 'ding', 'impact', 'pop', 'swoosh-in', 'typing', 'whoosh']);
    for (const c of SFX_CATEGORIES) expect(SFX_RECIPES.filter((r) => r.category === c).length, c).toBeGreaterThanOrEqual(3);
    expect(new Set(SFX_RECIPES.map((r) => r.name)).size).toBe(SFX_RECIPES.length);
  });

  it('short effects stay short; durations are positive', () => {
    for (const r of SFX_RECIPES) {
      expect(r.durationSec).toBeGreaterThan(0);
      if (r.category === 'pop' || r.category === 'click') expect(r.durationSec).toBeLessThanOrEqual(0.2);
      expect(r.durationSec).toBeLessThanOrEqual(2);
    }
  });

  it('deterministic: noise has a fixed seed, no random() in expressions; same recipe → same args', () => {
    for (const r of SFX_RECIPES) {
      expect(r.source).not.toMatch(/random\(/);
      if (r.source.startsWith('anoisesrc')) expect(r.source).toMatch(/seed=\d+/);
      expect(sfxArgs(r, 'o.wav')).toEqual(sfxArgs(r, 'o.wav'));
    }
    expect(recipesVersion()).toBe(recipesVersion([...SFX_RECIPES]));
    expect(recipesVersion(SFX_RECIPES.slice(1))).not.toBe(recipesVersion());
  });

  it('args: 48 kHz mono 16-bit wav of the recipe length, filter only when given', () => {
    const pop = SFX_RECIPES.find((r) => r.category === 'pop')!;
    const a = sfxArgs(pop, 'x.wav');
    expect(a.slice(0, 3)).toEqual(['-f', 'lavfi', '-i']);
    expect(a).not.toContain('-af');
    expect(a.slice(-9)).toEqual(['-t', String(pop.durationSec), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', 'x.wav']);
    expect(sfxArgs(SFX_RECIPES.find((r) => r.category === 'whoosh')!, 'y.wav')).toContain('-af');
  });

  it('sidecar: library id per category, CC0, no author (nothing to credit)', () => {
    const s = sfxSidecar(SFX_RECIPES.find((r) => r.name === 'whoosh-2')!);
    expect(s).toMatchObject({ id: 'sfx_whoosh_builtin_2', kind: 'sfx', category: 'whoosh', license: { spdx: 'CC0-1.0' }, features: { durationMs: 450 } });
    expect(s).not.toHaveProperty('author');
  });

  it('ensureBuiltinSfx writes missing files only, and everything again when the recipes change', async () => {
    const t = tempDir('sfxgen');
    try {
      const calls: string[][] = [];
      const { writeFileSync } = await import('node:fs');
      const run = async (args: string[]) => {
        calls.push(args);
        writeFileSync(args[args.length - 1]!, 'RIFF');
      };
      const recipes = SFX_RECIPES.slice(0, 3);
      expect(await ensureBuiltinSfx(t.dir, { run, recipes })).toHaveLength(3);
      expect(await ensureBuiltinSfx(t.dir, { run, recipes })).toHaveLength(0);
      expect(existsSync(join(t.dir, 'pop', 'pop-1.json'))).toBe(true);
      expect(readFileSync(join(t.dir, '.version'), 'utf8').trim()).toBe(recipesVersion(recipes));
      expect(await ensureBuiltinSfx(t.dir, { run, recipes: SFX_RECIPES.slice(0, 4) })).toHaveLength(4); // version changed
      const fail = async () => {
        throw new Error('boom');
      };
      await expect(ensureBuiltinSfx(join(t.dir, 'other'), { run: fail, recipes })).rejects.toThrow('boom');
    } finally {
      t.cleanup();
    }
  });
});

describe('bench parsers (pure)', () => {
  it('parseSceneTimes reads showinfo pts_time, sorted', () => {
    const log = '[Parsed_showinfo_1 @ 0x1] n:   1 pts:  180 pts_time:6       duration: 1\n[Parsed_showinfo_1 @ 0x1] n:   0 pts:   90 pts_time:3.0333 x\nother line pts_time:9';
    expect(parseSceneTimes(log)).toEqual([3.0333, 6]);
    expect(parseSceneTimes('')).toEqual([]);
  });

  it('parseMomentary: median momentary loudness per whole second; -inf is ignored', () => {
    const log = [
      '[Parsed_ebur128_0 @ 0x] t: 0.1      TARGET:-23 LUFS    M: -inf S: -inf     I: -70.0 LUFS',
      '[Parsed_ebur128_0 @ 0x] t: 0.5      TARGET:-23 LUFS    M: -30.0 S: -inf',
      '[Parsed_ebur128_0 @ 0x] t: 0.9      TARGET:-23 LUFS    M: -20.0 S: -inf',
      '[Parsed_ebur128_0 @ 0x] t: 1.0      TARGET:-23 LUFS    M: -10.0 S: -inf',
      '[Parsed_ebur128_0 @ 0x] t: 1.4      TARGET:-23 LUFS    M: -inf S: -inf',
    ].join('\n');
    const m = parseMomentary(log);
    expect(m.get(0)).toBe(-20); // median of -30, -20, -10 (t=1.0 still belongs to second 0)
    expect(m.size).toBe(2);
    expect(m.get(1)).toBe(-70); // only -inf
  });

  it('detectTransients: a click on a quiet bed is found; a slow swell is not; gap between hits', () => {
    const sr = 16000;
    const x = new Float32Array(sr * 3);
    for (let i = 0; i < x.length; i++) x[i] = 0.002 * Math.sin(i * 0.37);
    const click = (at: number) => {
      for (let i = 0; i < 400; i++) x[Math.round(at * sr) + i] = 0.8 * Math.sin(i * 0.9) * Math.exp(-i / 80);
    };
    click(1);
    click(1.1); // too close: merged
    click(2.2);
    const t = detectTransients(x, sr);
    expect(t.length).toBe(2);
    expect(t[0]).toBeCloseTo(1, 1);
    expect(t[1]).toBeCloseTo(2.2, 1);
    const swell = new Float32Array(sr * 2).map((_, i) => 0.5 * (i / (sr * 2)) * Math.sin(i * 0.3));
    expect(detectTransients(swell, sr)).toEqual([]);
    expect(detectTransients(new Float32Array(10), sr)).toEqual([]);
  });

  it('captionBand: white text with dark outline in the lower part → band; flat frames or top-middle text → none', () => {
    const W = 160;
    const H = 90;
    const frame = (rows: [number, number][]) => {
      const px = new Uint8Array(W * H).fill(100);
      for (const [a, b] of rows) for (let y = a; y < b; y++) for (let x = 30; x < 130; x++) px[y * W + x] = Math.floor(x / 3) % 2 ? 250 : 20;
      return px;
    };
    const one = captionBand(frame([[76, 84]]), W, H)!;
    expect(one.lines).toBe(1);
    expect(one.y).toBeCloseTo(76 / 90, 2);
    expect(one.h).toBeCloseTo(8 / 90, 2);
    expect(captionBand(frame([[66, 73], [76, 83]]), W, H)!.lines).toBe(2);
    expect(captionBand(frame([]), W, H)).toBeNull();
    expect(captionBand(frame([[35, 45]]), W, H)).toBeNull(); // the middle of the frame is not a caption band
    expect(captionBand(new Uint8Array(10), W, H)).toBeNull();
  });
});

describe.skipIf(!HAVE_FFMPEG)('ffmpeg: generated sfx and a reference video', () => {
  const t = tempDir('bench');
  const video = join(t.dir, 'ref.mp4');
  beforeAll(() => {
    // 9 s: three flat shots (cuts at 3 s and 6 s), a striped "caption" band near the bottom, clicks at 1.5 s and 4.5 s
    ff(['-f', 'lavfi', '-i', 'color=c=0x404040:s=320x180:r=30:d=9',
      '-f', 'lavfi', '-i', "aevalsrc='0.003*sin(2*PI*200*t)+0.8*sin(2*PI*1500*t)*exp(-(t-1.5)*60)*gte(t,1.5)+0.8*sin(2*PI*1500*t)*exp(-(t-4.5)*60)*gte(t,4.5)':s=48000:d=9",
      '-vf', "geq=lum='if(between(Y,H*0.82,H*0.9)*between(X,W*0.2,W*0.8),255*mod(floor(X/4),2),if(lt(T,3),40,if(lt(T,6),150,240)))':cb=128:cr=128",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  }, 60_000);
  afterAll(() => t.cleanup());

  it('ensureBuiltinSfx makes real, audible wav files once', async () => {
    const dir = join(t.dir, 'sfx');
    const written = await ensureBuiltinSfx(dir);
    expect(written).toHaveLength(SFX_RECIPES.length);
    for (const r of SFX_RECIPES) {
      const f = join(dir, r.category, `${r.name}.wav`);
      const p = await probe(f);
      expect(p.durationSec).toBeCloseTo(r.durationSec, 1);
      expect(p.streams[0]).toMatchObject({ type: 'audio', sampleRate: 48000 });
      expect(statSync(f).size).toBeGreaterThan(1000);
    }
    expect(await ensureBuiltinSfx(dir)).toHaveLength(0);
  }, 120_000);

  it('analyzeReference: cuts, transients, caption band and loudness per second', async () => {
    const r = await analyzeReference(video);
    expect(r.samples).toHaveLength(9);
    const cuts = r.samples.flatMap((s) => s.cutTimes);
    expect(cuts.map(Math.round)).toEqual([3, 6]);
    const onsets = r.samples.flatMap((s) => s.sfxOnsets);
    expect(onsets.length).toBe(2);
    expect(onsets[0]).toBeCloseTo(1.5, 0);
    expect(r.samples.filter((s) => s.captionBoxes.length).length).toBeGreaterThanOrEqual(8);
    const box = r.samples[0]!.captionBoxes[0]!;
    expect(box.y).toBeGreaterThan(0.75);
    expect(box.y).toBeLessThan(0.9);
    expect(r.samples.every((s) => s.loudness <= 0)).toBe(true);
    // a range
    const part = await analyzeReference(video, { fromSec: 2, toSec: 5 });
    expect(part.samples).toHaveLength(3);
    expect(part.samples.flatMap((s) => s.cutTimes).map(Math.round)).toEqual([1]);
    await expect(analyzeReference(video, { fromSec: 8.5 })).rejects.toThrow(/shorter than 1 s/);
  }, 120_000);
});
