import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decided, Segment, Timeline } from '@video/core';
import { applyOp, applyOps, applyTracks, compile, compileFrame, deriveVariant, emptyTimeline, overlaysFromInputLogs, pickHighlights, validateTimeline } from '@video/core';
import { detectHwEncoder, executeRenderPlan, measureLoudness, MediaError, probe, renderFrame } from '@video/media';
import { readdirSync as listDir } from 'node:fs';
import { audioEnvelope, correlation, countFrames, ff, frameLuma, gatedNoiseExpr, HAVE_FFMPEG, HAVE_LIBASS, regionLuma, tempDir } from './helpers.js';

const D: Decided = { by: 'agent', reason: 'test' };

function seg(id: string, from: number, to: number, video: Segment['video'], extra: Partial<Segment> = {}): Segment {
  return { id, range: { start: 0, end: 0 }, src: { from, to, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'explain', video, decided: D, ...extra };
}

describe.skipIf(!HAVE_FFMPEG)('executeRenderPlan', () => {
  const { dir, cleanup } = tempDir('render');
  const p = (n: string) => join(dir, n);
  let base: Timeline;

  beforeAll(() => {
    // camera: flat gray whose luma encodes the frame number (16 + 6·(N mod 37)), 4 s @30, with a tone
    ff(['-f', 'lavfi', '-i', "color=black:s=320x240:r=30:d=4,format=yuv420p,geq=lum='16+6*mod(N,37)':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('cam.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('scr.mp4')]);
    ff(['-f', 'lavfi', '-i', `aevalsrc='0.5*${gatedNoiseExpr(1)}':s=48000:d=4.5`, p('mic.wav')]);
    ff(['-f', 'lavfi', '-i', 'color=red:s=64x64:d=1', '-frames:v', '1', p('logo.png')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)':s=48000:d=1.5", p('bgm.wav')]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1200*t)':s=48000:d=0.2", p('pop.wav')]);
    const e = emptyTimeline({ title: 'r', kind: 'talk', template: { id: 't', version: '1' }, canvas: { width: 320, height: 240, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'] });
    base = applyOps({
      ...e,
      sources: {
        cam: { kind: 'camera', path: 'cam.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, durationFrames: 120 },
        scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'main', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, audio: false },
        mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
        logo: { kind: 'asset', path: 'logo.png', assetId: 'logo', license: { id: 'CC0-1.0' } },
        music: { kind: 'asset', path: 'bgm.wav', assetId: 'bgm', license: { id: 'CC0-1.0' } },
        pop: { kind: 'asset', path: 'pop.wav', assetId: 'pop', license: { id: 'CC0-1.0' } },
      },
      outline: [{ id: 'ch_1', title: 'c', start: 0, end: 60, points: [], importance: 'core' }],
    }, [
      { op: 'addSegment', segment: seg('seg_a', 30, 60, { layout: 'camera-full', camera: 'cam' }) },
      { op: 'addSegment', segment: seg('seg_b', 75, 105, { layout: 'screen-full', screen: 'scr' }) },
    ]).timeline;
  });
  afterAll(cleanup);

  const render = (t: Timeline, out: string, extra: Partial<Parameters<typeof compile>[1]> = {}, conc?: number) => {
    const plan = compile(t, { quality: 'preview', projectDir: dir, ...extra });
    return executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: out, ...(conc ? { concurrency: conc } : {}) });
  };

  it('renders a 2-segment timeline with the right duration, size, streams and exact source frames', async () => {
    const progress: number[] = [];
    const plan = compile(base, { quality: 'preview', projectDir: dir });
    const r = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'out/a.mp4', onProgress: (x) => progress.push(x.done) });
    expect(r).toMatchObject({ output: p('out/a.mp4'), reused: 0, rendered: 2 });
    expect(typeof r.encoder).toBe('string');
    expect(progress.at(-1)).toBe(2);
    const pr = await probe(r.output);
    expect(pr.durationSec).toBeCloseTo(2, 1);
    expect(pr.streams.find((s) => s.type === 'video')).toMatchObject({ codec: 'h264', width: 320, height: 240, fps: { num: 30, den: 1 }, pixFmt: 'yuv420p' });
    expect(pr.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(countFrames(r.output)).toBe(60);
    // frame-accurate cuts: output frame 0 is source frame 30, frame 29 is source frame 59
    const nearest = (lum: number, around: number) => {
      let best = -1;
      let bd = Infinity;
      for (let k = around - 3; k <= around + 3; k++) {
        const d = Math.abs(frameLuma(p('cam.mp4'), k) - lum);
        if (d < bd) [bd, best] = [d, k];
      }
      return best;
    };
    expect(nearest(frameLuma(r.output, 0), 30)).toBe(30);
    expect(nearest(frameLuma(r.output, 29), 59)).toBe(59);
    expect(readdirSync(p('out')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('reuses cached chunks; re-renders only what changed', async () => {
    const again = await render(base, 'out/b.mp4');
    expect(again.reused).toBe(2);
    expect(again.rendered).toBe(0);
    expect(countFrames(again.output)).toBe(60);
    const t = applyOp(base, { op: 'trimSegment', id: 'seg_b', to: 90, decided: D }).timeline;
    const r = await render(t, 'out/c.mp4');
    expect([r.reused, r.rendered]).toEqual([1, 1]);
    expect(countFrames(r.output)).toBe(45);
    // touching an input file invalidates the chunks that read it
    const later = new Date(Date.now() + 5000);
    const { utimesSync } = await import('node:fs');
    utimesSync(p('scr.mp4'), later, later);
    const r2 = await render(base, 'out/d.mp4');
    expect([r2.reused, r2.rendered]).toEqual([1, 1]);
  });

  it('renders layouts, zoom, transitions, masks, overlays, bgm ducking, sfx and chunk splitting', async () => {
    let t = applyOps(base, [
      { op: 'setSegments', segments: [
        seg('seg_w', 0, 30, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'default' } },
          { transitionIn: { kind: 'fade', frames: 5 } }),
        seg('seg_r', 30, 50, { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'rounded', corner: 'tl', style: 'default' } },
          { zoom: [{ at: 0, value: { scale: 1, focus: 'face' } }, { at: 15, value: { scale: 1.6, focus: { x: 100, y: 100 } } }] }),
        seg('seg_s', 50, 80, { layout: 'split-v', top: 'scr', bottom: 'cam' }, { transitionIn: { kind: 'jump-zoom', frames: 4 } }),
        seg('seg_z', 80, 110, { layout: 'camera-full', camera: 'cam' }, { zoom: [{ at: 0, value: { scale: 1.5, focus: 'face' } }] }),
      ] },
      { op: 'addMask', mask: { id: 'mask_1', kind: 'pixelate', source: 'scr', reason: 'pii:email', decided: D, track: [
        { frame: 0, box: { x: 10, y: 10, w: 120, h: 40 }, confidence: 0.9 }, { frame: 60, box: { x: 100, y: 60, w: 120, h: 40 }, confidence: 0.9 }] } },
      { op: 'addMask', mask: { id: 'mask_2', kind: 'blur', source: 'scr', reason: 'notification', decided: D, track: [{ frame: 40, box: { x: 200, y: 0, w: 100, h: 60 }, confidence: 1 }, { frame: 70, box: { x: 200, y: 0, w: 100, h: 60 }, confidence: 1 }] } },
      { op: 'addOverlay', overlay: { kind: 'image', id: 'ov_1', range: { start: 10, end: 40 }, asset: 'logo', position: { x: 20, y: 20, w: 64, h: 64 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'logo', id: 'ov_2', range: { start: 0, end: 110 }, asset: 'logo', corner: 'tr' } },
      { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 15, end: 110 }, gainDb: -12, duckDb: -10, fadeIn: 10, fadeOut: 15, decided: D }] },
      { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 50, gainDb: -6, trigger: 'cut', decided: D } },
      { op: 'setVoice', patch: { denoise: 'strong', eq: 'voice-bright' } },
    ]).timeline;
    const c = structuredClone(t.sources.cam) as Extract<Timeline['sources'][string], { kind: 'camera' }>;
    c.offset = -10; // camera starts 10 frames after the take: leading black padding in seg_w
    t = applyOp(t, { op: 'addSource', id: 'cam', source: c }).timeline;
    const r = await render(t, 'out/sink.mp4', { maxChunkFrames: 20 }, 3);
    expect(r.rendered).toBe(7); // 30→2, 20→1, 30→2, 30→2
    expect(countFrames(r.output)).toBe(110);
    const pr = await probe(r.output);
    expect(pr.durationSec).toBeCloseTo(110 / 30, 1);
  });

  it('renders a drifting camera as voice (resampled) and wipe ring/shadow styles', async () => {
    let t = applyOp(base, { op: 'updateSource', id: 'cam', patch: { drift: 1.01 } }).timeline;
    const { mic: _m, ...noMic } = t.sources;
    t = { ...t, sources: noMic };
    t = applyOp(t, { op: 'setVideo', id: 'seg_b', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'ring-gradient', size: 0.4 } }, decided: D }).timeline;
    const r = await render(t, 'out/drift.mp4');
    expect(countFrames(r.output)).toBe(60);
    const pr = await probe(r.output);
    expect(pr.streams.find((s) => s.type === 'audio')!.durationSec!).toBeCloseTo(2, 1);
    // ring: orange/red pixels just outside the wipe circle (d = 96 at 320x240, bottom-right)
    const { d, x, y } = { d: 96, x: 320 - 96 - 10, y: 240 - 96 - 10 };
    const ringTop = regionLuma(r.output, 45, x + d / 2 - 4, y - 2, 8, 2);
    expect(ringTop).toBeGreaterThan(60);
    const shadow = applyOp(t, { op: 'setVideo', id: 'seg_b', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'rounded', corner: 'tl', style: 'shadow' } }, decided: D }).timeline;
    expect(countFrames((await render(shadow, 'out/shadow.mp4')).output)).toBe(60);
  });

  it('renders a derived TikTok variant at 1080x1920 (one take → vertical)', async () => {
    const main = applyOp(base, { op: 'setVideo', id: 'seg_a', video: { layout: 'camera-full', camera: 'cam' }, decided: { ...D, reason: 'hook' } }).timeline;
    const hooked = applyOp(main, { op: 'setSegments', segments: main.segments.map((s) => (s.id === 'seg_b' ? { ...s, role: 'hook' as const } : s)) }).timeline;
    const sel = pickHighlights(hooked, { maxFrames: 60 });
    expect(sel[0]).toBe('seg_b');
    const v = deriveVariant(hooked, 'tiktok', { selection: sel });
    expect(validateTimeline(v).ok).toBe(true);
    expect(v.segments[0]!.video).toMatchObject({ layout: 'split-v', top: 'scr', bottom: 'cam' });
    const plan = compile(v, { quality: 'final', target: 'tiktok', projectDir: dir });
    const r = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'out/tiktok.mp4' });
    const pr = await probe(r.output);
    expect(pr.streams.find((s) => s.type === 'video')).toMatchObject({ codec: 'h264', width: 1080, height: 1920, fps: { num: 30, den: 1 } });
    expect(pr.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(countFrames(r.output)).toBe(v.segments.reduce((n, s) => n + s.range.end - s.range.start, 0));
    // bottom half shows the flat-gray camera, top half the screen pattern
    const bottom = regionLuma(r.output, 5, 400, 1300, 200, 200);
    const cam = frameLuma(p('cam.mp4'), 75 + 5);
    expect(Math.abs(bottom - cam)).toBeLessThan(12);
  });

  it('tracked reframing: the vertical crop follows a moving face; clicks punch in; input overlays render', async () => {
    // camera: horizontal brightness ramp (dark left → bright right), 4 s
    ff(['-f', 'lavfi', '-i', "color=black:s=640x360:r=30:d=4,format=yuv420p,geq=lum='16+X*219/W':cb=128:cr=128", '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', p('ramp.mp4')]);
    const e = emptyTimeline({ title: 'r', kind: 'tech', template: { id: 'tech', version: '1' }, canvas: { width: 640, height: 360, fps: { num: 30, den: 1 } }, language: 'ja', targets: ['youtube'] });
    const main = applyOps({
      ...e,
      sources: {
        ramp: { kind: 'camera', path: 'ramp.mp4', take: 'take_1', role: 'front', fps: { num: 30, den: 1 }, size: { width: 640, height: 360 }, offset: 0, audio: false },
        scr: { kind: 'screen', path: 'scr.mp4', take: 'take_1', display: 'main', fps: { num: 30, den: 1 }, size: { width: 320, height: 240 }, offset: 0, audio: false },
        mic: { kind: 'mic', path: 'mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
      },
    }, [{ op: 'setSegments', segments: [
      { id: 'seg_c', range: { start: 0, end: 0 }, src: { from: 0, to: 90, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'hook', video: { layout: 'camera-full', camera: 'ramp' }, decided: D },
      { id: 'seg_s', range: { start: 0, end: 0 }, src: { from: 90, to: 120, take: 'take_1' }, text: '', chapter: 'ch_1', role: 'demo', video: { layout: 'screen-full', screen: 'scr' }, decided: D },
    ] }]).timeline;
    // a face moving left → right over 3 s
    const faces = { fps: 30, frames: Array.from({ length: 91 }, (_, f) => ({ f, faces: [{ x: 0.05 + 0.8 * (f / 90), y: 0.3, w: 0.1, h: 0.15, score: 0.95 }] })) };
    const v = deriveVariant(main, 'tiktok', { selection: ['seg_c'], tracks: { faces: { ramp: faces } } });
    expect(Array.isArray((v.segments[0]!.video as { focus: unknown }).focus)).toBe(true);
    const r = await executeRenderPlan(compile(v, { quality: 'preview', projectDir: dir }), { projectDir: dir, cacheDir: 'cache', output: 'out/reframe.mp4' });
    expect((await probe(r.output)).streams[0]).toMatchObject({ width: 540, height: 960 });
    expect(frameLuma(r.output, 85)).toBeGreaterThan(frameLuma(r.output, 5) + 60); // the crop moved right (brighter)
    // click punch-in on the screen segment + click ring / keystroke overlays
    const cursor = [{ t_ms: 3400, x: 0.75, y: 0.75, click: true }];
    const zoomed = applyOp(main, { op: 'setSegments', segments: applyTracks(main, { cursor: { take_1: cursor } }, { followClicks: true }) }).timeline;
    expect(zoomed.segments[1]!.zoom!.length).toBeGreaterThan(1);
    const withInputs = applyOps(zoomed, overlaysFromInputLogs(zoomed, { cursor: { take_1: cursor }, keys: { take_1: [{ t_ms: 3100, keys: ['⌘', 'S'] }] } })
      .map((overlay) => ({ op: 'addOverlay' as const, overlay }))).timeline;
    expect(withInputs.overlays.map((o) => o.kind).sort()).toEqual(['click-ring', 'keystroke']);
    if (HAVE_LIBASS) {
      const z = await executeRenderPlan(compile(withInputs, { quality: 'preview', projectDir: dir }), { projectDir: dir, cacheDir: 'cache', output: 'out/clicks.mp4' });
      expect(countFrames(z.output)).toBe(120);
    } else {
      const z = await executeRenderPlan(compile(zoomed, { quality: 'preview', projectDir: dir }), { projectDir: dir, cacheDir: 'cache', output: 'out/clicks.mp4' });
      expect(countFrames(z.output)).toBe(120);
    }
  });

  it('fill mask lands where the source coordinates say', async () => {
    const t = applyOp(base, { op: 'addMask', mask: { id: 'mask_f', kind: 'fill', source: 'cam', reason: 'face', decided: D, track: [
      { frame: 0, box: { x: 0, y: 0, w: 160, h: 120 }, confidence: 1 }, { frame: 120, box: { x: 0, y: 0, w: 160, h: 120 }, confidence: 1 }] } }).timeline;
    const r = await render(t, 'out/mask.mp4');
    const inside = regionLuma(r.output, 25, 10, 10, 100, 80);
    const outside = regionLuma(r.output, 25, 200, 150, 100, 80);
    expect(inside).toBeLessThan(5);
    expect(outside).toBeGreaterThan(inside + 40);
  });

  it('the full voice chain (strong denoise, compressor, de-ess) still lands on the loudness target', async () => {
    let t = applyOp(base, { op: 'setSegments', segments: [seg('seg_v', 0, 120, { layout: 'camera-full', camera: 'cam' })] }).timeline;
    t = applyOp(t, { op: 'setVoice', patch: { denoise: 'strong', eq: 'voice-bright' } }).timeline;
    const plan = compile(t, { quality: 'final', target: 'youtube', projectDir: dir });
    const g = plan.audio.args[plan.audio.args.indexOf('-filter_complex') + 1]!;
    expect(g).toContain('acompressor=');
    expect(g).toContain('equalizer=f=6500');
    const r = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache', output: 'out/voice.mp4' });
    const l = await measureLoudness(r.output);
    expect(Math.abs(l.integrated - -14)).toBeLessThan(1);
    expect(l.truePeak).toBeLessThan(-0.3);
  });

  it('final quality hits the loudness target with 2-pass loudnorm', async () => {
    const t = applyOp(base, { op: 'setSegments', segments: [seg('seg_l', 0, 120, { layout: 'camera-full', camera: 'cam' })] }).timeline;
    const r = await render(t, 'out/final.mp4', { quality: 'final', target: 'youtube' });
    const l = await measureLoudness(r.output);
    expect(Math.abs(l.integrated - -14)).toBeLessThan(1);
    expect(l.truePeak).toBeLessThan(-0.3);
    const pr = await probe(r.output);
    expect(pr.streams.find((s) => s.type === 'video')!.profile).toBe('High');
  });

  it('renderFrame produces the exact timeline frame as an image', async () => {
    // timeline frame 15 = seg_a source frame 45
    const r = await renderFrame(compileFrame(base, 15, { projectDir: dir }), { projectDir: dir, output: 'frames/f15.png' });
    expect(r.output).toBe(p('frames/f15.png'));
    expect((await probe(r.output)).streams[0]).toMatchObject({ width: 320, height: 240 });
    const lum = frameLuma(r.output, 0);
    const d = (k: number) => Math.abs(frameLuma(p('cam.mp4'), k) - lum);
    expect(d(45)).toBeLessThan(Math.min(d(44), d(46)));
    // frame 30 is the first frame of the screen segment: not the flat camera gray
    const s = await renderFrame(compileFrame(base, 30, { projectDir: dir, quality: 'preview' }), { projectDir: dir, output: 'frames/f30.jpg' });
    expect((await probe(s.output)).streams[0]!.codec).toBe('mjpeg');
    await expect(renderFrame(compileFrame(applyOp(base, { op: 'updateSource', id: 'cam', patch: { path: 'gone.mp4' } }).timeline, 0, { projectDir: dir }), { projectDir: dir, output: 'frames/x.png' }))
      .rejects.toThrow(/input not found: gone\.mp4/);
    expect(existsSync(p('frames/x.png'))).toBe(false);
  });

  it('preview uses the hardware encoder when available, cached separately from x264 chunks', async () => {
    const hw = await detectHwEncoder();
    const t = applyOp(base, { op: 'trimSegment', id: 'seg_a', to: 50, decided: D }).timeline;
    const plan = compile(t, { quality: 'preview', projectDir: dir });
    const sw = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache-enc', output: 'out/sw.mp4', encoder: 'x264' });
    expect(sw.encoder).toBe('libx264');
    const auto = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache-enc', output: 'out/auto.mp4' });
    expect(auto.encoder).toBe(hw ?? 'libx264');
    if (hw) expect(auto.reused).toBe(0); // different encoder → different cache entries (concat copy needs one codec setup)
    expect(countFrames(auto.output)).toBe(countFrames(sw.output));
    const fin = await executeRenderPlan(compile(t, { quality: 'final', target: 'youtube', projectDir: dir }), { projectDir: dir, cacheDir: 'cache-enc', output: 'out/fin.mp4' });
    expect(fin.encoder).toBe('libx264'); // final always x264
  });

  it('cancel mid-render rejects, leaves no temp files and only complete chunks, and a re-render reuses them', async () => {
    // 12 segments of 1 s → 12 chunks
    const segs = Array.from({ length: 12 }, (_, i) => seg(`seg_${i}`, i * 10, i * 10 + 30, { layout: 'camera-full', camera: 'cam' }));
    const t = applyOp(base, { op: 'setSegments', segments: segs }).timeline;
    const plan = compile(t, { quality: 'final', target: 'youtube', projectDir: dir }); // x264 medium: slow enough to cancel
    const ac = new AbortController();
    const err = await executeRenderPlan(plan, {
      projectDir: dir, cacheDir: 'cache-cancel', output: 'out/cancel.mp4', concurrency: 2, signal: ac.signal,
      onProgress: (x) => { if (x.done >= 1) ac.abort(); },
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    const files = listDir(p('cache-cancel/chunks'));
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.length).toBeLessThan(12);
    for (const f of files) expect(countFrames(p(`cache-cancel/chunks/${f}`))).toBe(30); // complete chunks only
    expect(existsSync(p('out/cancel.mp4'))).toBe(false);
    const again = await executeRenderPlan(plan, { projectDir: dir, cacheDir: 'cache-cancel', output: 'out/cancel.mp4', concurrency: 2 });
    expect(again.reused).toBe(files.length);
    expect(again.rendered).toBe(12 - files.length);
    expect(countFrames(again.output)).toBe(360);
  });

  describe('fast preview audio (per-segment stems)', () => {
    const four = () => applyOp(base, { op: 'setSegments', segments: [
      seg('seg_1', 0, 25, { layout: 'camera-full', camera: 'cam' }),
      seg('seg_2', 30, 55, { layout: 'camera-full', camera: 'cam' }),
      seg('seg_3', 60, 90, { layout: 'camera-full', camera: 'cam' }),
      seg('seg_4', 95, 120, { layout: 'camera-full', camera: 'cam' }),
    ] }).timeline;
    const stems = (cache: string) => (existsSync(p(`${cache}/audio`)) ? listDir(p(`${cache}/audio`)).filter((f) => /^stem-.*\.wav$/.test(f)) : []);
    const run = (t: Timeline, cache: string, out: string, fastAudio?: boolean) =>
      executeRenderPlan(compile(t, { quality: 'preview', projectDir: dir }), { projectDir: dir, cacheDir: cache, output: out, ...(fastAudio === undefined ? {} : { fastAudio }) });

    it('matches the full graph (same length, same envelope) and lands near the loudness target', async () => {
      const t = four();
      const fast = await run(t, 'cache-fa', 'out/fa-fast.mp4');
      const full = await run(t, 'cache-fb', 'out/fa-full.mp4', false);
      expect(stems('cache-fa')).toHaveLength(4);
      expect(stems('cache-fb')).toHaveLength(0);
      const [a, b] = [audioEnvelope(fast.output), audioEnvelope(full.output)];
      expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
      expect(correlation(a, b)).toBeGreaterThan(0.9);
      const l = await measureLoudness(fast.output);
      expect(Math.abs(l.integrated - t.audio.voice.loudness)).toBeLessThan(2.5);
      expect(l.truePeak).toBeLessThan(t.audio.voice.truePeak + 1);
      expect((await probe(fast.output)).durationSec).toBeCloseTo((await probe(full.output)).durationSec, 1);
    });

    it('a one-segment edit renders exactly one new stem; an unchanged re-render renders none', async () => {
      const t = four();
      await run(t, 'cache-fc', 'out/fc1.mp4');
      expect(stems('cache-fc')).toHaveLength(4);
      await run(t, 'cache-fc', 'out/fc2.mp4');
      expect(stems('cache-fc')).toHaveLength(4);
      const edited = applyOp(t, { op: 'trimSegment', id: 'seg_3', to: 80, decided: D }).timeline;
      const r = await run(edited, 'cache-fc', 'out/fc3.mp4');
      expect(stems('cache-fc')).toHaveLength(5);
      expect((await probe(r.output)).durationSec).toBeCloseTo(95 / 30, 1);
    });

    it('a stem without its loudness sidecar is rendered again; bgm and sfx still mix in', async () => {
      let t = four();
      t = applyOps(t, [
        { op: 'setBgm', bgm: [{ id: 'bgm_1', asset: 'music', range: { start: 0, end: 100 }, gainDb: -12, duckDb: -10, fadeIn: 5, fadeOut: 5, decided: D }] },
        { op: 'addSfx', sfx: { id: 'sfx_1', asset: 'pop', at: 10, gainDb: -6, trigger: 'manual', decided: D } },
      ]).timeline;
      await run(t, 'cache-fd', 'out/fd1.mp4');
      const { rmSync } = await import('node:fs');
      const first = stems('cache-fd')[0]!;
      rmSync(p(`cache-fd/audio/${first}.json`));
      const r = await run(t, 'cache-fd', 'out/fd2.mp4');
      expect(existsSync(p(`cache-fd/audio/${first}.json`))).toBe(true);
      expect(audioEnvelope(r.output).some((v) => v > 0.01)).toBe(true);
    });

    it('segments without a voice source become exact-length silence', async () => {
      const f = four();
      const { mic: _mic, ...sources } = f.sources;
      const t = { ...f, sources: { ...sources, cam: { ...sources.cam!, audio: false } } } as Timeline;
      const r = await run(t, 'cache-fe', 'out/fe.mp4');
      expect((await probe(r.output)).durationSec).toBeCloseTo(105 / 30, 1);
      expect(Math.max(...audioEnvelope(r.output))).toBeLessThan(0.001);
    });
  });

  it('fails clearly on a missing input', async () => {
    const t = applyOp(base, { op: 'addSource', id: 'cam', source: { ...(base.sources.cam as Extract<Timeline['sources'][string], { kind: 'camera' }>), path: 'missing.mp4' } }).timeline;
    await expect(render(t, 'out/x.mp4')).rejects.toBeInstanceOf(MediaError);
    await expect(render(t, 'out/x.mp4')).rejects.toThrow(/input not found: missing\.mp4/);
    expect(existsSync(p('out/x.mp4'))).toBe(false);
  });

  it.skipIf(!HAVE_LIBASS)('burns captions and telops with libass', async () => {
    writeFileSync(p('captions.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,HELLO\n');
    let t = applyOp(base, { op: 'setCaptions', captions: [{ id: 'cap_1', range: { start: 0, end: 60 }, text: 'HELLO', spoken: 'hello', words: [], lines: ['HELLO'], emphasis: [], style: 'x', position: { anchor: 'bottom', y: 0.9 }, decided: D }] }).timeline;
    t = applyOp(t, { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_t', range: { start: 35, end: 55 }, text: 'テロップ', style: 'big', position: { x: 160, y: 60 }, decided: D } }).timeline;
    const r = await render(t, 'out/subs.mp4', { assPath: 'captions.ass' });
    expect(countFrames(r.output)).toBe(60);
  });
});
