import { registerRecorderContents } from '../captureConsent'
import { BrowserWindow, ipcMain, nativeImage, type NativeImage, type Streams, type WebContents } from 'electron'
import { constants, createWriteStream, type WriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { AudioLevel, PcmBlock, RecordingOptions } from './types'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'
import { systemAudioUnsupported } from '@shared/systemAudio'

/**
 * 録画用の非表示ウィンドウ（設計4章）。
 *
 * MediaRecorder と getUserMedia はレンダラにしか無いので、録画はこのウィンドウで動かす。
 * **UIのウィンドウとは別にする**のが肝で、モード切替や再描画でUIが作り直されても
 * 録画は切れない。ウィンドウは最後まで `show: false` のままで、画面にも
 * 画面共有にも出ない（MTG中に他アプリを前面にしても録り続けられる）。
 *
 * 動画は `timeslice` ごとに届く塊をそのままファイルへ追記する。
 * アプリが落ちても、その時点までのWebMが残る（NF-12）。
 */

/** main ⇄ 録画ウィンドウ のチャネル。アプリ本体のIPCとは混ぜない */
const RECORDER_CHANNELS = {
  start: 'ade-recorder:start',
  pause: 'ade-recorder:pause',
  resume: 'ade-recorder:resume',
  stop: 'ade-recorder:stop',
  video: 'ade-recorder:video',
  pcm: 'ade-recorder:pcm',
  level: 'ade-recorder:level',
  ready: 'ade-recorder:ready',
  error: 'ade-recorder:error',
  stopped: 'ade-recorder:stopped',
  started: 'ade-recorder:started',
  grab: 'ade-recorder:grab',
  frame: 'ade-recorder:frame',
  overlay: 'ade-recorder:overlay'
} as const

/**
 * 映像の取り込み元。
 * - tab: 内蔵ブラウザの webContents（タブ録画。OSの画面収録の許可は要らない）
 * - desktop: desktopCapturer の画面・ウインドウ（'screen:…' / 'window:…'）
 */
export type VideoSource = { kind: 'tab'; contents: WebContents } | { kind: 'desktop'; sourceId: string
  /** 同時に録るほかの画面・ウインドウ。録画ウインドウが sourceId と横に並べて1本の動画にする（@shared/captureComposite） */
  extraSourceIds?: string[] }

interface RecorderWindowHandlers {
  onPcm(block: PcmBlock): void
  onLevel(level: AudioLevel): void
  onError(message: string): void
}

type RecorderMessageKey = 'videoEnded' | 'videoPartEnded' | 'videoFailed' | 'micFailed' | 'systemAudioFailed' | 'systemAudioDenied' | 'systemAudioNoDevice' | 'systemAudioEnded' | 'noAudioTrack'

interface StartPayload {
  sourceKind: 'tab' | 'desktop'
  sourceId: string
  /** 同時に録るほかの画面・ウインドウ（desktop のときだけ）。sourceId と並べて1本の動画にする */
  extraSourceIds?: string[]
  startedAtEpoch: number
  /** process.platform。相手の声を取り込む方法を OS で変える */
  platform: string
  captureMic: boolean
  syntheticMic: boolean
  captureSystemAudio: boolean
  /** 検証用。相手の声の取り込みをこの時間(ms)で止める */
  systemAudioEndAfterMs?: number
  /** 検証用。OS の取り込み（ループバック）を使わない。古い取り込み方に逃げない */
  systemAudioSynthetic: boolean
  micDeviceId?: string
  videoBitsPerSecond: number
  videoMaxWidth: number
  videoMaxFrameRate: number
  videoTimesliceMs: number
  /** タブの映像の上に、拡張機能のポップアップの映像を重ねてから録る（recorder.ts の OverlayCompositor） */
  composite: boolean
  /** 録画ウィンドウが出すエラーの文。画面の言語で main が組み立てて渡す（録画ウィンドウは辞書を持たない） */
  messages: Record<RecorderMessageKey, string>
}

/**
 * 相手の声を何から取るか（getDisplayMedia への答え）。
 * - loopback: PC の音声（OS のループバック）
 * - page: 内蔵ブラウザのページの音（検証用。OS の許可が要らない）
 * - deny: 断る（検証用。OS が許可しなかったとき）
 * - silent: 音声を付けない（検証用。音声の出力先が無いとき）
 */
type SystemAudioPlan = { kind: 'loopback' } | { kind: 'page'; contents: WebContents } | { kind: 'deny' } | { kind: 'silent' }

/** 相手の声の文（画面の言語）。許可の案内は OS ごとに違う */
function systemAudioDeniedMessage(platform: string): string {
  if (platform === 'darwin') return t('recorder.systemAudioDeniedMac')
  if (platform === 'linux') return t('recorder.systemAudioDeniedLinux')
  return t('recorder.systemAudioDeniedWindows')
}

export class RecorderWindow {
  private window: BrowserWindow | null = null
  private videoStream: WriteStream | null = null
  private bytesWritten = 0
  private stoppedResolve: (() => void) | null = null
  private startedResolve: (() => void) | null = null
  private grabSeq = 0
  /** 録画ウインドウが getDisplayMedia を呼んだときに返すもの。録画を始めるときに決める */
  private systemAudioPlan: SystemAudioPlan | null = null
  private readonly grabs = new Map<number, (png: ArrayBuffer | null) => void>()
  private readonly listeners: Array<
    [string, (event: Electron.IpcMainEvent, ...args: unknown[]) => void]
  > = []

  constructor(
    private readonly htmlPath: string,
    private readonly preloadPath: string,
    private readonly handlers: RecorderWindowHandlers,
    /**
     * 映像だけを録る（同じ録画の2本目以降のトラック。@shared/captureTracks）。音は1本目の録画ウインドウが録るので、
     * 相手の声の取り込み（session 全体の getDisplayMedia の受け口）には触らない
     */
    private readonly videoOnly = false
  ) {}

  get videoBytes(): number {
    return this.bytesWritten
  }

  /** 起動を軽くするため、録画を始めるときに初めて作る */
  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 非表示ウィンドウはタイマーが絞られる。録画中は絞らせない
        backgroundThrottling: false
      }
    })
    this.window = window
    // 映像（画面・タブ）の取り込みを許すのは、この録画ウインドウだけ（アプリの窓は音だけ。captureConsent.ts）
    registerRecorderContents(window.webContents)
    /*
     * 相手の声は getDisplayMedia で取る。映像はこのウインドウ自身（画面収録の許可が要らない）、音声は PC のループバック。
     * 同じ session のほかのページ（アプリの画面・プレビュー）の getDisplayMedia は、これまでどおり断る
     */
    if (!this.videoOnly) window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const plan = this.systemAudioPlan
      const own = this.window && !this.window.isDestroyed() ? this.window.webContents.mainFrame : null
      const fromRecorder = !!own && !!request.frame && request.frame.processId === own.processId && request.frame.routingId === own.routingId
      if (!own || !fromRecorder || !plan || plan.kind === 'deny') return callback({})
      const streams: Streams = { video: own }
      if (plan.kind === 'loopback') streams.audio = 'loopback'
      else if (plan.kind === 'page' && !plan.contents.isDestroyed()) streams.audio = plan.contents.mainFrame
      try {
        callback(streams)
      } catch (err) {
        // 求めたフレームがもう無い（録画を止めた直後など）
        reportHandled(err, { area: 'recording', op: 'display media handler' })
      }
    })
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.warn('[recorder]', message)
      // 録画ウインドウには Sentry を入れていないので、console のエラーをここで知らせる（文は scrub される）
      if (level >= 3) reportHandled(new Error(message), { area: 'recording', op: 'recorder window error' })
    })
    this.bind()
    await window.loadFile(this.htmlPath)
  }

  private bind(): void {
    const add = <T extends unknown[]>(
      channel: string,
      handler: (event: Electron.IpcMainEvent, ...args: T) => void
    ): void => {
      const wrapped = (event: Electron.IpcMainEvent, ...args: unknown[]): void => {
        if (event.sender !== this.window?.webContents) return
        handler(event, ...(args as T))
      }
      ipcMain.on(channel, wrapped)
      this.listeners.push([channel, wrapped])
    }

    add<[ArrayBuffer]>(RECORDER_CHANNELS.video, (_event, chunk) => {
      const buffer = Buffer.from(chunk)
      this.bytesWritten += buffer.byteLength
      this.videoStream?.write(buffer)
    })

    add<[{ source: PcmBlock['source']; offsetMs: number; samples: ArrayBuffer }]>(
      RECORDER_CHANNELS.pcm,
      (_event, block) => {
        this.handlers.onPcm({
          source: block.source,
          offsetMs: block.offsetMs,
          samples: new Int16Array(block.samples)
        })
      }
    )

    add<[AudioLevel]>(RECORDER_CHANNELS.level, (_event, level) => this.handlers.onLevel(level))
    add<[string]>(RECORDER_CHANNELS.error, (_event, message) => this.handlers.onError(message))
    add<[]>(RECORDER_CHANNELS.stopped, () => {
      this.stoppedResolve?.()
      this.stoppedResolve = null
    })
    add<[]>(RECORDER_CHANNELS.started, () => this.startedResolve?.())
    add<[number, ArrayBuffer | null]>(RECORDER_CHANNELS.frame, (_event, id, png) => {
      this.grabs.get(id)?.(png)
      this.grabs.delete(id)
    })
  }

  /**
   * 録画を始める。
   * @param source 録りたいもの（内蔵ブラウザの webContents、または画面・ウインドウ）
   */
  async start(source: VideoSource, options: RecordingOptions, startedAtEpoch: number): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) throw new UserFacingError(t('recording.errors.noRecorderWindow'))

    // 録画のフォルダは作ったばかり。既にある名前・シンボリックリンクには書かない（O_EXCL と O_NOFOLLOW で開く）
    const nofollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const handle = await open(options.paths.videoPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o644)
    const stream = createWriteStream('', { fd: handle })
    // 書けなくなった（ディスクがいっぱいなど）ときに main を落とさない。録画は止めずに知らせる
    stream.on('error', (err) => {
      reportHandled(err, { area: 'recording', op: 'write video' })
      this.handlers.onError(String(err))
    })
    this.videoStream = stream
    this.bytesWritten = 0

    // tab は自アプリ内の webContents を指す「タブ録画」のID。OSの画面収録権限は要らない
    const sourceId = source.kind === 'tab' ? source.contents.getMediaSourceId(window.webContents) : source.sourceId
    const synthetic = this.videoOnly ? undefined : options.syntheticSystemAudio
    let captureSystemAudio = options.captureSystemAudio && !this.videoOnly
    this.systemAudioPlan = null
    if (captureSystemAudio && synthetic) {
      // 検証用: 内蔵ブラウザのページの音を PC の音声の代わりにする（画面全体・別のウインドウのときは鳴らす元が無い）
      if (synthetic === 'denied') this.systemAudioPlan = { kind: 'deny' }
      else if (synthetic === 'no-device') this.systemAudioPlan = { kind: 'silent' }
      else this.systemAudioPlan = source.kind === 'tab' ? { kind: 'page', contents: source.contents } : { kind: 'silent' }
    } else if (captureSystemAudio) {
      // macOS 14.2 より前は取れない。試さずに案内する（映像とマイクは続ける）
      if (systemAudioUnsupported(process.platform, typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '') === 'macosTooOld') {
        this.handlers.onError(t('recorder.systemAudioMacTooOld'))
        captureSystemAudio = false
      } else this.systemAudioPlan = { kind: 'loopback' }
    }
    const payload: StartPayload = {
      sourceKind: source.kind,
      sourceId,
      ...(source.kind === 'desktop' && source.extraSourceIds?.length ? { extraSourceIds: source.extraSourceIds } : {}),
      startedAtEpoch,
      platform: process.platform,
      captureMic: options.captureMic && !this.videoOnly,
      syntheticMic: options.syntheticMic === true && !this.videoOnly,
      captureSystemAudio,
      systemAudioSynthetic: !!synthetic,
      ...(synthetic === 'ends' ? { systemAudioEndAfterMs: 2500 } : {}),
      micDeviceId: options.micDeviceId,
      videoBitsPerSecond: options.videoBitsPerSecond,
      videoMaxWidth: options.videoMaxWidth,
      videoMaxFrameRate: options.videoMaxFrameRate,
      videoTimesliceMs: options.videoTimesliceMs,
      composite: source.kind === 'tab' && options.overlayCompositing === true,
      // {{message}} / {{source}} は録画ウィンドウ側で埋める
      messages: {
        videoEnded: t('recorder.videoEnded'),
        videoPartEnded: t('recorder.videoPartEnded'),
        videoFailed: t('recorder.videoFailed'),
        micFailed: t('recorder.micFailed'),
        systemAudioFailed: t('recorder.systemAudioFailed'),
        systemAudioDenied: systemAudioDeniedMessage(process.platform),
        systemAudioNoDevice: t('recorder.systemAudioNoDevice'),
        systemAudioEnded: t('recorder.systemAudioEnded'),
        noAudioTrack: t('recorder.noAudioTrack')
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('recording.errors.recorderNotReady'))), 15_000)
      this.startedResolve = () => { clearTimeout(timer); this.startedResolve = null; resolve() }
      window.webContents.send(RECORDER_CHANNELS.start, payload)
    })
  }

  /** 重ねている中身と、その取り込みの ID（同じ中身なら ID を作り直さない） */
  private overlaySource: { contents: WebContents; id: string } | null = null

  /**
   * タブの映像の上に重ねるもの（拡張機能のポップアップ）を録画ウインドウへ渡す。null で外す。
   * 映像はタブ録画と同じ取り込み（getMediaSourceId。OS の画面収録の許可は要らない）。合成しない録画（composite 切）では録画ウインドウが無視する
   */
  setOverlay(overlay: { contents: WebContents; rect: { x: number; y: number; width: number; height: number } } | null): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (!overlay || overlay.contents.isDestroyed()) {
      this.overlaySource = null
      window.webContents.send(RECORDER_CHANNELS.overlay, null)
      return
    }
    try {
      if (this.overlaySource?.contents !== overlay.contents) this.overlaySource = { contents: overlay.contents, id: overlay.contents.getMediaSourceId(window.webContents) }
      window.webContents.send(RECORDER_CHANNELS.overlay, { sourceId: this.overlaySource.id, rect: overlay.rect })
    } catch (err) {
      // ポップアップが閉じた直後など。重ねずに録画は続ける
      this.overlaySource = null
      reportHandled(err, { area: 'recording', op: 'overlay source' })
    }
  }

  /** 録画用ウインドウが閉じた（静止画を撮れない） */
  get gone(): boolean {
    return !this.window || this.window.isDestroyed()
  }

  /**
   * 録画中の映像から1枚切り出す（画面全体・別のウインドウの静止画用）。
   * 内蔵ブラウザなら capturePage() で撮れるが、他のアプリの画面は撮れないため。
   * 映像が届かない（ウインドウが最小化された等）ときは null。
   */
  async grabFrame(timeoutMs = 2000): Promise<NativeImage | null> {
    const window = this.window
    if (!window || window.isDestroyed()) return null
    const id = ++this.grabSeq
    const png = await new Promise<ArrayBuffer | null>((resolve) => {
      const timer = setTimeout(() => { this.grabs.delete(id); resolve(null) }, timeoutMs)
      timer.unref?.()
      this.grabs.set(id, (data) => { clearTimeout(timer); resolve(data) })
      window.webContents.send(RECORDER_CHANNELS.grab, id)
    })
    if (!png || png.byteLength === 0) return null
    const image = nativeImage.createFromBuffer(Buffer.from(png))
    return image.isEmpty() ? null : image
  }

  pause(): void {
    this.window?.webContents.send(RECORDER_CHANNELS.pause)
  }

  resume(): void {
    this.window?.webContents.send(RECORDER_CHANNELS.resume)
  }

  /** 停止して、最後のチャンクが書き終わるまで待つ */
  async stop(timeoutMs = 5000): Promise<void> {
    const window = this.window
    if (window && !window.isDestroyed()) {
      let timer: NodeJS.Timeout | null = null
      const stopped = new Promise<void>((resolve) => {
        this.stoppedResolve = resolve
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
      try {
        window.webContents.send(RECORDER_CHANNELS.stop)
        await stopped
      } catch (err) {
        // 録画ウインドウの中身が落ちた・閉じた直後（返事は来ない）。それまでに届いた塊で閉じる
        reportHandled(err, { area: 'recording', op: 'send recorder stop' })
      } finally {
        if (timer) clearTimeout(timer)
        this.stoppedResolve = null
      }
    }
    this.systemAudioPlan = null
    await this.closeVideoStream(timeoutMs)
  }

  /**
   * 動画のファイルを閉じる。書き終わりを待つのは timeoutMs まで
   * （Windows でウイルス対策・同期ソフトがファイルを掴んで書き終わらないことがある。待ち続けると停止が終わらない）
   */
  private async closeVideoStream(timeoutMs: number): Promise<void> {
    const stream = this.videoStream
    this.videoStream = null
    if (!stream) return
    let timer: NodeJS.Timeout | null = null
    const ended = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
      try {
        stream.end(() => resolve(true))
      } catch (err) {
        reportHandled(err, { area: 'recording', op: 'end video stream' })
        resolve(false)
      }
    })
    if (timer) clearTimeout(timer)
    if (!ended) {
      reportHandled(new Error(`video stream did not finish within ${timeoutMs}ms`), { area: 'recording', op: 'end video stream' })
      stream.destroy()
    }
  }

  dispose(): void {
    this.systemAudioPlan = null
    this.overlaySource = null
    if (!this.videoOnly && this.window && !this.window.isDestroyed()) this.window.webContents.session.setDisplayMediaRequestHandler(null)
    for (const [channel, handler] of this.listeners) ipcMain.off(channel, handler)
    this.listeners.length = 0
    for (const resolve of this.grabs.values()) resolve(null)
    this.grabs.clear()
    this.videoStream?.end()
    this.videoStream = null
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) window.destroy()
  }
}
