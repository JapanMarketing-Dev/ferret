import { fakeCapturePath } from './recording/fakeCapture'
import { isGestureInput, registerRecorderContents } from './captureConsent'
import { BrowserIdentity, cleanElectronUserAgent, electronUserAgent } from './browserUserAgent'
import { SHARED_BROWSER_PARTITION } from '@shared/browserProfile'
import { WebContentsView, dialog, session, shell, type BaseWindow, type BrowserWindow, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import { MOBILE_PRESET, type BrowserState, type ViewBounds, type Viewport } from '@shared/types'
import { MAX_BROWSER_TABS, browserTabKeyAction, canOpenTab, cycleTab, nextTabId, tabAfterClose, tabAtNumber, type BrowserTabInfo, type BrowserTabKeyAction } from '@shared/browserTabs'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportHandled } from '@shared/report'
import { retireView } from './viewTeardown'
import { addressBarUrl, normalizeUrl } from '@shared/projectUrl'
import { isProjectPageUrl } from '@shared/htmlPreview'
import { restorableHistory } from '@shared/projectSession'
import { isAbortedNavigation } from '@shared/browserNav'
import {
  createExternalOpener,
  displayOrigin,
  installPermissionPolicy,
  isAllowedExternalUrl,
  isPageNavigationAllowed,
  isTabCaptureRequest,
  isPopupUrlAllowed,
  isTypedNavigationAllowed,
  PageClipboardGrant,
  popupWindowAction,
  type PermissionSessionLike
} from './webPolicy'

/**
 * 内蔵ブラウザ（設計 2章の WebContentsView = Chromium）。
 *
 * インスタンスは1つだけ作り、モード切替では bounds だけを動かす。
 * ビューを作り直さないので、エディタモード ⇄ フィードバックモードでページが再読込されない。
 *
 * タブ（@shared/browserTabs）: タブ1枚が WebContentsView 1つ。前に出ているタブだけを見せ、ほかは隠す（ページはそのまま残る）。
 * どのタブも同じ永続の session と同じ守り（権限・遷移・window.open・注入スクリプト）で作る（createTab の1か所だけ）
 */

/** WS-2 ログイン状態（Cookie）を保持する永続パーティション。既定はすべてのプロジェクトで共有（@shared/browserProfile） */
export const PARTITION = SHARED_BROWSER_PARTITION

/**
 * 内蔵ブラウザで許す権限。レビューするページは信用しないので、既定ですべて断る。
 * 録画は別の録画ウインドウ（既定のセッション）がタブを録るので、ページにマイク・カメラ・画面共有は要らない。
 * 許すのは、利用者がビューを操作した直後の、そのページの1回のコピー（書き込み専用・整形済み。PageClipboardGrant）と、
 * 録画ウインドウからのタブ録画の問い合わせ（isTabCaptureRequest）だけ
 */
const pageClipboard = new PageClipboardGrant()

/** 用意した内蔵ブラウザの session（組ごと。partition の名前 → session） */
const readySessions = new Map<string, Session>()
/** session ごとの UA の決まり（browserSession で作る） */
const identities = new WeakMap<Session, BrowserIdentity>()
/** session を用意したときに入れるもの（プレビュー・プロジェクトのページの配信・拡張機能。index.ts が登録する） */
const sessionReadyListeners: Array<(ses: Session) => void> = []

/**
 * 内蔵ブラウザの session。権限の決まり（既定で拒否）と外部アプリの確認を、読み込みの前に必ず入れてから返す。
 * 内蔵ブラウザの session は必ずここから取ること。partition を省くと共有の組（すべてのプロジェクトで共有）
 */
export function browserSession(confirmWindow?: () => BaseWindow | null, partition: string = PARTITION): Session {
  const ses = session.fromPartition(partition)
  if (!readySessions.has(partition)) {
    readySessions.set(partition, ses)
    installPermissionPolicy(ses as unknown as PermissionSessionLike,
      (query) => pageClipboard.allow(query) || isTabCaptureRequest(query),
      (url, origin) => void openExternalFromPage(url, origin))
    // Google などのログインに断られないよう、既定は Chrome と同じ形の UA。
    // Cloudflare の確認を返したホストだけ Electron の印を残した UA で開き直す（browserUserAgent.ts の BrowserIdentity）
    const native = ses.getUserAgent()
    const id = new BrowserIdentity(cleanElectronUserAgent(native), electronUserAgent(native))
    identities.set(ses, id)
    ses.setUserAgent(id.chromeUserAgent)
    installIdentityHeaders(ses, id)
    for (const listener of sessionReadyListeners) listener(ses)
  }
  if (confirmWindow) confirmWindowOf = confirmWindow
  return ses
}

/** 用意した内蔵ブラウザの session すべて（共有の組が先） */
export function browserSessions(): Session[] {
  return [...readySessions.values()]
}

/** 内蔵ブラウザの session を用意したときに呼ぶ（すでに用意したものにもすぐ呼ぶ） */
export function onBrowserSessionReady(listener: (ses: Session) => void): void {
  sessionReadyListeners.push(listener)
  for (const ses of readySessions.values()) listener(ses)
}

/** その画面の session の UA の決まり（内蔵ブラウザの session でなければ null） */
function identityOf(wc: WebContents): BrowserIdentity | null {
  return identities.get(wc.session) ?? null
}

/**
 * ページ本体の読み込みのリクエストの UA を行き先のホストに合わせ、Cloudflare の確認が返ったら Electron の UA で1回だけ開き直す。
 * GET 以外（フォームの送信）は開き直さない（同じ内容を勝手に送り直さない。次に開いたときから Electron の UA になる）
 */
function installIdentityHeaders(ses: Session, id: BrowserIdentity): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const wc = details.webContents
    const ua = wc && !wc.isDestroyed() ? id.requestUserAgent({ url: details.url, resourceType: details.resourceType, currentUserAgent: wc.getUserAgent() }) : null
    if (!ua) return callback({})
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== 'user-agent'))
    callback({ requestHeaders: { ...requestHeaders, 'User-Agent': ua } })
  })
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({})
    const wc = details.webContents
    if (!wc || wc.isDestroyed() || details.resourceType !== 'mainFrame') return
    const current = wc.getUserAgent()
    const sent = id.owns(current) ? id.userAgentFor(details.url) : current
    if (!id.noteResponse({ url: details.url, resourceType: details.resourceType, sentUserAgent: sent, headers: details.responseHeaders })) return
    if (details.method !== 'GET') return
    setImmediate(() => {
      if (wc.isDestroyed()) return
      wc.setUserAgent(id.electronUserAgent)
      void wc.loadURL(details.url).catch(() => undefined)
    })
  })
}

/**
 * タブ・ポップアップの UA を、遷移が始まるたびに行き先のホストのもの（BrowserIdentity）にする。
 * ページの JS から見える navigator.userAgent を、送るヘッダーの UA と揃えるため。モバイルの表示の UA には手を出さない
 */
function followIdentity(wc: WebContents): void {
  wc.on('did-start-navigation', (details) => {
    const identity = identityOf(wc)
    if (!identity || !details.isMainFrame || details.isSameDocument) return
    const current = wc.getUserAgent()
    if (!identity.owns(current)) return
    const next = identity.userAgentFor(details.url)
    if (next !== current) wc.setUserAgent(next)
  })
}

let confirmWindowOf: () => BaseWindow | null = () => null

/** E2E の非表示実行（ADE_E2E=1 で ADE_E2E_SHOW が無い）ではポップアップを画面に出さない */
const HIDE_POPUPS = process.env.ADE_E2E === '1' && process.env.ADE_E2E_SHOW !== '1'

/**
 * ログインのポップアップの子ウインドウ。内蔵ブラウザと同じ永続の session（ログインがそのまま残る）で、
 * ページのスクリプトに Node は渡さない（sandbox・contextIsolation・nodeIntegration なし）。
 * 内蔵ブラウザのページと同じ書き込みの注入スクリプト（preload/review）を入れ、録画中はポップアップの上にもペン・枠・文字で指摘を引ける。
 * main が受けるのは、いま前に出ているポップアップからの書き込みのチャネルだけ（recording/controller.ts・textNotes.ts）
 */
function popupWindowOptions(partition: string): Electron.BrowserWindowConstructorOptions {
  return {
    width: 520,
    height: 680,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // 開いたタブと同じ組の session（ログインの結果がそのタブに届く）
      partition,
      preload: join(__dirname, '../preload/review.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false
    }
  }
}

/** 表示中のページが別のアプリ（mailto など）を開こうとした。許可リストのものだけ、確認してから渡す */
const openExternalFromPage = createExternalOpener({
  confirm: async ({ url, origin }) => {
    const options = {
      type: 'question' as const,
      buttons: [t('browser.external.open'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('browser.external.message'),
      detail: t('browser.external.detail', { origin: displayOrigin(origin) || '-', url: url.slice(0, 300) })
    }
    const parent = confirmWindowOf()
    const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return response === 0
  },
  open: (url) => shell.openExternal(url),
  onError: (err) => reportHandled(err, { area: 'browser', op: 'open external link' })
})

/** ページが新しいタブを開いてよい、利用者がそのタブを操作してからの時間（ページのスクリプトだけではタブを増やせない） */
const PAGE_TAB_GESTURE_MS = 5_000

/** タブを URL の並びで開くときの形（プロジェクトごとに覚えたタブ。@shared/projectSession の sessionTabs） */
export interface ProjectTabs {
  urls: string[]
  /** 前に出すタブの番号 */
  active: number
}

/** 戻る・進むの履歴ごと写したタブ（アプリを開いている間だけ main が持つ。設定には書かない） */
export interface TabsSnapshot {
  tabs: Array<{ url: string; entries: import('electron').NavigationEntry[]; index: number }>
  active: number
}

const isRecordableTabUrl = (url: string): boolean => !!url && url !== 'about:blank' && isNavigableUrl(url)

/** 内蔵ブラウザのタブ1枚 */
interface BrowserTab {
  id: string
  view: WebContentsView
  /**
   * レンダラ（フレームウィジェット）ができているか。
   *
   * Electron 44 の `enableDeviceEmulation` / `disableDeviceEmulation` は、
   * まだレンダラが無い webContents に対して呼ぶとネイティブ側でヌル参照し、
   * メインプロセスごと落ちる（EXC_BAD_ACCESS）。`dom-ready` まで呼ばない。
   */
  rendererReady: boolean
  /**
   * 端末エミュレーションを実際に有効化したか。
   * 一度も有効化していないのに解除を呼ばないための印。
   */
  emulating: boolean
  /** 最後の遷移が失敗したときの理由。次の読み込みが始まったら消す */
  loadError: string | null
  /** 利用者がこのタブに最後に本物の入力をした時刻（ページが新しいタブを開くときの許可） */
  gestureAt: number
  /**
   * 閉じ始めた（destroyTab）。ビューは外し、webContents の close は次のティック。
   * 印の付いたタブは、前に出す・配置・エミュレーションの対象にしない（閉じかけのビューを触らない。0.4.19 の Windows のクラッシュの候補）
   */
  destroyed: boolean
}

export class EmbeddedBrowser {
  private tabs: BrowserTab[] = []
  private activeId = ''
  private tabCounter = 0
  /** 閉じたが、録画が使っているので録画が終わるまで残すタブの中身（releaseClosedTabs で閉じる） */
  private retired = new Set<WebContents>()
  private window: BaseWindow | null = null
  private viewport: Viewport = 'desktop'
  private bounds: ViewBounds | null = null
  private listeners = new Set<(state: BrowserState) => void>()
  private lastState: string | null = null
  /** 地の色（新しいタブにも同じ色を入れる） */
  private background = '#ffffff'

  /**
   * 表示幅が変わったことを録画へ知らせる（WS-3 → 操作ログの viewport イベント）。
   * 録画していないときは何もしない。
   */
  onViewportChange?: (width: number) => void

  /**
   * 内蔵ブラウザ・映したウインドウのビューに本物の入力（クリック・キー）が届いた。
   * 文字で指摘の静止画の許可（captureConsent.ts の ViewInputGrant）に使う
   */
  onPageInput?: (contents: WebContents) => void

  /** ログインのポップアップ（子ウインドウ）を開いた。url は開いた先（録画のトラックの名前に使う） */
  onPopupWindow?: (contents: WebContents, url: string) => void

  /** タブを作った（録画の結びつけ・拡張機能のポップアップを閉じるなど、タブごとの受け口を付ける） */
  onTabCreated?: (contents: WebContents) => void

  /** 前に出ているタブが変わった（録画はそのタブを録る。recording/controller.ts の selectBrowserTab） */
  onActiveTab?: (contents: WebContents) => void

  /** タブを閉じた（録画のそのタブのトラックを閉じる） */
  onTabClosed?: (contents: WebContents) => void

  /** 閉じたタブの中身を、いま捨てずに残すか（録画がそのタブを録っている間は残す） */
  keepClosedTab?: (contents: WebContents) => boolean

  /** ページのキー（⌘T）で新しいタブを開いた。アプリの画面の URL 欄へ焦点を移す */
  onFocusUrl?: () => void

  /** 利用者に短く知らせる（タブの上限など） */
  onNotice?: (message: string) => void

  /** 開いているログインのポップアップの中身 */
  popupContents(): WebContents[] {
    return [...this.popups].filter((popup) => !popup.isDestroyed() && !popup.webContents.isDestroyed()).map((popup) => popup.webContents)
  }

  /** 録画エンジンが録る対象（前に出ているタブ）。破棄済みなら null */
  get contents(): WebContents | null {
    return this.webContents
  }

  /** 開いているタブの中身すべて（並び順） */
  allContents(): WebContents[] {
    return this.tabs.map((tab) => tab.view.webContents).filter((wc) => !wc.isDestroyed())
  }

  /** 内蔵ブラウザのどれかのタブのページに焦点があるか */
  hasFocus(): boolean {
    return this.allContents().some((wc) => wc.isFocused())
  }

  /** 内蔵ブラウザの場所に映しているウインドウのビュー（showMirror）。映していなければ null */
  get mirrorContents(): WebContents | null {
    const wc = this.mirror?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  /**
   * フィードバックに添える Ferret の静止画に重ねるため、見えているビューの位置（ウインドウの中の DIP）と中身。
   * 隠れている（0 サイズ）・破棄済みなら null
   */
  visibleSnapshotTarget(): { contents: WebContents; bounds: { x: number; y: number; width: number; height: number } } | null {
    const wc = this.webContents
    const bounds = this.view?.getBounds()
    if (!wc || !bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return { contents: wc, bounds }
  }

  /**
   * ビューの位置・大きさが変わった（隠れた・映したウインドウを出した・タブを切り替えた も含む）。
   * 拡張機能のポップアップ（browserExtensions.ts）をビューの右上に付いて動かす・閉じるのに使う
   */
  onLayout?: () => void

  /**
   * 内蔵ブラウザのビューの、いまの位置（ウインドウの中の DIP）。
   * 隠れている（0 サイズ）・映したウインドウを上に出している・破棄済みなら null
   */
  viewBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.webContents || this.mirrorContents) return null
    const bounds = this.view?.getBounds()
    return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null
  }

  /** ページが描く前に見える地の色。配色の切り替えに合わせる */
  setBackgroundColor(color: string): void {
    this.background = color
    for (const tab of this.tabs) tab.view.setBackgroundColor(color)
  }

  /** いま開いているプロジェクトのログインの組（session の名前）。新しいタブ・ポップアップはこの組で作る */
  private partition: string = PARTITION

  /**
   * ログインの組を変える（プロジェクトの切り替え・組の変更の前に呼ぶ）。開いているタブはそのまま。
   * 入れ替えるのは replaceTabs（新しいタブを新しい組で作る）
   */
  setPartition(partition: string): void {
    this.partition = partition
  }

  /** いまのログインの組の session（拡張機能のポップアップなど） */
  activeSession(): Session {
    return browserSession(undefined, this.partition)
  }

  /** いまのログインの組 */
  activePartition(): string {
    return this.partition
  }

  attach(window: BaseWindow, initial: string | ProjectTabs, viewport: Viewport): void {
    this.window = window
    this.viewport = viewport
    this.openTabs(typeof initial === 'string' ? { urls: [initial], active: 0 } : initial)
  }

  /**
   * 開いているタブを、戻る・進むの履歴とページの状態（スクロール・フォームの値）ごと写す。
   * プロジェクトを切り替えるときに main が前のプロジェクトの分として持っておき、戻ってきたら replaceTabs で開き直す
   */
  snapshotTabs(): TabsSnapshot {
    const tabs = this.tabs.filter((tab) => !tab.view.webContents.isDestroyed())
    return {
      tabs: tabs.map((tab) => {
        const history = tab.view.webContents.navigationHistory
        return { url: tab.view.webContents.getURL(), entries: history.getAllEntries(), index: history.getActiveIndex() }
      }),
      active: Math.max(0, tabs.findIndex((tab) => tab.id === this.activeId))
    }
  }

  /**
   * いまのタブをすべて閉じ、別のプロジェクトのタブに入れ替える（プロジェクトの切り替え）。
   * 写し（snapshot）があれば履歴ごと、無ければ URL の並び（fallback）で開く。前のプロジェクトのタブ・履歴は残さない
   */
  replaceTabs(snapshot: TabsSnapshot | null, fallback: ProjectTabs): void {
    if (!this.window || this.window.isDestroyed()) return
    // 前のタブは、新しいタブを作り終えてから外す（新しいタブを映した映像・拡張機能のポップアップより下に差し込むため）
    const old = [...this.tabs]
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.close()
    this.popups.clear()
    if (snapshot && snapshot.tabs.length > 0) this.restoreSnapshot(snapshot)
    else this.openTabs(fallback)
    this.tabs = this.tabs.filter((tab) => !old.includes(tab))
    for (const tab of old) this.destroyTab(tab)
    this.emitState()
  }

  /** URL の並びでタブを開き、active 番目を前に出す。開けない URL のタブは空のまま（URL 欄から直せる） */
  private openTabs({ urls, active }: ProjectTabs): void {
    const list = (urls.length ? urls : ['']).slice(0, MAX_BROWSER_TABS)
    const created = list.map(() => this.createTab())
    this.activateFirst(created[Math.min(Math.max(0, active), created.length - 1)]!)
    list.forEach((url, i) => {
      const wc = created[i]!.view.webContents
      const target = url ? normalizeUrl(url) : ''
      // 前回の URL が開けない（形式が違う・許さないスキーム）なら空のまま
      if (target && isNavigableUrl(target) && isTypedNavigationAllowed(target)) void this.load(wc, target).then(() => this.emitState())
    })
  }

  /** 写したタブを、戻る・進むの履歴ごと開き直す。開いてよい URL の項目だけを戻す */
  private restoreSnapshot(snapshot: TabsSnapshot): void {
    const list = snapshot.tabs.slice(0, MAX_BROWSER_TABS)
    const created = list.map(() => this.createTab())
    this.activateFirst(created[Math.min(Math.max(0, snapshot.active), created.length - 1)]!)
    list.forEach((saved, i) => {
      const wc = created[i]!.view.webContents
      const history = restorableHistory(saved.entries, saved.index, (url) => isNavigableUrl(url) && isTypedNavigationAllowed(url))
      if (history) {
        void wc.navigationHistory.restore(history).then(() => this.emitState()).catch((err: unknown) => {
          // 次の読み込み・タブの入れ替えで中断された（ERR_ABORTED）・閉じたタブは想定内。送らず、開き直しもしない（FERRET-1R）
          if (isAbortedNavigation(err) || wc.isDestroyed()) return
          reportHandled(err, { area: 'browser', op: 'restore tab history' })
          if (isRecordableTabUrl(saved.url)) void this.load(wc, saved.url).then(() => this.emitState())
        })
      } else if (isRecordableTabUrl(saved.url) && isTypedNavigationAllowed(saved.url)) {
        void this.load(wc, saved.url).then(() => this.emitState())
      }
    })
  }

  /** 作ったばかりのタブを前に出す（attach・入れ替えの直後。activateTab と違い前のタブを見ない） */
  private activateFirst(tab: BrowserTab): void {
    this.activeId = tab.id
    this.placeViews()
    this.onLayout?.()
    this.applyEmulation(tab)
    this.onActiveTab?.(tab.view.webContents)
  }

  /**
   * タブを1枚作る（まだ前には出さない）。どのタブもここだけで作り、同じ守りを入れる:
   * 権限の決まりを入れた永続の session・注入スクリプトだけの preload・sandbox・遷移と転送の決まり・window.open の扱い
   */
  private createTab(): BrowserTab {
    const window = this.window
    if (!window || window.isDestroyed()) throw new UserFacingError(t('browser.errors.generic'))
    const view = new WebContentsView({
      webPreferences: {
        // 権限の決まり（既定で拒否）を入れた session。ビューを作る＝読み込む前に入れる
        session: browserSession(() => this.window, this.partition),
        // ペン・操作ログの注入スクリプト（設計4章）。
        // preload なのでページ本体のスクリプトとは別の世界で動き、遷移のたびに読み直される。
        preload: join(__dirname, '../preload/review.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // レビュー対象は開発中のローカルサイトであり、拡張機能的な注入は後続の
        // ペン・テキストレイヤーで行う。ここでは素のブラウザとして扱う。
        webSecurity: true
      }
    })
    const tab: BrowserTab = { id: nextTabId(++this.tabCounter), view, rendererReady: false, emulating: false, loadError: null, gestureAt: 0, destroyed: false }
    view.setBackgroundColor(this.background)
    // 映した映像・拡張機能のポップアップより下に置く（いちばん下のタブの位置に差し込む）
    const children = window.contentView.children ?? []
    const lowest = this.tabs.map((other) => children.indexOf(other.view)).filter((i) => i >= 0)
    if (lowest.length > 0) window.contentView.addChildView(view, Math.min(...lowest))
    else window.contentView.addChildView(view)
    // bounds が renderer から届くまでは描画させない（0サイズ）。前に出すまでは隠す
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    this.tabs.push(tab)

    const wc = view.webContents
    // ページのコピーは、利用者がこのビューをクリック・キー入力した直後だけ（ポップアップの入力では許さない。security-5 [14]）
    wc.on('input-event', (_event, input) => {
      if (isGestureInput(input.type)) pageClipboard.noteGesture(wc, wc.getURL())
      // 文字で指摘の静止画の許可（そのビューへの本物の入力だけ。captureConsent.ts の ViewInputGrant）
      if (isGestureInput(input.type)) this.onPageInput?.(wc)
      // ページが新しいタブを開いてよいのは、利用者がこのタブを操作した直後だけ
      if (isGestureInput(input.type)) tab.gestureAt = Date.now()
    })
    // タブのキー（⌘T・⌘W・⌘1〜9・Ctrl+Tab）。ページに焦点があるときは、メニュー（ターミナルの ⌘T / ⌘W）より先にここで受ける
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const action = browserTabKeyAction(input, process.platform)
      if (!action) return
      event.preventDefault()
      this.runTabKey(action)
    })

    // ログインのポップアップ（window.open に大きさを指定したもの。Google でログインなど）だけは、同じセッションの子ウインドウで開く。
    // opener を保つので、ログインが終わってポップアップが閉じれば元のページに結果が届く（webPolicy.ts の popupWindowAction）。
    // 普通の別タブ（target=_blank のリンクなど）は内蔵ブラウザの新しいタブで開く（opener は渡さない）。別のアプリへは mailto だけを、確認してから渡す。
    // file: data: javascript: や独自スキームは何もしない（ページから OS の URL ハンドラを呼ばせない）
    wc.setWindowOpenHandler((details) => {
      // プロジェクトのページからは、外のページを別タブ・ポップアップ・外のアプリで開かせない（security-7 [6]。開くのは利用者が URL 欄に入れたときだけ）
      if (isProjectPageUrl(wc.getURL()) && !isProjectPageUrl(details.url)) {
        this.noticeBlockedExternal(details.url)
        return { action: 'deny' }
      }
      const action = popupWindowAction(details)
      if (action === 'popup') return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(this.partition) }
      if (action === 'tab') this.openTabFromPage(tab, details.url, details.disposition !== 'background-tab')
      else if (action === 'in-app') void wc.loadURL(details.url).catch(() => undefined)
      else if (action === 'external') void openExternalFromPage(details.url, wc.getURL())
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child, details) => this.guardPopup(child, (details as { url?: unknown } | undefined)?.url))
    // ページが始めた遷移（リンク・location の書き換え）。行けない先は止め、mailto は確認へ回す
    wc.on('will-navigate', (event) => {
      if (isPageNavigationAllowed(event.url, wc.getURL())) return
      event.preventDefault()
      if (isProjectPageUrl(wc.getURL())) {
        this.noticeBlockedExternal(event.url)
        return
      }
      if (isAllowedExternalUrl(event.url)) void openExternalFromPage(event.url, wc.getURL())
    })
    // サーバーの転送（リダイレクト）にも同じ決まりを当てる。独自スキームへの転送は、外部アプリの起動の権限（確認付き）へ回る
    wc.on('will-redirect', (event) => {
      if (isPageNavigationAllowed(event.url, wc.getURL())) return
      event.preventDefault()
      if (isProjectPageUrl(wc.getURL())) return
      if (isAllowedExternalUrl(event.url)) void openExternalFromPage(event.url, wc.getURL())
    })

    followIdentity(wc)

    const emit = (): void => this.emitState()
    wc.on('did-start-loading', () => {
      tab.loadError = null
      emit()
    })
    wc.on('did-stop-loading', emit)
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
    wc.on('page-title-updated', emit)
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 は ERR_ABORTED（遷移のキャンセル）。通常運用で出るので黙って無視する
      if (code !== -3) console.warn(`[browser] 読み込み失敗 ${code} ${desc} ${url}`)
      // 白い画面のままにしない。理由を出して、URLの直しか再読み込みを促す
      if (code !== -3 && isMainFrame) tab.loadError = loadErrorMessage(code)
      emit()
    })

    wc.on('dom-ready', () => {
      tab.rendererReady = true
      // プロセスが入れ替わる遷移ではエミュレーションが外れるため、掛け直す
      if (this.viewport === 'mobile') tab.emulating = false
      this.applyEmulation(tab)
    })
    wc.on('render-process-gone', (_e, details) => {
      // レンダラが居なくなったら、できるまで emulation 系のAPIを呼ばない
      tab.rendererReady = false
      tab.emulating = false
      // 利用者のページのレンダラの終了。アプリの不具合ではないので送らない（アプリ自身の画面は telemetry.ts が拾う）
      console.warn(`[browser] レンダラが終了しました: ${details.reason}`)
    })
    this.onTabCreated?.(wc)
    return tab
  }

  /** 前に出ているタブ */
  private get activeTab(): BrowserTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId && !tab.destroyed)
  }

  private get view(): WebContentsView | null {
    return this.activeTab?.view ?? null
  }

  /** 破棄済みの webContents を触らない。すべての操作はこれを通す */
  private get webContents() {
    const wc = this.view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  /**
   * 新しいタブを開いて前に出す。url を渡せばそれを開き、省けば空のタブ（URL 欄から入れる）。
   * 上限（MAX_BROWSER_TABS）なら開かずに知らせる。開けない URL なら、タブを作る前に断る
   */
  async newTab(input = ''): Promise<string> {
    if (!canOpenTab(this.tabs.length)) throw new UserFacingError(t('browser.tabs.limit', { n: MAX_BROWSER_TABS }))
    // URL 欄から（URL の形でなければ Google で検索）
    const url = input.trim() ? addressBarUrl(input) : ''
    if (url && (!isNavigableUrl(url) || !isTypedNavigationAllowed(url))) throw new UserFacingError(t('browser.errors.invalidUrl'))
    const tab = this.createTab()
    this.activateTab(tab.id)
    if (url) await this.load(tab.view.webContents, url)
    this.emitState()
    return tab.id
  }

  /**
   * ページが開いた別タブ（target=_blank・大きさの無い window.open）。利用者がそのタブを操作した直後で、上限より少なければ新しいタブで開く。
   * そうでなければ今までどおり同じタブで開く（ページのスクリプトだけではタブを増やせない）
   */
  private openTabFromPage(opener: BrowserTab, url: string, foreground: boolean): void {
    const fresh = Date.now() - opener.gestureAt <= PAGE_TAB_GESTURE_MS
    if (!fresh || !canOpenTab(this.tabs.length)) {
      if (fresh) this.onNotice?.(t('browser.tabs.limitSameTab', { n: MAX_BROWSER_TABS }))
      void opener.view.webContents.loadURL(url).catch(() => undefined)
      return
    }
    // 1回の操作で開けるのは1枚だけ
    opener.gestureAt = 0
    let tab: BrowserTab
    try {
      tab = this.createTab()
    } catch (err) {
      reportHandled(err, { area: 'browser', op: 'open tab from page' })
      return
    }
    if (foreground) this.activateTab(tab.id)
    else this.emitState()
    void this.load(tab.view.webContents, url)
  }

  /** その中身のタブを前に出す（録画のトラックの切り替えから） */
  activateContents(contents: WebContents): void {
    const tab = this.tabs.find((candidate) => candidate.view.webContents === contents)
    if (tab) this.activateTab(tab.id)
  }

  /** そのタブを前に出す。録画中なら録画もそのタブへ移る（onActiveTab） */
  activateTab(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const changed = this.activeId !== id
    this.activeId = id
    this.placeViews()
    this.onLayout?.()
    this.emitState()
    if (changed) {
      // 表示幅（スマホ幅）はタブをまたいで同じ。前に出たタブにも掛ける
      this.applyEmulation(tab)
      this.onActiveTab?.(tab.view.webContents)
    }
  }

  /** タブの並び（右クリックのメニューで閉じるタブを決める） */
  tabIds(): string[] {
    return this.tabs.map((tab) => tab.id)
  }

  /**
   * まとめて閉じる（右クリックの「ほかを閉じる・右側を閉じる・すべて閉じる」）。残るタブ（keep）があり、前に出ているタブを閉じるなら、
   * 先に keep を前に出す（閉じる途中で、どうせ閉じる隣のタブへ次々に切り替わらないように）。全部閉じれば空のタブが1枚残る
   */
  closeTabs(ids: readonly string[], keep: string | null): void {
    const closing = new Set(ids)
    if (keep && !closing.has(keep) && closing.has(this.activeId)) this.activateTab(keep)
    for (const id of ids) this.closeTab(id)
  }

  /**
   * タブを閉じる。最後の1枚なら、空のタブに置き換える（内蔵ブラウザは空にしない）。
   * 録画がそのタブを録っている間は、中身を捨てずに残す（録画が終わったら releaseClosedTabs で閉じる）
   */
  closeTab(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (this.tabs.length === 1) {
      const blank = this.createTab()
      this.activateTab(blank.id)
    }
    const next = tabAfterClose(this.tabs.map((candidate) => candidate.id), id, this.activeId)
    this.tabs = this.tabs.filter((candidate) => candidate !== tab)
    if (this.activeId === id && next) this.activateTab(next)
    this.destroyTab(tab)
    this.emitState()
  }

  /** 録画が終わった。録画のために残していた、閉じたタブの中身を閉じる */
  releaseClosedTabs(): void {
    for (const wc of this.retired) if (!wc.isDestroyed()) wc.close()
    this.retired.clear()
  }

  /**
   * タブを閉じる。先に印を付けて隠し、ウインドウから外す（以後どの処理も触らない）。webContents の close は次のティックに回す
   * （外す処理と close を同じ流れで重ねない。プロジェクトの切り替え・タブを閉じる操作のどちらもここを通る）
   */
  private destroyTab(tab: BrowserTab): void {
    if (tab.destroyed) return
    tab.destroyed = true
    const wc = tab.view.webContents
    try {
      // 録画が使っているタブは、録画が終わるまで中身を残す（隠すと録っている映像が止まるので、表示のまま外すだけ）
      const keep = !wc.isDestroyed() && (this.keepClosedTab?.(wc) ?? false)
      if (!wc.isDestroyed() && !keep) {
        tab.view.setVisible(false)
        tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      }
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
      if (wc.isDestroyed()) return
      this.onTabClosed?.(wc)
      if (keep) {
        this.retired.add(wc)
        return
      }
    } catch (err) {
      reportHandled(err, { area: 'browser', op: 'close tab' })
    }
    setImmediate(() => {
      try {
        if (!wc.isDestroyed()) wc.close()
      } catch (err) {
        reportHandled(err, { area: 'browser', op: 'close tab' })
      }
    })
  }

  /** ページのキー（⌘T・⌘W・⌘1〜9・Ctrl+Tab） */
  private runTabKey(action: BrowserTabKeyAction): void {
    const ids = this.tabs.map((tab) => tab.id)
    if (action.type === 'new') {
      void this.newTab().then(() => this.onFocusUrl?.()).catch((err: unknown) => {
        if (err instanceof UserFacingError) this.onNotice?.(err.message)
        else reportHandled(err, { area: 'browser', op: 'new tab from key' })
      })
      return
    }
    if (action.type === 'close') return this.closeTab(this.activeId)
    const target = action.type === 'number' ? tabAtNumber(ids, action.n) : cycleTab(ids, this.activeId, action.step)
    if (!target || target === this.activeId) return
    this.activateTab(target)
    // キーで切り替えたら、続けてキーで操作できるよう、前に出たページへ焦点を移す
    this.webContents?.focus()
  }

  onStateChange(listener: (state: BrowserState) => void): void {
    this.listeners.add(listener)
  }

  /** 画面へ出すタブの一覧 */
  private tabInfos(): BrowserTabInfo[] {
    return this.tabs.filter((tab) => !tab.view.webContents.isDestroyed()).map((tab) => {
      const wc = tab.view.webContents
      return { id: tab.id, title: wc.getTitle(), url: wc.getURL(), loading: wc.isLoading() }
    })
  }

  state(): BrowserState {
    const wc = this.webContents
    const tabs = { tabs: this.tabInfos(), activeTabId: this.activeId }
    if (!wc) {
      return {
        url: '',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        viewport: this.viewport,
        ...tabs
      }
    }
    const loadError = this.activeTab?.loadError
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      viewport: this.viewport,
      ...(loadError ? { loadError } : {}),
      ...tabs
    }
  }

  private emitState(): void {
    const next = this.state()
    const key = JSON.stringify(next)
    if (key === this.lastState) return
    this.lastState = key
    for (const listener of this.listeners) listener(next)
  }

  /** 録画中の画面・ウインドウを映すビュー（showMirror）。内蔵ブラウザの上に同じ大きさで重ねる */
  private mirror: WebContentsView | null = null
  /** 映しているもの（desktopCapturer の ID）。同じものなら作り直さない */
  private mirrorSource: string | null = null

  /**
   * 画面全体・別のウインドウを録画している間、内蔵ブラウザの場所にその映像を映す。
   * 何が録られているかを見ながら、内蔵ブラウザと同じ書き込み（ペン・四角の枠）をその上に引ける
   * （書き込みの注入スクリプト preload/review を同じく読み込む）。映像を求めてよいのは録画ウインドウと同じ扱い。
   * 映せなければ null（録画は続ける）
   */
  async showMirror(htmlPath: string, sourceId: string, message = ''): Promise<WebContents | null> {
    const current = this.mirror?.webContents
    if (this.mirrorSource === sourceId && current && !current.isDestroyed()) return current
    this.hideMirror()
    const window = this.window
    if (!window || window.isDestroyed()) return null
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/review.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false
      }
    })
    this.mirror = view
    this.mirrorSource = sourceId
    view.setBackgroundColor('#111214')
    const wc = view.webContents
    registerRecorderContents(wc)
    // 映すだけのページ。ほかへは行かせず、窓も開かせない
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('will-redirect', (event) => event.preventDefault())
    // 映した映像の上で文字で指摘を打ったときの許可（そのビューへの本物の入力だけ）
    wc.on('input-event', (_event, input) => { if (isGestureInput(input.type)) this.onPageInput?.(wc) })
    window.contentView.addChildView(view)
    this.applyBounds()
    try {
      // E2E の偽の画面・ウインドウ（recording/fakeCapture.ts）なら、本物の取り込みの代わりに canvas の映像を映す
      await wc.loadFile(htmlPath, { query: { source: sourceId, ...(message ? { message } : {}), ...(fakeCapturePath() ? { synthetic: '1' } : {}) } })
    } catch (err) {
      reportHandled(err, { area: 'browser', op: 'load capture mirror' })
      if (this.mirror === view) this.hideMirror()
      return null
    }
    return this.mirror === view && !wc.isDestroyed() ? wc : null
  }

  hideMirror(): void {
    const view = this.mirror
    this.mirror = null
    this.mirrorSource = null
    if (!view) return
    this.onLayout?.()
    retireView(this.window, view, 'destroy capture mirror')
  }

  /** renderer が実測した領域。スマホ幅のときは中央に寄せて端末幅に収める */
  setBounds(bounds: ViewBounds | null): void {
    this.bounds = bounds
    this.applyBounds()
  }

  private applyBounds(): void {
    this.placeViews()
    this.onLayout?.()
  }

  private placeViews(): void {
    // 前に出ていないタブは隠す（ページはそのまま。切り替えても読み込み直さない）
    for (const tab of this.tabs) {
      if (tab.id === this.activeId || tab.destroyed || tab.view.webContents.isDestroyed()) continue
      tab.view.setVisible(false)
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
    const view = this.view
    // 破棄済みのビューに bounds を入れない（終了処理と重なるとネイティブ側で落ちる）
    if (!view || !this.webContents) return
    view.setVisible(true)
    const mirror = this.mirror && !this.mirror.webContents.isDestroyed() ? this.mirror : null
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      mirror?.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const { x, y, width, height } = this.bounds
    // 映像は表示幅（スマホ幅）に関わらず、枠いっぱいに収める
    mirror?.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
    if (this.viewport === 'mobile') {
      const w = Math.min(MOBILE_PRESET.width, width)
      view.setBounds({
        x: Math.round(x + (width - w) / 2),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(height)
      })
    } else {
      view.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      })
    }
  }

  setViewport(viewport: Viewport): void {
    if (this.viewport === viewport) return
    this.viewport = viewport
    for (const tab of this.tabs) this.applyEmulation(tab)
    this.applyBounds()
    this.emitState()
    this.onViewportChange?.(
      viewport === 'mobile' ? MOBILE_PRESET.width : Math.round(this.bounds?.width ?? 0)
    )
  }

  /**
   * WS-3 代表的な端末サイズへのエミュレーション。
   * 幅そのものは bounds で変えるため、ここでは screen 系の値と UA を合わせる。
   * 再読込しないので、表示中のページの状態は保たれる。
   *
   * レンダラができる前（`dom-ready` 前）は何もしない。呼ぶとプロセスが落ちるため、
   * `dom-ready` のたびに掛け直す。
   */
  private applyEmulation(tab: BrowserTab): void {
    const wc = tab.view.webContents
    if (tab.destroyed || wc.isDestroyed() || !tab.rendererReady) return
    try {
      if (this.viewport === 'mobile') {
        if (tab.emulating) return
        wc.setUserAgent(MOBILE_PRESET.userAgent)
        wc.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: { width: MOBILE_PRESET.width, height: MOBILE_PRESET.height },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: MOBILE_PRESET.width, height: MOBILE_PRESET.height },
          deviceScaleFactor: 0,
          scale: 1
        })
        tab.emulating = true
      } else {
        if (tab.emulating) {
          tab.emulating = false
          wc.disableDeviceEmulation()
        }
        wc.setUserAgent(identityOf(wc)?.userAgentFor(wc.getURL()) ?? wc.session.getUserAgent())
      }
    } catch (err) {
      console.warn('[browser] 表示幅の切り替えに失敗しました', err)
      reportHandled(err, { area: 'browser', op: 'switch viewport' })
    }
  }

  async navigate(input: string): Promise<void> {
    const wc = this.webContents
    if (!wc) return
    // URL の形でない入力（言葉・空白を含む）は Google で検索する
    const url = addressBarUrl(input)
    // javascript: data: や独自スキーム（OS のアプリを起動する）は開かない
    if (!isNavigableUrl(url) || !isTypedNavigationAllowed(url)) throw new UserFacingError(t('browser.errors.invalidUrl'))
    await this.load(wc, url)
    this.emitState()
  }

  /** そのタブで開く。相手のサーバー・回線の失敗は画面に理由を出すので送らない */
  private async load(wc: WebContents, url: string): Promise<void> {
    try {
      await wc.loadURL(url)
    } catch (err) {
      if (!isAbortedNavigation(err)) console.warn(`[browser] 遷移できませんでした: ${url}`, err)
    }
  }

  back(): void {
    this.webContents?.navigationHistory.goBack()
  }

  forward(): void {
    this.webContents?.navigationHistory.goForward()
  }

  reload(): void {
    this.webContents?.reload()
  }

  /** プロジェクトのページが外のページへ移ろうとして止めた（行き先のホストだけ知らせる。security-7 [6]） */
  private noticeBlockedExternal(url: string): void {
    let host = ''
    try { host = new URL(url).host } catch { /* 読めない URL（想定内）。ホストなしで知らせる */ }
    this.onNotice?.(t('browser.projectPageBlockedExternal', { host: host || url.slice(0, 80) }))
  }

  /** 開いているログインのポップアップ。ビューを破棄するときに閉じる */
  private popups = new Set<BrowserWindow>()

  /**
   * ログインのポップアップに決まりを当てる。行けるのは https と手元の開発サーバーだけ（isPopupUrlAllowed）。
   * ポップアップの中からさらに開こうとしたものは、行ける先ならポップアップの中で開き、ほかは断る
   */
  private guardPopup(child: BrowserWindow, openedUrl: unknown): void {
    const url = typeof openedUrl === 'string' ? openedUrl : ''
    this.popups.add(child)
    child.once('closed', () => this.popups.delete(child))
    child.setMenuBarVisibility(false)
    const pwc = child.webContents
    pwc.setWindowOpenHandler(({ url }) => {
      if (isPopupUrlAllowed(url)) void pwc.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
    const guard = (event: { url: string; preventDefault: () => void }) => {
      if (!isPopupUrlAllowed(event.url)) event.preventDefault()
    }
    pwc.on('will-navigate', guard)
    pwc.on('will-redirect', guard)
    followIdentity(pwc)
    // 文字で指摘の静止画の許可（そのポップアップへの本物の入力だけ。captureConsent.ts の ViewInputGrant）
    pwc.on('input-event', (_event, input) => { if (isGestureInput(input.type)) this.onPageInput?.(pwc) })
    // 録画中はこのポップアップも録り、前に出たら書き込む先をそちらへ切り替える（recording/controller.ts の attachPopupWindow）
    this.onPopupWindow?.(pwc, url)
    // E2E の非表示実行では出さない（Playwright からは見える）
    if (!HIDE_POPUPS) child.once('ready-to-show', () => { if (!child.isDestroyed()) child.show() })
  }

  /**
   * ビューを明示的に捨てる。
   *
   * アプリ終了時には呼ばないこと。ウィンドウを閉じる処理と、こちらの
   * `removeChildView` + `webContents.close()` が重なると二重破棄になりうる。
   * 終了時のビューの後始末は Electron に任せる。
   */
  dispose(): void {
    this.hideMirror()
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.close()
    this.popups.clear()
    const tabs = this.tabs
    this.tabs = []
    this.activeId = ''
    for (const tab of tabs) {
      tab.destroyed = true
      retireView(this.window, tab.view, 'destroy view')
    }
    this.releaseClosedTabs()
    this.window = null
  }
}

/** スキームを補ったあとも URL として読めるか（ホスト名に空白を含む入力などを弾く） */
function isNavigableUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    // 入力の検証。読めない URL は想定内
    return false
  }
}

/** Chromium のエラー番号を、利用者向けの短い文にする */
function loadErrorMessage(code: number): string {
  // -102 接続拒否 / -105 名前解決失敗 / -106 オフライン / -118 タイムアウト / -109 到達不可 / -312 禁止ポート
  if (code === -102 || code === -109 || code === -118) {
    return t('browser.errors.connectionRefused')
  }
  if (code === -312) return t('browser.errors.unsafePort')
  if (code === -105) return t('browser.errors.nameNotResolved')
  if (code === -106) return t('browser.errors.offline')
  return t('browser.errors.generic')
}
