/**
 * 画面・音声・クリップボードなど、利用者の情報に触れる操作の「同意」を main が持つ（security-5 [1][9]）。
 *
 * - IPC を受けてよいのは、アプリの窓の本体のフレーム（アプリのページ）だけ（isTrustedIpcSender）
 * - 同意は main が OS から受けた本物の入力（クリック・キー）とメニューの操作からだけ作る（UserGestures）。
 *   renderer が送る値や画面の状態は同意にしない。録画の開始・画面の撮影は1回の操作につき1回だけ使える
 * - 録る対象と音（マイク・PC の音声）は、利用者が操作で選んだもの（CaptureConsentState）を超えて録らない
 * - カメラは使わない。映像を求めてよいのは録画ウインドウ（画面・タブの取り込み）だけ
 *
 * Electron に依存させない（単体テストで偽の webContents・フレームを渡して確かめるため）。
 */
import type { CaptureTarget } from '@shared/types'

/** 本物の入力（OS から窓に届いたもの）のうち、利用者の操作とみなす種類 */
const GESTURE_INPUT_TYPES = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'gestureTap', 'touchStart'])

export function isGestureInput(type: string): boolean {
  return GESTURE_INPUT_TYPES.has(type)
}

/** 操作から何秒まで使えるか。録画の開始はプロジェクトの切り替えを待つことがあるので少し長い */
export const GESTURE_GRANT_MS = {
  /** 録画の開始（1回だけ） */
  record: 15_000,
  /** アプリの窓の撮影（1回だけ） */
  screenshot: 10_000,
  /** 画面・ウインドウの一覧（サムネイル）。選択画面を開いている間に何度か呼ぶ */
  sources: 30_000,
  /** 録る対象・音を選ぶ（利用者が切り替えた直後） */
  choice: 30_000,
  /** 端末の選択範囲のコピー（キーを押した直後） */
  copy: 5_000,
  /** 端末への貼り付け（Ctrl+V を押した直後に1回だけ。security-7 [1]） */
  paste: 5_000,
  /** フッターの「最新を取得」・push（押した直後に1回だけ。push は外へ出るので確認の Push を押したとき） */
  gitSync: 10_000,
  /** ビジネス・ビジネスリサーチの「Agent へ送る」の札を作る（押した直後に1回だけ。renderer はクリックの処理ですぐ呼ぶ） */
  send: 1_500
} as const

export type GestureAction = keyof typeof GESTURE_GRANT_MS
/** 1回の操作で1回しか使えないもの */
const ONE_USE: ReadonlySet<GestureAction> = new Set(['record', 'screenshot', 'gitSync', 'paste', 'send'])

/**
 * 利用者の操作から作る、短い間だけ有効な許可。
 * noteGesture は main だけが呼ぶ（窓の input-event とメニューのクリック）。renderer から呼べる道は作らない
 */
export class UserGestures {
  private at = Number.NEGATIVE_INFINITY
  private used = new Set<GestureAction>()

  constructor(private readonly now: () => number = Date.now) {}

  noteGesture(): void {
    this.at = this.now()
    this.used.clear()
  }

  /** 使える許可があれば使う。1回きりのものは、同じ操作でもう一度は使えない */
  consume(action: GestureAction): boolean {
    const age = this.now() - this.at
    if (!(age >= 0 && age <= GESTURE_GRANT_MS[action])) return false
    if (ONE_USE.has(action)) {
      if (this.used.has(action)) return false
      this.used.add(action)
    }
    return true
  }
}

/**
 * 内蔵ブラウザ・映したウインドウのビューに届いた本物の入力（クリック・キー）からの、そのビューだけの1回きりの許可。
 * 文字で指摘の静止画は、利用者がそのビューで指示を打って Enter を押した（・足すボタンを押した）直後に1枚だけ撮る。
 * 入力の記録は main が各ビューの input-event から付ける（ページのスクリプトや IPC からは付けられない）。
 * アプリの窓の許可（UserGestures）とは別に持つ（ページの中の操作で、アプリの窓の撮影・録画の許可を作らない）
 */
export class ViewInputGrant<View extends object> {
  private readonly last = new WeakMap<View, number>()

  constructor(private readonly windowMs = 5_000, private readonly now: () => number = Date.now) {}

  /** そのビューに本物の入力が届いた（main のビューの input-event からだけ呼ぶ） */
  sawInput(view: View): void {
    this.last.set(view, this.now())
  }

  /** そのビューの直前の入力の許可を使う。1回の入力で1回だけ */
  consume(view: View): boolean {
    const at = this.last.get(view)
    if (at === undefined) return false
    this.last.delete(view)
    const age = this.now() - at
    return age >= 0 && age <= this.windowMs
  }
}

/** IPC の送り主の最小の形（Electron の IpcMainInvokeEvent の一部） */
export interface IpcSenderLike {
  sender: unknown
  senderFrame: { url: string; processId: number; routingId: number } | null
}

/**
 * アプリの窓の本体のフレームから届いたか。サブフレーム（プレビューの iframe）・別の窓・内蔵ブラウザ・
 * アプリのページ以外へ移った窓からの呼び出しは受けない
 */
export function isTrustedIpcSender(
  event: IpcSenderLike,
  main: { contents: unknown; mainFrame: { processId: number; routingId: number } } | null,
  isAppUrl: (url: string) => boolean
): boolean {
  if (!main || event.sender !== main.contents) return false
  const frame = event.senderFrame
  if (!frame || frame.processId !== main.mainFrame.processId || frame.routingId !== main.mainFrame.routingId) return false
  return isAppUrl(frame.url)
}

/** 利用者が選んだ録る対象と音。録画はこれを超えない */
export interface CaptureConsentState {
  target: CaptureTarget
  mic: boolean
  systemAudio: boolean
}

export type CaptureRequestProblem = 'target' | 'mic' | 'systemAudio' | null

/** 録画の求め（renderer が送った対象・音）が、利用者の選んだ範囲に収まっているか */
export function captureRequestProblem(
  request: { target: CaptureTarget; mic: boolean; systemAudio: boolean },
  consent: CaptureConsentState
): CaptureRequestProblem {
  if (request.target.kind !== 'browser') {
    const chosen = consent.target
    if (chosen.kind !== request.target.kind || chosen.sourceId !== request.target.sourceId) return 'target'
    // 複数選んだときは、同時に録るほかの画面・ウインドウも選んだものと同じ並びでなければ録らない
    const also = (target: CaptureTarget) => (target.kind === 'browser' ? [] : (target.also ?? []).map((part) => `${part.kind}|${part.sourceId}`)).join('\n')
    if (also(chosen) !== also(request.target)) return 'target'
  }
  if (request.mic && !consent.mic) return 'mic'
  if (request.systemAudio && !consent.systemAudio) return 'systemAudio'
  return null
}

/**
 * 音の同意を更新する。操作の直後なら設定どおりに広げてよい。操作が無ければ狭めるだけ
 * （renderer だけで PC の音声・マイクを足さない）
 */
export function nextAudioConsent(
  current: Pick<CaptureConsentState, 'mic' | 'systemAudio'>,
  requested: { captureMic?: boolean; captureSystemAudio?: boolean },
  byGesture: boolean
): Pick<CaptureConsentState, 'mic' | 'systemAudio'> {
  const mic = requested.captureMic ?? current.mic
  const systemAudio = requested.captureSystemAudio ?? current.systemAudio
  if (byGesture) return { mic, systemAudio }
  return { mic: current.mic && mic, systemAudio: current.systemAudio && systemAudio }
}

/**
 * 既定のセッション（アプリの窓・録画ウインドウ）で、マイク・カメラ・画面の取り込み（media）を許してよいか。
 * アプリの窓は音だけ（マイクの音量表示）。映像（カメラ・画面・タブ）は録画ウインドウだけ。
 * 種類の分からない求めは断る（問い合わせ＝check は取り込みを始めないので、映像のものだけ断る）
 */
export function appMediaAllowed(query: { request: boolean; mediaTypes: string[]; details: { mediaType?: unknown; [key: string]: unknown } }, fromRecorder: boolean): boolean {
  if (fromRecorder) return true
  if (query.request) return query.mediaTypes.length > 0 && query.mediaTypes.every((type) => type === 'audio')
  return query.details.mediaType !== 'video'
}

/** 録画ウインドウの webContents。映像の取り込みを許すのはここだけ */
const recorderContents = new WeakSet<object>()

export function registerRecorderContents(contents: object): void {
  recorderContents.add(contents)
}

export function isRecorderContents(contents: unknown): boolean {
  return typeof contents === 'object' && contents !== null && recorderContents.has(contents)
}

/** 録画中の印（main が出す。renderer の表示に頼らない）。macOS は Dock のバッジ、どの OS も窓の題名の先頭 */
export const CAPTURE_INDICATOR = '●'

export function indicatorTitle(base: string, capturing: boolean): string {
  return capturing ? `${CAPTURE_INDICATOR} ${base}` : base
}
