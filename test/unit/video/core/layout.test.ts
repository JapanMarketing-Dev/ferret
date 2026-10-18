import { describe, expect, it } from 'vitest';
import type { Caption, Mask, Timeline } from '@video/core';
import {
  applyOp, applyOps, compileFrame, hitTest, layoutAt, maskBoxAt, sourceRectToCanvas, videoRegions,
} from '@video/core';
import { D, fixture } from './fixtures.js';
import { SAMPLE_SLOTS } from './pattern-samples.js';

const wipe = { layout: 'screen-with-wipe' as const, screen: 'scr', camera: 'cam', wipe: { shape: 'circle' as const, corner: 'br' as const, style: 'd' } };
const cap = (id: string, start: number, end: number, extra: Partial<Caption> = {}): Caption => ({
  id, range: { start, end }, text: 'こんにちは', spoken: 'こんにちは', words: [], lines: ['こんにちは'], emphasis: [], style: 'x',
  position: { anchor: 'bottom', y: 0.9 }, decided: D, ...extra,
});
const mask = (track: Mask['track'], source = 'scr'): Mask => ({ id: 'mask_1', kind: 'pixelate', source, reason: 'manual', track, decided: D });
const kinds = (t: Timeline, f: number) => layoutAt(t, f).map((i) => `${i.kind}:${i.id}${i.slot ? `/${i.slot}` : ''}`);

describe('geometry helpers', () => {
  it('videoRegions mirror the compiler layouts', () => {
    const t = fixture();
    expect(videoRegions(t.segments[0]!, t.canvas)).toEqual([{ source: 'cam', rect: { x: 0, y: 0, w: 1920, h: 1080 }, fit: 'cover', kind: 'video' }]);
    expect(videoRegions({ ...t.segments[0]!, video: wipe }, t.canvas)[0]).toEqual({ source: 'cam', rect: { x: 1553, y: 713, w: 324, h: 324 }, fit: 'cover', kind: 'wipe' });
    expect(videoRegions({ ...t.segments[0]!, video: { layout: 'split-v', top: 'scr', bottom: 'cam' } }, { width: 1080, height: 1920 }).map((r) => r.rect))
      .toEqual([{ x: 0, y: 0, w: 1080, h: 960 }, { x: 0, y: 960, w: 1080, h: 960 }]);
    expect(videoRegions({ ...t.segments[0]!, video: { layout: 'scene', scene: 'scn_1' } }, t.canvas)).toEqual([]);
  });
  it('sourceRectToCanvas handles fit (letterbox) and cover (centre crop)', () => {
    const box = { x: 100, y: 50, w: 200, h: 40 };
    expect(sourceRectToCanvas(box, { width: 1280, height: 720 }, { x: 0, y: 0, w: 1920, h: 1080 }, 'fit')).toEqual({ x: 150, y: 75, w: 300, h: 60 });
    // 16:9 source into 9:16 canvas, fit: letterboxed vertically
    const f = sourceRectToCanvas(box, { width: 1920, height: 1080 }, { x: 0, y: 0, w: 1080, h: 1920 }, 'fit')!;
    expect(f.x).toBeCloseTo(56.25, 5);
    expect(f.y).toBeCloseTo(656.25 + 28.125, 5);
    // cover: centre crop; a box near the left edge is cut away
    const c = sourceRectToCanvas({ x: 1000, y: 500, w: 100, h: 100 }, { width: 1920, height: 1080 }, { x: 0, y: 0, w: 1080, h: 1920 }, 'cover')!;
    expect(c.x).toBeCloseTo(-1166.67 + 1000 * (1920 / 1080), 1);
    expect(sourceRectToCanvas({ x: 0, y: 0, w: 100, h: 100 }, { width: 1920, height: 1080 }, { x: 0, y: 0, w: 1080, h: 1920 }, 'cover')).toBeNull();
  });
  it('maskBoxAt interpolates centres, uses the largest size, and is inactive outside the track', () => {
    const m = mask([{ frame: 0, box: { x: 0, y: 0, w: 100, h: 20 }, confidence: 1 }, { frame: 10, box: { x: 100, y: 40, w: 60, h: 20 }, confidence: 1 }]);
    expect(maskBoxAt(m, 5)).toEqual({ x: 40, y: 20, w: 100, h: 20 });
    expect(maskBoxAt(m, 10.5)).toEqual({ x: 100, y: 40, w: 60, h: 20 });
    expect(maskBoxAt(m, -1)).toBeNull();
    expect(maskBoxAt(m, 12)).toBeNull();
  });
});

describe('layoutAt', () => {
  it('lists video, wipe and masks for the segment at the frame', () => {
    let t = applyOp(fixture(), { op: 'setVideo', id: 'seg_b', video: wipe, decided: D }).timeline;
    t = applyOp(t, { op: 'addMask', mask: mask([{ frame: 120, box: { x: 100, y: 50, w: 200, h: 40 }, confidence: 1 }, { frame: 300, box: { x: 100, y: 50, w: 200, h: 40 }, confidence: 1 }]) }).timeline;
    const items = layoutAt(t, 100); // seg_b (timeline 90..270), take frame 130
    expect(items).toEqual([
      { kind: 'mask', id: 'mask_1', source: 'scr', segment: 'seg_b', rect: { x: 100, y: 50, w: 200, h: 40 } },
      { kind: 'wipe', id: 'seg_b', source: 'cam', segment: 'seg_b', rect: { x: 1553, y: 713, w: 324, h: 324 } },
      { kind: 'video', id: 'seg_b', source: 'scr', segment: 'seg_b', rect: { x: 0, y: 0, w: 1920, h: 1080 } },
    ]);
    expect(kinds(t, 10)).toEqual(['video:seg_a']); // mask belongs to the screen, seg_a shows the camera
    expect(layoutAt(t, 330)).toEqual([]); // past the end
    // the hit test finds the wipe over the screen
    expect(hitTest(items, 1700, 900).map((i) => i.kind)).toEqual(['wipe', 'video']);
    expect(hitTest(items, 5, 5).map((i) => i.kind)).toEqual(['video']);
  });
  it('follows source offsets for masks', () => {
    let t = applyOp(fixture(), { op: 'updateSource', id: 'scr', patch: { offset: 100 } }).timeline;
    t = applyOp(t, { op: 'addMask', mask: mask([{ frame: 220, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1 }, { frame: 240, box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 1 }]) }).timeline;
    // timeline 90 → take 120 → screen local frame 220
    expect(kinds(t, 90)).toContain('mask:mask_1');
    expect(kinds(t, 130)).not.toContain('mask:mask_1');
  });
  it('applies static zoom to video and mask rects', () => {
    let t = applyOp(fixture(), { op: 'setSegments', segments: fixture().segments.map((s) => s.id === 'seg_b' ? { ...s, zoom: [{ at: 0, value: { scale: 2, focus: { x: 960, y: 540 } } }] } : s) }).timeline;
    t = applyOp(t, { op: 'addMask', mask: mask([{ frame: 0, box: { x: 900, y: 500, w: 100, h: 50 }, confidence: 1 }, { frame: 999, box: { x: 900, y: 500, w: 100, h: 50 }, confidence: 1 }]) }).timeline;
    const m = layoutAt(t, 100).find((i) => i.kind === 'mask')!;
    expect(m.rect).toEqual({ x: 840, y: 460, w: 200, h: 100 });
  });
  it('estimates captions and overlays, topmost first', () => {
    const t = applyOps(fixture(), [
      { op: 'setCaptions', captions: [cap('cap_1', 0, 60), cap('cap_2', 60, 90, { position: { anchor: 'top', y: 0.1 }, lines: ['一行目', '二行目'] })] },
      { op: 'addOverlay', overlay: { kind: 'image', id: 'ov_img', range: { start: 0, end: 100 }, asset: 'logo', position: { x: 10, y: 20, w: 300, h: 200 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_tel', range: { start: 0, end: 100 }, text: '3つのコツ', style: 's', position: { x: 960, y: 300 }, decided: D } },
      { op: 'addOverlay', overlay: { kind: 'logo', id: 'ov_logo', range: { start: 0, end: 330 }, asset: 'logo', corner: 'tr' } },
      { op: 'addOverlay', overlay: { kind: 'click-ring', id: 'ov_ring', at: 5, position: { x: 500, y: 500 } } },
      { op: 'addOverlay', overlay: { kind: 'keystroke', id: 'ov_keys', range: { start: 0, end: 10 }, keys: ['⌘', 'K'] } },
    ]).timeline;
    const items = layoutAt(t, 6);
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'caption:cap_1', 'overlay:ov_keys', 'overlay:ov_ring', 'overlay:ov_logo', 'overlay:ov_tel', 'overlay:ov_img', 'video:seg_a',
    ]);
    const c1 = items[0]!.rect;
    expect(c1.y + c1.h).toBe(972); // bottom anchored at 0.9 H
    expect(Math.abs(c1.x + c1.w / 2 - 960)).toBeLessThanOrEqual(1);
    expect(items.find((i) => i.id === 'ov_img')!.rect).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(items.find((i) => i.id === 'ov_logo')!.rect).toEqual({ x: 1920 - 152 - 43, y: 43, w: 152, h: 152 });
    { const r = items.find((i) => i.id === "ov_tel")!.rect; expect(Math.abs(r.x + r.w / 2 - 960)).toBeLessThanOrEqual(1); }
    // ring lasts ~0.4 s (12 frames)
    expect(kinds(t, 16)).toContain('overlay:ov_ring');
    expect(kinds(t, 17)).not.toContain('overlay:ov_ring');
    const c2 = layoutAt(t, 70).find((i) => i.id === 'cap_2')!.rect;
    expect(c2.y).toBe(108);
    expect(c2.h).toBe(Math.round(2 * 1080 * 0.06 * 1.25));
  });
  it('reports scene slots (media and text regions) above the scene', () => {
    const t = applyOps(fixture(), [
      { op: 'addSource', id: 'ill', source: { kind: 'asset', path: 'ill.png', assetId: 'ill', license: { id: 'CC0-1.0' } } },
      { op: 'addScene', scene: { id: 'scn_1', pattern: { id: 'explain-illust-bubbles', version: '1' }, range: { start: 0, end: 90 }, slots: SAMPLE_SLOTS['explain-illust-bubbles']!, decided: D } },
    ]).timeline;
    const ks = kinds(t, 30);
    expect(ks).toEqual(['scene-slot:scn_1/wipe', 'scene-slot:scn_1/illustration', 'scene-slot:scn_1/bubbleLeft', 'scene-slot:scn_1/bubbleRight', 'scene:scn_1', 'video:seg_a']);
    const items = layoutAt(t, 30);
    const left = items.find((i) => i.slot === 'bubbleLeft')!;
    expect(hitTest(items, left.rect.x + 5, left.rect.y + 5)[0]).toMatchObject({ kind: 'scene-slot', slot: 'bubbleLeft' });
    expect(kinds(t, 95)).toEqual(['video:seg_b']);
  });
  it('scales rects to a requested canvas', () => {
    const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_a', video: wipe, decided: D }).timeline;
    expect(layoutAt(t, 0, { canvas: { width: 960, height: 540 } })[0]!.rect).toEqual({ x: 777, y: 357, w: 162, h: 162 });
  });
});

describe('compileFrame', () => {
  it('renders one frame through the chunk graph at final quality', () => {
    const f = compileFrame(fixture(), 100, { projectDir: '/p' });
    expect(f.args.slice(-7)).toEqual(['-map', '[vout]', '-frames:v', '1', '-update', '1', '{out}']);
    expect(f.canvas).toMatchObject({ width: 1920, height: 1080 });
    // seg_b: timeline 90 → take 120; frame 100 → take 130 → 4.333 s into the screen
    expect(Number(f.args[1])).toBeCloseTo(130 / 30, 5);
    expect(f.args).toContain('media/screen.mp4');
    expect(f.writes).toEqual([]);
  });
  it('preview quality, writes for text overlays, and range errors', () => {
    const t = applyOp(fixture(), { op: 'addOverlay', overlay: { kind: 'telop', id: 'ov_1', range: { start: 0, end: 30 }, text: 'A', style: 's', position: { x: 1, y: 2 }, decided: D } }).timeline;
    const f = compileFrame(t, 10, { projectDir: '/p', quality: 'preview' });
    expect(f.canvas).toMatchObject({ width: 960, height: 540 });
    expect(f.writes).toHaveLength(1);
    expect(f.args.join(' ')).toContain('subtitles=filename=derived/cache/generated/overlays-');
    expect(() => compileFrame(t, 330, { projectDir: '/p' })).toThrow(RangeError);
    expect(() => compileFrame(t, -1, { projectDir: '/p' })).toThrow(RangeError);
    expect(() => compileFrame(t, 1.5, { projectDir: '/p' })).toThrow(RangeError);
  });
});
