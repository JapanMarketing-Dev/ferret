import { describe, expect, it } from 'vitest'
import {
  CAMERA_BITRATE, CHUNK_MS, MAX_CAMERAS, PlanError, SCREEN_BITRATE, allowedTrackFiles, buildStartPayload, cleanCameraFormat, cleanCountdown, cleanDevices, cleanFps,
  cleanPreview, displayOfSource, type PlanEnv
} from '../../../../src/video/app/shared/record/plan'
import type { RecordPlan } from '../../../../src/video/app/shared/record/types'

const env = (over: Partial<PlanEnv> = {}): PlanEnv => ({
  takeId: 'take_20261018-101500',
  createdAt: '2026-10-18T01:15:00.000Z',
  app: { version: '0.6.31', os: 'darwin' },
  sources: [
    { id: 'screen:1:0', kind: 'screen', displayId: '1' },
    { id: 'screen:2:0', kind: 'screen', displayId: '2' },
    { id: 'window:77:0', kind: 'window' }
  ],
  displays: [
    { id: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
    { id: '2', bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  ],
  devices: {
    cameras: [{ id: 'camA', label: 'FaceTime HD' }, { id: 'camB', label: 'Sony ZV-1' }, { id: 'camC', label: '' }, { id: 'camD', label: 'D' }, { id: 'camE', label: 'E' }],
    mics: [{ id: 'micA', label: 'Shure MV7' }, { id: 'micB', label: 'Built-in' }]
  },
  region: null,
  systemAudioSupported: true,
  messages: { trackEnded: 'a', micFailed: 'b', cameraFailed: 'c', screenFailed: 'd', systemAudioFailed: 'e' },
  ...over
})

const plan = (over: Partial<RecordPlan> = {}): RecordPlan => ({
  videoDir: '/ch/2026-10-18-demo',
  screen: { sourceId: 'screen:1:0' },
  cameraIds: ['camB', 'camA'],
  micIds: ['micA'],
  systemAudio: false,
  screenFps: 30,
  camera: { width: 1920, height: 1080, fps: 30 },
  countdownSec: 3,
  ...over
})

const problem = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof PlanError) return err.problem
    throw err
  }
  return null
}

describe('buildStartPayload', () => {
  it('builds the full plan: main camera first as camera-1, mic-1.wav, screen at display pixels', () => {
    const p = buildStartPayload(plan(), env())
    expect(p.takeId).toBe('take_20261018-101500')
    expect(p.chunkMs).toBe(CHUNK_MS)
    expect(p.screen).toMatchObject({ base: 'screen', sourceId: 'screen:1:0', fps: 30, maxWidth: 2880, maxHeight: 1800, region: null, videoBitsPerSecond: SCREEN_BITRATE })
    expect(p.screen!.display!.id).toBe('1')
    expect(p.cameras.map((c) => [c.base, c.deviceId, c.main, c.label])).toEqual([['camera-1', 'camB', true, 'Sony ZV-1'], ['camera-2', 'camA', false, 'FaceTime HD']])
    expect(p.cameras[0]!.videoBitsPerSecond).toBe(CAMERA_BITRATE)
    expect(p.mics).toEqual([{ file: 'mic-1.wav', deviceId: 'micA', label: 'Shure MV7' }])
    expect(p.systemAudio).toBeNull()
  })

  it('applies the saved region of the chosen display', () => {
    const region = { displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }
    expect(buildStartPayload(plan(), env({ region })).screen!.region).toEqual(region)
  })

  it('a region of another display, a whole-display region or garbage means the whole screen', () => {
    expect(buildStartPayload(plan(), env({ region: { displayId: '2', x: 0, y: 0, width: 100, height: 100 } })).screen!.region).toBeNull()
    expect(buildStartPayload(plan(), env({ region: { displayId: '1', x: 0, y: 0, width: 2880, height: 1800 } })).screen!.region).toBeNull()
    expect(buildStartPayload(plan(), env({ region: 'nope' })).screen!.region).toBeNull()
  })

  it('a window has no display and no region, and is captured up to 4K', () => {
    const p = buildStartPayload(plan({ screen: { sourceId: 'window:77:0' } }), env({ region: { displayId: '1', x: 0, y: 50, width: 2880, height: 1700 } }))
    expect(p.screen).toMatchObject({ display: null, region: null, maxWidth: 3840, maxHeight: 2160 })
  })

  it('a screen that is no longer listed is refused', () => {
    expect(problem(() => buildStartPayload(plan({ screen: { sourceId: 'screen:9:0' } }), env()))).toBe('screenMissing')
    expect(problem(() => buildStartPayload(plan(), env({ sources: [] })))).toBe('screenMissing')
  })

  it('a camera or mic that was unplugged is refused', () => {
    expect(problem(() => buildStartPayload(plan({ cameraIds: ['camZ'] }), env()))).toBe('cameraMissing')
    expect(problem(() => buildStartPayload(plan({ micIds: ['micZ'] }), env()))).toBe('micMissing')
  })

  it('caps the number of cameras and mics', () => {
    expect(problem(() => buildStartPayload(plan({ cameraIds: ['camA', 'camB', 'camC', 'camD', 'camE'] }), env()))).toBe('tooManyCameras')
    const many = { cameras: [], mics: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, label: '' })) }
    expect(problem(() => buildStartPayload(plan({ cameraIds: [], micIds: many.mics.map((m) => m.id) }), env({ devices: many })))).toBe('tooManyMics')
    expect(buildStartPayload(plan({ cameraIds: ['camA', 'camB', 'camC', 'camD'] }), env()).cameras).toHaveLength(MAX_CAMERAS)
  })

  it('removes duplicate ids', () => {
    const p = buildStartPayload(plan({ cameraIds: ['camA', 'camA', 'camB'], micIds: ['micA', 'micA'] }), env())
    expect(p.cameras.map((c) => c.deviceId)).toEqual(['camA', 'camB'])
    expect(p.mics).toHaveLength(1)
  })

  it('nothing to record is refused', () => {
    expect(problem(() => buildStartPayload(plan({ screen: null, cameraIds: [], micIds: [], systemAudio: false }), env()))).toBe('nothingSelected')
  })

  it('only the computer sound is fine', () => {
    const p = buildStartPayload(plan({ screen: null, cameraIds: [], micIds: [], systemAudio: true }), env())
    expect(p.systemAudio).toEqual({ file: 'system.wav' })
  })

  it('computer sound on an OS that cannot record it is refused', () => {
    expect(problem(() => buildStartPayload(plan({ systemAudio: true }), env({ systemAudioSupported: false })))).toBe('systemAudioUnsupported')
  })

  it('cleans the format and frame rate', () => {
    const p = buildStartPayload(plan({ screenFps: 999 as never, camera: { width: 99999, height: -5, fps: 7 as never } }), env())
    expect(p.screen!.fps).toBe(30)
    expect(p.cameras[0]).toMatchObject({ width: 3840, height: 240, fps: 30 })
  })

  it('an unlabeled camera gets a short id label', () => {
    expect(buildStartPayload(plan({ cameraIds: ['camC'] }), env()).cameras[0]!.label).toBe('camC')
  })

  it('ignores non-string ids from the screen', () => {
    const p = buildStartPayload(plan({ cameraIds: [42, null, 'camA'] as never, micIds: 'micA' as never }), env())
    expect(p.cameras.map((c) => c.deviceId)).toEqual(['camA'])
    expect(p.mics).toEqual([])
  })
})

describe('allowedTrackFiles', () => {
  it('lists every planned file, video in either container', () => {
    const files = allowedTrackFiles(buildStartPayload(plan({ systemAudio: true }), env()))
    expect([...files.entries()].sort()).toEqual([
      ['camera-1.mp4', 'camera'], ['camera-1.webm', 'camera'], ['camera-2.mp4', 'camera'], ['camera-2.webm', 'camera'],
      ['mic-1.wav', 'mic'], ['screen.mp4', 'screen'], ['screen.webm', 'screen'], ['system.wav', 'system']
    ])
  })
})

describe('displayOfSource', () => {
  const displays = env().displays
  it('uses the source display id, or the one in the id', () => {
    expect(displayOfSource({ id: 'screen:2:0', kind: 'screen', displayId: '2' }, displays)!.id).toBe('2')
    expect(displayOfSource({ id: 'screen:1:0', kind: 'screen' }, displays)!.id).toBe('1')
  })
  it('null for windows and unknown displays', () => {
    expect(displayOfSource({ id: 'window:1:0', kind: 'window' }, displays)).toBeNull()
    expect(displayOfSource({ id: 'screen:5:0', kind: 'screen' }, displays)).toBeNull()
  })
})

describe('cleaners', () => {
  it('fps', () => {
    expect(cleanFps(60)).toBe(60)
    expect(cleanFps(24)).toBe(24)
    expect(cleanFps(31)).toBe(30)
    expect(cleanFps('60')).toBe(30)
    expect(cleanFps(undefined, 25)).toBe(25)
  })
  it('countdown is 0, 3, 5 or 10', () => {
    expect(cleanCountdown(0)).toBe(0)
    expect(cleanCountdown(10)).toBe(10)
    expect(cleanCountdown(4)).toBe(3)
    expect(cleanCountdown(-1)).toBe(3)
    expect(cleanCountdown('5')).toBe(3)
  })
  it('camera format defaults and clamps', () => {
    expect(cleanCameraFormat(null)).toEqual({ width: 1920, height: 1080, fps: 30 })
    expect(cleanCameraFormat({ width: 1280.4, height: 720.6, fps: 60 })).toEqual({ width: 1280, height: 721, fps: 60 })
    expect(cleanCameraFormat({ width: Number.NaN, height: Number.POSITIVE_INFINITY })).toEqual({ width: 1920, height: 1080, fps: 30 })
  })
  it('preview keeps only known devices and screens', () => {
    const d = env().devices
    expect(cleanPreview({ screenSourceId: 'screen:1:0', cameraIds: ['camA', 'x'], micIds: ['micB', 'micB'], camera: { width: 1280, height: 720, fps: 30 } }, d, env().sources))
      .toEqual({ screenSourceId: 'screen:1:0', cameraIds: ['camA'], micIds: ['micB'], camera: { width: 1280, height: 720, fps: 30 } })
    expect(cleanPreview({ screenSourceId: 'screen:9:0' }, d, env().sources).screenSourceId).toBeNull()
    expect(cleanPreview('garbage', d, null)).toEqual({ screenSourceId: null, cameraIds: [], micIds: [], camera: { width: 1920, height: 1080, fps: 30 } })
  })
  it('devices from the recorder window are checked', () => {
    expect(cleanDevices({ cameras: [{ id: 'a', label: 'A' }, { id: 'a', label: 'dup' }, { id: '', label: 'x' }, { id: 5 }, null], mics: [{ id: 'm' }] }))
      .toEqual({ cameras: [{ id: 'a', label: 'A' }], mics: [{ id: 'm', label: '' }] })
    expect(cleanDevices(null)).toEqual({ cameras: [], mics: [] })
    expect(cleanDevices({ cameras: 'x' })).toEqual({ cameras: [], mics: [] })
    expect(cleanDevices({ cameras: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, label: '' })) }).cameras.length).toBe(64)
  })
})
