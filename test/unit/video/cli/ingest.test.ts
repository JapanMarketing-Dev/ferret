import { describe, expect, it } from 'vitest';
import { CLOCK_SANITY_MS, cameraRoles, editFps, takeOffsets, trackStartMs, type TakeTrackClock } from '@video/cli/ingest.js';

// The clock values of a real take (take_20261011-154310, 2026-10-11): video tracks on performance.now(), the PCM
// tracks' first sample on the AudioContext clock (≈ -10.7 ms) — the cause of "starts 3986 frames before camera-1".
const REAL: { startedAtMs: number; tracks: TakeTrackClock[] } = {
  startedAtMs: 134834.30000000005,
  tracks: [
    { file: 'screen.mp4', kind: 'screen', fps: 30, firstFrameMs: 134872.30000000005, recorderStartMs: 134901.69999999995 },
    { file: 'system.wav', kind: 'system', recorderStartMs: 134847, firstFrameMs: -10.666666666666666 },
    { file: 'camera-1.mp4', kind: 'camera', fps: 30, firstFrameMs: 134864.8999999999, recorderStartMs: 134902.69999999995 },
    { file: 'camera-2.mp4', kind: 'camera', fps: 30, firstFrameMs: 134877.69999999995, recorderStartMs: 134907.09999999986 },
    { file: 'mic-1.wav', kind: 'mic', recorderStartMs: 134848.69999999995, firstFrameMs: -10.666666666666666 },
  ],
};

describe('trackStartMs', () => {
  it('uses the first frame when it is on the recorder clock', () => {
    expect(trackStartMs({ firstFrameMs: 1005, recorderStartMs: 1000 }, 900)).toBe(1005);
  });
  it('falls back to the recorder start when the first-sample time is on another clock', () => {
    expect(trackStartMs({ firstFrameMs: -10.7, recorderStartMs: 134848.7 }, 134834.3)).toBe(134848.7);
  });
  it('boundary: exactly CLOCK_SANITY_MS away is still trusted; 1 ms more is not', () => {
    expect(trackStartMs({ firstFrameMs: 1000 + CLOCK_SANITY_MS, recorderStartMs: 1000 }, undefined)).toBe(1000 + CLOCK_SANITY_MS);
    expect(trackStartMs({ firstFrameMs: 1001 + CLOCK_SANITY_MS, recorderStartMs: 1000 }, undefined)).toBe(1000);
    expect(trackStartMs({ firstFrameMs: 1000 - CLOCK_SANITY_MS - 1, recorderStartMs: 1000 }, undefined)).toBe(1000);
  });
  it('without a recorder start, the take start is the reference; without anything, undefined', () => {
    expect(trackStartMs({ firstFrameMs: -10 }, 50_000)).toBe(50_000);
    expect(trackStartMs({ firstFrameMs: 49_990 }, 50_000)).toBe(49_990);
    expect(trackStartMs({ firstFrameMs: 5 }, undefined)).toBe(5);
    expect(trackStartMs({}, undefined)).toBeUndefined();
    expect(trackStartMs({ recorderStartMs: 7 }, undefined)).toBe(7);
  });
  it('ignores non-finite numbers', () => {
    expect(trackStartMs({ firstFrameMs: Number.NaN, recorderStartMs: 10 }, undefined)).toBe(10);
    expect(trackStartMs({ firstFrameMs: Number.POSITIVE_INFINITY }, 3)).toBe(3);
  });
});

describe('takeOffsets', () => {
  it('real take: every track within 0.1 s of each other (not 134.8 s apart)', () => {
    const { t0, offsets } = takeOffsets(REAL.tracks, REAL.startedAtMs);
    expect(t0).toBeCloseTo(134848.7, 1); // the mic's recorder start, not -10.7
    expect(Object.keys(offsets).sort()).toEqual(['camera-1.mp4', 'camera-2.mp4', 'mic-1.wav', 'screen.mp4']); // system.wav left out
    for (const v of Object.values(offsets)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(0.1);
    }
    expect(offsets['mic-1.wav']).toBe(0);
    expect(offsets['camera-1.mp4']).toBeCloseTo(0.016, 3);
    expect(offsets['screen.mp4']).toBeCloseTo(0.024, 3);
    // in camera frames (30 fps) the cameras start within 1 frame of the mic: no black opening
    expect(Math.round(offsets['camera-1.mp4']! * 30)).toBe(0);
    expect(Math.round(offsets['camera-2.mp4']! * 30)).toBe(1);
  });
  it('system audio never moves t0, even when it starts first', () => {
    const r = takeOffsets([
      { file: 'system.wav', kind: 'system', firstFrameMs: 0 },
      { file: 'mic.wav', kind: 'mic', firstFrameMs: 500 },
      { file: 'cam.mp4', kind: 'camera', firstFrameMs: 750 },
    ], undefined);
    expect(r.t0).toBe(500);
    expect(r.offsets).toEqual({ 'mic.wav': 0, 'cam.mp4': 0.25 });
  });
  it('a track without any clock starts at 0; no tracks → t0 is the take start', () => {
    expect(takeOffsets([{ file: 'a.mp4', kind: 'camera' }, { file: 'b.wav', kind: 'mic', firstFrameMs: 100 }], undefined).offsets).toEqual({ 'a.mp4': 0, 'b.wav': 0 });
    expect(takeOffsets([], 42)).toEqual({ t0: 42, offsets: {} });
    expect(takeOffsets([], undefined)).toEqual({ t0: 0, offsets: {} });
  });
  it('offsets are millisecond-rounded and never negative', () => {
    const r = takeOffsets([{ file: 'a', kind: 'mic', firstFrameMs: 10.0004 }, { file: 'b', kind: 'camera', firstFrameMs: 1010.4996 }], undefined);
    expect(r.offsets).toEqual({ a: 0, b: 1 });
  });
});

describe('cameraRoles', () => {
  it("the recorder's main camera is the person (front), whatever its position", () => {
    expect(cameraRoles([
      { file: 'camera-1.mp4', kind: 'camera' },
      { file: 'camera-2.mp4', kind: 'camera', role: 'main' },
      { file: 'mic-1.wav', kind: 'mic', role: 'main' },
    ])).toEqual({ 'camera-1.mp4': 'other', 'camera-2.mp4': 'front' });
  });
  it('without a main camera the first is front; two mains → the first; no cameras → empty', () => {
    expect(cameraRoles([{ file: 'a', kind: 'camera' }, { file: 'b', kind: 'camera' }])).toEqual({ a: 'front', b: 'other' });
    expect(cameraRoles([{ file: 'a', kind: 'camera', role: 'main' }, { file: 'b', kind: 'camera', role: 'main' }])).toEqual({ a: 'front', b: 'other' });
    expect(cameraRoles([{ file: 's', kind: 'screen', role: 'main' }])).toEqual({});
  });
});

describe('editFps', () => {
  it('real screen: VFR average 6.39 fps → edit at the recorded 30 fps', () => {
    expect(editFps({ num: 3765000, den: 589553 }, 30, true)).toEqual({ num: 30, den: 1 });
  });
  it('a far-off average wins over a missing vfr flag only when there is a hint', () => {
    expect(editFps({ num: 6, den: 1 }, 30, false)).toEqual({ num: 30, den: 1 });
    expect(editFps({ num: 6, den: 1 }, undefined, true)).toEqual({ num: 6, den: 1 });
  });
  it('boundary: within 2 % of the hint keeps the probed rate (camera 29.86 for 30)', () => {
    expect(editFps({ num: 7176000, den: 240311 }, 30, false)).toEqual({ num: 7176000, den: 240311 });
    expect(editFps({ num: 2941, den: 100 }, 30, false)).toEqual({ num: 2941, den: 100 }); // just inside 2 %
    expect(editFps({ num: 2939, den: 100 }, 30, false)).toEqual({ num: 30, den: 1 }); // just outside
  });
  it('NTSC hints become exact rationals; nonsense rates fall back', () => {
    expect(editFps({ num: 15, den: 1 }, 29.97, true)).toEqual({ num: 30000, den: 1001 });
    expect(editFps({ num: 1000, den: 1 }, 30, false)).toEqual({ num: 30, den: 1 });
    expect(editFps({ num: 1000, den: 1 }, undefined, false)).toEqual({ num: 30, den: 1 });
    expect(editFps(undefined, 25, undefined)).toEqual({ num: 25, den: 1 });
    expect(editFps(undefined, 0, undefined)).toEqual({ num: 30, den: 1 });
    expect(editFps({ num: 30, den: 0 }, undefined, false)).toEqual({ num: 30, den: 1 });
    expect(editFps({ num: 24, den: 1 }, 500, true)).toEqual({ num: 24, den: 1 }); // a bad hint is ignored
  });
});
