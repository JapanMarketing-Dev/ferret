import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordSession, type RecorderLink, type RecorderLinkHandlers, type SessionDeps } from '../../../../src/video/app/main/record/session'
import { TakeWriter } from '../../../../src/video/app/main/record/takeWriter'
import { videoCaptureActive } from '../../../../src/video/app/main/record/captureLock'
import { addMarker, createTakeMeta, type TakeMeta } from '../../../../src/video/app/shared/record/take'
import type { RecordPlan, RecordStatus, RecorderStartPayload } from '../../../../src/video/app/shared/record/types'

/** 録画ウインドウの代わり。始めると、渡された計画のトラックを開いて時計を返す */
class FakeLink implements RecorderLink {
  alive = true
  handlers: RecorderLinkHandlers
  payload: RecorderStartPayload | null = null
  marks: string[] = []
  previews: unknown[] = []
  meta: TakeMeta | null = null
  startError: Error | null = null
  stopResult: 'meta' | 'null' | 'throw' = 'meta'
  openError: string | null = null
  disposed = false

  constructor(handlers: RecorderLinkHandlers, private readonly devices: unknown) {
    this.handlers = handlers
  }

  async open() {}
  async enumerate() {
    return this.devices
  }
  preview(sel: unknown) {
    this.previews.push(sel)
  }
  async start(payload: RecorderStartPayload) {
    this.payload = payload
    if (this.startError) throw this.startError
    this.meta = createTakeMeta({ id: payload.takeId, createdAt: payload.createdAt, timeOrigin: 1_760_000_000_000, startedAtMs: 500, app: payload.app })
    const open = (file: string, kind: 'screen' | 'camera' | 'mic' | 'system', wav?: { sampleRate: number; channels: number }) => {
      this.handlers.openTrack({ file, kind, ...(wav ? { wav } : {}) })
      this.meta!.tracks.push({ file, kind, recorderStartMs: 510 })
    }
    if (payload.screen) open(`${payload.screen.base}.webm`, 'screen')
    for (const c of payload.cameras) open(`${c.base}.webm`, 'camera')
    for (const m of payload.mics) open(m.file, 'mic', { sampleRate: 48000, channels: 1 })
    if (payload.systemAudio) open(payload.systemAudio.file, 'system', { sampleRate: 48000, channels: 2 })
    this.handlers.meta(this.meta)
    return { startedAtMs: 500, timeOrigin: 1_760_000_000_000 }
  }
  mark(kind: 'ng' | 'important') {
    this.marks.push(kind)
    this.meta = addMarker(this.meta!, kind, 1500)
    this.handlers.meta(this.meta)
  }
  async stop() {
    if (this.stopResult === 'throw') throw new Error('stop failed')
    if (this.stopResult === 'null') return null
    return { ...this.meta!, stoppedAtMs: 9_500, complete: true }
  }
  dispose() {
    this.disposed = true
    this.alive = false
  }
}

let root: string
let videoDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ferret-video-session-'))
  videoDir = join(root, '2026-10-18-demo')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function setup(over: Partial<SessionDeps> = {}) {
  const statuses: RecordStatus[] = []
  const reports: string[] = []
  const hotkeys = new Map<string, () => void>()
  const links: FakeLink[] = []
  const cursorCalls: unknown[][] = []
  const devices = { cameras: [{ id: 'camA', label: 'FaceTime' }, { id: 'camB', label: 'ZV-1' }], mics: [{ id: 'micA', label: 'MV7' }] }
  let review = false
  let gesture = true
  const deps: SessionDeps = {
    createLink: (h) => {
      const link = new FakeLink(h, devices)
      links.push(link)
      return link
    },
    writer: new TakeWriter(() => new Date(2026, 9, 18, 10, 15, 0)),
    cursor: {
      start: (...args: unknown[]) => {
        cursorCalls.push(['start', ...args])
        return { file: 'cursor.jsonl', hz: 30, displayId: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, window: false }
      },
      stop: (id: string) => { cursorCalls.push(['stop', id]) }
    },
    listSources: async () => [{ id: 'screen:1:0', kind: 'screen', displayId: '1' }],
    displays: () => [{ id: '1', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }],
    systemAudioSupported: () => true,
    reviewRecording: () => review,
    consumeGesture: () => gesture,
    resolveVideoDir: (dir) => {
      if (dir !== videoDir) throw new Error('outside the channel')
      return videoDir
    },
    runIngest: vi.fn(async () => ({ ok: true, message: 'registered 3 source(s)' })),
    region: () => null,
    autoStart: () => true,
    hotkeys: { ng: 'CmdOrCtrl+Shift+N', important: 'CmdOrCtrl+Shift+M' },
    registerHotkey: (accel, fn) => { hotkeys.set(accel, fn); return true },
    unregisterHotkey: (accel) => { hotkeys.delete(accel) },
    emitStatus: (s) => statuses.push(s),
    emitLevels: () => undefined,
    emitFrame: () => undefined,
    emitDevices: () => undefined,
    wait: async () => undefined,
    now: () => new Date(2026, 9, 18, 10, 15, 0),
    app: { version: '0.6.31', os: 'darwin' },
    report: (_err, op) => { reports.push(op) },
    ...over
  }
  const session = new RecordSession(deps)
  return {
    session, deps, statuses, reports, hotkeys, links, cursorCalls,
    setReview: (v: boolean) => { review = v },
    setGesture: (v: boolean) => { gesture = v },
    link: () => links[links.length - 1]!
  }
}

const plan = (over: Partial<RecordPlan> = {}): RecordPlan => ({
  videoDir,
  screen: { sourceId: 'screen:1:0' },
  cameraIds: ['camB', 'camA'],
  micIds: ['micA'],
  systemAudio: false,
  screenFps: 30,
  camera: { width: 1920, height: 1080, fps: 30 },
  countdownSec: 0,
  ...over
})

const takeDir = () => join(videoDir, 'media', 'takes', 'take_20261018-101500')
const takeJson = () => JSON.parse(readFileSync(join(takeDir(), 'take.json'), 'utf8')) as TakeMeta

describe('RecordSession: the whole take', () => {
  it('records every track to its own file, writes take.json, ingests and reports autoStart', async () => {
    const s = setup()
    await s.session.prepare()
    const started = await s.session.start(plan({ systemAudio: true }))
    expect(started).toEqual({ takeId: 'take_20261018-101500' })
    expect(s.session.current).toMatchObject({ state: 'recording', takeId: 'take_20261018-101500', tracks: 5 })
    expect(videoCaptureActive()).toBe(true)

    s.link().handlers.chunk('screen.webm', new Uint8Array([1, 2, 3]))
    s.link().handlers.chunk('camera-1.webm', new Uint8Array([4]))
    s.link().handlers.chunk('mic-1.wav', new Uint8Array(4))
    expect(readdirSync(takeDir()).sort()).toEqual(['camera-1.webm', 'camera-2.webm', 'mic-1.wav', 'screen.webm', 'system.wav', 'take.json'])

    const result = await s.session.stop()
    expect(result).toMatchObject({ takeId: 'take_20261018-101500', videoDir, ingest: { ok: true }, autoStart: true })
    expect(s.deps.runIngest).toHaveBeenCalledWith(videoDir)
    expect(videoCaptureActive()).toBe(false)
    expect(s.session.current.state).toBe('idle')

    const meta = takeJson()
    expect(meta).toMatchObject({ id: 'take_20261018-101500', complete: true, stoppedAtMs: 9_500 })
    expect(meta.cursor).toMatchObject({ file: 'cursor.jsonl' })
    expect(meta.tracks.find((t) => t.file === 'screen.webm')!.bytes).toBe(3)
    expect(readFileSync(join(takeDir(), 'screen.webm'))).toEqual(Buffer.from([1, 2, 3]))
    expect(readFileSync(join(takeDir(), 'mic-1.wav')).length).toBe(48)
  })

  it('passes the main camera first and the cursor log the display and region', async () => {
    const region = { displayId: '1', x: 0, y: 50, width: 2880, height: 1700 }
    const s = setup({ region: () => region })
    await s.session.start(plan())
    expect(s.link().payload!.cameras.map((c) => [c.base, c.deviceId, c.main])).toEqual([['camera-1', 'camB', true], ['camera-2', 'camA', false]])
    expect(s.cursorCalls[0]).toEqual(['start', 'take_20261018-101500', takeDir(), '1', 1_760_000_000_500, region])
    await s.session.stop()
    expect(s.cursorCalls.at(-1)).toEqual(['stop', 'take_20261018-101500'])
  })

  it('no cursor log without a screen', async () => {
    const s = setup()
    await s.session.start(plan({ screen: null }))
    expect(s.cursorCalls).toEqual([])
    await s.session.stop()
  })

  it('goes through the states in order', async () => {
    const s = setup()
    await s.session.start(plan({ countdownSec: 3 }))
    await s.session.stop()
    const states = s.statuses.map((x) => x.state).filter((v, i, a) => a[i - 1] !== v)
    expect(states).toEqual(['countdown', 'recording', 'stopping', 'ingesting', 'idle'])
    expect(s.statuses.filter((x) => x.state === 'countdown').map((x) => x.countdown)).toEqual([3, 2, 1])
  })
})

describe('RecordSession: markers and hotkeys', () => {
  it('marks through the recorder window clock, counts them and writes take.json', async () => {
    const s = setup()
    await s.session.start(plan())
    s.session.mark('ng')
    s.hotkeys.get('CmdOrCtrl+Shift+M')!()
    expect(s.link().marks).toEqual(['ng', 'important'])
    expect(s.session.current.markers).toEqual({ ng: 1, important: 1 })
    expect(takeJson().markers).toHaveLength(2)
    await s.session.stop()
    expect(takeJson().markers.map((m) => m.kind)).toEqual(['ng', 'important'])
  })

  it('ignores unknown marker kinds and marks while idle', async () => {
    const s = setup()
    s.session.mark('ng')
    await s.session.start(plan())
    s.session.mark('oops')
    s.session.mark(null)
    expect(s.link().marks).toEqual([])
    await s.session.stop()
  })

  it('registers the hotkeys only while recording', async () => {
    const s = setup()
    await s.session.start(plan())
    expect([...s.hotkeys.keys()].sort()).toEqual(['CmdOrCtrl+Shift+M', 'CmdOrCtrl+Shift+N'])
    await s.session.stop()
    expect(s.hotkeys.size).toBe(0)
  })

  it('a hotkey another app owns does not stop the recording', async () => {
    const s = setup({ registerHotkey: () => { throw new Error('conflict') } })
    await s.session.start(plan())
    expect(s.session.current.state).toBe('recording')
    expect(s.reports).toContain('register marker hotkey')
    await s.session.stop()
  })
})

describe('RecordSession: exclusivity and consent', () => {
  it('does not start during a review recording', async () => {
    const s = setup()
    s.setReview(true)
    await expect(s.session.start(plan())).rejects.toThrow(/review recording/i)
    expect(videoCaptureActive()).toBe(false)
    expect(existsSync(videoDir)).toBe(false)
  })

  it('a review recording that started during the countdown wins', async () => {
    let s!: ReturnType<typeof setup>
    s = setup({ wait: async () => { s.setReview(true) } })
    await expect(s.session.start(plan({ countdownSec: 3 }))).rejects.toThrow(/review recording/i)
    expect(videoCaptureActive()).toBe(false)
    expect(s.session.current.state).toBe('idle')
  })

  it('holds the capture lock from the countdown until stopped', async () => {
    const seen: boolean[] = []
    const s = setup({ wait: async () => { seen.push(videoCaptureActive()) } })
    await s.session.start(plan({ countdownSec: 3 }))
    expect(seen).toEqual([true, true, true])
    await s.session.stop()
    expect(videoCaptureActive()).toBe(false)
  })

  it('needs a fresh user action', async () => {
    const s = setup()
    s.setGesture(false)
    await expect(s.session.start(plan())).rejects.toThrow(/press the button again/i)
    expect(videoCaptureActive()).toBe(false)
  })

  it('refuses a second start while recording', async () => {
    const s = setup()
    await s.session.start(plan())
    await expect(s.session.start(plan())).rejects.toThrow(/already in progress/i)
    await s.session.stop()
  })

  it('refuses a video folder outside the channel', async () => {
    const s = setup()
    await expect(s.session.start(plan({ videoDir: '/etc' }))).rejects.toThrow()
    expect(videoCaptureActive()).toBe(false)
  })

  it('refuses a plan with nothing to record, before the countdown', async () => {
    const wait = vi.fn(async () => undefined)
    const s = setup({ wait })
    await s.session.prepare()
    await expect(s.session.start(plan({ screen: null, cameraIds: [], micIds: [], countdownSec: 3 }))).rejects.toThrow(/choose a screen/i)
    expect(wait).not.toHaveBeenCalled()
    expect(videoCaptureActive()).toBe(false)
  })

  it('refuses an unplugged camera with a readable message', async () => {
    const s = setup()
    await s.session.prepare()
    await expect(s.session.start(plan({ cameraIds: ['camZ'] }))).rejects.toThrow(/no longer connected/i)
  })

  it('refuses garbage plans', async () => {
    const s = setup()
    await expect(s.session.start(null as never)).rejects.toThrow()
    await expect(s.session.start('x' as never)).rejects.toThrow()
  })
})

describe('RecordSession: countdown', () => {
  it('stopping during the countdown cancels without a take folder', async () => {
    let release!: () => void
    const s = setup({ wait: () => new Promise<void>((r) => { release = r }) })
    const started = s.session.start(plan({ countdownSec: 3 }))
    await vi.waitFor(() => expect(s.session.current.state).toBe('countdown'))
    expect(await s.session.stop()).toMatchObject({ cancelled: true })
    release()
    expect(await started).toEqual({ cancelled: true })
    expect(s.session.current.state).toBe('idle')
    expect(videoCaptureActive()).toBe(false)
    expect(existsSync(join(videoDir, 'media'))).toBe(false)
    expect(s.deps.runIngest).not.toHaveBeenCalled()
  })

  it('countdown values outside 0/3/5/10 become 3', async () => {
    const wait = vi.fn(async () => undefined)
    const s = setup({ wait })
    await s.session.start(plan({ countdownSec: 99 }))
    expect(wait).toHaveBeenCalledTimes(3)
    await s.session.stop()
  })
})

describe('RecordSession: failures', () => {
  it('a recorder that cannot start leaves nothing locked and reports the reason', async () => {
    const s = setup()
    await s.session.prepare()
    s.link().startError = new Error('no track could be started')
    await expect(s.session.start(plan())).rejects.toThrow(/no track could be started/)
    expect(videoCaptureActive()).toBe(false)
    expect(s.session.current.state).toBe('idle')
    expect(s.deps.writer.activeTakes).toBe(0)
    expect(s.reports).toContain('start recording')
  })

  it('refuses tracks the plan did not ask for', async () => {
    const s = setup()
    await s.session.start(plan({ micIds: [] }))
    const h = s.link().handlers
    expect(() => h.openTrack({ file: 'mic-1.wav', kind: 'mic' })).toThrow(/not allowed/)
    expect(() => h.openTrack({ file: '../x.wav', kind: 'mic' })).toThrow(/not allowed/)
    expect(() => h.openTrack({ file: 'screen.mp4', kind: 'camera' })).toThrow(/not allowed/)
    // screen.webm は開いてある。同じ映像を .mp4 でも開くことはできない
    expect(() => h.openTrack({ file: 'screen.mp4', kind: 'screen' })).toThrow(/already open/)
    await s.session.stop()
  })

  it('opening a track after stopping is refused', async () => {
    const s = setup()
    await s.session.start(plan())
    const h = s.link().handlers
    await s.session.stop()
    expect(() => h.openTrack({ file: 'mic-1.wav', kind: 'mic' })).toThrow(/not recording/)
  })

  it('a track that cannot be written stops only that track and warns once', async () => {
    const s = setup()
    await s.session.start(plan())
    const writer = s.deps.writer
    const append = writer.appendTrack.bind(writer)
    let calls = 0
    writer.appendTrack = (take, file, data) => {
      if (file === 'camera-1.webm') { calls++; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) }
      return append(take, file, data)
    }
    const h = s.link().handlers
    h.chunk('camera-1.webm', new Uint8Array([1]))
    h.chunk('camera-1.webm', new Uint8Array([2]))
    h.chunk('screen.webm', new Uint8Array([3, 4]))
    expect(calls).toBe(1)
    expect(s.session.current.warning).toMatch(/camera-1\.webm/)
    expect(s.session.current.state).toBe('recording')
    await s.session.stop()
    expect(readFileSync(join(takeDir(), 'screen.webm'))).toEqual(Buffer.from([3, 4]))
  })

  it('chunks for unknown files, empty chunks and chunks while idle are ignored', async () => {
    const s = setup()
    await s.session.prepare()
    s.link().handlers.chunk('screen.webm', new Uint8Array([1]))
    await s.session.start(plan())
    const h = s.link().handlers
    h.chunk('screen.webm', new Uint8Array(0))
    h.chunk('nope.webm', new Uint8Array([1]))
    h.chunk('screen.webm', 'x' as never)
    expect(s.session.current.state).toBe('recording')
    await s.session.stop()
    expect(readFileSync(join(takeDir(), 'screen.webm')).length).toBe(0)
  })

  it('the recorder window crashing keeps the files and marks take.json incomplete', async () => {
    const s = setup()
    await s.session.start(plan())
    s.link().handlers.chunk('screen.webm', new Uint8Array([1, 2]))
    s.link().handlers.gone('crashed')
    expect(s.session.current).toMatchObject({ state: 'idle', takeId: 'take_20261018-101500' })
    expect(s.session.current.warning).toMatch(/stopped unexpectedly/i)
    expect(videoCaptureActive()).toBe(false)
    expect(s.hotkeys.size).toBe(0)
    expect(s.deps.writer.activeTakes).toBe(0)
    expect(takeJson().complete).toBe(false)
    expect(readFileSync(join(takeDir(), 'screen.webm'))).toEqual(Buffer.from([1, 2]))
    expect(await s.session.stop()).toBeNull()
    expect(s.deps.runIngest).not.toHaveBeenCalled()
    // 次の撮影は新しい録画ウインドウで始められる
    await s.session.start(plan())
    expect(s.links.length).toBe(2)
    await s.session.stop()
  })

  it('a stop that times out still finishes the take with an estimated stop time', async () => {
    let now = new Date(2026, 9, 18, 10, 15, 0).getTime()
    const s = setup({ now: () => new Date(now) })
    await s.session.start(plan())
    s.link().stopResult = 'null'
    now += 4000
    const r = await s.session.stop()
    expect(r!.ingest!.ok).toBe(true)
    const meta = takeJson()
    expect(meta.complete).toBe(true)
    expect(meta.stoppedAtMs).toBe(500 + 4000)
  })

  it('a stop that throws still closes the files and ingests', async () => {
    const s = setup()
    await s.session.start(plan())
    s.link().stopResult = 'throw'
    const r = await s.session.stop()
    expect(r).toMatchObject({ ingest: { ok: true } })
    expect(s.reports).toContain('stop recording')
    expect(s.deps.writer.activeTakes).toBe(0)
  })

  it('a failed ingest is reported and autoStart is off for it', async () => {
    const s = setup({ runIngest: vi.fn(async () => ({ ok: false, message: 'ffprobe not found' })) })
    await s.session.start(plan())
    expect(await s.session.stop()).toMatchObject({ ingest: { ok: false, message: 'ffprobe not found' }, autoStart: false })
    expect(s.session.current.state).toBe('idle')
  })

  it('an ingest that throws becomes a failed result', async () => {
    const s = setup({ runIngest: vi.fn(async () => { throw new Error('cli crashed') }) })
    await s.session.start(plan())
    expect(await s.session.stop()).toMatchObject({ ingest: { ok: false, message: 'cli crashed' } })
  })

  it('autoStart off is passed through', async () => {
    const s = setup({ autoStart: () => false })
    await s.session.start(plan())
    expect(await s.session.stop()).toMatchObject({ autoStart: false, ingest: { ok: true } })
  })

  it('a take.json that cannot be written warns but keeps recording', async () => {
    const s = setup()
    await s.session.start(plan())
    s.deps.writer.writeMeta = () => { throw new Error('EACCES') }
    s.session.mark('ng')
    expect(s.session.current.warning).toMatch(/take\.json/)
    expect(s.session.current.state).toBe('recording')
    await s.session.stop()
  })

  it('take.json from the recorder for another take is ignored', async () => {
    const s = setup()
    await s.session.start(plan())
    s.link().handlers.meta({ ...s.link().meta!, id: 'take_other', markers: [{ kind: 'ng', atMs: 1, sinceStartMs: 0 }] })
    expect(s.session.current.markers).toEqual({ ng: 0, important: 0 })
    await s.session.stop()
  })

  it('a recorder window that cannot open is a readable error', async () => {
    const s = setup({
      createLink: (h) => {
        const link = new FakeLink(h, {})
        link.open = async () => { throw new Error('page missing') }
        return link
      }
    })
    await expect(s.session.prepare()).rejects.toThrow(/could not start/i)
    expect(s.reports).toContain('open recorder window')
  })

  it('stop while idle is null', async () => {
    expect(await setup().session.stop()).toBeNull()
  })
})

describe('RecordSession: preview and closing', () => {
  it('previews only known devices, and not while recording', async () => {
    const s = setup()
    await s.session.prepare()
    await s.session.preview({ screenSourceId: 'screen:1:0', cameraIds: ['camA', 'camZ'], micIds: ['micA'], camera: { width: 1280, height: 720, fps: 30 } })
    expect(s.link().previews).toEqual([{ screenSourceId: 'screen:1:0', cameraIds: ['camA'], micIds: ['micA'], camera: { width: 1280, height: 720, fps: 30 } }])
    await s.session.start(plan())
    await s.session.preview({ screenSourceId: null, cameraIds: [], micIds: [] })
    expect(s.link().previews).toHaveLength(1)
    await s.session.stop()
  })

  it('preview before prepare does nothing', async () => {
    const s = setup()
    await expect(s.session.preview({})).resolves.toBeUndefined()
    expect(s.links).toHaveLength(0)
  })

  it('closing keeps the recorder window while recording, and closes it when idle', async () => {
    const s = setup()
    await s.session.start(plan())
    s.session.close()
    expect(s.link().disposed).toBe(false)
    await s.session.stop()
    s.session.close()
    expect(s.link().disposed).toBe(true)
  })

  it('devices from the recorder window are checked and forwarded', async () => {
    const forwarded: unknown[] = []
    const s = setup({ emitDevices: (d) => forwarded.push(d) })
    await s.session.prepare()
    s.link().handlers.devices({ cameras: [{ id: 'x', label: 'X' }, { id: '' }], mics: 'nope' })
    expect(forwarded).toEqual([{ cameras: [{ id: 'x', label: 'X' }], mics: [] }])
    expect(s.session.knownDevices.cameras).toHaveLength(1)
  })

  it('quitting mid-take keeps what was recorded', async () => {
    const s = setup()
    await s.session.start(plan())
    s.session.dispose()
    expect(takeJson().complete).toBe(false)
    expect(videoCaptureActive()).toBe(false)
    expect(s.hotkeys.size).toBe(0)
    expect(s.link().disposed).toBe(true)
  })
})
