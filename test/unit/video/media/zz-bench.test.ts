import { describe, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Segment } from '@video/core';
import { applyOp, applyOps, compile, emptyTimeline } from '@video/core';
import { cpuCount, executeRenderPlan, probe } from '@video/media';
import { ff } from './helpers.js';
const D = { by: 'agent' as const, reason: 'bench' };

/**
 * Render benchmark on a synthetic 20-minute 1080p30 timeline (120 segments, all layouts, zoom, BGM). Never part of
 * `pnpm test` / CI: run with `FERRET_VIDEO_BENCH=1 npx vitest run test/unit/video/media/zz-bench.test.ts`.
 * Files and log.txt go to FERRET_VIDEO_BENCH_DIR (default <tmp>/ferret-video-bench); the 1.2 GB source is reused across runs.
 * FERRET_VIDEO_BENCH_FINAL=0 skips the final render (the slow part) when only the preview edit loop matters.
 */
const ENABLED = process.env.FERRET_VIDEO_BENCH === '1';
const dir = process.env.FERRET_VIDEO_BENCH_DIR?.trim() || join(tmpdir(), 'ferret-video-bench');
const log = (m: string) => {
  console.log(m);
  appendFileSync(join(dir, 'log.txt'), m + '\n');
};

describe.skipIf(!ENABLED)('render benchmark (FERRET_VIDEO_BENCH=1 to run)', () => {
it('20-minute 1080p timeline: preview x264 / hardware, 1 edit, final', async () => {
  mkdirSync(dir, { recursive: true });
  const p = (n: string) => join(dir, n);
  let t0 = Date.now();
  if (!existsSync(p('src.mp4'))) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=1200', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=1200', '-c:v', 'h264_videotoolbox', '-b:v', '8M', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('src.mp4')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*330*t)':s=48000:d=60", p('bgm.wav')]);
    log('generate source: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  }
  const e = emptyTimeline({ title: 'bench', kind: 'tech', template: { id: 'tech', version: '1' }, canvas: { width: 1920, height: 1080, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'] });
  const layouts: Segment['video'][] = [
    { layout: 'camera-full', camera: 'cam' },
    { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'ring-gradient' } },
    { layout: 'split-v', top: 'scr', bottom: 'cam' },
    { layout: 'screen-full', screen: 'scr' },
  ];
  const segs: Segment[] = Array.from({ length: 120 }, (_, i) => ({ id: 'seg_' + i, range: { start: 0, end: 0 }, src: { from: i * 300, to: i * 300 + 300, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video: layouts[i % 4]!, decided: D, ...(i % 4 === 3 ? { zoom: [{ at: 0, value: { scale: 1.3, focus: 'cursor' as const } }] } : {}) }));
  let t = applyOps({ ...e, sources: {
    cam: { kind: 'camera', path: 'src.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0 },
    scr: { kind: 'screen', path: 'src.mp4', take: 'take_1', display: 'm', fps: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, offset: 0, audio: false },
    music: { kind: 'asset', path: 'bgm.wav', assetId: 'bgm', license: { id: 'CC0-1.0' } } } } as any, [
    { op: 'setSegments', segments: segs },
    { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 36000 }, gainDb: -20, duckDb: -10, fadeIn: 30, fadeOut: 60, decided: D }] },
  ]).timeline;
  log('cpus: ' + cpuCount());
  const run = async (label: string, quality: 'preview' | 'final', cache: string, encoder?: 'x264' | 'auto') => {
    const t1 = Date.now();
    const plan = compile(t, quality === 'final' ? { quality, target: 'youtube', projectDir: dir } : { quality, projectDir: dir });
    const r = await executeRenderPlan(plan, { projectDir: dir, cacheDir: cache, output: 'out/' + label + '.mp4', ...(encoder ? { encoder } : {}) });
    const sec = (Date.now() - t1) / 1000;
    const pr = await probe(r.output);
    log(label + ': ' + sec.toFixed(1) + ' s (' + (1200 / sec).toFixed(1) + 'x realtime) encoder=' + r.encoder + ' reused=' + r.reused + ' rendered=' + r.rendered + ' dur=' + pr.durationSec.toFixed(2));
  };
  await run('preview-x264', 'preview', 'cache-px', 'x264');
  await run('preview-hw', 'preview', 'cache-ph', 'auto');
  t = applyOp(t, { op: 'trimSegment', id: 'seg_50', to: 50 * 300 + 200, decided: D }).timeline;
  await run('preview-hw-after-1-edit', 'preview', 'cache-ph', 'auto');
  t = applyOp(t, { op: 'trimSegment', id: 'seg_90', to: 90 * 300 + 150, decided: D }).timeline;
  await run('preview-hw-after-2nd-edit', 'preview', 'cache-ph', 'auto');
  if (process.env.FERRET_VIDEO_BENCH_FINAL !== '0') await run('final-x264', 'final', 'cache-f');
}, 7_200_000);
});
