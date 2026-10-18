import type { Rational } from '@video/core';
import { toRational } from '@video/templates';

// Pure helpers of `ferret-video ingest` (docs/03 「収録の時計」): where each track of a take starts on the shared clock, which
// camera is the person, and the frame rate to edit a recorder file at. Kept here so they can be tested without media.

/** A track of take.json as the desktop recorder writes it (apps/desktop/src/renderer/src/lib/recorder.ts). */
export interface TakeTrackClock {
  file: string;
  kind: 'screen' | 'camera' | 'mic' | 'system';
  fps?: number;
  /** performance.now() of the first frame / sample. Audio from an AudioContext can be on another clock (see below). */
  firstFrameMs?: number;
  /** performance.now() when the MediaRecorder / PCM capture started. */
  recorderStartMs?: number;
  /** 'main': the camera that shows the person (set by the recorder). */
  role?: string;
}

/**
 * A firstFrameMs further than this from the track's recorder start is on another clock. The PCM capture reports its
 * first sample through AudioContext.getOutputTimestamp(), which is 0 until audio output starts, so a mic track can say
 * firstFrameMs = -10.7 while every video track says ~134 872 (performance.now()). Taking that at face value put the
 * cameras and the screen 134.8 s after the mic (rendered as black). Same rule as the desktop's rawTake.trackStartMs.
 */
export const CLOCK_SANITY_MS = 2000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Where a track starts (ms, performance.now() clock): its first frame, unless that is clearly on another clock. */
export function trackStartMs(tr: Pick<TakeTrackClock, 'firstFrameMs' | 'recorderStartMs'>, startedAtMs: number | undefined): number | undefined {
  const first = finite(tr.firstFrameMs) ? tr.firstFrameMs : undefined;
  const ref = finite(tr.recorderStartMs) ? tr.recorderStartMs : finite(startedAtMs) ? startedAtMs : undefined;
  if (first !== undefined && (ref === undefined || Math.abs(first - ref) <= CLOCK_SANITY_MS)) return first;
  return ref;
}

/**
 * Seconds from the earliest track start to each track's start (≥ 0), by file. Tracks with no usable clock start at 0.
 * `system` audio is not part of the edit and does not move t0.
 */
export function takeOffsets(tracks: TakeTrackClock[], startedAtMs: number | undefined): { t0: number; offsets: Record<string, number> } {
  const used = tracks.filter((t) => t.kind !== 'system');
  const starts = new Map(used.map((t) => [t.file, trackStartMs(t, startedAtMs)] as const));
  const known = [...starts.values()].filter((x): x is number => x !== undefined);
  const t0 = known.length ? Math.min(...known) : finite(startedAtMs) ? startedAtMs : 0;
  const offsets: Record<string, number> = {};
  for (const t of used) {
    const ms = starts.get(t.file);
    offsets[t.file] = ms === undefined ? 0 : Math.round(ms - t0) / 1000;
  }
  return { t0, offsets };
}

/**
 * Source role per camera file: the recorder's `role: 'main'` camera is the person ('front'); without one, the first
 * camera is. Every other camera is 'other'. With several 'main' cameras the first wins.
 */
export function cameraRoles(tracks: Pick<TakeTrackClock, 'file' | 'kind' | 'role'>[]): Record<string, 'front' | 'other'> {
  const cams = tracks.filter((t) => t.kind === 'camera');
  const person = cams.find((t) => t.role === 'main') ?? cams[0];
  return Object.fromEntries(cams.map((t) => [t.file, t === person ? 'front' : 'other']));
}

/**
 * The frame rate to edit a file at. MediaRecorder writes variable frame rate; for a mostly still screen the average
 * rate can be 6 fps although it was recorded at 30. A CFR proxy at that average would drop frames and make the take
 * clock coarse, so the rate the recorder asked for (take.json `fps`) wins when the file is VFR or its average is off
 * by more than 2 %. Without a hint the probed rate is used; nonsense rates fall back to 30.
 */
export function editFps(probed: Rational | undefined, hint: number | undefined, vfr: boolean | undefined): Rational {
  const ok = (r: number) => r >= 1 && r <= 120;
  const hintOk = finite(hint) && ok(hint);
  if (probed && probed.den > 0 && ok(probed.num / probed.den)) {
    const rate = probed.num / probed.den;
    if (hintOk && (vfr || Math.abs(rate - hint) / hint > 0.02)) return toRational(hint);
    return probed;
  }
  return hintOk ? toRational(hint) : { num: 30, den: 1 };
}
