/**
 * 録画用ウィンドウの中身（レンダラ）。画面には出ない。
 *
 * - 動画: 内蔵ブラウザの webContents をタブ録画（chromeMediaSource: 'tab'）して MediaRecorder へ。
 *   画面全体・別のウインドウを選んだときは chromeMediaSource: 'desktop' で取り込む（要 画面収録の許可）。
 *   そのときの静止画は、main から頼まれるたびにこの映像から1枚切り出して返す。
 *   `timeslice` ごとの塊をそのまま main へ渡し、main がファイルへ追記する（NF-12）。
 * - 音声: マイク（自分）と PC音声（相手）を**別々の AudioContext** で受け、
 *   16kHz モノラルの Int16 PCM にして main へ送る。動画側のトラックとは分けるので、
 *   文字起こしの系統（話者）が混ざらない。
 *
 * AudioContext を 16000Hz で作ると、Chromium が入力を自動でリサンプルしてくれる。
 * 自前のリサンプラを持たずに済み、品質も安定する。
 */

import { init as initSentry } from '@sentry/electron/renderer'
import { classifySystemAudioError } from '../shared/systemAudio'
import { defaultMicKey, micRecoveryAction, silencePadSamples, type MicDeviceLike } from '../shared/micRecovery'
import { compositeLayout, fitInto, sourceMaxWidth, type Rect } from '../shared/captureComposite'

export {} // このファイルをモジュールにする（declare global のため）

/*
 * 録画ウインドウの例外もクラッシュレポートに載せる（src/main/telemetry.ts）。main が Sentry を初期化した起動だけ、
 * Sentry の preload が __SENTRY_IPC__ を置くので、それがあるときだけ初期化する。操作の記録（パンくず）は集めない
 */
if ((window as { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__) {
  initSentry({ integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs' && i.name !== 'HttpContext'), maxBreadcrumbs: 0 })
}

interface StartPayload {
  sourceKind: 'tab' | 'desktop'
  sourceId: string
  /** 同時に録るほかの画面・ウインドウ（desktop のときだけ）。sourceId と横に並べて1本の動画にする（DesktopCompositor） */
  extraSourceIds?: string[]
  startedAtEpoch: number
  platform?: string
  captureMic: boolean
  syntheticMic: boolean
  captureSystemAudio: boolean
  systemAudioEndAfterMs?: number
  systemAudioSynthetic?: boolean
  micDeviceId?: string
  videoBitsPerSecond: number
  videoMaxWidth: number
  videoMaxFrameRate: number
  videoTimesliceMs: number
  /** タブの映像の上に、拡張機能のポップアップの映像を重ねてから録る（OverlayCompositor） */
  composite?: boolean
  /** エラーの文（画面の言語）。{{message}} / {{source}} をここで埋める。main（recorderWindow.ts）が渡す */
  messages?: Partial<Record<keyof typeof DEFAULT_MESSAGES, string>>
}

interface RecorderBridge {
  onStart(fn: (payload: StartPayload) => void): void
  onPause(fn: () => void): void
  onResume(fn: () => void): void
  onStop(fn: () => void): void
  video(chunk: ArrayBuffer): void
  pcm(block: { source: 'mic' | 'system'; offsetMs: number; samples: ArrayBuffer }): void
  level(level: { source: 'mic' | 'system'; rms: number; peak: number }): void
  error(message: string): void
  stopped(): void
  started(): void
  onGrab(fn: (id: number) => void): void
  frame(id: number, png: ArrayBuffer | null): void
  onOverlay(fn: (overlay: unknown) => void): void
}

/** Chromium の Insertable Streams（lib.dom に型が無い） */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' })
  readonly writable: WritableStream<VideoFrame>
}

/** Chromium の ImageCapture（lib.dom に型が無い） */
declare class ImageCapture {
  constructor(track: MediaStreamTrack)
  grabFrame(): Promise<ImageBitmap>
}

declare global {
  interface Window {
    adeRecorder: RecorderBridge
  }
}

const bridge = window.adeRecorder

/** 録画開始時に main から届く文。届く前・欠けたときは英語 */
let messages: NonNullable<StartPayload['messages']> = {}
const DEFAULT_MESSAGES = {
  videoEnded: 'The recorded screen or window was closed, so video and image capture stopped. Audio and drawings are still being recorded.',
  videoPartEnded: 'One of the screens or windows being recorded together was closed. The others are still being recorded.',
  videoFailed: "Couldn't capture video: {{message}}",
  micFailed: "Couldn't access the microphone: {{message}}",
  systemAudioFailed: "Couldn't capture system audio: {{message}}",
  systemAudioDenied: "Couldn't record the other side because system audio access wasn't allowed. Your microphone is still being recorded.",
  systemAudioNoDevice: "Couldn't record the other side because no audio output device was found. Your microphone is still being recorded.",
  systemAudioEnded: 'System audio stopped (the output device may have changed). The rest of the recording continues without the other side.',
  noAudioTrack: '{{source}}: no audio track'
}
function text(key: keyof typeof DEFAULT_MESSAGES, params: Record<string, string> = {}): string {
  return (messages[key] ?? DEFAULT_MESSAGES[key]).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => params[name] ?? whole)
}
const SAMPLE_RATE = 16_000

/** 1系統ぶんの音声取り込み */
class AudioCapture {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private stream: MediaStream | null = null
  private samplesSent = 0
  private paused = false

  constructor(
    private readonly source: 'mic' | 'system',
    /** この系統が録り始めたのが録画開始から何ms後か */
    private readonly startOffsetMs: number
  ) {}

  private input: MediaStreamAudioSourceNode | null = null

  async start(stream: MediaStream): Promise<void> {
    if (stream.getAudioTracks().length === 0) {
      throw new Error(text('noAudioTrack', { source: this.source }))
    }
    // 16kHz で作ると Chromium が入力を自動でリサンプルする
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.context = context
    await context.audioWorklet.addModule('./pcm-worklet.js')

    const node = new AudioWorkletNode(context, 'ade-pcm', { numberOfOutputs: 0 })
    this.node = node
    node.port.onmessage = (event: MessageEvent) => {
      if (this.paused) return
      const data = event.data as { samples: Int16Array; rms: number; peak: number }
      this.send(data.samples)
      bridge.level({ source: this.source, rms: data.rms, peak: data.peak })
    }
    this.connect(stream)
  }

  private send(samples: Int16Array): void {
    const offsetMs = this.startOffsetMs + (this.samplesSent / SAMPLE_RATE) * 1000
    this.samplesSent += samples.length
    // 転送可能オブジェクトとして渡す（コピーを減らす）
    bridge.pcm({ source: this.source, offsetMs, samples: samples.buffer as ArrayBuffer })
  }

  private connect(stream: MediaStream): void {
    if (!this.context || !this.node) return
    this.stream = stream
    this.input = this.context.createMediaStreamSource(stream)
    this.input.connect(this.node)
  }

  /**
   * 録画中にマイクを付け替える（抜かれた・既定が変わった。MicKeeper）。同じ系統のまま、途切れた分を無音で埋めてからつなぐ
   * （main はサンプル数で時刻を数えるので、埋めないと後の声が早い時刻にずれる。@shared/micRecovery の silencePadSamples）
   */
  replace(stream: MediaStream, activeMs: number): void {
    if (!this.context || !this.node) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    try { this.input?.disconnect() } catch { /* もう外れている */ }
    this.input = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    let pad = silencePadSamples(activeMs, this.startOffsetMs, this.samplesSent, SAMPLE_RATE)
    while (pad > 0) {
      const size = Math.min(pad, SAMPLE_RATE / 10)
      this.send(new Int16Array(size))
      pad -= size
    }
    this.connect(stream)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  get sampleCount(): number {
    return this.samplesSent
  }

  stop(): void {
    this.node?.port.close()
    this.input?.disconnect()
    this.input = null
    this.node?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.context = null
    this.node = null
    this.stream = null
  }
}

interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/** main から届く重ねるもの。形が違えば null（重ねない） */
function readOverlay(raw: unknown): { sourceId: string; rect: OverlayRect } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { sourceId?: unknown; rect?: Partial<Record<keyof OverlayRect, unknown>> }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const rect = { x: n(r.rect?.x), y: n(r.rect?.y), width: n(r.rect?.width), height: n(r.rect?.height) }
  if (typeof r.sourceId !== 'string' || !r.sourceId || Object.values(rect).some(Number.isNaN) || rect.width <= 0 || rect.height <= 0) return null
  return { sourceId: r.sourceId, rect }
}

/**
 * タブの映像（内蔵ブラウザのビュー）の上に、拡張機能のポップアップ（別のビュー。タブ録画には写らない）の映像を重ねる。
 *
 * 両方の映像をフレームごとに受け（MediaStreamTrackProcessor）、OffscreenCanvas に重ねて描き、新しい映像（MediaStreamTrackGenerator）にする。
 * 画面に描かない（非表示の録画ウインドウでも止まらない）。どちらかの映像が変わったときだけ描き、フレームレートの上限で間引く
 */
class OverlayCompositor {
  readonly stream: MediaStream
  private readonly canvas = new OffscreenCanvas(2, 2)
  private readonly context = this.canvas.getContext('2d', { alpha: false })
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>
  private base: VideoFrame | null = null
  private top: VideoFrame | null = null
  private topTrack: MediaStreamTrack | null = null
  private topSource: string | null = null
  private rect: OverlayRect | null = null
  private generation = 0
  private lastDraw = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly minIntervalMs: number

  static supported(): boolean {
    return typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function'
  }

  constructor(baseTrack: MediaStreamTrack, private readonly maxFrameRate: number) {
    this.minIntervalMs = 1000 / Math.max(1, maxFrameRate)
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    this.writer = generator.writable.getWriter()
    this.stream = new MediaStream([generator])
    void this.pump(baseTrack, (frame) => { this.base?.close(); this.base = frame })
  }

  /** その映像のフレームを受け続ける。止めた・映像が終わったら抜ける */
  private async pump(track: MediaStreamTrack, take: (frame: VideoFrame) => void, generation?: number): Promise<void> {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.stopped || (generation !== undefined && generation !== this.generation)) {
          value.close()
          break
        }
        take(value)
        this.schedule()
      }
    } catch {
      // 映像が途中で止まった（ポップアップが閉じた等）。重ねるのをやめるだけ（想定内）
    } finally {
      reader.releaseLock()
    }
  }

  /** ポップアップが開いた・動いた・閉じた（null） */
  async setOverlay(next: { sourceId: string; rect: OverlayRect } | null): Promise<void> {
    if (this.stopped) return
    if (next && next.sourceId === this.topSource) {
      this.rect = next.rect
      this.schedule()
      return
    }
    const generation = ++this.generation
    this.topTrack?.stop()
    this.topTrack = null
    this.top?.close()
    this.top = null
    this.topSource = next?.sourceId ?? null
    this.rect = next?.rect ?? null
    this.schedule()
    if (!next) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: next.sourceId, maxFrameRate: this.maxFrameRate } } as unknown as MediaTrackConstraints
      })
      const track = stream.getVideoTracks()[0] ?? null
      if (!track || this.stopped || generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return }
      this.topTrack = track
      void this.pump(track, (frame) => { this.top?.close(); this.top = frame }, generation)
    } catch (err) {
      // 重ねられなくても録画は続ける（タブの映像だけになる）
      console.warn('[recorder] overlay capture failed', message(err))
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer) return
    const wait = this.lastDraw + this.minIntervalMs - performance.now()
    if (wait <= 0) return this.draw()
    this.timer = setTimeout(() => { this.timer = null; this.draw() }, wait)
  }

  private draw(): void {
    const base = this.base
    const context = this.context
    if (this.stopped || !base || !context) return
    this.lastDraw = performance.now()
    const width = base.displayWidth
    const height = base.displayHeight
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    context.drawImage(base, 0, 0, width, height)
    const rect = this.rect
    if (this.top && rect) {
      const x = Math.round(rect.x * width)
      const y = Math.round(rect.y * height)
      const w = Math.round(rect.width * width)
      const h = Math.round(rect.height * height)
      context.drawImage(this.top, x, y, w, h)
      // ポップアップの縁（ページと見分けられるよう、Chrome のポップアップと同じく薄い線）
      context.strokeStyle = 'rgba(0, 0, 0, 0.25)'
      context.lineWidth = 1
      context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    }
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) })
    this.writer.write(frame).catch(() => frame.close())
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.topTrack?.stop()
    this.base?.close()
    this.top?.close()
    this.base = this.top = null
    void this.writer.close().catch(() => undefined)
  }
}

/**
 * 複数の画面・ウインドウを横に並べて1本の映像にする（選択画面で複数選んだとき）。
 *
 * それぞれの映像をフレームごとに受け（MediaStreamTrackProcessor）、最新の1枚を持っておき、
 * フレームレートの上限の間隔で OffscreenCanvas に並べて描いて新しい映像（MediaStreamTrackGenerator）にする。
 * 動画の大きさは最初に全部の大きさが分かった時点（遅くても LAYOUT_WAIT_MS 後）で決め、録画の途中では変えない。
 * 並びの計算は @shared/captureComposite（単体テストあり）。閉じた映像の枠は暗いままにして、ほかは録り続ける
 */
class DesktopCompositor {
  static readonly LAYOUT_WAIT_MS = 1_500
  readonly stream: MediaStream
  readonly track: MediaStreamTrack
  private readonly canvas = new OffscreenCanvas(2, 2)
  private readonly context = this.canvas.getContext('2d', { alpha: false })
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>
  private readonly frames: Array<VideoFrame | null>
  private readonly sizes: Array<{ width: number; height: number }>
  private readonly ended: boolean[]
  private cells: Rect[] | null = null
  private readonly timer: ReturnType<typeof setInterval>
  private readonly layoutTimer: ReturnType<typeof setTimeout>
  private stopped = false

  static supported(): boolean {
    return OverlayCompositor.supported()
  }

  constructor(
    private readonly sources: MediaStreamTrack[],
    private readonly maxWidth: number,
    maxFrameRate: number,
    private readonly onEnded: (all: boolean) => void
  ) {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    this.track = generator
    this.writer = generator.writable.getWriter()
    this.stream = new MediaStream([generator])
    this.frames = sources.map(() => null)
    this.sizes = sources.map(() => ({ width: 0, height: 0 }))
    this.ended = sources.map(() => false)
    sources.forEach((track, i) => {
      track.addEventListener('ended', () => this.end(i))
      void this.pump(track, i)
    })
    this.layoutTimer = setTimeout(() => this.fixLayout(), DesktopCompositor.LAYOUT_WAIT_MS)
    this.timer = setInterval(() => this.draw(), 1000 / Math.max(1, maxFrameRate))
  }

  private async pump(track: MediaStreamTrack, index: number): Promise<void> {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.stopped) { value.close(); break }
        this.frames[index]?.close()
        this.frames[index] = value
        this.sizes[index] = { width: value.displayWidth, height: value.displayHeight }
        if (!this.cells && this.sizes.every((size, i) => size.width > 0 || this.ended[i])) this.fixLayout()
      }
    } catch {
      // 映像が途中で止まった（ウインドウが閉じた等）。その枠を暗くするだけ（想定内）
    } finally {
      reader.releaseLock()
      this.end(index)
    }
  }

  private end(index: number): void {
    if (this.stopped || this.ended[index]) return
    this.ended[index] = true
    this.frames[index]?.close()
    this.frames[index] = null
    this.onEnded(this.ended.every(Boolean))
  }

  /** 動画の大きさと枠を決める（1回だけ） */
  private fixLayout(): void {
    if (this.cells || this.stopped) return
    clearTimeout(this.layoutTimer)
    const layout = compositeLayout(this.sizes, this.maxWidth)
    this.canvas.width = layout.width
    this.canvas.height = layout.height
    this.cells = layout.cells
  }

  private draw(): void {
    const context = this.context
    const cells = this.cells
    if (this.stopped || !context || !cells) return
    context.fillStyle = '#111214'
    context.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.frames.forEach((frame, i) => {
      const cell = cells[i]
      if (!frame || !cell) return
      const rect = fitInto({ width: frame.displayWidth, height: frame.displayHeight }, cell)
      context.drawImage(frame, rect.x, rect.y, rect.width, rect.height)
    })
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) })
    this.writer.write(frame).catch(() => frame.close())
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.layoutTimer)
    for (const track of this.sources) track.stop()
    this.frames.forEach((frame) => frame?.close())
    this.frames.fill(null)
    void this.writer.close().catch(() => undefined)
  }
}

let desktopCompositor: DesktopCompositor | null = null

let compositor: OverlayCompositor | null = null
/** 録画を始める前に届いた重ねるもの（開いていたポップアップ） */
let pendingOverlay: { sourceId: string; rect: OverlayRect } | null = null

let recorder: MediaRecorder | null = null
let videoTrack: MediaStreamTrack | null = null
const captures: AudioCapture[] = []
let videoWrites: Promise<void> = Promise.resolve()
/** 止める操作の途中。相手の声の取り込みが終わっても「途中で止まった」とは知らせない */
let stopping = false
/** 録画を始めた時刻と、一時停止していた時間（マイクを付け替えるときの時刻。一時停止の間は数えない） */
let recordStartedAt = 0
let pausedTotalMs = 0
let pausedAt: number | null = null
function activeMs(): number {
  const now = Date.now()
  return now - recordStartedAt - pausedTotalMs - (pausedAt !== null ? now - pausedAt : 0)
}
let micKeeper: MicKeeper | null = null

/**
 * 録画中のマイクを持ち続ける。マイクが抜かれた・OS の既定のマイクが変わった・取り込みが終わった（ended）ときは、
 * 録画を止めずにマイクだけを開き直して同じ音声の系統へつなぐ。開けるマイクが無い間は映像だけ録り、戻ったらつなぐ。
 * どうするかは @shared/micRecovery の micRecoveryAction が決める（単体テストあり）
 */
class MicKeeper {
  private track: MediaStreamTrack | null = null
  private requested = ''
  private defaultKey: string | null = null
  private busy = false
  private again = false
  private stopped = false
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private readonly onDeviceChange = () => void this.check()

  constructor(private readonly wanted: string, private readonly echoCancellation: boolean) {}

  /** 最初に開く。開けなければ投げる（録画は続ける。マイクがつながったら devicechange で開き直す） */
  async start(): Promise<void> {
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
    const devices = await this.devices()
    const action = micRecoveryAction(this.wanted, null, devices)
    // 一覧が読めない・空でも、まず既定（または選んだもの）を開いてみる（許可の前は一覧が空のことがある）
    const deviceId = action.kind === 'open' ? action.deviceId : (this.wanted === 'default' ? '' : this.wanted)
    await this.attach(await this.openStream(deviceId), deviceId, devices)
  }

  private capture: AudioCapture | null = null

  /** 開いたマイクを音声の系統へつなぐ。まだ系統が無ければ作る（録画の開始時にマイクが無かったときは、つながった時刻から録る） */
  private async attach(stream: MediaStream, deviceId: string, devices: MicDeviceLike[]): Promise<void> {
    if (this.stopped) { stream.getTracks().forEach((track) => track.stop()); return }
    if (this.capture) this.capture.replace(stream, activeMs())
    else {
      const capture = new AudioCapture('mic', activeMs())
      try {
        await capture.start(stream)
      } catch (err) {
        capture.stop()
        throw err
      }
      capture.setPaused(pausedAt !== null)
      captures.push(capture)
      this.capture = capture
    }
    this.adopt(stream, deviceId, devices)
  }

  private async devices(): Promise<MicDeviceLike[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }))
    } catch {
      return []
    }
  }

  private openStream(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      /*
       * 相手の声も録るときは、スピーカーから出た相手の声がマイクに入りにくいようエコー除去を入れる。
       * 残った二重取りは、文字起こしのあとに時刻と文で落とす（src/main/pipeline/merge.ts）
       */
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: this.echoCancellation, noiseSuppression: false }
        : { echoCancellation: this.echoCancellation, noiseSuppression: false },
      video: false
    })
  }

  private adopt(stream: MediaStream, deviceId: string, devices: MicDeviceLike[]): void {
    const track = stream.getAudioTracks()[0] ?? null
    this.track = track
    this.requested = deviceId
    this.defaultKey = deviceId === '' ? defaultMicKey(devices.filter((d) => d.deviceId !== '')) : null
    // マイクが抜かれた・OS が取り込みを止めた。録画は止めず、開き直す
    track?.addEventListener('ended', () => { if (this.track === track) void this.check() })
  }

  /** 一覧が変わった・取り込みが終わった。必要ならマイクを開き直す（重なったら終わってからもう一度） */
  async check(): Promise<void> {
    if (this.stopped) return
    if (this.busy) { this.again = true; return }
    this.busy = true
    try {
      const devices = await this.devices()
      const open = this.track ? { requested: this.requested, defaultKey: this.defaultKey, live: this.track.readyState === 'live' } : null
      const action = micRecoveryAction(this.wanted, open, devices)
      if (action.kind !== 'open') return
      await this.attach(await this.openStream(action.deviceId), action.deviceId, devices)
      this.failures = 0
      console.info('[recorder] microphone switched', action.deviceId ? 'chosen' : 'default')
    } catch (err) {
      // 開けなかった（切り替えの途中など）。少し待って数回だけ試し直す。それでもだめなら次の devicechange を待つ
      console.warn('[recorder] microphone reopen failed', message(err))
      if (++this.failures <= 5 && !this.stopped) {
        if (this.retry) clearTimeout(this.retry)
        this.retry = setTimeout(() => { this.retry = null; void this.check() }, 1_500)
      }
    } finally {
      this.busy = false
      if (this.again && !this.stopped) { this.again = false; void this.check() }
    }
  }

  stop(): void {
    this.stopped = true
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.track = null
  }
}

/**
 * 映像。内蔵ブラウザのタブ映像（tab）は OSの画面収録権限が要らない。
 * 画面全体・別のウインドウ（desktop）は macOS で「画面収録」の許可が要る。
 *
 * 取り込みの時点で大きさとフレームレートを絞る。
 * Retina の原寸・30fps のままだと 90分で2GBを超え、見返しの役に立つ以上の容量を使う。
 */
async function captureVideo(
  sourceKind: 'tab' | 'desktop',
  sourceId: string,
  maxWidth: number,
  maxFrameRate: number
): Promise<MediaStream> {
  const mandatory: Record<string, unknown> = {
    // desktop は画面全体・別のウインドウ（desktopCapturer の ID）
    chromeMediaSource: sourceKind,
    chromeMediaSourceId: sourceId,
    maxFrameRate
  }
  if (maxWidth > 0) {
    mandatory.maxWidth = maxWidth
    // 縦は横から決める（16:10 より縦長の画面でも収まるよう余裕をみる）
    mandatory.maxHeight = Math.round(maxWidth * 1.2)
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // Electron のタブ録画は旧来の constraints でしか指定できない
    video: { mandatory } as unknown as MediaTrackConstraints
  })
}

/**
 * 複数の画面・ウインドウを並べた1本の映像。どれか1つでも取り込めなければ始めない（選んだものの一部だけを黙って録らない）。
 * 合成が使えない環境では、最初の対象だけを録って知らせる
 */
async function compositeDesktopStream(payload: StartPayload, extra: string[]): Promise<MediaStream> {
  const ids = [payload.sourceId, ...extra]
  const width = sourceMaxWidth(ids.length, payload.videoMaxWidth)
  const open = (id: string) => captureVideo('desktop', id, width, payload.videoMaxFrameRate)
  if (!DesktopCompositor.supported()) {
    console.warn('[recorder] desktop compositing is not available; recording the first source only')
    return open(payload.sourceId)
  }
  const streams: MediaStream[] = []
  try {
    for (const id of ids) streams.push(await open(id))
  } catch (err) {
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
    throw err
  }
  const tracks = streams.map((stream) => stream.getVideoTracks()[0]).filter((track): track is MediaStreamTrack => !!track)
  desktopCompositor = new DesktopCompositor(tracks, payload.videoMaxWidth, payload.videoMaxFrameRate, (all) => bridge.error(text(all ? 'videoEnded' : 'videoPartEnded')))
  return desktopCompositor.stream
}

/**
 * PC音声（相手の声。AUD-1）。
 * getDisplayMedia で取る。main（recorderWindow.ts）の setDisplayMediaRequestHandler が、映像はこのウインドウ自身、
 * 音声は PC のループバックを返す（macOS 14.2+ は Core Audio の tap、Windows は再生デバイス、Linux は PulseAudio のモニター）。
 * Windows で取れなかったときだけ、古い取り込み方（desktop の音声）を試す。取れない場合も録画は続ける（マイクだけになる）。
 */
async function captureSystemAudio(payload: StartPayload): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  } catch (err) {
    const kind = classifySystemAudioError(err instanceof Error ? err.name : undefined, payload.platform)
    if (payload.systemAudioSynthetic || payload.platform !== 'win32' || kind === 'denied') throw err
    return legacyDesktopAudio()
  }
}

/** Windows の古い取り込み方（chromeMediaSource: 'desktop' の音声） */
async function legacyDesktopAudio(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'desktop' }
    } as unknown as MediaTrackConstraints,
    video: {
      mandatory: { chromeMediaSource: 'desktop', maxWidth: 2, maxHeight: 2, maxFrameRate: 1 }
    } as unknown as MediaTrackConstraints
  })
}

async function start(payload: StartPayload): Promise<void> {
  const startedAt = payload.startedAtEpoch
  stopping = false
  messages = payload.messages ?? {}
  recordStartedAt = startedAt
  pausedTotalMs = 0
  pausedAt = null

  // 映像
  try {
    const extra = payload.sourceKind === 'desktop' ? payload.extraSourceIds ?? [] : []
    const stream = extra.length > 0 ? await compositeDesktopStream(payload, extra)
      : await captureVideo(
          payload.sourceKind,
          payload.sourceId,
          payload.videoMaxWidth,
          payload.videoMaxFrameRate
        )
    videoTrack = stream.getVideoTracks()[0] ?? null
    // 並べた映像は、閉じたものを DesktopCompositor が知らせる（合成した映像そのものは終わらない）
    if (videoTrack && payload.sourceKind === 'desktop' && !desktopCompositor) {
      // 録っていたウインドウが閉じられた。音声と書き込みの記録は続ける
      videoTrack.onended = () => bridge.error(text('videoEnded'))
    }
    // 拡張機能のポップアップも録るときは、タブの映像に重ねた映像を録る（使えない環境ではタブの映像のまま）
    let recorded = stream
    if (payload.composite && payload.sourceKind === 'tab' && videoTrack && OverlayCompositor.supported()) {
      compositor = new OverlayCompositor(videoTrack, payload.videoMaxFrameRate)
      recorded = compositor.stream
      if (pendingOverlay) void compositor.setOverlay(pendingOverlay)
    } else if (payload.composite) console.warn('[recorder] overlay compositing is not available; recording the page only')
    recorder = new MediaRecorder(recorded, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: payload.videoBitsPerSecond
    })
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      // 1つの塊が読めなくても、後の塊と停止の返事を止めない（つないだ Promise が失敗のまま残ると、以降の塊がすべて捨てられる）
      videoWrites = videoWrites.then(async () => bridge.video(await event.data.arrayBuffer()))
        .catch((err: unknown) => bridge.error(text('videoFailed', { message: message(err) })))
    }
    recorder.onerror = (event) => bridge.error(`MediaRecorder: ${String((event as ErrorEvent).error)}`)
    recorder.start(payload.videoTimesliceMs)
  } catch (err) {
    bridge.error(text('videoFailed', { message: message(err) }))
  }

  // マイク（自分）。録画中にマイクが抜かれた・既定が変わっても、開き直して録り続ける（MicKeeper）
  if (payload.captureMic) {
    try {
      if (payload.syntheticMic) {
        const capture = new AudioCapture('mic', activeMs())
        await capture.start(syntheticSpeechStream())
        captures.push(capture)
      } else {
        micKeeper = new MicKeeper(payload.micDeviceId ?? '', payload.captureSystemAudio)
        await micKeeper.start()
      }
    } catch (err) {
      bridge.error(text('micFailed', { message: message(err) }))
    }
  }

  // PC音声（相手。MTG時のみ）
  if (payload.captureSystemAudio) {
    try {
      const stream = await captureSystemAudio(payload)
      // 映像トラックは不要なので止める（音声だけ使う）
      stream.getVideoTracks().forEach((track) => track.stop())
      const track = stream.getAudioTracks()[0]
      // 音声の出力先が無いと、音声の無い取り込みが返る
      if (!track) throw new DOMException('no system audio track', 'NotFoundError')
      // 出力先が抜かれた・切り替わった。マイクと映像は続ける
      track.addEventListener('ended', () => { if (!stopping) bridge.error(text('systemAudioEnded')) })
      const capture = new AudioCapture('system', Date.now() - startedAt)
      await capture.start(stream)
      captures.push(capture)
      if (payload.systemAudioEndAfterMs) {
        // 検証用: 取り込みが途中で止まったときと同じにする（stop() では ended が来ないので自分で送る）
        setTimeout(() => { track.stop(); track.dispatchEvent(new Event('ended')) }, payload.systemAudioEndAfterMs)
      }
    } catch (err) {
      const kind = classifySystemAudioError(err instanceof Error ? err.name : undefined, payload.platform)
      bridge.error(kind === 'denied' ? text('systemAudioDenied') : kind === 'noDevice' ? text('systemAudioNoDevice') : text('systemAudioFailed', { message: message(err) }))
    }
  }
  bridge.started()
}

/**
 * 検証用の合成音声。実機のマイクを開かずに、音声の経路（Worklet → PCM → main）を通す。
 * 1.2秒鳴って0.8秒黙る、を繰り返す。無音区切り（SilenceSegmenter）の確認にも使える。
 */
function syntheticSpeechStream(): MediaStream {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  const oscillator = context.createOscillator()
  oscillator.type = 'sawtooth'
  oscillator.frequency.value = 180
  const gain = context.createGain()
  gain.gain.value = 0
  oscillator.connect(gain).connect(destination)
  oscillator.start()
  const begin = context.currentTime
  for (let i = 0; i < 300; i++) {
    const at = begin + i * 2
    gain.gain.setValueAtTime(0.25, at)
    gain.gain.setValueAtTime(0, at + 1.2)
  }
  return destination.stream
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * いまの映像を1枚 PNG にする（画面全体・別のウインドウの静止画）。
 * 録画の映像トラックをそのまま使うので、画面収録の許可を二重に求めない。
 */
async function grabFrame(): Promise<ArrayBuffer | null> {
  const track = videoTrack
  if (!track || track.readyState !== 'live' || typeof ImageCapture === 'undefined') return null
  const bitmap = await new ImageCapture(track).grabFrame()
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await blob.arrayBuffer()
  } finally {
    bitmap.close()
  }
}

bridge.onGrab((id) => {
  grabFrame()
    .then((png) => bridge.frame(id, png))
    .catch(() => bridge.frame(id, null))
})

bridge.onOverlay((raw) => {
  pendingOverlay = readOverlay(raw)
  void compositor?.setOverlay(pendingOverlay)
})

bridge.onStart((payload: StartPayload) => {
  void start(payload).catch((err) => bridge.error(message(err)))
})

bridge.onPause(() => {
  if (pausedAt === null) pausedAt = Date.now()
  if (recorder?.state === 'recording') recorder.pause()
  for (const capture of captures) capture.setPaused(true)
})

bridge.onResume(() => {
  if (pausedAt !== null) { pausedTotalMs += Date.now() - pausedAt; pausedAt = null }
  if (recorder?.state === 'paused') recorder.resume()
  for (const capture of captures) capture.setPaused(false)
})

bridge.onStop(() => {
  stopping = true
  // 後片付けのどれかが投げても、main へ「止まった」を必ず返す（返さないと main は上限まで待つ）
  const attempt = (run: () => void): void => {
    try { run() } catch (err) { console.error('[recorder] stop', message(err)) }
  }
  let reported = false
  const done = async (): Promise<void> => {
    if (reported) return
    reported = true
    try {
      attempt(() => videoTrack?.stop())
      attempt(() => desktopCompositor?.stop())
      desktopCompositor = null
      attempt(() => compositor?.stop())
      compositor = null
      pendingOverlay = null
      attempt(() => micKeeper?.stop())
      micKeeper = null
      for (const capture of captures) attempt(() => capture.stop())
      captures.length = 0
      await videoWrites
    } catch (err) {
      console.error('[recorder] stop', message(err))
    } finally {
      bridge.stopped()
    }
  }
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = () => void done()
    try {
      // 残っている分を吐き出させてから止める
      recorder.requestData()
      recorder.stop()
    } catch (err) {
      // 映像のトラックが先に終わっていた等で止められない（onstop は来ない）。ここで片付けて返す
      console.error('[recorder] stop', message(err))
      void done()
    }
  } else {
    void done()
  }
})
