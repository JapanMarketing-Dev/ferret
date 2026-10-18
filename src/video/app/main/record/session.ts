import { t, type TranslationKey } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { PlanError, allowedTrackFiles, buildStartPayload, cleanCountdown, cleanDevices, cleanPreview, type PlanSource } from '../../shared/record/plan'
import { countMarkers, finalizeTake, sanitizeTakeMeta, type MarkerKind, type TakeCursorInfo, type TakeMeta } from '../../shared/record/take'
import type { DisplayInfo } from '../../shared/record/region'
import type {
  PreviewSelection, RecordDevices, RecordFrame, RecordLevel, RecordPlan, RecordStatus, RecordStopResult, RecorderOpenTrack, RecorderStartPayload
} from '../../shared/record/types'
import { setVideoCaptureActive } from './captureLock'
import type { TakeWriter } from './takeWriter'

/**
 * 撮影の流れ（main）。録画ウインドウ（RecorderLink）・ファイルの書き込み・カーソルの記録・目印のホットキー・取り込みをつなぐ。
 * Electron に直接触らない（差し替えて単体テストで確かめる）。本物のつなぎは ipc.ts が作る。
 *
 *   idle → countdown → recording → stopping → ingesting → idle
 *
 * countdown から stopping までは videoCaptureActive() が true（Ferret のレビューの録画を始めない）。
 * レビューの録画中は撮影を始めない（reviewRecording）。開始は利用者の操作の直後に1回だけ（consumeGesture）。
 */

/** 録画ウインドウから main へ届くもの */
export interface RecorderLinkHandlers {
  /** トラックのファイルを開く。許していない名前なら投げる（録画ウインドウはそのトラックを録らない） */
  openTrack(spec: RecorderOpenTrack): void
  chunk(file: string, data: Uint8Array): void
  /** take.json の中身（録画ウインドウの時計の目印・トラックの時刻） */
  meta(raw: unknown): void
  frame(frame: RecordFrame): void
  levels(levels: RecordLevel[]): void
  devices(raw: unknown): void
  /** 録画は続くが知らせたいこと（機器が外れた・PC の音声が取れない） */
  warning(message: string): void
  /** 録画ウインドウが落ちた・閉じた */
  gone(reason: string): void
}

/** 非表示の録画ウインドウ（recorderWindow.ts） */
export interface RecorderLink {
  readonly alive: boolean
  open(): Promise<void>
  enumerate(): Promise<unknown>
  preview(selection: PreviewSelection): void
  /** 録画を始める。全トラックが動き出したら、録画ウインドウの時計の起点を返す */
  start(payload: RecorderStartPayload): Promise<{ startedAtMs: number; timeOrigin: number }>
  mark(kind: MarkerKind): void
  /** 止めて、最後の塊を書き終えたら最後の take.json の中身を返す */
  stop(): Promise<unknown>
  dispose(): void
}

export type GestureAction = 'record' | 'sources' | 'choice'

export interface SessionDeps {
  createLink(handlers: RecorderLinkHandlers): RecorderLink
  writer: TakeWriter
  cursor: { start(takeId: string, takeDir: string, displayId: string | null, epochStartMs: number, region?: unknown): TakeCursorInfo; stop(takeId: string): void }
  /** desktopCapturer の一覧（サムネイル無し。速い） */
  listSources(): Promise<PlanSource[]>
  displays(): DisplayInfo[]
  systemAudioSupported(): boolean
  /** Ferret のレビューの録画中か */
  reviewRecording(): boolean
  consumeGesture(action: GestureAction): boolean
  /** 画面から届いた動画のフォルダを確かめる（今のチャンネルの中の動画のフォルダだけ）。だめなら投げる */
  resolveVideoDir(dir: unknown): string
  runIngest(videoDir: string): Promise<{ ok: boolean; message: string }>
  /** 設定 record.region（生の値） */
  region(): unknown
  autoStart(): boolean
  hotkeys: { ng: string; important: string }
  registerHotkey(accelerator: string, fn: () => void): boolean
  unregisterHotkey(accelerator: string): void
  emitStatus(status: RecordStatus): void
  emitLevels(levels: RecordLevel[]): void
  emitFrame(frame: RecordFrame): void
  emitDevices(devices: RecordDevices): void
  wait(ms: number): Promise<void>
  now(): Date
  app: { version: string; os: string }
  report(err: unknown, op: string): void
}

const IDLE: RecordStatus = { state: 'idle', markers: { ng: 0, important: 0 }, bytes: 0, tracks: 0 }
/** 状態の知らせを送る間隔の下限（塊は1秒ごとに全トラックから届く） */
const STATUS_THROTTLE_MS = 500

export function userError(key: TranslationKey, params?: Record<string, string | number>): UserFacingError {
  return new UserFacingError(t(key, params))
}

const PLAN_MESSAGES: Record<PlanError['problem'], TranslationKey> = {
  nothingSelected: 'video.record.errors.nothingSelected',
  screenMissing: 'video.record.errors.screenMissing',
  cameraMissing: 'video.record.errors.cameraMissing',
  micMissing: 'video.record.errors.micMissing',
  tooManyCameras: 'video.record.errors.tooManyCameras',
  tooManyMics: 'video.record.errors.tooManyMics',
  systemAudioUnsupported: 'video.record.errors.systemAudioUnsupported'
}

interface Active {
  takeId: string
  videoDir: string
  payload: RecorderStartPayload
  allowed: Map<string, RecorderOpenTrack['kind']>
  meta: TakeMeta | null
  cursor: TakeCursorInfo | null
  failed: Set<string>
  bytes: Map<string, number>
}

export class RecordSession {
  private link: RecorderLink | null = null
  private status: RecordStatus = { ...IDLE }
  private devices: RecordDevices = { cameras: [], mics: [] }
  private active: Active | null = null
  private cancelCountdown = false
  private lastEmit = 0
  private hotkeysOn: string[] = []

  constructor(private readonly deps: SessionDeps) {}

  get current(): RecordStatus {
    return this.status
  }

  get knownDevices(): RecordDevices {
    return this.devices
  }

  private set(next: Partial<RecordStatus>, force = true): void {
    this.status = { ...this.status, ...next }
    const now = Date.now()
    if (!force && now - this.lastEmit < STATUS_THROTTLE_MS) return
    this.lastEmit = now
    this.deps.emitStatus(this.status)
  }

  private handlers(): RecorderLinkHandlers {
    return {
      openTrack: (spec) => this.openTrack(spec),
      chunk: (file, data) => this.chunk(file, data),
      meta: (raw) => this.meta(raw),
      frame: (frame) => this.deps.emitFrame(frame),
      levels: (levels) => this.deps.emitLevels(levels),
      devices: (raw) => {
        this.devices = cleanDevices(raw)
        this.deps.emitDevices(this.devices)
      },
      warning: (message) => { if (this.active) this.set({ warning: message }) },
      gone: (reason) => this.gone(reason)
    }
  }

  /** 録画ウインドウを用意して、機器の一覧を読む */
  async prepare(): Promise<RecordDevices> {
    if (!this.link || !this.link.alive) {
      this.link?.dispose()
      this.link = this.deps.createLink(this.handlers())
      try {
        await this.link.open()
      } catch (err) {
        this.link.dispose()
        this.link = null
        this.deps.report(err, 'open recorder window')
        throw userError('video.record.errors.notReady')
      }
    }
    this.devices = cleanDevices(await this.link.enumerate())
    return this.devices
  }

  async preview(selection: unknown): Promise<void> {
    // 録画中はプレビューの選択を変えない（録っているトラックを閉じない）
    if (!this.link || this.status.state !== 'idle') return
    const wantsScreen = !!selection && typeof selection === 'object' && typeof (selection as { screenSourceId?: unknown }).screenSourceId === 'string'
    const sources = wantsScreen ? await this.deps.listSources().catch(() => [] as PlanSource[]) : []
    this.link?.preview(cleanPreview(selection, this.devices, sources))
  }

  /** カウントダウンのあと録画を始める */
  async start(planIn: RecordPlan): Promise<{ takeId: string } | { cancelled: true }> {
    if (this.status.state !== 'idle') throw userError('video.record.errors.busy')
    if (this.deps.reviewRecording()) throw userError('video.record.errors.reviewRecording')
    if (!planIn || typeof planIn !== 'object') throw userError('video.record.errors.nothingSelected')
    const videoDir = this.deps.resolveVideoDir(planIn.videoDir)
    if (!this.deps.consumeGesture('record')) throw userError('video.record.errors.needsUserAction')
    if (!this.link || !this.link.alive) await this.prepare()
    const sources = planIn.screen ? await this.deps.listSources() : []
    // テイクの ID とフォルダはカウントダウンのあとに作る（取り消したテイクのフォルダを残さない）。選択はここで先に確かめる
    const check = (takeId: string, createdAt: Date) => {
      try {
        return buildStartPayload(planIn, {
          takeId, createdAt: createdAt.toISOString(), app: this.deps.app, sources, displays: this.deps.displays(), devices: this.devices,
          region: this.deps.region(), systemAudioSupported: this.deps.systemAudioSupported(), messages: recorderMessages()
        })
      } catch (err) {
        if (err instanceof PlanError) throw userError(PLAN_MESSAGES[err.problem])
        throw err
      }
    }
    check('take_check', this.deps.now())

    setVideoCaptureActive(true)
    this.cancelCountdown = false
    try {
      for (let left = cleanCountdown(planIn.countdownSec); left > 0; left--) {
        this.set({ ...IDLE, state: 'countdown', countdown: left, videoDir })
        await this.deps.wait(1000)
        if (this.cancelCountdown) {
          this.set({ ...IDLE })
          setVideoCaptureActive(false)
          return { cancelled: true }
        }
      }
      if (this.deps.reviewRecording()) throw userError('video.record.errors.reviewRecording')
      if (!this.link || !this.link.alive) throw userError('video.record.errors.notReady')
      const { takeId, takeDir } = this.deps.writer.beginTake(videoDir)
      const payload = check(takeId, this.deps.now())
      this.active = { takeId, videoDir, payload, allowed: allowedTrackFiles(payload), meta: null, cursor: null, failed: new Set(), bytes: new Map() }
      this.set({ ...IDLE, state: 'recording', takeId, videoDir, startedAt: this.deps.now().getTime() })
      let started: { startedAtMs: number; timeOrigin: number }
      try {
        started = await this.link.start(payload)
      } catch (err) {
        this.deps.writer.endTake(takeId)
        this.active = null
        this.deps.report(err, 'start recording')
        throw userError('video.record.errors.startFailed', { message: err instanceof Error ? err.message : String(err) })
      }
      if (payload.screen) {
        try {
          this.active.cursor = this.deps.cursor.start(takeId, takeDir, payload.screen.display?.id ?? null, started.timeOrigin + started.startedAtMs, payload.screen.region)
        } catch (err) {
          // カーソルの記録が無くても録画は続ける
          this.deps.report(err, 'start cursor log')
        }
      }
      this.registerHotkeys()
      this.set({ tracks: this.openCount(), startedAt: this.deps.now().getTime() })
      return { takeId }
    } catch (err) {
      if (this.status.state !== 'idle') this.set({ ...IDLE })
      setVideoCaptureActive(false)
      throw err
    }
  }

  private openCount(): number {
    const a = this.active
    if (!a) return 0
    return [...a.allowed.keys()].filter((file) => this.deps.writer.isOpen(a.takeId, file)).length
  }

  private openTrack(spec: RecorderOpenTrack): void {
    const a = this.active
    if (!a || !spec || typeof spec !== 'object') throw new Error('not recording')
    const kind = a.allowed.get(spec.file)
    if (!kind || kind !== spec.kind) throw new Error(`track not allowed: ${String(spec.file)}`)
    // 映像は .mp4 か .webm のどちらか1つだけ
    const base = spec.file.replace(/\.(mp4|webm)$/, '')
    if (base !== spec.file && [`${base}.mp4`, `${base}.webm`].some((f) => this.deps.writer.isOpen(a.takeId, f))) throw new Error(`track already open: ${base}`)
    this.deps.writer.openTrack(a.takeId, spec)
    this.set({ tracks: this.openCount() })
  }

  private chunk(file: string, data: Uint8Array): void {
    const a = this.active
    if (!a || a.failed.has(file) || !(data instanceof Uint8Array) || data.byteLength === 0) return
    try {
      a.bytes.set(file, this.deps.writer.appendTrack(a.takeId, file, data))
    } catch (err) {
      // ディスクがいっぱい・消された。このトラックは書くのをやめ、ほかのトラックは続ける
      a.failed.add(file)
      this.deps.report(err, 'append track')
      this.set({ warning: t('video.record.errors.writeFailed', { file }) })
      return
    }
    let bytes = 0
    for (const n of a.bytes.values()) bytes += n
    this.set({ bytes }, false)
  }

  private meta(raw: unknown): void {
    const a = this.active
    if (!a) return
    const meta = sanitizeTakeMeta(raw, a.takeId)
    if (!meta) return
    a.meta = meta
    this.set({ markers: countMarkers(meta.markers) })
    this.writeMeta()
  }

  private writeMeta(): void {
    const a = this.active
    if (!a?.meta) return
    const meta: TakeMeta = a.cursor ? { ...a.meta, cursor: a.cursor } : a.meta
    for (const tr of meta.tracks) {
      const bytes = a.bytes.get(tr.file)
      if (bytes !== undefined) tr.bytes = bytes
    }
    try {
      this.deps.writer.writeMeta(a.takeId, meta)
    } catch (err) {
      this.deps.report(err, 'write take.json')
      this.set({ warning: t('video.record.errors.writeFailed', { file: 'take.json' }) })
    }
  }

  mark(kind: unknown): void {
    if (this.status.state !== 'recording' || (kind !== 'ng' && kind !== 'important')) return
    this.link?.mark(kind)
  }

  private registerHotkeys(): void {
    this.unregisterHotkeys()
    for (const [accel, kind] of [[this.deps.hotkeys.ng, 'ng'], [this.deps.hotkeys.important, 'important']] as const) {
      if (!accel) continue
      try {
        if (this.deps.registerHotkey(accel, () => this.mark(kind))) this.hotkeysOn.push(accel)
      } catch (err) {
        // ほかのアプリが使っているキー・形の違う指定。画面のボタンは使える
        this.deps.report(err, 'register marker hotkey')
      }
    }
  }

  private unregisterHotkeys(): void {
    for (const accel of this.hotkeysOn.splice(0)) {
      try {
        this.deps.unregisterHotkey(accel)
      } catch {
        // 外せなくても続ける
      }
    }
  }

  /** 止めて取り込む。カウントダウン中なら取り消す。録っていなければ null */
  async stop(): Promise<RecordStopResult | null> {
    if (this.status.state === 'countdown') {
      this.cancelCountdown = true
      return { takeId: '', videoDir: this.status.videoDir ?? '', cancelled: true, ingest: null, autoStart: false }
    }
    const a = this.active
    if (this.status.state !== 'recording' || !a) return null
    this.set({ state: 'stopping' })
    this.unregisterHotkeys()
    let finalRaw: unknown = null
    try {
      finalRaw = this.link?.alive ? await this.link.stop() : null
    } catch (err) {
      this.deps.report(err, 'stop recording')
    }
    this.finish(a, finalRaw, true)
    setVideoCaptureActive(false)
    this.set({ state: 'ingesting' })
    let ingest: { ok: boolean; message: string }
    try {
      ingest = await this.deps.runIngest(a.videoDir)
    } catch (err) {
      this.deps.report(err, 'ingest')
      ingest = { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    this.set({ ...IDLE })
    return { takeId: a.takeId, videoDir: a.videoDir, ingest, autoStart: ingest.ok && this.deps.autoStart() }
  }

  /** 最後の記録を書いてファイルを閉じる。complete = 止める操作で最後まで書けた */
  private finish(a: Active, finalRaw: unknown, complete: boolean): void {
    this.deps.cursor.stop(a.takeId)
    const last = sanitizeTakeMeta(finalRaw, a.takeId) ?? a.meta
    if (last) {
      // 最後の記録が届かなかった（止める知らせが時間切れ）ときは、経過時間から止めた時刻を見積もる
      const elapsed = this.status.startedAt !== undefined ? Math.max(0, this.deps.now().getTime() - this.status.startedAt) : 0
      const stoppedAtMs = last.stoppedAtMs ?? last.startedAtMs + elapsed
      a.meta = complete ? finalizeTake(last, stoppedAtMs) : { ...last, stoppedAtMs, complete: false }
      this.writeMeta()
    }
    this.deps.writer.endTake(a.takeId)
    this.active = null
  }

  /** 録画ウインドウが落ちた。そこまでのファイルは残す（take.json は complete: false） */
  private gone(reason: string): void {
    this.link = null
    const a = this.active
    if (this.status.state === 'countdown') this.cancelCountdown = true
    if (!a) return
    this.deps.report(new Error(`recorder window gone: ${reason}`), 'recorder gone')
    this.unregisterHotkeys()
    this.finish(a, null, false)
    setVideoCaptureActive(false)
    this.set({ ...IDLE, takeId: a.takeId, videoDir: a.videoDir, warning: t('video.record.errors.recorderGone') })
  }

  /** 撮影の画面を閉じた。録画中でなければ録画ウインドウを閉じる */
  close(): void {
    if (this.status.state !== 'idle') return
    this.link?.dispose()
    this.link = null
  }

  /** アプリを終える。録画中なら、そこまでを残して閉じる */
  dispose(): void {
    this.unregisterHotkeys()
    const a = this.active
    if (a) this.finish(a, null, false)
    this.link?.dispose()
    this.link = null
    setVideoCaptureActive(false)
    this.status = { ...IDLE }
  }
}

/** 録画ウインドウが出す文（画面の言語） */
export function recorderMessages(): RecorderStartPayload['messages'] {
  return {
    trackEnded: t('video.record.recorder.trackEnded'),
    micFailed: t('video.record.recorder.micFailed'),
    cameraFailed: t('video.record.recorder.cameraFailed'),
    screenFailed: t('video.record.recorder.screenFailed'),
    systemAudioFailed: t('video.record.recorder.systemAudioFailed')
  }
}
