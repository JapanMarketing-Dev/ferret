import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decided, Timeline } from '@video/core';
import { applyOps, compile, emptyTimeline, layoutAt } from '@video/core';
import { executeRenderPlan } from '@video/media';
import { SAMPLE_SLOTS } from '../core/pattern-samples.js';
import { countFrames, ff, FFMPEG_MAJOR, frameLuma, HAVE_LIBASS, maxLuma, regionLuma, tempDir } from './helpers.js';

const D: Decided = { by: 'agent', reason: 'test' };
const IDS = Object.keys(SAMPLE_SLOTS);
const SCENE = 60; // frames per scene (2 s)

// Pixel checks are relative to the measured background and the video underneath, so they hold across fonts and
// ffmpeg/libass versions. Very old ffmpeg (< 6) differs in filter behaviour (geq/overlay alpha): skipped.
const OLD_FFMPEG = FFMPEG_MAJOR > 0 && FFMPEG_MAJOR < 6;

describe.skipIf(!HAVE_LIBASS || OLD_FFMPEG)('scene patterns render with libass', () => {
  const { dir, cleanup } = tempDir('scenes');
  const p = (n: string) => join(dir, n);
  let out = '';
  let t: Timeline;
  beforeAll(async () => {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('scr.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=0x30C060:s=320x240:r=30:d=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('cam.mp4')]);
    ff(['-f', 'lavfi', '-i', "color=black:s=200x250,format=rgba,geq=r=255:g=255:b=255:a='255*lt(abs(hypot(X-100,Y-90)-50),4)'", '-frames:v', '1', p('ill.png')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*300*t)':s=48000:d=24", p('mic.wav')]);
    const e = emptyTimeline({ title: 's', kind: 'tech', template: { id: 't', version: '1' }, canvas: { width: 640, height: 360, fps: { num: 30, den: 1 } }, language: 'ja', targets: [] });
    t = applyOps({
      ...e,
      sources: {
        scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'm', fps: { num: 30, den: 1 }, size: { width: 640, height: 360 }, offset: 0, audio: false },
        cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, audio: false },
        mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
        ill: { kind: 'asset', path: 'ill.png', assetId: 'ill', license: { id: 'CC0-1.0' } },
      },
    }, [
      { op: 'addSegment', segment: { id: 'seg_1', range: { start: 0, end: 0 }, src: { from: 0, to: SCENE * IDS.length, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video: { layout: 'screen-full', screen: 'scr' }, decided: D } },
      ...IDS.map((id, i) => ({ op: 'addScene' as const, scene: { id: `scn_${i}`, pattern: { id, version: '1' }, range: { start: i * SCENE, end: (i + 1) * SCENE }, slots: SAMPLE_SLOTS[id]!, decided: D } })),
    ]).timeline;
    const plan = compile(t, { quality: 'preview', projectDir: dir, maxChunkFrames: SCENE });
    expect(plan.warnings).toEqual([]);
    out = (await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'scenes.mp4', concurrency: 4 })).output;
  }, 120_000);
  afterAll(cleanup);

  it('renders every pattern for its full range', () => {
    expect(countFrames(out)).toBe(SCENE * IDS.length);
  });
  for (const [i, id] of IDS.entries()) {
    it(`${id}: shows bright text/shapes`, () => {
      expect(maxLuma(out, i * SCENE + 40)).toBeGreaterThan(200);
    });
  }
  /** Mean luma of the screen video under the scenes at the same frame. */
  const under = (f: number) => frameLuma(p('scr.mp4'), f);
  /** Background luma of a dark pattern: darkest of the four corners (thin waves may cross one). */
  const bg = (f: number) => Math.min(regionLuma(out, f, 0, 0, 8, 8), regionLuma(out, f, 632, 0, 8, 8), regionLuma(out, f, 0, 352, 8, 8), regionLuma(out, f, 632, 352, 8, 8));
  const inner = (r: { x: number; y: number; w: number; h: number }, fx: number, fy: number, fw: number, fh: number) =>
    [Math.round(r.x + r.w * fx), Math.round(r.y + r.h * fy), Math.max(2, Math.round(r.w * fw)), Math.max(2, Math.round(r.h * fh))] as const;

  it('dark-background patterns cover the screen video; cta keeps it visible', () => {
    for (const id of ['title-card', 'quote', 'code-focus']) {
      const f = IDS.indexOf(id) * SCENE + 40;
      expect(frameLuma(out, f), id).toBeLessThan(under(f) * 0.6);
    }
    const f = IDS.indexOf('cta-subscribe') * SCENE + 40;
    expect(frameLuma(out, f)).toBeGreaterThan(under(f) * 0.6);
  });
  it('explain-illust-bubbles: white bubbles, camera in the round wipe, illustration in the centre', () => {
    const f = IDS.indexOf('explain-illust-bubbles') * SCENE + 40;
    const items = layoutAt(t, f);
    const back = bg(f);
    for (const slot of ['bubbleLeft', 'bubbleRight']) {
      const r = items.find((i) => i.slot === slot)!.rect;
      // a strip near the top of the pill, left of centre (away from the text)
      expect(regionLuma(out, f, ...inner(r, 0.3, 0.12, 0.15, 0.06)), slot).toBeGreaterThan(back + 120);
    }
    const w = items.find((i) => i.slot === 'wipe')!.rect;
    expect(Math.abs(regionLuma(out, f, ...inner(w, 0.4, 0.4, 0.2, 0.2)) - back)).toBeGreaterThan(40); // the green camera
    const ill = items.find((i) => i.slot === 'illustration')!.rect;
    expect(ill.x + ill.w / 2).toBeCloseTo(320, -1);
    expect(maxLuma(out, f)).toBeGreaterThan(back + 150); // white line art and bubbles
  });
});
