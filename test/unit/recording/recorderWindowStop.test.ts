import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 録画ウインドウの停止（RecorderWindow.stop）が、返事が来ない・送れない・動画のファイルが書き終わらないときも
 * 上限で終わることを確かめる（Windows で停止が終わらず、録画中のまま残った不具合の再発防止）
 */
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), off: vi.fn() }, BrowserWindow: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }))
const reported = vi.hoisted(() => [] as unknown[])
vi.mock('@shared/report', () => ({ reportHandled: (error: unknown) => { reported.push(error) } }))

const { RecorderWindow } = await import('../../../src/main/recording/recorderWindow')

function fakeWindow(send: (channel: string) => void) {
  return { isDestroyed: () => false, destroy: vi.fn(), webContents: { send: vi.fn(send), session: { setDisplayMediaRequestHandler: vi.fn() } } }
}

function fakeStream(endBehavior: 'finish' | 'never' | 'throw') {
  return {
    end: vi.fn((cb?: () => void) => {
      if (endBehavior === 'throw') throw new Error('write after destroy')
      if (endBehavior === 'finish') cb?.()
    }),
    destroy: vi.fn(),
    write: vi.fn()
  }
}

function recorderWith(window: unknown, stream: unknown) {
  const rw = new RecorderWindow('', '', { onPcm: vi.fn(), onLevel: vi.fn(), onError: vi.fn() })
  const r = rw as unknown as Record<string, unknown>
  r.window = window
  r.videoStream = stream
  return rw
}

beforeEach(() => { reported.length = 0 })
afterEach(() => { vi.useRealTimers() })

describe('録画ウインドウの停止', () => {
  it('「止まった」が届けば、動画のファイルを閉じて終わる', async () => {
    const stream = fakeStream('finish')
    let rw: InstanceType<typeof RecorderWindow>
    const window = fakeWindow(() => queueMicrotask(() => (rw as unknown as { stoppedResolve: (() => void) | null }).stoppedResolve?.()))
    rw = recorderWith(window, stream)
    await rw.stop(5_000)
    expect(window.webContents.send).toHaveBeenCalledWith('ade-recorder:stop')
    expect(stream.end).toHaveBeenCalledOnce()
    expect(stream.destroy).not.toHaveBeenCalled()
    expect(reported).toEqual([])
  })

  it('返事が来なければ上限で先へ進み、ファイルを閉じる', async () => {
    vi.useFakeTimers()
    const stream = fakeStream('finish')
    const rw = recorderWith(fakeWindow(() => {}), stream)
    const stopping = rw.stop(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await stopping
    expect(stream.end).toHaveBeenCalledOnce()
  })

  it('停止を送れない（中身が落ちた）ときも投げずに、ファイルを閉じて終わる', async () => {
    const stream = fakeStream('finish')
    const rw = recorderWith(fakeWindow(() => { throw new Error('Render frame was disposed') }), stream)
    await expect(rw.stop(5_000)).resolves.toBeUndefined()
    expect(stream.end).toHaveBeenCalledOnce()
    expect(reported).toHaveLength(1)
  })

  it('動画のファイルが書き終わらない（ファイルを掴まれた）ときは、上限で閉じ切って終わる', async () => {
    vi.useFakeTimers()
    const stream = fakeStream('never')
    const rw = recorderWith(fakeWindow(() => {}), stream)
    const stopping = rw.stop(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await stopping
    expect(stream.destroy).toHaveBeenCalledOnce()
    expect(reported).toHaveLength(1)
  })

  it('ファイルを閉じるときに投げても、停止は終わる', async () => {
    vi.useFakeTimers()
    const stream = fakeStream('throw')
    const rw = recorderWith(fakeWindow(() => {}), stream)
    const stopping = rw.stop(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(stopping).resolves.toBeUndefined()
    expect(stream.destroy).toHaveBeenCalledOnce()
  })

  it('録画ウインドウがもう無くても、開いたままの動画のファイルは閉じる', async () => {
    const stream = fakeStream('finish')
    const rw = recorderWith(null, stream)
    await rw.stop(5_000)
    expect(stream.end).toHaveBeenCalledOnce()
  })

  it('動画のファイルも無ければ何もしない。2回目の停止もすぐ終わる', async () => {
    const rw = recorderWith(null, null)
    await expect(rw.stop(5_000)).resolves.toBeUndefined()
    await expect(rw.stop(5_000)).resolves.toBeUndefined()
  })

  it('止めたあとに遅れて届いた映像の塊は、閉じたファイルへ書かない', async () => {
    const stream = fakeStream('finish')
    const rw = recorderWith(null, stream)
    await rw.stop(5_000)
    expect((rw as unknown as { videoStream: unknown }).videoStream).toBeNull()
  })
})
