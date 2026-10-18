import type { Decided, Segment, Timeline } from '@video/core';
import { applyOps, emptyTimeline } from '@video/core';

export const D: Decided = { by: 'agent', agent: 'claude', reason: 'test' };

export function seg(id: string, from: number, to: number, extra: Partial<Segment> = {}): Segment {
  return {
    id,
    range: { start: 0, end: 0 },
    src: { from, to, take: 'take_1' },
    text: '',
    chapter: 'ch_1',
    role: 'explain',
    video: { layout: 'camera-full', camera: 'cam' },
    decided: D,
    ...extra,
  };
}

/** 1920x1080@30 timeline with a camera, a screen, a mic, assets and three segments (take frames at 30 fps). */
export function fixture(o: { fps?: { num: number; den: number }; srcFps?: { num: number; den: number } } = {}): Timeline {
  const fps = o.fps ?? { num: 30, den: 1 };
  const srcFps = o.srcFps ?? { num: 30, den: 1 };
  const base = emptyTimeline({
    title: 'テスト', kind: 'talk', template: { id: 'talk-youtube', version: '1' },
    canvas: { width: 1920, height: 1080, fps }, language: 'ja', targets: ['youtube'],
  });
  const t: Timeline = {
    ...base,
    sources: {
      cam: { kind: 'camera', path: 'media/cam.mp4', take: 'take_1', role: 'front', fps: srcFps, size: { width: 1920, height: 1080 }, offset: 0 },
      scr: { kind: 'screen', path: 'media/screen.mp4', take: 'take_1', display: 'main', fps: srcFps, size: { width: 1920, height: 1080 }, offset: 0 },
      mic: { kind: 'mic', path: 'media/mic.wav', take: 'take_1', sampleRate: 48000, offset: 0 },
      music: { kind: 'asset', path: 'assets/bgm.mp3', assetId: 'bgm-1', license: { id: 'CC0-1.0' } },
      pop: { kind: 'asset', path: 'assets/pop.wav', assetId: 'sfx-1', license: { id: 'CC0-1.0' } },
      logo: { kind: 'asset', path: 'assets/logo.png', assetId: 'logo-1', license: { id: 'CC0-1.0' } },
    },
    outline: [{ id: 'ch_1', title: 'はじめに', start: 0, end: 1000, points: [], importance: 'core' }],
  };
  return applyOps(t, [
    { op: 'addSegment', segment: seg('seg_a', 0, 90) },
    { op: 'addSegment', segment: seg('seg_b', 120, 300, { video: { layout: 'screen-full', screen: 'scr' } }) },
    { op: 'addSegment', segment: seg('seg_c', 400, 460) },
  ]).timeline;
}

/** Deterministic PRNG for property-style loops. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
