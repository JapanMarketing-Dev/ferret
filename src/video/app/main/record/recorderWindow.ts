import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type Streams } from 'electron'
import { registerRecorderContents } from '../../../../main/captureConsent'
import type { MarkerKind } from '../../shared/record/take'
import type { PreviewSelection, RecordFrame, RecordLevel, RecorderOpenTrack, RecorderStartPayload } from '../../shared/record/types'
import type { RecorderLink, RecorderLinkHandlers } from './session'
import { RECORDER_CHANNELS as CH } from '../../shared/record/channels'

/**
 * 動画の撮影の非表示の録画ウインドウ（Ferret のレビューの録画ウインドウ src/main/recording/recorderWindow.ts と同じ作法）。
 *
 * MediaRecorder・getUserMedia はページにしか無いので、画面・カメラ・マイクはこのウインドウで開く。最後まで show: false で、
 * 画面にも画面共有にも出ない。映像の取り込みを許すのはこのウインドウだけ（captureConsent の registerRecorderContents）で、
 * アプリの窓へは縮小フレーム（JPEG）と音の大きさだけを送る（アプリの窓に映像の権限を広げない）。
 *
 * 塊は1秒ごとに届き、main がすぐファイルへ追記する（takeWriter.ts）。アプリが落ちてもそこまでは残る。
 */

const READY_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 8_000
const ENUMERATE_TIMEOUT_MS = 5_000
/** 縮小フレームの大きさの上限（JPEG）。これより大きいものは捨てる */
const MAX_FRAME_BYTES = 400_000
const MAX_CHUNK_BYTES = 64 * 1024 * 1024
const TIMEOUT = Symbol('timeout')

export class VideoRecorderWindow implements RecorderLink {
  private window: BrowserWindow | null = null
  private readonly listeners: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = []
  private handlesOpen = false
  private waiters = new Map<string, Array<(value: unknown) => void>>()
  private systemAudio = false
  private disposed = false

  constructor(
    private readonly htmlPath: string,
    private readonly preloadPath: string,
    private readonly handlers: RecorderLinkHandlers
  ) {}

  get alive(): boolean {
    return !!this.window && !this.window.isDestroyed() && !this.window.webContents.isCrashed()
  }

  async open(): Promise<void> {
    if (this.alive) return
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      title: 'Ferret video recorder',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 非表示のウインドウはタイマーが絞られる。録画中は絞らせない
        backgroundThrottling: false
      }
    })
    this.window = window
    // 映像（画面・カメラ）の取り込みを許すのは録画ウインドウだけ（アプリの窓は音だけ。src/main/captureConsent.ts）
    registerRecorderContents(window.webContents)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.warn('[video-recorder]', message)
    })
    window.webContents.on('render-process-gone', (_event, details) => this.lost(details.reason))
    window.on('closed', () => this.lost('closed'))
    this.bind()
    const ready = this.wait(CH.ready, READY_TIMEOUT_MS)
    await window.loadFile(this.htmlPath)
    if ((await ready) === TIMEOUT) throw new Error('video recorder page did not start')
  }

  private lost(reason: string): void {
    if (this.disposed) return
    this.dispose()
    this.handlers.gone(reason)
  }

  private bind(): void {
    const add = <T extends unknown[]>(channel: string, handler: (...args: T) => void): void => {
      const wrapped = (event: IpcMainEvent, ...args: unknown[]): void => {
        if (!this.window || event.sender !== this.window.webContents) return
        handler(...(args as T))
      }
      ipcMain.on(channel, wrapped)
      this.listeners.push([channel, wrapped])
    }
    const settle = (channel: string) => (value: unknown) => {
      const list = this.waiters.get(channel) ?? []
      this.waiters.delete(channel)
      for (const resolve of list) resolve(value)
    }
    add(CH.ready, settle(CH.ready))
    add(CH.started, settle(CH.started))
    add(CH.startFailed, (message) => settle(CH.started)({ error: typeof message === 'string' ? message : 'start failed' }))
    add(CH.stopped, settle(CH.stopped))
    add<[unknown]>(CH.devices, (devices) => {
      settle(CH.devices)(devices)
      this.handlers.devices(devices)
    })
    add<[string, ArrayBuffer]>(CH.chunk, (file, chunk) => {
      if (typeof file !== 'string' || !(chunk instanceof ArrayBuffer) || chunk.byteLength > MAX_CHUNK_BYTES) return
      this.handlers.chunk(file, new Uint8Array(chunk))
    })
    add<[unknown]>(CH.meta, (meta) => this.handlers.meta(meta))
    add<[string, ArrayBuffer]>(CH.frame, (id, jpeg) => {
      if (typeof id !== 'string' || id.length > 600 || !(jpeg instanceof ArrayBuffer) || jpeg.byteLength === 0 || jpeg.byteLength > MAX_FRAME_BYTES) return
      const frame: RecordFrame = { id, dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` }
      this.handlers.frame(frame)
    })
    add<[unknown]>(CH.levels, (levels) => {
      if (!Array.isArray(levels)) return
      const clean: RecordLevel[] = levels.slice(0, 16).flatMap((l: unknown) => {
        const o = l as Record<string, unknown> | null
        if (!o || typeof o.id !== 'string' || typeof o.level !== 'number' || !Number.isFinite(o.level)) return []
        return [{ id: o.id.slice(0, 600), level: Math.min(1, Math.max(0, o.level)), clip: o.clip === true }]
      })
      this.handlers.levels(clean)
    })
    add<[string]>(CH.warning, (message) => { if (typeof message === 'string') this.handlers.warning(message.slice(0, 500)) })
    ipcMain.handle(CH.open, (event: IpcMainInvokeEvent, spec: RecorderOpenTrack) => {
      if (!this.window || event.sender !== this.window.webContents) throw new Error('not the recorder window')
      this.handlers.openTrack(spec)
    })
    this.handlesOpen = true
  }

  private wait(channel: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(channel)
        if (list) this.waiters.set(channel, list.filter((r) => r !== done))
        resolve(TIMEOUT)
      }, timeoutMs)
      timer.unref?.()
      const done = (value: unknown) => { clearTimeout(timer); resolve(value) }
      this.waiters.set(channel, [...(this.waiters.get(channel) ?? []), done])
    })
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.alive) this.window!.webContents.send(channel, ...args)
  }

  async enumerate(): Promise<unknown> {
    const reply = this.wait(CH.devices, ENUMERATE_TIMEOUT_MS)
    this.send(CH.enumerate)
    const devices = await reply
    return devices === TIMEOUT ? { cameras: [], mics: [] } : devices
  }

  preview(selection: PreviewSelection): void {
    this.send(CH.preview, selection)
  }

  async start(payload: RecorderStartPayload): Promise<{ startedAtMs: number; timeOrigin: number }> {
    if (!this.alive) throw new Error('recorder window is gone')
    this.setSystemAudio(payload.systemAudio !== null)
    const reply = this.wait(CH.started, START_TIMEOUT_MS)
    this.send(CH.start, payload)
    const result = (await reply) as { startedAtMs?: unknown; timeOrigin?: unknown; error?: unknown } | typeof TIMEOUT
    if (result === TIMEOUT) throw new Error('recorder did not start in time')
    if (typeof result.error === 'string') throw new Error(result.error)
    const startedAtMs = Number(result.startedAtMs)
    const timeOrigin = Number(result.timeOrigin)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(timeOrigin)) throw new Error('recorder sent no clock')
    return { startedAtMs, timeOrigin }
  }

  /**
   * PC の音声は getDisplayMedia で取る。映像はこのウインドウ自身、音声は OS のループバック（Ferret のレビューの録画と同じ）。
   * 同じ session のほかのページの getDisplayMedia は断る。止めたら外す（レビューの録画とは同時に使わない）
   */
  private setSystemAudio(on: boolean): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    this.systemAudio = on
    if (!on) return window.webContents.session.setDisplayMediaRequestHandler(null)
    window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const own = this.window && !this.window.isDestroyed() ? this.window.webContents.mainFrame : null
      const fromRecorder = !!own && !!request.frame && request.frame.processId === own.processId && request.frame.routingId === own.routingId
      if (!own || !fromRecorder || !this.systemAudio) return callback({})
      const streams: Streams = { video: own, audio: 'loopback' }
      try {
        callback(streams)
      } catch {
        // 求めたフレームがもう無い（止めた直後など）
      }
    })
  }

  mark(kind: MarkerKind): void {
    this.send(CH.mark, kind)
  }

  async stop(): Promise<unknown> {
    if (!this.alive) return null
    const reply = this.wait(CH.stopped, STOP_TIMEOUT_MS)
    this.send(CH.stop)
    const meta = await reply
    this.setSystemAudio(false)
    return meta === TIMEOUT ? null : meta
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [channel, handler] of this.listeners) ipcMain.off(channel, handler)
    this.listeners.length = 0
    if (this.handlesOpen) ipcMain.removeHandler(CH.open)
    this.handlesOpen = false
    for (const list of this.waiters.values()) for (const resolve of list) resolve(TIMEOUT)
    this.waiters.clear()
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) {
      if (this.systemAudio) window.webContents.session.setDisplayMediaRequestHandler(null)
      window.destroy()
    }
    this.systemAudio = false
  }
}

