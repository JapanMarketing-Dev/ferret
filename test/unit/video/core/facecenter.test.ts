import { describe, expect, it } from 'vitest';
import {
  applyOp, axisFocus, cameraMaterial, centerPerson, compile, coverScaleSize, coverVisible, faceCrop, faceFrameSec, faceSamples, focusForPoint,
  personCamera, personFaceSamples, placedAt, scaleToPlace, sourceRectToCanvas, suggestCameras, validateTimeline, videoRegions,
  type FaceTrack, type SegmentMaterial, type Timeline,
} from '@video/core';
import { D, fixture } from './fixtures.js';

const fc = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;
const opts = { quality: 'preview' as const, projectDir: '/p' };

/** A face track sampled at 5 fps over `sec` seconds (source frames at 30 fps), like the desktop writes it. */
function track(sec: number, face: (t: number) => { x: number; y: number; w?: number; h?: number; score?: number }[] | null): FaceTrack {
  const frames: FaceTrack['frames'] = [];
  for (let i = 0; i <= sec * 5; i++) {
    const t = i / 5;
    const fs = face(t);
    frames.push({ f: Math.round(t * 30), t, faces: (fs ?? []).map((f) => ({ w: 0.1, h: 0.18, score: 0.9, ...f, x: f.x - (f.w ?? 0.1) / 2, y: f.y - (f.h ?? 0.18) / 2 })) });
  }
  return { fps: 5, sourceFps: 30, frames };
}

describe('face track time', () => {
  it('uses t when present, else f over the source rate, else f over fps (older files)', () => {
    expect(faceFrameSec({ fps: 5, sourceFps: 30 }, { f: 60, t: 2 })).toBe(2);
    expect(faceFrameSec({ fps: 5, sourceFps: 30 }, { f: 60 })).toBe(2); // not 12: fps is the sampling rate here
    expect(faceFrameSec({ fps: 30 }, { f: 60 })).toBe(2);
    expect(faceFrameSec({ fps: 0 }, { f: 60 })).toBe(2); // fallback 30
    expect(faceFrameSec({ fps: 5, sourceFps: 30 }, { f: 60, t: Number.NaN })).toBe(2);
  });
  it('faceSamples times follow the source clock (regression: the desktop file put faces 6× too late)', () => {
    const s = faceSamples(track(2, () => [{ x: 0.5, y: 0.5 }]));
    expect(s.at(-1)!.t).toBeCloseTo(2, 5);
  });
});

describe('crop geometry', () => {
  it('coverVisible: 16:9 in 16:9 crops nothing; in a square wipe 9/16 of the width', () => {
    expect(coverVisible({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual({ x: 1, y: 1 });
    const w = coverVisible({ width: 1920, height: 1080 }, { width: 324, height: 324 });
    expect(w.x).toBeCloseTo(0.5625, 4);
    expect(w.y).toBe(1);
    expect(coverVisible({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }).y).toBeCloseTo(0.31640625, 6);
  });

  it('scaleToPlace: centred point needs no zoom; off-centre needs 1/(2·min(c,1−c)); edges are impossible', () => {
    expect(scaleToPlace(0.5, 1)).toBe(1);
    expect(scaleToPlace(0.73, 1)).toBeCloseTo(1 / 0.54, 6);
    expect(scaleToPlace(0.27, 1)).toBeCloseTo(1 / 0.54, 6);
    expect(scaleToPlace(0, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(scaleToPlace(1, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(scaleToPlace(-3, 1)).toBe(Number.POSITIVE_INFINITY); // clamped to the edge
    // a crop that already moves (wipe: v0 = 0.5625) needs no zoom while the window fits
    expect(scaleToPlace(0.7, 0.5625)).toBe(1);
    expect(scaleToPlace(0.8, 0.5625)).toBeCloseTo(0.5625 / 0.4, 6);
    // a target above the middle
    expect(scaleToPlace(0.45, 1, 0.45)).toBe(1);
  });

  it('axisFocus / placedAt round-trip: the point lands on the target unless the window hits an edge', () => {
    for (const v of [0.5, 0.5625, 0.74, 0.9]) {
      for (const c of [0.3, 0.45, 0.5, 0.6]) {
        const f = axisFocus(c, v);
        if (c - v / 2 >= 0 && c + v / 2 <= 1) expect(placedAt(c, v, f)).toBeCloseTo(0.5, 3);
      }
    }
    expect(axisFocus(0.02, 0.5)).toBe(0); // near the left edge: clamped
    expect(axisFocus(0.99, 0.5)).toBe(1); // near the right edge: clamped
    expect(axisFocus(0.3, 1)).toBe(0.5); // nothing cropped
    expect(placedAt(0.3, 1, 0.5)).toBeCloseTo(0.3, 6);
  });

  it('focusForPoint with scale matches axisFocus', () => {
    const f = focusForPoint({ x: 0.6, y: 0.4 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, 1.25);
    expect(f.x).toBeCloseTo(axisFocus(0.6, 0.8), 3);
    expect(f.y).toBeCloseTo(axisFocus(0.4, 0.8), 3);
    expect(focusForPoint({ x: 0.6, y: 0.4 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it('coverScaleSize: even and never smaller than the region', () => {
    expect(coverScaleSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(coverScaleSize(1920, 1080, 1.35)).toEqual({ w: 2592, h: 1458 });
    expect(coverScaleSize(323, 323, 1.001)).toEqual({ w: 324, h: 324 });
    expect(coverScaleSize(100, 100, 0.5)).toEqual({ w: 100, h: 100 });
  });
});

describe('personFaceSamples', () => {
  it('skips frames without a confident face and broken boxes', () => {
    const tr: FaceTrack = { fps: 5, sourceFps: 30, frames: [
      { f: 0, t: 0, faces: [] },
      { f: 6, t: 0.2, faces: [{ x: 0.4, y: 0.4, w: 0.2, h: 0.2, score: 0.1 }] },
      { f: 12, t: 0.4, faces: [{ x: Number.NaN, y: 0.4, w: 0.2, h: 0.2, score: 0.9 }, { x: 0.4, y: 0.4, w: 0, h: 0.2, score: 0.9 }] },
      { f: 18, t: 0.6, faces: [{ x: 0.4, y: 0.4, w: 0.2, h: 0.2, score: 0.9 }] },
    ] };
    expect(personFaceSamples(tr)).toEqual([{ t: 0.6, x: 0.5, y: 0.5 }]);
    expect(personFaceSamples({ fps: 5, frames: [] })).toEqual([]);
  });

  it('several faces: the biggest first, then the same person while they stay nearly as big', () => {
    const big = { x: 0.2, y: 0.3, w: 0.2, h: 0.3, score: 0.9 }; // centre 0.3, 0.45
    const small = { x: 0.7, y: 0.3, w: 0.15, h: 0.25, score: 0.9 }; // centre 0.775, 0.425
    const tr: FaceTrack = { fps: 5, sourceFps: 30, frames: [
      { f: 0, t: 0, faces: [small, big] },
      // the other person leans in and is a bit bigger now: stay with the first person
      { f: 6, t: 0.2, faces: [{ ...small, w: 0.22, h: 0.32 }, big] },
      // the first person is gone: switch
      { f: 12, t: 0.4, faces: [small] },
    ] };
    const s = personFaceSamples(tr);
    expect(s.map((x) => x.x)).toEqual([expect.closeTo(0.3, 6), expect.closeTo(0.3, 6), expect.closeTo(0.775, 6)]);
  });
});

describe('faceCrop', () => {
  const samples = (x: number, y: number, sec = 3) => Array.from({ length: sec * 5 + 1 }, (_, i) => ({ t: i / 5, x, y }));
  const base = { fromSec: 0, toSec: 3, fps: 30, visible: { x: 1, y: 1 }, maxScale: 1.35 };

  it('no faces in the range → null (the shot is left alone)', () => {
    expect(faceCrop([], base)).toBeNull();
    expect(faceCrop(samples(0.5, 0.5).map((s) => ({ ...s, t: s.t + 10 })), base)).toBeNull();
  });

  it('a centred face needs no zoom', () => {
    const c = faceCrop(samples(0.5, 0.45), base)!;
    expect(c.scale).toBe(1);
    expect(c.focus).toEqual({ x: 0.5, y: 0.5 });
  });

  it('an off-centre face (the user’s take: x 0.73) is zoomed up to maxScale and moved as far as it goes', () => {
    const c = faceCrop(samples(0.73, 0.35), base)!;
    expect(c.scale).toBe(1.35);
    expect(c.focus).toEqual({ x: 1, y: axisFocus(0.35, 1 / 1.35, 0.45) });
    // the face is clearly closer to the middle than before (0.73 → ~0.64)
    const at = placedAt(0.73, 1 / 1.35, 1);
    expect(at).toBeLessThan(0.65);
    expect(at).toBeGreaterThan(0.5);
  });

  it('a slightly off-centre face is centred exactly with a small zoom', () => {
    const c = faceCrop(samples(0.55, 0.45), base)!;
    expect(c.scale).toBeCloseTo(1 / 0.9, 3);
    const f = c.focus as { x: number; y: number };
    expect(placedAt(0.55, 1 / c.scale, f.x)).toBeCloseTo(0.5, 2);
  });

  it('a face on the very edge does not blow the zoom past maxScale', () => {
    expect(faceCrop(samples(1, 0.5), base)!.scale).toBe(1.35);
    expect(faceCrop(samples(0, 0, 1), { ...base, toSec: 1 })!.focus).toEqual({ x: 0, y: 0 });
  });

  it('a moving face gives smoothed keyframes inside 0..1; one magnification for the whole shot', () => {
    const moving = Array.from({ length: 16 }, (_, i) => ({ t: i / 5, x: 0.4 + i * 0.02, y: 0.45 }));
    const c = faceCrop(moving, base)!;
    expect(Array.isArray(c.focus)).toBe(true);
    const keys = c.focus as { at: number; x: number; y: number }[];
    expect(keys[0]!.at).toBe(0);
    for (const k of keys) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(1);
      expect(k.at).toBeLessThan(90);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.x).toBeGreaterThanOrEqual(keys[i - 1]!.x - 1e-9); // follows to the right
  });

  it('maxScale 1 never zooms: the crop only moves where the aspect ratio crops (wipe)', () => {
    const c = faceCrop(samples(0.65, 0.35), { ...base, maxScale: 1, visible: { x: 0.5625, y: 1 } })!;
    expect(c.scale).toBe(1);
    const f = c.focus as { x: number; y: number };
    expect(placedAt(0.65, 0.5625, f.x)).toBeCloseTo(0.5, 2);
    expect(f.y).toBe(0.5);
    // 0.73 is past what the window can reach: it stops at the edge (face at 0.52 instead of 0.73)
    const edge = faceCrop(samples(0.73, 0.35), { ...base, maxScale: 1, visible: { x: 0.5625, y: 1 } })!;
    expect((edge.focus as { x: number }).x).toBe(1);
    expect(placedAt(0.73, 0.5625, 1)).toBeCloseTo(0.52, 2);
  });
});

describe('centerPerson', () => {
  const off = { faces: { cam: track(20, () => [{ x: 0.73, y: 0.35 }]) } };

  it('camera-full gets focus + scale; screen-full is untouched; the result validates', () => {
    const t = fixture();
    const { segments, report } = centerPerson(t, off);
    expect(report).toEqual({ centered: ['seg_a', 'seg_c'], noFace: [], noTrack: [] });
    expect(segments[0]!.video).toMatchObject({ layout: 'camera-full', camera: 'cam', scale: 1.35, focus: { x: 1 } });
    expect(segments[1]).toBe(t.segments[1]);
    const v = validateTimeline({ ...t, segments });
    expect(v.ok, JSON.stringify(v.issues)).toBe(true);
  });

  it('the wipe camera gets cameraFocus (+ cameraScale), the screen stays as it is', () => {
    const t = applyOp(fixture(), { op: 'setVideo', id: 'seg_b', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain' } }, decided: D }).timeline;
    const { segments } = centerPerson(t, off);
    const w = segments[1]!.video;
    expect(w.layout).toBe('screen-with-wipe');
    if (w.layout !== 'screen-with-wipe') return;
    expect(w.cameraFocus).toBeDefined();
    expect(w.cameraScale).toBeGreaterThan(1);
    expect(w.cameraScale).toBeLessThanOrEqual(1.6);
    // the face lands in the middle of the wipe (within a few pixels)
    const rg = videoRegions(segments[1]!, t.canvas).find((r) => r.kind === 'wipe')!;
    const f = w.cameraFocus as { x: number; y: number };
    const box = sourceRectToCanvas({ x: 0.73 * 1920, y: 0.35 * 1080, w: 1, h: 1 }, { width: 1920, height: 1080 }, rg.rect, 'cover', f, w.cameraScale);
    expect(Math.abs(box!.x - (rg.rect.x + rg.rect.w / 2))).toBeLessThan(rg.rect.w * 0.05);
    // and vertically just below the middle of the circle (a higher face would lose the top of the head)
    expect(Math.abs(box!.y - (rg.rect.y + rg.rect.h * 0.55))).toBeLessThan(rg.rect.h * 0.05);
    expect(validateTimeline({ ...t, segments }).ok).toBe(true);
  });

  it('no face track → reported, unchanged; no face in the range → reported, unchanged', () => {
    const t = fixture();
    expect(centerPerson(t, {}).report).toEqual({ centered: [], noFace: [], noTrack: ['seg_a', 'seg_c'] });
    const late = { faces: { cam: track(20, (s) => (s > 15 ? [{ x: 0.5, y: 0.5 }] : null)) } };
    const r = centerPerson(t, late);
    expect(r.report.noFace).toEqual(['seg_a']);
    expect(r.segments[0]).toBe(t.segments[0]);
  });

  it('running again replaces the earlier crop (idempotent); a centred face clears the scale', () => {
    const t = fixture();
    const once = { ...t, segments: centerPerson(t, off).segments };
    expect(centerPerson(once, off).segments).toEqual(once.segments);
    const centred = { faces: { cam: track(20, () => [{ x: 0.5, y: 0.45 }]) } };
    const v = centerPerson(once, centred).segments[0]!.video;
    expect(v).toEqual({ layout: 'camera-full', camera: 'cam', focus: { x: 0.5, y: 0.5 } });
  });

  it('compile renders the magnified cover crop (camera-full and wipe)', () => {
    const t = fixture();
    const c = { ...t, segments: centerPerson(t, off).segments };
    // preview is half size: 960x540 magnified 1.35 → 1296x730
    expect(fc(compile(c, opts).chunks[0]!.args)).toContain('scale=1296:730:force_original_aspect_ratio=increase,crop=960:540:(iw-ow)*1:');
    const w = applyOp(fixture(), { op: 'setVideo', id: 'seg_a', video: { layout: 'screen-with-wipe', screen: 'scr', camera: 'cam', wipe: { shape: 'circle', corner: 'br', style: 'plain', size: 0.3 } }, decided: D }).timeline;
    const wc = { ...w, segments: centerPerson(w, off).segments };
    const f = fc(compile(wc, opts).chunks[0]!.args);
    expect(f).toMatch(/scale=\d+:\d+:force_original_aspect_ratio=increase,crop=162:162:/);
    // without centring the plain cover crop is unchanged
    expect(fc(compile(t, opts).chunks[0]!.args)).toContain('scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1');
  });
});

describe('person camera (multicam without a decision model)', () => {
  const twoCams = (roles: [string, string]) => {
    const t = fixture();
    return {
      ...t,
      sources: {
        ...t.sources,
        cam: { ...(t.sources.cam as Extract<Timeline['sources'][string], { kind: 'camera' }>), role: roles[0] as 'front' },
        cam2: { ...(t.sources.cam as Extract<Timeline['sources'][string], { kind: 'camera' }>), path: 'media/cam2.mp4', role: roles[1] as 'front' },
      },
    } as Timeline;
  };

  it('role front (the recorder’s main camera) is the person; else the camera with the face seen most; else the first', () => {
    expect(personCamera(twoCams(['other', 'front']))).toBe('cam2');
    const t = twoCams(['other', 'other']);
    const mat = cameraMaterial(t, { faces: { cam2: track(20, () => [{ x: 0.5, y: 0.5 }]), cam: track(20, () => null) } });
    expect(personCamera(t, mat)).toBe('cam2');
    expect(personCamera(t)).toBe('cam');
    const none = fixture();
    expect(personCamera({ ...none, sources: { mic: none.sources.mic! } })).toBeNull();
  });

  it('suggestCameras keeps the person camera unless their face is hidden and another camera shows it (needsReview)', () => {
    const m = (cams: { id: string; faceVisible: number | null }[]): SegmentMaterial => ({
      segment: 'seg_x', take: 'take_1', durationSec: 3, current: 'cam', speaking: true, speechRatio: 1, words: 3, emphasisWords: [],
      cameras: cams.map((c) => ({ ...c, role: 'other', faceArea: null })),
    });
    expect(suggestCameras([m([{ id: 'cam', faceVisible: 0.9 }, { id: 'cam2', faceVisible: 1 }])], 'cam')[0]).toEqual({ segment: 'seg_x', camera: 'cam', reason: 'person', needsReview: false });
    expect(suggestCameras([m([{ id: 'cam', faceVisible: 0.1 }, { id: 'cam2', faceVisible: 0.9 }])], 'cam')[0]).toMatchObject({ camera: 'cam2', reason: 'person-face-hidden', needsReview: true });
    // boundary: 0.3 is visible enough; the other camera must be clearly better (+0.2)
    expect(suggestCameras([m([{ id: 'cam', faceVisible: 0.3 }, { id: 'cam2', faceVisible: 1 }])], 'cam')[0]!.camera).toBe('cam');
    expect(suggestCameras([m([{ id: 'cam', faceVisible: 0.1 }, { id: 'cam2', faceVisible: 0.25 }])], 'cam')[0]!.camera).toBe('cam');
    // unknown face data keeps the person camera
    expect(suggestCameras([m([{ id: 'cam', faceVisible: null }, { id: 'cam2', faceVisible: 1 }])], 'cam')[0]!.camera).toBe('cam');
    // the person camera is not in this take: the first one, unsure when there is a choice
    expect(suggestCameras([m([{ id: 'a', faceVisible: 1 }, { id: 'b', faceVisible: 1 }])], 'cam')[0]).toMatchObject({ camera: 'a', reason: 'only-camera', needsReview: true });
    expect(suggestCameras([m([])], 'cam')).toEqual([]);
  });
});
