import { randomUUID } from 'node:crypto'
import { sanitizeGithubPreferences } from '@shared/repoCreate'
import { MAX_TEXT_FILE_SIZE } from '@shared/files'
import { UNSAVED_LIST_LIMIT, describeUnsavedFile, planUnsavedQuit, quitActionFor, sanitizeUnsavedRefs, screenQuitSaveEntries, type QuitAction, type QuitSaveOutcome, type UnsavedFileRef, type UnsavedQuitItem } from '@shared/quitUnsaved'
import { CAPTURE_INDICATOR, UserGestures, ViewInputGrant, appMediaAllowed, captureRequestProblem, indicatorTitle, isGestureInput, isRecorderContents, isTrustedIpcSender, nextAudioConsent, type CaptureConsentState } from './captureConsent'
import { programCopyText } from './terminalClipboard'
import { showAgentNotification } from './agentNotify'
import { failoverPrefs, initFailover, onUsageChanged, setFailoverPrefs, switchRunningAgents } from './failover/service'
import { agentMailEnv, agentMailTerminalCreated, initAgentMail, revokeAgentMailSession, stopAgentMail, syncAgentMailSkill } from './agentMail'
import { agentLabel, isAccountAgent } from '@shared/agentCatalog'
// 動画づくり（src/video/app/main/。入口はこの1つ）
import { createVideoIpcHandlers, startVideo, stopVideo, videoCaptureActive, videoTerminalEnv } from '@video/app/main/ipc'
import type { VideoMainContext } from '@video/app/main/context'
// ビジネス（venture: のチャネル。src/main/venture/。入口はこの1つ）
import { ventureForBusiness, ventureOpsHandlers, type VentureOpsWiring } from './venture/wire'
import { droppedFolder, inspectDropped } from './droppedPaths'
import { terminalOwnsMenuKey } from '@shared/terminalMenuKeys'
import { BROWSER_TAB_CLOSE_ACTIONS, browserTabsToClose } from '@shared/browserTabs'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { SessionPaths } from './sessions/paths'
import type { IncrementalTranscriber } from './pipeline/stt/engine'
import { loadDevDotEnv, type SttKeyStore } from './pipeline/stt/keys'
import { captureTargetLabel, resolveCaptureTarget, sanitizeCaptureTarget, targetSourceIds } from '@shared/captureTarget'
import { mirrorSourceParam } from '@shared/captureComposite'
import { AGENT_SKILL_AGENTS, type AgentSkillAgent, type SkillContext } from '@shared/agentSkill'
import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, safeStorage, shell, protocol, session } from 'electron'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { IpcEventChannel, IpcEvents, IpcRequests } from '@shared/ipc'
import type { AiVendor, LlmApiProvider, SttRemoteProvider } from '@shared/aiProviders'
import {
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_URL,
  type AnnotationMode,
  type AppMode,
  type BrowserState,
  type CaptureTarget,
  type Project,
  type ProjectUpdate,
  type ProjectSession,
  type ProjectsState,
  type RecordingStatus,
  type Settings,
  type SttKeySource,
  type SttProvider,
  type WorkspaceState
} from '@shared/types'
import { isRecordableUrl, recordableTabs, sessionTabs, withProjectSession } from '@shared/projectSession'
import { THEME_BACKGROUND } from '@shared/theme'
import { normalizeAnnotationColor } from '@shared/annotation'
import { extensionPopupGetsReviewPreload, shouldCloseExtensionPopup, type AnnotationActivity, type PopupDismissCause } from '@shared/popupAnnotation'
import { findProjectByFolder, markProjectOpened, newProject, reorderProjects, upsertProjectFolder } from './projects'
import { currentOrchestra, moveInTree, orchestraList, orchestraMembers, removeOrchestra } from '@shared/orchestras'
import { checkSshTarget, remoteWorkspaceDirName, sshDefaultName, type SshTarget } from '@shared/sshCommand'
import { EmbeddedBrowser, browserSession, browserSessions, onBrowserSessionReady, type ProjectTabs, type TabsSnapshot } from './browser'
import { browserPartition, sanitizeBrowserProfile } from '@shared/browserProfile'
import { BrowserExtensions } from './browserExtensions'
import { browserImportHandlers } from './browserImport/ipc'
import { feedbackShareHandlers } from './feedbackShare/ipc'
import { publishHandlers } from './publish/ipc'
import { PublishStore } from './publish/store'
import { PublishBackground } from './publish/background'
import { PublishConnections } from './publish/connections'
import { chooseKeyCipher } from './pipeline/stt/keys'
import { waitForCallback } from './publish/xAuthServer'
import { MAX_BROWSER_EXTENSIONS, relativeRect, sanitizeBrowserExtensions, type BrowserExtensionEntry, type BrowserExtensionInfo } from '@shared/browserExtensions'
import { APP_ALLOWED_PERMISSIONS, installPermissionPolicy, isAllowedExternalUrl, isAppPageUrl, isBrowserPageExternalUrl, isSnapshotableBrowserUrl, type PermissionSessionLike } from './webPolicy'
import { pathToFileURL } from 'node:url'
import type { PcmBlock, RecordingController } from './recording'
import { installMenu } from './menu'
import { allowCrashReload } from './crashReload'
import { applyLocalePreference } from './locale'
import { PRODUCT_NAME, getLocale, t } from '@shared/i18n'
import { UserFacingError, isStaleChunkError, toUserFacingFileError } from '@shared/errors'
import { IS_PACKAGED } from './runtime'
import { configDir, currentSettings, flushSettingsSync, loadSettings, readSettingsText, settingsFileInfo, updateSettings, watchSettings, writeSettingsText } from './settings'
import { envGetter, keepKeyRefs, redactKeys, resolveApiKey, resolveConfiguredKey, resolveEndpointRefs, type KeyRef } from './settingsKeys'
import { elapsedMs, mark, markAt, markOnce, noteLaunchedVersion, reportInteractive, setStartupTags } from './startup'
import { emulationKind } from './emulation'
import { TerminalManager, prereadNodePtyBinaries } from './terminal'
import { listAgentOptions, warmLoginShellPath } from './agentDetection'
import { listCliTools } from './cliTools'
import {
  addAgentAccount,
  listAgentAccounts,
  reloginAgentAccount,
  removeAgentAccount,
  renameAgentAccount,
  requireTuiAgent,
  resolveAgentEnv,
  selectAgentAccount
} from './accounts'
import { attachUsageWindow, getAccountUsage, getUsageState, refreshUsage } from './usage/service'
import { listAgentResources } from './agentResources'
import { appVersion, checkForUpdate, isSuspendedNetworkError, usingE2eReleaseServer, verifiedDownload, verifiedFileOfKind } from './updateCheck'
import { AutoUpdater } from './autoUpdate'
import { installMethodFor } from '@shared/appUpdate'
import { sanitizeLayout } from '@shared/layout'
import { ResourceCollector } from './resources'
import { ProjectWatcher, listDirectory, listFiles, readTextFile, resolveInside, searchFiles, writeTextFile } from './files'
import { copyEntries, createEntry, importEntries, importMediaForMarkdown, moveEntries, pathsForClipboard, renameEntry, terminalDirFor, trashEntries, trashFor } from './fileOps'
import { inspectProjectFile, projectMediaResponse, readOfficeFile } from './projectMedia'
import { isRiskyToOpenExternally } from '@shared/fileViewer'
import { refreshPreviewIn, registerPreviewProtocol, renderPreviewSource } from './preview'
import { PREVIEW_SCHEME, stripPreviewGrant } from '@shared/preview'
import { PROJECT_PAGE_SCHEME } from '@shared/htmlPreview'
import { crashReportsActive, initCrashReporting, maybeSendTestEvent, reportMainError, sentryTestKinds, setTelemetryContext, noteQuitRequested, telemetryInstallId, trackIpc } from './telemetry'
import { wrapIpcHandler } from '@shared/telemetry'
import { errorKind, flow, reportHandled } from '@shared/report'
import { isValidPort } from '@shared/mobileRemote'
import { delay } from '@shared/delay'
import { TerminalRestoreStore } from './terminalRestore'
import { syntheticSystemAudio, systemAudioFeatures } from '@shared/systemAudio'
import { ventureHandlers, ventureWatcher } from './business/wire'
import businessManual from '../../resources/business/手法.md?raw'
import researchKnowledge from '../../docs/business-research/knowledge.md?raw'
import researchKnowledgeEn from '../../docs/business-research/knowledge.en.md?raw'

/*
 * クラッシュの受け口（Crashpad / Sentry）は、OSの既定のクラッシュ処理より前に入れたいので、他の初期化より先に呼ぶ。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'ade-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  // markdown / Mermaid のプレビュー（src/main/preview）。page.js が fetch で中身を取り直す
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // 内蔵ブラウザで開くプロジェクトの HTML（src/main/projectPage.ts。外へ通信させない CSP 付き。security-7 [2][6]）
  { scheme: PROJECT_PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
/*
 * userData は製品名（Ferret）ではなく、これまでと同じ「ade-movie」フォルダに固定する。
 * 名前で決まるままにすると、改名で既存の設定・プロジェクト・保存したキーが見えなくなる。
 * E2E などが --user-data-dir を渡したときはそちらに従う。Crashpad も userData に書くので、その前に決める。
 */
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'ade-movie'))
/*
 * macOS の開発起動では、本物のキーチェーンを使わない（Chromium の --use-mock-keychain）。
 * 開発版の Electron.app は名前を変えて ad-hoc で署名し直している（scripts/prepare-dev-electron.mjs）ので、
 * Chromium が起動時に Cookie の暗号化の鍵（ade-movie Safe Storage）を読むたびに、パスワードの確認が出てしまう。
 * 開発版の Cookie と safeStorage は固定の鍵になる（初回だけ、開発版の内蔵ブラウザのログインが切れる）。
 * 配布版は影響なし。本物のキーチェーンで試したいときは ADE_DEV_REAL_KEYCHAIN=1 を付けて起動する。
 */
if (!IS_PACKAGED && process.platform === 'darwin' && process.env.ADE_DEV_REAL_KEYCHAIN !== '1') {
  app.commandLine.appendSwitch('use-mock-keychain')
}
/*
 * 相手の声（PC の音声）をループバックで取れるようにする。macOS 14.2+ は Core Audio の tap、Linux は PulseAudio のモニター。
 * Windows は既定で取れる。許可を求めるのは録画で相手の声を録り始めたときだけ（src/shared/systemAudio.ts）
 */
if (systemAudioFeatures(process.platform).length) app.commandLine.appendSwitch('enable-features', systemAudioFeatures(process.platform).join(','))
// 内蔵ブラウザの Google ログインが FedCM の画面で止まらないよう、従来のポップアップに戻す（Orca #12854。Orca と同じ）
app.commandLine.appendSwitch('disable-features', 'FedCm')
/*
 * 表示名は Ferret だが、app.setName() は呼ばない。app.name（package.json の name = ade-movie）は
 * macOS のキーチェーンの「ade-movie Safe Storage」の名前にもなっていて、変えると保存済みのキーや
 * 内蔵ブラウザの Cookie を復号できなくなる。メニュー・Dock・⌘Tab の名前は .app の CFBundleName
 * （配布版は electron-builder の productName、開発版は scripts/prepare-dev-electron.mjs）から出る。
 * Windows / Linux の「について」の表示だけ、起動後に製品名にする（whenReady の直後）。
 */
// 配布版で設定が ON なら Sentry へ送る。それ以外は Crashpad でローカルに受けるだけ（src/main/telemetry.ts）
initCrashReporting()

// 開発用の .env は dev 起動のときだけ読む。配布版は読まない（pipeline/stt/keys.ts）
loadDevDotEnv(IS_PACKAGED)
mark('main:loaded')

/**
 * メインプロセスのエントリ。
 *
 * 起動時間（NF-5）のため、ここで読み込むのはウィンドウ・内蔵ブラウザ・設定・メニューだけ。
 * 録画（src/main/recording）、分解（src/main/pipeline）、セッション保存（src/main/sessions）は
 * 後続の実装で追加し、必要になった時点で動的 import する。
 */

let mainWindow: BrowserWindow | null = null
/** 画面のターミナルにフォーカスがあるか（renderer が terminal:focused で知らせる） */
let terminalFocused = false
/** terminal:paste（Windows / Linux の Ctrl+V）で OS の貼り付けをさせた時刻。続く terminal:pasteFiles を1回だけ許す */
let terminalPasteGrantAt = 0
/**
 * 録画・撮影・端末のプログラムのコピーの同意（security-5 [1][9]。captureConsent.ts）。
 * 窓に届いた本物の入力とメニューの操作からだけ作り、renderer の求めは同意にしない
 */
const gestures = new UserGestures()
/**
 * 文字で指摘の静止画の許可。内蔵ブラウザ・映したウインドウのビューに届いた本物の入力（Enter・クリック）から、そのビューだけに1回（captureConsent.ts）。
 * アプリの窓の同意（gestures）とは別に持つ（ページの中の操作で、窓の撮影・録画の同意を作らない）
 */
const noteInputs = new ViewInputGrant<Electron.WebContents>()
/** 文字で指摘（エディタで枠を引いて指示を打つ。src/main/textNotes.ts）。最初に入れたときに用意する */
let textNotes: import('./textNotes').TextNotes | null = null
/** 利用者が選んだ録る対象と音。起動時の設定から始め、操作の直後の変更でだけ広げる */
let captureConsent: CaptureConsentState = { target: { kind: 'browser' }, mic: true, systemAudio: false }
/** 録画中か（main が出す印。窓の題名と macOS の Dock） */
let capturing = false
let browser: EmbeddedBrowser | null = null
/** 内蔵ブラウザのタブの変化を待つもの（browser-use の中継。browserAutomation.ts） */
const browserTabListeners = new Set<() => void>()
/** 内蔵ブラウザを browser-use で動かす口（ターミナルに BU_CDP_URL を渡す） */
let browserAutomationService: import('./browserAutomation').BrowserAutomation | null = null
async function browserAutomation(): Promise<import('./browserAutomation').BrowserAutomation> {
  if (!browserAutomationService) {
    const { BrowserAutomation } = await import('./browserAutomation')
    browserAutomationService = new BrowserAutomation({
      configFile: join(app.getPath('userData'), 'browser-cdp.json'),
      toolDir: join(app.getPath('userData'), 'browser-use'),
      tabs: () => browser?.automationTabs() ?? [],
      createTab: async (url) => {
        if (!browser) throw new UserFacingError(t('browser.errors.invalidUrl'))
        return browser.newTab(url)
      },
      closeTab: (id) => browser?.closeTab(id),
      activateTab: (id) => browser?.activateTab(id),
      hold: (id, held) => browser?.holdForAutomation(id, held),
      capture: async (id, params) => {
        if (!browser) throw new Error('No target with given id found')
        return browser.captureTab(id, params)
      },
      onTabsChanged: (listener) => {
        browserTabListeners.add(listener)
        return () => browserTabListeners.delete(listener)
      },
      session: () => browser?.activeSession() ?? browserSession(),
      notice: (message) => send('browser:notice', message),
      attachedMessage: () => t('browser.automation.attached'),
      reveal: () => send('browser:agentAttached'),
      // browser-use の Agent（API）の中継が付けるキー。送り先は中継の表の決まった接続先だけで、保存したキーと同じ門（gateCredentials）を通す
      llmKey: async (id) => {
        const { LLM_PROVIDER_PRESETS } = await import('@shared/aiProviders')
        const { RELAY_PROVIDERS } = await import('./browserLlmRelay')
        const preset = (LLM_PROVIDER_PRESETS as Record<string, { vendor: import('@shared/aiProviders').AiVendor; envVar?: string }>)[id]
        const relay = RELAY_PROVIDERS.find((p) => p.id === id)
        if (!preset || !relay) return undefined
        const ref = preset.envVar ? { apiKeyEnv: preset.envVar } : undefined
        try {
          await gateCredentials(`browser-use:${id}`, relay.baseUrl, ref, preset.vendor, [relay.baseUrl], false)
        } catch {
          return undefined
        }
        return providerKey(ref, preset.vendor)
      }
    })
  }
  return browserAutomationService
}
/** 内蔵ブラウザの拡張機能（内蔵ブラウザの session にだけ読み込む。browserExtensions.ts） */
let extensions: BrowserExtensions | null = null
/** 直前に探した取り込みの候補（key → 写す元）。画面からはパスを受け取らず、この key だけを受ける */
let installedExtensions = new Map<string, { id: string; dir: string }>()
let terminals: TerminalManager | null = null
/** この起動がその版の初めての起動か（入れた・更新した直後。startup.ts の noteLaunchedVersion） */
let launchedNewVersion = false
/** node-pty のファイルを先に読み始めたか（1度だけ） */
let prereadStarted = false
/** スマホから操作（src/main/mobileRemote.ts）。入れたときに初めて読み込む */
let mobileRemote: import('./mobileRemote').MobileRemoteService | null = null
/** Resource Manager の集計。ターミナル・ブラウザ・プロジェクトは読むだけ */
const resources = new ResourceCollector({
  terminals: () => terminals?.list() ?? [],
  projects: () => currentSettings().projects,
  activeProjectId: () => workspace.projectId ?? null,
  page: () => {
    const wc = browser?.contents
    if (!wc || wc.isDestroyed()) return null
    return { pid: wc.getOSProcessId(), title: wc.getTitle(), url: wc.getURL() }
  }
})
let mode: AppMode = 'editor'
let workspace: WorkspaceState = { folderPath: null, folderName: null }
/**
 * 終了処理に入ったか。
 * PTYの出力やブラウザの状態変化は非同期に届くため、ウィンドウを閉じ始めた後に
 * 破棄済みのオブジェクトを触らないよう、ここで入口をふさぐ。
 */
let shuttingDown = false
/** エディタで未保存のファイル（renderer が editor:unsaved で知らせる。別のプロジェクトのタブも含む） */
let unsavedFiles: UnsavedFileRef[] = []
/** 「保存せずに終了」を選んだ／「保存して終了」で全部書けた。before-quit とウィンドウの close の両方で聞き直さない */
let discardUnsavedConfirmed = false
/** 未保存の確認を出している間（2つ目の終了の入口では出し直さない） */
let unsavedPromptOpen = false
/** 「保存して終了」で renderer に中身を頼んでいる最中のもの。requestId が合う返事だけを受ける */
let pendingQuitSave: { id: string; expected: UnsavedFileRef[]; resolve: (outcomes: QuitSaveOutcome[] | null) => void } | null = null
/** 「保存して終了」で renderer の返事を待つ上限 */
const QUIT_SAVE_REPLY_MS = 15_000
/** 「保存して終了」で書く1ファイルと全体の上限（エディタで開けるのは MAX_TEXT_FILE_SIZE まで。編集で少し増えても書ける幅） */
const QUIT_SAVE_MAX_BYTES = MAX_TEXT_FILE_SIZE * 4
const QUIT_SAVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024

async function showQuitMessageBox(options: Electron.MessageBoxOptions): Promise<number> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return response
}

/**
 * 未保存のファイルがあれば、終了してよいかを聞く（ネイティブのダイアログ。内蔵ブラウザに隠れない）。
 * Orca由来: ~/bench/orca/src/renderer/src/components/use-terminal-editor-close-foundation.ts（MIT）の
 * 「ウィンドウを閉じる前に未保存を確かめる」。
 * 各ファイルはプロジェクト名とその中の相対パスで示し（プロジェクトが複数あると絶対パスだけでは分からない）、
 * 「保存して終了」（既定）・「保存せずに終了」・「プロジェクトを開く」・「キャンセル」（Esc）を選べる（src/shared/quitUnsaved.ts）。
 * @returns 終了してよいなら true
 */
async function resolveUnsavedBeforeQuit(): Promise<boolean> {
  if (unsavedFiles.length === 0 || discardUnsavedConfirmed || IS_E2E) return true
  const snapshot = unsavedFiles
  const plan = planUnsavedQuit(snapshot, currentSettings().projects)
  const labels: Record<QuitAction, string> = {
    save: t('dialog.unsaved.saveAndQuit'),
    discard: t('dialog.unsaved.quitWithoutSaving'),
    openProject: t('dialog.unsaved.openProject', { name: plan.openTarget?.projectName ?? '' }),
    cancel: t('common.cancel')
  }
  const lines = plan.listed.map((item) => item.label)
  if (plan.more > 0) lines.push(t('dialog.unsaved.more', { count: plan.more }))
  const response = await showQuitMessageBox({
    type: 'warning',
    buttons: plan.actions.map((action) => labels[action]),
    defaultId: plan.defaultId,
    cancelId: plan.cancelId,
    noLink: true,
    message: t('dialog.unsaved.message', { count: plan.items.length }),
    detail: `${lines.join('\n')}\n\n${t('dialog.unsaved.detail')}`
  })
  const action = quitActionFor(response, plan.actions)
  if (action === 'cancel') return false
  if (action === 'discard') {
    discardUnsavedConfirmed = true
    return true
  }
  if (action === 'openProject') {
    if (plan.openTarget) revealUnsavedFile(plan.openTarget)
    return false
  }
  const failures = await saveUnsavedForQuit(snapshot)
  if (failures.length === 0) {
    discardUnsavedConfirmed = true
    return true
  }
  // 1つでも書けなければ終了しない（内容を失わない）。どれがなぜ書けなかったかを示す
  const failed = failures.map((f) => `${describeUnsavedFile(f, currentSettings().projects).label}: ${f.error ?? ''}`)
  await showQuitMessageBox({
    type: 'error',
    buttons: [t('common.close')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: t('dialog.unsaved.saveFailed', { count: failures.length }),
    detail: `${failed.slice(0, UNSAVED_LIST_LIMIT).join('\n')}${failed.length > UNSAVED_LIST_LIMIT ? `\n${t('dialog.unsaved.more', { count: failed.length - UNSAVED_LIST_LIMIT })}` : ''}\n\n${t('dialog.unsaved.saveFailedDetail')}`
  })
  return false
}

/**
 * 「保存して終了」。未保存の内容は renderer が持っているので、editor:saveForQuit で頼み、editor:quitSave の返事で書く。
 * 書けなかったファイル（返事が来ない・上限を超えた・書き込みの失敗）を返す。空なら全部書けた。
 */
async function saveUnsavedForQuit(expected: UnsavedFileRef[]): Promise<QuitSaveOutcome[]> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return expected.map((file) => ({ ...file, ok: false, error: t('dialog.unsaved.noReply') }))
  }
  pendingQuitSave?.resolve(null)
  const id = randomUUID()
  const outcomes = await new Promise<QuitSaveOutcome[] | null>((resolve) => {
    const timer = setTimeout(() => { if (pendingQuitSave?.id === id) { pendingQuitSave = null; resolve(null) } }, QUIT_SAVE_REPLY_MS)
    pendingQuitSave = { id, expected, resolve: (value) => { clearTimeout(timer); resolve(value) } }
    send('editor:saveForQuit', id)
  })
  if (!outcomes) return expected.map((file) => ({ ...file, ok: false, error: t('dialog.unsaved.noReply') }))
  return outcomes.filter((outcome) => !outcome.ok)
}

/**
 * editor:quitSave。頼んだ requestId の返事だけを受け、確認で示したファイルだけを書く。
 * 書き先は、登録済みのプロジェクトのフォルダ（root と一致するもの）の中に限る。書くのはエディタの保存と同じ
 * writeTextFile（プロジェクトの中に閉じ、リンクをたどらず、開いた fd が中の実体かを確かめる）。
 */
async function receiveQuitSave(requestId: unknown, entries: unknown): Promise<QuitSaveOutcome[]> {
  const pending = pendingQuitSave
  if (!pending || typeof requestId !== 'string' || requestId !== pending.id) throw new UserFacingError(t('dialog.unsaved.noReply'))
  pendingQuitSave = null
  const screened = screenQuitSaveEntries(entries, pending.expected, {
    maxBytes: QUIT_SAVE_MAX_BYTES,
    maxTotalBytes: QUIT_SAVE_MAX_TOTAL_BYTES,
    byteLength: (text) => Buffer.byteLength(text, 'utf8')
  })
  const outcomes: QuitSaveOutcome[] = []
  const projects = currentSettings().projects
  for (const entry of screened.accepted) {
    const project = findProjectByFolder(projects, entry.root)
    if (!project) { outcomes.push({ root: entry.root, path: entry.path, ok: false, error: t('errors.folderNotRegistered') }); continue }
    try {
      await writeTextFile(project.folderPath, entry.path, entry.content)
      outcomes.push({ root: entry.root, path: entry.path, ok: true })
    } catch (err) {
      outcomes.push({ root: entry.root, path: entry.path, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const r of screened.rejected) {
    if (r.reason === 'tooLarge') outcomes.push({ root: r.root, path: r.path, ok: false, error: t('dialog.unsaved.tooLarge', { limit: QUIT_SAVE_MAX_BYTES / 1024 / 1024 }) })
  }
  for (const m of screened.missing) outcomes.push({ ...m, ok: false, error: t('dialog.unsaved.noReply') })
  pending.resolve(outcomes)
  return outcomes
}

/**
 * 「プロジェクトを開く」。終了をやめ、そのファイルのプロジェクトへ切り替え（project:switch と同じ）、エディタにしてタブを開かせる。
 * 録画中はプロジェクトを切り替えない（assertNotRecording と同じ）。アプリを前に出して、理由を知らせるだけにする。
 */
function revealUnsavedFile(target: UnsavedQuitItem): void {
  const window = mainWindow
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible() && !HIDE_WINDOW) window.show()
    window.focus()
  }
  try {
    assertNotRecording()
  } catch (err) {
    send('editor:revealUnsaved', { root: target.root, path: target.path, error: err instanceof Error ? err.message : String(err) })
    return
  }
  const project = currentSettings().projects.find((p) => p.id === target.projectId)
  if (project && workspace.projectId !== project.id) openProject(project)
  if (mode !== 'editor') {
    mode = 'editor'
    setTelemetryContext({ mode })
    send('mode:changed', mode)
  }
  send('editor:revealUnsaved', { root: target.root, path: target.path })
}
/** 録画エンジン。起動を軽くするため、録画を始める時点で初めて読み込む（NF-5） */
let recording: RecordingController | null = null
/**
 * 録画中の音声を無音で区切ってセッションへ書き出す係（系統ごと）。
 * 文字起こしへ渡す形（16kHz モノラルWAV）で、録画中に逐次書く（NF-12）。
 */
let activePaths: SessionPaths | null = null
/** 「このレビューに追加で録る」の録画中なら、足す先のレビューと録画の番号（activePaths は takes/<n>/ を指す） */
let activeAppend: { review: SessionPaths; n: number } | null = null
let transcriber: IncrementalTranscriber | null = null
/** 録画中の文字起こしの途中経過を画面へ送る（右パネルの「文字起こし」タブと、止まったときの警告。pipeline/stt/liveFeed.ts） */
let liveFeed: import('./pipeline/stt/liveFeed').LiveTranscriptFeed | null = null
let activeOptions = { captureSystemAudio: false, captureMic: true, transcription: 'local' as SttProvider }

/**
 * 文字起こし・整理のAPIキー（pipeline/stt/keys.ts）。配布版は OS の鍵で暗号化して userData/stt-keys.bin に保存する。
 * - 起動時・画面の表示では復号しない（has / source は保存した提供元の名前の一覧で答える）。
 *   復号（macOS では Keychain に触れる）は、実際に送る直前・接続の確認・キーの保存のときだけ（read / set）
 * - dev 起動・E2E では safeStorage を使わず、その起動中だけ持つ（Keychain の確認を出さない）
 */
let sttKeys: SttKeyStore | null = null
async function sttKeyStore(): Promise<SttKeyStore> {
  if (!sttKeys) {
    const { SttKeyStore: Store, chooseKeyCipher, devKeyEnv } = await import('./pipeline/stt/keys')
    // 環境変数のキー（.env の OPENAI_API_KEY）は dev 起動のときだけ使う
    sttKeys = new Store(join(app.getPath('userData'), 'stt-keys.bin'),
      chooseKeyCipher({ isPackaged: IS_PACKAGED, isE2E: IS_E2E, safeStorage }), devKeyEnv(IS_PACKAGED))
  }
  return sttKeys
}
/**
 * 送信に使うキー。settings.json の apiKey（平文）> apiKeyEnv（環境変数・プロジェクトの .env・設定フォルダの .env）> 保存したキー の順。
 * 値はログ・エラー・IPC の戻り値に出さない（src/main/settingsKeys.ts）
 */
async function providerKey(ref: KeyRef | undefined, vendor: AiVendor | null): Promise<string | undefined> {
  return resolveApiKey(ref, keyLookup(), async () => (vendor ? (await sttKeyStore()).read(vendor) : undefined))
}

function keyLookup(): import('./settingsKeys').KeyLookup {
  return { env: process.env, projectDir: workspace.folderPath, configDir: configDir() }
}

/**
 * 保存したキー・環境変数のヘッダーを送ってよい接続元（security-5 [6]。src/main/credentialOrigin.ts）。
 * 設定（settings.json）の接続先は、初めての起動でも認めたものとして入れない（security-6 [3]。設定は画面・Agent からも書ける）。
 * プリセット以外の接続先は、「接続を確かめる」で main のダイアログが接続元の名前を出して聞き、認められたものだけを覚える
 */
let credentialOrigins: Promise<import('./credentialOrigin').CredentialOrigins> | null = null

/**
 * ターミナルのタブと画面の文字を、終了・閉じたあとに戻すために覚える（userData/terminal-restore.json。terminalRestore.ts）。
 * 設定の agents.restoreTerminals が切なら覚えない。E2E では ADE_E2E_TERMINAL_RESTORE=1 のときだけ（既存の E2E の起動の形を変えない）
 */
let terminalRestoreStore: TerminalRestoreStore | null = null
function terminalRestoreEnabled(): boolean {
  if (process.env.ADE_E2E === '1' && process.env.ADE_E2E_TERMINAL_RESTORE !== '1') return false
  return currentSettings().agents.restoreTerminals
}
function terminalRestore(): TerminalRestoreStore {
  terminalRestoreStore ??= new TerminalRestoreStore(join(app.getPath('userData'), 'terminal-restore.json'), terminalRestoreEnabled)
  return terminalRestoreStore
}
/** 設定を切にしたら、書いたものも消す */
function syncTerminalRestore(): void {
  if (!currentSettings().agents.restoreTerminals) terminalRestore().clear()
}
/** 終了の前に renderer に今の画面の文字を頼み、返事（terminal:restoreSave）を待っている間の後始末 */
let terminalRestoreCollected: (() => void) | null = null
/** 終了の前に renderer の返事を待つ上限 */
const TERMINAL_RESTORE_COLLECT_MS = 1000

/** 終了の前に、今のタブと画面の文字を renderer から受け取る（返事が無くても上限で進める） */
function collectTerminalRestore(): Promise<void> {
  const window = mainWindow
  if (!terminalRestoreEnabled() || !window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      if (terminalRestoreCollected === done) terminalRestoreCollected = null
      resolve()
    }
    const timer = setTimeout(done, TERMINAL_RESTORE_COLLECT_MS)
    terminalRestoreCollected = done
    // send() は終了の手順に入ると（shuttingDown）何も送らないので、ここは直接送る（終了の途中で頼むもの）
    window.webContents.send('terminal:restoreCollect')
  })
}
function credentialOriginStore(): Promise<import('./credentialOrigin').CredentialOrigins> {
  credentialOrigins ??= (async () => {
    const { CredentialOrigins } = await import('./credentialOrigin')
    return new CredentialOrigins(join(app.getPath('userData'), 'credential-origins.json'))
  })()
  return credentialOrigins
}

/**
 * 認証情報（保存したキー・settings.json の apiKey / apiKeyEnv・環境変数から読むヘッダー）を url へ送ってよいかを確かめる。
 * プリセットの接続元か、認めた接続元でなければ断る（UserFacingError）。ask（「接続を確かめる」を押したとき）なら、
 * main のダイアログで接続元の名前を出して聞く。画面から届いた値で決めない
 */
async function gateCredentials(scope: string, url: string | undefined, ref: (KeyRef & { headers?: Record<string, unknown> }) | undefined,
  vendor: AiVendor | null, defaults: ReadonlyArray<string | undefined>, ask: boolean): Promise<void> {
  const { authorizeCredentialOrigin, isPlainHttpOrigin } = await import('./credentialOrigin')
  const hasCredential = !!(ref?.apiKey || ref?.apiKeyEnv || Object.values(ref?.headers ?? {}).some((v) => typeof v !== 'string')
    || (vendor && (await sttKeyStore()).has(vendor)))
  const confirm = ask ? async (origin: string) => {
    const options = {
      type: 'question' as const,
      buttons: [t('credentialOrigin.confirm.send'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('credentialOrigin.confirm.message', { origin }),
      detail: [t('credentialOrigin.confirm.detail'), isPlainHttpOrigin(origin) ? t('credentialOrigin.confirm.http') : ''].filter(Boolean).join('\n\n')
    }
    const { response } = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    return response === 0
  } : undefined
  const verdict = await authorizeCredentialOrigin({ scope, url, hasCredential, defaults }, await credentialOriginStore(), confirm)
  if (!verdict.ok) throw new UserFacingError(t(ask ? 'credentialOrigin.declined' : 'credentialOrigin.blocked', { origin: verdict.origin }))
}

/**
 * 従量課金の API 呼び出しの記録（<設定フォルダ>/usage/decision-YYYY-MM.jsonl）と、判定モデルのローカル中継。
 * 中継は判定モデルを有効にしたときだけ立てる。Agent にはキーを渡さず、中継の URL だけを渡す（src/main/decision/）
 */
let callLog: import('./decision/callLog').CallLog | null = null
let decisionService: import('./decision/service').DecisionService | null = null
let usagePushTimer: NodeJS.Timeout | null = null

async function apiCallLog(): Promise<import('./decision/callLog').CallLog> {
  if (!callLog) callLog = new (await import('./decision/callLog')).CallLog(join(configDir(), 'usage'))
  return callLog
}

async function apiUsageSummary(): Promise<import('@shared/apiUsage').ApiUsageSummary> {
  const { DEFAULT_DECISION_PREFERENCES, resolveDecision } = await import('@shared/decision')
  const prefs = currentSettings().decision ?? DEFAULT_DECISION_PREFERENCES
  const resolved = prefs.enabled ? resolveDecision(prefs, envGetter(keyLookup())) : null
  return (await apiCallLog()).summary({ enabled: prefs.enabled, model: resolved?.model ?? null, provider: resolved?.preset ?? null })
}

/** 記録を足したらフッターへ知らせる（続けて来たら少しまとめる） */
function recordCall(record: import('@shared/apiUsage').ApiCallRecord): void {
  const withProject = record.projectId || !workspace.projectId ? record : { ...record, projectId: workspace.projectId }
  void apiCallLog().then((log) => log.append(withProject)).then(() => {
    if (usagePushTimer) clearTimeout(usagePushTimer)
    usagePushTimer = setTimeout(() => {
      usagePushTimer = null
      void apiUsageSummary().then((summary) => send('usage:apiCallsChanged', summary))
        .catch((err: unknown) => reportHandled(err, { area: 'usage', op: 'summarize api calls' }))
    }, 300)
  })
}

async function decision(): Promise<import('./decision/service').DecisionService> {
  if (!decisionService) {
    const { DecisionService } = await import('./decision/service')
    const { DECISION_PRESETS, DEFAULT_DECISION_PREFERENCES, withLocalDecisionModel } = await import('@shared/decision')
    const { localModelRecommendation } = await import('./localModels')
    const { ProjectLedger } = await import('./decision/projectLedger')
    decisionService = new DecisionService({
      // プロジェクトのその日の量は main のフォルダに残す（起動し直しても枠を空に戻さない。security-6 [8]）
      ledger: new ProjectLedger(join(app.getPath('userData'), 'decision-project-usage.json')),
      // Ollama でモデルを決めていなければ、この PC に合うもの（clef / clef-flash）を使う
      prefs: () => withLocalDecisionModel(currentSettings().decision ?? DEFAULT_DECISION_PREFERENCES, localModelRecommendation().decision),
      // キーは中継に最初の依頼が来たときに初めて読む（起動時には復号しない）
      readKey: (prefs) => providerKey(prefs as KeyRef, DECISION_PRESETS[prefs.preset].vendor),
      // 認証情報は認めた接続元にだけ送る（security-5 [6]）。中継の依頼では聞かずに断り、「接続を確かめる」でだけ聞く
      authorize: (prefs, url, interactive) => gateCredentials(`decision:${prefs.preset}`, url, prefs as KeyRef & { headers?: Record<string, unknown> },
        DECISION_PRESETS[prefs.preset].vendor, [DECISION_PRESETS[prefs.preset].endpoint], interactive),
      getEnv: (name) => envGetter(keyLookup())(name),
      onCall: recordCall
    })
    // 保存したキーが変わったら、古いキーの合言葉と途中の依頼を止める（security-7 [4]。キーの保存先が同期で知らせる）
    const service = decisionService
    ;(await sttKeyStore()).onChange(() => service.credentialsChanged())
  }
  return decisionService
}

/** 判定モデルの設定が変わったら、中継を立てる・止める */
function syncDecision(): void {
  if (!currentSettings().decision?.enabled && !decisionService) return
  void decision().then((d) => d.sync()).catch((err: unknown) => reportHandled(err, { area: 'settings', op: 'start decision relay' }))
}

/**
 * 設定の文字起こしのエンジン（録画と mtg の取り込みで共通）。使えなければ engine は null で、warning に利用者向けの理由。
 * キーが無ければ別のキーや接続先へ切り替えず、端末内の文字起こしを案内するだけにする
 */
async function sttEngineFor(transcription: import('@shared/types').SttProvider, language: string): Promise<{
  engine: import('./pipeline/stt/engine').SttEngine | null; kind: import('./pipeline/stt/segmenter').SttEngineKind; warning?: string
}> {
  if (transcription !== 'local') {
    const provider = transcription
    const { STT_PROVIDER_PRESETS, providerLabel, resolveEndpoint } = await import('@shared/aiProviders')
    const { createSttEngine } = await import('./pipeline/stt/cloud')
    const preset = STT_PROVIDER_PRESETS[provider]
    const capture = currentSettings().capture
    // 認証情報は認めた接続元にだけ送る（security-5 [6]）。認めていなければ送らずに知らせ、端末内の文字起こしを案内する
    const gate = await gateCredentials(`stt:${provider}`, resolveEndpoint(preset, resolveEndpointRefs(capture?.sttEndpoints?.[provider], keyLookup())).baseUrl,
      capture?.sttEndpoints?.[provider], preset.vendor, [preset.baseUrl], false).then(() => null, (err: unknown) => err instanceof UserFacingError ? err.message : t('errors.endpointMissingWarning'))
    const apiKey = gate ? undefined : await providerKey(capture?.sttEndpoints?.[provider], preset.vendor)
    // 上限は設定の値（null は上限なし）。検証起動では実API保護のため $0.05 に固定する
    const maxCostUsd = IS_E2E ? 0.05 : capture?.costLimitUsd
    if (gate) return { engine: null, kind: 'openai', warning: gate }
    if (preset.keyRequired && !apiKey) return { engine: null, kind: 'openai', warning: t('stt.errors.keyMissing', { label: providerLabel(preset, t) }) }
    try {
      return { engine: createSttEngine({ provider, endpoint: resolveEndpointRefs(capture?.sttEndpoints?.[provider], keyLookup()), apiKey, language, maxCostUsd }), kind: 'openai' }
    } catch (err) {
      // 接続先の設定の不足（UserFacingError）は送らない。それ以外の失敗だけが届く
      reportHandled(err, { area: 'stt', op: 'create stt engine' })
      return { engine: null, kind: 'openai', warning: t('errors.endpointMissingWarning') }
    }
  }
  const { nodeProbes, resolveWhisperBinary } = await import('./pipeline/environment')
  const binary = await resolveWhisperBinary({ modelDir: '' }, nodeProbes(workspace.folderPath))
  const { WhisperCppEngine } = await import('./pipeline/stt/whisper')
  if (binary && existsSync(localModel())) return { engine: new WhisperCppEngine({ binary, model: localModel(), language, greedy: true }), kind: 'local-cpu' }
  return { engine: null, kind: 'local-cpu', warning: t('errors.localModelMissingWarning') }
}

let sttWarnings: string[] = []
let recordingBusy = false

function localModel(): string {
  if (process.env.ADE_WHISPER_MODEL) return process.env.ADE_WHISPER_MODEL
  // 設定の「モデルをダウンロード」で落とした既定のモデル（userData/models）
  const downloaded = join(app.getPath('userData'), 'models', 'ggml-large-v3-turbo.bin')
  return existsSync(downloaded) ? downloaded : join(homedir(), '.cache/ade-movie/models/ggml-small.bin')
}

/** 設定の「モデルをダウンロード」（pipeline/stt/modelManager.ts）。使うときに読み込む */
let modelDownloads: import('./pipeline/stt/modelManager').WhisperModelDownloads | null = null
async function whisperModelDownloads(): Promise<import('./pipeline/stt/modelManager').WhisperModelDownloads> {
  if (!modelDownloads) {
    const { WhisperModelDownloads } = await import('./pipeline/stt/modelManager')
    modelDownloads = new WhisperModelDownloads(app.getPath('userData'))
  }
  return modelDownloads
}

let audioWriter: { write(block: PcmBlock): void; flush(): Promise<void> } | null = null

function send<C extends IpcEventChannel>(channel: C, ...args: Parameters<IpcEvents[C]>): void {
  if (shuttingDown) return
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const wc = window.webContents
  if (wc.isDestroyed()) return
  wc.send(channel, ...args)
}

/** 登録済みプロジェクトとして開くときは project を渡す。表示名はプロジェクト名を優先する */
/** 開いているプロジェクトの外部の変更（Agent の書き換えなど）をエディタへ知らせる */
const fileWatcher = new ProjectWatcher((event) => {
  send('fs:changed', event)
  // 内蔵ブラウザで開いているプレビューは、読み直さずに中身だけ差し替える（録画中の書き込みを残す）
  for (const tab of browser?.allContents() ?? []) refreshPreviewIn(tab, event.paths)
}, (ids) => {
  send('review:progressChanged', ids)
  // Agent が直した（human_review にした）ことを、オーケストラのフィードバックの記録に足す
  recordProgressFromDisk(ids)
})

/** ビジネス・ビジネスリサーチのフォルダ（business.yaml・research.yaml など）の変更を画面へ知らせる（src/main/business/wire.ts） */
const businessWatcher = ventureWatcher((channel) => send(channel))

/**
 * ビジネスリサーチ・「プロジェクトにする」で作ったフォルダを登録する（src/main/research/handlers.ts から呼ぶ）。
 * リサーチ（research: true）はオーケストラに入れず、ビジネスは指定のオーケストラ（無ければ先頭）に入れる
 */
function registerVentureProject(folder: string, patch: Partial<Project>): Project {
  const { projects, project } = upsertProjectFolder(currentSettings().projects, folder)
  const next = projects.map((p) => (p.id === project.id ? { ...p, ...patch } : p))
  updateSettings({ projects: next })
  syncEditorWorkspace()
  send('projects:changed', projectsState())
  return next.find((p) => p.id === project.id) ?? project
}

/**
 * ビジネス（src/main/venture/）が使う Ferret 本体の口。フォルダの登録・オーケストラにする・開くはここだけで行う
 */
/** 使っている人の状況（ビジネスリサーチ・ビジネスの前提。userData/founder-profile.md。src/main/founderProfile.ts） */
let founderProfileStore: import('./founderProfile').FounderProfileStore | null = null
async function founderProfile(): Promise<import('./founderProfile').FounderProfileStore> {
  if (!founderProfileStore) {
    const { FounderProfileStore } = await import('./founderProfile')
    founderProfileStore = new FounderProfileStore(join(app.getPath('userData'), 'founder-profile.md'))
  }
  return founderProfileStore
}
const founderText = async (): Promise<string> => (await founderProfile()).get()

function ventureWiring(): VentureOpsWiring {
  return {
    userData: app.getPath('userData'),
    founder: founderText,
    isPackaged: IS_PACKAGED,
    isE2E: IS_E2E,
    safeStorage,
    dialog,
    window: () => mainWindow,
    root: () => (workspace.folderPath && !isRemoteWorkspace() ? workspace.folderPath : null),
    openProjectId: () => workspace.projectId ?? null,
    projects: () => currentSettings().projects,
    registerFolder: (folder, options) => {
      const { projects, project } = upsertProjectFolder(currentSettings().projects, folder)
      const merged: Project = options.orchestra
        ? { ...project, ...(options.name ? { name: options.name } : {}), orchestrator: true, editorWorkspace: true }
        : { ...project, ...(options.name ? { name: options.name } : {}), ...(options.orchestraId && !project.editorWorkspace ? { orchestraId: options.orchestraId } : {}) }
      updateSettings({ projects: projects.map((p) => (p.id === merged.id ? merged : p)) })
      syncEditorWorkspace()
      send('projects:changed', projectsState())
      return merged
    },
    openProject: (id) => {
      const project = currentSettings().projects.find((p) => p.id === id)
      if (project && workspace.projectId !== id) openProject(project)
    },
    projectsState,
    assertNotRecording,
    terminals: () => terminals,
    // 送るボタンを押した直後だけ（gestures の 'send'。1回きり）
    consentSend: () => gestures.consume('send'),
    locale: guideLanguage,
    notify: () => send('venture:changed')
  }
}

/** ファイルエディタの IPC が触ってよい根。未選択なら断る */
function projectRoot(): string {
  if (!workspace.folderPath) throw new UserFacingError(t('errors.openProjectFolder'))
  return workspace.folderPath
}

function setWorkspace(folderPath: string | null, project: Project | null = null): WorkspaceState {
  if (folderPath !== workspace.folderPath) {
    fileWatcher.watch(folderPath)
    businessWatcher.watch(project?.source === 'ssh' ? null : folderPath)
    // 文字で指摘は前のプロジェクトのレビューへ足さない（切って足し先も外す）
    textNotes?.setActive(false, { reviewId: null, notify: true })
  }
  workspace = {
    folderPath,
    folderName: project?.name ?? (folderPath ? basename(folderPath) : null),
    projectId: project?.id ?? null
  }
  terminals?.setCwd(folderPath)
  terminals?.setRemote(project?.source === 'ssh' && project.ssh ? project.ssh : null)
  refreshWindowTitle()
  return workspace
}

/** 窓の題名。録画中は先頭に印を付け、macOS は Dock にも出す（renderer の表示に頼らない録画中の印） */
function refreshWindowTitle(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setTitle(indicatorTitle(workspace.folderName ? `${workspace.folderName} — ${PRODUCT_NAME}` : PRODUCT_NAME, capturing))
}

/** 拡張機能を足す・外す・切り替える。録画中は変えない（録画の合成の有無が録画の途中で変わらないように） */
function requireExtensionsEditable(): BrowserExtensions {
  if (!extensions) throw new UserFacingError(t('browserExtensions.errors.unavailable'))
  if (recordingBusy || (recording && recording.status.state !== 'idle')) throw new UserFacingError(t('browserExtensions.errors.recording'))
  return extensions
}

/** 設定の browserExtensions を書き換えて保存し、読み込み直した一覧を返す */
async function saveExtensionEntries(ext: BrowserExtensions, change: (entries: BrowserExtensionEntry[]) => BrowserExtensionEntry[]): Promise<BrowserExtensionInfo[]> {
  const next = change(currentSettings().browserExtensions ?? [])
  if (next.length > MAX_BROWSER_EXTENSIONS) throw new UserFacingError(t('browserExtensions.errors.tooMany', { max: MAX_BROWSER_EXTENSIONS }))
  const browserExtensions = sanitizeBrowserExtensions(next)
  updateSettings({ browserExtensions })
  await ext.sync(browserExtensions)
  return ext.list()
}

/** いまの書き込みの状態（拡張機能のポップアップを閉じるか・注入スクリプトを入れるかの判断に使う。@shared/popupAnnotation） */
function annotationActivity(): AnnotationActivity {
  const state = recording?.status.state ?? 'idle'
  return { capturing: state === 'recording' || state === 'paused', mode: recording?.annotationModeNow ?? 'off', note: textNotes?.isActive === true }
}

/** ページ・アプリの画面を押したときに拡張機能のポップアップを閉じる（書き込みの最中は閉じない） */
function dismissExtensionPopup(cause: PopupDismissCause): void {
  if (shouldCloseExtensionPopup(cause, annotationActivity())) extensions?.closePopup()
}

/** 内蔵ブラウザのビューの上に開いている拡張機能のポップアップと、ビューの中の位置（0〜1 の割合）。無ければ null */
function browserOverlay(): { contents: Electron.WebContents; rect: { x: number; y: number; width: number; height: number } } | null {
  const popup = extensions?.popupTarget() ?? null
  const view = browser?.viewBounds() ?? null
  const rect = popup && view ? relativeRect(popup.bounds, view) : null
  return popup && rect ? { contents: popup.contents, rect } : null
}

/**
 * 内蔵ブラウザの拡張機能を用意する。拡張は内蔵ブラウザの session にだけ読み込む（アプリの画面の session には入れない）。
 * 設定に拡張があるときだけ、最初のページを開く前に少し（最大2秒）待つ
 */
async function startBrowserExtensions(entries: BrowserExtensionEntry[] | undefined): Promise<void> {
  const ext = new BrowserExtensions({
    // いま開いているプロジェクトのログインの組（ポップアップ）と、用意したすべての組（読み込み）
    session: () => browser?.activeSession() ?? browserSession(),
    sessions: () => browserSessions(),
    importDir: () => join(configDir(), 'browser-extensions'),
    host: {
      window: () => mainWindow,
      viewBounds: () => browser?.viewBounds() ?? null,
      navigate: (url) => void browser?.navigate(url).catch(() => undefined),
      // 録画中・文字で指摘の間に開いたポップアップにだけ、内蔵ブラウザのページと同じ書き込みの注入スクリプトを入れる
      reviewPreload: () => (extensionPopupGetsReviewPreload(annotationActivity()) ? join(__dirname, '../preload/review.js') : null),
      annotating: () => !shouldCloseExtensionPopup('escape', annotationActivity()),
      // 文字で指摘の静止画の許可は、そのポップアップへの本物の入力から（内蔵ブラウザのビューと同じ口）
      popupInput: (contents) => browser?.onPageInput?.(contents)
    }
  })
  extensions = ext
  ext.onChange = () => send('browserExtensions:changed', ext.list())
  // 拡張を作っているプロジェクトで読み込み直したら、開いているページも読み込み直す（録画中は触らない）
  ext.onReloaded = () => { if (!recording || recording.status.state === 'idle') browser?.reload() }
  // ポップアップは別のビューなので、録画（タブ録画・静止画）にはビューの上の位置を割合で渡して重ねる
  ext.onPopupChange = () => recording?.setBrowserOverlay(browserOverlay())
  if (browser) browser.onLayout = () => ext.relayout()
  if (!entries?.length) return
  const { delay } = await import('@shared/delay')
  await Promise.race([ext.sync(entries), delay(2000)])
}

/** 取り込んだ settings.json を、動いているアプリへ反映する（配色・言語・エージェント・プロジェクト）。renderer へは平文のキーを外して送る */
function applyExternalSettings(settings: Settings): void {
  nativeTheme.themeSource = settings.theme ?? 'system'
  send('locale:changed', applyLocalePreference(settings.locale))
  if (settings.whisperModel) process.env.ADE_WHISPER_MODEL = settings.whisperModel
  void listAgentOptions(settings.agents).then((options) => send('agents:changed', options))
    .catch((err: unknown) => reportHandled(err, { area: 'settings', op: 'reload agents' }))
  syncTerminalRestore()
  syncAgentMailSkillNow()
  send('projects:changed', projectsState())
  // 内蔵ブラウザの拡張機能（足す・外す・有効の切り替え）
  void extensions?.sync(settings.browserExtensions)
  // 判定モデルの中継（有効・接続先の変更）
  syncDecision()
  // スマホから操作（settings.json で入れた・切った・ポートを変えた）
  syncMobileRemote()
  send('settings:changed', redactKeys(settings))
}

/** スマホから操作のサービス。最初に使うときに読み込んで作る */
async function mobileRemoteService(): Promise<import('./mobileRemote').MobileRemoteService> {
  if (mobileRemote) return mobileRemote
  const { MobileRemoteService } = await import('./mobileRemote')
  mobileRemote ??= new MobileRemoteService({
    tokenFile: join(configDir(), 'mobile-remote-token'),
    deps: {
      terminals: () => terminals,
      projects: () => currentSettings().projects,
      agentLabel: (agent) => agentLabel(agent, currentSettings().agents),
      locale: () => (getLocale() === 'ja' ? 'ja' : 'en'),
      // 開いているオーケストラの human.md（読むだけ）
      checklist: async () => {
        const editor = openOrchestra()
        return editor ? (await (await import('./orchestraOverview')).readChecklist(editor.folderPath)).items : []
      },
      // URL・合言葉・本文は渡さない（種類だけ）
      onError: (err, op) => reportHandled(errorKind(err), { area: 'mobile-remote', op })
    },
    onChange: (state) => send('remote:changed', state)
  })
  return mobileRemote
}

/** 設定（mobileRemote）に合わせて開け閉めする。一度も入れていなければ読み込まない */
function syncMobileRemote(): void {
  const prefs = currentSettings().mobileRemote
  if (!prefs?.enabled && !mobileRemote) return
  void mobileRemoteService().then((service) => service.apply(prefs))
    .catch((err: unknown) => reportHandled(errorKind(err), { area: 'mobile-remote', op: 'apply settings' }))
}

/** 開いているのが SSH のプロジェクトか（Agent はリモートで動くので、feedback.md は中身を貼って送る） */
function isRemoteWorkspace(): boolean {
  return currentSettings().projects.find((p) => p.id === workspace.projectId)?.source === 'ssh'
}

function projectsState(): ProjectsState {
  const { projects, activeProjectId } = currentSettings()
  return { projects, activeProjectId }
}

function assertNotRecording(): void {
  if (recordingBusy || (recording && recording.status.state !== 'idle')) throw new UserFacingError(t('errors.stopRecordingBeforeFolderChange'))
}

/**
 * オーケストレーターの subagent（<フォルダ>/.claude/agents/ferret-*.md）を、今のサブフォルダに合わせる。
 * オーケストレーターにしたプロジェクトを開いたとき・起動したとき。SSH のプロジェクトは手元のフォルダが置き場なので書かない
 */
function syncOrchestratorOnOpen(project: Project | null | undefined): void {
  if (!project?.orchestrator || project.source === 'ssh') return
  void import('./orchestrator')
    .then(({ syncOrchestrator }) => syncOrchestrator(project.folderPath, currentSettings().projects, true, membersOf(project), guideLanguage(), currentSettings().orchestra, project.name))
    // .claude がリンクなのは利用者の置き方（書かないのが正しい）。Sentry へは送らない
    .catch((err: unknown) => { if ((err as Error)?.name !== 'SubagentLinkError') reportHandled(err, { area: 'agent-launch', op: 'sync orchestrator subagents' }) })
}

/** オーケストレーターの子にするプロジェクト。オーケストラはそこに属するプロジェクト（SSH・外したものを除く。@shared/orchestras） */
function membersOf(project: Project): string[] {
  if (!project.editorWorkspace) return project.members ?? []
  return orchestraMembers(currentSettings().projects, project.id).map((p) => p.id)
}

/** 開いているプロジェクトのオーケストラ（オーケストラならそれ、プロダクトならその所属、無ければ先頭） */
function openOrchestra(): Project | null {
  return currentOrchestra(currentSettings().projects, workspace.projectId)
}

/** 足したプロジェクトを、開いているオーケストラに入れる */
function assignToOpenOrchestra(projects: Project[], id: string): Project[] {
  const orchestra = currentOrchestra(projects, workspace.projectId)
  return orchestra ? projects.map((p) => (p.id === id && !p.editorWorkspace ? { ...p, orchestraId: orchestra.id } : p)) : projects
}

/** 新しいオーケストラを作って開く。Ferret のデータの下に専用のフォルダを作り、そこに所属するプロジェクトがリンクで入る */
async function createOrchestra(name: string): Promise<ProjectsState> {
  assertNotRecording()
  const label = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  if (!label) throw new UserFacingError(t('orchestra.createNameRequired'))
  const folder = join(app.getPath('userData'), 'orchestras', randomUUID())
  const { mkdir } = await import('node:fs/promises')
  await mkdir(folder, { recursive: true })
  const { projects, project } = upsertProjectFolder(currentSettings().projects, folder)
  const orchestra: Project = { ...project, name: label, orchestrator: true, editorWorkspace: true }
  updateSettings({ projects: projects.map((p) => (p.id === orchestra.id ? orchestra : p)) })
  openProject(orchestra)
  return projectsState()
}

/** プロジェクトを別のオーケストラへ移す・並べ替える（オーケストラ同士の並べ替えも）。移す前と後のオーケストラの中身を合わせる */
function moveProjectInTree(id: string, toOrchestraId: string | null, beforeId: string | null): ProjectsState {
  const { projects } = currentSettings()
  if (typeof id !== 'string' || !projects.some((p) => p.id === id)) throw new UserFacingError(t('errors.projectNotFound'))
  updateSettings({ projects: moveInTree(projects, id, typeof toOrchestraId === 'string' ? toOrchestraId : null, typeof beforeId === 'string' ? beforeId : null) })
  syncEditorWorkspace()
  send('projects:changed', projectsState())
  return projectsState()
}

/**
 * 「すべてのプロダクト」（エディタ全体）を用意する。Ferret のデータの下の隠れたフォルダを作り、プロジェクトとして登録する。
 * 中には登録したプロジェクトが全部サブフォルダ（リンク）として入る。サブフォルダのことは画面に出さない
 */
async function ensureEditorWorkspace(): Promise<void> {
  const settings = currentSettings()
  const existing = settings.projects.find((p) => p.editorWorkspace)
  if (existing) {
    // 0.4.26 の既定の名前（すべてのプロジェクト）は今の名前（すべてのプロダクト）に揃える。利用者が付けた名前は変えない
    if (['すべてのプロジェクト', 'All projects'].includes(existing.name) && existing.name !== t('editorWorkspace.name')) {
      updateSettings({ projects: settings.projects.map((p) => (p.id === existing.id ? { ...p, name: t('editorWorkspace.name') } : p)) })
    }
    return
  }
  const folder = join(app.getPath('userData'), 'editor-workspace')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(folder, { recursive: true })
  const { projects, project } = upsertProjectFolder(settings.projects, folder)
  const editor: Project = { ...project, name: t('editorWorkspace.name'), orchestrator: true, editorWorkspace: true }
  // 一覧の一番上に置く
  updateSettings({ projects: [editor, ...projects.filter((p) => p.id !== editor.id)] })
}

/** オーケストラの中身（リンク・subagent）を、今の登録に合わせる（プロジェクトを足した・消した・移した・開いたとき）。全部のオーケストラ */
function syncEditorWorkspace(): void {
  for (const orchestra of orchestraList(currentSettings().projects)) syncOrchestratorOnOpen(orchestra)
}

/** オーケストレーターの README・CLAUDE.md の人が書く部分の雛形の言語（画面の言語が日本語なら日本語） */
function guideLanguage(): 'ja' | 'en' {
  return getLocale() === 'ja' ? 'ja' : 'en'
}

/**
 * 決まった起動（@shared/codexAudit）の引数。Codex のセキュリティ監査は、依頼文を開くフォルダの .ferret/requests/ に書き、
 * モデル・考える深さ・そのファイルを読む短い依頼を引数にする。preset が無い・Codex でないときは何も足さない
 */
async function terminalPresetArgs(options: import('@shared/types').TerminalCreateOptions): Promise<string[]> {
  const { isTerminalPreset, codexAuditArgs, CODEX_AUDIT_FILE } = await import('@shared/codexAudit')
  if (!isTerminalPreset(options.preset)) return []
  if (options.agent !== 'codex') return []
  const folder = typeof options.cwd === 'string' && options.cwd ? options.cwd : workspace.folderPath
  if (!folder || !currentSettings().projects.some((p) => p.folderPath === folder)) throw new UserFacingError(t('errors.openProjectFolder'))
  const { composeAgentRequest, resolveAgentRequests } = await import('@shared/agentRequests')
  const lang = guideLanguage()
  const request = resolveAgentRequests(currentSettings().agentRequests, lang).filter((r) => r.id === 'security-codex')
  const file = join(folder, ...CODEX_AUDIT_FILE.split('/'))
  await mkdir(dirname(file), { recursive: true })
  await (await import('./sessions/containment')).writeFileNoFollow(file, composeAgentRequest(request, lang, false) + '\n')
  return codexAuditArgs(lang)
}

/** オーケストレーターにする・やめる。子の subagent を書く・消す */
async function setProjectOrchestrator(id: unknown, enabled: unknown): Promise<{ children: Array<{ dir: string; name: string; agent: string }>; skipped: string[] }> {
  const settings = currentSettings()
  const current = settings.projects.find((p) => p.id === id)
  if (!current) throw new UserFacingError(t('errors.projectNotFound'))
  if (current.source === 'ssh') throw new UserFacingError(t('errors.folderNotRegistered'))
  const on = enabled === true
  const { SubagentLinkError, syncOrchestrator } = await import('./orchestrator')
  const result = await syncOrchestrator(current.folderPath, settings.projects, on, membersOf(current), guideLanguage(), currentSettings().orchestra, current.name).catch((err: unknown) => {
    if (err instanceof SubagentLinkError) throw new UserFacingError(t('orchestrator.linkRefused'))
    throw err
  })
  const merged: Project = { ...current }
  if (on) merged.orchestrator = true
  else delete merged.orchestrator
  updateSettings({ projects: currentSettings().projects.map((p) => (p.id === current.id ? merged : p)) })
  send('projects:changed', projectsState())
  return { children: result.children, skipped: result.skipped }
}

/**
 * プロジェクトを開く。ターミナルの起動先（cwd）と保存先をそのフォルダに切り替える。
 * 内蔵ブラウザが空か、前のプロジェクトのURLを表示しているなら、このプロジェクトの先頭URLへ移る。
 */
function openProject(project: Project): WorkspaceState {
  const previousId = workspace.projectId
  // 前のプロジェクトのタブ（戻る・進むの履歴ごと）は、このプロジェクトに切り替える前に写しておく
  const previousTabs = browser && previousId && previousId !== project.id ? browser.snapshotTabs() : null
  const next = setWorkspace(project.folderPath, project)
  updateSettings({ activeProjectId: project.id, folderPath: project.folderPath, projects: markProjectOpened(currentSettings().projects, project.id) })
  syncOrchestratorOnOpen(project)
  // プロジェクトを足して開いたときも、「すべてのプロジェクト」の中身を合わせる
  if (!project.editorWorkspace) syncEditorWorkspace()
  send('workspace:changed', next)
  send('projects:changed', projectsState())
  // 内蔵ブラウザもそのプロジェクトのタブに入れ替える（ターミナルと同じく、プロジェクトごとに分ける）。
  // この起動で開いていたなら履歴ごと → 前に開いていたタブの URL → 登録 URL の先頭 → 空の画面。
  // 前のプロジェクトのタブの URL は、表示が変わるたびに recordProjectUrl が覚えてある
  if (browser && previousId !== project.id) {
    if (previousId && previousTabs) parkedBrowserTabs.set(previousId, previousTabs)
    const parked = parkedBrowserTabs.get(project.id) ?? null
    parkedBrowserTabs.delete(project.id)
    const saved = currentSettings().projects.find((p) => p.id === project.id) ?? project
    // ログインの組（既定は全プロジェクトで共有。設定で分けたプロジェクトはその組の session）
    browser.setPartition(browserPartition(saved.browserProfile))
    browser.replaceTabs(parked, sessionTabs(saved))
  }
  // 録画の対象の画面・ウインドウは前のプロジェクトで選んだもの。別のアプリを映したり録ったりしないよう、内蔵ブラウザに戻す
  if (captureConsent.target.kind !== 'browser') setCaptureTargetFromMain({ kind: 'browser' })
  return next
}

/**
 * 開いているプロジェクトに、内蔵ブラウザで表示している URL を覚える。
 * 読み込み途中は覚えない（切り替え直後は前のプロジェクトの URL がまだ出ているため）。
 */
function recordProjectUrl(state: BrowserState): void {
  const id = workspace.projectId
  if (!id || state.loading || !isRecordableUrl(state.url)) return
  // 読み込み途中のタブがあれば、その URL が決まってから覚える（切り替え直後の空のタブで前の値を消さない）
  if (state.tabs?.some((tab) => tab.loading)) return
  const { projects } = currentSettings()
  const project = projects.find((p) => p.id === id)
  if (!project) return
  // プレビューの外部の画像の許可（使い切りの合言葉）は覚えない（security-4 [6]）
  const url = stripPreviewGrant(state.url)
  const tabs = state.tabs ? recordableTabs(state.tabs, state.activeTabId) : null
  const session = project.session
  const sameTabs = !tabs || (JSON.stringify(session?.tabs ?? []) === JSON.stringify(tabs.tabs) && (session?.activeTab ?? 0) === (tabs.activeTab ?? 0))
  if (session?.url === url && sameTabs) return
  updateSettings({ projects: withProjectSession(projects, id, { url, ...(tabs ? { tabs: tabs.tabs, activeTab: tabs.activeTab } : {}) }) })
}

/** 切り替えて離れたプロジェクトの内蔵ブラウザのタブ（戻る・進むの履歴ごと）。アプリを開いている間だけ持つ */
const parkedBrowserTabs = new Map<string, TabsSnapshot>()

/** フォルダを登録して開く。同じフォルダが登録済みならそれを開く */
function openFolderAsProject(folderPath: string): WorkspaceState {
  const { projects, project, alreadyPresent } = upsertProjectFolder(currentSettings().projects, folderPath)
  if (!alreadyPresent) updateSettings({ projects: assignToOpenOrchestra(projects, project.id) })
  return openProject(project)
}

/** clone したフォルダを「GitHub から取得」したプロジェクトとして開く（同じフォルダが登録済みならそれに印を付ける） */

/** フッターの git（gitSync.ts）。裏の fetch の許可を userData に残す（security-7 [9]）。起動を重くしないよう、使うときに読む */
let fetchConsentReady = false
async function gitSyncModule(): Promise<typeof import('./github/gitSync')> {
  const sync = await import('./github/gitSync')
  if (!fetchConsentReady) {
    const { FetchConsentStore } = await import('./github/fetchConsent')
    sync.setFetchConsentStore(new FetchConsentStore(join(app.getPath('userData'), 'git-auto-fetch.json')))
    fetchConsentReady = true
  }
  return sync
}
function openClonedProject(folderPath: string, remoteUrl: string): WorkspaceState {
  const { projects, project } = upsertProjectFolder(currentSettings().projects, folderPath)
  const marked = assignToOpenOrchestra(projects.map((p) => (p.id === project.id ? { ...p, source: 'github' as const, remoteUrl } : p)), project.id)
  updateSettings({ projects: marked })
  return openProject(marked.find((p) => p.id === project.id) ?? project)
}

/**
 * SSH の接続先とリモートのフォルダを登録して開く。ターミナルと Agent のタブはリモートで動き（setWorkspace → terminals.setRemote）、
 * レビューはローカルの置き場（設定フォルダの remote/<host>-<名前>-<ハッシュ>）に保存する。鍵やパスワードは扱わない。
 */
async function addSshProject(target: SshTarget, name?: string): Promise<ProjectsState> {
  const checked = checkSshTarget(target ?? { host: '', path: '' })
  if (!checked.ok) throw new UserFacingError(t(checked.reason === 'host' ? 'projectSource.errors.host' : 'projectSource.errors.path'))
  assertNotRecording()
  const { projects } = currentSettings()
  const existing = projects.find((p) => p.source === 'ssh' && p.ssh?.host === checked.target.host && p.ssh?.path === checked.target.path)
  if (existing) {
    openProject(existing)
    return projectsState()
  }
  const folder = join(configDir(), 'remote', remoteWorkspaceDirName(checked.target))
  await mkdir(folder, { recursive: true })
  const project: Project = { ...newProject(folder), name: name?.trim() || sshDefaultName(checked.target), source: 'ssh', ssh: checked.target }
  updateSettings({ projects: assignToOpenOrchestra([...projects, project], project.id) })
  openProject(currentSettings().projects.find((p) => p.id === project.id) ?? project)
  return projectsState()
}

async function pickFolder(): Promise<string | null> {
  const window = mainWindow
  if (!window || window.isDestroyed() || shuttingDown) return null
  const result = await dialog.showOpenDialog(window, {
    title: t('dialog.openFolder.title'),
    buttonLabel: t('dialog.openFolder.button'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** フォルダを開く（メニュー・空状態の「フォルダを開く」）。開いたフォルダはプロジェクトとして登録する */
async function openFolderDialog(): Promise<WorkspaceState> {
  assertNotRecording()
  const folder = await pickFolder()
  return folder ? openFolderAsProject(folder) : workspace
}

/** 登録を外す。開いているプロジェクトを外したら、残りの先頭へ移る（無ければ何も開いていない状態） */
function removeProject(id: string): ProjectsState {
  const settings = currentSettings()
  if (!settings.projects.some((p) => p.id === id)) return projectsState()
  const wasActive = workspace.projectId === id || settings.activeProjectId === id
  if (wasActive) assertNotRecording()
  const target = settings.projects.find((p) => p.id === id)!
  // オーケストラを消すときは、属するプロジェクトを残りの先頭のオーケストラへ移す。最後の1つは消さない
  const removed = target.editorWorkspace ? removeOrchestra(settings.projects, id) : settings.projects.filter((p) => p.id !== id)
  if (!removed) throw new UserFacingError(t('orchestra.removeLast'))
  const projects = removed
  updateSettings({ projects, ...(wasActive ? { activeProjectId: null } : {}) })
  syncEditorWorkspace()
  if (wasActive) {
    const fallback = projects[0]
    if (fallback) openProject(fallback)
    else {
      updateSettings({ folderPath: null })
      send('workspace:changed', setWorkspace(null))
    }
  }
  send('projects:changed', projectsState())
  return projectsState()
}

/** 名前・URLの変更。フォルダは変えられない（別フォルダは別プロジェクトとして足す） */
function updateProject(next: ProjectUpdate): ProjectsState {
  const settings = currentSettings()
  const current = settings.projects.find((p) => p.id === next.id)
  if (!current) throw new UserFacingError(t('errors.projectNotFound'))
  // 送られてきた項目だけを変える（名前だけ・確認先だけの更新が、ほかの画面の変更を古い値で上書きしないように）
  const merged: Project = {
    ...current,
    name: next.name?.trim() || current.name,
    ...(next.urls ? { urls: next.urls } : {}),
    ...(next.kind ? { kind: next.kind } : {})
  }
  if (next.starred === true) merged.starred = true
  else if (next.starred === false) delete merged.starred
  // オーケストラの対象・対象外。変えたら全体の subagent を合わせる
  const orchestraChanged = typeof next.orchestraExcluded === 'boolean' && next.orchestraExcluded !== !!current.orchestraExcluded
  if (next.orchestraExcluded === true) merged.orchestraExcluded = true
  else if (next.orchestraExcluded === false) delete merged.orchestraExcluded
  // ブラウザのログインの組（空で共有に戻す）。開いているプロジェクトなら、タブを新しい組で開き直す
  if (typeof next.browserProfile === 'string') {
    const profile = sanitizeBrowserProfile(next.browserProfile)
    if (profile) merged.browserProfile = profile
    else delete merged.browserProfile
  }
  const partitionChanged = browserPartition(merged.browserProfile) !== browserPartition(current.browserProfile)
  updateSettings({ projects: settings.projects.map((p) => (p.id === next.id ? merged : p)) })
  // 表示名が変わったらタイトルバーにも反映する
  if (workspace.projectId === next.id) {
    const saved = currentSettings().projects.find((p) => p.id === next.id) ?? merged
    send('workspace:changed', setWorkspace(saved.folderPath, saved))
  }
  if (orchestraChanged) syncEditorWorkspace()
  if (partitionChanged) {
    // 切り替えて戻ったときに前の組のタブを開かないよう、覚えた写しを捨てる
    parkedBrowserTabs.delete(next.id)
    if (browser && workspace.projectId === next.id) {
      const tabs = browser.snapshotTabs()
      browser.setPartition(browserPartition(merged.browserProfile))
      browser.replaceTabs(tabs, sessionTabs(merged))
    }
  }
  send('projects:changed', projectsState())
  return projectsState()
}

/*
 * E2E 実行中は、使っている人の画面にウィンドウを出さない。
 *
 * E2Eは1回で十数回アプリを起動するため、そのたびにウィンドウが開いては閉じ、
 * フォーカスとDockを奪う。これが「アプリが落ち続けている」ように見えていた。
 *
 *   ADE_E2E=1      … 画面に出さずに動かす（既定のE2E動作）
 *   ADE_E2E_SHOW=1 … E2E中でも従来どおり表示する（目視デバッグ用）
 *
 * 製品の通常起動では、どちらの環境変数も無いので挙動は変わらない。
 */
const IS_E2E = process.env.ADE_E2E === '1'
const SHOW_IN_E2E = process.env.ADE_E2E_SHOW === '1'
const HIDE_WINDOW = IS_E2E && !SHOW_IN_E2E

/*
 * 検証起動では既定のブラウザを開かない（作った Issue・GitHub / GitLab のページ・フィードバックの「新しい Issue」が
 * 本物のブラウザに出ないように）。開こうとした URL は ADE_E2E_OPEN_LOG のファイルに1行ずつ書き、E2E が確かめる
 */
if (IS_E2E) {
  shell.openExternal = async (url: string) => {
    const log = process.env.ADE_E2E_OPEN_LOG
    if (log) await import('node:fs/promises').then((fs) => fs.appendFile(log, `${url}\n`, 'utf8'))
  }
}

/** 解決済みの配色に合わせた地の色（tokens.css の --color-bg-app と同値） */
function nativeThemeBackground(): string {
  return THEME_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
}

/**
 * Windows / Linux のウインドウのアイコン。配布版は electron-builder.config.cjs の extraResources が
 * resources/icon.png に置き、開発時は build/icon.png を使う。macOS は Dock・.app のアイコンに任せる。
 */
function windowIcon(): { icon?: string } {
  if (process.platform === 'darwin') return {}
  const icon = IS_PACKAGED ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(icon) ? { icon } : {}
}

/** アプリ自身の画面の置き場所（file: のアプリのフォルダと、開発サーバー） */
let realAppPathCache: string | null | undefined
function realAppPath(): string | null {
  if (realAppPathCache !== undefined) return realAppPathCache
  try {
    const real = realpathSync(app.getAppPath())
    realAppPathCache = real !== app.getAppPath() ? real : null
  } catch {
    realAppPathCache = null
  }
  return realAppPathCache ?? null
}

function appPageRoots(): string[] {
  const roots = [pathToFileURL(app.getAppPath()).href]
  // リンクを通った場所から起動すると、ページの URL は実体のパスになる（macOS の /var → /private/var、/tmp → /private/tmp）。
  // 実体のパスも認めないと、画面からの呼び出しを全部断ってしまう
  const real = realAppPath()
  if (real) roots.push(pathToFileURL(real).href)
  if (process.env.ELECTRON_RENDERER_URL) roots.push(process.env.ELECTRON_RENDERER_URL)
  return roots
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 読み込み前に一瞬見える地の色。配色（nativeTheme）に合わせる
    backgroundColor: nativeThemeBackground(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows / Linux のタイトルバーとタスクバーのアイコン（macOS は .app のアイコンを使う）
    ...windowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 最初の描画の前に配色を決められるよう、解決済みの配色を preload へ渡す
      additionalArguments: [`--ade-theme=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`, `--ade-locale=${getLocale()}`,
        // 確認用（FERRET_SENTRY_TEST=preload）：preload の読み込み中の例外が Sentry へ届くか
        ...(sentryTestKinds().includes('preload') ? ['--ade-sentry-test-preload'] : [])],
      contextIsolation: true,
      nodeIntegration: false,
      // preload は contextBridge / ipcRenderer しか使わないので、サンドボックス内で動く
      sandbox: true,
      spellcheck: false,
      /*
       * 非表示・背面でも描画を止めない。
       * useViewBounds は requestAnimationFrame で内蔵ブラウザの位置を実測し、
       * E2Eは capturePage で画面を撮るため、止まると両方が狂う。
       */
      backgroundThrottling: false
    }
  })

  const showOnce = () => {
    // 画面に出さない指定のときは show() を呼ばない（フォーカスも奪わない）
    if (HIDE_WINDOW || window.isDestroyed() || window.isVisible()) return
    // E2Eで表示する場合も、前面に出して作業を邪魔しない
    if (IS_E2E) window.showInactive()
    else window.show()
  }
  window.once('ready-to-show', () => {
    mark('window:readyToShow')
    showOnce()
  })
  // Linux の一部の環境では ready-to-show が届かず、窓が出ないままになる。読み込み終わりから少し待って出す（Orca #8421）
  window.webContents.once('did-finish-load', () => setTimeout(showOnce, 1500).unref?.())

  // Windows / Linux: ターミナルにフォーカスがあるときは、シェルが使う Ctrl+… をメニューのショートカットに取らせない（Orca #11540）
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') window.webContents.setIgnoreMenuShortcuts(terminalFocused && terminalOwnsMenuKey(input, process.platform))
  })
  // 利用者の操作（OS から窓に届いたクリック・キー）だけが、録画・撮影・プログラムのコピーの許可を作る（captureConsent.ts）
  window.webContents.on('input-event', (_event, input) => { if (isGestureInput(input.type)) gestures.noteGesture() })
  // アプリの画面を押したら、拡張機能のポップアップは閉じる（Chrome と同じ）。録画中・文字で指摘の間は閉じない（ツールバーで道具を選んでからポップアップに書き込む）
  window.webContents.on('input-event', (_event, input) => { if (input.type === 'mouseDown') dismissExtensionPopup('app') })
  // 読み込み直したら、新しい画面が知らせ直すまではターミナルにフォーカスが無いとみなす
  window.webContents.on('did-start-loading', () => { terminalFocused = false })

  // 画面のプロセスが落ちたら読み込み直す（白い画面のまま残さない。crashReload.ts）
  const crashReloads: number[] = []
  window.webContents.on('render-process-gone', (_event, details) => {
    if (shuttingDown || window.isDestroyed() || !allowCrashReload(crashReloads, details.reason, Date.now())) return
    console.warn(`[app] 画面のプロセスが終了しました（${details.reason}）。読み込み直します`)
    window.webContents.reload()
  })

  // リンクはブラウザで開く。http / https / mailto だけ（プレビューの iframe の中身はプロジェクトのもので信用しない。
  // file: や独自スキームを OS の URL ハンドラへ渡さない）
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch((err: unknown) => reportHandled(err, { area: 'browser', op: 'open external link' }))
    return { action: 'deny' }
  })
  // アプリの画面からほかのページへ移らない（ファイルを落としたときの既定の遷移も含む。preload の IPC を外のページに渡さない）
  window.webContents.on('will-navigate', (event) => {
    if (!isAppPageUrl(event.url, appPageRoots())) event.preventDefault()
  })

  // 単一ウィンドウのアプリなので、ウィンドウを閉じる＝アプリの終了とする（3つのOSで同じ）。
  // 終了の手順は beginShutdown() に一本化する。
  window.on('close', (event) => {
    if (beginShutdown()) event.preventDefault()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  return window
}

const IDLE_RECORDING_STATUS: RecordingStatus = {
  state: 'idle',
  elapsedMs: 0,
  videoBytes: 0,
  frameCount: 0,
  eventCount: 0
}

/**
 * 録画エンジンを必要になった時点で用意する（設計1.3「起動時に読むコードを最小化」）。
 *
 * 音声（onPcm）・操作ログ（onEvent）・静止画（onFrame）を分解パイプラインと
 * セッション保存へ渡す結線は、進行役（src/main/review）が作られたときに差し込む。
 */
async function ensureRecording(): Promise<RecordingController> {
  if (recording) return recording
  const { RecordingController } = await import('./recording')
  recording = new RecordingController(
    {
      recorderHtml: join(__dirname, '../recorder/index.html'),
      recorderPreload: join(__dirname, '../preload/recorder.js')
    },
    {
      onLimit: () => stopReview().then(() => undefined),
      onStatus: (status) => {
        setTelemetryContext({ recording: status.state })
        const next = status.state !== 'idle'
        if (next !== capturing) {
          capturing = next
          refreshWindowTitle()
          if (process.platform === 'darwin') app.dock?.setBadge(capturing ? CAPTURE_INDICATOR : '')
        }
        send('recording:status', status)
        // 録画のために残していた、録画中に閉じたタブを閉じる
        if (status.state === 'idle') browser?.releaseClosedTabs()
      },
      onLevel: (level) => { send('recording:level', level); liveFeed?.level(level.source, level.rms, level.peak) },
      onPcm: (block) => audioWriter?.write(block),
      onWarning: (message) => send('recording:warning', message),
      onAnnotationHistory: (history) => send('annotation:history', history),
      onAnnotationShortcut: (action) => send('annotation:shortcut', action),
      onTracks: (state) => send('recording:tracksChanged', state),
      // 録画のトラックの切り替えで内蔵ブラウザの別のタブを映した。内蔵ブラウザもそのタブを前に出す
      onBrowserTab: (contents) => browser?.activateContents(contents)
    }
  )
  // 内蔵ブラウザのタブ（録画の用意より前に開いていたもの）。録るのは前に出ているタブ
  for (const tab of browser?.allContents() ?? []) recording.attach(tab)
  const contents = browser?.contents
  if (contents) recording.selectBrowserTab(contents)
  // 録画の用意より前に開いていたログインのポップアップ
  for (const popup of browser?.popupContents() ?? []) recording.attachPopupWindow(popup, popup.getURL())
  // 録画の用意より前に開いていた拡張機能のポップアップ
  recording.setBrowserOverlay(browserOverlay())
  // 画面・ウインドウを録る間は、その映像を内蔵ブラウザの場所に映し、その上に書き込める
  recording.setMirror({
    show: (sourceId) => { mirrorRecording = sourceId; return syncMirror() },
    hide: () => { mirrorRecording = null; void syncMirror() },
    // 録画中に内蔵ブラウザへ切り替えた。選んだウインドウの下見も出さない（録画が終わるまで）
    showBrowser: () => { mirrorRecording = false; void syncMirror() }
  })
  return recording
}

/** Agent に入れる設定の skill に書く、この Ferret の設定ファイルの場所 */
function agentSkillContext(): SkillContext {
  const dir = configDir()
  return { settingsPath: join(dir, 'settings.json'), schemaPath: join(dir, 'settings.schema.json'), version: app.getVersion(), editorWorkspacePath: openOrchestra()?.folderPath ?? join(app.getPath('userData'), 'editor-workspace') }
}

/**
 * 入れてある設定の skill を、この版の設定の項目に合わせて書き直す（起動時）。
 * 配布版だけ。開発版・E2E が、ふだん使う Agent の skill を開発用の設定ファイルへ向け直さないように
 */
function syncAgentSkillOnStart(): void {
  if (!IS_PACKAGED || IS_E2E) return
  void import('./agentSkill').then(({ syncAgentSkill }) => syncAgentSkill(agentSkillContext()))
    .catch((err: unknown) => reportHandled(err, { area: 'agent-launch', op: 'sync agent skill' }))
}

/**
 * Agent どうしの依頼の skill を、設定（agents.agentMail）に合わせて入れる・外す（起動時と設定の変更時）。
 * 配布版だけ（開発版・E2E は、ふだん使う Agent の skill に触らない）
 */
function syncAgentMailSkillNow(): void {
  if (!IS_PACKAGED || IS_E2E) return
  void syncAgentMailSkill(app.getVersion()).catch((err: unknown) => reportHandled(err, { area: 'agent-mail', op: 'sync skill' }))
}

/** 内蔵ブラウザを browser-use で動かす skill（ferret-browser）を Claude Code・Codex に入れる。配布版だけ */
function syncBrowserSkillNow(): void {
  if (!IS_PACKAGED || IS_E2E) return
  void import('./browserSkill')
    .then(({ syncBrowserSkill }) => syncBrowserSkill(app.getVersion()))
    .catch((err: unknown) => reportHandled(err, { area: 'browser', op: 'sync skill' }))
}

/** main が録画の対象を変える（内蔵ブラウザへ戻すときだけ）。設定に残し、画面へ知らせる */
function setCaptureTargetFromMain(target: CaptureTarget): void {
  captureConsent = { ...captureConsent, target }
  const capture = currentSettings().capture
  if (capture) updateSettings({ capture: { ...capture, captureTarget: target } })
  void syncMirror()
  send('capture:targetChanged', target)
}

/** 録画中の画面・ウインドウ（録画が映させているもの）。録画していなければ null、録画中に内蔵ブラウザを見せているなら false */
let mirrorRecording: string | false | null = null
let mirrorQueue: Promise<unknown> = Promise.resolve()

/**
 * 録画の対象に選んだウインドウ（デスクトップアプリ・シミュレータ・ゲームのエディタなど）を、録画していなくても映す。
 * 画面全体は映さない（エディタ自身が映り込むため。録画中だけ映す）。画面収録の許可が無ければ映さない（OS の確認を出さない）
 */
async function previewSourceId(): Promise<string | null> {
  const target = captureConsent.target
  if (target.kind !== 'window') return null
  const { listCaptureSources, screenAccess } = await import('./recording/sources')
  if (screenAccess() !== 'granted') return null
  const sources = await listCaptureSources({ width: 0, height: 0 }).catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'list mirror sources' }); return [] })
  const resolved = resolveCaptureTarget(target, sources)
  // 複数選んだときは並べて映す（mirror.js）
  return mirrorSourceParam(targetSourceIds(resolved && resolved.kind === 'window' ? resolved : target))
}

/**
 * 内蔵ブラウザの場所に映すものを決め直す。録画中はその対象、そうでなければ選んだウインドウ、どちらも無ければ内蔵ブラウザ。
 * 呼ばれた順に1つずつ行う（選び直しと録画の開始が重なっても、最後の状態に揃う）
 */
function syncMirror(): Promise<Electron.WebContents | null> {
  const next = mirrorQueue.then(async () => {
    const wanted = mirrorRecording === false ? null : mirrorRecording ?? await previewSourceId()
    if (!browser) return null
    if (!wanted) { browser.hideMirror(); return null }
    return browser.showMirror(join(__dirname, '../recorder/mirror.html'), wanted, t('recording.mirrorUnavailable', { target: captureTargetLabel(captureConsent.target) }))
  })
  mirrorQueue = next.catch(() => undefined)
  return next.catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'sync capture mirror' }); return null })
}

/** 文字で指摘の受け口を用意する（最初に入れたとき。src/main/textNotes.ts） */
async function ensureTextNotes(): Promise<import('./textNotes').TextNotes> {
  if (textNotes) return textNotes
  const { TextNotes } = await import('./textNotes')
  textNotes = new TextNotes({
    views: () => ({ browser: browser?.contents ?? null, mirror: browser?.mirrorContents ?? null,
      popups: [extensions?.popupTarget()?.contents, ...(browser?.popupContents() ?? [])].filter((wc): wc is Electron.WebContents => !!wc) }),
    recording: () => recordingBusy || (!!recording && recording.status.state !== 'idle'),
    capture: async (view) => {
      // そのビューで直前に利用者が Enter・クリックした1回だけ撮る（security-5 [1]。ページのスクリプトや IPC だけでは撮れない）
      if (!noteInputs.consume(view)) return false
      const image = await view.capturePage()
      if (image.isEmpty()) return null
      const { width } = image.getSize()
      const saved = width > 2560 ? image.resize({ width: 2560, quality: 'better' }) : image
      return { png: saved.toPNG(), size: saved.getSize() }
    },
    save: async (request, reviewId, mirrored) => {
      if (!workspace.folderPath) throw new UserFacingError(t('errors.openProjectFolder'))
      const { addTextNote } = await import('./review')
      const urlPresets = currentSettings().projects.find((p) => p.id === workspace.projectId)?.urls ?? []
      return addTextNote(workspace.folderPath, reviewId, { ...request, ...(mirrored ? { captureTarget: captureConsent.target } : {}), urlPresets })
    },
    color: () => normalizeAnnotationColor(currentSettings().capture?.annotationColor),
    labels: () => ({ placeholder: t('textNote.page.placeholder'), hint: t('textNote.page.hint'), add: t('textNote.page.add') }),
    onMode: (active) => send('note:mode', active),
    onAdded: (result) => send('note:added', result as { review: import('@shared/review').ReviewData; count: number }),
    onError: (err) => {
      if (!(err instanceof UserFacingError)) reportHandled(err, { area: 'review', op: 'add text note' })
      send('note:error', err instanceof UserFacingError ? err.message : t('textNote.errors.saveFailed'))
    }
  })
  textNotes.bind()
  return textNotes
}

/**
 * 録画中の音声を、無音で区切って 16kHz モノラルWAV で書き出す係を作る。
 *
 * 文字起こし（src/main/pipeline/stt）は逐次処理が前提で、
 * ファイル全体を一度に渡すと同じ文の繰り返し誤認識が起きる（05_pipeline_findings 2章）。
 * ここで区切っておき、後段はこのWAVをそのまま読む。
 * 文字起こしの起動そのものは進行役（src/main/review）が受け持つ。
 */
async function createAudioWriter(audioDir: string): Promise<NonNullable<typeof audioWriter>> {
  const { SilenceSegmenter } = await import('./pipeline/stt/segmenter')
  const { writeWavFile } = await import('./pipeline/stt/wav')
  const SAMPLE_RATE = 16_000

  // マイクとPC音声は別々に区切る（二重取りの除去は後段が時刻で行う）
  const perSource = new Map<PcmBlock['source'], InstanceType<typeof SilenceSegmenter>>()
  const counters = new Map<PcmBlock['source'], number>()
  const offsets = new Map<PcmBlock['source'], number>()

  const segmenterFor = (source: PcmBlock['source']): InstanceType<typeof SilenceSegmenter> => {
    const found = perSource.get(source)
    if (found) return found
    const made = new SilenceSegmenter(
      async (chunk) => {
        const seq = (counters.get(source) ?? 0) + 1
        counters.set(source, seq)
        const name = `${source}-${String(seq).padStart(5, '0')}-${chunk.offsetMs}.wav`
        const wavPath = join(audioDir, name)
        await writeWavFile(wavPath, chunk.samples, SAMPLE_RATE)
        recording?.clearAnnotations()
        transcriber?.push({ wavPath, offsetMs: chunk.offsetMs + (offsets.get(source) ?? 0), source,
          speaker: source === 'mic' ? 'self' : 'other' })
      },
      { sampleRate: SAMPLE_RATE }
    )
    perSource.set(source, made)
    return made
  }

  return {
    // 区切りの時刻は Segmenter が流し込まれたサンプル数から数える（block.offsetMs と同じ基準）
    write: (block) => {
      if (!offsets.has(block.source)) offsets.set(block.source, block.offsetMs)
      segmenterFor(block.source).push(block.samples)
    },
    flush: async () => {
      for (const segmenter of perSource.values()) {
        const result = await segmenter.flush()
        sttWarnings.push(...result.errors.map((e) => t('errors.saveAudioFailed', { message: e.message })))
      }
      perSource.clear()
    }
  }
}

/**
 * GitHub の star のお願い（src/main/starPrompt.ts）。良い場面（最初の送信・レビューの完成）で呼ぶ。
 * 録画中とセットアップを終えるまでは出さない。star するのは利用者が押したときだけ
 */
let starPromptService: import('./starPrompt').StarPromptService | null = null
async function starPrompt(): Promise<import('./starPrompt').StarPromptService> {
  if (starPromptService) return starPromptService
  const [{ StarPromptService }, { checkStarred, starRepo }, { STAR_REPO_URL }] = await Promise.all([import('./starPrompt'), import('./github/star'), import('@shared/starPrompt')])
  starPromptService ??= new StarPromptService({
    getState: () => currentSettings().starPrompt,
    setState: (starPrompt) => updateSettings({ starPrompt }),
    context: () => {
      const onboarding = currentSettings().onboarding
      return {
        recording: Boolean(recording && recording.status.state !== 'idle'),
        onboardingDone: Boolean(onboarding?.completedAt || onboarding?.dismissedAt)
      }
    },
    checkStarred: () => checkStarred(),
    starRepo: () => starRepo(),
    openRepo: () => shell.openExternal(STAR_REPO_URL),
    show: (mode) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      send('star:show', mode)
      return true
    },
    // フィードバックの声かけ（送信 3 回で一度だけ。src/renderer/components/FeedbackDialog.tsx の FeedbackAskToast）
    askFeedback: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      send('feedback:ask')
      return true
    }
  })
  return starPromptService
}

/** 良い場面を知らせる。失敗しても元の操作には響かせない */
function recordStarMoment(moment: import('@shared/starPrompt').StarPromptMoment): void {
  void starPrompt().then((service) => service.record(moment)).catch((err: unknown) => reportHandled(err, { area: 'github', op: 'star prompt' }))
}

/**
 * 録画 n の何も起きていない時間を削った版を作る（設定の capture.trimIdle が false なら作らない）。
 * speechKnown が false（文字起こしが動かなかった・失敗した）なら、話していた時間を削らないよう作らない
 */
function scheduleTrim(review: SessionPaths, n: number, result: import('./recording/types').RecordingResult, transcript: import('./pipeline/types').TranscriptSegment[], speechKnown: boolean): void {
  const capture = currentSettings().capture
  if (capture?.trimIdle === false) return
  void (async () => {
    const { planTrim } = await import('./sessions/trim')
    const cuts = planTrim({ durationMs: result.durationMs, transcript, events: result.events, frames: result.frames, speechKnown },
      { minIdleMs: (capture?.trimIdleSeconds ?? 3) * 1000 })
    if (!cuts) return
    await (await import('./review')).trimReviewTake(review, n, cuts, result.durationMs)
  })().catch((err: unknown) => reportHandled(err, { area: 'review', op: 'trim recording' }))
}

async function stopReview(): Promise<RecordingStatus> {
      if (!recording || recording.status.state === 'idle') return recording?.status ?? IDLE_RECORDING_STATUS
      if (recordingBusy) throw new UserFacingError(t('errors.recordingBusy'))
      recordingBusy = true
      try {
        const result = await recording.stop()
        await audioWriter?.flush()
        audioWriter = null
        const stt = await transcriber?.flush()
        transcriber = null
        liveFeed?.stop()
        if (stt) flow(stt.errors.length ? 'stt failed' : 'stt end', { segments: stt.segments.length, errors: stt.errors.length })
        const paths = activePaths
        const append = activeAppend
        activeAppend = null
        if (paths) {
          const { appendReviewTake, finishReview } = await import('./review')
          const warnings = [...sttWarnings, ...(stt?.errors.map((e) => t('errors.transcriptionFailed', { message: e.message })) ?? [])]
          // 追記の録画は、開いていたレビューの末尾に足す（新しいレビューは作らない）
          const review = append
            ? await appendReviewTake(append.review, append.n, result, stt?.segments ?? [], warnings)
            : await finishReview(paths, result, stt?.segments ?? [], warnings, activeOptions.captureSystemAudio)
          send('review:ready', review)
          recordStarMoment('reviews')
          // 何も起きていない時間を削った版は、指摘を出したあとに裏で作る（失敗しても元の動画のまま使える）
          scheduleTrim(append?.review ?? paths, append?.n ?? 1, result, stt?.segments ?? [],
            (activeOptions.captureMic === false && !activeOptions.captureSystemAudio) || (!!stt && stt.errors.length === 0))
        }
        return recording.status
      } finally { recordingBusy = false }
}

/** 直前の更新確認で見つかった新しい版のページ（app:openUpdate で開く） */
let latestReleaseUrl: string | null = null

/**
 * 裏での更新（src/main/autoUpdate.ts）。起動時・6時間ごと・［更新を確認］で確かめ、新しい版を裏でダウンロードして、
 * 署名した SHA256SUMS で確かめてから「再起動して更新」を出す。
 * 配布版だけで動かす。E2E は偽の配信元（FERRET_E2E_RELEASE_BASE_URL。updateCheck.ts）のときだけ流れを通し、本物の入れ替えはしない
 */
let autoUpdates: AutoUpdater | null = null
/** ウインドウに戻ったとき、前の確認からこれ以上たっていれば確かめ直す */
const UPDATE_RECHECK_ON_FOCUS_MS = 60 * 60 * 1000
function autoUpdater(): AutoUpdater {
  if (autoUpdates) return autoUpdates
  const e2eServer = IS_E2E && usingE2eReleaseServer()
  // E2E だけ: 閉じたときの入れ替えの代わりに呼ぶ偽のインストーラー（絶対パスの .mjs）
  const e2eInstaller = e2eServer ? process.env.FERRET_E2E_UPDATE_INSTALLER?.trim() : undefined
  const install = () => import('./autoUpdateInstall')
  // 閉じるときは import を待てないので、準備ができた時点で読んでおく
  let installSync: typeof import('./autoUpdateInstall') | null = null
  autoUpdates = new AutoUpdater({
    method: installMethodFor(process.platform, process.env),
    enabled: (IS_PACKAGED && !IS_E2E) || e2eServer,
    canInstall: IS_PACKAGED && !IS_E2E,
    check: async () => {
      const result = await checkForUpdate()
      // 開くURLは main が覚えておく。renderer から任意のURLを開かせない
      latestReleaseUrl = result.state === 'available' ? result.url : null
      return result
    },
    checkVersion: async (version) => {
      const result = await (await import('./updateCheck')).checkForVersion(version)
      latestReleaseUrl = result.state === 'available' ? result.url : latestReleaseUrl
      return result
    },
    verifiedFile: (kind) => verifiedFileOfKind(kind),
    download: async (file, dir, onProgress, signal) => {
      const [{ downloadVerifiedTo }, { net }] = await Promise.all([import('./updateDownload'), import('electron')])
      return downloadVerifiedTo(file, dir, ((url, init) => net.fetch(url as string, init)) as typeof fetch, signal, onProgress)
    },
    hashFile: async (path) => (await install()).hashFile(path),
    prepareDir: async (keep) => (await install()).prepareUpdateDir(app.getPath('userData'), keep),
    stage: async (method, path, file) => (await install()).stageUpdate(method, path, file),
    install: async (method, path, file) => (await install()).installUpdate(method, path, file),
    runPendingInstall: () => (IS_PACKAGED && !IS_E2E ? installSync?.runPendingInstall() ?? false : false),
    installOnQuit: (method, path, file) => {
      if (!installSync) return false
      if (e2eInstaller && isAbsolute(e2eInstaller) && e2eInstaller.endsWith('.mjs')) return installSync.runE2eQuitInstaller(e2eInstaller, method, path)
      return IS_PACKAGED && !IS_E2E ? installSync.installUpdateOnQuit(method, path, file) : false
    },
    getAutoDownload: () => currentSettings().autoUpdate !== false,
    setAutoDownload: (on) => updateSettings({ autoUpdate: on ? undefined : false }),
    emit: (status) => {
      if (status.progress.phase === 'ready' && !installSync) void install().then((m) => { installSync = m }).catch(() => undefined)
      send('update:status', status)
    },
    // スリープに入るところで OS が止めたダウンロードは送らない（次の確認でやり直す。FERRET-1N）
    report: (err, op) => { if (!isSuspendedNetworkError(err)) reportHandled(err, { area: 'update', op }) },
    failedMessage: () => t('update.errors.download')
  })
  return autoUpdates
}

/**
 * 「再起動して更新」の前に、作業中の Agent（処理中・確認待ち）と録画を数えて、あれば確かめる。
 * 未保存のファイルは、その後に同じ確認（resolveUnsavedBeforeQuit）で聞く（update:install）。E2E では聞かない
 * Orca由来: ~/bench/orca/src/main/updater/updater-install-execution.ts の「終了の前の後始末」（Orca は確認を出さずに PTY を閉じる）
 */
async function confirmRestartForUpdate(): Promise<boolean> {
  if (IS_E2E) return true
  const states = await Promise.all((terminals?.list() ?? []).map((info) => terminals!.agentState(info.id).catch(() => null)))
  const busy = states.filter((s) => s && (s.state === 'working' || s.state === 'blocked')).length
  const recordingNow = !!recording && recording.status.state !== 'idle'
  if (busy === 0 && !recordingNow) return true
  const options = {
    type: 'question' as const,
    buttons: [t('update.restart.confirm'), t('common.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: t('update.restart.title'),
    detail: [busy > 0 ? t('update.restart.agents', { count: busy }) : '', recordingNow ? t('update.restart.recording') : ''].filter(Boolean).join('\n')
  }
  const { response } = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
  return response === 0
}

/**
 * 依頼文（設定の「Agent への依頼」）を、開いているプロジェクトの Agent へ送る。宛先は「Agent へ送信」の auto と同じ。
 * オーケストレーターからなら、すべてのプロダクトに subagent で並行して行うよう添える（@shared/agentRequests）
 */
async function sendAgentRequests(ids: unknown): Promise<{ ok: boolean; message: string; noAgent?: boolean }> {
  const { sendAgentRequestsTo } = await import('./agentRequestSend')
  const result = await sendAgentRequestsTo({
    resolveTarget: async (folder) => (terminals ? terminals.resolveSendTarget(null, folder) : null),
    send: (id, text) => terminals!.sendReview(id, text),
    noAgentMessage: t('terminal.send.noAgent'),
    // 送った依頼をオーケストラのフィードバックの記録に足す（待たない）
    onSent: (picked) => recordFeedback(workspace.projectId, async (m, at) => m.recordFeedbackMessage(at.orchestra.folderPath, at.orchestra.name, {
      product: at.product, channel: 'request', text: (await import('@shared/feedbackLog')).requestsFeedbackText(picked)
    }))
  }, { ids, prefs: currentSettings().agentRequests, lang: guideLanguage(), project: currentSettings().projects.find((p) => p.id === workspace.projectId), folder: workspace.folderPath })
  if (result === 'empty') throw new UserFacingError(t('errors.emptyText'))
  return result
}

/**
 * 長い依頼の途中で PC を閉じた・Ferret を終了したときに、開き直したら続きから再開する。
 * - 終了：戻したタブは会話を続けて起動し（--continue / resume --last）、閉じたとき作業の途中だったペインには、入力欄が出たら続きを頼む
 * - スリープ：眠る前に作業の途中だった Agent を覚え、戻って少し待っても止まっていれば続きを頼む（通信が切れて止まった Agent など）
 * どちらも、もう動き出している Agent・確認を出している Agent には送らない
 */
const RESUME_AFTER_WAKE_MS = 20_000
const CONTINUE_WAIT_MS = 3 * 60_000
let workingBeforeSleep: string[] = []

async function continueInterruptedWork(id: string): Promise<boolean> {
  if (!terminals) return false
  const deadline = Date.now() + CONTINUE_WAIT_MS
  // 会話を開き直して入力を待つまで待つ（起動直後は unknown・作業中のことがある）
  for (;;) {
    const state = await terminals.agentState(id).catch(() => null)
    if (!state) return false
    if (state.kind !== 'unknown' && state.state === 'idle') break
    if (state.state === 'blocked' || Date.now() > deadline) return false
    await delay(2000)
  }
  const result = await terminals.sendReview(id, t('terminal.continueWork'))
  return result.ok
}

async function rememberWorkBeforeSleep(): Promise<void> {
  if (!terminals) return
  const list = terminals.list()
  const states = await Promise.all(list.map((info) => terminals!.agentState(info.id).catch(() => null)))
  workingBeforeSleep = list.filter((_, i) => states[i]?.state === 'working').map((info) => info.id)
}

async function resumeWorkAfterSleep(): Promise<void> {
  const ids = workingBeforeSleep
  workingBeforeSleep = []
  if (!terminals || !ids.length) return
  const alive = new Set(terminals.list().map((info) => info.id))
  await Promise.all(ids.filter((id) => alive.has(id)).map(async (id) => {
    const state = await terminals!.agentState(id).catch(() => null)
    // 戻ってからも動いている Agent はそのまま。止まって入力を待っているものだけに頼む
    if (state && state.kind !== 'unknown' && state.state === 'idle') await terminals!.sendReview(id, t('terminal.continueWork')).catch(() => undefined)
  }))
}

/** 開いているのが「すべてのプロダクト」か */
function isEditorWorkspaceOpen(): boolean {
  return !!currentSettings().projects.find((p) => p.id === workspace.projectId)?.editorWorkspace
}

/** 全体で録った1回のフィードバックを、プロダクトごとに分けて各 Agent へ並行して送る（src/main/productSplitSend.ts） */
async function sendSplitByProduct(
  paths: import('./sessions/paths').SessionPaths,
  items: ReadonlyArray<{ id: string; index: number; t: number; include: boolean; context: { url?: string } }>,
  pending: ReadonlySet<string>
): Promise<{ ok: boolean; message: string; terminalId?: string } | null> {
  const settings = currentSettings()
  const [{ sendSplitByProduct: send }, { reviewInstruction }] = await Promise.all([import('./productSplitSend'), import('./review')])
  return send({
    resolveTarget: (folder) => terminals!.resolveSendTarget(null, folder),
    send: (id, text) => terminals!.sendReview(id, text),
    t: (key, values) => t(key as Parameters<typeof t>[0], values)
  }, {
    // 開いているオーケストラに属するプロダクトだけ（外したもの・SSH は入れない）
    products: (() => { const o = openOrchestra(); return o ? orchestraMembers(settings.projects, o.id) : [] })(),
    items,
    pending,
    orchestraFolder: workspace.folderPath,
    instruction: await reviewInstruction(paths, settings.agentPrompt),
    feedbackPath: paths.feedbackMd
  })
}

/** 「すべてのプロダクト」で動いている Agent（プロダクトに Agent がいないときの渡し先） */
async function orchestraTarget(): Promise<{ terminalId: string; folder: string } | null> {
  const editor = openOrchestra()
  if (!editor || !terminals || editor.folderPath === workspace.folderPath) return null
  const id = await terminals.resolveSendTarget(null, editor.folderPath)
  return id ? { terminalId: id, folder: editor.folderPath } : null
}

/** 全体の Agent に渡すとき添える一文：このレビューはどのプロダクトのもので、どの subagent に任せるか */
async function orchestraNote(productFolder: string | null): Promise<string> {
  const settings = currentSettings()
  const product = settings.projects.find((p) => p.folderPath === productFolder)
  const editor = product ? currentOrchestra(settings.projects, product.id) : null
  if (!editor || !product) return ''
  const children = await (await import('./orchestrator')).findOrchestratorChildren(editor.folderPath, settings.projects, membersOf(editor)).catch(() => [])
  const child = children.find((c) => c.outside === product.folderPath || c.path === product.folderPath)
  return t('orchestra.relayNote', { name: product.name, path: product.folderPath, agent: child?.agent ?? 'general-purpose' })
}

/** 全プロダクトの確認待ち（before / after の確認）。確認の巡回に使う */
async function pendingAcross(): Promise<Array<{ projectId: string; reviewId: string; count: number }>> {
  const { listSessions } = await import('./sessions')
  const out: Array<{ projectId: string; reviewId: string; count: number }> = []
  const orchestra = openOrchestra()
  for (const project of orchestra ? orchestraMembers(currentSettings().projects, orchestra.id) : []) {
    const sessions = await listSessions(project.folderPath).catch(() => [])
    for (const s of sessions) if ((s.humanReviewCount ?? 0) > 0) out.push({ projectId: project.id, reviewId: s.id, count: s.humanReviewCount ?? 0 })
  }
  return out
}

// ───────────── オーケストラのフィードバックの記録（<オーケストラ>/feedback/。@shared/feedbackLog・src/main/feedbackLog.ts） ─────────────

/**
 * 人が送ったフィードバックを、そのプロジェクトのオーケストラに記録する。オーケストラに属さないプロジェクトは記録しない。
 * 送信を待たせない・失敗させない（結果を待たずに投げ、失敗は記録だけする）
 */
function recordFeedback(projectId: string | null | undefined, run: (m: typeof import('./feedbackLog'), target: { orchestra: Project; product: string }) => Promise<unknown>): void {
  void (async () => {
    const { feedbackTarget } = await import('@shared/feedbackLog')
    const target = feedbackTarget(currentSettings().projects, projectId)
    if (!target) return
    await run(await import('./feedbackLog'), target)
  })().catch((err: unknown) => reportHandled(err, { area: 'review', op: 'record orchestra feedback' }))
}

/**
 * 送ったレビューを記録する。ふつうの送信は送った指摘ごとに1組（枠の描かれた画像・枠の位置・文）、
 * 本文を差し替えた送信（確認への返答・NG の送り直し）はその本文を1件。全体で録ったものはプロダクトの名前を指摘の URL で分ける
 */
function recordSentReview(paths: SessionPaths, items: readonly import('./pipeline/types').FeedbackItem[], sendIds: readonly string[] | null, overrideText: string | undefined): void {
  const projectId = workspace.projectId
  recordFeedback(projectId, async (m, target) => {
    const { folderPath, name } = target.orchestra
    if (overrideText) return m.recordFeedbackMessage(folderPath, name, { product: target.product, channel: 'review', text: overrideText, reviewId: paths.id })
    const wanted = new Set(sendIds ?? [])
    const sent = items.filter((it) => it.include && wanted.has(it.id))
    if (!sent.length) return
    const names = new Map<number, string>()
    const project = currentSettings().projects.find((p) => p.id === projectId)
    if (project?.editorWorkspace) {
      const { splitByProduct } = await import('@shared/productSplit')
      const products = orchestraMembers(currentSettings().projects, project.id)
      for (const share of splitByProduct(products, sent.map((it) => ({ index: it.index, t: it.t, url: it.context.url })))) {
        const product = products.find((p) => p.id === share.projectId)
        if (product) for (const index of share.indexes) names.set(index, product.name)
      }
    }
    const events = await (await import('./sessions')).readEvents(paths).catch(() => [])
    return m.recordReviewSent(folderPath, name, {
      projectId: projectId ?? '', reviewId: paths.id, reviewDir: paths.dir, events,
      items: sent.map((item) => ({ product: names.get(item.index) ?? target.product, item }))
    })
  })
}

/** 記録するオーケストラがあるときだけ、変える前の progress.json を読む（Agent の直しを、人の判断で消える前に残す） */
async function progressBeforeChange(paths: SessionPaths): Promise<import('@shared/findingProgress').ProgressMap | null> {
  const { feedbackTarget } = await import('@shared/feedbackLog')
  if (!feedbackTarget(currentSettings().projects, workspace.projectId)) return null
  return (await import('./sessions')).readProgress(paths).catch(() => null)
}

/** progress.json の値（変える前・後の順）から、Agent が直したこと・人の反応を記録する */
function recordProgressFeedback(paths: SessionPaths, maps: ReadonlyArray<import('@shared/findingProgress').ProgressMap | null>, projectId = workspace.projectId): void {
  recordFeedback(projectId, async (m, target) => {
    for (const progress of maps) {
      if (progress) await m.recordReviewProgress(target.orchestra.folderPath, target.orchestra.name, { projectId: projectId ?? '', reviewId: paths.id, reviewDir: paths.dir, progress })
    }
  })
}

/** Agent が progress.json を書いた（ファイルの見張りから）。開いているプロジェクトのレビューだけ */
function recordProgressFromDisk(ids: readonly string[]): void {
  const folder = workspace.folderPath
  const projectId = workspace.projectId
  if (!folder || !ids.length) return
  void (async () => {
    const { feedbackTarget } = await import('@shared/feedbackLog')
    if (!feedbackTarget(currentSettings().projects, projectId)) return
    const { readProgress, sessionPaths } = await import('./sessions')
    for (const id of ids) {
      const paths = sessionPaths(folder, id)
      recordProgressFeedback(paths, [await readProgress(paths).catch(() => null)], projectId)
    }
  })().catch((err: unknown) => reportHandled(err, { area: 'review', op: 'record orchestra feedback' }))
}

/**
 * オーケストレーターのプロジェクトから送るとき、指示文の後ろに「どの子の subagent に任せるか」を足す。
 * 子が見つからない・読めないときはそのまま
 */
async function withOrchestratorNote(text: string): Promise<string> {
  const project = currentSettings().projects.find((p) => p.id === workspace.projectId)
  if (!project?.orchestrator || project.source === 'ssh') return text
  try {
    const [{ findOrchestratorChildren }, { childList }] = await Promise.all([import('./orchestrator'), import('@shared/orchestrator')])
    const children = await findOrchestratorChildren(project.folderPath, currentSettings().projects, membersOf(project))
    return children.length ? `${text}\n\n${t('orchestrator.reviewNote', { children: childList(children) })}` : text
  } catch (err) {
    reportHandled(err, { area: 'review', op: 'list orchestrator children' })
    return text
  }
}

/**
 * レビュー履歴を読む・整理するフォルダ。省略時は開いているプロジェクト。
 * 別フォルダは登録済みプロジェクトに限る（renderer から任意のパスを読ませない・消させない）。
 */
function historyFolder(folderPath: unknown): string | null {
  if (folderPath === undefined || folderPath === null) return workspace.folderPath
  const target = typeof folderPath === 'string' ? findProjectByFolder(currentSettings().projects, folderPath)?.folderPath ?? null : null
  if (!target) throw new UserFacingError(t('errors.folderNotRegistered'))
  return target
}

/**
 * パンくずを残す IPC。失敗したとき、直前にどの操作をしたかが分かるようにする（引数の値は入れない）。
 * 設定の保存はどの節かだけ、パネルの移動と開閉は settings:layout / settings:splitRatio。
 */
const FLOW_CHANNELS: Partial<Record<string, string>> = {
  'project:switch': 'project switch', 'project:add': 'project add', 'project:remove': 'project remove', 'workspace:open': 'project open folder', 'project:addDropped': 'project add dropped',
  'recording:start': 'recording start', 'recording:stop': 'recording stop', 'recording:pause': 'recording pause', 'recording:resume': 'recording resume',
  'review:organize': 'organize', 'review:send': 'send to agent', 'terminal:close': 'terminal close',
  'app:checkUpdate': 'update check', 'settings:layout': 'layout change', 'settings:splitRatio': 'layout resize'
}

function flowOf(channel: string): { name: string; data?: Record<string, string> } | null {
  const name = FLOW_CHANNELS[channel]
  if (name) return { name }
  if (channel.startsWith('settings:')) return { name: 'settings save', data: { section: channel.slice('settings:'.length) } }
  return null
}

/*
 * 発信（X への投稿の下書き。src/main/publish/）。下書きの控えと AI の生成の順番待ちは1つだけ持つ（2つ作ると書き込みが互いを上書きする）。
 * AI は「整理」と同じ実行方法（settings.json の organizer.runner。CLI は各自の契約、api: は保存したキー）を使う
 */
const publishStore = new PublishStore(app.getPath('userData'))
const publishBackground = new PublishBackground({
  project: () => (workspace.projectId && workspace.folderPath && !isRemoteWorkspace() ? { id: workspace.projectId, dir: workspace.folderPath } : null),
  store: publishStore,
  makeRunner: () => publishRunner(),
  workDir: () => join(app.getPath('userData'), 'publish', 'work'),
  language: () => guideLanguage(),
  onChanged: () => send('publish:changed')
})

/** 発信の接続先（X のトークン・ブログの秘密）。文字起こしのキーと同じく、配布版は OS の鍵で暗号化して保存する */
let publishConnectionStore: PublishConnections | null = null
function publishConnections(): PublishConnections {
  publishConnectionStore ??= new PublishConnections(join(app.getPath('userData'), 'publish-connections.bin'),
    chooseKeyCipher({ isPackaged: IS_PACKAGED, isE2E: IS_E2E, safeStorage }))
  return publishConnectionStore
}

/** 発信の下書きを書く AI。使えなければ null */
async function publishRunner(): Promise<import('./pipeline/organize/runner').LlmRunner | null> {
  const organizer = currentSettings().organizer
  const runnerId = organizer?.runner ?? 'codex'
  const project = workspace.folderPath
  if (!project) return null
  const { CodexRunner, ClaudeCodeRunner } = await import('./pipeline/organize')
  if (runnerId.startsWith('api:')) {
    const [{ ApiLlmRunner }, { LLM_PROVIDER_PRESETS, resolveEndpoint }] = await Promise.all([import('./pipeline/organize/runners/api'), import('@shared/aiProviders')])
    const provider = runnerId.slice(4) as keyof typeof LLM_PROVIDER_PRESETS
    const endpoint = organizer?.endpoints?.[provider]
    const vendor = LLM_PROVIDER_PRESETS[provider].vendor
    const resolved = resolveEndpointRefs(endpoint, keyLookup())
    // 認証情報は認めた接続元にだけ送る（security-5 [6]。整理と同じ確かめ方）
    await gateCredentials(`organize:${provider}`, resolveEndpoint(LLM_PROVIDER_PRESETS[provider], resolved).baseUrl, endpoint, vendor, [LLM_PROVIDER_PRESETS[provider].baseUrl], false)
    const runner = new ApiLlmRunner({ provider, endpoint: resolved, apiKey: await providerKey(endpoint, vendor) })
    return await runner.available() ? runner : null
  }
  const cliModels = organizer?.cliModels
  const runner = runnerId === 'claude-code'
    ? new ClaudeCodeRunner({ project, accountEnv: () => resolveAgentEnv('claude'), ...(cliModels?.['claude-code'] ? { model: cliModels['claude-code'] } : {}) })
    : new CodexRunner({ project, accountEnv: () => resolveAgentEnv('codex'), ...(cliModels?.codex ? { model: cliModels.codex } : {}) })
  return await runner.available() ? runner : null
}

/** 下書きに付けた画像・動画の小さな見本（動画は OS のサムネイル。作れなければ無し） */
async function publishThumbnail(path: string, kind: 'image' | 'video'): Promise<string | undefined> {
  const size = { width: 176, height: 176 }
  try {
    const image = await nativeImage.createThumbnailFromPath(path, size)
    if (!image.isEmpty()) return image.toDataURL()
  } catch {
    // Linux などで OS のサムネイルが無い（画像は読み込んで縮める。動画は名前だけ出す）
  }
  if (kind !== 'image') return undefined
  const image = nativeImage.createFromPath(path)
  return image.isEmpty() ? undefined : image.resize({ width: size.width }).toDataURL()
}

/**
 * 動画づくり（src/video/app/main/）へ渡すもの。動画のコードは workspace・terminals を直接触らず、これを通す。
 * 送り先は agent:sendText と同じ（選んでいるターミナル → 同じプロジェクトの Agent）
 */
const videoContext: VideoMainContext = {
  folderPath: () => workspace.folderPath,
  project: () => {
    const found = workspace.projectId ? currentSettings().projects.find((p) => p.id === workspace.projectId) : undefined
    return found ? { id: found.id, name: found.name, ...(found.kind ? { kind: found.kind } : {}) } : null
  },
  send: (channel, ...args) => (send as (c: string, ...a: unknown[]) => void)(channel, ...args),
  mainWindow: () => mainWindow,
  get userDataDir() { return app.getPath('userData') },
  // 配布版では CLI・録画のページを app.asar.unpacked から読む（Electron の Node は asar の中のファイルを実行できない）
  appOutDir: join(__dirname, '..').replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'),
  isPackaged: IS_PACKAGED,
  sendToAgent: async (text) => {
    const target = terminals ? await terminals.resolveSendTarget(null, workspace.folderPath) : null
    if (!target) return { ok: false, message: t('terminal.send.noAgent'), noAgent: true }
    return terminals!.sendReview(target, text)
  },
  // 確認の画面の「喋って囲む」の文字起こし（録画・mtg の取り込みと同じ設定のエンジン）
  transcribe: async (wavPath, options) => {
    const stt = await sttEngineFor(currentSettings().capture?.transcription ?? 'local', options?.language ?? currentSettings().capture?.language ?? 'auto')
    if (!stt.engine) return { segments: [], ...(stt.warning ? { warning: stt.warning } : {}) }
    try {
      const result = await stt.engine.transcribeChunk({ wavPath, offsetMs: 0, speaker: 'self', source: 'mic' })
      return { segments: result.segments.map(({ t0, t1, text }) => ({ t0, t1, text })) }
    } catch (err) {
      reportHandled(err, { area: 'stt', op: 'transcribe video feedback' })
      return { segments: [], warning: t('errors.transcriptionFailed', { message: err instanceof Error ? err.message : String(err) }) }
    }
  },
  // 動画の撮影とレビューの録画は同時に使わない（逆向きは recording:start・note:setMode が videoCaptureActive() を見る）
  reviewRecording: () => recordingBusy || (!!recording && recording.status.state !== 'idle'),
  consumeGesture: (action) => gestures.consume(action),
  reportHandled
}

function registerIpc(): void {
  const handlers: { [C in keyof IpcRequests]: (...args: Parameters<IpcRequests[C]>) => unknown } = {
    // 動画づくり（video: のチャネル。src/video/app/main/ipc.ts）
    ...createVideoIpcHandlers(videoContext),
    // ビジネス（src/main/business/）とビジネスリサーチ（src/main/research/）。フォルダは開いているプロジェクトだけ（SSH は除く）
    ...ventureHandlers({
      userData: app.getPath('userData'),
      isPackaged: IS_PACKAGED,
      isE2E: IS_E2E,
      safeStorage,
      dialog,
      root: () => (workspace.folderPath && !isRemoteWorkspace() ? workspace.folderPath : null),
      projects: () => currentSettings().projects,
      terminals: () => terminals,
      browserContents: () => browser?.contents ?? null,
      // 証拠に追加（ビジネス）: 許可（gestures の 'screenshot'。1回きり）を使えたときだけ wire.ts から呼ばれる
      shootPage: async (contents) => { const image = await contents.capturePage(); return image.isEmpty() ? new Uint8Array() : image.toPNG() },
      consume: (kind) => gestures.consume(kind),
      window: () => mainWindow,
      locale: guideLanguage,
      manual: businessManual,
      knowledge: guideLanguage() === 'en' ? researchKnowledgeEn : researchKnowledge,
      founder: founderText,
      registerResearch: (folder) => {
        assertNotRecording()
        const project = registerVentureProject(folder, { research: true })
        openProject(project)
        return { projectId: project.id }
      },
      // 「プロジェクトにする」はビジネス（オーケストラ粒度。src/main/venture/）を作り、その中にビジネス記録を入れる
      registerBusiness: ventureForBusiness(ventureWiring())
    }),
    // ビジネス（venture: のチャネル。src/main/venture/wire.ts）
    ...ventureOpsHandlers(ventureWiring()),
    'app:ready': (paintedAt) => {
      markAt('renderer:painted', paintedAt)
      // 更新した直後の Windows は、最初のタブの前に node-pty のファイルを裏で読んで OS の検査を済ませる（操作可能になってから。FERRET-M）
      if (launchedNewVersion && !prereadStarted) {
        prereadStarted = true
        void prereadNodePtyBinaries().catch(() => undefined)
      }
      return reportInteractive()
    },
    // 平文の apiKey は renderer へ渡さない
    'app:settings': () => redactKeys({ ...currentSettings() }),
    'settingsFile:info': () => settingsFileInfo(),
    'settingsFile:read': () => readSettingsText(),
    'settingsFile:write': (text) => {
      if (typeof text !== 'string') throw new UserFacingError(t('settingsFile.invalidText'))
      return writeSettingsText(text)
    },
    'settingsFile:reveal': () => shell.showItemInFolder(settingsFileInfo().path),
    'settings:feedbackTargets': (prefs) => updateSettings({ feedbackTargets: { ...currentSettings().feedbackTargets, ...prefs } }),
    'app:version': () => ({ version: appVersion(), packaged: IS_PACKAGED }),
    // 確かめた結果を返す。新しい版があり自動のダウンロードがオンなら、続けて裏でダウンロードする（autoUpdate.ts）
    'app:checkUpdate': () => autoUpdater().checkNow(),
    'update:status': () => autoUpdater().status(),
    'update:download': () => autoUpdater().download(),
    'update:install': async () => {
      const updates = autoUpdater()
      const progress = updates.status().progress
      if (progress.phase !== 'ready') return false
      // 再起動するときだけ確かめる（deb はインストーラーを開くだけで、アプリは閉じない）
      if (progress.action === 'restart') {
        if (!(await confirmRestartForUpdate())) return false
        // 未保存のファイルは、終了のときと同じ確認で聞く（保存して再起動・保存せずに再起動・プロジェクトを開く・キャンセル）
        if (unsavedPromptOpen) return false
        unsavedPromptOpen = true
        try {
          if (!(await resolveUnsavedBeforeQuit())) return false
        } finally {
          unsavedPromptOpen = false
        }
      }
      const installed = await updates.install()
      // 入れられなかった（終了しない）なら、次の終了でまた聞く
      if (!installed) discardUnsavedConfirmed = false
      return installed
    },
    'update:setAutoDownload': (on) => {
      autoUpdater().setAutoDownload(on === true)
      return autoUpdater().status()
    },
    // 版を選んで入れる（配信元の versions.json の版から。古い版へ戻すことも含む）。中身は新しい版と同じく署名で確かめる
    'update:versions': async () => {
      const { listReleaseVersions } = await import('./updateCheck')
      return { current: appVersion(), pinned: autoUpdater().pinnedVersion(), versions: await listReleaseVersions() }
    },
    'update:chooseVersion': async (version) => {
      if (typeof version !== 'string') throw new UserFacingError(t('update.errors.badVersion', { tag: String(version) }))
      const { listReleaseVersions } = await import('./updateCheck')
      const latest = (await listReleaseVersions())[0]?.version ?? null
      return autoUpdater().chooseVersion(version, latest)
    },
    'resources:snapshot': () => resources.collect(),
    'resources:kill': (target) => {
      if (target.kind === 'terminal') terminals?.close(target.id)
      else {
        // 入力欄からの遷移（navigate）は http(s) に限るので、空ページは直接読む
        const wc = browser?.contents
        // 空ページへの切り替えは、前の読み込みの中断（ERR_ABORTED）で拒否されることがある。想定内なので送らない
        if (wc && !wc.isDestroyed()) void wc.loadURL('about:blank').catch(() => undefined)
      }
    },
    'resources:cleanup': () => {
      const ids = resources.orphanIds()
      for (const id of ids) terminals?.close(id)
      return ids.length
    },
    'app:openExternal': async (url) => {
      const { isSafeExternalUrl } = await import('@shared/setupGuide')
      // renderer から任意の URL を開かせない（file: や javascript: などは断る）
      if (!isSafeExternalUrl(url)) throw new UserFacingError(t('errors.unsafeLink'))
      await shell.openExternal(url)
    },
    'agent:sendText': async (text, feedback) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new UserFacingError(t('errors.emptyText'))
      // 宛先は「Agent へ送信」の auto と同じ（選んでいるターミナル → 同じプロジェクトの Agent）
      const target = terminals ? await terminals.resolveSendTarget(null, workspace.folderPath) : null
      if (!target) return { ok: false, message: t('terminal.send.noAgent'), noAgent: true }
      const { ok, message } = await terminals!.sendReview(target, text)
      // 人が打ったフィードバック（feedback）だけを、オーケストラのフィードバックの記録に足す（設定の手順の依頼などは残さない）
      if (ok && feedback && typeof feedback === 'object' && typeof feedback.text === 'string' && feedback.text.trim()) {
        recordFeedback(workspace.projectId, (m, at) => m.recordFeedbackMessage(at.orchestra.folderPath, at.orchestra.name, {
          product: typeof feedback.product === 'string' && feedback.product.trim() ? feedback.product : at.product, channel: 'text', text: feedback.text
        }))
      }
      return { ok, message }
    },
    'app:openUpdate': async () => {
      // 署名を確かめたこの OS・CPU 向けのファイルは、アプリが落として sha256 を確かめてから置く（security-4 [7]）
      const file = verifiedDownload()
      if (!file) {
        // この OS・CPU 向けのファイルが無い版だけ、ダウンロードページを開く（ページも署名と中身を確かめる）
        if (latestReleaseUrl) void shell.openExternal(latestReleaseUrl).catch((err: unknown) => reportHandled(err, { area: 'update', op: 'open release page' }))
        return
      }
      const [{ downloadVerifiedUpdate }, { net }] = await Promise.all([import('./updateDownload'), import('electron')])
      try {
        shell.showItemInFolder(await downloadVerifiedUpdate(file, app.getPath('downloads'), ((url, init) => net.fetch(url as string, init)) as typeof fetch))
      } catch (err) {
        reportHandled(err, { area: 'update', op: 'download update' })
        throw new UserFacingError(t('update.errors.download'))
      }
    },

    'workspace:open': () => openFolderDialog(),
    'workspace:current': () => workspace,

    'project:list': () => projectsState(),
    'project:add': async () => {
      assertNotRecording()
      const folder = await pickFolder()
      if (!folder) return null
      openFolderAsProject(folder)
      return projectsState()
    },
    'project:switch': (id) => {
      const project = currentSettings().projects.find((p) => p.id === id)
      if (!project) throw new UserFacingError(t('errors.projectNotFound'))
      if (workspace.projectId === id) return workspace
      assertNotRecording()
      return openProject(project)
    },
    'project:update': (project) => updateProject(project),
    'project:orchestrator': (id, enabled) => setProjectOrchestrator(id, enabled),
    'project:remove': (id) => removeProject(id),
    'project:sshHosts': async () => (await import('./projectSources')).listSshHosts(),
    'project:githubRepos': async () => (await import('./projectSources')).listGitHubRepos(),
    'project:gitlabRepos': async () => (await import('./github/gitlab')).listGitLabRepos(),
    'project:cloneDefaults': async () => ({ parent: (await import('./projectSources')).defaultCloneParent(), home: homedir() }),
    'project:pickParent': async (current) => {
      const window = mainWindow
      if (!window || window.isDestroyed()) return null
      const result = await dialog.showOpenDialog(window, {
        title: t('projectSource.pickParent'),
        properties: ['openDirectory', 'createDirectory'],
        ...(typeof current === 'string' && current ? { defaultPath: current } : {})
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    'project:clone': async (url, parent) => {
      assertNotRecording()
      if (typeof url !== 'string' || typeof parent !== 'string') return { ok: false as const, kind: 'failed' as const, detail: 'invalid input' }
      const { cloneRepository } = await import('./projectSources')
      const outcome = await cloneRepository({ url, parent }, (progress) => send('project:cloneProgress', progress))
      if (!outcome.ok) return outcome
      // 利用者が入れた URL のリモートは、裏で確認してよいものとして始める（security-7 [9]）
      await (await gitSyncModule()).approveClonedRemote(outcome.path, outcome.url).catch(() => undefined)
      openClonedProject(outcome.path, outcome.url)
      return { ok: true as const, state: projectsState() }
    },
    'project:cloneCancel': async () => (await import('./projectSources')).cancelClone(),
    'project:addSsh': (target, name) => addSshProject(target, typeof name === 'string' ? name : undefined),
    'project:addDropped': async (path) => {
      // 落とされて drop:inspect で確かめたフォルダだけ（renderer から任意のフォルダを登録させない）
      const folder = await droppedFolder(path)
      if (!folder) throw new UserFacingError(t('drop.errors.notFolder'))
      assertNotRecording()
      openFolderAsProject(folder)
      return projectsState()
    },
    'orchestra:create': (name) => createOrchestra(name),
    'project:move': (id, toOrchestraId, beforeId) => moveProjectInTree(id, toOrchestraId, beforeId),
    'project:reorder': (ids) => {
      updateSettings({ projects: reorderProjects(currentSettings().projects, ids) })
      send('projects:changed', projectsState())
      return projectsState()
    },
    'drop:inspect': (paths) => inspectDropped(paths, workspace.folderPath),
    'project:saveSession': (id, session) => {
      const { projects } = currentSettings()
      if (!projects.some((p) => p.id === id) || !session || typeof session !== 'object') return
      // renderer が持つ項目だけを受け取る（URL は main が覚える）。送られてこなかった項目は前の値のまま
      const patch: Partial<ProjectSession> = {}
      if ('centerTab' in session) patch.centerTab = session.centerTab
      if ('openFiles' in session) patch.openFiles = session.openFiles
      if ('reviewId' in session) patch.reviewId = session.reviewId ?? undefined
      updateSettings({ projects: withProjectSession(projects, id, patch) })
    },

    'settings:agents': (preferences) => {
      updateSettings({ agents: preferences })
      syncTerminalRestore()
      syncAgentMailSkillNow()
      // 「＋」メニューと設定画面に、保存した結果（sanitize 後）と検出を配る
      void listAgentOptions(currentSettings().agents).then((options) => send('agents:changed', options))
    },
    'agents:list': (refresh) => listAgentOptions(currentSettings().agents, refresh === true),
    'cliTools:list': (refresh) => listCliTools(refresh === true),
    'agents:resources': (agent) => listAgentResources(String(agent) as Parameters<typeof listAgentResources>[0], workspace.folderPath ?? null),
    'settings:agentPrompt': (template) => updateSettings({ agentPrompt: typeof template === 'string' ? template : undefined }),
    'settings:agentRequests': async (prefs) => {
      const { sanitizeAgentRequestPrefs } = await import('@shared/agentRequests')
      updateSettings({ agentRequests: sanitizeAgentRequestPrefs(prefs) })
    },
    'agentRequests:send': (ids) => sendAgentRequests(ids),
    'review:pendingAcross': () => pendingAcross(),
    'orchestra:overview': async () => {
      const [{ orchestraOverview }, { listSessions }] = await Promise.all([import('./orchestraOverview'), import('./sessions')])
      return orchestraOverview(currentSettings().projects, openOrchestra(), listSessions)
    },
    'orchestra:checklist': async () => {
      const editor = openOrchestra()
      return editor ? (await (await import('./orchestraOverview')).readChecklist(editor.folderPath)).items : []
    },
    'orchestra:answer': async (entries) => {
      const editor = openOrchestra()
      if (!editor) return []
      const list = Array.isArray(entries) ? entries.slice(0, 500).filter((e): e is { key: string; answer: string } => !!e && typeof e === 'object' && typeof e.key === 'string' && typeof e.answer === 'string') : []
      return (await import('./orchestraOverview')).writeAnswers(editor.folderPath, list, guideLanguage())
    },
    'orchestra:feedbackFile': async (which) => {
      const editor = openOrchestra()
      if (!editor || editor.source === 'ssh') throw new UserFacingError(t('errors.openProjectFolder'))
      return (await import('./feedbackLog')).ensureFeedbackFile(editor.folderPath, editor.name, which === 'playbook' ? 'playbook' : 'log')
    },
    'orchestra:sendAnswers': async () => {
      const editor = openOrchestra()
      if (!editor) return { ok: false, message: t('orchestra.answersNone') }
      const [{ readChecklist }, { composeAnswersMessage }] = await Promise.all([import('./orchestraOverview'), import('@shared/humanChecklist')])
      const { items } = await readChecklist(editor.folderPath)
      if (!items.some((it) => it.answer)) return { ok: false, message: t('orchestra.answersNone') }
      // 宛先は全体（すべてのプロダクト）のフォルダの Agent
      const target = terminals ? await terminals.resolveSendTarget(null, editor.folderPath) : null
      if (!target) return { ok: false, message: t('terminal.send.noAgent'), noAgent: true }
      const { ok, message } = await terminals!.sendReview(target, composeAnswersMessage(items, guideLanguage(), currentSettings().orchestra?.allowed))
      if (ok) {
        recordFeedback(editor.id, async (m, at) => m.recordFeedbackMessage(at.orchestra.folderPath, at.orchestra.name, {
          product: at.product, channel: 'answers', text: (await import('@shared/feedbackLog')).answersFeedbackText(items)
        }))
      }
      return { ok, message: ok ? t('orchestra.answersSent', { count: items.filter((it) => it.answer).length }) : message }
    },
    'settings:orchestraAllowed': async (allowed) => {
      const { sanitizeOrchestraRules } = await import('@shared/orchestrator')
      updateSettings({ orchestra: sanitizeOrchestraRules({ ...currentSettings().orchestra, allowed: typeof allowed === 'string' ? allowed : '' }) })
      syncEditorWorkspace()
    },
    'settings:orchestra': async (rules) => {
      const { sanitizeOrchestraRules } = await import('@shared/orchestrator')
      updateSettings({ orchestra: sanitizeOrchestraRules(rules) })
      // 全体の CLAUDE.md・subagent に書き直す
      syncEditorWorkspace()
    },

    // Claude Code / Codex のアカウント（src/main/accounts）。renderer からの値は種類を確かめてから使う
    'accounts:list': () => listAgentAccounts(),
    'accounts:add': (agent) => addAgentAccount(requireTuiAgent(agent)),
    'accounts:rename': (agent, accountId, label) => renameAgentAccount(requireTuiAgent(agent), String(accountId), String(label ?? '')),
    'accounts:remove': (agent, accountId) => removeAgentAccount(requireTuiAgent(agent), String(accountId)),
    'accounts:select': async (agent, accountId) => {
      const target = requireTuiAgent(agent)
      const id = accountId === null ? null : String(accountId)
      const state = await selectAgentAccount(target, id)
      // 選んだアカウントを、いま動いているその Agent のタブにも効かせる（待機中になったものから引き継いで開き直す。failover/service.ts）
      if (isAccountAgent(target)) await switchRunningAgents(target, id).catch((err: unknown) => reportHandled(err, { area: 'accounts', op: 'switch running agents' }))
      return state
    },
    'accounts:relogin': (agent, accountId) => reloginAgentAccount(requireTuiAgent(agent), String(accountId)),
    'usage:get': () => getUsageState(),
    'usage:refresh': (force) => refreshUsage(force === true),
    'failover:get': () => failoverPrefs(),
    'failover:set': (prefs) => setFailoverPrefs(prefs),
    'agentNotify:show': (request) => showAgentNotification(request, {
      enabled: () => currentSettings().agents.notify,
      projects: () => currentSettings().projects,
      supported: () => Notification.isSupported(),
      create: (options) => new Notification(options),
      open: (target) => {
        const window = mainWindow
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          if (!window.isVisible() && !HIDE_WINDOW) window.show()
          window.focus()
        }
        send('agentNotify:open', target)
      }
    }),
    'usage:accounts': (agent, force) => getAccountUsage(requireTuiAgent(agent), force === true),

    'mode:set': (next) => {
      if (mode === next) return
      mode = next
      setTelemetryContext({ mode: next })
      send('mode:changed', mode)
    },

    'browser:setBounds': (bounds) => browser?.setBounds(bounds),
    'browser:navigate': (url) => {
      // ウインドウを映している間に URL を開いたら、内蔵ブラウザへ戻す（録画中は録画の対象を変えない）。狭める向きなので操作の許可は要らない
      if (captureConsent.target.kind === 'window' && (recording?.status.state ?? 'idle') === 'idle') setCaptureTargetFromMain({ kind: 'browser' })
      return browser?.navigate(url)
    },
    'browser:newTab': (url) => browser?.newTab(typeof url === 'string' ? url.slice(0, 8000) : '').then(() => undefined),
    'browser:closeTab': (id) => { if (typeof id === 'string') browser?.closeTab(id) },
    'browser:tabMenu': (id, at) => {
      const window = mainWindow
      if (typeof id !== 'string' || !browser || !window || window.isDestroyed()) return
      const ids = browser.tabIds()
      if (!ids.includes(id)) return
      const x = Number(at?.x)
      const y = Number(at?.y)
      const items: Electron.MenuItemConstructorOptions[] = BROWSER_TAB_CLOSE_ACTIONS.map((action) => {
        const closing = browserTabsToClose(action, id, ids)
        return {
          label: t(`browser.tabs.menu.${action}`),
          enabled: closing.length > 0,
          click: () => browser?.closeTabs(closing, action === 'closeOthers' || action === 'closeRight' ? id : null)
        }
      })
      // 先頭の「閉じる」と、まとめて閉じる項目の間に線を引く
      items.splice(1, 0, { type: 'separator' })
      Menu.buildFromTemplate(items).popup({ window, x: Math.round(Number.isFinite(x) ? x : 0), y: Math.round(Number.isFinite(y) ? y : 0) })
    },
    'browser:activateTab': (id) => { if (typeof id === 'string') browser?.activateTab(id) },
    'browser:back': () => browser?.back(),
    'browser:forward': () => browser?.forward(),
    'browser:reload': () => browser?.reload(),
    'browser:openExternal': async () => {
      // renderer から URL を受け取らない（URL を同意にしない）。開くのは今のタブの URL で、http / https だけ
      const url = browser?.state().url ?? ''
      if (!isBrowserPageExternalUrl(url)) throw new UserFacingError(t('errors.unsafePage'))
      await shell.openExternal(url)
    },
    'browser:setViewport': (viewport) => {
      updateSettings({ viewport })
      browser?.setViewport(viewport)
    },
    'browserExtensions:list': () => extensions?.list() ?? [],
    'browserExtensions:addFolder': async () => {
      const ext = requireExtensionsEditable()
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const options: Electron.OpenDialogOptions = { title: t('browserExtensions.pickFolder'), properties: ['openDirectory'] }
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      const path = picked.canceled ? undefined : picked.filePaths[0]
      if (!path) return null
      if (!(await ext.inspectFolder(path))) throw new UserFacingError(t('browserExtensions.errors.notExtension'))
      return saveExtensionEntries(ext, (entries) => entries.some((e) => e.path === path) ? entries.map((e) => e.path === path ? { path } : e) : [...entries, { path }])
    },
    'browserExtensions:scanInstalled': async () => {
      const found = await (extensions?.scanInstalled(homedir()) ?? Promise.resolve([]))
      installedExtensions = new Map(found.map((f) => [f.key, { id: f.id, dir: f.dir }]))
      return found.map(({ dir: _dir, ...rest }) => rest)
    },
    'browserExtensions:import': async (key) => {
      const ext = requireExtensionsEditable()
      // 直前に main が見つけた候補だけ（画面が送るのは key だけ）
      const candidate = installedExtensions.get(String(key))
      if (!candidate) throw new UserFacingError(t('browserExtensions.errors.notFound'))
      const path = await ext.importInstalled(candidate)
      return saveExtensionEntries(ext, (entries) => entries.some((e) => e.path === path) ? entries.map((e) => e.path === path ? { path } : e) : [...entries, { path }])
    },
    'browserExtensions:setEnabled': (path, enabled) => {
      const ext = requireExtensionsEditable()
      return saveExtensionEntries(ext, (entries) => entries.map((e) => e.path === path ? (enabled === true ? { path: e.path } : { path: e.path, enabled: false }) : e))
    },
    'browserExtensions:remove': async (path) => {
      const ext = requireExtensionsEditable()
      const list = await saveExtensionEntries(ext, (entries) => entries.filter((e) => e.path !== path))
      // 外し終えてから、取り込んだ写しだけを消す（利用者の開発中のフォルダは消さない）
      await ext.deleteImportedCopy(String(path)).catch((err: unknown) => reportHandled(err, { area: 'browser', op: 'delete imported extension' }))
      return list
    },
    'browserExtensions:menu': async (at) => {
      const ext = extensions
      const window = mainWindow
      if (!ext || !window || window.isDestroyed()) return null
      const x = Number(at?.x)
      const y = Number(at?.y)
      const { webStoreExtensionId } = await import('@shared/browserExtensions')
      const onStorePage = !!webStoreExtensionId(browser?.state().url ?? '')
      return ext.showMenu(window, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 },
        { manage: t('browserExtensions.menu.manage'), options: t('browserExtensions.menu.options'), none: t('browserExtensions.menu.none'),
          ...(onStorePage ? { install: t('browserExtensions.menu.installThis') } : {}) })
    },
    'browserExtensions:open': (path) => {
      const ext = extensions
      if (!ext || typeof path !== 'string') return 'none'
      const info = ext.list().find((e) => e.path === path)
      if (!info?.id) return 'none'
      if (info.hasPopup) return ext.openPopup(path, 'popup') ? 'popup' : 'closed'
      if (info.hasOptions) return ext.openPopup(path, 'options') ? 'options' : 'closed'
      return 'none'
    },
    'browserExtensions:installFromStore': async (input) => {
      const ext = requireExtensionsEditable()
      const { webStoreExtensionId } = await import('@shared/browserExtensions')
      // 省いたら内蔵ブラウザでいま開いているストアのページ（URL は main が持つものを使う）
      const id = webStoreExtensionId(typeof input === 'string' && input.trim() ? input : browser?.state().url ?? '')
      if (!id) throw new UserFacingError(t('browserExtensions.errors.storeUrl'))
      const { WebStoreNotFoundError } = await import('./browserExtensions')
      const { CrxError } = await import('./crx')
      let path: string
      try {
        // ストアは配布の置き場（googleusercontent など）へ転送する。行き先は1回ずつ Google の置き場かを確かめ、中身は署名で確かめる
        const { downloadFromWebStore } = await import('./webStoreDownload')
        path = await ext.installFromWebStore(id, downloadFromWebStore, process.versions.chrome ?? '130.0.0.0')
      } catch (err) {
        if (err instanceof WebStoreNotFoundError) throw new UserFacingError(t('browserExtensions.errors.storeNotFound'))
        if (err instanceof CrxError) throw new UserFacingError(t('browserExtensions.errors.badPackage', { reason: err.message }))
        throw new UserFacingError(t('browserExtensions.errors.storeFailed'))
      }
      return saveExtensionEntries(ext, (entries) => entries.some((e) => e.path === path) ? entries.map((e) => e.path === path ? { path } : e) : [...entries, { path }])
    },
    'browserExtensions:addCrx': async () => {
      const ext = requireExtensionsEditable()
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const options: Electron.OpenDialogOptions = { title: t('browserExtensions.pickCrx'), properties: ['openFile'], filters: [{ name: 'Chrome extension', extensions: ['crx'] }] }
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      const file = picked.canceled ? undefined : picked.filePaths[0]
      if (!file) return null
      const { CRX_LIMITS, CrxError } = await import('./crx')
      const { readFileBounded } = await import('./boundedFile')
      let path: string
      try {
        path = await ext.installCrx(await readFileBounded(file, CRX_LIMITS.packageBytes))
      } catch (err) {
        if (err instanceof CrxError) throw new UserFacingError(t('browserExtensions.errors.badPackage', { reason: err.message }))
        throw err
      }
      return saveExtensionEntries(ext, (entries) => entries.some((e) => e.path === path) ? entries.map((e) => e.path === path ? { path } : e) : [...entries, { path }])
    },
    // ほかのブラウザからの取り込み（パスワードの CSV・履歴）と、保存したパスワードのログインの欄への入力（src/main/browserImport/ipc.ts）
    ...browserImportHandlers({
      window: () => mainWindow,
      pageContents: () => browser?.contents ?? null,
      userDataDir: () => app.getPath('userData'),
      isPackaged: IS_PACKAGED,
      isE2E: IS_E2E,
      notifyChanged: () => send('passwords:changed')
    }),
    // 発信（X とブログへの投稿。AI が書き、X API・WordPress・EmDash の API で投稿する。src/main/publish/ipc.ts）
    ...publishHandlers({
      projectId: () => workspace.projectId ?? null,
      projectDir: () => workspace.folderPath ?? null,
      store: publishStore,
      background: publishBackground,
      thumbnail: publishThumbnail,
      pickFiles: async () => {
        const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } = await import('@shared/publish')
        const options: Electron.OpenDialogOptions = { title: t('publish.pickMediaTitle'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('publish.media'), extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }] }
        const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
        return chosen.canceled ? [] : chosen.filePaths
      },
      connections: publishConnections(),
      fetcher: (url, init) => import('./netFetch').then(({ mainFetch }) => mainFetch(url, init)),
      openExternal: (url) => shell.openExternal(url),
      waitForCallback: (options) => waitForCallback(options),
      notifyChanged: () => send('publish:changed')
    }),
    // ログイン無しで誰でも指摘を送れる共有リンク（作る・届いた録画を取り込む。src/main/feedbackShare/ipc.ts）
    ...feedbackShareHandlers({
      projectId: () => workspace.projectId ?? null,
      projectDir: () => workspace.folderPath ?? null,
      fetch: (url, init) => import('electron').then(({ net }) => net.fetch(url, init)),
      // 開発版だけ、手元で動かした Worker（127.0.0.1 / localhost）に向けて確かめられる。配布版は常に share.ferretade.dev
      ...(!IS_PACKAGED && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.FERRET_SHARE_BASE ?? '') ? { base: process.env.FERRET_SHARE_BASE } : {}),
      userAgent: `${PRODUCT_NAME}/${app.getVersion()}`,
      installId: () => telemetryInstallId(),
      userDataDir: () => app.getPath('userData'),
      isPackaged: IS_PACKAGED,
      isE2E: IS_E2E,
      // 届いた録画は mtg と同じ流れ（文字起こし・コマ・書き込み）で指摘の候補にする（meeting/import.ts）
      importRecording: async ({ projectDir, recording, events, download }) => {
        const [{ importShareRecording }, r] = await Promise.all([import('./meeting/import'), import('./review')])
        return importShareRecording({
          projectDir, recording, events, download,
          sttEngine: () => sttEngineFor(currentSettings().capture?.transcription ?? 'local', currentSettings().capture?.language ?? 'auto'),
          urlPresets: (currentSettings().projects.find((p) => p.id === workspace.projectId)?.urls ?? []).flatMap((u) => (u.url ? [{ id: u.id, label: u.label, url: u.url, ...(u.purpose ? { purpose: u.purpose } : {}) }] : [])),
          createReview: r.createImportedReview,
          onProgress: (progress) => send('meeting:progress', progress)
        })
      }
    }),
    'browser:state': () =>
      browser?.state() ?? {
        url: '',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        viewport: 'desktop' as const
      },

    'terminal:create': async (options) => {
      if (!terminals) throw new UserFacingError(t('errors.terminalNotReady'))
      const extraArgs = await terminalPresetArgs(options)
      return terminals.create(options, { extraArgs }).then((info) => { resources.noteTerminalCreated(info.id); return info })
    },
    'terminal:write': (id, data) => terminals?.write(id, data),
    'terminal:resize': (id, size) => terminals?.resize(id, size),
    'terminal:ack': (id, chars) => { if (typeof id === 'string' && typeof chars === 'number') terminals?.ack(id, chars) },
    'terminal:close': (id) => terminals?.close(id),
    'terminal:screen': (id, text) => terminals?.updateScreen(id, text),
    'terminal:agentState': (id) => terminals?.agentState(id) ?? { kind: 'unknown', state: 'unknown' },
    'terminal:agentStates': (ids) => (Array.isArray(ids) ? terminals?.agentStates(ids.filter((id): id is string => typeof id === 'string').slice(0, 512)) : null) ?? [],
    'terminal:visible': (ids) => { if (Array.isArray(ids)) terminals?.setVisible(ids.filter((id): id is string => typeof id === 'string')) },
    'terminal:continueWork': (id) => (typeof id === 'string' ? continueInterruptedWork(id) : false),
    'terminal:cwd': (id) => terminals?.currentCwd(id) ?? null,
    // 端末への貼り付け（Windows / Linux の Ctrl+V）。クリップボードの中身は renderer へ返さない（security-7 [1]）。
    // キーを押した直後に1回だけ、アプリの窓にフォーカスがあり端末が選ばれているときに、OS の貼り付けをその窓に行わせる
    // （中身はふつうの貼り付けとして、フォーカスのある端末の入力欄に届く）。
    // その paste のイベントからは、クリップボードのファイル・画像を1回だけ取り込める（terminalPasteGrantAt → terminal:pasteFiles）
    'terminal:paste': () => {
      const win = mainWindow
      if (!win || win.isDestroyed() || !win.isFocused() || !terminalFocused || !gestures.consume('paste')) return false
      terminalPasteGrantAt = Date.now()
      win.webContents.paste()
      return true
    },
    // ターミナルへの貼り付けで、クリップボードのファイル・画像（スクリーンショット・動画）をプロジェクトの .ferret/pasted/ に写す。
    // 返すのは作ったものの絶対パスだけ（クリップボードの中身・元のパスは返さない。security-7 [1]）。押した直後の1回だけ
    'terminal:pasteFiles': async () => {
      const granted = Date.now() - terminalPasteGrantAt < 2000
      terminalPasteGrantAt = 0
      const win = mainWindow
      if (!win || win.isDestroyed() || !win.isFocused() || !terminalFocused || !(granted || gestures.consume('paste'))) return null
      // SSH のプロジェクトは Agent がリモートで動くので、手元に写したパスは使えない（ふつうの貼り付けにする）
      if (!workspace.folderPath || isRemoteWorkspace()) return null
      const root = projectRoot()
      const { pasteClipboardForTerminal } = await import('./clipboardFiles')
      return pasteClipboardForTerminal(root, clipboard, async (paths, destRel) => (await importEntries(root, paths, destRel, () => true)).map((d) => d.to))
    },
    // 選択範囲のコピー。キーを押した直後だけ書く（プログラムのコピーはこの道を通さない。terminal:programCopy）
    'terminal:writeClipboard': (text) => { if (typeof text === 'string' && text.length <= 8 * 1024 * 1024 && gestures.consume('copy')) clipboard.writeText(text) },
    // 端末のプログラムのコピー（OSC 52）。確認なしで写す。大きすぎるもの・アプリの窓にフォーカスが無いときは写さない（terminalClipboard.ts）
    'terminal:programCopy': (_id, text) => {
      const write = programCopyText(text, { windowFocused: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() })
      if (write === null) return false
      clipboard.writeText(write)
      return true
    },
    'terminal:focused': (focused) => { terminalFocused = focused === true },
    // 終了・閉じたあとに戻すタブと画面の文字（中身は main が確かめてから覚える。@shared/terminalRestore）
    'terminal:restoreSave': (snapshot) => {
      terminalRestore().save(snapshot)
      terminalRestoreCollected?.()
    },
    'terminal:restoreTake': () => terminalRestore().takeSession(new Set(currentSettings().projects.map((project) => project.id))),
    'terminal:closedPush': (entry) => terminalRestore().pushClosed(entry),
    'terminal:closedPop': (projectId) => terminalRestore().popClosed(typeof projectId === 'string' ? projectId : null),
    'terminal:restoreClear': () => terminalRestore().clear(),
    'terminal:list': () => terminals?.list() ?? [],
    'terminal:attach': (id) => {
      const info = terminals?.attach(String(id)) ?? null
      // つなぎ直したターミナルは今の画面のもの。置き去り（Resource Manager の片付けの対象）にしない
      if (info) resources.noteTerminalCreated(info.id)
      return info
    },
    'review:send': async (id, rawRequest) => {
      // 宛先（auto / Agent / タブ）と、差し替える本文。古い形（ターミナルの id だけ）も auto として読む（@shared/sendTarget）
      const { parseSendRequest } = await import('@shared/sendTarget')
      const request = parseSendRequest(rawRequest)
      const { checkedPaths, loadReviewAt, markSentInProgress, prepareSendFeedback, refreshFeedbackMarkdown, remoteReviewInstruction, reviewInstruction } = await import('./review')
      const paths = checkedPaths(workspace.folderPath, id)
      const data = await loadReviewAt(paths)
      if (!data.document.items.some((it) => it.include)) return { ok: false, message: t('errors.nothingToSend') }
      // 判定モデルの受け入れ確認の節を今の設定に合わせる。
      // 既定の送信は未対応の指摘だけを送る（done・in_progress・human_review は送らない）。feedback.md もその指摘だけを詳しく書く。
      // 本文を差し替えた送信（確認への返答）は1件だけを指すので、全件の feedback.md のまま
      let sendIds: string[] | null = null
      if (request.text) await refreshFeedbackMarkdown(paths)
      else if (!(sendIds = await prepareSendFeedback(paths)).length) return { ok: false, message: t('review.nothingPending') }
      // auto: 選んでいるターミナル → 同じプロジェクトの Agent。どこにも居なければ noAgent（renderer が既定の Agent を起動して送り直す）
      // agent: その Agent が動いているタブ。無ければ launchAgent（renderer がその Agent のタブを開いて送り直す）
      // terminal: そのタブ。Agent が抜けていれば、覚えていた Agent を launchAgent で返す
      const want = request.target
      // 全体（すべてのプロダクト）で録ったものは、指摘をプロダクトごとに分けて、それぞれの Agent へ並行して渡す（@shared/productSplit）
      if (terminals && want.kind === 'auto' && !request.text && isEditorWorkspaceOpen()) {
        const split = await sendSplitByProduct(paths, data.document.items, new Set(sendIds ?? []))
        if (split) {
          if (split.ok) {
            recordSentReview(paths, data.document.items, sendIds, undefined)
            await (await import('./sessions')).updateLabel(paths, { sentAt: new Date().toISOString() }).catch((err: unknown) => reportHandled(err, { area: 'review', op: 'record sent label' }))
            await markSentInProgress(paths).catch((err: unknown) => reportHandled(err, { area: 'review', op: 'mark sent in progress' }))
            recordStarMoment('first-send')
          }
          return split
        }
      }
      let target: string | null = null
      if (terminals && want.kind === 'auto') target = await terminals.resolveSendTarget(request.focusedTerminalId ?? null, workspace.folderPath)
      if (terminals && want.kind === 'agent') target = await terminals.findAgentTerminal(want.agent, workspace.folderPath)
      if (terminals && want.kind === 'terminal' && (await terminals.agentState(want.terminalId)).kind !== 'unknown') target = want.terminalId
      // このプロダクトに Agent がいなければ、「すべてのプロダクト」の Agent に渡す（そのプロダクトの subagent に任せる一文を添える）
      let viaOrchestra: string | null = null
      if (!target && terminals && want.kind === 'auto') {
        const relay = await orchestraTarget()
        if (relay) { target = relay.terminalId; viaOrchestra = await orchestraNote(workspace.folderPath) }
      }
      if (!target) {
        const launchAgent = want.kind === 'agent' ? want.agent : want.kind === 'terminal' ? want.agent ?? undefined : undefined
        return { ok: false, message: t('terminal.send.noAgent'), noAgent: true, ...(launchAgent ? { launchAgent } : {}) }
      }
      const instruction = request.text ?? (isRemoteWorkspace() ? await remoteReviewInstruction(paths) : await withOrchestratorNote(await reviewInstruction(paths, currentSettings().agentPrompt)))
      const result: { ok: boolean; message: string; terminalId?: string; submitted?: boolean } = { ...(await terminals!.sendReview(target, viaOrchestra ? `${instruction}\n\n${viaOrchestra}` : instruction)), terminalId: target }
      // 一覧の「送信済み」に使う。記録できなくても送信の結果は変えない
      if (result.ok) await (await import('./sessions')).updateLabel(paths, { sentAt: new Date().toISOString() }).catch((err: unknown) => reportHandled(err, { area: 'review', op: 'record sent label' }))
      // 送った指摘を対応中にする（Agent が progress.json で done にするまで）。書けなくても送信の結果は変えない。
      // 本文を差し替えた送信（確認への返答で1件だけ送り直す）は、その指摘だけを renderer が review:progress で戻す
      if (result.ok && !request.text) await markSentInProgress(paths).catch((err: unknown) => reportHandled(err, { area: 'review', op: 'mark sent in progress' }))
      if (result.ok) recordStarMoment('first-send')
      // オーケストラのフィードバックの記録（待たない・失敗しても送信の結果は変えない）
      if (result.ok) recordSentReview(paths, data.document.items, sendIds, request.text ?? undefined)
      return result
    },

    'settings:splitRatio': (ratio) => updateSettings({ splitRatio: ratio }),
    'settings:layout': (layout) => updateSettings({ layout: sanitizeLayout(layout) }),
    // Orca由来: ~/bench/orca/src/main/ipc/settings.ts の nativeTheme.themeSource（MIT）
    'settings:theme': (theme) => {
      updateSettings({ theme })
      nativeTheme.themeSource = currentSettings().theme ?? 'system'
    },
    // メニューは onLocaleChange で作り直る（menu.ts）。renderer へは解決済みの言語を送る
    'settings:locale': (locale) => {
      updateSettings({ locale })
      const resolved = applyLocalePreference(currentSettings().locale)
      send('locale:changed', resolved)
      return resolved
    },
    'settings:crashReports': (enabled) => updateSettings({ crashReports: enabled === true, crashReportsNoticeShown: true }),
    'telemetry:state': () => {
      const s = currentSettings()
      return { active: crashReportsActive(), enabled: s.crashReports !== false, noticeShown: s.crashReportsNoticeShown === true, packaged: IS_PACKAGED, test: sentryTestKinds() }
    },
    'telemetry:noticeShown': () => updateSettings({ crashReportsNoticeShown: true }),
    'remote:state': async () => (await mobileRemoteService()).state(),
    'remote:set': async (patch) => {
      const before = currentSettings().mobileRemote ?? {}
      const enabled = typeof patch?.enabled === 'boolean' ? patch.enabled : before.enabled === true
      // 外から操作できる口を開くので、入れるのは利用者が押した直後だけ（切る・ポートの変更だけなら要らない）
      if (enabled && before.enabled !== true && !gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      if (patch && 'port' in patch && patch.port !== undefined && !isValidPort(patch.port)) throw new UserFacingError(t('remote.portInvalid'))
      const port = patch && 'port' in patch ? patch.port : before.port
      updateSettings({ mobileRemote: { ...(enabled ? { enabled: true } : {}), ...(port !== undefined ? { port } : {}) } })
      return (await mobileRemoteService()).apply(currentSettings().mobileRemote)
    },
    'remote:resetToken': async () => {
      if (!gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      return (await mobileRemoteService()).resetToken()
    },
    'agentSkill:status': async () => (await import('./agentSkill')).agentSkillStatus(agentSkillContext()),
    // 使っている人の状況（ビジネスリサーチ・ビジネスの前提）。画面の「あなたの状況」で読み書きする
    'profile:get': async () => ({ text: await founderText() }),
    'profile:set': async (text) => ({ text: await (await founderProfile()).set(text) }),
    'agentSkill:install': async (agents) => {
      // Agent の設定のフォルダへ書くので、利用者が押した直後だけ
      if (!gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      const wanted = Array.isArray(agents) ? agents.filter((a): a is AgentSkillAgent => (AGENT_SKILL_AGENTS as readonly string[]).includes(a)) : undefined
      return (await import('./agentSkill')).installAgentSkill(agentSkillContext(), wanted)
    },
    'settings:onboarding': async (patch) => {
      const { applyOnboardingPatch } = await import('@shared/onboarding')
      updateSettings({ onboarding: applyOnboardingPatch(currentSettings().onboarding, patch && typeof patch === 'object' ? patch : {}) })
      return currentSettings().onboarding ?? null
    },
    'permissions:status': async () => (await import('./permissions')).permissionsState(),
    'permissions:request': async (kind) => {
      const { permissionsState, requestPermission } = await import('./permissions')
      return kind === 'microphone' || kind === 'screen' ? requestPermission(kind) : permissionsState()
    },

    // 録画の対象（captureTarget）は別に覚えるので、送られてこなければ前の値を残す
    'settings:capture': (preferences) => {
      // マイク・PC の音声を録る同意は、利用者が切り替えた直後だけ広げる（操作が無ければ狭めるだけ）
      captureConsent = { ...captureConsent, ...nextAudioConsent(captureConsent, preferences ?? {}, gestures.consume('choice')) }
      return updateSettings({ capture: { ...currentSettings().capture, ...preferences } })
    },
    // ページで動かす文は固定の文字列にし、値（名前の無いマイクの訳）は main 側で付ける（コードに値を埋め込まない）
    'capture:devices': async () => {
      const devices: Array<{ id: string; label: string }> = await mainWindow?.webContents.executeJavaScript(`navigator.mediaDevices.enumerateDevices().then(devices => devices.filter(d => d.kind === 'audioinput' && d.deviceId).map(d => ({ id: d.deviceId, label: d.label })))`).catch((err: unknown) => { reportHandled(err, { area: 'recording', op: 'list microphones' }); return [] }) ?? []
      return devices.map((d, i) => ({ id: d.id, label: d.label || t('capture.micNumbered').replace('{{n}}', String(i + 1)) }))
    },
    'capture:model': async () => {
      if (recordingBusy || (recording && recording.status.state !== 'idle')) throw new UserFacingError(t('errors.stopRecordingBeforeChange'))
      const chosen = await dialog.showOpenDialog(mainWindow!, { title: t('dialog.whisperModel.title'), properties: ['openFile'], filters: [{ name: t('dialog.whisperModel.filter'), extensions: ['bin'] }] })
      if (chosen.canceled || !chosen.filePaths[0]) return false
      process.env.ADE_WHISPER_MODEL = chosen.filePaths[0]
      updateSettings({ whisperModel: chosen.filePaths[0] })
      return true
    },
    'review:restore': async (id, t) => {
      const r = await import('./review')
      return r.restoreDropped(r.checkedPaths(workspace.folderPath, id), t)
    },
    'review:organize': async (id, runner) => {
      const r = await import('./review')
      const { LLM_PROVIDER_PRESETS, isOrganizeRunnerId, resolveEndpoint } = await import('@shared/aiProviders')
      // Ollama でモデルを決めていなければ、この PC に合うもの（gpt-oss / qwen3）を使う
      const localOrganizeModel = (await import('./localModels')).localModelRecommendation().organize
      if (!isOrganizeRunnerId(runner)) throw new Error('unknown runner')
      // API キーで直接呼ぶ場合は、キーと接続先を渡す（キーは settings.json の指定 > 保存したキー。名前の無い環境変数は読まない）
      const api = runner.startsWith('api:') ? (() => {
        const provider = runner.slice(4) as keyof typeof LLM_PROVIDER_PRESETS
        const endpoint = currentSettings().organizer?.endpoints?.[provider]
        return { provider, endpoint: provider === 'ollama' && !endpoint?.model ? { ...endpoint, model: localOrganizeModel } : endpoint, vendor: LLM_PROVIDER_PRESETS[provider].vendor }
      })() : undefined
      updateSettings({ organizer: { ...currentSettings().organizer, runner } })
      const resolvedApi = api ? resolveEndpointRefs(api.endpoint, keyLookup()) : undefined
      // 認証情報は認めた接続元にだけ送る（security-5 [6]。ここでは聞かずに断り、設定の「接続を確かめる」へ案内する）
      if (api) await gateCredentials(`organize:${api.provider}`, resolveEndpoint(LLM_PROVIDER_PRESETS[api.provider], resolvedApi).baseUrl, api.endpoint, api.vendor, [LLM_PROVIDER_PRESETS[api.provider].baseUrl], false)
      return r.organizeReview(r.checkedPaths(workspace.folderPath, id), runner,
        api ? { endpoint: resolvedApi, apiKey: await providerKey(api.endpoint, api.vendor) } : undefined, currentSettings().organizer?.cliModels)
    },
    'review:frames': async (id, itemId) => {
      const r = await import('./review')
      return r.previewFrames(r.checkedPaths(workspace.folderPath, id), itemId)
    },
    // mtg の取り込み（meeting/import.ts）。選んだファイルのパスは main だけが持つ
    'meeting:pickMedia': async () => {
      const { MEETING_MEDIA_EXTENSIONS } = await import('@shared/meetingImport')
      const options: Electron.OpenDialogOptions = { title: t('meeting.dialog.media'), properties: ['openFile'], filters: [{ name: t('meeting.dialog.mediaFilter'), extensions: [...MEETING_MEDIA_EXTENSIONS] }] }
      const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (chosen.canceled || !chosen.filePaths[0]) return null
      return (await import('./meeting/import')).rememberMeetingMedia(chosen.filePaths[0])
    },
    'meeting:pickTranscript': async () => {
      const { MEETING_TRANSCRIPT_EXTENSIONS } = await import('@shared/meetingImport')
      const options: Electron.OpenDialogOptions = { title: t('meeting.dialog.transcript'), properties: ['openFile'], filters: [{ name: t('meeting.dialog.transcriptFilter'), extensions: [...MEETING_TRANSCRIPT_EXTENSIONS] }] }
      const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (chosen.canceled || !chosen.filePaths[0]) return null
      const m = await import('./meeting/import')
      return m.readMeetingTranscriptFile(chosen.filePaths[0], m.readDocxFile)
    },
    'meeting:import': async (request) => {
      if (!workspace.folderPath) throw new UserFacingError(t('errors.openProjectFolder'))
      const { importMeeting } = await import('./meeting/import')
      const r = await import('./review')
      const safe = request && typeof request === 'object' ? request : {}
      return importMeeting({
        projectDir: workspace.folderPath,
        request: {
          ...(typeof safe.mediaToken === 'string' ? { mediaToken: safe.mediaToken } : {}),
          ...(safe.transcript && typeof safe.transcript.text === 'string' ? { transcript: { text: safe.transcript.text, ...(typeof safe.transcript.name === 'string' ? { name: safe.transcript.name.slice(0, 200) } : {}) } } : {})
        },
        sttEngine: () => sttEngineFor(currentSettings().capture?.transcription ?? 'local', currentSettings().capture?.language ?? 'auto'),
        urlPresets: (currentSettings().projects.find((p) => p.id === workspace.projectId)?.urls ?? []).flatMap((u) => (u.url ? [{ id: u.id, label: u.label, url: u.url, ...(u.purpose ? { purpose: u.purpose } : {}) }] : [])),
        createReview: r.createImportedReview,
        onProgress: (progress) => send('meeting:progress', progress)
      })
    },
    'meeting:score': async (reviewId) => {
      const r = await import('./review')
      const { encodeFrameJpeg, scoreMeetingReview } = await import('./meeting/import')
      const paths = r.checkedPaths(workspace.folderPath, reviewId)
      const session = currentSettings().decision?.enabled
        ? await (await decision()).openAskSession({ ...(workspace.projectId ? { projectId: workspace.projectId } : {}), agent: 'meeting import', sessionId: `meeting:${reviewId}` })
        : null
      let latest: import('@shared/review').ReviewData | null = null
      try {
        const result = await scoreMeetingReview({
          paths, session, encodeFrame: encodeFrameJpeg,
          save: async (scores, threshold) => {
            const saved = await r.setMeetingScores(paths, scores, threshold)
            latest = saved.review
            return { excluded: saved.excluded }
          },
          onProgress: (done, total) => send('meeting:progress', { stage: 'score', done, total })
        })
        return { review: latest ?? await r.loadReviewAt(paths), result }
      } finally {
        session?.close()
      }
    },
    'capture:apiKey': async (key, provider) => {
      if (recordingBusy || (recording && recording.status.state !== 'idle')) throw new UserFacingError(t('errors.stopRecordingBeforeSetup'))
      if (typeof key !== 'string') throw new UserFacingError(t('errors.apiKeyInvalid'))
      // 形式の確認と保存（暗号化できなければ起動中だけ）は keys.ts。キーの値はログに出さない
      const { AI_VENDORS } = await import('@shared/aiProviders')
      return (await sttKeyStore()).set(provider && AI_VENDORS.includes(provider) ? provider : 'openai', key)
    },
    'capture:testConnection': async (target) => {
      const { STT_PROVIDER_PRESETS, isSttRemoteProvider, resolveEndpoint } = await import('@shared/aiProviders')
      const { sanitizeEndpointConfig } = await import('./pipeline/stt/endpoint')
      const { checkSttEngine } = await import('./pipeline/stt/cloud')
      if (!isSttRemoteProvider(target?.provider)) throw new Error('unknown provider')
      // 画面でまだ保存していない値で確かめる。キーは settings.json の指定か保存済みのもの。
      // 認証情報は、プリセットの接続元か利用者が main のダイアログで認めた接続元にだけ送る（security-5 [6]）
      const preset = STT_PROVIDER_PRESETS[target.provider]
      const endpoint = keepKeyRefs(currentSettings().capture?.sttEndpoints, { [target.provider]: sanitizeEndpointConfig(target.endpoint) })?.[target.provider]
      const resolved = resolveEndpointRefs(endpoint, keyLookup())
      await gateCredentials(`stt:${target.provider}`, resolveEndpoint(preset, resolved).baseUrl, endpoint, preset.vendor, [preset.baseUrl], true)
      return checkSttEngine({ provider: target.provider, endpoint: resolved,
        apiKey: await providerKey(endpoint, STT_PROVIDER_PRESETS[target.provider].vendor) })
    },
    'settings:stt': async (patch) => {
      const capture = currentSettings().capture ?? { captureMic: true, captureSystemAudio: false, transcription: 'local' as const, language: 'auto' as const, keepDays: 7, stayFeedbackOnStop: false }
      updateSettings({ capture: { ...capture,
        // 画面にはキーを渡していないので、settings.json に書かれた apiKey / apiKeyEnv を引き継ぐ
        ...(patch?.sttEndpoints !== undefined ? { sttEndpoints: keepKeyRefs(capture.sttEndpoints, patch.sttEndpoints) } : {}),
        ...(patch && 'costLimitUsd' in patch ? { costLimitUsd: patch.costLimitUsd } : {}) } })
    },
    'settings:organizer': (prefs) => {
      const prev = currentSettings().organizer
      updateSettings({ organizer: { ...prev, ...prefs, ...(prefs?.endpoints !== undefined ? { endpoints: keepKeyRefs(prev?.endpoints, prefs.endpoints) } : {}) } })
    },
    'organize:testConnection': async (target) => {
      const { LLM_PROVIDER_PRESETS, isLlmApiProvider, resolveEndpoint } = await import('@shared/aiProviders')
      const { sanitizeEndpointConfig } = await import('./pipeline/stt/endpoint')
      const { checkLlmRunner } = await import('./pipeline/organize/runners/api')
      if (!isLlmApiProvider(target?.provider)) throw new Error('unknown provider')
      const preset = LLM_PROVIDER_PRESETS[target.provider]
      const endpoint = keepKeyRefs(currentSettings().organizer?.endpoints, { [target.provider]: sanitizeEndpointConfig(target.endpoint) })?.[target.provider]
      const resolved = resolveEndpointRefs(endpoint, keyLookup())
      await gateCredentials(`organize:${target.provider}`, resolveEndpoint(preset, resolved).baseUrl, endpoint, preset.vendor, [preset.baseUrl], true)
      return checkLlmRunner({ provider: target.provider, endpoint: resolved,
        apiKey: await providerKey(endpoint, LLM_PROVIDER_PRESETS[target.provider].vendor) })
    },
    'settings:decision': async (prefs) => {
      const { sanitizeDecisionPreferences } = await import('@shared/decision')
      // 画面にはキーを渡していないので、settings.json に書かれた apiKey / apiKeyEnv を引き継ぐ
      const kept = keepKeyRefs({ d: currentSettings().decision as KeyRef | undefined }, { d: (prefs ?? {}) as KeyRef })?.d
      updateSettings({ decision: sanitizeDecisionPreferences(kept) })
      syncDecision()
      return redactKeys(currentSettings().decision!)
    },
    'decision:testConnection': async (raw) => {
      const { sanitizeDecisionPreferences } = await import('@shared/decision')
      // 画面にはキーを渡していないので、settings.json に書かれた apiKey / apiKeyEnv を引き継ぐ。E2E は本物を呼ばない
      const prefs = sanitizeDecisionPreferences(keepKeyRefs({ d: currentSettings().decision as KeyRef | undefined }, { d: (raw ?? {}) as KeyRef })?.d)
      return (await decision()).testConnection(prefs, { fake: IS_E2E, interactive: true })
    },
    'usage:apiCalls': () => apiUsageSummary(),
    'usage:openApiLog': async () => {
      const file = (await apiUsageSummary()).logFile
      // 今月まだ呼んでいなければファイルが無いので、フォルダを開く
      if (existsSync(file)) shell.showItemInFolder(file)
      else void shell.openPath(dirname(file)).catch((err: unknown) => reportHandled(err, { area: 'usage', op: 'open api call log' }))
    },
    'capture:sources': async () => {
      // 画面・ウインドウのサムネイルは、利用者が選択画面を開いた・選び直した直後だけ（security-5 [1]）
      if (!gestures.consume('sources')) throw new UserFacingError(t('errors.needsUserAction'))
      const { listCaptureSources, screenAccess } = await import('./recording/sources')
      const sources = await listCaptureSources().catch((err: unknown) => {
        console.warn('[capture] 画面・ウインドウの一覧を取得できませんでした', err)
        reportHandled(err, { area: 'recording', op: 'list capture sources' })
        return []
      })
      // macOS のフルスクリーンは専用のデスクトップ（Spaces）。そこにはほかのウインドウが無いので、一覧に出ない理由を選択画面に添える
      const appFullScreen = process.platform === 'darwin' && !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()
      return { screenAccess: screenAccess(), sources, ...(appFullScreen ? { appFullScreen } : {}) }
    },
    'capture:setTarget': async (target) => {
      const captureTarget = sanitizeCaptureTarget(target)
      if (!captureTarget) throw new UserFacingError(t('errors.captureTargetInvalid'))
      // 録る対象は、利用者が選んだ直後だけ変える。録画はこの対象しか録らない
      if (!gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      captureConsent = { ...captureConsent, target: captureTarget }
      // 選んだウインドウをエディタに映す（録画中は録画の対象を映したまま）
      void syncMirror()
      const capture = currentSettings().capture
      if (capture) updateSettings({ capture: { ...capture, captureTarget } })
      else updateSettings({ capture: { captureMic: true, captureSystemAudio: false, transcription: 'local', language: 'auto', keepDays: 7, stayFeedbackOnStop: false, captureTarget } })
    },
    'capture:openScreenSettings': async () => (await import('./recording/sources')).openScreenSettings(),
    'capture:screenAccess': async () => (await import('./recording/sources')).screenAccess(),
    // 入れてあるアプリの名前とパスだけ（中身は実行しない・画面に触れない）
    'capture:apps': async () => (await import('./recording/apps')).listDesktopApps().catch((err: unknown) => {
      reportHandled(err, { area: 'recording', op: 'list desktop apps' })
      return []
    }),
    'capture:launchApp': async (id) => {
      // アプリを起動するのは、利用者が選択画面で選んだ直後だけ。起動するのは main が並べた一覧にあるものだけ（apps.ts）
      if (!gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      return (await import('./recording/apps')).launchDesktopApp(id)
    },
    'capture:whisperModels': async () => {
      const { nodeProbes, resolveWhisperBinary } = await import('./pipeline/environment')
      const { whisperInstallHint } = await import('./pipeline/stt/modelManager')
      const downloads = await whisperModelDownloads()
      const models = await downloads.list()
      const current = localModel()
      return { models, binaryFound: !!(await resolveWhisperBinary({ modelDir: '' }, nodeProbes(workspace.folderPath))), installHint: whisperInstallHint(process.platform),
        downloading: downloads.downloading(), selected: models.find((m) => m.downloaded && downloads.pathOf(m.id) === current)?.id ?? null }
    },
    'capture:downloadModel': async (id) => {
      const { isWhisperModelId } = await import('./pipeline/stt/models')
      if (!isWhisperModelId(id)) throw new Error('unknown model')
      const result = await (await whisperModelDownloads()).start(id, (p) => send('capture:modelProgress', p))
      if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
      // 落とし終えたらそのモデルを使う（「モデルを選ぶ」と同じ扱い）。録画中なら次の録画から
      process.env.ADE_WHISPER_MODEL = result.path
      updateSettings({ whisperModel: result.path })
      return { ok: true }
    },
    'capture:cancelModelDownload': async () => { (await whisperModelDownloads()).cancel() },
    'capture:availability': async () => {
      const { nodeProbes, resolveWhisperBinary } = await import('./pipeline/environment')
      const ai = await import('@shared/aiProviders')
      const keys = await sttKeyStore()
      const settings = currentSettings()
      // settings.json で指定したキー（apiKey / apiKeyEnv）は提供元（provider）ごと。値は渡さず、出どころだけ
      const lookup = keyLookup()
      const sttRef = (p: SttRemoteProvider) => resolveConfiguredKey(settings.capture?.sttEndpoints?.[p], lookup)
      const llmRef = (p: LlmApiProvider) => resolveConfiguredKey(settings.organizer?.endpoints?.[p], lookup)
      const configured = new Map<AiVendor, SttKeySource>()
      for (const p of ai.STT_REMOTE_PROVIDERS) { const found = sttRef(p); if (found) configured.set(ai.STT_PROVIDER_PRESETS[p].vendor, found.source) }
      for (const p of ai.LLM_API_PROVIDERS) { const found = llmRef(p); if (found) configured.set(ai.LLM_PROVIDER_PRESETS[p].vendor, found.source) }
      return { localReady: !!(await resolveWhisperBinary({ modelDir: '' }, nodeProbes(workspace.folderPath))) && existsSync(localModel()),
        // 復号しない（起動直後にも呼ばれるため）。dev 版は保存しないことを画面に出す
        keyStorage: IS_PACKAGED ? keys.storage() : 'dev' as const,
        keys: Object.fromEntries(ai.AI_VENDORS.map((v) => [v, configured.get(v) ?? keys.source(v)])) as Record<AiVendor, SttKeySource>,
        stt: Object.fromEntries(ai.STT_REMOTE_PROVIDERS.map((p) => [p, ai.isEndpointReady(ai.STT_PROVIDER_PRESETS[p],
          settings.capture?.sttEndpoints?.[p], !!sttRef(p) || keys.has(ai.STT_PROVIDER_PRESETS[p].vendor))])) as Record<SttRemoteProvider, boolean>,
        llm: Object.fromEntries(ai.LLM_API_PROVIDERS.map((p) => [p, ai.isEndpointReady(ai.LLM_PROVIDER_PRESETS[p],
          settings.organizer?.endpoints?.[p], !!llmRef(p) || keys.has(ai.LLM_PROVIDER_PRESETS[p].vendor))])) as Record<LlmApiProvider, boolean>,
        // Ollama の既定のモデル（判定・整理）。この PC のメモリと GPU から選ぶ
        localModels: (await import('./localModels')).localModelRecommendation() }
    },
    'review:list': async (folderPath) => {
      const target = historyFolder(folderPath)
      return target ? (await import('./sessions')).listSessions(target) : []
    },
    'review:activity': async (folderPath) => {
      const target = historyFolder(folderPath)
      return target ? (await import('./sessions/history')).sessionActivity(target) : { recorded: false, sent: false }
    },
    'review:label': async (id, patch, folderPath) => {
      const target = historyFolder(folderPath)
      const s = await import('./sessions')
      if (!target || !s.isSessionId(id)) throw new UserFacingError(t('errors.folderNotRegistered'))
      await s.updateLabel(s.sessionPaths(target, id), { ...(patch?.name !== undefined ? { name: patch.name } : {}), ...(typeof patch?.archived === 'boolean' ? { archived: patch.archived } : {}) })
    },
    'review:delete': async (ids, folderPath) => {
      const target = historyFolder(folderPath)
      if (!target || !Array.isArray(ids)) return []
      const s = await import('./sessions')
      // 録画中・分解中のレビューは消さない（書き込み中のフォルダを消すと保存に失敗する）
      const busy = (recordingBusy || (recording && recording.status.state !== 'idle')) && activePaths?.dir.startsWith(target) ? activePaths.id : null
      const deleted: string[] = []
      for (const id of ids) {
        if (typeof id !== 'string' || id === busy) continue
        await s.deleteSession(target, id)
        deleted.push(id)
      }
      return deleted
    },
    'review:load': async (id) => {
      const r = await import('./review')
      return r.loadReviewAt(r.checkedPaths(workspace.folderPath, id))
    },
    'review:edit': async (id, edit) => {
      const r = await import('./review')
      return r.editReview(r.checkedPaths(workspace.folderPath, id), edit)
    },
    'review:progress': async (id, patch) => {
      const r = await import('./review')
      const paths = r.checkedPaths(workspace.folderPath, id)
      // 変える前の値（Agent の直し）と変えた後の値（人の判断）を、オーケストラのフィードバックの記録に足す
      const before = patch ? await progressBeforeChange(paths) : null
      const result = await r.setReviewProgress(paths, patch ?? {})
      recordProgressFeedback(paths, [before, result])
      return result
    },
    'review:verdict': async (id, itemId, verdict, text) => {
      const r = await import('./review')
      if (typeof itemId !== 'string' || (verdict !== 'ok' && verdict !== 'ng' && verdict !== 'comment')) throw new UserFacingError(t('review.errors.findingNotFound'))
      const paths = r.checkedPaths(workspace.folderPath, id)
      // 人の判断で Agent のひとことが消える前に、直した記録を残す（オーケストラのフィードバックの記録）
      const before = await progressBeforeChange(paths)
      const result = await r.recordReviewVerdict(paths, itemId, verdict, typeof text === 'string' ? text : undefined)
      recordProgressFeedback(paths, [before, result])
      return result
    },
    'review:ngPrompt': async (id, itemIds) => {
      const r = await import('./review')
      return r.ngResendInstruction(r.checkedPaths(workspace.folderPath, id), Array.isArray(itemIds) ? itemIds.filter((x): x is string => typeof x === 'string') : undefined)
    },
    'review:resent': async (id, itemIds) => {
      const r = await import('./review')
      return r.markResent(r.checkedPaths(workspace.folderPath, id), Array.isArray(itemIds) ? itemIds.filter((x): x is string => typeof x === 'string') : [])
    },
    'review:copy': async (id) => {
      const r = await import('./review')
      return r.copyReview(r.checkedPaths(workspace.folderPath, id), currentSettings().agentPrompt, isRemoteWorkspace())
    },
    'review:folder': async (id) => {
      const r = await import('./review')
      return r.revealReview(r.checkedPaths(workspace.folderPath, id))
    },
    'recording:start': async (options) => {
      if (recordingBusy || (recording && recording.status.state !== 'idle') || videoCaptureActive()) throw new UserFacingError(t('errors.recordingBusy'))
      if (!workspace.folderPath) throw new UserFacingError(t('errors.openProjectFolder'))
      const { BROWSER_TARGET } = await import('@shared/captureTarget')
      let captureTarget = sanitizeCaptureTarget(options.captureTarget) ?? BROWSER_TARGET
      // 利用者の操作の直後に1回だけ。対象と音は、利用者が選んだ範囲を超えない（security-5 [1]）
      if (captureRequestProblem({ target: captureTarget, mic: options.captureMic !== false, systemAudio: options.captureSystemAudio === true }, captureConsent) !== null) {
        throw new UserFacingError(t('errors.captureChooseAgain'))
      }
      if (!gestures.consume('record')) throw new UserFacingError(t('errors.needsUserAction'))
      // 文字で指摘は録画と同時に使わない（録画の書き込みと取り違えない）
      textNotes?.setActive(false, { notify: true })
      // 画面全体・別のウインドウを録るときは、内蔵ブラウザにページが無くてもよい
      if (captureTarget.kind === 'browser') {
        if (!browser?.state().url || browser.state().url === 'about:blank') throw new UserFacingError(t('errors.openUrlToReview'))
        if (browser.state().loadError) throw new UserFacingError(t('errors.pageNotLoaded'))
      }
      recordingBusy = true
      try {
        const controller = await ensureRecording()
        captureTarget = await controller.checkTarget(captureTarget)
        const { createSession } = await import('./sessions')
        const { ensureGitExclude } = await import('./sessions')
        await ensureGitExclude(workspace.folderPath)
        // 追記なら、開いているレビューの takes/<n>/ へ録る（レビューが無い・壊れていれば始めない）
        const append = typeof options.appendTo === 'string' ? await (await import('./review')).prepareReviewTake(workspace.folderPath, options.appendTo) : null
        const paths = append?.paths ?? await createSession(workspace.folderPath)
        activePaths = paths
        activeAppend = append ? { review: append.review, n: append.n } : null
        const onSegments = async (segments: import('./pipeline/types').TranscriptSegment[]) => {
          // 末端のリンクはたどらない（sessions/containment.ts）
          if (segments.length) await (await import('./sessions/containment')).appendFileNoFollow(join(paths.dir, 'transcript.jsonl'), segments.map((s) => JSON.stringify(s)).join('\n') + '\n')
        }
        await (await import('./sessions/containment')).writeFileNoFollow(join(paths.dir, 'capture.json'), JSON.stringify({ startedAt: new Date().toISOString(), twoSpeakers: options.captureSystemAudio, captureTarget,
          // 指摘の URL に local / dev / prd のラベルを付けるため、録画を始めた時点の登録URLを控える
          urlPresets: currentSettings().projects.find((p) => p.id === workspace.projectId)?.urls ?? [] }))
        activeOptions = { captureSystemAudio: options.captureSystemAudio, captureMic: options.captureMic !== false,
          transcription: options.transcription ?? 'local' }
        sttWarnings = []
        transcriber = null
        // 検証用の合成音は文字起こしに送らない。送るのは検証の音声（ADE_QA_AUDIO）か、相手の声の検証（ADE_SYNTHETIC_SYSTEM_AUDIO）のときだけ
        const systemAudioCheck = options.captureSystemAudio ? syntheticSystemAudio(process.env.ADE_SYNTHETIC_SYSTEM_AUDIO, IS_E2E) : null
        // 検証起動で口の指定が無ければ、本物のループバックを開かない（OS の許可の確認を出さない）。許可が無いときと同じに扱う
        const systemAudioSafe = systemAudioCheck ?? (options.captureSystemAudio && (IS_E2E || process.env.ADE_SYNTHETIC_MIC === '1') ? 'denied' as const : null)
        if ((options.captureMic !== false || options.captureSystemAudio) && (process.env.ADE_SYNTHETIC_MIC !== '1' || (IS_E2E && process.env.ADE_QA_AUDIO) || systemAudioCheck)) {
          const { IncrementalTranscriber } = await import('./pipeline/stt/engine')
          // 区切りごとの進み具合を右パネルの「文字起こし」タブへ（録画は待たせない）
          const onProgress = (progress: import('./pipeline/stt/engine').TranscriberProgress) => liveFeed?.progress(progress)
          const stt = await sttEngineFor(activeOptions.transcription, options.language ?? 'auto')
          if (stt.engine) transcriber = new IncrementalTranscriber(stt.engine, onSegments, onProgress)
          else if (stt.warning) sttWarnings.push(stt.warning)
        }
        flow('stt start', { engine: transcriber ? (options.transcription ?? 'local') : 'none' })
        const { LiveTranscriptFeed } = await import('./pipeline/stt/liveFeed')
        liveFeed ??= new LiveTranscriptFeed({ status: (status) => send('transcript:status', status), segments: (batch) => send('transcript:segments', batch) })
        liveFeed.start({ transcribing: transcriber !== null, audio: options.captureMic !== false || options.captureSystemAudio, mic: options.captureMic !== false,
          twoSpeakers: options.captureSystemAudio, message: sttWarnings[0] })
        audioWriter = await createAudioWriter(paths.audioDir)
        // 確認先に登録した「録画中に開いたら録る」ウインドウ（Web アプリから起動するデスクトップアプリなど。@shared/captureTracks）
        const project = currentSettings().projects.find((p) => p.id === workspace.projectId)
        const watch = project ? (await import('@shared/captureTracks')).watchedWindows(project.urls, project.kind ?? 'web') : []
        await controller.start({ paths: { videoPath: paths.recording, framesDir: paths.framesDir,
          audioDir: paths.audioDir, eventsPath: paths.eventsJsonl }, captureSystemAudio: options.captureSystemAudio,
          captureMic: options.captureMic !== false, captureTarget, watch,
          // 拡張機能のポップアップがあるときは、動画にも重ねて録る（無ければ今までどおりタブの映像だけ）
          overlayCompositing: extensions?.hasPopupExtensions() ?? false,
          ...(IS_E2E && process.env.ADE_QA_LIMIT_MS ? { maxDurationMs: Number(process.env.ADE_QA_LIMIT_MS) } : {}),
          ...(options.micDeviceId ? { micDeviceId: options.micDeviceId } : {}),
          ...(process.env.ADE_SYNTHETIC_MIC === '1' ? { syntheticMic: true } : {}),
          ...(systemAudioSafe ? { syntheticSystemAudio: systemAudioSafe } : {}),
          ...(IS_E2E && process.env.ADE_QA_AUDIO ? { syntheticMicWavBase64: (await readFile(process.env.ADE_QA_AUDIO)).toString('base64') } : {}) })
          .catch((err: unknown) => { liveFeed?.stop(); throw err })
        for (const warning of sttWarnings) send('recording:warning', warning)
        return controller.status
      } finally { recordingBusy = false }
    },
    'recording:pause': async () => {
      const controller = await ensureRecording()
      controller.pause()
      return controller.status
    },
    'recording:resume': async () => {
      const controller = await ensureRecording()
      controller.resume()
      return controller.status
    },
    'recording:stop': () => stopReview(),
    'recording:status': () => recording?.status ?? IDLE_RECORDING_STATUS,
    'recording:addTrack': async (target) => {
      const captureTarget = sanitizeCaptureTarget(target)
      if (!captureTarget) throw new UserFacingError(t('errors.captureTargetInvalid'))
      // 録る映像を足すのは、利用者が選択画面・確認先で選んだ直後だけ（security-5 [1]。録画の開始と同じく、利用者の選んだものだけを録る）
      if (!gestures.consume('choice')) throw new UserFacingError(t('errors.needsUserAction'))
      if (!recording || recording.status.state === 'idle' || recording.status.state === 'stopping') throw new UserFacingError(t('recording.errors.notRecording'))
      return recording.addTrack(captureTarget, { activate: true })
    },
    'recording:switchTrack': async (id) => {
      const { isTrackId } = await import('@shared/captureTracks')
      if (!isTrackId(id) || !recording) return
      await recording.switchTrack(id)
    },
    'recording:tracks': async () => recording?.tracksState ?? (await import('@shared/captureTracks')).EMPTY_TRACKS_STATE,
    'annotation:setMode': async (mode: AnnotationMode) => {
      // 廃止した 'text' など知らない値は OFF にする
      ;(await ensureRecording()).setAnnotationMode(mode === 'pen' || mode === 'rect' ? mode : 'off')
    },
    'annotation:setColor': async (value: unknown) => {
      const annotationColor = normalizeAnnotationColor(value)
      ;(await ensureRecording()).setAnnotationColor(annotationColor)
      const capture = currentSettings().capture
      if (capture) updateSettings({ capture: { ...capture, annotationColor } })
      else updateSettings({ capture: { captureMic: true, captureSystemAudio: false, transcription: 'local', language: 'auto', keepDays: 7, stayFeedbackOnStop: false, annotationColor } })
      textNotes?.refreshColor()
    },
    'note:setMode': async (enabled, reviewId) => {
      // ツールバーの［文字で指摘］。録画中・プロジェクト未選択は入れない。足し先は開いているレビュー（このプロジェクトのもの。review.ts の addTextNote が確かめる）
      if (enabled === true && !workspace.folderPath) throw new UserFacingError(t('errors.openProjectFolder'))
      if (enabled === true && (recordingBusy || (recording && recording.status.state !== 'idle') || videoCaptureActive())) throw new UserFacingError(t('errors.recordingBusy'))
      const notes = enabled === true ? await ensureTextNotes() : textNotes
      return notes?.setActive(enabled === true, { reviewId: typeof reviewId === 'string' && reviewId ? reviewId : null }) ?? false
    },
    'annotation:clear': async () => {
      // ツールバーの［消去］。元に戻すで画面に戻せる
      ;(await ensureRecording()).clearAnnotations(true)
    },
    'annotation:undo': async () => {
      ;(await ensureRecording()).undoAnnotation()
    },
    'annotation:redo': async () => {
      ;(await ensureRecording()).redoAnnotation()
    },

    // ファイルエディタ（src/main/files.ts がプロジェクトの外を断る）
    'fs:list': (relDir) => listDirectory(projectRoot(), relDir),
    'fs:read': (relPath) => readTextFile(projectRoot(), relPath),
    'fs:write': (relPath, content) => writeTextFile(projectRoot(), relPath, content),
    'fs:files': () => listFiles(projectRoot()),
    'fs:search': (query, mode) => searchFiles(projectRoot(), query, mode),
    'fs:inspect': (relPath) => inspectProjectFile(projectRoot(), relPath),
    'fs:readOffice': (relPath) => readOfficeFile(projectRoot(), relPath),
    // フッターの git と同じく、起動の後で読む（github/gitSync.ts を起動時に読み込まない）
    'fs:gitStatus': async () => {
      const root = projectRoot()
      const { readGitDecorations } = await import('./gitDecorations')
      return readGitDecorations(root)
    },
    'fs:create': (parentRel, name, kind) => createEntry(projectRoot(), parentRel, name, kind),
    'fs:copy': (relPaths, destRel) => copyEntries(projectRoot(), relPaths, destRel),
    'fs:move': (relPaths, destRel) => moveEntries(projectRoot(), relPaths, destRel),
    'fs:import': (absolutePaths, destRel) => importEntries(projectRoot(), absolutePaths, destRel),
    // ファイルツリーの貼り付け（⌘V / Ctrl+V）。OS のクリップボードのファイル・画像を main が読んで取り込み、作ったものの相対パスだけを返す
    // （クリップボードの中身・元のパスは renderer へ返さない。押した直後の1回だけ。security-7 [1]）
    'fs:pasteClipboard': async (destRel) => {
      if (typeof destRel !== 'string' || !gestures.consume('paste')) throw new UserFacingError(t('errors.needsUserAction'))
      const root = projectRoot()
      const { readClipboardPaste, writePastedImage } = await import('./clipboardFiles')
      const found = await readClipboardPaste(clipboard)
      if (found.kind === 'files') {
        // 利用者が OS でコピーし、いま貼り付けを押したもの（main が読んだパスなので、落としたものの確認は要らない）
        const done = await importEntries(root, found.paths, destRel, () => true)
        return { kind: 'files' as const, created: done.map((d) => d.to) }
      }
      if (found.kind === 'image') return { kind: 'image' as const, created: [await writePastedImage(root, destRel, found.bytes, found.ext)] }
      return { kind: 'none' as const, created: [] }
    },
    'fs:importMedia': (markdownRel, absolutePaths) => importMediaForMarkdown(projectRoot(), markdownRel, absolutePaths),
    'fs:copyPath': async (relPaths, kind) => {
      const text = await pathsForClipboard(projectRoot(), relPaths, kind === 'relative' ? 'relative' : 'absolute')
      clipboard.writeText(text)
      return text
    },
    'fs:terminalDir': (relPath) => terminalDirFor(projectRoot(), relPath),
    'fs:rename': (relPath, newName) => renameEntry(projectRoot(), relPath, newName),
    'fs:trash': (relPaths) => trashEntries(projectRoot(), relPaths, trashFor((absolute) => shell.trashItem(absolute))),
    'fs:reveal': async (relPath) => shell.showItemInFolder(await resolveInside(projectRoot(), relPath)),
    'fs:openExternal': async (relPath) => {
      const file = await resolveInside(projectRoot(), relPath)
      // ワンクリックで実行されうるもの（.app・.command・拡張子なし など）は開かない。Finder で表示はできる
      if (isRiskyToOpenExternally(file.split(/[\\/]/).join('/'))) throw new UserFacingError(t('files.errors.openRisky'))
      const failure = await shell.openPath(file)
      if (failure) throw new UserFacingError(failure)
    },
    'preview:render': (path, source) => renderPreviewSource(path, source),
    'editor:unsaved': (files) => {
      unsavedFiles = sanitizeUnsavedRefs(files)
    },
    'editor:quitSave': (requestId, entries) => receiveQuitSave(requestId, entries),

    'star:star': async () => (await starPrompt()).star(),
    'star:openWeb': async () => (await starPrompt()).openWeb(),
    'star:later': async () => (await starPrompt()).later(),
    'star:never': async () => (await starPrompt()).never(),
    'star:fromMenu': async () => (await starPrompt()).starFromMenu(),
    'feedback:environment': async () => {
      const [{ collectEnvironment }, { sanitizeEnvironment }, os] = await Promise.all([import('./feedback'), import('@shared/feedback'), import('node:os')])
      const raw = collectEnvironment({
        appVersion: app.getVersion(), packaged: IS_PACKAGED, platform: process.platform, systemVersion: process.getSystemVersion(),
        arch: process.arch, cpuModel: os.cpus()[0]?.model, locale: getLocale()
      })
      // 元の値は OS の版や CPU の名前だけ。念のため、利用者名・端末名・登録したプロジェクトの名前が紛れていれば伏せる
      const user = (() => { try { return os.userInfo().username } catch { return '' } })()
      return sanitizeEnvironment(raw, [user, os.hostname(), ...currentSettings().projects.map((p) => p.name)])
    },
    'feedback:account': async () => (await (await import('./github')).githubStatus()).account?.user ?? null,
    'feedback:submit': async (input) => {
      const [{ submitFeedback }, { sendToRelay }, { gh }, { githubStatus }, { clipboard, net }, os] = await Promise.all([
        import('./feedback'), import('./feedbackRelay'), import('./github/gh'), import('./github'), import('electron'), import('node:os')])
      return submitFeedback(input, {
        // 確認・テストの起動（ADE_E2E）からは本物の中継へ送らない（Sentry と同じ扱い）。送れない扱いにしてブラウザへ回す
        relay: (submission) => process.env.ADE_E2E === '1'
          ? Promise.resolve({ ok: false as const, code: 'disabled' as const, retryable: false })
          : sendToRelay(submission, { fetch: (url, init) => net.fetch(url, init), userAgent: `${PRODUCT_NAME}/${app.getVersion()}` }),
        appMeta: () => ({ appVersion: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: os.release(), installId: telemetryInstallId() }),
        gh: (args, options) => gh(args, options),
        signedIn: async () => Boolean((await githubStatus()).account),
        openExternal: (url) => shell.openExternal(url),
        copyText: (text) => clipboard.writeText(text)
      })
    },
    'feedback:captureWindow': async () => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new UserFacingError(t('feedback.errors.captureFailed'))
      // 内蔵ブラウザも写る撮影は、利用者の操作1回につき1枚だけ（security-5 [1]）
      if (!gestures.consume('screenshot')) throw new UserFacingError(t('errors.needsUserAction'))
      const [{ fitScreenshot, overlayView }, { nativeImage }] = await Promise.all([import('./feedbackCapture'), import('electron')])
      const window = mainWindow
      const shot = await window.webContents.capturePage()
      // ウインドウの画像には内蔵ブラウザ（別のレイヤー）が写らないので、ビューも撮って同じ位置に重ねる（画面収録の許可は要らない）
      // 手元のファイル（file:）を表示しているビューは重ねない（security-7 [2]。撮った画像は renderer へ返るので、手元のファイルの中身を読ませない）
      const visible = browser?.visibleSnapshotTarget() ?? null
      const target = visible && isSnapshotableBrowserUrl(visible.contents.getURL()) ? visible : null
      const viewShot = target ? await target.contents.capturePage().catch(() => null) : null
      const [width, height] = window.isDestroyed() ? [0, 0] : window.getContentSize()
      const merged = viewShot && target ? overlayView(shot, { width: width!, height: height! }, { image: viewShot, bounds: target.bounds }) : null
      const withView = merged ? nativeImage.createFromBitmap(Buffer.from(merged.data.buffer, merged.data.byteOffset, merged.data.byteLength), { width: merged.width, height: merged.height }) : shot
      // 拡張機能のポップアップ（さらに別のビュー）も同じく重ねる
      const popup = extensions?.popupTarget() ?? null
      const popupShot = popup ? await popup.contents.capturePage().catch(() => null) : null
      const withPopup = popup && popupShot && !popupShot.isEmpty() ? overlayView(withView, { width: width!, height: height! }, { image: popupShot, bounds: popup.bounds }) : null
      return fitScreenshot(withPopup ? nativeImage.createFromBitmap(Buffer.from(withPopup.data.buffer, withPopup.data.byteOffset, withPopup.data.byteLength), { width: withPopup.width, height: withPopup.height }) : withView)
    },
    'github:repoStatus': async () => {
      await gitSyncModule()
      const { gitRepoStatus, watchGitHead } = await import('./github/repoStatus')
      void watchGitHead(workspace.folderPath, () => send('github:headChanged'))
      return gitRepoStatus(workspace.folderPath)
    },
    // プロジェクトの右クリックの「GitHub で private リポジトリを作る」。フォルダは main が設定から決める（renderer からパスを受けない）。
    // SSH のプロジェクトは手元のフォルダがレビューの置き場なので扱わない
    'github:repoCreateInfo': async (projectId) => {
      const project = currentSettings().projects.find((p) => p.id === projectId)
      if (!project || project.source === 'ssh') throw new UserFacingError(t('repoCreate.errors.unsupported'))
      const { repoCreateInfo } = await import('./github/createRepo')
      return repoCreateInfo(project.folderPath, currentSettings().github?.defaultOwner)
    },
    'github:createPrivateRepo': async (projectId, request) => {
      // 外へ出る操作なので、確認の「作成」を押した直後だけ（gitSync と同じ1回きりの許可。security-7 [9]）
      if (!gestures.consume('gitSync')) throw new UserFacingError(t('errors.needsUserAction'))
      const project = currentSettings().projects.find((p) => p.id === projectId)
      if (!project || project.source === 'ssh') throw new UserFacingError(t('repoCreate.errors.unsupported'))
      const { createPrivateRepo } = await import('./github/createRepo')
      const result = await createPrivateRepo(project.folderPath, {
        owner: String(request?.owner ?? ''), name: String(request?.name ?? ''),
        description: typeof request?.description === 'string' ? request.description : '', initialCommit: request?.initialCommit === true
      })
      // フッターの git（ブランチ・リモート）を読み直させる。git init したばかりのフォルダは HEAD の見張りがまだ無い
      if (project.folderPath === workspace.folderPath) send('github:headChanged')
      return result
    },
    'settings:github': (prefs) => {
      const github = sanitizeGithubPreferences(prefs)
      updateSettings({ github })
    },
    'github:autoFetch': async (trigger, visible) => {
      // 利用者が押す fetch は github:gitAction（manual はここでは受けない）
      if (trigger !== 'open' && trigger !== 'interval' && trigger !== 'focus') throw new Error('invalid fetch trigger')
      const { autoFetch } = await gitSyncModule()
      return autoFetch(workspace.folderPath, trigger, visible === true)
    },
    'github:autoFetchConsent': async (allowed) => {
      // 裏の fetch を認める／認めないは、フッターで押した直後だけ（security-7 [9]）。行き先は main が今の設定から決める
      if (typeof allowed !== 'boolean' || !gestures.consume('gitSync')) throw new UserFacingError(t('errors.needsUserAction'))
      const { decideAutoFetch } = await gitSyncModule()
      return decideAutoFetch(workspace.folderPath, allowed)
    },
    'github:gitAction': async (action, expectedHead) => {
      if (action !== 'fetch' && action !== 'pull' && action !== 'push') throw new Error('invalid git action')
      // 作業ツリーを書き換える・外へ送る操作は、利用者が押した直後だけ（fetch は読むだけ）
      if (action !== 'fetch' && !gestures.consume('gitSync')) throw new UserFacingError(t('errors.needsUserAction'))
      const head = typeof expectedHead === 'string' && /^[0-9a-f]{40,64}$/i.test(expectedHead) ? expectedHead : null
      if (action === 'push' && !head) throw new Error('push needs the confirmed HEAD')
      const { runGitAction } = await gitSyncModule()
      return runGitAction(workspace.folderPath, action, head)
    },
    'github:open': async (url) => {
      // 一覧に出した GitHub のページだけを開く（任意のURL・スキームは開かない）
      const parsed = new URL(String(url))
      if (parsed.protocol !== 'https:') throw new UserFacingError(t('errors.urlNotAllowed'))
      const repo = (await (await import('./github')).githubRepo(workspace.folderPath)).repo
      if (parsed.host !== 'github.com' && parsed.host !== repo?.host) throw new UserFacingError(t('errors.urlNotAllowed'))
      await shell.openExternal(parsed.toString())
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    // 投げた例外は Sentry へも送る（kind: ipc。src/main/telemetry.ts）
    const op = flowOf(channel)
    const run = wrapIpcHandler(channel, async (...args: unknown[]) => {
      // 主要な操作の区切り（パンくず）。操作名だけを残す
      if (op) flow(op.name, op.data)
      // 処理中の IPC を控える（main が止まったときの手がかり。src/main/telemetry.ts）
      const done = trackIpc(channel)
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        if (isStaleChunkError(err)) noteAppFilesReplaced(channel, err)
        // ファイル操作の英語のエラー（EACCES など）とパスを、そのまま画面へ出さない（想定内なので Sentry にも送らない）
        const wrapped = toUserFacingFileError(err)
        if (wrapped !== err) console.warn(`[ipc] ${channel} に失敗しました`, err)
        throw wrapped
      } finally {
        done()
      }
    }, reportMainError)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      // 終了処理に入った後は、破棄途中のオブジェクトを触らない。
      // ただし終了の途中で main が頼んだ、ターミナルの最後の画面の文字（terminal:restoreSave。collectTerminalRestore）は受ける
      if (shuttingDown && channel !== 'terminal:restoreSave') return null
      // アプリの窓の本体のフレーム（アプリのページ）からだけ受ける。サブフレーム・別の窓・別のページからは断る（security-5 [1]）
      const main = mainWindow && !mainWindow.isDestroyed() ? { contents: mainWindow.webContents, mainFrame: mainWindow.webContents.mainFrame } : null
      if (!isTrustedIpcSender(event, main, (url) => isAppPageUrl(url, appPageRoots()))) throw new Error(`ipc ${channel}: sender is not the app window`)
      // 起動の内訳: renderer の最初の呼び出し（renderer の JS が動き始めた）と、画面の最初のデータを返し終えた時刻。
      // renderer:loaded → interactive のどこで遅れたか（renderer・main の順番待ち・描画）を分ける
      markOnce('renderer:firstIpc')
      const result = await run(...args)
      if (channel === 'browser:state') markOnce('renderer:initialData')
      // void を返すハンドラの戻り値は undefined に正規化する（構造化クローンの失敗を避ける）
      return result === undefined ? null : result
    })
  }
}

/**
 * 起動中にアプリのファイルが入れ替わり、遅延 import の分割ファイルが無くなった（Sentry FERRET-X）。
 * 落とさずに「再起動してください」と1回だけ知らせる（消えない通知。録画の警告と同じ出し方を使い、preload に新しいチャネルを足さない）。
 * Sentry へは元のエラーを送り、telemetry.ts の beforeSend が dev なら捨て、配布版なら kind: stale-build で分ける
 */
let appFilesReplacedNoticed = false
function noteAppFilesReplaced(channel: string, err: unknown): void {
  console.warn(`[ipc] ${channel}: アプリのファイルが入れ替わりました（再起動が必要）`)
  reportMainError(err, { kind: 'stale-build', 'ipc.channel': channel })
  if (appFilesReplacedNoticed) return
  appFilesReplacedNoticed = true
  send('recording:warning', t('errors.appFilesReplaced'))
}

let loadedSettings: Settings = {
  folderPath: null,
  url: 'about:blank',
  splitRatio: DEFAULT_SPLIT_RATIO,
  viewport: 'desktop',
  projects: [],
  activeProjectId: null,
  agents: DEFAULT_AGENT_PREFERENCES
}

async function main(): Promise<void> {
  // 同じプロジェクトを二重に開かない
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    // 窓がまだ出ていなければ出す（2回目の起動でも見えないままにしない。Orca #8421）
    if (!mainWindow.isVisible() && !HIDE_WINDOW) mainWindow.show()
    mainWindow.focus()
  })

  await app.whenReady()
  mark('app:ready')
  // エミュレーション（Rosetta / Prism）で動いているかを、性能の報告のタグに付ける
  setStartupTags({ emulation: emulationKind(process.platform, app.runningUnderARM64Translation) })
  // 入れた・更新した直後の初回は、JS より前の遅れ（OS の検査）を数えない（startup.ts）
  launchedNewVersion = noteLaunchedVersion(join(app.getPath('userData'), 'last-launch-version'), app.getVersion())
  // 既定のセッション（アプリの画面・録画ウインドウ・プレビューの iframe）の権限。アプリ自身の画面の本体だけに、
  // 要るものだけを許す。プレビュー（プロジェクトの HTML）や外のページには何も許さない。読み込みの前に入れる
  // media はアプリの窓には音だけ、映像（画面・タブ）は録画ウインドウだけ。カメラはどこにも許さない（captureConsent.ts）
  installPermissionPolicy(session.defaultSession as unknown as PermissionSessionLike, (query) =>
    APP_ALLOWED_PERMISSIONS.has(query.permission) && query.isMainFrame !== false && isAppPageUrl(query.origin, appPageRoots()) &&
    (query.permission !== 'media' || appMediaAllowed(query, isRecorderContents(query.webContents))))
  // Windows のタスクバーで、インストーラが作るショートカット（appId）と同じアイコンにまとめる
  if (process.platform === 'win32') app.setAppUserModelId('dev.ferretade.ferret')
  // 開発版は名前を変えず、「について」の版の行にだけ (dev) と添える
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, ...(IS_PACKAGED ? {} : { applicationVersion: `${appVersion()} (dev)` }) })

  // E2E中はDockのアイコンを出さない（跳ねない・メニューバーを切り替えない）
  if (HIDE_WINDOW && process.platform === 'darwin') app.dock?.hide()
  // 開発起動では .app の icns が無いので、Dock のアイコンだけ build/icon.png に差し替える
  const devIcon = join(app.getAppPath(), 'build', 'icon.png')
  if (!IS_PACKAGED && !HIDE_WINDOW && process.platform === 'darwin' && existsSync(devIcon)) {
    app.dock?.setIcon(devIcon)
  }

  loadedSettings = await loadSettings()
  // 前回までに利用者が選んだ録る対象と音（起動後の変更は、操作の直後のものだけを足す）
  captureConsent = { target: sanitizeCaptureTarget(loadedSettings.capture?.captureTarget) ?? { kind: 'browser' },
    mic: loadedSettings.capture?.captureMic !== false, systemAudio: loadedSettings.capture?.captureSystemAudio === true }
  maybeSendTestEvent()
  // ウインドウ・メニュー・ダイアログを作る前に画面の言語を決める
  applyLocalePreference(loadedSettings.locale)
  // ウインドウを作る前に配色を決める。renderer の prefers-color-scheme もこれに従う
  nativeTheme.themeSource = loadedSettings.theme ?? 'system'
  nativeTheme.on('updated', () => {
    const color = nativeThemeBackground()
    mainWindow?.setBackgroundColor(color)
    browser?.setBackgroundColor(color)
    // renderer の prefers-color-scheme は Playwright などに上書きされうるので、解決済みの値を送る
    send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })
  if (loadedSettings.whisperModel) process.env.ADE_WHISPER_MODEL = loadedSettings.whisperModel
  protocol.handle('ade-media', async (request) => {
    const url = new URL(request.url)
    // エディタで開いたプロジェクトの画像・動画・音声・PDF（src/main/projectMedia.ts が外・リンク・パイプを断る）
    if (url.hostname === 'project') return projectMediaResponse(workspace.folderPath, request.url, request.headers.get('range'))
    // Agent が撮った AFTER のスクリーンショット: /<id>/file/<レビューのフォルダからの相対パス>（src/main/afterShots.ts が中を確かめる）
    const shot = /^\/(\d{8}-\d{6})\/file\/(.+)$/.exec(url.pathname)
    if (url.hostname === 'review' && shot && workspace.folderPath) {
      const { checkedPaths } = await import('./review')
      const { afterContentType, readAfterFile, resolveAfterFile } = await import('./afterShots')
      let rel: string
      try { rel = decodeURIComponent(shot[2]!) } catch { return new Response('Not found', { status: 404 }) } // 壊れた URL（想定内）
      const reviewDir = checkedPaths(workspace.folderPath, shot[1]!).dir
      const file = await resolveAfterFile(reviewDir, rel)
      if (!file) return new Response('Not found', { status: 404 })
      // 確かめたあとに途中のフォルダを差し替えられても外を読まないよう、開いた fd を確かめてからその fd で読む（security-7 [13]）
      const bytes = await readAfterFile(reviewDir, file)
      if (!bytes) return new Response('Not found', { status: 404 })
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': afterContentType(file), 'cache-control': 'no-store' } })
    }
    // 削った版を作る非表示ウィンドウのページ（動画と同じ出どころに置く。trimVideo.ts）
    if (url.hostname === 'review' && url.pathname === '/trim-host') {
      const { TRIM_HOST_HTML } = await import('./trimVideo')
      return new Response(TRIM_HOST_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    // 取り込んだ mtg の動画からコマ・音声を取り出す非表示ウィンドウのページ（meeting/media.ts）
    if (url.hostname === 'review' && url.pathname === '/meeting-host') {
      const { MEETING_HOST_HTML } = await import('./meeting/media')
      return new Response(MEETING_HOST_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    // 取り込んだ mtg の動画（/<id>/meeting.<拡張子>）。録画と同じく、中の実体を開いた fd から返す
    const meeting = /^\/(\d{8}-\d{6})\/meeting\.([a-z0-9]{2,4})$/.exec(url.pathname)
    if (url.hostname === 'review' && meeting && workspace.folderPath) {
      const { meetingMediaExtension, meetingMediaType } = await import('@shared/meetingImport')
      const ext = meetingMediaExtension(`meeting.${meeting[2]!}`)
      if (!ext) return new Response('Not found', { status: 404 })
      const { checkedPaths } = await import('./review')
      const review = checkedPaths(workspace.folderPath, meeting[1]!)
      const file = join(review.dir, `meeting.${ext}`)
      const { lstat } = await import('node:fs/promises')
      const leaf = await lstat(file).catch(() => null)
      if (!leaf?.isFile()) return new Response('Not found', { status: 404 })
      const { openContained } = await import('./containedFile')
      const handle = await openContained(review.dir, file, 'read').catch(() => null)
      if (!handle) return new Response('Not found', { status: 404 })
      const opened = await handle.stat().catch(() => null)
      if (!opened?.isFile()) {
        await handle.close()
        return new Response('Not found', { status: 404 })
      }
      const { mediaResponseFromHandle } = await import('./mediaRange')
      return mediaResponseFromHandle(handle, request.headers.get('range'), meetingMediaType(ext))
    }
    // 追記した録画は /<id>/takes/<n>/recording.webm。何もない時間を削った版は recording.trimmed.webm
    const match = /^\/(\d{8}-\d{6})\/(?:takes\/(\d{1,4})\/)?recording(\.trimmed)?\.webm$/.exec(url.pathname)
    if (url.hostname !== 'review' || !match || !workspace.folderPath) return new Response('Not found', { status: 404 })
    const { checkedPaths } = await import('./review')
    const { takePaths } = await import('./sessions/paths')
    const review = checkedPaths(workspace.folderPath, match[1]!)
    const files = takePaths(review, Number(match[2] ?? 1))
    const file = match[3] ? files.trimmedRecording : files.recording
    // 末端がリンクの動画は返さない（外のファイルを読ませない）。確かめたあとに差し替えられないよう、
    // 開いた fd がレビューのフォルダの中の実体と同じかを確かめ、その fd から返す（security-7 [13]）
    const { lstat } = await import('node:fs/promises')
    const leaf = await lstat(file).catch(() => null)
    if (!leaf?.isFile()) return new Response('Not found', { status: 404 })
    const { openContained } = await import('./containedFile')
    const handle = await openContained(review.dir, file, 'read').catch(() => null)
    if (!handle) return new Response('Not found', { status: 404 })
    const opened = await handle.stat().catch(() => null)
    if (!opened?.isFile()) {
      await handle.close()
      return new Response('Not found', { status: 404 })
    }
    // Range に答えないと video が seek できず、▷ が指摘の時刻でなく 0 秒から始まる
    const { mediaResponseFromHandle } = await import('./mediaRange')
    return mediaResponseFromHandle(handle, request.headers.get('range'), 'video/webm')
  })

  // 起動時にプロジェクトフォルダ・URLを指定できる（E2Eと `ferret <folder>` 相当の用途）。
  // 指定がなければ WS-1 のとおり前回の値を復元する。
  // 開くプロジェクトは ADE_PROJECT_DIR → 前回のプロジェクト の順に決める。
  // 指定フォルダもプロジェクトとして登録し、2回目以降は同じプロジェクト（URLプリセット込み）を開く。
  const presetFolder = process.env.ADE_PROJECT_DIR
  const startupFolder = presetFolder && presetFolder.length > 0 ? presetFolder : loadedSettings.folderPath
  // 「すべてのプロジェクト」（エディタ全体）を用意する（無ければ作る）
  await ensureEditorWorkspace().catch((err: unknown) => reportHandled(err, { area: 'startup', op: 'prepare editor workspace' }))
  loadedSettings = currentSettings()
  let startupProject = presetFolder && presetFolder.length > 0
    ? null
    : loadedSettings.projects.find((p) => p.id === loadedSettings.activeProjectId) ?? null
  if (!startupProject && startupFolder) {
    const added = upsertProjectFolder(loadedSettings.projects, startupFolder)
    startupProject = added.project
    if (!added.alreadyPresent) updateSettings({ projects: added.projects })
  }
  // 開いていたプロジェクトが無ければ、全体（すべてのプロダクト）を開く。ふだんは1つのフォルダではなく全体で頼む
  if (!startupProject && !(presetFolder && presetFolder.length > 0)) startupProject = currentSettings().projects.find((p) => p.editorWorkspace) ?? null
  /** 起動時に開くタブ（そのプロジェクトで前に開いていたタブ）。無ければ loadedSettings.url の1枚 */
  let startupTabs: ProjectTabs | null = null
  if (startupProject) {
    updateSettings({ activeProjectId: startupProject.id, folderPath: startupProject.folderPath })
    loadedSettings = currentSettings()
    // そのプロジェクトで前に開いていた URL（無ければ登録 URL の先頭）から始める
    const saved = loadedSettings.projects.find((p) => p.id === startupProject!.id) ?? startupProject
    const tabs = sessionTabs(saved)
    if (tabs.urls.length > 1 || tabs.urls[0] !== DEFAULT_URL || !loadedSettings.url) {
      loadedSettings = { ...loadedSettings, url: tabs.urls[tabs.active] ?? DEFAULT_URL }
      startupTabs = tabs
    }
  }
  if (loadedSettings.folderPath) {
    // 保持期間を過ぎた動画の掃除は窓を開くのを待たせない。小さな切れに分けて、あとから少しずつ進める（security-5 [7]）
    const { scheduleRetention } = await import('./sessions')
    scheduleRetention(loadedSettings.folderPath, { keepDays: loadedSettings.capture?.keepDays ?? 7,
      onError: (err) => reportHandled(err, { area: 'sessions', op: 'prune recordings' }) })
  }
  const presetUrl = process.env.ADE_INITIAL_URL
  if (presetUrl && presetUrl.length > 0) {
    loadedSettings.url = presetUrl
    startupTabs = null
  }

  // Agent のタブで実行ファイルを探すためのログインシェルの PATH を、前回の起動の値ですぐ使えるようにし、裏で取り直す（agentDetection.ts）
  void warmLoginShellPath(join(app.getPath('userData'), 'login-shell-path.json'))
  terminals = new TerminalManager(
    (id, data) => send('terminal:data', id, data),
    (id, code) => send('terminal:exit', id, code)
  )
  // 判定モデルを有効にしていれば、タブごとに中継の URL（合言葉付き）・モデル・画像の可否を渡す。キーは渡さない
  // Agent どうしの依頼（既定は入）。タブごとの合言葉と CLI の場所も渡す（src/main/agentMail.ts）
  terminals.launchEnv = async (meta) => ({
    ...(currentSettings().decision?.enabled
      ? await (await decision()).launchEnv({ ...(workspace.projectId ? { projectId: workspace.projectId } : {}), ...(meta.agent ? { agent: meta.agent } : {}), sessionId: meta.sessionId })
      : {}),
    ...(await agentMailEnv(meta.sessionId).catch((err: unknown) => { reportHandled(err, { area: 'agent-mail', op: 'terminal env' }); return {} })),
    // 動画づくりの CLI（ferret-video）を PATH に置く（src/video/app/main/cli/env.ts）
    ...(await videoTerminalEnv(videoContext).catch((err: unknown) => { reportHandled(err, { area: 'video', op: 'terminal env' }); return {} })),
    // browser-use で内蔵ブラウザを動かす（BU_CDP_URL。src/main/browserAutomation.ts）
    ...(await (await browserAutomation()).env().catch((err: unknown) => { reportHandled(err, { area: 'browser', op: 'automation env' }); return {} }))
  })
  // タブが閉じたら、そのタブに渡した中継の合言葉を無効にする（残った子プロセスが使い続けられないように）
  terminals.onSessionClosed = (sessionId) => { decisionService?.revokeSession(sessionId); revokeAgentMailSession(sessionId) }
  terminals.onCreated = agentMailTerminalCreated
  initAgentMail({ terminals, launch: (request) => send('agentMail:launch', request) })
  // ターミナルを速く開く：次の素のシェルを先に起動しておく。タブの環境変数を決めるもの（プロジェクト・判定モデル）が変われば作り直す
  terminals.spareShells = process.env.ADE_TERMINAL_PREWARM !== '0'
  terminals.spareContext = () => JSON.stringify([workspace.projectId ?? null, currentSettings().decision ?? null, currentSettings().agents.agentMail])
  // 上限での自動切り替え。新しいタブは renderer が開き、引き継ぎは main が行う
  initFailover({ terminals, launch: (request) => send('failover:launch', request), notice: (notice) => send('failover:notice', notice) })
  // 文字起こし・整理の API 呼び出しも同じ記録へ（src/main/decision/callLog.ts の recordApiCall）
  void import('./decision/callLog').then(({ setApiCallSink }) => setApiCallSink(recordCall))
  syncDecision()

  mainWindow = createWindow()
  // 使用量（フッター左下）。窓が前にあるときだけ取りに行く
  attachUsageWindow(mainWindow, (state) => {
    send('usage:changed', state)
    // 選択中のアカウントが上限に近ければ、新しく開く Agent のアカウントを切り替える（src/main/failover）
    onUsageChanged(state)
  })
  // 読み込み直し（⌘R・開発時の再読込）より前のターミナルは、どのタブにも付かずに残る
  mainWindow.webContents.on('did-start-loading', () => {
    resources.markRendererLoad()
    terminals?.resetFlow()
  })
  setWorkspace(loadedSettings.folderPath, startupProject)
  syncOrchestratorOnOpen(startupProject)
  // 起動の引数で開いて登録したプロジェクトも、「すべてのプロジェクト」に入れる
  if (!startupProject?.editorWorkspace) syncEditorWorkspace()
  // 最初のタブを開く要求が届く前に、node-pty の読み込みと最初のシェルの起動（rc の読み込み）を済ませておく
  terminals.prewarm()
  registerIpc()
  // 動画づくり: 投稿の受け渡しの見張りなど（src/video/app/main/ipc.ts）
  if (!IS_E2E) startVideo(videoContext)
  // 発信の下書きを、最近の変更から裏で作り置く（新しいコミットがあり、未使用が少ないときだけ。src/main/publish/background.ts）
  if (!IS_E2E) publishBackground.start()
  // 裏での更新。配布版だけ、起動から少し待って確かめ、あとは6時間ごと（開発版・E2E では動かさない）
  autoUpdater().start()
  // スリープ明けはすぐ、ウインドウに戻ったときは前の確認から1時間たっていれば確かめる（6時間ごとの確認はスリープで遅れる）
  // スリープ明けはネットワークが戻るのを待ってから確かめる（autoUpdate.ts の resumed）
  powerMonitor.on('resume', () => autoUpdater().resumed())
  // PC を閉じた（スリープ）ときに作業の途中だった Agent は、戻ったあと止まっていれば続きから再開するよう頼む
  powerMonitor.on('suspend', () => void rememberWorkBeforeSleep())
  powerMonitor.on('resume', () => { setTimeout(() => void resumeWorkAfterSleep(), RESUME_AFTER_WAKE_MS).unref?.() })
  mainWindow.on('focus', () => void autoUpdater().checkIfStale(UPDATE_RECHECK_ON_FOCUS_MS)?.catch(() => undefined))
  // settings.json の外部の変更（利用者のエディタ・Claude Code など）をその場で反映する。壊れていれば画面に知らせるだけ
  watchSettings(applyExternalSettings, (error) => send('settingsFile:error', error))
  // スマホから操作を入れていれば、ターミナルの用意ができたここで開く
  syncMobileRemote()
  installMenu({
    onOpenFolder: () => void openFolderDialog(),
    // メニューの操作も利用者の操作（録画の開始など。⌘⇧R）
    onCommand: (command) => { gestures.noteGesture(); send('menu:command', command) }
  })

  // プレビュー（ade-preview://）は内蔵ブラウザと、エディタの横並びの iframe（既定のセッション）の両方で開く。
  // 前回のURLがプレビューでも開けるよう、内蔵ブラウザを作る前に登録する
  registerPreviewProtocol([session.defaultSession], () => workspace.folderPath)
  // 内蔵ブラウザの session（ログインの組ごと）を用意したら、プレビューとプロジェクトのページを返せるようにし、拡張機能を読み込む
  onBrowserSessionReady((ses) => {
    registerPreviewProtocol([ses], () => workspace.folderPath)
    // プロジェクトの HTML は内蔵ブラウザの session でだけ返す（アプリの画面の session からは読めない。security-7 [2][6]）
    if (!ses.protocol.isProtocolHandled(PROJECT_PAGE_SCHEME)) ses.protocol.handle(PROJECT_PAGE_SCHEME, async (request) => {
      const { projectPageResponse } = await import('./projectPage')
      return projectPageResponse(workspace.folderPath, request.url).catch((err: unknown) => {
        reportHandled(err, { area: 'browser', op: 'serve project page' })
        return new Response('Error', { status: 500, headers: { 'Content-Type': 'text/plain' } })
      })
    })
    void extensions?.sync(currentSettings().browserExtensions)
  })
  browserSession()

  // 内蔵ブラウザと renderer は並行して起動する（設計 1.3）
  browser = new EmbeddedBrowser()
  browser.onStateChange((state) => {
    // WS-1 復元用に、実際に表示しているURLを控える（入力そのままではなく正規化後）
    // 題名・読み込みの変化でも届く。URL が同じなら設定を書き直さない（題名が毎秒変わるページで毎秒保存していた）
    if (state.url && state.url !== 'about:blank' && state.url !== currentSettings().url) updateSettings({ url: state.url })
    recordProjectUrl(state)
    send('browser:stateChanged', state)
    for (const listener of browserTabListeners) listener()
  })
  // タブ（@shared/browserTabs）。どのタブも録画に結びつけ、前に出ているタブを録る（recording/controller.ts の selectBrowserTab）
  browser.onTabCreated = (contents) => {
    recording?.attach(contents)
    // ページを押したら、拡張機能のポップアップは閉じる（Chrome と同じ）。書き込みの最中は閉じない
    contents.on('input-event', (_event, input) => { if (input.type === 'mouseDown') dismissExtensionPopup('page') })
  }
  browser.onActiveTab = (contents) => recording?.selectBrowserTab(contents)
  browser.onTabClosed = (contents) => recording?.browserTabClosed(contents)
  // 録画がそのタブを録っている間は、閉じても中身を残す（録画が終わったら閉じる）
  browser.keepClosedTab = (contents) => recording?.usesContents(contents) ?? false
  // ページのキー（⌘T）で新しいタブを開いた。アプリの画面の URL 欄へ焦点を移して、そのまま URL を打てるようにする
  browser.onFocusUrl = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.focus()
    send('menu:command', 'focusUrl')
  }
  browser.onNotice = (message) => send('browser:notice', message)
  // 表示幅の切替を操作ログへ残す（WS-3 → viewport イベント）
  browser.onViewportChange = (width) => recording?.recordViewport(width)
  // 文字で指摘の静止画は、そのビューへの本物の入力の直後だけ（noteInputs）
  browser.onPageInput = (contents) => noteInputs.sawInput(contents)
  // ログインのポップアップ。録画中はその窓も録り、前に出たら書き込む先をそちらへ切り替える（recording/controller.ts）
  browser.onPopupWindow = (contents, url) => recording?.attachPopupWindow(contents, url)
  // アプリの画面の読み込みは先に始める（拡張機能を待つ間〔最大 2 秒〕も JS を読む）。
  // 画面から先に届いた内蔵ブラウザの問い合わせは、attach の前は空の状態を返し、attach のあとの browser:stateChanged で揃う
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const rendererLoad = rendererUrl ? mainWindow.loadURL(rendererUrl) : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  // 失敗は下の await で投げる（待つ前に失敗しても、未処理の拒否にしない）
  rendererLoad.catch(() => undefined)
  // 内蔵ブラウザの拡張機能。content script を最初のページにも効かせるため、ページを開く前に読み込む（待つのは少しだけ）
  await startBrowserExtensions(loadedSettings.browserExtensions)
  browser.setPartition(browserPartition(currentSettings().projects.find((p) => p.id === currentSettings().activeProjectId)?.browserProfile))
  browser.attach(mainWindow, startupTabs ?? loadedSettings.url, loadedSettings.viewport)
  browser.setBackgroundColor(nativeThemeBackground())
  mark('browser:attached')
  // 前回ウインドウを選んでいたなら、起動したときからそれを映す
  void syncMirror()
  // 入れてある設定の skill を、この版の設定の項目に合わせる
  syncAgentSkillOnStart()
  syncAgentMailSkillNow()
  syncBrowserSkillNow()

  await rendererLoad
  mark('renderer:loaded')
  console.log(`[startup] renderer 読み込み完了 ${elapsedMs()}ms`)
}

// 単一ウィンドウのアプリなので、macOS でもウィンドウなしで残らない
app.on('window-all-closed', () => {
  app.quit()
})

/** SIGHUP を無視するシェルを強制終了に切り替えるまでの時間 */
const QUIT_PTY_ESCALATE_MS = 500
/** PTYの終了通知を待つ上限。超えたら警告してそのまま終了する */
const QUIT_PTY_TIMEOUT_MS = 2000
/** app.quit() のあと、これだけ経っても終わらなければ強制的に終了する */
const QUIT_WATCHDOG_MS = 3000

/** 終了処理の状態。入口が複数あるので1か所で持つ */
let shutdownPhase: 'running' | 'draining' | 'ready' = 'running'

/** 終了の前に未保存の確認が要るか（E2E では聞かない） */
function needsUnsavedPrompt(): boolean {
  return unsavedFiles.length > 0 && !discardUnsavedConfirmed && !IS_E2E
}

/**
 * 未保存の確認を出し（出している間は出し直さない）、終了してよいと答えたら改めて app.quit() する。
 * 入口（ウィンドウの close・⌘Q・メニューの終了）はどれも、ここからは app.quit() で続ければよい
 * （ウィンドウを閉じる＝終了。準備のできた更新は quit のときに入る）。
 */
function askUnsavedThenQuit(): void {
  if (unsavedPromptOpen) return
  unsavedPromptOpen = true
  void resolveUnsavedBeforeQuit()
    .then((ok) => { if (ok) app.quit() })
    .catch((err: unknown) => reportHandled(err, { area: 'editor', op: 'unsaved on quit' }))
    .finally(() => { unsavedPromptOpen = false })
}

/**
 * 終了の入口（ウィンドウの close / before-quit）を1つにまとめたもの。
 *
 * PTYが残っていれば、その場の終了をいったん止めて（戻り値 true）、
 * 全PTYの onExit が届くのを待ってから改めて `app.quit()` する。
 * ここで待たないと、node-pty の ThreadSafeFunction が Node の環境解体に重なり、
 * プロセスが abort する（SIGABRT）。
 *
 * @returns 呼び出し側が今回の終了を見送るべきなら true
 */
function beginShutdown(): boolean {
  console.log('[STEP] beginShutdown phase=' + shutdownPhase)
  if (shutdownPhase === 'ready') return false
  // 未保存のファイルがあれば、今回の終了は見送り（true）、確認の答えを待つ。保存して終了・保存せずに終了なら改めて終了する
  if (shutdownPhase === 'running' && needsUnsavedPrompt()) {
    askUnsavedThenQuit()
    return true
  }
  shuttingDown = true
  // スマホからの入力を受けないよう、終了を始めたら口を閉じる
  void mobileRemote?.stop()
  // ネイティブのクラッシュのイベントにも残るパンくず（終了のどの段階で落ちたかを追う。FERRET-1Q）
  if (shutdownPhase === 'running') {
    flow('quit begin', { terminals: terminals?.pendingCount() ?? 0 })
    // ここからの片付け（同期の書き込み・PTY を閉じる）の止まりは main の止まりとして送らない（FERRET-M）
    noteQuitRequested()
  }

  if (shutdownPhase === 'draining') {
    // すでに後始末中。終わるまで待たせる
    return true
  }

  flushSettingsSync()
  // ターミナルのタブと画面の文字（PTY を閉じる前に、renderer から最後の分を受け取ってもう一度書く。drainTerminalsAndQuit）
  terminalRestoreStore?.flushSync()
  fileWatcher.close()

  /*
   * 録画中なら、その時点までの記録を閉じてから終わる（NF-12）。
   * 動画の最後のチャンクと操作ログを書き終えるまで、終了を見送る。
   */
  if (recording && recording.status.state !== 'idle') {
    shutdownPhase = 'draining'
    console.log('[STEP] recording.stop 開始')
    void recording
      .stop()
      .then(() => { console.log('[STEP] recording.stop 完了'); return audioWriter?.flush() })
      .catch((err: unknown) => { console.warn('[recording] 停止に失敗しました', err); reportHandled(err, { area: 'recording', op: 'stop on quit' }) })
      .then(() => {
        console.log('[STEP] flush 完了')
        audioWriter = null
        recording?.dispose()
        recording = null
        // 録画を閉じたら、そのままPTYの後始末へ進む。
        // ここで app.quit() だけ呼ぶと、生きたままのPTYが Node の環境解体を
        // 止めてしまい、アプリが終了できなくなる
        drainTerminalsAndQuit()
      })
    return true
  }
  recording?.dispose()
  recording = null
  audioWriter = null

  // 内蔵ブラウザ（WebContentsView）はここで破棄しない。
  // ウィンドウを閉じる処理と removeChildView / webContents.close() が重なると、
  // Electron のネイティブ側で二重破棄になりうる。後始末は Electron に任せる。

  if (!terminals || terminals.pendingCount() === 0) {
    // 開いている途中のタブ（起動時にタブを戻している途中など）がこの後で PTY を起動しないよう、新しく開くのも止める（FERRET-20）
    terminals?.disposeAll()
    terminalRestoreStore?.finish()
    shutdownPhase = 'ready'
    return false
  }

  shutdownPhase = 'draining'
  drainTerminalsAndQuit()
  return true
}

/**
 * 全PTYの終了通知を待ってから `app.quit()` する。
 * 終了の経路がどれであっても（ウィンドウを閉じる / Cmd+Q / 録画の後）ここを通す。
 */
function drainTerminalsAndQuit(): void {
  shutdownPhase = 'draining'
  // PTY を閉じる前に、今のタブと画面の文字を受け取って書く（閉じると「終了しました」の行が画面に足される）
  void collectTerminalRestore()
    .catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'collect terminal restore' }))
    .finally(() => {
      terminalRestoreStore?.finish()
      drainTerminalsNow()
    })
}

function drainTerminalsNow(): void {
  const pending = terminals?.pendingCount() ?? 0
  const finish = (): void => {
    shutdownPhase = 'ready'
    app.quit()

    /*
     * 最後の保険。PTYの子プロセスが残ってハンドルを掴んでいると、
     * Nodeの環境解体が終わらずアプリが終了できなくなることがある。
     * 設定の保存とPTYの後始末は済んでいるので、ここまで来たら強制的に落とす。
     */
    const watchdog = setTimeout(() => {
      console.warn(`[quit] ${QUIT_WATCHDOG_MS}ms 経っても終了できないため、強制的に終了します`)
      flow('quit watchdog')
      // app.exit では quit が届かないので、閉じたときの更新はここで入れる
      autoUpdates?.installOnQuit()
      app.exit(0)
    }, QUIT_WATCHDOG_MS)
    watchdog.unref?.()
  }

  if (!terminals || pending === 0) {
    finish()
    return
  }

  void terminals
    .disposeAllAndWait({
      escalateAfterMs: QUIT_PTY_ESCALATE_MS,
      timeoutMs: QUIT_PTY_TIMEOUT_MS
    })
    .then(({ clean, pending: left, waitedMs }) => {
      flow('quit terminals', { closed: pending, left, waitedMs })
      if (clean) {
        console.log(`[terminal] 終了前にPTYを片付けました（${pending}件 / ${waitedMs}ms）`)
      } else {
        // 待ち続けるとアプリを終了できなくなるため、警告だけ出して進める
        console.warn(
          `[terminal] ${QUIT_PTY_TIMEOUT_MS}ms 以内に終了通知が届かないPTYが${left}件あります。そのまま終了します`
        )
      }
      finish()
    })
}

app.on('before-quit', (event) => {
  if (beginShutdown()) event.preventDefault()
})

// 準備のできた更新は、閉じたときに入れる（起動し直さない。次に開いたとき新しい版）。落ちたとき（0 以外）は入れない
app.on('quit', (_event, exitCode) => {
  // Agent どうしの依頼の受け口（一時フォルダ）を消す
  stopAgentMail()
  stopVideo()
  publishBackground.stop()
  void mobileRemote?.stop()
  if (exitCode === 0) autoUpdates?.installOnQuit()
})

app.on('activate', () => {
  // ウィンドウを閉じたら終了するので、ここで作り直す経路は持たない
  if (HIDE_WINDOW) return
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
})

void main().catch((err) => {
  console.error('[main] 起動に失敗しました', err)
  reportMainError(err, { kind: 'startup' })
  dialog.showErrorBox(t('dialog.startupFailed'), String(err))
  app.exit(1)
})
