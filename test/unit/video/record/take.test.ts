import { describe, expect, it } from 'vitest'
import {
  CLOCK_SANITY_MS, MAX_TRACKS, addMarker, countMarkers, createTakeMeta, finalizeTake, isTrackFile, newTakeId, sanitizeTakeMeta, trackFileName,
  trackOffsetsSec, trackStartMs, type TakeMeta
} from '../../../../src/video/app/shared/record/take'

const base = () => createTakeMeta({ id: 'take_20261018-101500', createdAt: '2026-10-18T01:15:00.000Z', timeOrigin: 1_760_000_000_000, startedAtMs: 1000, app: { version: '0.6.31', os: 'darwin' } })

describe('newTakeId', () => {
  it('is take_<YYYYMMDD-HHMMSS> in local time', () => {
    expect(newTakeId(new Date(2026, 9, 18, 9, 5, 7))).toBe('take_20261018-090507')
    expect(newTakeId(new Date(2026, 0, 1, 0, 0, 0))).toBe('take_20260101-000000')
  })
})

describe('track file names', () => {
  it('names each kind', () => {
    expect(trackFileName('screen', 1, 'mp4')).toBe('screen.mp4')
    expect(trackFileName('camera', 1, 'webm')).toBe('camera-1.webm')
    expect(trackFileName('camera', 3, 'mp4')).toBe('camera-3.mp4')
    expect(trackFileName('mic', 2, 'mp4')).toBe('mic-2.wav')
    expect(trackFileName('system', 1, 'webm')).toBe('system.wav')
  })
  it('refuses a wav video and bad indices', () => {
    expect(() => trackFileName('camera', 1, 'wav')).toThrow()
    expect(() => trackFileName('screen', 1, 'wav')).toThrow()
    expect(() => trackFileName('camera', 0, 'mp4')).toThrow()
    expect(() => trackFileName('mic', 1.5, 'wav')).toThrow()
    expect(() => trackFileName('mic', 100, 'wav')).toThrow()
  })
  it.each(['screen.mp4', 'screen.webm', 'camera-1.mp4', 'camera-12.webm', 'mic-1.wav', 'system.wav'])('accepts %s', (f) => {
    expect(isTrackFile(f)).toBe(true)
  })
  it.each(['../screen.mp4', 'screen.mov', 'camera.mp4', 'camera-123.mp4', 'mic.wav', 'system.mp4x', 'take.json', 'cursor.jsonl', '', 'a/b.wav', 'screen.mp4\0', 42, null])(
    'rejects %s', (f) => {
      expect(isTrackFile(f)).toBe(false)
    }
  )
})

describe('take.json building', () => {
  it('starts incomplete with no tracks or markers', () => {
    const m = base()
    expect(m).toMatchObject({ schema: 1, tracks: [], markers: [], complete: false })
    expect(m.stoppedAtMs).toBeUndefined()
  })
  it('adds markers relative to the start without mutating', () => {
    const m = base()
    const a = addMarker(m, 'ng', 3500)
    const b = addMarker(a, 'important', 4000)
    expect(m.markers).toEqual([])
    expect(b.markers).toEqual([{ kind: 'ng', atMs: 3500, sinceStartMs: 2500 }, { kind: 'important', atMs: 4000, sinceStartMs: 3000 }])
    expect(countMarkers(b.markers)).toEqual({ ng: 1, important: 1 })
  })
  it('a marker before the start is at 0', () => {
    expect(addMarker(base(), 'ng', 10).markers[0]!.sinceStartMs).toBe(0)
  })
  it('finalizes with a stop time not before the start', () => {
    expect(finalizeTake(base(), 9000)).toMatchObject({ stoppedAtMs: 9000, complete: true })
    expect(finalizeTake(base(), 10).stoppedAtMs).toBe(1000)
  })
})

describe('track clock', () => {
  it('uses the first frame when it is near the recorder start', () => {
    expect(trackStartMs({ firstFrameMs: 1100, recorderStartMs: 1050 }, 1000)).toBe(1100)
  })
  it('falls back to the recorder start when the first frame is on another clock', () => {
    expect(trackStartMs({ firstFrameMs: 1050 + CLOCK_SANITY_MS + 1, recorderStartMs: 1050 }, 1000)).toBe(1050)
    expect(trackStartMs({ firstFrameMs: -5000, recorderStartMs: 1050 }, 1000)).toBe(1050)
  })
  it('falls back to the take start without a recorder start', () => {
    expect(trackStartMs({}, 1000)).toBe(1000)
    expect(trackStartMs({ firstFrameMs: 5000 }, 1000)).toBe(1000)
    expect(trackStartMs({ firstFrameMs: 5000 }, undefined)).toBe(5000)
    expect(trackStartMs({}, undefined)).toBeUndefined()
  })
  it('offsets are seconds from the earliest track', () => {
    const offsets = trackOffsetsSec({
      startedAtMs: 1000,
      tracks: [
        { file: 'screen.mp4', kind: 'screen', firstFrameMs: 1200, recorderStartMs: 1010 },
        { file: 'camera-1.mp4', kind: 'camera', firstFrameMs: 1050, recorderStartMs: 1020 },
        { file: 'mic-1.wav', kind: 'mic', firstFrameMs: 1550, recorderStartMs: 1030 }
      ]
    })
    expect(offsets).toEqual({ 'screen.mp4': 0.15, 'camera-1.mp4': 0, 'mic-1.wav': 0.5 })
  })
  it('no tracks → no offsets', () => {
    expect(trackOffsetsSec({ startedAtMs: 0, tracks: [] })).toEqual({})
  })
})

describe('sanitizeTakeMeta', () => {
  const id = 'take_20261018-101500'
  const good = (): TakeMeta => ({
    ...base(),
    tracks: [
      { file: 'screen.mp4', kind: 'screen', mimeType: 'video/mp4;codecs=avc1', width: 2880, height: 1700, fps: 30, crop: { displayId: '1', x: 0, y: 50, width: 2880, height: 1700, sourceWidth: 2880, sourceHeight: 1800 } },
      { file: 'camera-1.mp4', kind: 'camera', role: 'main', device: 'abc', label: 'FaceTime', fps: 30, firstFrameMs: 1100, recorderStartMs: 1050 },
      { file: 'mic-1.wav', kind: 'mic', sampleRate: 48000, channels: 1, bytes: 96000 },
      { file: 'system.wav', kind: 'system', sampleRate: 48000, channels: 2 }
    ],
    markers: [{ kind: 'ng', atMs: 2000, sinceStartMs: 1000 }]
  })
  it('keeps a valid take.json as is', () => {
    expect(sanitizeTakeMeta(good(), id)).toEqual(good())
  })
  it('keeps stoppedAtMs and complete', () => {
    expect(sanitizeTakeMeta({ ...good(), stoppedAtMs: 5000, complete: true }, id)).toMatchObject({ stoppedAtMs: 5000, complete: true })
  })
  it('refuses another take, a bad id and non-objects', () => {
    expect(sanitizeTakeMeta(good(), 'take_other')).toBeNull()
    expect(sanitizeTakeMeta({ ...good(), id: '../x' }, '../x')).toBeNull()
    for (const v of [null, undefined, 'x', 1, [good()]]) expect(sanitizeTakeMeta(v, id)).toBeNull()
  })
  it('refuses a take without clock values', () => {
    expect(sanitizeTakeMeta({ ...good(), startedAtMs: undefined }, id)).toBeNull()
    expect(sanitizeTakeMeta({ ...good(), timeOrigin: Number.NaN }, id)).toBeNull()
    expect(sanitizeTakeMeta({ ...good(), startedAtMs: -1 }, id)).toBeNull()
  })
  it('drops tracks with unsafe or mismatched names', () => {
    const m = sanitizeTakeMeta({
      ...good(),
      tracks: [
        { file: '../../etc/passwd', kind: 'mic' },
        { file: 'camera-1.wav', kind: 'camera' },
        { file: 'mic-1.mp4', kind: 'mic' },
        { file: 'screen.mp4', kind: 'camera' },
        { file: 'mic-1.wav', kind: 'speaker' },
        { file: 'mic-2.wav', kind: 'mic' },
        null,
        'x'
      ]
    }, id)!
    expect(m.tracks).toEqual([{ file: 'mic-2.wav', kind: 'mic' }])
  })
  it('drops duplicate files (first wins) and caps the number of tracks', () => {
    const dup = sanitizeTakeMeta({ ...good(), tracks: [{ file: 'mic-1.wav', kind: 'mic', label: 'a' }, { file: 'mic-1.wav', kind: 'mic', label: 'b' }] }, id)!
    expect(dup.tracks).toEqual([{ file: 'mic-1.wav', kind: 'mic', label: 'a' }])
    const many = Array.from({ length: 40 }, (_, i) => ({ file: `mic-${i + 1}.wav`, kind: 'mic' }))
    expect(sanitizeTakeMeta({ ...good(), tracks: many }, id)!.tracks.length).toBeLessThanOrEqual(MAX_TRACKS)
  })
  it('drops wrong-typed fields but keeps the track', () => {
    const m = sanitizeTakeMeta({ ...good(), tracks: [{ file: 'camera-1.mp4', kind: 'camera', width: 'big', fps: -3, role: 'boss', firstFrameMs: Number.NaN, label: 42, extra: 'x' }] }, id)!
    expect(m.tracks).toEqual([{ file: 'camera-1.mp4', kind: 'camera' }])
  })
  it('role main only for cameras, crop only for the screen', () => {
    const m = sanitizeTakeMeta({ ...good(), tracks: [{ file: 'mic-1.wav', kind: 'mic', role: 'main', crop: { displayId: '1', x: 0, y: 0, width: 10, height: 10 } }] }, id)!
    expect(m.tracks[0]).toEqual({ file: 'mic-1.wav', kind: 'mic' })
  })
  it('drops a malformed crop', () => {
    const m = sanitizeTakeMeta({ ...good(), tracks: [{ file: 'screen.webm', kind: 'screen', crop: { displayId: '', x: 0, y: 0, width: 10, height: 10 } }] }, id)!
    expect(m.tracks[0]!.crop).toBeUndefined()
  })
  it('keeps valid markers and drops the rest', () => {
    const m = sanitizeTakeMeta({ ...good(), markers: [{ kind: 'ng', atMs: 2000 }, { kind: 'oops', atMs: 1 }, { kind: 'important', atMs: Number.NaN }, null, { kind: 'important', atMs: 3000, sinceStartMs: 2000 }] }, id)!
    expect(m.markers).toEqual([{ kind: 'ng', atMs: 2000, sinceStartMs: 1000 }, { kind: 'important', atMs: 3000, sinceStartMs: 2000 }])
  })
  it('complete must be exactly true', () => {
    expect(sanitizeTakeMeta({ ...good(), complete: 'yes' }, id)!.complete).toBe(false)
  })
  it('missing arrays are empty', () => {
    expect(sanitizeTakeMeta({ ...good(), tracks: 'x', markers: undefined }, id)).toMatchObject({ tracks: [], markers: [] })
  })
  it('long strings are cut', () => {
    const m = sanitizeTakeMeta({ ...good(), tracks: [{ file: 'mic-1.wav', kind: 'mic', label: 'x'.repeat(5000) }] }, id)!
    expect(m.tracks[0]!.label!.length).toBeLessThanOrEqual(200)
  })
})
