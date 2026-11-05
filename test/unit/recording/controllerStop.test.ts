import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 録画の停止（RecordingController.stop）が必ず終わり、idle へ戻ることを確かめる。
 * Windows で「停止を押しても録画中のまま」になったのは、停止のどこかの段が返ってこない・投げると
 * 状態が stopping のまま残り、それまでの音声・発話がレビューにならなかったため。
 * 録画ウインドウ・静止画は偽物に差し替える（Electron は動かさない）
 */
vi.mock('electron', () => {
  const stub = new Proxy({}, { get: () => vi.fn() })
  return { ipcMain: { on: vi.fn(), off: vi.fn(), handle: vi.fn() }, BrowserWindow: vi.fn(), desktopCapturer: stub, nativeImage: stub, screen: stub, shell: stub, systemPreferences: stub, app: stub }
})
const reported = vi.hoisted(() => [] as Array<{ error: unknown; tags: unknown }>)
vi.mock('@shared/report', () => ({ reportHandled: (error: unknown, tags: unknown) => { reported.push({ error, tags }) } }))

const { RecordingController } = await import('../../../src/main/recording/controller')
const { setLocale } = await import('@shared/i18n')
setLocale('ja')

type Fake = Record<string, unknown>
const never = <T>() => new Promise<T>(() => {})

function fakeRecorder(stop: () => Promise<void>, opts: { disposeThrows?: boolean } = {}): Fake & { stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return {
    videoBytes: 12_345,
    stop: vi.fn(stop),
    dispose: vi.fn(() => { if (opts.disposeThrows) throw new Error('Object has been destroyed') })
  }
}

function fakeStills(stop: () => Promise<void> = async () => {}): Fake {
  return { stop: vi.fn(stop), captured: [{ t: 1_000, path: '0001.png', size: { width: 10, height: 10 } }] }
}

/** 録画中の状態を直接作る（start は録画ウインドウと OS の取り込みが要るので通さない） */
function recordingController(parts: { recorder: Fake; stills?: Fake; tracks?: Fake[] }) {
  const statuses: string[] = []
  const warnings: string[] = []
  const controller = new RecordingController({ recorderHtml: '', recorderPreload: '' }, {
    onStatus: (s) => statuses.push(s.state),
    onWarning: (m) => warnings.push(m)
  })
  const c = controller as unknown as Record<string, unknown>
  c.state = 'recording'
  c.recorder = parts.recorder
  c.stills = parts.stills ?? fakeStills()
  c.clock = { now: () => 42_000 }
  c.startedAt = '2026-11-05T00:00:00.000Z'
  c.options = { paths: { videoPath: '/tmp/x/recording.webm', eventsPath: '', framesDir: '', audioDir: '' } }
  c.tracks = parts.tracks ?? []
  return { controller, statuses, warnings }
}

beforeEach(() => { reported.length = 0 })
afterEach(() => { vi.useRealTimers() })

describe('録画の停止は必ず終わる', () => {
  it('ふつうに止まれば、長さ・静止画・動画の大きさを返して idle へ戻る', async () => {
    const recorder = fakeRecorder(async () => {})
    const { controller, statuses, warnings } = recordingController({ recorder })
    const result = await controller.stop()
    expect(result.durationMs).toBe(42_000)
    expect(result.videoBytes).toBe(12_345)
    expect(result.frames).toHaveLength(1)
    expect(controller.status.state).toBe('idle')
    expect(statuses[0]).toBe('stopping')
    expect(statuses.at(-1)).toBe('idle')
    expect(recorder.dispose).toHaveBeenCalledOnce()
    expect(warnings).toEqual([])
    expect(reported).toEqual([])
  })

  it('録画ウインドウが返事をしない（Windows）: 上限で先へ進み、idle へ戻り、理由を残して知らせる', async () => {
    vi.useFakeTimers()
    const recorder = fakeRecorder(() => never())
    const { controller, warnings } = recordingController({ recorder })
    const stopping = controller.stop()
    await vi.advanceTimersByTimeAsync(11_999)
    expect(controller.status.state).toBe('stopping')
    await vi.advanceTimersByTimeAsync(1)
    const result = await stopping
    expect(controller.status.state).toBe('idle')
    // それまでの記録で結果を返す（音声・発話はこのあとレビューになる）
    expect(result.durationMs).toBe(42_000)
    expect(result.frames).toHaveLength(1)
    expect(result.warnings.some((w) => w.includes('recorder'))).toBe(true)
    expect(warnings.some((w) => w.includes('recorder'))).toBe(true)
    expect(reported.some((r) => String((r.tags as { op: string }).op).includes('recorder'))).toBe(true)
    expect(recorder.dispose).toHaveBeenCalledOnce()
  })

  it('録画ウインドウの停止が投げても idle へ戻る', async () => {
    const recorder = fakeRecorder(async () => { throw new Error('Render frame was disposed') })
    const { controller } = recordingController({ recorder })
    const result = await controller.stop()
    expect(controller.status.state).toBe('idle')
    expect(result.warnings.join('\n')).toContain('Render frame was disposed')
  })

  it('静止画の書き終わりが返ってこなくても先へ進み、録画ウインドウは止める', async () => {
    vi.useFakeTimers()
    const recorder = fakeRecorder(async () => {})
    const { controller } = recordingController({ recorder, stills: fakeStills(() => never()) })
    const stopping = controller.stop()
    await vi.advanceTimersByTimeAsync(7_000)
    await stopping
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(controller.status.state).toBe('idle')
  })

  it('後片付け（録画ウインドウを閉じる）が投げても idle へ戻り、結果を返す', async () => {
    const recorder = fakeRecorder(async () => {}, { disposeThrows: true })
    const { controller } = recordingController({ recorder })
    await expect(controller.stop()).resolves.toMatchObject({ durationMs: 42_000 })
    expect(controller.status.state).toBe('idle')
    expect(reported.some((r) => String((r.tags as { op: string }).op).includes('dispose recorder'))).toBe(true)
  })

  it('追加の映像が止まらなくても、ほかの映像と結果は待たせない', async () => {
    vi.useFakeTimers()
    const main = fakeRecorder(async () => {})
    const extraRecorder = fakeRecorder(() => never())
    const extra = { id: 't2', live: true, target: { kind: 'window' }, label: 'Figma', videoRel: 'tracks/t2.webm', startMs: 5_000, recorder: extraRecorder }
    const { controller } = recordingController({ recorder: main, tracks: [extra] })
    ;(controller as unknown as { appendTrackLine: () => void }).appendTrackLine = () => {}
    const stopping = controller.stop()
    await vi.advanceTimersByTimeAsync(12_000)
    const result = await stopping
    expect(result.tracks).toEqual([{ id: 't2', kind: 'window', label: 'Figma', video: 'tracks/t2.webm', startMs: 5_000, endMs: 42_000 }])
    expect(extraRecorder.dispose).toHaveBeenCalledOnce()
    expect(controller.status.state).toBe('idle')
  })

  it('停止を2回押しても後片付けは1回だけ。同じ結果を返す', async () => {
    let finish!: () => void
    const recorder = fakeRecorder(() => new Promise<void>((done) => { finish = done }))
    const { controller } = recordingController({ recorder })
    const first = controller.stop()
    const second = controller.stop()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(recorder.stop).toHaveBeenCalled())
    finish()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(recorder.dispose).toHaveBeenCalledOnce()
  })

  it('止まったあとにもう一度止めると「録画していない」と返す（idle のまま）', async () => {
    const { controller } = recordingController({ recorder: fakeRecorder(async () => {}) })
    await controller.stop()
    await expect(controller.stop()).rejects.toThrow()
    expect(controller.status.state).toBe('idle')
  })
})
