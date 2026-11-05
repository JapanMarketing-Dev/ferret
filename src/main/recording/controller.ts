import { delay } from '@shared/delay'
import { ipcMain, type WebContents } from 'electron'
import { appendFileNoFollow, mkdirContained } from '../sessions/containment'
import { redactUrl } from '../pipeline/redact'
import { basename, dirname, join } from 'node:path'
import { captureTargetGap, captureTargetLabel, resolveCaptureTarget, targetFromSource, targetParts, targetSourceIds } from '@shared/captureTarget'
import {
  EXTRA_TRACK_BITS_PER_SECOND,
  EXTRA_TRACK_MAX_FPS,
  MAX_CAPTURE_TRACKS,
  WATCH_POLL_MS,
  nextTrackId,
  planWatch,
  trackLabel,
  waitingWindows,
  watchUnavailable,
  type CaptureTracksState,
  type WatchedWindow
} from '@shared/captureTracks'
import { RecordingClock } from './clock'
import { isPageChange } from '@shared/page'
import { DEFAULT_ANNOTATION_COLOR, type AnnotationColor } from '@shared/annotation'
import { mapPopupBox, popupHost, popupReturnTrack, reviewSurfaceOf } from '@shared/popupAnnotation'
import { RecorderWindow, type VideoSource } from './recorderWindow'
import { mirrorSourceParam } from '@shared/captureComposite'
import { listCaptureSources, screenAccess } from './sources'
import { readDevice } from './devices'
import { StillCapturer, mirrorStillSource, overlayStillSource, webContentsStillSource, type StillSource } from './stills'
import {
  defaultRecordingOptions,
  type AudioLevel,
  type BrowserOverlay,
  type PcmBlock,
  type RecordingHandlers,
  type RecordingOptions,
  type RecordingResult,
  type RecordingState,
  type RecordingStatus,
  type TrackRecordInfo
} from './types'
import type { Event } from '../pipeline/types'
import type { CaptureTarget } from '@shared/types'
import { shouldCaptureStill, toJsonLine, toLogEvent, type RawReviewEvent } from './events'
import { ReviewEventBudget, type Admission, type ReviewInputKind } from './eventBudget'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'
import { boundedStep, safeStep } from './stopStep'

/**
 * 録画の司令塔（要件 5.3・5.4 / 設計 4章）。
 *
 * 1つの時計（RecordingClock）を持ち、動画・静止画・音声・操作ログの時刻をそこに揃える。
 * 各データは録画中に逐次ディスクへ書くので、落ちてもその時点まで残る（NF-12）。
 *
 * ──────────────────────── 使い方 ────────────────────────
 *   const rec = new RecordingController({ assets, handlers })
 *   rec.attach(browser.contents)            // 内蔵ブラウザの webContents
 *   await rec.start({ paths, captureSystemAudio: true })
 *   rec.setAnnotationMode('pen')            // ペンON（PEN-2）
 *   rec.pause() / rec.resume()
 *   const result = await rec.stop()
 */

const REVIEW_CHANNELS = {
  event: 'ade-review:event',
  command: 'ade-review:command',
  ready: 'ade-review:ready',
  /** 注入側の書き込みの「元に戻す／やり直す」ができるか（ツールバーのボタンの有効・無効） */
  history: 'ade-review:history',
  /** ページに焦点があるときに押された、書き込みの道具の切り替えキー（ツールバーへ渡す） */
  shortcut: 'ade-review:shortcut'
} as const

/** 書き込みの道具。依頼は声とペンで行うので、ペンだけ（画面に文字を置く道具は廃止した） */
export type AnnotationMode = 'off' | 'pen' | 'rect'

/** 画面収録の許可が無いときの案内。選択画面の案内（CaptureTargetPicker）と同じ手順を書く */
/** 画面・ウインドウの取り込み元。複数選んだときは、ほかの画面・ウインドウも一緒に渡して1本の動画に並べる（recorder.ts） */
function desktopVideo(target: CaptureTarget): VideoSource {
  const [main = '', ...extra] = targetSourceIds(target)
  return { kind: 'desktop', sourceId: main, ...(extra.length ? { extraSourceIds: extra } : {}) }
}

function screenAccessMessage(): string {
  return t('recording.errors.screenPermission')
}

/**
 * ページが変わったとき、注入側が入力中の文を確定して返事をくれるまで待つ上限(ms)。
 * 返事が来なくても、書き込みを新しいページへ持ち越さないよう消して進める。
 */
const LEAVE_TIMEOUT_MS = 600

/** events.jsonl への書き込みの待ち行列の上限。ディスクが詰まっても、書けない操作ログをメモリに積み続けない */
const MAX_PENDING_EVENT_WRITES = 1000
/** 停止のとき、events.jsonl の書き込みを待つ上限(ms) */
const EVENT_WRITES_STOP_TIMEOUT_MS = 5_000
/** 停止のとき、静止画の書き終わり・トラックの切り替えを待つ上限(ms) */
const STOP_STEP_TIMEOUT_MS = 7_000
/** 停止のとき、録画ウインドウが最後の塊を書き終えるのを待つ上限(ms)。RecorderWindow.stop の上限（返事5秒＋書き終わり5秒）より少し長い */
const RECORDER_STOP_TIMEOUT_MS = 12_000

export interface RecordingAssets {
  recorderHtml: string
  recorderPreload: string
}

/**
 * 画面全体・別のウインドウを録る間、その映像を内蔵ブラウザの場所に映すビュー（browser.ts の showMirror）。
 * 映したビューには書き込みの注入スクリプトが入っているので、書き込みはそこで受ける
 */
export interface CaptureMirror {
  show(sourceId: string): Promise<WebContents | null>
  /** 録画が終わった。録画の前の表示（選んだウインドウ・内蔵ブラウザ）へ戻す */
  hide(): void
  /** 録画中に内蔵ブラウザのトラックへ切り替えた。録画が終わるまで、何も映さず内蔵ブラウザを見せる */
  showBrowser?(): void
}

/**
 * 1回の録画の映像1本（@shared/captureTracks）。main は録画を始めたときの対象で、音声も録る（this.recorder と同じ録画ウインドウ）。
 * ほかは映像だけを tracks/<id>.webm へ録る
 */
interface Track {
  id: string
  target: CaptureTarget
  label: string
  video: VideoSource
  recorder: RecorderWindow
  /** レビューのフォルダからの相対パス */
  videoRel: string
  startMs: number
  endMs?: number
  watchId?: string
  live: boolean
  /** ログインのポップアップ（内蔵ブラウザが開いた子ウインドウ）の映像。書き込みはその窓の中で引く */
  popup?: WebContents
}

export class RecordingController {
  private source: WebContents | null = null
  /** 画面・ウインドウの映像を映したビュー。録画中だけ。あれば書き込みはこちらで受ける */
  private mirrorContents: WebContents | null = null
  /** 録画中に映すものを切り替えた（止めたときに、録画の前の表示へ戻す） */
  private mirrorSwitched = false
  private mirror: CaptureMirror | null = null
  private clock: RecordingClock | null = null
  private recorder: RecorderWindow | null = null
  private lastViewWidth = 0
  private lastCursor?: { x: number; y: number; view?: { width: number; height: number } }
  private stills: StillCapturer | null = null
  private options: RecordingOptions | null = null
  private state: RecordingState = 'idle'
  private startedAt = ''
  private readonly events: Event[] = []
  private readonly warnings: string[] = []
  private readonly samples: Record<'mic' | 'system', number> = { mic: 0, system: 0 }
  private annotationMode: AnnotationMode = 'off'
  /** 書き込みの色。録画をまたいで引き継ぐ（設定の capture.annotationColor） */
  private annotationColor: AnnotationColor = DEFAULT_ANNOTATION_COLOR
  private limitWarningTimer: NodeJS.Timeout | null = null
  private maxDurationTimer: NodeJS.Timeout | null = null
  private boundReview = false
  private statusTimer: NodeJS.Timeout | null = null
  private lastStatus: RecordingStatus | null = null
  private eventWrites: Promise<void> = Promise.resolve()
  private pendingEventWrites = 0
  /** 注入スクリプトから届く入力の頻度と総量の上限（録画ごとに作り直す） */
  private budget = new ReviewEventBudget()
  /** 上限で捨てたことを知らせたか（録画ごとに1度だけ出す） */
  private readonly limitWarned = new Set<Admission>()
  /** 書き込みが属するページのURL（ハッシュ違いは同じページ。page.ts） */
  private pageUrl = ''
  /** ページが変わり、書き込みを片付けている途中の行き先URL */
  private pendingLeave: string | null = null
  private leaveTimer: NodeJS.Timeout | null = null
  /** 録っている映像（main とあとから足したもの。閉じたものも録画の終わりまで残す） */
  private tracks: Track[] = []
  /** 画面に映して書き込んでいるトラック */
  private activeTrackId = 'main'
  /** トラックの追加・切り替え・閉じるを1つずつ行う */
  private trackQueue: Promise<unknown> = Promise.resolve()
  /** 待ち受けるウインドウ（プロジェクトの確認先の watch） */
  private watched: WatchedWindow[] = []
  private watchTimer: NodeJS.Timeout | null = null
  private watchBusy = false
  private watchProblem: CaptureTracksState['watchUnavailable'] | undefined
  /** 待ち受けのウインドウを録れなかったと知らせた確認先（同じ失敗を1秒ごとに出さない） */
  private readonly watchFailed = new Set<string>()
  /** 内蔵ブラウザのページの大きさ（CSS px）。拡張機能のポップアップの書き込みの座標を直すのに使う */
  private lastBrowserView?: { width: number; height: number }
  /** 最後に書き込みを確定した面（ツールバーの元に戻す・やり直すはそこへ送る） */
  private lastSurface: WebContents | null = null
  /** 開いているログインのポップアップの中身と、開いたときの URL（トラックの名前に使う） */
  private readonly popupWindows = new Map<WebContents, string>()
  /** ログインのポップアップへ切り替える前に映していたトラック（ポップアップから戻るときに使う） */
  private popupReturnTrackId: string | null = null
  /** 前に出たら書き込みを戻す面に付けた focus の受け口（同じものに二重に付けない） */
  private readonly focusWatched = new WeakSet<WebContents>()
  /** 結びつけた内蔵ブラウザのタブ（同じタブに受け口を二重に付けない） */
  private readonly attachedTabs = new WeakSet<WebContents>()
  /** 内蔵ブラウザでいま前に出ているタブ（browser.ts の onActiveTab）。録画していない間は source と同じ */
  private browserTab: WebContents | null = null
  /** 録画中に前に出た空のタブ。URL が入ったら、そのタブの映像を録り始める */
  private pendingTab: WebContents | null = null

  constructor(
    private readonly assets: RecordingAssets,
    private readonly handlers: RecordingHandlers = {}
  ) {}

  /**
   * 録る対象（内蔵ブラウザのタブの webContents）を結びつける。タブごとに1度（同じタブは二度結びつけない）。
   * モード切替でビューを作り直さないので、タブを開いたときだけでよい。録るのは前に出ているタブ（selectBrowserTab）
   */
  attach(contents: WebContents): void {
    this.bindReview()
    if (contents.isDestroyed() || this.attachedTabs.has(contents)) return
    this.attachedTabs.add(contents)
    const wc = contents
    if (!this.source || this.source.isDestroyed()) {
      this.source = wc
      this.pageUrl = wc.getURL()
    }
    if (!this.browserTab || this.browserTab.isDestroyed()) this.browserTab = wc
    // ログインのポップアップで書き込んでいる間に内蔵ブラウザを押したら、書き込みを内蔵ブラウザへ戻す
    this.watchFocusBack(wc)

    // 遷移のたびに注入スクリプトが読み直されるので、現在のモードを送り直す
    wc.on('did-finish-load', () => this.pushMode())
    // 別のドキュメントへ移る前に、入力中の文を確定させる（ページを離れると吹き出しごと消えるため）
    wc.on('did-start-navigation', (details) => {
      if (wc === this.source && this.recordsBrowser && details.isMainFrame && !details.isSameDocument && isPageChange(this.pageUrl, details.url)) {
        this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'commit' })
      }
    })
    // 別のドキュメントへ移ったときは注入スクリプトごと読み直されるので、書き込みは自然に消える
    wc.on('did-navigate', (_e, url) => {
      // 録画中に開いた空のタブに URL が入った。そのタブを録り始める
      if (wc === this.pendingTab) return this.selectBrowserTab(wc, true)
      if (wc !== this.source) return
      this.pageUrl = url
      this.recordNav(url)
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && wc === this.source) this.onInPageNavigate(url)
    })
  }

  /**
   * 内蔵ブラウザで前に出ているタブが変わった（browser.ts の onActiveTab）。
   * 録画中に内蔵ブラウザを映しているなら、そのタブの映像（トラック）へ切り替える。まだ録っていないタブなら1本足す
   * （切り替えは track と nav の操作ログに残るので、指摘がどのタブのページの話かが分かる）
   */
  selectBrowserTab(contents: WebContents, again = false): void {
    if (contents.isDestroyed() || (!again && contents === this.browserTab && contents === this.source)) return
    this.attach(contents)
    this.browserTab = contents
    if (!this.capturing) {
      this.pendingTab = null
      this.source = contents
      this.pageUrl = contents.getURL()
      return
    }
    void this.serialTracks(() => this.followBrowserTabNow(contents)).catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'follow browser tab' }))
  }

  private async followBrowserTabNow(contents: WebContents): Promise<void> {
    if (!this.capturing || contents.isDestroyed() || contents !== this.browserTab) return
    this.pendingTab = null
    const active = this.activeTrack
    // 画面・ウインドウ・ログインのポップアップを映している間は、内蔵ブラウザのどのタブかだけ覚えておく（内蔵ブラウザへ戻したときに使う）
    if (!active || active.popup || active.video.kind !== 'tab') {
      this.source = contents
      this.pageUrl = contents.getURL()
      return
    }
    const live = this.tracks.filter((track) => track.live)
    const same = live.find((track) => !track.popup && track.video.kind === 'tab' && track.video.contents === contents)
    if (same) return this.switchTrackNow(same.id)
    // 空のタブ（URL 欄から入れる前）はまだ録らない。URL が入ったら録り始める（attach の did-navigate）
    const url = contents.getURL()
    if (!url || url === 'about:blank') {
      this.pendingTab = contents
      return
    }
    if (live.length >= MAX_CAPTURE_TRACKS) {
      // 上限なら、いま映していないほかのタブの映像を閉じて空ける（録った分は残る）
      const spare = live.find((track) => track.id !== 'main' && track !== active && !track.popup && track.video.kind === 'tab')
      if (!spare) {
        this.warn(t('recording.tracks.limit', { n: MAX_CAPTURE_TRACKS }))
        return
      }
      await this.closeTrackNow(spare.id)
    }
    const label = t('recording.tracks.tabLabel', { host: popupHost(url) || '-' })
    await this.startTrack({ kind: 'tab', contents }, { kind: 'browser' }, label, { activate: true })
  }

  /** 内蔵ブラウザのタブを閉じた。そのタブの映像（main 以外）を閉じる。main は音声も録っているので録画の終わりまで残す */
  browserTabClosed(contents: WebContents): void {
    if (this.pendingTab === contents) this.pendingTab = null
    const track = this.tracks.find((candidate) => candidate.live && candidate.id !== 'main' && !candidate.popup && candidate.video.kind === 'tab' && candidate.video.contents === contents)
    if (track) void this.closeTrack(track.id)
  }

  /** 録画がそのタブの映像を録っている（録った）か。録画中に閉じたタブは、録画が終わるまで中身を残す */
  usesContents(contents: WebContents): boolean {
    return this.capturing && this.tracks.some((track) => track.video.kind === 'tab' && track.video.contents === contents)
  }

  /** 画面・ウインドウを録るときに映像を映す先を結びつける */
  setMirror(mirror: CaptureMirror): void {
    this.mirror = mirror
  }

  /** 内蔵ブラウザのビューの上に重なっているもの（拡張機能のポップアップ）。録画していない間も覚えておき、録り始めたら重ねる */
  private overlay: BrowserOverlay | null = null

  /**
   * 拡張機能のポップアップが開いた・動いた・閉じた（null）。
   * 内蔵ブラウザを録っている間は、動画（録画ウインドウの合成）と静止画（overlayStillSource）の両方に重ねる
   */
  setBrowserOverlay(overlay: BrowserOverlay | null): void {
    const before = this.overlay?.contents ?? null
    this.overlay = overlay && !overlay.contents.isDestroyed() ? overlay : null
    if (this.state !== 'idle' && this.options?.captureTarget.kind === 'browser') this.recorder?.setOverlay(this.overlay)
    const now = this.overlay?.contents ?? null
    if (now === before) return
    if (this.lastSurface === before) this.lastSurface = null
    // 新しく開いたポップアップ（注入スクリプトが入っていれば）にも、いまの道具を送る。
    // 注入側の準備の知らせ（ready）は、ポップアップがここへ届くより先に来ることがあるので、ここでも送る
    const surface = this.overlaySurface
    if (surface) this.pushModeTo(surface)
  }

  /** いまの書き込みの道具 */
  get annotationModeNow(): AnnotationMode {
    return this.annotationMode
  }

  /**
   * ログインのポップアップ（内蔵ブラウザが window.open で開いた子ウインドウ）を結びつける。
   * 録画中は映像を1本足し（タブ録画。OS の画面収録の許可は要らない）、その窓が前に出たら映すもの（書き込む先）をそちらへ切り替える。
   * 窓が閉じたらトラックを閉じ、前に映していたものへ戻す
   */
  attachPopupWindow(contents: WebContents, url: string): void {
    if (contents.isDestroyed() || this.popupWindows.has(contents)) return
    this.popupWindows.set(contents, url)
    contents.on('focus', () => {
      if (!this.capturing || contents.isDestroyed()) return
      void this.serialTracks(() => this.addPopupTrackNow(contents, true)).catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'switch to popup' }))
    })
    contents.once('destroyed', () => {
      this.popupWindows.delete(contents)
      const track = this.tracks.find((candidate) => candidate.popup === contents && candidate.live)
      if (track) void this.closeTrack(track.id)
    })
    if (this.capturing) void this.serialTracks(() => this.addPopupTrackNow(contents, contents.isFocused())).catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'add popup track' }))
  }

  /** 書き込みを受ける面が前に出たら（押された）、ログインのポップアップで書き込んでいたのをやめて、その面のトラックへ戻す */
  private watchFocusBack(wc: WebContents): void {
    if (this.focusWatched.has(wc)) return
    this.focusWatched.add(wc)
    wc.on('focus', () => {
      if (!this.capturing || !this.activeTrack?.popup) return
      const target = popupReturnTrack(this.popupReturnTrackId, this.tracks.filter((track) => track.live && !track.popup).map((track) => track.id))
      void this.switchTrack(target).catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'return from popup' }))
    })
  }

  /**
   * SPA の画面遷移（pushState など）。ドキュメントはそのままなので、書き込みが残ってしまう。
   * パスかクエリが変わったら、その画面の書き込みを記録し終えてから消す（ハッシュだけなら残す）。
   *
   * 手順: 注入側へ leave → 入力中の文・描きかけの線を確定して送ってくる → 返事（left）
   *       → その静止画を撮り終えるのを待つ → 消す → 遷移を記録する。
   * 遷移の記録を最後にするので、確定した書き込みは前のページのURLの指摘になる（context.ts は直前の nav を見る）。
   */
  private onInPageNavigate(url: string): void {
    const changed = isPageChange(this.pageUrl, url)
    this.pageUrl = url
    // 画面・ウインドウを録っているときの書き込みは映したビューのもので、内蔵ブラウザの遷移では消さない
    if (!changed || !this.recordsBrowser) {
      this.recordNav(url)
      return
    }
    if (this.state !== 'recording') {
      // 録画していない・一時停止中は書き込みが無効なので、残りがあっても消すだけ
      this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'clear', page: true })
      return
    }
    const first = this.pendingLeave === null
    this.pendingLeave = url
    if (!first) return
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'leave' })
    this.leaveTimer = setTimeout(() => void this.finishLeave(), LEAVE_TIMEOUT_MS)
    this.leaveTimer.unref?.()
  }

  /** 前のページの書き込みを記録し終えたので、消して新しいページの遷移を記録する */
  private async finishLeave(): Promise<void> {
    const url = this.pendingLeave
    if (url === null) return
    this.pendingLeave = null
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
    // 確定した書き込みの静止画（captureNow）は、消す前に撮り終える
    await this.stills?.settle()
    this.reviewContents?.send(REVIEW_CHANNELS.command, { type: 'clear', page: true })
    // 遷移直後の1枚に消し残りが写らないよう、注入側の描画が反映されるのを待つ
    await delay(60)
    this.recordNav(url)
  }

  private bindReview(): void {
    if (this.boundReview) return
    this.boundReview = true

    // 受けるのは、いま書き込みを受けている面（映しているトラック・その上の拡張機能のポップアップ）からだけ（reviewSurfaceOf）
    ipcMain.on(REVIEW_CHANNELS.ready, (event) => {
      if (this.surfaceOf(event.sender)) this.pushModeTo(event.sender)
    })

    ipcMain.on(REVIEW_CHANNELS.history, (event, history: unknown) => {
      if (!this.surfaceOf(event.sender) || !this.admit('history')) return
      const value = history as { canUndo?: unknown; canRedo?: unknown } | null
      this.handlers.onAnnotationHistory?.({ canUndo: value?.canUndo === true, canRedo: value?.canRedo === true })
    })

    ipcMain.on(REVIEW_CHANNELS.shortcut, (event, action: unknown) => {
      if (!this.surfaceOf(event.sender) || this.state !== 'recording' || !this.admit('shortcut')) return
      if (action === 'pen' || action === 'rect' || action === 'off' || action === 'color') this.handlers.onAnnotationShortcut?.(action)
    })

    ipcMain.on(REVIEW_CHANNELS.event, (event, raw: RawReviewEvent) => {
      const surface = this.surfaceOf(event.sender)
      if (!surface) return
      if (surface === 'overlay') return this.recordOverlayInjected(event.sender, raw)
      // ページ移動に伴う確定が済んだ返事（onInPageNavigate）
      if (raw?.type === 'left') return void this.finishLeave()
      this.recordInjected(raw)
    })
  }

  /** IPC の送り主が、いま書き込みを受けている面か（@shared/popupAnnotation の reviewSurfaceOf） */
  private surfaceOf(sender: unknown): 'review' | 'overlay' | null {
    return reviewSurfaceOf<unknown>(sender, { review: this.reviewContents, overlay: this.overlaySurface })
  }

  /**
   * 内蔵ブラウザを映しているときの、その上の拡張機能のポップアップ。録画・静止画に同じ位置で重なるので、その中にも書き込める
   * （注入スクリプトは録画中・文字で指摘の間に開いたポップアップにだけ入る。browserExtensions.ts）
   */
  private get overlaySurface(): WebContents | null {
    const top = this.overlay?.contents
    if (!top || top.isDestroyed()) return null
    const review = this.reviewContents
    return review && review === this.source ? top : null
  }

  /** いま書き込みを受けている面（映しているもの・その上の拡張機能のポップアップ） */
  private get surfaces(): WebContents[] {
    return [this.reviewContents, this.overlaySurface].filter((wc): wc is WebContents => !!wc)
  }

  /** いま書き込みを受けている面のすべてへ送る */
  private sendAll(command: Record<string, unknown>): void {
    for (const wc of this.surfaces) wc.send(REVIEW_CHANNELS.command, command)
  }

  /** 書き込みを受けるビュー。ログインのポップアップを映しているならその窓、画面・ウインドウを映しているならそちら、ほかは内蔵ブラウザ */
  private get reviewContents(): WebContents | null {
    const popup = this.activeTrack?.popup
    if (popup && !popup.isDestroyed()) return popup
    const mirror = this.mirrorContents
    if (mirror && !mirror.isDestroyed()) return mirror
    const wc = this.source
    return wc && !wc.isDestroyed() ? wc : null
  }

  private pushMode(): void {
    for (const wc of this.surfaces) this.pushModeTo(wc)
  }

  private pushModeTo(wc: WebContents): void {
    if (wc.isDestroyed()) return
    wc.send(REVIEW_CHANNELS.command, {
      type: 'config',
      maxHoldMs: this.options?.annotationMaxHoldMs ?? 30_000,
      color: this.annotationColor
    })
    wc.send(REVIEW_CHANNELS.command, {
      type: this.state === 'recording' ? 'enable' : 'disable'
    })
    if (this.state === 'recording') {
      wc.send(REVIEW_CHANNELS.command, { type: 'mode', mode: this.annotationMode })
    }
  }

  /** ペン／四角の枠／OFF の切り替え（PEN-2） */
  setAnnotationMode(mode: AnnotationMode): void {
    this.annotationMode = mode
    this.sendAll({ type: 'mode', mode })
  }

  /** 書き込みの色。描いてあるものはそのままで、次に描くものから変わる */
  setAnnotationColor(color: AnnotationColor): void {
    this.annotationColor = color
    this.sendAll({ type: 'color', color })
  }

  /**
   * 書き込み（線・四角の枠）を消す（PEN-3）。
   *
   * 呼び出し元は2つ:
   * - 手動の［消去］ボタン
   * - **発話の区切り**。pipeline の `SilenceSegmenter` が区切りを出した時点で呼ぶ
   *   （`new SilenceSegmenter((chunk) => { …; recording.clearAnnotations() })`）
   *
   * スクロールでの消去は注入スクリプト側が自分で行う。ページ遷移での消去は onInPageNavigate
   * （SPA）と、ドキュメントの読み直し（通常の遷移）で行う。
   * 指示が来ないまま残り続けないよう、注入側に上限（既定30秒）の保険がある。
   */
  clearAnnotations(manual = false): void {
    // 手動の［消去］だけは「元に戻す」で画面に戻せる。発話の区切りでの消去は戻す手順も片付ける
    this.sendAll({ type: 'clear', ...(manual ? { manual: true } : {}) })
  }

  /** 書き込みを一つ前に戻す・やり直す（描く・動かす・消去が1手）。最後に書き込んだ面（拡張機能のポップアップのこともある）へ送る */
  undoAnnotation(): void {
    this.undoTarget()?.send(REVIEW_CHANNELS.command, { type: 'undo' })
  }

  redoAnnotation(): void {
    this.undoTarget()?.send(REVIEW_CHANNELS.command, { type: 'redo' })
  }

  private undoTarget(): WebContents | null {
    const last = this.lastSurface
    return last && !last.isDestroyed() && this.surfaces.includes(last) ? last : this.reviewContents
  }

  get status(): RecordingStatus {
    return {
      state: this.state,
      elapsedMs: this.clock?.now() ?? this.lastStatus?.elapsedMs ?? 0,
      videoBytes: this.recorder?.videoBytes ?? this.lastStatus?.videoBytes ?? 0,
      frameCount: this.stills?.captured.length ?? this.lastStatus?.frameCount ?? 0,
      eventCount: this.events.length
    }
  }

  async start(partial: Partial<RecordingOptions> & Pick<RecordingOptions, 'paths'>): Promise<void> {
    if (this.state !== 'idle') throw new UserFacingError(t('recording.errors.alreadyRecording'))
    // 録るのは、内蔵ブラウザでいま前に出ているタブ
    if (this.browserTab && !this.browserTab.isDestroyed()) this.source = this.browserTab
    this.pendingTab = null
    const source = this.reviewContents
    const options: RecordingOptions = { ...defaultRecordingOptions, ...partial }
    const video = await this.resolveVideo(options, source)
    this.events.length = 0
    this.budget = new ReviewEventBudget()
    this.limitWarned.clear()
    this.lastViewWidth = 0
    this.lastCursor = undefined
    this.warnings.length = 0
    this.samples.mic = this.samples.system = 0
    this.annotationMode = 'off'
    this.lastStatus = null
    this.pendingLeave = null
    this.tracks = []
    this.activeTrackId = 'main'
    this.popupReturnTrackId = null
    this.lastSurface = null
    this.lastBrowserView = undefined
    this.watchFailed.clear()
    this.watchProblem = undefined

    this.options = options
    // 画面全体・別のウインドウでは、内蔵ブラウザ専用の情報が欠けることを指摘に明記する
    const gap = captureTargetGap(options.captureTarget)
    if (gap) this.warnings.push(gap)
    // 親を開いて持ったまま1段ずつ作る（security-5 [11]。sessions/containment.ts）
    await mkdirContained(options.paths.framesDir)
    await mkdirContained(options.paths.audioDir)

    const clock = new RecordingClock()
    this.clock = clock
    this.startedAt = new Date(clock.startedAtEpoch).toISOString()
    this.state = 'recording'

    this.recorder = new RecorderWindow(this.assets.recorderHtml, this.assets.recorderPreload, {
      onPcm: (block) => this.onPcm(block),
      onLevel: (level) => this.onLevel(level),
      onError: (message) => this.warn(message)
    })
    try {
      await this.recorder.open()
      await this.recorder.start(video, options, clock.startedAtEpoch)
      if (video.kind === 'tab' && this.overlay) this.recorder.setOverlay(this.overlay)
    } catch (err) {
      this.recorder.dispose()
      this.recorder = null
      this.clock = null
      this.state = 'idle'
      this.emitStatus()
      throw err
    }

    const recorder = this.recorder
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 静止画の撮る元の getter から、いま映しているトラックを引く
    const controller = this
    this.tracks = [{ id: 'main', target: options.captureTarget, label: trackLabel(options.captureTarget), video, recorder,
      videoRel: basename(options.paths.videoPath), startMs: 0, live: true }]
    if (video.kind === 'desktop') await this.openMirror(mirrorSourceParam([video.sourceId, ...(video.extraSourceIds ?? [])]))
    // 静止画は、そのとき画面に映しているトラックから撮る（切り替えると撮る元も変わる）
    const stillSource: StillSource = {
      capture: () => this.activeStillSource().capture(),
      get gone() { return controller.activeStillSource().gone }
    }
    this.stills = new StillCapturer(stillSource, clock, options, {
      // カーソルの座標は内蔵ブラウザの中のものなので、画面・ウインドウの画像には重ねない
      getCursor: () => (this.activeTrack?.video.kind === 'tab' && !this.activeTrack.popup ? this.lastCursor : undefined),
      onFrame: (frame) => {
        this.eventWrites = this.eventWrites.then(() => appendFileNoFollow(join(dirname(options.paths.eventsPath), 'frames.jsonl'), JSON.stringify(frame) + '\n')).catch((err) => { reportHandled(err, { area: 'recording', op: 'save frame times' }); this.warn(t('recording.errors.frameTimesSaveFailed', { error: String(err) })) })
        this.handlers.onFrame?.(frame)
      },
      onWarning: (message) => this.warn(message)
    })
    this.stills.start()

    // 最初に映しているもの（main）を記録する。切り替えたら足していく（指摘がどれの話かを引く）
    const main = this.tracks[0]!
    this.pushTrackEvent(main)
    this.appendTrackLine({ op: 'open', id: main.id, t: 0, kind: main.target.kind, label: main.label, video: main.videoRel })
    this.pushMode()
    if (source) {
      this.pageUrl = source.getURL()
      this.recordNav(this.pageUrl)
    }
    this.startWatch(options.watch ?? [])
    // 録画の前から開いていたログインのポップアップも録る（前に出ているならそちらへ切り替える）
    for (const contents of this.popupWindows.keys()) {
      if (contents.isDestroyed()) continue
      void this.serialTracks(() => this.addPopupTrackNow(contents, contents.isFocused())).catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'add popup track' }))
    }
    this.emitTracks()

    this.limitWarningTimer = setTimeout(() => this.warn(t('recording.limitSoon')), Math.max(0, options.maxDurationMs - Math.min(300000, options.maxDurationMs / 10)))
    this.limitWarningTimer.unref?.()
    // REC-6 上限時間
    this.maxDurationTimer = setTimeout(() => {
      this.warn(t('recording.limitReached', { limit: formatLimit(options.maxDurationMs) }))
      void (this.handlers.onLimit?.() ?? this.stop()).catch((err) => { reportHandled(err, { area: 'recording', op: 'stop at time limit' }); this.warn(t('recording.errors.stopFailed', { error: String(err) })) })
    }, options.maxDurationMs)
    this.maxDurationTimer.unref?.()
    this.statusTimer = setInterval(() => this.emitStatus(), 250)
    this.statusTimer.unref?.()

    this.emitStatus()
  }

  /**
   * 録っている画面・ウインドウを内蔵ブラウザの場所に映す。映せなくても録画は続ける（書き込みが引けないだけ）。
   * 内蔵ブラウザの書き込みは止めておく（録っている映像とは別の画面なので）
   */
  private async openMirror(sourceId: string): Promise<void> {
    if (!this.mirror) return
    const browser = this.source && !this.source.isDestroyed() ? this.source : null
    browser?.send(REVIEW_CHANNELS.command, { type: 'disable' })
    this.mirrorContents = await this.mirror.show(sourceId).catch((err: unknown) => {
      reportHandled(err, { area: 'recording', op: 'show capture mirror' })
      return null
    })
    if (this.mirrorContents) this.watchFocusBack(this.mirrorContents)
  }

  private closeMirror(): void {
    // 録画中に内蔵ブラウザへ切り替えていた（映していない）ときも、録画の前の表示へ戻すよう知らせる
    if (!this.mirrorContents && !this.mirrorSwitched) return
    this.mirrorContents = null
    this.mirrorSwitched = false
    this.mirror?.hide()
    // 内蔵ブラウザの注入側へ、いまの状態（録画していないので無効）を送り直す
    this.pushMode()
  }

  /**
   * 映像の取り込み元を決める。画面・ウインドウは、許可と対象の存在をここで確かめる
   * （録画を始めてから映像が空と分かるより、始める前に理由を伝えたほうが直しやすい）。
   */
  private async resolveVideo(options: RecordingOptions, source: WebContents | null): Promise<VideoSource> {
    if (options.captureTarget.kind === 'browser') {
      if (!source) throw new UserFacingError(t('recording.errors.noBrowser'))
      return { kind: 'tab', contents: source }
    }
    const resolved = await this.checkTarget(options.captureTarget)
    options.captureTarget = resolved
    return desktopVideo(resolved)
  }

  /**
   * 画面・ウインドウを録れるか確かめ、いまの ID に直した対象を返す。録れなければ理由を投げる。
   * セッションのフォルダを作る前にも呼ぶ（空のレビューを残さないため）。
   */
  async checkTarget(target: CaptureTarget): Promise<CaptureTarget> {
    if (target.kind === 'browser') return target
    const access = screenAccess()
    if (access === 'denied' || access === 'restricted') throw new Error(screenAccessMessage())
    const sources = await listCaptureSources({ width: 0, height: 0 }).catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'list capture sources' }); return [] })
    const resolved = resolveCaptureTarget(target, sources)
    if (!resolved) {
      throw new UserFacingError(t('recording.errors.targetGone', { target: captureTargetLabel(target) }))
    }
    // 複数選んだうち、見つからないものがあれば始めない（選んだものの一部だけを黙って録らない）
    const missing = targetParts(target).length > targetSourceIds(resolved).length
      ? targetParts(target).find((part) => !resolveCaptureTarget(part, sources)) ?? targetParts(target).at(-1) : undefined
    if (missing) throw new UserFacingError(t('recording.errors.targetGone', { target: captureTargetLabel(missing) }))
    if (resolved.kind !== 'window') return resolved
    // スマホのシミュレータ／エミュレータなら、端末名・OS の版・前面のアプリを指摘に添える（読むだけの命令。取れなくても録る）
    if (target.kind === 'window' && target.device && target.sourceId === resolved.sourceId) return { ...resolved, device: target.device }
    const platform = sources.find((s) => s.id === resolved.sourceId)?.device
    if (!platform) return resolved
    const device = await readDevice(platform, resolved.name).catch((err: unknown) => {
      reportHandled(err, { area: 'recording', op: 'read device' })
      return { platform }
    })
    return { ...resolved, device }
  }

  /** 内蔵ブラウザを映しているか。画面・ウインドウのときは内蔵ブラウザの操作ログを取らない */
  private get recordsBrowser(): boolean {
    return (this.activeTrack?.target.kind ?? this.options?.captureTarget.kind ?? 'browser') === 'browser'
  }

  // ───────────────────────── 複数の映像（トラック） ─────────────────────────

  private get activeTrack(): Track | undefined {
    return this.tracks.find((track) => track.id === this.activeTrackId)
  }

  /** いま映しているトラックの静止画の撮り方 */
  private activeStillSource(): StillSource {
    const track = this.activeTrack
    if (!track) return { capture: async () => null, gone: true }
    // ログインのポップアップはその窓をそのまま撮る（書き込みも写る）
    if (track.popup) return webContentsStillSource(track.popup)
    // 拡張機能のポップアップが開いていれば、ビューの静止画に同じ位置で重ねる（ポップアップの中の書き込みも一緒に写る）
    if (track.video.kind === 'tab') return overlayStillSource(webContentsStillSource(track.video.contents), () => this.overlay)
    const recorder = track.recorder
    return mirrorStillSource(() => this.mirrorContents, { capture: () => recorder.grabFrame(), get gone() { return recorder.gone } })
  }

  /** トラックの操作を1つずつ行う（待ち受けと利用者の切り替えが重なっても、順に揃う） */
  private serialTracks<T>(task: () => Promise<T>): Promise<T> {
    const next = this.trackQueue.then(task)
    this.trackQueue = next.catch(() => undefined)
    return next
  }

  private get capturing(): boolean {
    return this.state === 'recording' || this.state === 'paused'
  }

  /** 画面へ出すトラックの状態 */
  get tracksState(): CaptureTracksState {
    const live = this.tracks.filter((track) => track.live)
    return {
      tracks: live.map((track) => ({ id: track.id, kind: track.target.kind, label: track.label, live: true, active: track.id === this.activeTrackId,
        ...(track.watchId ? { watchId: track.watchId } : {}) })),
      waiting: this.capturing ? waitingWindows(this.watched, this.tracks) : [],
      ...(this.watchProblem ? { watchUnavailable: this.watchProblem } : {})
    }
  }

  private emitTracks(): void {
    this.handlers.onTracks?.(this.tracksState)
  }

  /**
   * 録画中に映像を足す（別のウインドウ・画面・内蔵ブラウザ）。足した映像は tracks/<id>.webm へ録画の終わりまで録る。
   * activate なら画面もそちらへ切り替える。同じものを録っていれば足さずにそれを使う。
   * @param fresh 待ち受けがいま見つけたウインドウ（一覧を取り直さない）
   * @returns トラックの id
   */
  addTrack(target: CaptureTarget, opts: { watch?: WatchedWindow; activate?: boolean; fresh?: boolean } = {}): Promise<string> {
    return this.serialTracks(() => this.addTrackNow(target, opts))
  }

  private async addTrackNow(target: CaptureTarget, opts: { watch?: WatchedWindow; activate?: boolean; fresh?: boolean }): Promise<string> {
    const options = this.options
    const clock = this.clock
    if (!this.capturing || !options || !clock) throw new UserFacingError(t('recording.errors.notRecording'))
    const live = this.tracks.filter((track) => track.live)
    let video: VideoSource
    let resolved = target
    if (target.kind === 'browser') {
      // 内蔵ブラウザでいま前に出ているタブを録っていればそれ、無ければほかのタブの映像
      const tab = this.browserTab && !this.browserTab.isDestroyed() ? this.browserTab : this.source
      const tabs = live.filter((track) => track.video.kind === 'tab' && !track.popup)
      const same = tabs.find((track) => track.video.kind === 'tab' && track.video.contents === tab) ?? tabs[0]
      if (same) { if (opts.activate) await this.switchTrackNow(same.id); return same.id }
      const wc = tab
      if (!wc || wc.isDestroyed()) throw new UserFacingError(t('recording.errors.noBrowser'))
      video = { kind: 'tab', contents: wc }
    } else {
      if (!opts.fresh) resolved = await this.checkTarget(target)
      const sourceId = resolved.kind === 'browser' ? '' : resolved.sourceId
      const same = live.find((track) => track.video.kind === 'desktop' && track.video.sourceId === sourceId && !track.video.extraSourceIds?.length)
      if (same) { if (opts.activate) await this.switchTrackNow(same.id); return same.id }
      video = desktopVideo(resolved)
    }
    if (live.length >= MAX_CAPTURE_TRACKS) throw new UserFacingError(t('recording.tracks.limit', { n: MAX_CAPTURE_TRACKS }))
    return this.startTrack(video, resolved, trackLabel(resolved, opts.watch?.label), opts)
  }

  /**
   * ログインのポップアップの映像を足す（同じ窓を録っていれば足さない）。activate なら映すものもそちらへ切り替える。
   * 録っている数が上限なら足さずに知らせる（ポップアップの書き込みは引けない）
   */
  private async addPopupTrackNow(contents: WebContents, activate: boolean): Promise<string | null> {
    if (!this.capturing || contents.isDestroyed() || !this.popupWindows.has(contents)) return null
    const live = this.tracks.filter((track) => track.live)
    const same = live.find((track) => track.popup === contents)
    if (same) {
      if (activate) await this.switchTrackNow(same.id)
      return same.id
    }
    if (live.length >= MAX_CAPTURE_TRACKS) {
      this.warn(t('recording.tracks.limit', { n: MAX_CAPTURE_TRACKS }))
      return null
    }
    const host = popupHost(this.popupWindows.get(contents) ?? '') || popupHost(contents.getURL())
    const label = t('recording.tracks.popupLabel', { host: host || '-' })
    const target: CaptureTarget = { kind: 'window', sourceId: '', name: label }
    return this.startTrack({ kind: 'tab', contents }, target, label, { activate }, contents)
  }

  /** 録画ウインドウを1つ開いてトラックを録り始め、一覧に足す */
  private async startTrack(video: VideoSource, resolved: CaptureTarget, label: string, opts: { watch?: WatchedWindow; activate?: boolean }, popup?: WebContents): Promise<string> {
    const options = this.options
    const clock = this.clock
    if (!this.capturing || !options || !clock) throw new UserFacingError(t('recording.errors.notRecording'))
    const id = nextTrackId(this.tracks.map((track) => track.id))
    const dir = join(dirname(options.paths.videoPath), 'tracks')
    await mkdirContained(dir)
    const recorder = new RecorderWindow(this.assets.recorderHtml, this.assets.recorderPreload, {
      onPcm: () => undefined,
      onLevel: () => undefined,
      onError: (message) => this.onTrackError(id, message)
    }, true)
    // 見ていない間も録り続けるが、見返し用なのでフレームレートとビットレートは控えめにする
    const trackOptions: RecordingOptions = { ...options, paths: { ...options.paths, videoPath: join(dir, `${id}.webm`) }, captureMic: false, captureSystemAudio: false,
      videoMaxFrameRate: Math.min(options.videoMaxFrameRate, EXTRA_TRACK_MAX_FPS), videoBitsPerSecond: Math.min(options.videoBitsPerSecond, EXTRA_TRACK_BITS_PER_SECOND) }
    try {
      await recorder.open()
      await recorder.start(video, trackOptions, clock.startedAtEpoch)
    } catch (err) {
      recorder.dispose()
      throw err
    }
    // 始めている間に止めた
    if (!this.capturing) {
      await recorder.stop()
      recorder.dispose()
      throw new UserFacingError(t('recording.errors.notRecording'))
    }
    if (this.state === 'paused') recorder.pause()
    const track: Track = { id, target: resolved, label, video, recorder, videoRel: `tracks/${id}.webm`,
      startMs: clock.now(), live: true, ...(opts.watch ? { watchId: opts.watch.id } : {}), ...(popup ? { popup } : {}) }
    this.tracks.push(track)
    this.appendTrackLine({ op: 'open', id, t: track.startMs, kind: resolved.kind, label: track.label, video: track.videoRel, ...(track.watchId ? { watchId: track.watchId } : {}) })
    if (video.kind === 'desktop') this.ensureWatchTimer()
    this.emitTracks()
    if (opts.activate) await this.switchTrackNow(id)
    return id
  }

  /** 画面に映して書き込むトラックを切り替える。録画はどのトラックも続ける */
  switchTrack(id: string): Promise<void> {
    return this.serialTracks(() => this.switchTrackNow(id))
  }

  private async switchTrackNow(id: string): Promise<void> {
    const track = this.tracks.find((candidate) => candidate.id === id && candidate.live)
    if (!track || id === this.activeTrackId || !this.capturing) return
    // 書きかけを確定させ、その静止画を撮り終えてから切り替える（前に映していたものの指摘として残す）
    const before = this.surfaces
    this.sendAll({ type: 'commit' })
    await delay(80)
    await this.stills?.settle()
    this.sendAll({ type: 'clear', page: true })
    // ログインのポップアップへ切り替えるときは、戻る先（いま映しているもの）を覚えておく
    if (track.popup && !this.activeTrack?.popup) this.popupReturnTrackId = this.activeTrackId
    this.activeTrackId = id
    if (track.popup) {
      // ポップアップの窓そのものに書き込む。内蔵ブラウザの場所に映しているものはそのまま
    } else if (track.video.kind === 'desktop') {
      this.mirrorSwitched = true
      await this.openMirror(mirrorSourceParam([track.video.sourceId, ...(track.video.extraSourceIds ?? [])]))
    } else {
      // 内蔵ブラウザへ戻す。映していたビューは閉じる
      this.mirrorSwitched = true
      this.mirrorContents = null
      this.mirror?.showBrowser?.()
      // 内蔵ブラウザのタブの映像。書き込み・操作ログもそのタブで受け、内蔵ブラウザもそのタブを前に出す
      const wc = track.video.kind === 'tab' ? track.video.contents : null
      if (wc && !wc.isDestroyed()) {
        this.source = wc
        if (wc !== this.browserTab) this.handlers.onBrowserTab?.(wc)
      }
    }
    this.lastSurface = null
    // 前に書き込みを受けていた面（隠れた・後ろに回った）は書き込みを止める
    const now = this.surfaces
    for (const wc of before) if (!now.includes(wc) && !wc.isDestroyed()) wc.send(REVIEW_CHANNELS.command, { type: 'disable' })
    this.pushTrackEvent(track)
    this.pushMode()
    if (track.video.kind === 'tab' && !track.popup) {
      const wc = this.source
      if (wc && !wc.isDestroyed()) {
        this.pageUrl = wc.getURL()
        // 遷移として記録し、その画面を1枚撮る（ウインドウを映していた間の遷移は記録していない）
        this.recordNav(this.pageUrl)
      }
    } else {
      // 映したビューが映像を出すまで少し待って1枚撮る
      setTimeout(() => void this.stills?.captureNow('track'), 600).unref?.()
    }
    this.emitTracks()
  }

  /** 足したトラックを閉じる（ウインドウが閉じた）。main は音声も録っているので閉じない */
  closeTrack(id: string): Promise<void> {
    return this.serialTracks(() => this.closeTrackNow(id))
  }

  private async closeTrackNow(id: string): Promise<void> {
    const track = this.tracks.find((candidate) => candidate.id === id && candidate.live)
    if (!track || id === 'main') return
    track.live = false
    track.endMs = this.clock?.now() ?? 0
    if (this.activeTrackId === id) {
      // 映していたものが消えたら、ログインのポップアップなら前に映していたもの、ほかは main へ戻す
      const back = track.popup ? popupReturnTrack(this.popupReturnTrackId, this.tracks.filter((c) => c.live && !c.popup).map((c) => c.id)) : 'main'
      const next = this.tracks.find((candidate) => candidate.id === back && candidate.live) ?? this.tracks[0]
      if (next?.live) await this.switchTrackNow(next.id)
    }
    await track.recorder.stop().catch((err: unknown) => reportHandled(err, { area: 'recording', op: 'stop track' }))
    track.recorder.dispose()
    this.appendTrackLine({ op: 'close', id, t: track.endMs })
    this.emitTracks()
  }

  /** 足したトラックの録画ウインドウからの知らせ。ウインドウが閉じたならトラックを閉じる（警告にしない） */
  private onTrackError(id: string, message: string): void {
    if (message === t('recorder.videoEnded')) return void this.closeTrack(id)
    const track = this.tracks.find((candidate) => candidate.id === id)
    this.warn(t('recording.tracks.trackProblem', { label: track?.label ?? id, message }))
  }

  /** 映しているものの切り替えを操作ログに残す */
  private pushTrackEvent(track: Track): void {
    if (!this.clock) return
    this.push({ t: this.clock.now(), type: 'track', track: track.id, kind: track.target.kind, label: track.label, video: track.videoRel })
  }

  /** tracks.jsonl（録った映像の始まりと終わり）。追記のみ */
  private appendTrackLine(line: Record<string, unknown>): void {
    const eventsPath = this.options?.paths.eventsPath
    if (!eventsPath) return
    this.eventWrites = this.eventWrites.then(() => appendFileNoFollow(join(dirname(eventsPath), 'tracks.jsonl'), JSON.stringify(line) + '\n'))
      .catch((err) => { reportHandled(err, { area: 'recording', op: 'save tracks' }); this.warn(t('recording.errors.eventsSaveFailed', { error: String(err) })) })
  }

  /** 待ち受けを始める。Wayland・画面収録の許可が無いときは待たない（知らせるだけ） */
  private startWatch(watched: WatchedWindow[]): void {
    this.watched = watched
    if (watched.length === 0) return
    const problem = watchUnavailable(process.platform, process.env, screenAccess())
    if (problem) {
      this.watchProblem = problem
      this.warn(t(problem === 'wayland' ? 'recording.tracks.watchWayland' : 'recording.tracks.watchPermission', { names: watched.map((w) => w.label).join(', ') }))
      return
    }
    this.ensureWatchTimer()
  }

  /** ウインドウの一覧を定期的に見る（待ち受けがあるか、足したウインドウを録っている間） */
  private ensureWatchTimer(): void {
    if (this.watchTimer || this.watchProblem || !this.capturing) return
    if (watchUnavailable(process.platform, process.env, screenAccess())) return
    this.watchTimer = setInterval(() => void this.pollWatch(), WATCH_POLL_MS)
    this.watchTimer.unref?.()
    void this.pollWatch()
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  /** 待ち受けのウインドウが現れたら録り、録っているウインドウが消えたら閉じる */
  private async pollWatch(): Promise<void> {
    if (this.watchBusy || !this.capturing) return
    this.watchBusy = true
    try {
      const sources = await listCaptureSources({ width: 0, height: 0 })
      if (!this.capturing) return
      const actions = planWatch({
        watched: this.watched,
        tracks: this.tracks.map((track) => ({ id: track.id, live: track.live, closable: track.id !== 'main',
          ...(track.video.kind === 'desktop' ? { sourceId: track.video.sourceId } : {}), ...(track.watchId ? { watchId: track.watchId } : {}) })),
        sources
      })
      for (const action of actions) {
        if (!this.capturing) return
        if (action.type === 'close') { await this.closeTrack(action.trackId); continue }
        await this.addTrack(targetFromSource(action.source), { watch: action.watch, activate: action.watch.mode === 'switch', fresh: true })
          .then(() => { this.watchFailed.delete(action.watch.id) })
          .catch((err: unknown) => {
            if (this.watchFailed.has(action.watch.id)) return
            this.watchFailed.add(action.watch.id)
            if (!(err instanceof UserFacingError)) reportHandled(err, { area: 'recording', op: 'add watched window' })
            this.warn(t('recording.tracks.watchFailed', { label: action.watch.label, error: err instanceof Error ? err.message : String(err) }))
          })
      }
    } catch (err) {
      reportHandled(err, { area: 'recording', op: 'poll watched windows' })
    } finally {
      this.watchBusy = false
    }
  }


  pause(): void {
    if (this.state !== 'recording') return
    this.state = 'paused'
    this.clock?.pause()
    this.recorder?.pause()
    for (const track of this.tracks) if (track.live && track.id !== 'main') track.recorder.pause()
    this.stills?.pause()
    this.pushMode()
    this.emitStatus()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'recording'
    this.clock?.resume()
    this.recorder?.resume()
    for (const track of this.tracks) if (track.live && track.id !== 'main') track.recorder.resume()
    this.stills?.resume()
    this.pushMode()
    this.emitStatus()
  }

  /** 進んでいる停止（2回押されても、後片付けを二重に走らせず同じ結果を返す） */
  private stopping: Promise<RecordingResult> | null = null

  /**
   * 録画を止める。**必ず終わり、必ず idle へ戻る**。
   * どこかの段が返ってこない・投げても、上限（STOP_STEP_TIMEOUT_MS など）であきらめて次へ進み、
   * それまでの動画・静止画・操作ログ・音声で結果を返す（停止中のまま残ると、話した内容がレビューにならない）
   */
  stop(): Promise<RecordingResult> {
    if (this.stopping) return this.stopping
    if (this.state === 'idle') return Promise.reject(new UserFacingError(t('recording.errors.notRecording')))
    const run = this.stopNow().finally(() => { this.stopping = null })
    this.stopping = run
    return run
  }

  /** 停止の1段。上限を過ぎた・投げた段は知らせて次へ進む */
  private async stopStep<T>(step: string, run: () => Promise<T> | T, timeoutMs: number): Promise<T | undefined> {
    const result = await boundedStep(run, timeoutMs)
    if (result.ok) return result.value
    const error = result.reason === 'error' ? result.error : new Error(`recording stop step timed out: ${step} (${timeoutMs}ms)`)
    reportHandled(error, { area: 'recording', op: `stop: ${step}` })
    this.warn(t('recording.errors.stopStepFailed', { step, reason: result.reason === 'timeout' ? `timeout ${timeoutMs}ms` : String(result.error) }))
    return undefined
  }

  /** 同期の後片付け。投げても次へ進む（idle へ戻すのを止めない） */
  private stopSync(step: string, run: () => void): void {
    safeStep(run, (error) => reportHandled(error, { area: 'recording', op: `stop: ${step}` }))
  }

  private async stopNow(): Promise<RecordingResult> {
    this.state = 'stopping'
    if (this.limitWarningTimer) clearTimeout(this.limitWarningTimer)
    this.limitWarningTimer = null
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    this.maxDurationTimer = null
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = null
    this.pendingLeave = null
    this.stopSync('stop watch', () => this.stopWatch())
    this.stopSync('status', () => this.emitStatus())

    // 長さは「止める直前」の時計を使う。停止処理にかかる時間を含めると、
    // 動画の長さと数百msずれる
    const clock = this.clock
    const durationMs = clock?.now() ?? 0
    const options = this.options
    const recorder = this.recorder
    const stills = this.stills
    const extras = this.tracks.filter((track) => track.live && track.id !== 'main')

    try {
      console.log('[STEP] stills.stop')
      await this.stopStep('stills', () => stills?.stop(), STOP_STEP_TIMEOUT_MS)
      // 追加・切り替えの途中なら終わるのを待つ（録画ウインドウを残さない）
      await this.stopStep('track queue', () => this.trackQueue, STOP_STEP_TIMEOUT_MS)
      console.log('[STEP] recorder.stop 開始')
      // 録画ウインドウは最後の塊を書き終えるまで待つ（RecorderWindow.stop 自身にも上限がある）。返ってこなくても先へ進む
      await Promise.all([
        this.stopStep('recorder', () => recorder?.stop(), RECORDER_STOP_TIMEOUT_MS),
        ...extras.map((track) => this.stopStep(`track ${track.id}`, () => track.recorder.stop(), RECORDER_STOP_TIMEOUT_MS))
      ])
      console.log('[STEP] recorder.stop 完了')
      // 書き込みの待ち行列は MAX_PENDING_EVENT_WRITES 件までだが、ディスクが詰まっても停止を待たせ続けない
      await boundedStep(() => this.eventWrites, EVENT_WRITES_STOP_TIMEOUT_MS)
    } finally {
      // ここから先は投げても止まらない。必ず idle へ戻す
      for (const track of extras) {
        track.live = false
        track.endMs = durationMs
        this.stopSync('dispose track', () => track.recorder.dispose())
        this.stopSync('track line', () => this.appendTrackLine({ op: 'close', id: track.id, t: durationMs }))
      }
      const frames = stills?.captured ?? []
      this.lastStatus = { state: 'idle', elapsedMs: durationMs, videoBytes: recorder?.videoBytes ?? 0,
        frameCount: frames.length, eventCount: this.events.length }
      this.stopSync('disable surfaces', () => this.sendAll({ type: 'disable' }))
      this.stopSync('dispose recorder', () => recorder?.dispose())
      this.recorder = null
      this.stills = null
      this.clock = null
      this.state = 'idle'
      // 録画のあいだに映すものを切り替えていても、内蔵ブラウザでいま前に出ているタブへ戻す
      this.pendingTab = null
      this.stopSync('restore tab', () => {
        if (this.browserTab && !this.browserTab.isDestroyed()) {
          this.source = this.browserTab
          this.pageUrl = this.browserTab.getURL()
        }
      })
      this.stopSync('close mirror', () => this.closeMirror())
    }

    const videoBytes = this.lastStatus.videoBytes
    const frames = stills?.captured ?? []
    const tracks: TrackRecordInfo[] = this.tracks.map((track) => ({ id: track.id, kind: track.target.kind, label: track.label, video: track.videoRel,
      startMs: track.startMs, endMs: track.endMs ?? durationMs, ...(track.watchId ? { watchId: track.watchId } : {}) }))
    this.tracks = []
    this.activeTrackId = 'main'
    this.popupReturnTrackId = null
    this.lastSurface = null
    this.watched = []
    this.watchProblem = undefined
    this.stopSync('status', () => this.emitStatus())
    this.stopSync('tracks', () => this.emitTracks())

    return {
      startedAt: this.startedAt,
      durationMs,
      videoPath: options?.paths.videoPath ?? '',
      videoBytes,
      frames,
      events: [...this.events],
      audioSamples: { ...this.samples },
      warnings: [...this.warnings],
      tracks
    }
  }

  dispose(): void {
    if (this.limitWarningTimer) clearTimeout(this.limitWarningTimer)
    this.limitWarningTimer = null
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.stopWatch()
    for (const track of this.tracks) if (track.id !== 'main') track.recorder.dispose()
    this.tracks = []
    this.recorder?.dispose()
    this.recorder = null
    this.stills?.stop()
    this.closeMirror()
  }

  // ───────────────────────── 受け口 ─────────────────────────

  private onPcm(block: PcmBlock): void {
    this.samples[block.source] += block.samples.length
    this.handlers.onPcm?.(block)
  }

  private onLevel(level: AudioLevel): void {
    this.handlers.onLevel?.(level)
  }

  private warn(message: string): void {
    console.warn('[recording]', message)
    this.warnings.push(message)
    this.handlers.onWarning?.(message)
  }

  private emitStatus(): void {
    this.handlers.onStatus?.(this.status)
  }

  /** 操作ログを1件足す。追記のみでファイルへも書く */
  private push(event: Event): void {
    const path = this.options?.paths.eventsPath
    if (path && this.pendingEventWrites >= MAX_PENDING_EVENT_WRITES) return void this.warnLimit('total')
    this.events.push(event)
    this.handlers.onEvent?.(event)
    if (!path) return
    this.pendingEventWrites++
    // 末端がリンク・ハードリンクなら書かない（events.jsonl はプロジェクトのフォルダの中にある）
    this.eventWrites = this.eventWrites.then(() => appendFileNoFollow(path, toJsonLine(event)))
      .catch((err) => { reportHandled(err, { area: 'recording', op: 'save events' }); this.warn(t('recording.errors.eventsSaveFailed', { error: String(err) })) })
      .finally(() => { this.pendingEventWrites-- })
  }

  /** 注入スクリプトから届いた入力を、頻度と総量の上限の内で受け付けるか。超えたら捨てて1度だけ知らせる */
  private admit(kind: ReviewInputKind): boolean {
    const admission = this.budget.admit(kind)
    if (admission === 'ok') return true
    // 記録しない入力（カーソル位置・キー・戻せるかの知らせ）は、黙って間引く
    if (kind !== 'pointer' && kind !== 'shortcut' && kind !== 'history') this.warnLimit(admission)
    return false
  }

  private warnLimit(admission: Admission): void {
    if (this.limitWarned.has(admission)) return
    this.limitWarned.add(admission)
    this.warn(t(admission === 'total' ? 'recording.errors.eventsLimitReached' : 'recording.errors.eventsThrottled'))
  }

  private recordNav(url: string): void {
    if (this.state !== 'recording' || !this.clock || !url || url === 'about:blank') return
    // 画面・ウインドウを録っているときの内蔵ブラウザのURLは、録っている画面のURLとは限らない
    if (!this.recordsBrowser) return
    // ページのスクリプトが pushState やハッシュの変更を繰り返しても、操作ログと撮影を積み続けない
    if (!this.admit('nav')) return
    const wc = this.reviewContents
    this.push({
      t: this.clock.now(),
      type: 'nav',
      url: redactUrl(url),
      title: wc?.getTitle() ?? ''
    })
    // 遷移直後の画面は指摘の文脈になるので1枚撮る
    void this.stills?.captureNow('nav')
  }

  /** 表示幅の切替（WS-3）。browser.ts の setViewport から呼ぶ */
  recordViewport(width: number, t?: number): void {
    if (this.state !== 'recording' || !this.clock || !this.recordsBrowser) return
    this.lastViewWidth = width
    this.push({ t: t ?? this.clock.now(), type: 'viewport', width })
  }

  private recordInjected(raw: RawReviewEvent): void {
    const clock = this.clock
    if (this.state !== 'recording' || !clock || typeof raw !== 'object' || raw === null) return

    if (raw.type === 'pointer' && !this.admit('pointer')) return
    const view = sanitizeView(raw.view)
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y) && view) this.lastCursor = { x: raw.x!, y: raw.y!, view }
    if (raw.type === 'pointer') return
    let event = toLogEvent(raw, (epochMs) => clock.fromEpoch(epochMs))
    // 遷移・表示幅・映すものの切り替えは main が記録する。注入側からは受けない
    if (!event || event.type === 'nav' || event.type === 'viewport' || event.type === 'track') return
    if (!this.admit(event.type)) return
    if (event.type === 'pen' || event.type === 'erase') this.lastSurface = this.reviewContents
    if (!this.recordsBrowser) {
      // 画面・ウインドウを録っているときは、書き込み（指摘そのもの）だけ残す。
      // 要素情報は内蔵ブラウザの中のもので、録っている画面と食い違いうるので外す
      if (event.type === 'erase') return void this.push(event)
      if (event.type !== 'pen') return
      const { el: _el, ...rest } = event
      event = rest
      this.push(event)
      void this.stills?.captureNow(event.type, undefined, event.id)
      return
    }
    if (view) this.lastBrowserView = view
    if (view && this.lastViewWidth !== view.width) this.recordViewport(view.width, event.t)
    this.push(event)

    if (!shouldCaptureStill(event)) return
    // ペンの確定時とクリック時は、間隔を待たずにその場で撮る（設計4章）
    const cursor = event.type === 'click' ? { x: event.x, y: event.y, view } : undefined
    void this.stills?.captureNow(event.type, cursor, event.type === 'pen' ? event.id : undefined)
  }

  /**
   * 内蔵ブラウザの上の拡張機能のポップアップから届いた書き込み。書き込み（pen・erase）だけを、内蔵ブラウザのビューの座標へ直して残す。
   * クリック・スクロール・カーソルはポップアップの中のもので、ページの操作ログとは食い違うので受けない。
   * 要素情報（拡張機能の画面の中身）は外す。静止画は内蔵ブラウザの画像にポップアップを重ねたもの（書き込みも写る）
   */
  private recordOverlayInjected(sender: WebContents, raw: RawReviewEvent): void {
    const clock = this.clock
    const overlay = this.overlay
    if (this.state !== 'recording' || !clock || !overlay || typeof raw !== 'object' || raw === null) return
    if (raw.type !== 'pen' && raw.type !== 'erase') return
    let input: RawReviewEvent = { ...raw, el: undefined }
    if (raw.type === 'pen') {
      const mapped = mapPopupBox(raw.bbox, sanitizeView(raw.view), overlay.rect, this.lastBrowserView)
      if (!mapped) return
      input = { ...input, bbox: mapped.bbox, view: mapped.view }
    }
    const event = toLogEvent(input, (epochMs) => clock.fromEpoch(epochMs))
    if (!event || (event.type !== 'pen' && event.type !== 'erase') || !this.admit(event.type)) return
    this.lastSurface = sender
    this.push(event)
    if (event.type === 'pen') void this.stills?.captureNow('pen', undefined, event.id)
  }

}

/** 注入スクリプトが添えるビューの大きさ。数でない・極端な値は使わない */
function sanitizeView(view: unknown): { width: number; height: number } | undefined {
  const value = view as { width?: unknown; height?: unknown } | null | undefined
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100_000
  return value && ok(value.width) && ok(value.height) ? { width: Math.round(value.width), height: Math.round(value.height) } : undefined
}

/** 上限時間の表示。1分未満（検証用の短縮時）でも「0分」と出さない */
function formatLimit(ms: number): string {
  return ms >= 60_000 ? t('recording.minutes', { n: Math.round(ms / 60_000) }) : t('recording.seconds', { n: Math.max(1, Math.round(ms / 1000)) })
}
