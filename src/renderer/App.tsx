import { ExternalDropOverlay, useExternalDrop } from './hooks/useExternalDrop'
import { currentOrchestra, orchestraMembers } from '@shared/orchestras'
import { planEditorDrop, readDrop } from './lib/externalDrop'
import { preloadable } from './lib/preloadable'
import { embedMedia, markdownDropTargetAt, planMediaDrop, planTreeMediaDrop } from './editor/markdownDrop'
import { isMarkdownLanguage } from './editor/language'
import { delay } from '@shared/delay'
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_URL,
  type AgentPreferences,
  type AppMode,
  type BrowserState,
  type ProjectsState,
  type WorkspaceState
} from '@shared/types'
import { BrowserSlot, type SlotEmptyReason } from './components/BrowserSlot'
import { BrowserToolbar } from './components/BrowserToolbar'
import { BrowserTabs } from './components/BrowserTabs'
import { UrlField } from './components/NavControls'
import { useVideoChannel } from '@video/app/renderer/useVideoChannel'
import { CenterTabs, isFileTab, type CenterTab } from './components/CenterTabs'
import { useVentureTab, VentureCenter } from './business/ventureShell'
import { ResearchModeView, useResearchMode } from './research/researchMode'
import { browserFocusLayout, layoutSignature, mainSplitGrid, withPanel, workspaceGrid, type Dock } from '@shared/layout'
import { exitBrowserFocus, initLayout, setLayout, togglePanelShown, useBrowserFocus, useLayout } from './lib/layout'
import { FileExplorer } from './components/FileExplorer'
import { QuickOpen } from './components/QuickOpen'
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog'
import { fileTabId, useOpenFiles } from './editor/useOpenFiles'
import { isHtmlPath, projectPathFromPageUrl } from '@shared/htmlPreview'
import { FeedbackToolbar, type AnnotationTool } from './components/FeedbackToolbar'
import { ReviewTargetsPanel } from './components/ReviewTargetsPanel'
import { FeedbackSideTabs, LiveTranscriptPanel } from './components/LiveTranscriptPanel'
import { TERMINAL_MOUNT_CLASS, readFeedbackSideTab, shownFeedbackSideTab, terminalPlacement, type FeedbackSideTab } from './lib/feedbackSide'
import { getTerminal } from './terminal/terminalClient'
import { useLiveTranscript } from './lib/liveTranscript'
import { liveTranscriptProblem } from '@shared/liveTranscript'
import { readLocal, writeLocal } from './lib/localPref'
import { useUrlHistory } from './lib/urlHistory'
import { startUrlChoices } from '@shared/startUrls'
import { subscribeIpc } from './lib/ipcEvents'
import { CaptureTargetPicker } from './components/CaptureTargetPicker'
import { FindingsList } from './components/FindingsList'
import { Sidebar, toReviewSession } from './components/Sidebar'
import { DEMO_SESSION_IDS, EMPTY_CAPTURE, demoCapture, demoFindings, demoSessions } from './demoData'
import { Splitter } from './components/Splitter'
import { MIC_DEVICES_REFRESH_EVENT, StatusBar, type FooterCapture } from './components/StatusBar'
import { TerminalPane } from './components/TerminalPane'
import { onAgentLaunchRequest } from './lib/agentLaunchRequest'
import { TitleBar } from './components/TitleBar'
import { useViewBounds } from './hooks/useViewBounds'
import { useAnyModalOpen } from './lib/openModals'
import { useProjectSession } from './hooks/useProjectSession'
import { matchWindowSource } from '@shared/projectTargets'
import { newReviewNeedsPage, planNewReview } from './lib/newReview'
import { useProductRound } from './hooks/useProductRound'
import { RoundBar } from './components/RoundBar'
import { useProjectActivity } from './terminal/agentActivity'
import { OrchestraDock } from './components/OrchestraDock'
import { currentDockGroup, groupDockTargets } from '@shared/dockGroups'
import { pageItems } from '@shared/humanChecklist'
import type { ChecklistItem } from '@shared/humanChecklist'
import { RemoteFilesNotice } from './components/AddProjectDialog'
import { targetFromSource } from '@shared/captureTarget'
import { installTestHooks } from './testHooks'
import { ErrorBoundary, ToastProvider, setToastNoticeFallback, useToast } from './ui'
import { sanitizeAgentPreferences } from '@shared/agentCatalog'
import { CrashReportNotice } from './components/CrashReportNotice'
import { setUiTab } from './lib/telemetry'
import type { CaptureTarget, FeedbackTargetsPrefs, RecordingStatus, SttAvailability, SttProvider } from '@shared/types'
import { EMPTY_TRACKS_STATE, type CaptureTracksState } from '@shared/captureTracks'
import { DEFAULT_ANNOTATION_COLOR, annotationModeForTool, normalizeAnnotationColor, type AnnotationColor } from '@shared/annotation'
import { showsBrowserNav } from '@shared/browserNav'
import { AI_VENDORS, LLM_API_PROVIDERS, STT_PROVIDER_PRESETS, STT_REMOTE_PROVIDERS, providerLabel } from '@shared/aiProviders'
import type { ReviewData, ReviewSummary } from '@shared/review'
import { ReviewFindings } from './components/ReviewFindings'
import { errorMessage } from './lib/errors'
import { useT } from './lib/i18n'
import type { CaptureSettings } from './components/SettingsPage'
// 設定のページの部品は遅れて読むが、その CSS はフッターのポップオーバー・オンボーディング・ダッシュボードも使うので、先に読む（並びも前と同じ所）
import './styles/cliTools.css'
import './styles/settings.css'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './lib/settingsSections'
import { shouldShowOnboarding, type OnboardingPatch, type OnboardingState, type OnboardingStepId } from '@shared/onboarding'
import { reopenPatch } from './onboarding/onboardingFlowState'
import { onShowOnboardingRequested } from './onboarding/showOnboardingEvent'
import { notifySetupChanged } from './onboarding/useSetupChecklist'
import { OnboardingStore } from './onboarding/onboardingStore'
import { StarPromptHost } from './components/StarPrompt'
import { FeedbackDialogHost } from './components/FeedbackDialog'
import { OPEN_REVIEW_EVENT } from './lib/importedReview'
import { setRecordingLevel } from './lib/recordingLevel'
import { usePublishPanelRequest } from './lib/publishPanel'
import { PublishPanel } from './components/PublishPanel'
import { ReviewHub } from './components/ReviewHub'
import { reportAnomaly, reportHandled } from '@shared/report'
import type { SttLanguageCode } from '@shared/sttLanguages'

/** エディタは重いので、起動の後で読む（起動時間 NF-5）。読み終わっていれば、開いたときに Suspense で待たせない */
const { Component: FileEditor, preload: preloadFileEditor } = preloadable(() => import('./editor/FileEditor'))
/**
 * 開いたときだけ要る画面も、起動の JS から外す（設定のページは十数の節と CSS を持つ）。
 * よく開く設定と全体のダッシュボードは、エディタと一緒に手が空いたときに先読みする
 */
/** 遅れて読む部品の props（型だけを読む） */
type PropsOf<C> = C extends (props: infer P) => unknown ? P : never
const { Component: SettingsPage, preload: preloadSettingsPage } = preloadable<PropsOf<typeof import('./components/SettingsPage').SettingsPage>>(() => import('./components/SettingsPage').then((m) => ({ default: m.SettingsPage })))
// 動画づくり（src/video/app/renderer/）。動画のチャンネルのプロジェクトで「動画」のタブを開いたときだけ読む
const VideoWorkspace = lazy(() => import('@video/app/renderer/VideoWorkspace'))
const { Component: OrchestraDashboard, preload: preloadOrchestraDashboard } = preloadable<PropsOf<typeof import('./components/OrchestraDashboard').OrchestraDashboard>>(() => import('./components/OrchestraDashboard').then((m) => ({ default: m.OrchestraDashboard })))
// ビジネス（src/renderer/venture/）。オーケストラのダッシュボードを包み、ビジネスならビジネスの画面にする
const { Component: VentureOrOrchestra } = preloadable<PropsOf<typeof import('./venture/VentureOrOrchestra').VentureOrOrchestra>>(() => import('./venture/VentureOrOrchestra').then((m) => ({ default: m.VentureOrOrchestra })))
const { Component: OnboardingFlow } = preloadable<PropsOf<typeof import('./onboarding/OnboardingFlow').OnboardingFlow>>(() => import('./onboarding/OnboardingFlow').then((m) => ({ default: m.OnboardingFlow })))
const { Component: MeetingImportDialog } = preloadable<PropsOf<typeof import('./components/MeetingImportDialog').MeetingImportDialog>>(() => import('./components/MeetingImportDialog').then((m) => ({ default: m.MeetingImportDialog })))
const { Component: Gallery } = preloadable<PropsOf<typeof import('./gallery/Gallery').Gallery>>(() => import('./gallery/Gallery').then((m) => ({ default: m.Gallery })))
/** 起動してからエディタを先読みするまでの待ち（起動直後の描画・Agent の起動と重ねない） */
const EDITOR_PRELOAD_DELAY_MS = 2500

/**
 * 起動して手が空いたら、エディタ（Markdown のプレビューの編集・Monaco）を先に読む。
 * 初めて Markdown・HTML を開いて書き始めるときに、数MBの読み込みを待たせない
 */
function scheduleEditorPreload(): () => void {
  let idle: number | undefined
  const timer = window.setTimeout(() => {
    const run = () => {
      void preloadFileEditor().then((m) => (m as typeof import('./editor/FileEditor')).preloadEditors()).catch(() => undefined)
      void preloadSettingsPage().catch(() => undefined)
      void preloadOrchestraDashboard().catch(() => undefined)
    }
    idle = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(run, { timeout: 5000 }) : window.setTimeout(run, 0)
  }, EDITOR_PRELOAD_DELAY_MS)
  return () => {
    window.clearTimeout(timer)
    if (idle !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle)
  }
}

const INITIAL_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  viewport: 'desktop'
}

/** 非表示のモードの置き場所は測らない（測ると0サイズを送ってビューが消える） */
function noopRef(): void {}

/** 部品見本は URL の #gallery で開く（E2Eからも開ける）*/
function galleryRequested(): boolean {
  return window.location.hash === '#gallery'
}

/** 画面に出す部分（状態と経過の秒）が同じか */
function sameShownStatus(a: RecordingStatus, b: RecordingStatus): boolean {
  return a.state === b.state && Math.floor(a.elapsedMs / 1000) === Math.floor(b.elapsedMs / 1000)
}

export function App() {
  // 初回のセットアップを閉じるまで、クラッシュレポートの案内は出さない（セットアップの最後で同じことを選べる）
  const [onboardingSettled, setOnboardingSettled] = useState(false)
  const settle = useCallback(() => setOnboardingSettled(true), [])
  return (
    <ToastProvider>
      <Workspace onOnboardingSettled={settle} />
      {onboardingSettled && <CrashReportNotice />}
      {/* GitHub の star のお願いも、セットアップを閉じるまでは出さない（main もセットアップ中・録画中は送らない） */}
      {onboardingSettled && <StarPromptHost />}
      {/* フィードバック → GitHub の Issue（ヘルプのメニューとサイドバーの入口から開く） */}
      <FeedbackDialogHost />
    </ToastProvider>
  )
}

function Workspace({ onOnboardingSettled }: { onOnboardingSettled: () => void }) {
  const [mode, setMode] = useState<AppMode>('editor')
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    folderPath: null,
    folderName: null
  })
  const [projects, setProjects] = useState<ProjectsState>({ projects: [], activeProjectId: null })
  /**
   * 起動の読み込みより後に projects:changed が届いたか。届いていれば、起動の読み込み（それより古い一覧）で上書きしない。
   * 起動の読み込みは内蔵ブラウザの状態なども待つので、その間に変わった一覧を古いもので戻していた（issue #5）
   */
  const projectsFromEventRef = useRef(false)
  const [agents, setAgents] = useState<AgentPreferences>(DEFAULT_AGENT_PREFERENCES)
  /** Agentへ渡す指示のテンプレート。空なら既定文 */
  const [agentPrompt, setAgentPrompt] = useState('')
  /** プロジェクト一覧・URL登録ダイアログ。開いている間はビューを隠す（ビューがDOMの上に重なるため） */
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  /** 中央のタブの右クリックのメニュー。開いている間は内蔵ブラウザのビューを隠す */
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  /** サイドバーの「プロジェクトを編集」 */
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  /** mtg の録画・文字起こしの取り込み（MeetingImportDialog） */
  const [meetingOpen, setMeetingOpen] = useState(false)
  /** 設定とワークスペースを読み終えたか。終わるまでターミナルは作らない（projectId=null 用の余分なシェルを残さない） */
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE)
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  /**
   * パネルの置き場所と表示（設定の「レイアウト」・メニューの ⌘B / ⌘J と同じ値。lib/layout.ts）。
   * splitRatio は中央のタブ群の大きさで、ターミナルが左右なら幅、上下なら高さに使う
   */
  const savedLayout = useLayout()
  /** ブラウザに集中している（タイトルバーのボタン）間は、ブラウザ以外のパネルを隠した配置で描く。設定の配置は変えない */
  const browserFocus = useBrowserFocus()
  /** 全体（すべてのプロダクト）を開いているか。オーケストラの画面（ダッシュボード・指示の欄・確認リストの帯）にする */
  const isOrchestra = !!projects.projects.find((p) => p.id === workspace.projectId)?.editorWorkspace
  /** 動画のチャンネルのプロジェクトか（src/video/app/renderer/useVideoChannel.ts） */
  const videoChannel = useVideoChannel(projects.projects.find((p) => p.id === workspace.projectId))
  /** 上のモード切替で「動画」を選んでいる間だけ、中央に動画の画面（一覧・撮る・確認・投稿）を出す。エディタのモードの上に重ねる */
  const [videoOpen, setVideoOpen] = useState(false)
  const videoOpenRef = useRef(videoOpen)
  videoOpenRef.current = videoOpen
  /** 全体では、フィードバックの対象を大きく見せるためターミナルの欄を閉じる（右下のボタンで開く。設定の配置は変えない） */
  const [terminalPeek, setTerminalPeek] = useState(false)
  const baseLayout = browserFocus ? browserFocusLayout(savedLayout) : savedLayout
  // オーケストラ前提：どのプロジェクトでも、ターミナルの欄は閉じておき右下の小さなボタンで開く（フィードバックの対象を大きく見せる）
  const layout = !terminalPeek ? { ...baseLayout, panels: { ...baseLayout.panels, terminal: { ...baseLayout.panels.terminal, visible: false } } } : baseLayout
  const terminalDock = layout.panels.terminal.dock
  /** フッターのポップオーバー。開いている間はビューを隠す（ビューがDOMの上に重なるため） */
  const [footerPopoverOpen, setFooterPopoverOpen] = useState(false)
  /** 境界をドラッグ中。ビューの上でポインターが途切れないよう、その間はビューを隠す */
  const [splitDragging, setSplitDragging] = useState(false)
  const [gallery, setGallery] = useState(galleryRequested)
  /**
   * 初回起動のセットアップ（src/renderer/onboarding/）。undefined は設定の読み込み前。
   * 開いている間は内蔵ブラウザのビューを隠し、最初に閉じるまでターミナル（＝Agent の自動起動）を作らない
   */
  const [onboarding, setOnboarding] = useState<OnboardingState | null | undefined>(undefined)
  const onboardingOpen = onboarding !== undefined && !gallery && shouldShowOnboarding(onboarding ?? undefined)
  const [terminalsAllowed, setTerminalsAllowed] = useState(false)
  useEffect(() => scheduleEditorPreload(), [])
  useEffect(() => {
    if (onboarding === undefined || onboardingOpen || terminalsAllowed) return
    setTerminalsAllowed(true)
    onOnboardingSettled()
  }, [onboarding, onboardingOpen, terminalsAllowed, onOnboardingSettled])
  /**
   * 進み具合は画面ですぐ反映し、保存は裏で行う（onboardingStore.ts）。「始める」「閉じる」は保存の成否に関わらずすぐ閉じる。
   * 保存の失敗はトーストで知らせて Sentry へ送るだけで、この起動中は閉じたままにする
   */
  const onboardingErrorRef = useRef<(err: unknown) => void>(() => undefined)
  const onboardingStoreRef = useRef<OnboardingStore | null>(null)
  onboardingStoreRef.current ??= new OnboardingStore(null, {
    save: (patch) => window.ade.invoke('settings:onboarding', patch),
    onChange: setOnboarding,
    onError: (err) => {
      reportHandled(err, { area: 'onboarding', op: 'save onboarding progress' })
      // main 側にハンドラが無い（main が古いまま）ときは main からは送られないので、ここで知らせる
      if (err instanceof Error && err.message.includes('No handler registered')) reportAnomaly('onboarding save has no handler', { kind: 'ipc', area: 'onboarding' })
      onboardingErrorRef.current(err)
    }
  })
  const persistOnboarding = useCallback((patch: OnboardingPatch) => {
    void onboardingStoreRef.current?.apply(patch)
  }, [])
  const sidebarOpen = layout.panels.projects.visible
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null)
  const [centerTab, setCenterTab] = useState<CenterTab>('browser')
  /** 中央のタブの並び（ドラッグで並べ替えた順）。開いているファイルは閉じれば消えるので保存しない */
  const [centerOrder, setCenterOrder] = useState<CenterTab[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  /*
   * 録画の中身は後続の実装（REC-1〜）。ここでは状態と見た目だけを持つ。
   * 押すとフィードバックモードへ移って録画を始める（MODE-3）という流れだけ再現する。
   */
  const [recordStatus, setRecordStatus] = useState<RecordingStatus>({ state: 'idle', elapsedMs: 0, videoBytes: 0, frameCount: 0, eventCount: 0 })
  const recording = recordStatus.state !== 'idle'
  /** 録画中に録っている映像（トラック）と待ち受け。2本以上なら録画の帯で切り替える（@shared/captureTracks） */
  const [tracks, setTracks] = useState<CaptureTracksState>(EMPTY_TRACKS_STATE)
  /** 録画中に「ほかのウインドウも同時に録る」の選択画面を開いているか */
  const [addTrackOpen, setAddTrackOpen] = useState(false)
  const [recordBusy, setRecordBusy] = useState(false)
  const recordLock = useRef(false)
  /** 次の録画を足す先のレビュー（Findings の「追加で録る」）。toggleRecording が読んで空にする */
  const appendNext = useRef<string | null>(null)
  const [review, setReview] = useState<ReviewData | null>(null)
  const [history, setHistory] = useState<ReviewSummary[]>([])
  /** 設定のページ（中央のタブ）を開いているか。focus は外から節を指定して開いたときの行き先 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFocus, setSettingsFocus] = useState<{ section: SettingsSectionId; nonce: number } | null>(null)
  const [transcription, setTranscription] = useState<SttProvider>('local')
  const [micDevices, setMicDevices] = useState<Array<{ id: string; label: string }>>([])
  // マイクの一覧は、機器の抜き差し（AirPods をつないだ など）と、マイクのメニューを開いた・［再読み込み］のたびに読み直す
  useEffect(() => {
    let timer = 0
    const refresh = () => {
      window.clearTimeout(timer)
      // 抜き差しの直後は名前がまだ揃っていないことがあるので少し待つ
      timer = window.setTimeout(() => { window.ade.invoke('capture:devices').then(setMicDevices).catch(() => undefined) }, 300) // 失敗は main の IPC が送る
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    window.addEventListener(MIC_DEVICES_REFRESH_EVENT, refresh)
    return () => {
      window.clearTimeout(timer)
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      window.removeEventListener(MIC_DEVICES_REFRESH_EVENT, refresh)
    }
  }, [])
  const [micDeviceId, setMicDeviceId] = useState('')
  const [keepDays, setKeepDays] = useState(7)
  const [stayFeedbackOnStop, setStayFeedbackOnStop] = useState(false)
  /** 録画中の文字起こしを右パネルのタブに出すか（設定の capture.showLiveTranscript。止まったときの警告は切っても出す） */
  const [showLiveTranscript, setShowLiveTranscript] = useState(true)
  const [language, setLanguage] = useState<SttLanguageCode>('auto')
  const [captureSystemAudio, setCaptureSystemAudio] = useState(false)
  /** フィードバック画面の帯に出す警告（トーストはビューに隠れるため） */
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }, [])
  // ビューの外にトーストを置く場所が無いとき（フィードバックモードで右パネルを閉じたとき）は、帯の案内の枠に出す
  useEffect(() => {
    setToastNoticeFallback(showNotice)
    return () => setToastNoticeFallback(null)
  }, [showNotice])
  const [captureMic, setCaptureMic] = useState(true)
  /** 文字起こし・整理の提供元ごとの準備状況（キーと接続先は設定の節がその場で保存する） */
  const [available, setAvailable] = useState<SttAvailability>({ localReady: false, keyStorage: 'session',
    keys: Object.fromEntries(AI_VENDORS.map((v) => [v, null])) as SttAvailability['keys'],
    stt: Object.fromEntries(STT_REMOTE_PROVIDERS.map((p) => [p, false])) as SttAvailability['stt'],
    llm: Object.fromEntries(LLM_API_PROVIDERS.map((p) => [p, false])) as SttAvailability['llm'] })
  const toast = useToast()
  const t = useT()
  /*
   * 待ち受けのウインドウ（確認先の「録画中に開いたら録る」）が現れて録り始めたら知らせる。
   * ビューは DOM の上に重なるのでトーストは見えないことがあるが、録画の帯のチップにも出る
   */
  const seenTracks = useRef(new Set<string>())
  useEffect(() => {
    if (tracks.tracks.length === 0) { seenTracks.current.clear(); return }
    for (const track of tracks.tracks) {
      if (seenTracks.current.has(track.id)) continue
      seenTracks.current.add(track.id)
      if (track.watchId) toast({ tone: 'info', message: t('feedback.tracks.appeared', { label: track.label }) })
    }
  }, [tracks, toast, t])
  /** ファイルエディタ（中央のファイルタブ・右のファイルツリー・⌘P） */
  const explorerOpen = layout.panels.files.visible
  // 「Agentへ送信」で Agent を起動するときは、ターミナルの欄を隠していても出す（起動の様子と送った結果が見えるように。ブラウザへの集中もやめる）
  useEffect(() => onAgentLaunchRequest(() => {
    exitBrowserFocus()
    setTerminalPeek(true)
    setLayout((prev) => (prev.panels.terminal.visible ? prev : withPanel(prev, 'terminal', { visible: true })))
  }), [])
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)
  /** フィードバックモードの右パネル（レビュー対象）。開閉と幅はこの端末に覚える */
  // 正本は settings.json の feedbackTargets。以前は localStorage に置いていたので、設定に無ければ1度だけそこから移す
  /** 内蔵ブラウザで開いた URL の履歴（右パネルの URL ツリーの元。パネルを閉じていても積む） */
  const urlHistory = useUrlHistory(workspace.projectId ?? null, browserState.url)
  /** 内蔵ブラウザの開始画面の候補（登録した URL・最近開いた URL・登録が無ければ localhost の補助） */
  const startTargets = projects.projects.find((p) => p.id === workspace.projectId)?.urls
  const startChoices = useMemo(() => startUrlChoices({ targets: startTargets ?? [], history: urlHistory }), [startTargets, urlHistory])
  /**
   * フィードバックの画面の右のパネル（確認先・文字起こし・ターミナル）。オーケストラ前提で、どのプロジェクトでもエディタと同じく閉じておき、
   * 右下の小さなボタン（またはツールバーの開閉）で開く。フィードバックの対象を大きく見せる。開いた状態は覚えない
   */
  const [orchestraSideOpen, setOrchestraSideOpen] = useState(false)
  const targetsOpen = orchestraSideOpen
  const [targetsRatio, setTargetsRatio] = useState(() => Number(readLocal('ade.feedback.targetsRatio')) || 0.78)
  const setTargetsOpen = (next: (open: boolean) => boolean) => setOrchestraSideOpen(next)
  /*
   * 録画中の文字起こし（右パネルの「文字起こし」タブ）。パネルを閉じていても受け取る。
   * 止まった・声が文字にならない・マイクに音が来ないときは、パネルを見ていなくても1回だけ知らせ、右パネルの開閉ボタンに印を付ける
   */
  const live = useLiveTranscript()
  const [sideTab, setSideTab] = useState<FeedbackSideTab>(() => readFeedbackSideTab(readLocal('ade.feedback.sideTab')))
  /** ターミナルのタブを押したら、移した先で入力できるようにフォーカスを渡す（モードの切り替えだけでは渡さない。描き込みのキーを奪わないため） */
  const focusTerminalOnMove = useRef(false)
  const chooseSideTab = (tab: FeedbackSideTab) => {
    setSideTab(tab)
    writeLocal('ade.feedback.sideTab', tab)
    if (tab === 'terminal') focusTerminalOnMove.current = true
  }
  const shownSideTab = shownFeedbackSideTab(sideTab, showLiveTranscript)
  const liveProblem = liveTranscriptProblem(live.status)
  const liveToasted = useRef(new Set<string>())
  useEffect(() => {
    // 文字起こしが動いていない（モデル・キーが無い）ことは、録画の警告（recording:warning）がすでに知らせている
    if (!liveProblem || liveProblem === 'unavailable') return
    const key = `${live.status.run}:${liveProblem}`
    if (liveToasted.current.has(key)) return
    liveToasted.current.add(key)
    const message = liveProblem === 'error' ? t('liveTranscript.toast.error', { message: live.status.message ?? '' }) : t(`liveTranscript.warning.${liveProblem}`)
    toast({ tone: 'warning', message, duration: 0 })
    showNotice(message)
  }, [liveProblem, live.status.run, live.status.message, toast, showNotice, t])
  const liveAlert = liveProblem && !(targetsOpen && shownSideTab === 'transcript') ? t('liveTranscript.alert') : null
  const fileError = useCallback((message: string) => toast({ tone: 'danger', message }), [toast])
  const files = useOpenFiles({ root: workspace.folderPath, activeTab: centerTab, setActiveTab: setCenterTab, onError: fileError })
  // 発信（X への投稿の下書き）。フッター・エディタから開く
  const publishRequest = usePublishPanelRequest()
  // 外からエディタの領域へ落としたファイルを開く。プロジェクトの外はファイルツリーへの取り込みを案内し、フォルダはプロジェクトとして開く。
  // Markdown のエディタ（ソース・プレビュー）の上に落とした画像・動画は、開かずにその位置へ埋め込む（外のものは隣の assets/ などへコピー。markdownDrop.ts）
  const importMedia = useCallback((markdownRel: string, paths: string[]) => window.ade.invoke('fs:importMedia', markdownRel, paths), [])
  const editorDrop = useExternalDrop((dataTransfer, point) => {
    // 位置の判定は落とした瞬間に（読み取りを待つ間に画面が変わっても、落とした先のエディタへ入れる）
    const markdownTarget = markdownDropTargetAt(point)
    void readDrop(dataTransfer).then(async (entries) => {
      let rest = entries
      if (markdownTarget) {
        const media = planMediaDrop(entries)
        rest = media.rest
        await embedMedia(markdownTarget, media.media, point, importMedia)
        if (rest.length === 0 && entries.length > 0) return
      }
      const plan = planEditorDrop(rest)
      for (const path of plan.open) files.open(path)
      if (plan.outside) toast({ tone: 'info', message: t('drop.editor.outside', { name: plan.outside }) })
      else if (plan.unreadable) toast({ tone: 'warning', message: t('drop.errors.unreadable') })
      if (plan.folder) await window.ade.invoke('project:addDropped', plan.folder)
    }).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, true, (relPaths, point) => void (async () => {
    let rest = relPaths
    const markdownTarget = markdownDropTargetAt(point)
    if (markdownTarget) {
      const media = planTreeMediaDrop(relPaths)
      rest = media.rest
      await embedMedia(markdownTarget, media.media, point, importMedia)
    }
    // ファイルツリーの行: ファイルだけを開く（フォルダは fs:inspect が断る）
    for (const path of rest) {
      if (await window.ade.invoke('fs:inspect', path).then(() => true, () => false)) files.open(path)
    }
  })().catch((err) => toast({ tone: 'warning', message: errorMessage(err) })))
  // 内蔵ブラウザで見ているのがプロジェクトの HTML なら、ツールバーに「ソースを開く」を出す
  const browserFilePath = workspace.folderPath ? projectPathFromPageUrl(browserState.url) : null
  const htmlSourcePath = browserFilePath && isHtmlPath(browserFilePath) ? browserFilePath : null
  const markdownActive = centerTab.startsWith('file:') && !!files.activeFile && isMarkdownLanguage(files.activeFile.language) && files.activeFile.status === 'ready' && !files.activeFile.viewer
  // プロジェクトごとに、中央のタブ・開いていたファイル・表示中のレビューを覚えて戻す（URL は main が戻す）
  useProjectSession({
    projectId: workspace.projectId ?? null,
    root: workspace.folderPath,
    ready: projectsLoaded,
    centerTab,
    // 全体（すべてのプロダクト）はダッシュボードがトップ。前に開いていたブラウザ・指摘のタブで上書きしない
    setCenterTab: (tab) => setCenterTab(isOrchestra && (tab === 'browser' || tab === 'findings') ? 'dashboard' : tab as CenterTab),
    openPaths: files.files.map((file) => file.path),
    // 開いていたタブはそのまま戻す（HTML のソースのタブも、ブラウザで開き直さない）
    openFile: files.openSource,
    reviewId: sessionId,
    onRestoreReview: (id) => {
      setSessionId(id)
      setReview(null)
      // 消えたレビューは黙って空に戻す
      if (id) void window.ade.invoke('review:load', id).then(setReview).catch(() => setSessionId(null))
    }
  })
  /** 録画中に選んでいる書き込みの道具（PEN-1 / TXT-1）。中身は後続 */
  const [tool, setTool] = useState<AnnotationTool>('none')
  /** 書き込みの「元に戻す／やり直す」ができるか（注入スクリプトが知らせてくる） */
  const [annotationHistory, setAnnotationHistory] = useState({ canUndo: false, canRedo: false })
  const [annotationColor, setAnnotationColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR)
  /** 録画の対象（内蔵ブラウザ／画面全体／別のウインドウ）。選んですぐ録画を始めるため ref にも持つ */
  const [captureTarget, setCaptureTarget] = useState<CaptureTarget>({ kind: 'browser' })
  const captureTargetRef = useRef<CaptureTarget>({ kind: 'browser' })
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  /** フィードバックモードのタブの帯の URL 欄 */
  const feedbackUrlRef = useRef<HTMLInputElement | null>(null)
  const terminalCommand = useRef<{ add: () => void; close: () => void; reopen: () => void } | null>(null)

  /*
   * 空状態（NF-13）。フォルダ未選択、またはURL未入力のときはDOMで案内を出す。
   * 内蔵ブラウザのビューはDOMの上に必ず重なるので、出している間はビューを隠す。
   */
  const emptyReason: SlotEmptyReason | null =
    // 画面・ウインドウを録っている間と、ウインドウを選んでいる間は、その映像を内蔵ブラウザの場所に映す（main の syncMirror）。空の案内で隠さない
    (recording && captureTarget.kind !== 'browser') || captureTarget.kind === 'window'
      ? null
      : workspace.folderPath === null
      ? 'no-folder'
      : browserState.url === '' || browserState.url === DEFAULT_URL
        ? 'no-url'
        : browserState.loadError
          ? 'load-failed'
          : null

  // モーダル（フィードバック・画面の確認・送る前の確認など）を開いている間も隠す。ビューがダイアログの上に重なるため
  const anyModalOpen = useAnyModalOpen()
  /** ビューに場所を譲ってよい条件。ひとつでも欠けたら 0 サイズにして隠す */
  // 上のモード切替の「ビジネスリサーチ」（選んだときだけ中央をリサーチの画面にする。src/renderer/research/researchMode.tsx）
  const researchMode = useResearchMode(projects, workspace, mode)
  // リサーチの画面で開いたファイル。エディタへ移らずに、リサーチの画面の帯のタブで中身を出す
  const [researchFile, setResearchFile] = useState(false)
  const researchActiveRef = useRef(researchMode.active)
  researchActiveRef.current = researchMode.active
  useEffect(() => {
    if (!researchMode.active) setResearchFile(false)
  }, [researchMode.active])
  // クイックオープンなど、ファイルツリー以外から開いたときも、リサーチの画面のままその中身を出す（入ったときに前からあったタブは出さない）
  const lastCenterTab = useRef(centerTab)
  useEffect(() => {
    if (lastCenterTab.current === centerTab) return
    lastCenterTab.current = centerTab
    if (researchActiveRef.current && isFileTab(centerTab)) setResearchFile(true)
  }, [centerTab])
  /** 右のファイルツリーから開く。リサーチの画面では HTML もソースで開く（内蔵ブラウザはリサーチの画面では出ないため） */
  const openFromTree = useCallback((path: string) => {
    if (!researchActiveRef.current) return files.open(path)
    files.openSource(path)
    setResearchFile(true)
  }, [files])
  const viewVisible =
    !researchMode.active && !anyModalOpen && !gallery && !onboardingOpen && !targetPickerOpen && !addTrackOpen && !footerPopoverOpen && !splitDragging && !projectMenuOpen && !urlDialogOpen && !tabMenuOpen && !projectDialogOpen && !quickOpenOpen && !files.pendingClose && emptyReason === null && (mode === 'feedback' || (centerTab === 'browser' && !videoOpen))

  const layoutKey = [
    mode,
    splitRatio.toFixed(4),
    browserState.viewport,
    emptyReason ?? '-',
    centerTab,
    // パネルの置き場所・表示が変わると、内蔵ブラウザの置き場所も動く
    layoutSignature(layout),
    targetsOpen ? `t${targetsRatio.toFixed(4)}` : '-',
    // フィードバックモードのタブの帯は、内蔵ブラウザを録るときだけ出る（出ると置き場所が下がる）
    showsBrowserNav(captureTarget) ? 'tabs' : '-'
  ].join(':')
  const slotRef = useViewBounds(layoutKey, viewVisible)

  /*
   * ターミナルはエディタとフィードバックで1つだけ（同じ xterm・同じ PTY・同じタブ）。
   * TerminalPane は React の上ではずっと同じ場所（この器への portal）に描き、器の DOM だけをエディタの場所と
   * フィードバックの右パネルの間で移す。作り直さないので、Agent の画面・スクロールの履歴・入力中の文字がそのまま残る。
   * xterm の器は自分の大きさの変化を見て寸法を合わせ直す（terminalClient.ts の ResizeObserver）
   */
  const [terminalHost] = useState(() => {
    const host = document.createElement('div')
    // xterm の器（terminalClient.ts の .terminal-host・絶対配置）と同じ名前にしない。同じだと窓いっぱいに広がり、上のボタンを覆う
    host.className = TERMINAL_MOUNT_CLASS
    return host
  })
  const [editorTerminalSlot, setEditorTerminalSlot] = useState<HTMLDivElement | null>(null)
  const [feedbackTerminalSlot, setFeedbackTerminalSlot] = useState<HTMLDivElement | null>(null)
  const terminalPlace = terminalPlacement({ mode, targetsOpen, shownTab: shownSideTab })
  useLayoutEffect(() => {
    const slot = terminalPlace === 'feedback' ? feedbackTerminalSlot : editorTerminalSlot
    if (!slot) return
    if (terminalHost.parentElement !== slot) slot.appendChild(terminalHost)
    // 右パネルへ移さなかったら頼みは捨てる（あとでモードを切り替えたときに、描き込みのキーを奪わないよう）
    const wantFocus = terminalPlace === 'feedback' && focusTerminalOnMove.current
    focusTerminalOnMove.current = false
    if (!wantFocus) return
    // 移した直後は xterm が寸法を測り直している。2フレーム待ってから、見えているタブの選択中のペインへ
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const leaf = terminalHost.querySelector<HTMLElement>('.terminal-surface:not([hidden]) .terminal-leaf[data-active="true"]')
        const key = leaf?.dataset.pane
        if (key) getTerminal(key)?.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [terminalPlace, editorTerminalSlot, feedbackTerminalSlot, terminalHost])

  /** 連打（⌘⇧M）で古い値から切り替えないよう、最新のモードを同期して持つ */
  const modeRef = useRef<AppMode>('editor')
  const changeMode = useCallback((next: AppMode) => {
    modeRef.current = next
    setMode(next)
    void window.ade.invoke('mode:set', next)
  }, [])
  /** 上のモード切替の「動画」。エディタのモードで中央に動画の画面を出す（フィードバックへ移ったら閉じる） */
  const openVideo = useCallback(() => {
    if (modeRef.current !== 'editor') changeMode('editor')
    setVideoOpen(true)
  }, [changeMode])
  useEffect(() => { if (mode === 'feedback') setVideoOpen(false) }, [mode])


  /** 録音の設定を変える。設定ダイアログとフッターで同じ state を使う（二重管理しない） */
  const patchCapture = (patch: Partial<CaptureSettings>) => {
    if (patch.captureMic !== undefined) setCaptureMic(patch.captureMic)
    if (patch.micDeviceId !== undefined) setMicDeviceId(patch.micDeviceId)
    if (patch.captureSystemAudio !== undefined) setCaptureSystemAudio(patch.captureSystemAudio)
    if (patch.language !== undefined) setLanguage(patch.language)
    if (patch.transcription !== undefined) setTranscription(patch.transcription)
    if (patch.keepDays !== undefined) setKeepDays(patch.keepDays)
    if (patch.stayFeedbackOnStop !== undefined) setStayFeedbackOnStop(patch.stayFeedbackOnStop)
    if (patch.showLiveTranscript !== undefined) setShowLiveTranscript(patch.showLiveTranscript)
  }

  /** フッターからの変更は閉じる操作が無いので、その場で保存する */
  const changeCaptureFromFooter = (patch: Partial<FooterCapture>) => {
    patchCapture(patch)
    void window.ade.invoke('settings:capture', { captureMic, captureSystemAudio, transcription, language, micDeviceId, keepDays, stayFeedbackOnStop, ...patch })
  }

  /** 設定のページでの変更も、その場で保存する。接続先が揃ったかでフッターの選択肢が変わるので読み直す */
  const changeCaptureFromSettings = (patch: Partial<CaptureSettings>) => {
    patchCapture(patch)
    void window.ade.invoke('settings:capture', { captureMic, captureSystemAudio, transcription, language, micDeviceId, keepDays, stayFeedbackOnStop, ...patch })
      // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      .then(() => window.ade.invoke('capture:availability')).then(setAvailable).catch(() => undefined)
  }
  /** 空のコマンドは main 側で既定へ戻して保存する。入力中の表示はそのまま（読み直すと打っている文字が消える） */
  const changeAgents = (next: AgentPreferences) => {
    setAgents(next)
    void window.ade.invoke('settings:agents', next)
  }
  const changeAgentPrompt = (next: string) => {
    setAgentPrompt(next)
    void window.ade.invoke('settings:agentPrompt', next.trim())
  }

  /** 設定のページを開く。section を渡すとその節へ移る。フィードバックモードではエディタへ戻ってから開く */
  const openSettings = useCallback((section?: SettingsSectionId) => {
    if (modeRef.current === 'feedback') changeMode('editor')
    setSettingsOpen(true)
    setCenterTab('settings')
    if (section) setSettingsFocus((prev) => ({ section, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [changeMode])
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setCenterTab((tab) => (tab === 'settings' ? 'browser' : tab))
  }, [])
  // App の外の部品（初回の告知など）からも開けるように、window のイベントでも受ける
  //   window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'general' } }))
  useEffect(() => {
    const onOpen = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string } | undefined>).detail?.section
      openSettings(SETTINGS_SECTIONS.includes(section as SettingsSectionId) ? (section as SettingsSectionId) : undefined)
    }
    window.addEventListener('ade:open-settings', onOpen)
    return () => window.removeEventListener('ade:open-settings', onOpen)
  }, [openSettings])

  const openFolder = useCallback(() => {
    void window.ade.invoke('workspace:open').then(setWorkspace).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [toast])

  const navigate = useCallback((url: string) => {
    void window.ade.invoke('browser:navigate', url)
  }, [])

  /** いまのモードの URL 欄へ焦点を移して全体を選ぶ（⌘L・新しいタブ）。エディタではブラウザのタブを前に出してから */
  const focusUrlField = useCallback(() => {
    if (modeRef.current === 'feedback') {
      feedbackUrlRef.current?.focus()
      feedbackUrlRef.current?.select()
      return
    }
    setCenterTab('browser')
    requestAnimationFrame(() => {
      urlInputRef.current?.focus()
      urlInputRef.current?.select()
    })
  }, [])

  /**
   * ⌘T / ⌘W（メニューのターミナルのキー）を内蔵ブラウザのタブに使うか。ページに焦点があるときは main が受けるので、ここはアプリの画面の焦点。
   * ターミナル・エディタで打っているときはターミナルのまま。フィードバックモードは内蔵ブラウザを見ているときはタブ、
   * エディタはタブの帯・URL 欄（data-browser-chrome）に焦点があるときだけタブ
   */
  const browserOwnsTabKeys = useCallback((): boolean => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (focused?.closest('.xterm, .terminal-mount, .monaco-editor')) return false
    if (focused?.closest('[data-browser-chrome]')) return true
    return modeRef.current === 'feedback' && showsBrowserNav(captureTargetRef.current)
  }, [])

  const openBrowserTab = useCallback(() => {
    void window.ade.invoke('browser:newTab').then(focusUrlField).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [focusUrlField, toast])

  /** MODE-3 エディタで「録画」を押すとフィードバックモードへ移って始まる */
  const run = useCallback(async (fn: () => Promise<void>) => {
    try { await fn() } catch (err) {
      // IPC の失敗は main が送り済み（reportHandled が見分けて送らない）。renderer の処理の失敗だけが届く
      reportHandled(err, { area: 'ui', op: 'run action' })
      toast({ tone: 'danger', message: t('common.actionFailed'), detail: errorMessage(err) })
      if (modeRef.current === 'feedback') showNotice(errorMessage(err))
    }
  }, [toast, showNotice])

  const refreshHistory = useCallback(async () => {
    // 終了の途中は main が IPC に null で答える。一覧を null にすると Workspace が落ちるので、前の一覧のままにする
    const list = await window.ade.invoke('review:list')
    if (Array.isArray(list)) setHistory(list)
  }, [])
  /** mtg・共有リンクから取り込んだレビューの指摘（候補）を開く。人が確かめてから Agent へ送る */
  const openImported = useCallback((imported: ReviewData) => {
    setSessionId(imported.id)
    setReview(imported)
    setCenterTab('findings')
    void run(refreshHistory)
  }, [run, refreshHistory])
  useEffect(() => {
    const onOpen = (e: Event) => { const detail = (e as CustomEvent<ReviewData>).detail; if (detail?.id) openImported(detail) }
    window.addEventListener(OPEN_REVIEW_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_REVIEW_EVENT, onOpen)
  }, [openImported])
  /*
   * 文字で指摘（エディタの内蔵ブラウザ・映したウインドウで、枠を引いて指示を打つ。録画しない）。
   * 使えるのはエディタのブラウザのタブで、録画していないとき。足し先は開いているレビュー（無ければ最初の1件で新しく作る）。
   * 足しても画面はブラウザのまま（続けて何件も足せる）。Esc（ページ）かボタンでやめる
   */
  const [noteMode, setNoteMode] = useState(false)
  // エディタのブラウザのタブと、フィードバックモード（大きなページ）の両方で使える。右上の［文字で指摘］はエディタの別のタブからでも押せて、ブラウザのタブへ移ってから始める
  const noteAllowed = (mode === 'feedback' || (mode === 'editor' && centerTab === 'browser')) && !recording && !recordBusy && workspace.folderPath !== null && emptyReason === null
  const noteStartable = !recording && !recordBusy && workspace.folderPath !== null && emptyReason === null
  const openReviewForNote = review?.id ?? null
  const toggleNote = () => {
    const next = !noteMode
    if (next && mode === 'editor' && centerTab !== 'browser') setCenterTab('browser')
    // フィードバックモードの書き込みの道具とは同時に使わない（文字で指摘の枠と線が重なる）
    if (next && mode === 'feedback') setTool('none')
    void window.ade.invoke('note:setMode', next, openReviewForNote).then(setNoteMode).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  // 使えない場面（タブ・モードの切り替え・録画の開始）になったら切る
  useEffect(() => {
    if (!noteMode || noteAllowed) return
    setNoteMode(false)
    void window.ade.invoke('note:setMode', false).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }, [noteMode, noteAllowed])
  // 開いているレビューが変わったら足し先も変える
  useEffect(() => {
    if (!noteMode) return
    void window.ade.invoke('note:setMode', true, openReviewForNote).then(setNoteMode).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }, [openReviewForNote])
  // アプリの側に焦点があるときの Esc でもやめる（ページに焦点があるときは注入スクリプトが main へ知らせる）。文字を打つ欄・端末の Esc は奪わない
  useEffect(() => {
    if (!noteMode) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], .xterm')) return
      setNoteMode(false)
      void window.ade.invoke('note:setMode', false).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noteMode])
  useEffect(() => {
    const offs = [
      window.ade.on('note:mode', setNoteMode),
      window.ade.on('note:added', ({ review: next, count }) => {
        setReview(next); setSessionId(next.id)
        toast({ tone: 'success', message: t('textNote.added', { count }) })
        void refreshHistory().catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
      }),
      window.ade.on('note:error', (message) => toast({ tone: 'warning', message }))
    ]
    return () => offs.forEach((off) => off())
  }, [toast, t, refreshHistory])

  const toggleRecording = useCallback(() => {
    // Findings の「追加で録る」から来たときだけ、開いているレビューへ足す（1回限り）
    const appendTo = appendNext.current
    appendNext.current = null
    if (recordLock.current) return
    recordLock.current = true
    setRecordBusy(true)
    void run(async () => {
      if (recording) {
        // 保存に失敗しても、途中の記録は一覧に出す
        try {
          setRecordStatus(await window.ade.invoke('recording:stop'))
        } catch (err) {
          // フィードバック画面はビューが全面を覆い、知らせが見えない。エディタへ戻してから伝える
          changeMode('editor')
          // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
        await refreshHistory().catch(() => undefined)
          throw err
        }
        setTool('none')
        if (!stayFeedbackOnStop) changeMode('editor')
        setCenterTab('findings')
        await refreshHistory()
      } else {
        // 画面全体・別のウインドウを録るなら、内蔵ブラウザにページが無くてもよい（保存先のフォルダは要る）
        if (emptyReason && (emptyReason === 'no-folder' || captureTargetRef.current.kind === 'browser')) { toast({ tone: 'warning', message: emptyReason === 'load-failed' ? t('app.recordNoPage') : t('app.recordNoFolder') }); return }
        setCenterTab('browser')
        // 録画は書き込みなしで始まる。前回の停止が失敗して道具の表示が残っていても揃える
        setTool('none')
        changeMode('feedback')
        try {
          setRecordStatus(await window.ade.invoke('recording:start', { captureSystemAudio, captureMic, transcription, language, micDeviceId, captureTarget: captureTargetRef.current, ...(appendTo ? { appendTo } : {}) }))
        } catch (err) { changeMode('editor'); throw err }
      }
    }).finally(() => { recordLock.current = false; setRecordBusy(false) })
  }, [recording, emptyReason, changeMode, run, refreshHistory, toast, captureMic, transcription, captureSystemAudio, language, micDeviceId, stayFeedbackOnStop])

  /*
   * サイドバーのプロジェクトごとの「新しいレビュー」。どのプロジェクトで始めるかは planNewReview が決める。
   * 別のプロジェクトなら切り替えてから始める。切り替え直後の toggleRecording は前のプロジェクトの状態を
   * 閉じ込めているので、新しいワークスペースが描かれるのを待ってから、最新の toggleRecording（ref）を呼ぶ。
   */
  const toggleRecordingRef = useRef(toggleRecording)
  toggleRecordingRef.current = toggleRecording
  const workspaceProjectRef = useRef<string | null>(workspace.projectId ?? null)
  workspaceProjectRef.current = workspace.projectId ?? null
  const emptyReasonRef = useRef(emptyReason)
  emptyReasonRef.current = emptyReason
  /** 履歴からレビューを選んで開く（指摘のページの左の一覧） */
  const selectReview = (id: string) => {
    setSessionId(id)
    setCenterTab('findings')
    // 見本だけを除いて読む
    if (!(showDemo && !history.length && DEMO_SESSION_IDS.includes(id))) void run(async () => { setReview(await window.ade.invoke('review:load', id)); await refreshHistory() })
  }

  const startReviewIn = useCallback((projectId: string) => void run(async () => {
    const plan = planNewReview({ projectId, activeProjectId: workspaceProjectRef.current, projectIds: projects.projects.map((p) => p.id), recording })
    if (plan.action === 'busy') { toast({ tone: 'warning', message: t('sidebar.reviewBusy') }); return }
    if (plan.action === 'no-project') return
    if (plan.action === 'switch-then-start') {
      await window.ade.invoke('project:switch', plan.projectId)
      for (let i = 0; i < 40 && workspaceProjectRef.current !== plan.projectId; i++) await delay(50)
      await new Promise((done) => requestAnimationFrame(() => done(null)))
      // 確認先の URL があるプロダクトは、そのページが読み込まれるまで少し待つ（巡回で次のプロダクトへ移った直後）
      const hasTarget = projects.projects.find((p) => p.id === plan.projectId)?.urls.some((u) => !!u.url)
      // 画面の状態は少し遅れて届くので、main の内蔵ブラウザの実際の状態で、ページが読み込まれるまで待つ
      for (let i = 0; hasTarget && i < 50; i++) {
        const state = await window.ade.invoke('browser:state')
        if (state.url && state.url !== 'about:blank' && !state.loading) break
        await delay(100)
      }
      await new Promise((done) => requestAnimationFrame(() => done(null)))
    }
    // レビューするページがまだ無い（URL を入れていない）なら、警告は出さずにフィードバックの画面へ移るだけ。
    // URL はそこで入れてから録画を始める
    if (newReviewNeedsPage(emptyReasonRef.current, captureTargetRef.current.kind)) {
      setCenterTab('browser')
      changeMode('feedback')
      return
    }
    toggleRecordingRef.current()
  }), [run, projects.projects, recording, toast, t, changeMode])

  /**
   * 確認の巡回（オーケストラ）。全プロダクトの確認待ちを順に開き、「次へ」で進む（src/renderer/hooks/useProductRound.ts）
   */
  const openReviewIn = useCallback(async (projectId: string, reviewId: string) => {
    if (workspaceProjectRef.current !== projectId) {
      await window.ade.invoke('project:switch', projectId)
      for (let i = 0; i < 40 && workspaceProjectRef.current !== projectId; i++) await delay(50)
      await new Promise((done) => requestAnimationFrame(() => done(null)))
    }
    setSessionId(reviewId)
    setReview(await window.ade.invoke('review:load', reviewId))
    setCenterTab('findings')
    changeMode('editor')
  }, [changeMode])
  const productRound = useProductRound({
    projects: projects.projects,
    openReview: (projectId, reviewId) => run(() => openReviewIn(projectId, reviewId)),
    openOverview: () => {
      const editor = currentOrchestra(projects.projects, workspaceProjectRef.current)
      if (editor) void window.ade.invoke('project:switch', editor.id).catch(() => undefined)
    },
    notify: (tone, message) => toast({ tone, message }),
    messages: {
      confirmDone: () => t('round.confirmDone'),
      nothingToConfirm: () => t('round.nothingToConfirm')
    }
  })

  const recordingRef = useRef(recording)
  recordingRef.current = recording
  /** 全体の Agent が動いているか（右下のボタンの印） */
  const allActivity = useProjectActivity()
  const orchestraBusy = !!workspace.projectId && allActivity[workspace.projectId] === 'working'

  // ビジネスリサーチ・ビジネスのプロジェクトでは、その画面のタブを先頭に出して前に出す（src/renderer/business/ventureShell.tsx）
  const ventureTab = useVentureTab(projects, workspace, setCenterTab)
  // 全体へ切り替えたらダッシュボードを開く。全体から離れたらダッシュボードのタブは無いのでブラウザへ
  useEffect(() => {
    if (isOrchestra) setCenterTab((tab) => (tab === 'browser' || tab === 'findings' ? 'dashboard' : tab))
    else setCenterTab((tab) => (tab === 'dashboard' ? 'browser' : tab))
  }, [isOrchestra, workspace.projectId])

  /** フィードバックの画面でそのページを開く（録画中なら止めずに移る。1回のフィードバックで全部のプロダクトを確かめる） */
  const openForFeedback = useCallback((url: string) => {
    setCenterTab('browser')
    changeMode('feedback')
    void window.ade.invoke('browser:navigate', url).catch(() => undefined)
  }, [changeMode])
  /** 確認リストを順に開く（human.md）。1件目を開いて録画を始め、「次へ」で次のページへ。最後で録画を止める */
  const [checklistTour, setChecklistTour] = useState<{ urls: string[]; index: number } | null>(null)
  const startChecklistTour = useCallback((urls: string[]) => {
    if (!urls.length) return
    setChecklistTour({ urls, index: 0 })
    openForFeedback(urls[0]!)
    void run(async () => {
      for (let i = 0; i < 50; i++) {
        const state = await window.ade.invoke('browser:state')
        if (state.url && state.url !== 'about:blank' && !state.loading) break
        await delay(100)
      }
      if (!recordingRef.current) toggleRecordingRef.current()
    })
  }, [openForFeedback, run])
  const stopAfterStart = useRef(false)
  useEffect(() => {
    if (recordBusy || !stopAfterStart.current) return
    stopAfterStart.current = false
    if (recording) toggleRecordingRef.current()
  }, [recordBusy, recording])
  const tourRef = useRef(checklistTour)
  tourRef.current = checklistTour
  const moveTour = useCallback((delta: 1 | -1) => {
    // 録画の停止とページの移動は state の更新関数の外で行う（更新関数は2回呼ばれることがある）
    const tour = tourRef.current
    if (!tour) return
    const index = tour.index + delta
    if (index < 0) return
    if (index >= tour.urls.length) {
      // 最後のページのあと：録画を止める（止めると全体の Agent に渡せる指摘の一覧になる）。
      // 録画の開始がまだ終わっていなければ、終わってから止める
      setChecklistTour(null)
      if (recordLock.current) stopAfterStart.current = true
      else if (recordingRef.current) toggleRecordingRef.current()
      return
    }
    setChecklistTour({ ...tour, index })
    void window.ade.invoke('browser:navigate', tour.urls[index]!).catch(() => undefined)
  }, [])
  /** 全体のフィードバックの帯に出すページ：確認リスト（human.md）と、対象のプロジェクトの確認先 */
  const [dockChecklist, setDockChecklist] = useState<ChecklistItem[]>([])
  useEffect(() => {
    if (!isOrchestra || mode !== 'feedback') return
    let cancelled = false
    void window.ade.invoke('orchestra:checklist').then((items) => { if (!cancelled) setDockChecklist(items) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [isOrchestra, mode])
  const dockGroups = isOrchestra
    ? groupDockTargets(orchestraMembers(projects.projects, workspace.projectId ?? ''), pageItems(dockChecklist))
    : []
  const dockGroupsRef = useRef(dockGroups)
  dockGroupsRef.current = dockGroups
  /** 帯で開いているプロダクト（文字のフィードバックの宛先） */
  const dockProduct = (() => {
    const id = currentDockGroup(dockGroups, browserState.url)
    const group = dockGroups.find((g) => g.id === id)
    return group ? { name: group.label, url: browserState.url } : null
  })()
  const roundBar = productRound.round && <RoundBar round={productRound.round} projects={projects.projects}
    onNext={productRound.skip} onStop={productRound.stop} />

  /**
   * 全プロダクトを1回の録画でフィードバックする。全体（すべてのプロダクト）のフィードバックの画面を開き、
   * 最初のプロダクトのページで録画を始める。録画は止めずに帯のタブでプロダクトを切り替えると、その間の指摘はそのプロダクトのものになる
   * （送るときに main がプロダクトごとに分けて、それぞれの Agent へ並行して渡す。@shared/productSplit）
   */
  const recordAll = useCallback(() => void run(async () => {
    if (recordingRef.current) { setCenterTab('browser'); changeMode('feedback'); return }
    const editor = currentOrchestra(projects.projects, workspaceProjectRef.current)
    if (editor && workspaceProjectRef.current !== editor.id) {
      await window.ade.invoke('project:switch', editor.id)
      for (let i = 0; i < 40 && workspaceProjectRef.current !== editor.id; i++) await delay(50)
    }
    setCenterTab('browser')
    changeMode('feedback')
    const state = await window.ade.invoke('browser:state')
    const first = dockGroupsRef.current[0]?.items[0]?.url
    if ((!state.url || state.url === 'about:blank') && first) await window.ade.invoke('browser:navigate', first).catch(() => undefined)
    for (let i = 0; i < 50; i++) {
      const now = await window.ade.invoke('browser:state')
      if (now.url && now.url !== 'about:blank' && !now.loading) break
      await delay(100)
    }
    await new Promise((done) => requestAnimationFrame(() => done(null)))
    if (newReviewNeedsPage(emptyReasonRef.current, captureTargetRef.current.kind)) return
    if (!recordingRef.current) toggleRecordingRef.current()
  }), [run, projects.projects, changeMode])

  /** 録画の対象を選んで、次回のために覚える */
  const chooseTarget = (target: CaptureTarget) => {
    captureTargetRef.current = target
    setCaptureTarget(target)
    void window.ade.invoke('capture:setTarget', target).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  /**
   * 確認先のウインドウを録画の対象に選ぶ（デスクトップアプリ・シミュレータなど）。
   * 画面収録の許可が無いうちは一覧を取らず、対象の選択画面（許可の案内つき）を出す。
   * 起動コマンドを走らせた直後は、ウインドウが出るまで少し待って探し直す。
   */
  const selectWindowTarget = (windowMatch: string, launched: boolean) => void run(async () => {
    // 録画中は対象を変えず、同時に録る映像として足す（画面もそちらへ切り替わる）
    const adding = recording
    if ((await window.ade.invoke('capture:screenAccess')) !== 'granted') { if (adding) setAddTrackOpen(true); else setTargetPickerOpen(true); return }
    const attempts = launched ? 15 : 1
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await delay(1000)
      const found = matchWindowSource((await window.ade.invoke('capture:sources')).sources, windowMatch)
      if (found) {
        if (adding) await window.ade.invoke('recording:addTrack', targetFromSource(found))
        else chooseTarget(targetFromSource(found))
        toast({ tone: 'success', message: adding ? t('feedback.tracks.appeared', { label: found.name }) : t('projectTargets.windowSelected', { name: found.name }) })
        return
      }
    }
    toast({ tone: 'warning', message: t('projectTargets.windowNotFound', { match: windowMatch }) })
    if (adding) setAddTrackOpen(true)
    else setTargetPickerOpen(true)
  })

  /** 録画中に選んだウインドウ・画面・内蔵ブラウザを同時に録る映像として足す */
  const addTrack = (target: CaptureTarget) => void run(async () => {
    setAddTrackOpen(false)
    await window.ade.invoke('recording:addTrack', target)
  })

  const selectTool = (next: AnnotationTool) => void run(async () => {
    await window.ade.invoke('annotation:setMode', annotationModeForTool(next))
    setTool(next)
  })

  // 先に画面の色を変え、保存と注入先への反映は裏で行う
  const selectColor = (next: AnnotationColor) => {
    setAnnotationColor(next)
    void run(async () => { await window.ade.invoke('annotation:setColor', next) })
  }

  useEffect(() => {
    const offs = [
      window.ade.on('recording:level', (data) => { if (data.source === 'mic') setRecordingLevel(data.rms) }),
      // 250ms ごとに届くが、画面に出すのは状態と秒だけ。同じなら前のものを使い、画面全体を描き直さない
      window.ade.on('recording:status', (next) => setRecordStatus((cur) => (sameShownStatus(cur, next) ? cur : next))),
      window.ade.on('recording:tracksChanged', setTracks),
      // ウインドウを映している間に URL を開くと、main が内蔵ブラウザへ戻す
      window.ade.on('capture:targetChanged', (target) => { captureTargetRef.current = target; setCaptureTarget(target) }),
      window.ade.on('annotation:history', setAnnotationHistory),
      window.ade.on('recording:warning', (message) => { toast({ tone: 'warning', message, duration: 0 }); showNotice(message) }),
      window.ade.on('review:ready', (data) => {
        setReview(data); setSessionId(data.id); setCenterTab('findings'); setTool('none')
        if (!stayFeedbackOnStop) changeMode('editor')
        void refreshHistory()
      })
    ]
    void run(async () => { setAvailable(await window.ade.invoke('capture:availability')); setMicDevices(await window.ade.invoke('capture:devices')); await refreshHistory() })
    return () => offs.forEach((off) => off())
  }, [workspace.folderPath, run, refreshHistory, toast, stayFeedbackOnStop, changeMode, showNotice])

  /*
   * Agent が progress.json（指摘の進み具合）を書いたら、サイドバーの「完了数/対象数」と開いている Findings を読み直す。
   * 変更はプロジェクトの監視（files.ts の ProjectWatcher）で届く。開いているレビューは進み具合だけを差し替える（画像は読み直さない）
   */
  const openReviewId = review?.id ?? null
  useEffect(() => subscribeIpc('review:progressChanged', (ids) => {
    void refreshHistory().catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（次の更新で読み直す）
    if (!openReviewId || !ids.includes(openReviewId)) return
    void window.ade.invoke('review:progress', openReviewId).then((progress) => {
      setReview((current) => current && current.id === openReviewId ? { ...current, progress } : current)
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（画面は前の値のまま）
  }, 'review'), [openReviewId, refreshHistory])

  /*
   * 起動経路（NF-5）。設定・ワークスペース・ブラウザ状態を1度にまとめて取得し、
   * 最初の描画が終わった時点を「操作可能」として記録する。
   */
  const applyFeedbackTargets = (prefs: FeedbackTargetsPrefs) => {
    // 開閉は覚えない（右下のボタンで開く）。幅だけ戻す
    if (prefs.ratio) setTargetsRatio(prefs.ratio)
  }

  // settings.json の外部の変更（Claude Code などの書き換え）はその場で反映し、壊れたときは理由と行を知らせる（取り込まない）
  useEffect(() => {
    const offChanged = window.ade.on('settings:changed', (settings) => {
      setSplitRatio(settings.splitRatio)
      setAgents(sanitizeAgentPreferences(settings.agents))
      setAgentPrompt(settings.agentPrompt ?? '')
      if (settings.capture) {
        setCaptureMic(settings.capture.captureMic); setCaptureSystemAudio(settings.capture.captureSystemAudio)
        setTranscription(settings.capture.transcription); setLanguage(settings.capture.language); setMicDeviceId(settings.capture.micDeviceId ?? '')
        setKeepDays(settings.capture.keepDays); setStayFeedbackOnStop(settings.capture.stayFeedbackOnStop); setAnnotationColor(normalizeAnnotationColor(settings.capture.annotationColor))
        setShowLiveTranscript(settings.capture.showLiveTranscript !== false)
      }
      applyFeedbackTargets(settings.feedbackTargets ?? {})
      toast({ tone: 'info', message: t('settings.file.reloaded') })
    })
    const offError = window.ade.on('settingsFile:error', (error) => {
      if (error) toast({ tone: 'warning', message: `${t('settings.file.error')} ${error.line ? t('settings.file.errorAt', { line: String(error.line), message: error.message }) : error.message}` })
    })
    return () => { offChanged(); offError() }
  }, [toast, t])

  useEffect(() => {
    let cancelled = false
    initLayout()
    void Promise.all([
      window.ade.invoke('app:settings'),
      window.ade.invoke('workspace:current'),
      window.ade.invoke('browser:state')
    ]).then(([settings, ws, state]) => {
      if (cancelled) return
      setSplitRatio(settings.splitRatio)
      if (!projectsFromEventRef.current) setProjects({ projects: settings.projects, activeProjectId: settings.activeProjectId })
      // 古い形の設定（main が古いまま動いているときなど）でも描画が落ちないよう、ここでも整える
      setAgents(sanitizeAgentPreferences(settings.agents))
      setAgentPrompt(settings.agentPrompt ?? '')
      onboardingStoreRef.current?.reset(settings.onboarding ?? null)
      if (settings.capture) {
        setCaptureMic(settings.capture.captureMic); setCaptureSystemAudio(settings.capture.captureSystemAudio)
        setTranscription(settings.capture.transcription); setLanguage(settings.capture.language); setMicDeviceId(settings.capture.micDeviceId ?? '')
        setKeepDays(settings.capture.keepDays); setStayFeedbackOnStop(settings.capture.stayFeedbackOnStop); setAnnotationColor(normalizeAnnotationColor(settings.capture.annotationColor))
        setShowLiveTranscript(settings.capture.showLiveTranscript !== false)
        if (settings.capture.captureTarget) { captureTargetRef.current = settings.capture.captureTarget; setCaptureTarget(settings.capture.captureTarget) }
      }
      if (settings.feedbackTargets) applyFeedbackTargets(settings.feedbackTargets)
      else if (readLocal('ade.feedback.targetsOpen') !== null || readLocal('ade.feedback.targetsRatio') !== null) {
        // 以前 localStorage に置いていたフィードバックの右パネルの開閉・幅を、設定へ1度だけ移す
        void window.ade.invoke('settings:feedbackTargets', { visible: readLocal('ade.feedback.targetsOpen') !== 'false',
          ...(Number(readLocal('ade.feedback.targetsRatio')) ? { ratio: Number(readLocal('ade.feedback.targetsRatio')) } : {}) }).catch(() => undefined)
      }
      setWorkspace(ws)
      setProjectsLoaded(true)
      setBrowserState(state)
      requestAnimationFrame(() => {
        void window.ade.invoke('app:ready').then((timing) => {
          console.log(`[startup] 操作可能まで ${timing.totalMs}ms`, timing.marks)
        })
      })
    }).catch((err: unknown) => {
      // どれか1つが失敗しても（画面の読み込み直しの途中など）、プロジェクトとオーケストラの一覧だけは出す（issue #5）
      console.warn('[startup] 最初の読み込みに失敗しました', err)
      void window.ade.invoke('project:list').then((state) => {
        if (!cancelled && !projectsFromEventRef.current && state) setProjects(state)
      }).catch(() => undefined)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offBrowser = window.ade.on('browser:stateChanged', setBrowserState)
    // 内蔵ブラウザからの短い知らせ（タブの上限など）。フィードバックモードでは帯の案内の枠にも出る（Toast の置き先）
    const offBrowserNotice = window.ade.on('browser:notice', (message) => toast({ tone: 'warning', message }))
    // エージェントが browser-use で内蔵ブラウザを動かし始めた。エディタの画面なら中央を内蔵ブラウザにして、操作が見えるようにする
    // （ビジネスリサーチ・動画の画面のときは切り替えない。そのタブは隠れたまま、大きさだけ保つ）
    const offAgentBrowser = window.ade.on('browser:agentAttached', () => {
      if (modeRef.current === 'editor' && !researchActiveRef.current && !videoOpenRef.current) setCenterTab('browser')
    })
    const offWorkspace = window.ade.on('workspace:changed', setWorkspace)
    const offProjects = window.ade.on('projects:changed', (state) => {
      projectsFromEventRef.current = true
      setProjects(state)
    })
    const offMode = window.ade.on('mode:changed', (next) => { modeRef.current = next; setMode(next) })
    return () => {
      offBrowser()
      offBrowserNotice()
      offAgentBrowser()
      offWorkspace()
      offProjects()
      offMode()
    }
  }, [])

  /** ヘルプ → セットアップをもう一度・設定の「セットアップをもう一度」。録画中は全面を覆わない */
  const reopenOnboarding = useCallback((step?: OnboardingStepId) => {
    if (recording) { toast({ tone: 'warning', message: t('errors.stopRecordingBeforeChange') }); return }
    if (modeRef.current === 'feedback') changeMode('editor')
    // チェックリストの「設定する」からは、その手順から開く
    persistOnboarding(step ? { ...reopenPatch(), lastStep: step } : reopenPatch())
  }, [recording, toast, t, changeMode, persistOnboarding])
  // セットアップを閉じたら、チェックリスト（サイドバーの Setup n/7）に読み直してもらう
  useEffect(() => { if (onboarding !== undefined && !onboardingOpen) notifySetupChanged() }, [onboardingOpen])
  useEffect(() => onShowOnboardingRequested(reopenOnboarding), [reopenOnboarding])
  onboardingErrorRef.current = (err) => toast({ tone: 'warning', message: t('onboarding.saveFailed'), detail: errorMessage(err) })

  // メニュー（＝キーボードショートカット）からの指示
  useEffect(() => {
    return window.ade.on('menu:command', (command) => {
      switch (command) {
        case 'toggleRecording':
          toggleRecording()
          break
        case 'toggleMode':
          changeMode(modeRef.current === 'editor' ? 'feedback' : 'editor')
          break
        case 'toggleViewport':
          void window.ade.invoke(
            'browser:setViewport',
            browserState.viewport === 'desktop' ? 'mobile' : 'desktop'
          )
          break
        case 'focusUrl':
          focusUrlField()
          break
        case 'reloadPage':
          void window.ade.invoke('browser:reload')
          break
        case 'browserBack':
        case 'browserForward':
          // フィードバックモードのツールバーの戻る・進むと同じ。画面全体・ウインドウを録るときは内蔵ブラウザを動かさない
          if (modeRef.current === 'feedback' && showsBrowserNav(captureTargetRef.current)) {
            void window.ade.invoke(command === 'browserBack' ? 'browser:back' : 'browser:forward')
          }
          break
        case 'newTerminal':
          // 内蔵ブラウザを見ているときは新しいタブ（@shared/browserTabs）
          if (browserOwnsTabKeys()) openBrowserTab()
          else terminalCommand.current?.add()
          break
        case 'closeTerminal':
          if (browserOwnsTabKeys()) { if (browserState.activeTabId) void window.ade.invoke('browser:closeTab', browserState.activeTabId) }
          else terminalCommand.current?.close()
          break
        case 'reopenTerminal':
          // 最後に閉じたターミナルを開き直す（前の画面の文字と会話のまま）
          terminalCommand.current?.reopen()
          break
        case 'quickOpen':
          // フィードバック（録画）中はビューを隠さない
          if (workspace.folderPath && modeRef.current === 'editor') setQuickOpenOpen(true)
          break
        case 'saveFile':
          if (files.activeFile) void files.save(files.activeFile.id)
          break
        case 'toggleExplorer':
          togglePanelShown('files')
          break
        case 'toggleTargets':
          setTargetsOpen((open) => !open)
          break
        case 'toggleFooter':
          setLayout((prev) => ({ ...prev, footer: { ...prev.footer, visible: !prev.footer.visible } }))
          break
        case 'toggleSettings':
          // ⌘, 開いていて表示中なら閉じ、それ以外は開いて前に出す
          if (settingsOpen && centerTab === 'settings') closeSettings()
          else openSettings()
          break
        case 'showOnboarding':
          reopenOnboarding(undefined)
          break
        case 'toggleGallery':
          setGallery((open) => {
            window.location.hash = open ? '' : 'gallery'
            return !open
          })
          break
      }
    })
  }, [browserState.viewport, browserState.activeTabId, changeMode, toggleRecording, workspace.folderPath, files.activeFile, files.save, settingsOpen, centerTab, openSettings, closeSettings, reopenOnboarding, focusUrlField, browserOwnsTabKeys, openBrowserTab])

  // #gallery で直接開けるようにする（E2Eが撮影に使う）
  useEffect(() => {
    const sync = () => setGallery(galleryRequested())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => installTestHooks(), [])
  // クラッシュのタグ：どの画面を見ていたか（src/renderer/lib/telemetry.ts）
  useEffect(() => setUiTab(centerTab), [centerTab])

  const onTerminalReady = useCallback(() => {
    console.log('[startup] ターミナル利用可能')
  }, [])

  const commitSplit = useCallback((ratio: number) => {
    void window.ade.invoke('settings:splitRatio', ratio)
  }, [])

  const changeTerminalDock = useCallback((dock: Dock) => {
    setLayout((prev) => withPanel(prev, 'terminal', { dock }))
  }, [])

  /** Resource Manager の行から移る。別のプロジェクトなら先に切り替え、エディタへ戻す */
  const showInProject = useCallback(async (projectId: string | null) => {
    changeMode('editor')
    if (projectId && projectId !== workspace.projectId) {
      setWorkspace(await window.ade.invoke('project:switch', projectId))
      // ターミナルのタブが新しいプロジェクトに切り替わってから知らせる
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }, [changeMode, workspace.projectId])
  const openTerminalFromResources = useCallback((projectId: string | null, terminalId: string) => void run(async () => {
    await showInProject(projectId)
    window.dispatchEvent(new CustomEvent('ade:focus-terminal', { detail: { id: terminalId } }))
  }), [run, showInProject])
  const openPageFromResources = useCallback((projectId: string | null) => void run(async () => {
    await showInProject(projectId)
    setCenterTab('browser')
  }), [run, showInProject])
  /** アカウントの「管理…」。設定のページのアカウント節を開く */
  const manageAccounts = useCallback(() => openSettings('accounts'), [openSettings])

  // 録画していないときは 00:00。前回の録画の長さが残ると、フィードバック画面に来ただけで録画中に見える
  const shownElapsedMs = recording ? recordStatus.elapsedMs : 0
  const elapsed = `${Math.floor(shownElapsedMs / 60000).toString().padStart(2, '0')}:${Math.floor(shownElapsedMs / 1000 % 60).toString().padStart(2, '0')}`

  /*
   * 見本データは「部品見本」と「E2Eの撮影」でだけ出す（window.ade.demo）。
   * 通常起動では実データだけを出し、無ければ空状態にする。
   * 架空のレビューや指摘が製品の画面に出ないようにするため。
   * 次の工程では、この3つに実データを渡すだけでよい（型は各部品が正本）。
   */
  const showDemo = window.ade.demo && workspace.folderPath !== null
  const sessions = history.length ? history.map(toReviewSession) : showDemo ? demoSessions() : []
  const findings = showDemo ? demoFindings() : []
  const capture = showDemo ? demoCapture() : { ...EMPTY_CAPTURE, microphone: captureMic ? t('capture.summary.defaultMic') : t('capture.summary.noRecording'), transcription: transcription === 'openai' ? t('capture.summary.openai') : transcription === 'compatible' ? t('capture.summary.compatible') : transcription !== 'local' ? t('capture.summary.provider', { label: providerLabel(STT_PROVIDER_PRESETS[transcription], t) }) : available.localReady ? t('capture.summary.local') : t('capture.summary.localMissing') }
  const selectedSession = sessions.find((s) => s.id === sessionId)

  const wsGrid = workspaceGrid(layout)
  const splitGrid = mainSplitGrid(terminalDock, layout.panels.terminal.visible)
  const footer = layout.footer

  return (
    <div className="app" data-mode={mode}>
      {/*
       * 両方のモードをDOMに残し、表示だけを切り替える。
       * 片方を unmount すると、内蔵ブラウザの置き場所だけでなく
       * ターミナルのPTY（＝起動中のAgent）も失われるため。
       */}
      <div
        className={`shell shell--editor${footer.visible && footer.dock === 'top' ? ' shell--footer-top' : ''}`}
        hidden={mode !== 'editor'}
        style={{ gridTemplateRows: footer.visible
          ? footer.dock === 'top'
            ? 'var(--size-titlebar) var(--size-statusbar) minmax(0, 1fr)'
            : 'var(--size-titlebar) minmax(0, 1fr) var(--size-statusbar)'
          : 'var(--size-titlebar) minmax(0, 1fr)' }}
      >
        <TitleBar
          workspace={workspace}
          projects={projects}
          mode={mode}
          recording={recording}
          onChangeMode={(next) => { setVideoOpen(false); if (researchMode.active) researchMode.leave(next, changeMode); else changeMode(next) }}
          video={videoOpen && !researchMode.active}
          onOpenVideo={() => { if (researchMode.active) researchMode.leave(mode, changeMode); openVideo() }}
          research={{ active: researchMode.active, onEnter: () => { setVideoOpen(false); researchMode.enter(mode, changeMode) } }}
          onProjectMenuChange={setProjectMenuOpen}
          onToggleRecording={toggleRecording}
          onOpenSettings={() => openSettings()}
          onFocusBrowser={() => setCenterTab('browser')}
          busy={recordBusy}
          noteMode={noteMode}
          noteDisabled={!noteStartable}
          onToggleNote={toggleNote}
          round={mode === 'editor' && roundBar}
        />

        {/* 列と行は配置（layout）から作る。隠したパネルも大きさ 0 で残す（src/shared/layout.ts） */}
        <div
          className={`workspace${sidebarOpen ? '' : ' workspace--narrow'}${explorerOpen ? ' workspace--explorer' : ''}`}
          style={{ gridTemplateColumns: wsGrid.columns, gridTemplateRows: wsGrid.rows, gridTemplateAreas: wsGrid.areas }}
        >
          {/*
            * 折りたたみは「外す」のではなく、枠の幅を 0 にして隠す。
            * 外すと格子の列がずれて、本体が幅0の列に落ちてしまう。
            * 枠（.sidebar-slot）が切り取り、中身は240pxのまま滑り出る。
            */}
          <div className="sidebar-slot" aria-hidden={!sidebarOpen} style={{ gridArea: 'projects' }}>
            <ErrorBoundary name="left-sidebar">
            <Sidebar
              projects={projects}
              activeProjectId={workspace.projectId ?? null}
              onOverlayChange={setProjectDialogOpen}
            />
            </ErrorBoundary>
          </div>

          <div
            className={`main-split main-split--${terminalDock}${layout.panels.terminal.visible ? '' : ' main-split--focus'}`}
            style={{
              '--split-left': `${(splitRatio * 100).toFixed(3)}%`,
              gridArea: 'main',
              gridTemplateColumns: splitGrid.columns,
              gridTemplateRows: splitGrid.rows,
              gridTemplateAreas: splitGrid.areas
            } as React.CSSProperties}
          >
            <section className="pane pane--browser external-drop-host" aria-label={t('app.reviewTarget')} data-testid="center-pane" {...editorDrop.props}>
              {editorDrop.over && <ExternalDropOverlay label={t(markdownActive ? 'drop.editor.markdownHint' : 'drop.editor.hint')} testId="editor-file-drop" align="top" />}
              <ErrorBoundary name="center">
              {researchMode.active ? <ResearchModeView projects={projects} workspace={workspace} onOpenProject={researchMode.openProject} files={{
                tabs: files.files.map((f) => ({ id: f.id, name: f.name, path: f.path, dirty: f.dirty })),
                activeId: researchFile && isFileTab(centerTab) ? (files.activeFile?.id ?? null) : null,
                onSelect: (id) => { setCenterTab(fileTabId(id)); setResearchFile(true) },
                onClose: files.requestClose,
                onShowResearch: () => setResearchFile(false),
                view: files.activeFile && (
                  <ErrorBoundary name="editor"><Suspense fallback={<div className="editor-area" />}>
                    <FileEditor file={files.activeFile} editor={files} />
                  </Suspense></ErrorBoundary>
                )
              }} /> : videoOpen && workspace.folderPath ? (
                /* 上のモード切替の「動画」。選んでいる間は中央のタブの代わりに動画の画面を出す（src/video/app/renderer/） */
                <ErrorBoundary name="video"><Suspense fallback={<div className="editor-area" />}>
                  <VideoWorkspace folderPath={workspace.folderPath} projectName={workspace.folderName ?? ''} reviewRecording={recording || recordBusy}
                    isChannel={videoChannel} projectId={workspace.projectId ?? null} />
                </Suspense></ErrorBoundary>
              ) : (<>
              <CenterTabs
                active={centerTab}
                pageTitle={browserState.title}
                findingCount={review?.document.items.length ?? findings.length}
                onChange={setCenterTab}
                files={files.files}
                onCloseFile={files.requestClose}
                onCloseFiles={files.requestCloseMany}
                onMenuOpenChange={setTabMenuOpen}
                order={centerOrder}
                onReorder={setCenterOrder}
                settingsOpen={settingsOpen}
                onCloseSettings={closeSettings}
                dashboard={isOrchestra}
                venture={ventureTab}
              />
              {centerTab === 'dashboard' && isOrchestra ? (
                <ErrorBoundary name="orchestra"><Suspense fallback={<div className="editor-area" />}>
                  <VentureOrOrchestra projectId={workspace.projectId} projects={projects.projects} onOpenFile={files.open} onOpenProject={(id) => void window.ade.invoke('project:switch', id).catch(() => undefined)} orchestra={
                  <OrchestraDashboard
                    projects={projects.projects}
                    onOpenProject={(id) => void window.ade.invoke('project:switch', id).catch(() => undefined)}
                    onOpenUrl={openForFeedback}
                    onReviewChecklist={startChecklistTour}
                    onRecordAll={recordAll}
                    onStartRound={() => void run(() => productRound.start())}
                    onOpenFile={files.open}
                  />
                  } />
                </Suspense></ErrorBoundary>
              ) : centerTab === 'business' && ventureTab === 'business' ? (
                <VentureCenter projectId={workspace.projectId ?? null} />
              ) : centerTab === 'settings' && settingsOpen ? (
                <ErrorBoundary name="settings"><Suspense fallback={<div className="editor-area" />}>
                <SettingsPage
              value={{ captureMic, micDeviceId, captureSystemAudio, language, transcription, keepDays, stayFeedbackOnStop, showLiveTranscript }}
              onChange={changeCaptureFromSettings}
              recording={recording}
              micDevices={micDevices}
              available={available}
              onAvailabilityChange={() => /* 失敗は main の IPC が送る */ void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)}
              onPickModel={() => void run(async () => { await window.ade.invoke('capture:model'); setAvailable(await window.ade.invoke('capture:availability')) })}
              onModelChanged={() => /* 失敗は main の IPC が送る */ void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)}
              agents={agents}
              onAgentsChange={changeAgents}
              agentPrompt={agentPrompt}
              onAgentPromptChange={changeAgentPrompt}
                  focus={settingsFocus}
                />
                </Suspense></ErrorBoundary>
              ) : isFileTab(centerTab) ? (
                files.activeFile && (
                  <ErrorBoundary name="editor">
                  <Suspense fallback={<div className="editor-area" />}>
                    <FileEditor file={files.activeFile} editor={files} />
                  </Suspense>
                  </ErrorBoundary>
                )
              ) : centerTab === 'browser' ? (
                <ErrorBoundary name="browser">
                  <div className="browser-chrome" data-browser-chrome="">
                  <BrowserTabs state={browserState} onNewTab={focusUrlField} />
                  <BrowserToolbar
                    state={browserState}
                    urlInputRef={urlInputRef}
                    project={projects.projects.find((p) => p.id === workspace.projectId) ?? null}
                    onOverlayChange={setUrlDialogOpen}
                    onSelectWindow={selectWindowTarget}
                    shownTarget={captureTarget.kind === 'window' || (recording && captureTarget.kind !== 'browser') ? captureTarget : undefined}
                    onShowBrowser={recording ? undefined : () => chooseTarget({ kind: 'browser' })}
                    noteMode={noteMode}
                    noteDisabled={!noteAllowed}
                    onToggleNote={toggleNote}
                    onOpenSource={htmlSourcePath ? () => files.openSource(htmlSourcePath) : undefined}
                  />
                  </div>
                  <BrowserSlot
                    viewport={browserState.viewport}
                    slotRef={mode === 'editor' && viewVisible ? slotRef : noopRef}
                    empty={emptyReason}
                    loadError={browserState.loadError}
                    onOpenFolder={openFolder}
                    onNavigate={navigate}
                    choices={startChoices}
                  />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary name="findings">
                <ReviewHub
                  sessions={sessions}
                  selectedId={sessionId}
                  onSelect={selectReview}
                  onNewReview={() => { if (workspace.projectId) startReviewIn(workspace.projectId) }}
                  onImportMeeting={() => setMeetingOpen(true)}
                  recording={recording}
                  onHistoryChanged={(deleted) => {
                    // 開いているレビューを消したら、確認画面も閉じる
                    if (sessionId && deleted.includes(sessionId)) { setSessionId(null); setReview(null) }
                    void run(refreshHistory)
                  }}
                >
                {review ? <ReviewFindings terminalId={activeTerminal} review={review} recording={recording || recordBusy} onRecord={(mode) => { appendNext.current = mode === 'append' ? review.id : null; toggleRecording() }} onUpdate={(next) => { setReview(next); void refreshHistory() }} /> : <FindingsList findings={findings} sessionLabel={selectedSession?.label} />}
                </ReviewHub>
                </ErrorBoundary>
              )}
              </>)}
              </ErrorBoundary>
            </section>

            <Splitter
              ratio={splitRatio}
              onChange={setSplitRatio}
              onCommit={commitSplit}
              orientation={splitGrid.orientation}
              reverse={splitGrid.reverse}
              onDragChange={setSplitDragging}
            />

            {/* ターミナルの置き場所。中身（.terminal-mount）は下の portal で描き、フィードバックの右パネルへも移す */}
            <div className="terminal-slot" ref={setEditorTerminalSlot} />
          </div>

          {/* 右のファイルツリー。閉じたら列の幅を 0 にして隠す（.sidebar-slot と同じ） */}
          <div className="explorer-slot" aria-hidden={!explorerOpen} style={{ gridArea: 'files' }}>
            <ErrorBoundary name="file-tree">
            {/* SSH のプロジェクトは、ローカルにはレビューの置き場しか無いので、ファイルツリーの代わりに案内を出す */}
            {(() => { const remote = projects.projects.find((p) => p.id === workspace.projectId && p.source === 'ssh'); return remote ? <RemoteFilesNotice project={remote} /> : null })() ?? <FileExplorer
              root={workspace.folderPath}
              projectId={workspace.projectId ?? null}
              activePath={files.activeFile?.path ?? null}
              dirtyPaths={files.dirtyPaths}
              onOpen={openFromTree}
              onOpenSource={files.openSource}
              onQuickOpen={() => setQuickOpenOpen(true)}
              onRenamed={files.followRename}
              onDeleted={files.closeDeleted}
            />}
            </ErrorBoundary>
          </div>
        </div>

        {footer.visible && <ErrorBoundary name="footer"><StatusBar
          items={footer.items}

          state={browserState}
          capture={capture}
          recording={recording}
          elapsed={elapsed}
          settings={{ captureMic, micDeviceId, captureSystemAudio, transcription, language }}
          onCaptureChange={changeCaptureFromFooter}
          micDevices={micDevices}
          available={available}
          terminalDock={terminalDock}
          onTerminalDockChange={changeTerminalDock}
          onOpenSettings={() => openSettings()}
          onPopoverChange={setFooterPopoverOpen}
          onOpenTerminal={openTerminalFromResources}
          onOpenPage={openPageFromResources}
          onManageAccounts={manageAccounts}
        /></ErrorBoundary>}
      </div>
      {publishRequest && <ErrorBoundary name="publish"><PublishPanel request={publishRequest} /></ErrorBoundary>}

      {/* 全体では、ターミナルの欄を閉じて右下の小さなボタンにする（フィードバックの対象を大きく見せる。ChatGPT の画面のように） */}
      {mode === 'editor' && <button type="button" className={`orchestra-peek${orchestraBusy ? ' is-busy' : ''}`} onClick={() => setTerminalPeek((v) => !v)}
        aria-pressed={terminalPeek} title={t(terminalPeek ? 'orchestra.hideTerminal' : 'orchestra.showTerminal')} data-testid="orchestra-terminal-toggle">
        <span className="orchestra-peek__dot" aria-hidden="true" />{t(terminalPeek ? 'orchestra.hideTerminal' : 'orchestra.showTerminal')}
      </button>}
      {mode === 'feedback' && <div className="orchestra-peeks">
        <button type="button" className={`orchestra-peek orchestra-peek--inline${orchestraBusy ? ' is-busy' : ''}`} aria-pressed={orchestraSideOpen && shownSideTab === 'terminal'}
          onClick={() => { const open = !(orchestraSideOpen && shownSideTab === 'terminal'); if (open) chooseSideTab('terminal'); setOrchestraSideOpen(open) }} data-testid="orchestra-feedback-terminal">
          <span className="orchestra-peek__dot" aria-hidden="true" />{t('orchestra.showTerminal')}
        </button>
        <button type="button" className="orchestra-peek orchestra-peek--inline" aria-pressed={orchestraSideOpen && shownSideTab === 'targets'}
          onClick={() => { const open = !(orchestraSideOpen && shownSideTab === 'targets'); if (open) chooseSideTab('targets'); setOrchestraSideOpen(open) }} data-testid="orchestra-feedback-targets">
          {t('orchestra.showTargets')}
        </button>
      </div>}
      <div className={`shell shell--feedback${productRound.round || (isOrchestra && mode === 'feedback') ? ' shell--round' : ''}`} hidden={mode !== 'feedback'}>
        {/* 巡回の帯と、全体のフィードバックの帯（上の帯とブラウザの間の段に出す。ブラウザの枠は測り直される） */}
        {mode === 'feedback' && (roundBar || isOrchestra) && <div className="round-dock">
          {roundBar}
          {isOrchestra && <OrchestraDock groups={dockGroups} currentUrl={browserState.url} product={dockProduct} onOpen={(url) => void window.ade.invoke('browser:navigate', url).catch(() => undefined)}
            tour={checklistTour ? { index: checklistTour.index, total: checklistTour.urls.length } : null}
            onPrev={() => moveTour(-1)} onNext={() => moveTour(1)} onEndTour={() => setChecklistTour(null)} />}
        </div>}
        <FeedbackToolbar
          state={browserState}
          recording={recording}
          elapsed={elapsed}
          tool={tool}
          captureMic={captureMic}
          onToolChange={selectTool}
          color={annotationColor}
          onColorChange={selectColor}
          paused={recordStatus.state === 'paused'}
          busy={recordBusy}
          onPause={() => void run(async () => setRecordStatus(await window.ade.invoke(recordStatus.state === 'paused' ? 'recording:resume' : 'recording:pause')))}
          onClear={() => void run(async () => { await window.ade.invoke('annotation:clear') })}
          canUndo={annotationHistory.canUndo}
          canRedo={annotationHistory.canRedo}
          onUndo={() => void run(async () => { await window.ade.invoke('annotation:undo') })}
          onRedo={() => void run(async () => { await window.ade.invoke('annotation:redo') })}
          onToggleRecording={toggleRecording}
          noteMode={noteMode}
          noteDisabled={!noteAllowed}
          onToggleNote={toggleNote}
          onBackToEditor={() => changeMode('editor')}
          target={captureTarget}
          onPickTarget={() => setTargetPickerOpen(true)}
          tracks={tracks}
          onSwitchTrack={(id) => void run(async () => { await window.ade.invoke('recording:switchTrack', id) })}
          onAddTrack={() => setAddTrackOpen(true)}
          notice={notice}
          targetsOpen={targetsOpen}
          targetsAlert={liveAlert}
          onToggleTargets={() => {
            // 文字起こしに問題があるときは、開いたら文字起こしのタブを見せる
            if (liveAlert && showLiveTranscript) { chooseSideTab('transcript'); setTargetsOpen(() => true); return }
            setTargetsOpen((open) => !open)
          }}
          mic={{ settings: { captureMic, micDeviceId, captureSystemAudio, transcription, language }, onChange: changeCaptureFromFooter,
            devices: micDevices, available, onOpenSettings: () => openSettings(), onPopoverChange: setFooterPopoverOpen }}
        />
        {/* 内蔵ブラウザと、右のレビュー対象の一覧。対象を押すと録画したまま切り替わる */}
        <div className={`fb-body${targetsOpen ? ' has-targets' : ''}`} style={targetsOpen ? { gridTemplateColumns: `minmax(0, ${targetsRatio}fr) var(--size-splitter) minmax(0, ${1 - targetsRatio}fr)` } : undefined}>
          <ErrorBoundary name="feedback-browser">
          <div className="fb-browser">
          {/* 内蔵ブラウザのタブと URL 欄。メールのコードを別のタブで見て戻る、などをフィードバックモードのまま行う */}
          {showsBrowserNav(captureTarget) && (
            <div className="fb-tabbar" data-browser-chrome="" data-testid="feedback-tabbar">
              <BrowserTabs state={browserState} onNewTab={focusUrlField} testId="feedback-tabs" />
              <UrlField state={browserState} inputRef={feedbackUrlRef} testId="feedback-url-input" />
            </div>
          )}
          <BrowserSlot
            viewport={browserState.viewport}
            slotRef={mode === 'feedback' && viewVisible ? slotRef : noopRef}
            empty={emptyReason}
            loadError={browserState.loadError}
            onOpenFolder={openFolder}
            onNavigate={navigate}
            choices={startChoices}
          />
          </div>
          </ErrorBoundary>
          {targetsOpen && <>
            <Splitter
              ratio={targetsRatio}
              onChange={setTargetsRatio}
              onCommit={(ratio) => void window.ade.invoke('settings:feedbackTargets', { ratio }).catch(() => undefined)}
              onDragChange={setSplitDragging}
            />
            <ErrorBoundary name="review-targets">
            <ReviewTargetsPanel
              project={projects.projects.find((p) => p.id === workspace.projectId) ?? null}
              root={workspace.folderPath}
              currentUrl={browserState.url}
              history={urlHistory}
              onOpenUrl={navigate}
              onOpenEditor={(path) => { files.open(path); changeMode('editor') }}
              onSelectWindow={selectWindowTarget}
              hidden={shownSideTab !== 'targets'}
              head={<FeedbackSideTabs value={shownSideTab} onChange={chooseSideTab} alert={liveProblem !== null} showTranscript={showLiveTranscript} />}
            />
            </ErrorBoundary>
            {showLiveTranscript && <ErrorBoundary name="live-transcript">
            <LiveTranscriptPanel status={live.status} segments={live.segments} hidden={shownSideTab !== 'transcript'}
              head={<FeedbackSideTabs value={shownSideTab} onChange={chooseSideTab} alert={liveProblem !== null} showTranscript={showLiveTranscript} />} />
            </ErrorBoundary>}
            {/* エディタと同じターミナル（同じ Agent のタブ）。見ている間だけ、エディタの場所からここへ移す */}
            <aside className="fb-targets fb-terminal" aria-label={t('terminal.label')} data-testid="feedback-terminal" hidden={shownSideTab !== 'terminal'}>
              <header className="fb-targets__head">
                <FeedbackSideTabs value={shownSideTab} onChange={chooseSideTab} alert={liveProblem !== null} showTranscript={showLiveTranscript} />
              </header>
              <div className="fb-terminal__slot" ref={setFeedbackTerminalSlot} />
            </aside>
          </>}
        </div>
      </div>

      {createPortal(
        projectsLoaded && terminalsAllowed ? (
          <ErrorBoundary name="terminal" as="section" className="terminal-pane">
          <TerminalPane
            layoutKey={layoutKey}
            onReady={onTerminalReady}
            commandRef={terminalCommand}
            onActiveTerminal={setActiveTerminal}
            projectId={workspace.projectId ?? null}
            cwd={workspace.folderPath}
            startupAgents={agents.startupAgents}
            notify={agents.notify}
            restore={agents.restoreTerminals}
            onOpenFile={files.open}
            onOpenAgentSettings={() => openSettings('agents')}
          />
          </ErrorBoundary>
        ) : (
          <section className="terminal-pane" aria-label={t('app.terminal')} />
        ),
        terminalHost
      )}
      {quickOpenOpen && <QuickOpen onOpen={(path) => files.open(path)} onClose={() => setQuickOpenOpen(false)} />}
      {/* 取り込んだら、そのレビューの指摘（候補）を開く。人が確かめてから Agent へ送る */}
      {meetingOpen && <Suspense fallback={null}><MeetingImportDialog onClose={() => setMeetingOpen(false)} onImported={openImported} /></Suspense>}
      {files.pendingClose && <UnsavedChangesDialog name={files.pendingClose.name} onChoose={files.resolveClose} />}
      {addTrackOpen && recording && <CaptureTargetPicker
        value={{ kind: 'browser' }}
        initialKind="window"
        pageTitle={browserState.title || browserState.url}
        onChoose={addTrack}
        onStart={addTrack}
        onAdd={addTrack}
        onClose={() => setAddTrackOpen(false)}
      />}
      {targetPickerOpen && <CaptureTargetPicker
        value={captureTarget}
        pageTitle={browserState.title || browserState.url}
        onChoose={(target) => { chooseTarget(target); setTargetPickerOpen(false) }}
        onStart={(target) => { chooseTarget(target); setTargetPickerOpen(false); toggleRecording() }}
        onClose={() => setTargetPickerOpen(false)}
      />}
      {onboardingOpen && <Suspense fallback={null}><OnboardingFlow
        onboarding={onboarding ?? null}
        onPersist={persistOnboarding}
        agents={agents}
        onAgentsChange={changeAgents}
        projects={projects}
        voice={{
          transcription,
          language,
          available,
          onTranscriptionChange: (next) => changeCaptureFromSettings({ transcription: next }),
          onLanguageChange: (next) => changeCaptureFromSettings({ language: next }),
          onAvailabilityChange: () => void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined),
          onPickModel: () => void run(async () => { await window.ade.invoke('capture:model'); setAvailable(await window.ade.invoke('capture:availability')) }),
          onModelChanged: () => void window.ade.invoke('capture:availability').then(setAvailable).catch(() => undefined)
        }}
      /></Suspense>}
      {/* 部品見本。開発時だけ開く（表示メニュー → 部品見本、または #gallery）*/}
      {gallery && (
        <div className="app__gallery">
          <Suspense fallback={null}>
            <Gallery
              onClose={() => {
                window.location.hash = ''
                setGallery(false)
              }}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
