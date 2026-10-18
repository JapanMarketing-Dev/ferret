import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  formatElapsed, formatMegabytes, hasAnythingToRecord, initialSelection, litSegments, resolutionOf, selectionAfterDevices, videoFolderName
} from '../../../../src/video/app/shared/record/view'
import { ingestMessage, prefsFromSettings, recorderAssets } from '../../../../src/video/app/main/record/ipc'
import { defaultSettings } from '../../../../src/video/settings'
import { recordEn } from '../../../../src/shared/i18n/video/record.en'
import { recordJa } from '../../../../src/shared/i18n/video/record.ja'

describe('formatElapsed / formatMegabytes / litSegments', () => {
  it('mm:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(999)).toBe('00:00')
    expect(formatElapsed(61_000)).toBe('01:01')
    expect(formatElapsed(3_599_999)).toBe('59:59')
    expect(formatElapsed(3_600_000)).toBe('1:00:00')
    expect(formatElapsed(-5)).toBe('00:00')
    expect(formatElapsed(Number.NaN)).toBe('00:00')
  })
  it('megabytes', () => {
    expect(formatMegabytes(0)).toBe('0.0 MB')
    expect(formatMegabytes(12_345_678)).toBe('12.3 MB')
    expect(formatMegabytes(-1)).toBe('0.0 MB')
    expect(formatMegabytes(Number.NaN)).toBe('0.0 MB')
  })
  it('meter segments', () => {
    expect(litSegments(0, 12)).toBe(0)
    expect(litSegments(0.5, 12)).toBe(6)
    expect(litSegments(1, 12)).toBe(12)
    expect(litSegments(2, 12)).toBe(12)
    expect(litSegments(-1, 12)).toBe(0)
    expect(litSegments(1, 12, true)).toBe(0)
    expect(litSegments(Number.NaN, 12)).toBe(0)
  })
})

describe('resolutionOf', () => {
  it('nearest preset', () => {
    expect(resolutionOf(1920, 1080)).toBe('1080p')
    expect(resolutionOf(1280, 720)).toBe('720p')
    expect(resolutionOf(3840, 2160)).toBe('4k')
    expect(resolutionOf(2560, 1440)).toBe('1080p')
    expect(resolutionOf(640, 480)).toBe('720p')
  })
})

describe('selection', () => {
  const prefs = { camera: { deviceId: 'camB', width: 1920, height: 1080, fps: 30 as const }, micId: 'micZ', systemAudio: true }
  const devices = { cameras: [{ id: 'camA', label: 'A' }, { id: 'camB', label: 'B' }], mics: [{ id: 'micA', label: 'MV7' }] }
  const screens = [{ id: 'window:1:0', kind: 'window' as const }, { id: 'screen:2:0', kind: 'screen' as const }]

  it('starts from the saved camera, the first mic, the first screen', () => {
    expect(initialSelection(prefs, devices, screens, true)).toEqual({ screenSourceId: 'screen:2:0', cameraIds: ['camB'], mainCameraId: 'camB', micIds: ['micA'], systemAudio: true })
  })
  it('computer sound is off where it cannot be recorded', () => {
    expect(initialSelection(prefs, devices, screens, false).systemAudio).toBe(false)
  })
  it('works with no devices and no screens', () => {
    expect(initialSelection(prefs, { cameras: [], mics: [] }, [], true)).toEqual({ screenSourceId: null, cameraIds: [], mainCameraId: null, micIds: [], systemAudio: true })
    expect(hasAnythingToRecord(initialSelection({ ...prefs, systemAudio: false }, { cameras: [], mics: [] }, [], true))).toBe(false)
  })
  it('unplugging drops devices and moves the main camera', () => {
    const sel = { screenSourceId: null, cameraIds: ['camA', 'camB'], mainCameraId: 'camB', micIds: ['micA'], systemAudio: false }
    expect(selectionAfterDevices(sel, { cameras: [{ id: 'camA', label: '' }], mics: [] })).toEqual({ ...sel, cameraIds: ['camA'], mainCameraId: 'camA', micIds: [] })
    expect(selectionAfterDevices(sel, { cameras: [], mics: [] }).mainCameraId).toBeNull()
  })
  it('anything to record', () => {
    const none = { screenSourceId: null, cameraIds: [], mainCameraId: null, micIds: [], systemAudio: false }
    expect(hasAnythingToRecord(none)).toBe(false)
    expect(hasAnythingToRecord({ ...none, systemAudio: true })).toBe(true)
    expect(hasAnythingToRecord({ ...none, micIds: ['m'] })).toBe(true)
    expect(hasAnythingToRecord({ ...none, screenSourceId: 's' })).toBe(true)
  })
  it('video folder name', () => {
    expect(videoFolderName('/Users/me/Channel/2026-10-18-demo')).toBe('2026-10-18-demo')
    expect(videoFolderName('/Users/me/Channel/2026-10-18-demo/')).toBe('2026-10-18-demo')
    expect(videoFolderName('C:\\Videos\\2026-10-18-demo')).toBe('2026-10-18-demo')
    expect(videoFolderName('')).toBe('')
  })
})

describe('main helpers', () => {
  it('recorder pages are read from the asar, not the unpacked folder', () => {
    // join() uses the OS separator (backslashes on Windows), so the expected paths are built the same way
    const asar = '/Applications/Ferret.app/Contents/Resources/app.asar/out'
    expect(recorderAssets('/Applications/Ferret.app/Contents/Resources/app.asar.unpacked/out')).toEqual({
      html: join(asar, 'video-recorder', 'index.html'),
      region: join(asar, 'video-recorder', 'region.html'),
      preload: join(asar, 'preload', 'videoRecorder.js')
    })
    expect(recorderAssets('/dev/ferret/out').html).toBe(join('/dev/ferret/out', 'video-recorder', 'index.html'))
  })
  it('ingest messages: last line, progress lines skipped', () => {
    expect(ingestMessage({ code: 0, stdout: 'a\nregistered 3 source(s)\n', stderr: '' })).toEqual({ ok: true, message: 'registered 3 source(s)' })
    expect(ingestMessage({ code: 2, stdout: '', stderr: '{"progress":0.5}\nffprobe not found\n' })).toEqual({ ok: false, message: 'ffprobe not found' })
    expect(ingestMessage({ code: 1, stdout: 'not a project', stderr: '' })).toEqual({ ok: false, message: 'not a project' })
    expect(ingestMessage({ code: 3, stdout: '', stderr: '' })).toEqual({ ok: false, message: 'exit 3' })
  })
  it('prefs from the default video settings', () => {
    expect(prefsFromSettings(defaultSettings())).toEqual({
      screenFps: 30,
      camera: { deviceId: 'default', width: 1920, height: 1080, fps: 30 },
      micId: 'default',
      systemAudio: true,
      region: null,
      autoStart: true,
      hotkeys: { ng: 'CmdOrCtrl+Shift+N', important: 'CmdOrCtrl+Shift+M' }
    })
  })
})

describe('record strings', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
  it('every key has Japanese, non-empty, with the same placeholders', () => {
    for (const [key, en] of Object.entries(recordEn)) {
      const ja = (recordJa as Record<string, string>)[key]
      expect(ja, key).toBeTruthy()
      expect(placeholders(ja!), key).toEqual(placeholders(en))
    }
    expect(Object.keys(recordJa).sort()).toEqual(Object.keys(recordEn).sort())
  })
  it('all keys are under video.record.', () => {
    for (const key of Object.keys(recordEn)) expect(key.startsWith('video.record.')).toBe(true)
  })
})
