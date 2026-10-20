import { app, BrowserWindow, crashReporter, dialog, powerMonitor, session, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import * as Sentry from '@sentry/electron/main'
import { IS_PACKAGED } from './runtime'
import {
  crashReportsEnabled,
  createEventLimiter,
  parseSentryTestKinds,
  resolveSentryDsn,
  sentryEnv,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  sentryRelease,
  shouldReportLoadFailure,
  shouldReportProcessGone,
  shouldSendCrashReports,
  telemetryProfile,
  createAnomalyGate,
  createLogRing,
  createSendGate,
  gateTransport,
  resolveEnvironment,
  startupBreadcrumb,
  isCrashEvent,
  resolveInstallId,
  createBreadcrumbFilter,
  createInflightTracker,
  eventLoopBlockContext,
  eventLoopBlockThreshold,
  shouldReportEventLoopBlock,
  type ScrubContext,
  type SentryTestKind,
  classifyStaleBuild,
  gcKindName,
  isNativeCrashEvent,
  minimizeNativeCrash,
  shouldSendNativeCrash,
  filterTransport,
  memoryBucket,
  uptimeBucket
} from '@shared/telemetry'
import { parseMinidumpCrash } from '@shared/minidump'
import { flow, noteSlowOp, recentSlowOps, reportHandled, reportPerf, setReporter } from '@shared/report'
import { version } from '../../package.json'
import { configDir, currentSettings } from './settings'
import { attachDebugIds, remapDevFrames } from './telemetrySourceMaps'

/**
 * クラッシュレポート（Sentry）。設定の「クラッシュレポートを送る」と src/shared/telemetry.ts を参照。
 *
 * - 配布版（production）と dev 起動（development）の両方で送る。E2E・単体テストでは初期化しない。
 *   配布版は JS の例外を半分・1回の起動で10件まで、dev は全部・50件まで。同じエラーはどちらも1度だけ。
 * - 起動時に設定が OFF なら初期化しない。起動後に OFF にしたら beforeSend で全部捨てる
 *   （ON に戻したときは次の起動から送る。minidump の受け口は ready の前にしか入れられないため）。
 * - 起動ごとのセッション（リリースごとのクラッシュしなかった割合・使っている人の数）は送る。
 *   利用者はインストール ID（userData に置くランダムな UUID）だけで数え、名前・メール・IP は送らない。
 * - パフォーマンスの計測・リプレイ・スクリーンショットは使わない。
 * - クラッシュ（minidump・fatal・捕まえていない例外）には、main の直近50行のログ（見出し付きの行だけ・伏せ字済み）を添付する。
 * - 未処理の例外のほかに、レンダラー・子プロセスの異常終了、ウインドウの応答なし、アプリ側の読み込み失敗、
 *   PTY の起動失敗、IPC のハンドラの例外を、kind のタグ付きで送る。
 * - dev は送る前にスタックを元のファイルと行へ戻す（telemetrySourceMaps.ts）。
 */

/** 初期化したか（設定画面の「次の起動から」の案内と、renderer の初期化の判断に使う） */
let active = false
/** 確認用にわざと起こす例外（FERRET_SENTRY_TEST） */
let testKinds: SentryTestKind[] = []
/** 同じ例外を2つの経路（PTY の起動失敗と、それを投げた IPC）から二重に送らない */
const reported = new WeakSet<object>()
/** クラッシュに添付する main の直近のログ */
const logRing = createLogRing(undefined, () => scrubContext())

/** インストール ID（userData の telemetry-install-id）。無ければ作って保存する。書けなくてもこの起動の間は使う */
function installId(): string {
  const file = join(app.getPath('userData'), 'telemetry-install-id')
  let saved: string | null = null
  try {
    saved = readFileSync(file, 'utf8')
  } catch {
    // 初回起動（想定内）
  }
  const { id, created } = resolveInstallId(saved, randomUUID)
  if (created) {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file, `${id}\n`, 'utf8')
    } catch {
      // 保存できない環境でも、この起動の間は同じ ID を使う（想定内）
    }
  }
  return id
}

/** 匿名フィードバックの中継に添えるインストール ID（Sentry と同じもの。頻度の上限に使うだけ。src/main/feedback.ts） */
export function telemetryInstallId(): string {
  return installId()
}

/** どの画面・状態で落ちたか（タグ）。mode = editor / feedback、recording = idle / recording / paused */
export function setTelemetryContext(context: { mode?: string; recording?: string }): void {
  if (!active) return
  if (context.mode) Sentry.setTag('app.mode', context.mode)
  if (context.recording) Sentry.setTag('recording', context.recording)
}

export function crashReportsActive(): boolean {
  return active
}

export function sentryTestKinds(): SentryTestKind[] {
  return active ? testKinds : []
}

/** 設定はまだ読み込んでいない（非同期）ので、ここだけ settings.json を同期で読む */
function readCrashReportsSetting(): boolean {
  try {
    // 設定は ~/.ferret/settings.json（src/main/settings.ts の configDir）。まだ移していなければ以前の userData/settings.json
    const file = [join(configDir(), 'settings.json'), join(app.getPath('userData'), 'settings.json')].find((f) => existsSync(f))
    if (!file) return true
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { crashReports?: unknown }
    return raw.crashReports !== false
  } catch {
    return true
  }
}

function scrubContext(): ScrubContext {
  const s = currentSettings()
  const projectPaths = [...s.projects.map((p) => p.folderPath), ...(s.folderPath ? [s.folderPath] : [])]
  // 長いパスから先に置き換える（親フォルダで先に置き換わると子が残る）
  return { homeDir: homedir(), projectPaths: [...new Set(projectPaths)].sort((a, b) => b.length - a.length) }
}

/** dev の release に付けるコミット。取れなければ null（release は +dev になる） */
function devGitHash(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: app.getAppPath(), timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** main で捕まえた例外を kind のタグ付きで送る。初期化していなければ何もしない */
export function reportMainError(err: unknown, tags: Record<string, string>): void {
  if (!active) return
  if (err && typeof err === 'object') {
    if (reported.has(err)) return
    reported.add(err)
  }
  Sentry.captureException(err, { tags })
}

/**
 * 例外ではない異常（プロセスの終了・応答なし・読み込み失敗）を送る。
 * captureMessage は送る処理の中のスタック（Electron のイベントの発火元）を付け、Sentry の題名が
 * `<object>.touch` のようなフレームの名前になってしまうので、スタックを付けずに送る（題名が文のまま出る）
 */
function reportMessage(message: string, level: 'error' | 'warning', tags: Record<string, string>): void {
  if (active) Sentry.captureEvent({ message, level, tags })
}

/**
 * アプリ自身の画面か。内蔵ブラウザ（利用者のページ）は別のセッション（browser.ts の PARTITION）で開くので、
 * 既定のセッションのものだけをアプリの画面（main の renderer・録画ウインドウ・プレビュー）として扱う。
 */
function isOwnContents(contents: WebContents): boolean {
  try {
    return contents.session === session.defaultSession
  } catch {
    // 破棄済みの webContents は session を読めない。判断できないものは送らない側に倒す
    return false
  }
}

function watchWebContents(contents: WebContents): void {
  contents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!shouldReportLoadFailure({ ownPage: isOwnContents(contents), errorCode, isMainFrame })) return
    // URL は送らない（scrub でも落ちるが、メッセージに入れない）
    reportMessage(`did-fail-load: ${errorDescription} (${errorCode})`, 'error', {
      kind: 'did-fail-load', 'load.errorCode': String(errorCode), 'contents.type': contents.getType()
    })
  })
  // preload の読み込み中の例外（renderer の Sentry には上がってこない）。どの preload かは名前だけ
  contents.on('preload-error', (_e, preloadPath, error) => {
    reportMainError(error, { kind: 'preload-error', preload: preloadPath.split(/[\\/]/).pop() ?? 'unknown' })
  })
  contents.on('unresponsive', () => {
    if (isOwnContents(contents)) reportMessage('webContents unresponsive', 'warning', { kind: 'unresponsive', 'contents.type': contents.getType() })
  })
}

const anomalyGate = createAnomalyGate()

/**
 * main のイベントループが長く止まったら warning を送る（種類ごとに10分に1度）。
 * 250ms ごとのタイマーの遅れで測る。スタックは取れない（ネイティブの計測は入れていない）。
 */
/** 処理中の IPC（止まったときの手がかり）。index.ts の IPC の登録が trackIpc で包む */
const inflightIpc = createInflightTracker()

/** IPC のハンドラの開始と終了を控える。長くかかったもの（1秒以上）は重い処理としても控える */
export function trackIpc(channel: string): () => void {
  const end = inflightIpc.begin(channel)
  return () => {
    const ms = end()
    if (ms >= 1000) noteSlowOp(`ipc:${channel}`, ms)
  }
}

/**
 * アプリ自身の終了の手順を始めた（index.ts の beginShutdown。ウィンドウの close からも来る）。
 * ウィンドウを閉じた終了では、PTY の後始末が終わって app.quit() するまで before-quit が来ないので、
 * その間の片付けの止まりも終了の途中として送らない（FERRET-M の 0.6.12 の Windows：quit begin の後に 3.8s）
 */
let onQuitRequested: (() => void) | null = null
export function noteQuitRequested(): void {
  onQuitRequested?.()
}

/** initCrashReporting から呼ぶ。テスト（telemetry-quit-block.test.ts）からも直接呼ぶ */
export function watchEventLoop(threshold: number): void {
  const INTERVAL = 250
  // 単調な時計で測る（Date.now は時計合わせ・スリープで飛ぶ）
  let expected = performance.now() + INTERVAL
  // 送らない遅れの見分け（shouldReportEventLoopBlock）：終了の途中・裏にいる間（App Nap）・スリープから戻った直後
  let quitting = false
  // 閉じる操作（before-quit）から will-quit までの片付けの止まりは送らない（shouldReportEventLoopBlock の msSinceQuitRequest）
  let quitRequestedAt: number | null = null
  let resumedAt: number | null = null
  let suspendedAt: number | null = null
  // OS が掛けている CPU の速度の上限（止まりの手がかり。eventLoopBlockContext の cpuSpeedLimit）
  let cpuSpeedLimit: number | null = null
  const isActive = (): boolean => app.isReady() && BrowserWindow.getFocusedWindow() !== null
  let activeAtLastTick = false
  app.on('will-quit', () => { quitting = true })
  app.on('before-quit', () => { quitRequestedAt = performance.now() })
  onQuitRequested = () => { quitRequestedAt = performance.now() }
  void app.whenReady().then(() => {
    // powerMonitor は ready の後でしか使えない
    powerMonitor.on('resume', () => { resumedAt = performance.now() })
    powerMonitor.on('suspend', () => { resumedAt = null; suspendedAt = performance.now() })
    powerMonitor.on('speed-limit-change', (details: { limit?: unknown }) => { cpuSpeedLimit = typeof details?.limit === 'number' ? details.limit : null })
  })
  // 補助技術の切り替え（FERRET-M では 25 秒ごとに来ていた）。パンくずには残さないので、最後の時刻だけ覚える
  let axChangedAt: number | null = null
  app.on('accessibility-support-changed', () => { axChangedAt = Date.now() })
  // 長い GC（ゴミ集め）も重い処理として控える。JS のスタックに出ない止まりの手がかり
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        noteSlowOp(`gc:${gcKindName((entry as { detail?: { kind?: unknown } }).detail?.kind)}`, entry.duration)
      }
    }).observe({ entryTypes: ['gc'] })
  } catch {
    // GC を観測できない環境では手がかりが減るだけ
  }
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = now - expected
    expected = now + INTERVAL
    // 遅れの前（前の回）と後（今）の両方で前面だったときだけ、利用者が待たされた止まりとみなす
    const activeNow = isActive()
    const appActive = activeAtLastTick && activeNow
    activeAtLastTick = activeNow
    const report = shouldReportEventLoopBlock({
      lagMs: lag, thresholdMs: threshold, quitting, appActive,
      msSinceQuitRequest: quitRequestedAt === null ? null : now - quitRequestedAt, msSinceResume: resumedAt === null ? null : now - resumedAt,
      msSinceSuspend: suspendedAt === null ? null : now - suspendedAt
    })
    if (report && anomalyGate('event-loop')) {
      // 手がかり：まだ終わっていない IPC（長い順の上位3つ）、直前に終わった重い処理（同期の fs・ps・which・GC など）、メモリの量、補助技術
      const inflight = inflightIpc.snapshot()
      const memory = process.memoryUsage()
      const ax = { axEnabled: app.accessibilitySupportEnabled, axChangedMsAgo: axChangedAt === null ? null : Date.now() - axChangedAt, cpuSpeedLimit }
      // GC の記録は少し遅れて届くので、待ってから重い処理を集める
      setTimeout(() => {
        reportPerf('event-loop-block', lag, eventLoopBlockContext(inflight, recentSlowOps(Date.now()).slice(0, 3), {
          heapUsedMb: memory.heapUsed / 2 ** 20, rssMb: memory.rss / 2 ** 20, ...ax
        }))
      }, 100).unref?.()
    }
  }, INTERVAL)
  timer.unref?.()
}

/**
 * main のメモリの量と起動からの時間を、区分が変わったときだけ scope のタグにする。
 * scope はディスクに控えられ、main がネイティブに落ちたときは次の起動でクラッシュのイベントに付く
 * （落ちる直前のメモリの量が分かる。値は区分だけ）
 */
function watchMainHealth(): void {
  let last = ''
  const tick = (): void => {
    const memory = process.memoryUsage()
    const tags = { 'mem.rss': memoryBucket(memory.rss / 2 ** 20), 'mem.heap': memoryBucket(memory.heapUsed / 2 ** 20), uptime: uptimeBucket(process.uptime()) }
    const key = JSON.stringify(tags)
    if (key === last) return
    last = key
    Sentry.setTags(tags)
  }
  tick()
  setInterval(tick, 30_000).unref?.()
}

function installProcessHooks(): void {
  app.on('render-process-gone', (_e, _contents, details) => {
    if (!shouldReportProcessGone(details.reason)) return
    reportMessage(`render-process-gone: ${details.reason}`, 'error', { kind: 'render-process-gone', reason: details.reason, exitCode: String(details.exitCode) })
  })
  app.on('child-process-gone', (_e, details) => {
    if (!shouldReportProcessGone(details.reason)) return
    reportMessage(`child-process-gone: ${details.type} ${details.reason}`, 'error', {
      kind: 'child-process-gone', reason: details.reason, 'process.type': details.type, exitCode: String(details.exitCode), ...(details.name ? { 'process.name': details.name } : {})
    })
  })
  // ウインドウの応答なしは webContents の unresponsive で拾う（BrowserWindow 以外の view も含む）
  app.on('web-contents-created', (_e, contents) => watchWebContents(contents))
  // console.error / warn のうち `[startup]` の失敗だけをパンくずに残す（console 全体は送らない）。
  // 見出し付きの行は、クラッシュに添付する直近のログ（logRing）にも残す
  for (const level of ['log', 'error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      logRing.push(level, args)
      if (level !== 'log' && typeof args[0] === 'string' && args[0].startsWith('[startup]')) {
        Sentry.addBreadcrumb(startupBreadcrumb(level === 'warn' ? 'warning' : 'error', args))
      }
      original(...args)
    }
  }
}

/** 他の初期化より先に、ready の前に呼ぶ（minidump を受けるため） */
export function initCrashReporting(): void {
  const dsn = resolveSentryDsn(process.env)
  const send = shouldSendCrashReports({
    e2e: process.env.ADE_E2E === '1',
    forced: sentryEnv(process.env, 'FORCE') === '1',
    unitTest: Boolean(process.env.VITEST),
    enabled: readCrashReportsSetting(),
    dsn
  })
  if (!send || !dsn) {
    // 送らないときも、クラッシュは Crashpad でローカルに受け止める（外部送信はしない）
    crashReporter.start({ uploadToServer: false, compress: true })
    return
  }

  const packaged = IS_PACKAGED
  const profile = telemetryProfile(packaged)
  const forced = sentryEnv(process.env, 'FORCE') === '1'
  // 補助技術の切り替えの通知のような騒がしい出来事と、同じものの連続を間引く
  const keepBreadcrumb = createBreadcrumbFilter()
  /*
   * 「クラッシュレポートを送る」を起動中に OFF にしたら、その瞬間から何も送らない（エラー・warning・性能の異常・
   * セッション・添付・renderer のイベント。renderer のイベントも main の transport を通る）。settings.json を外から
   * 書き換えた場合も、読み込み直した設定（currentSettings）で決まる。ON に戻したらそこから送り、セッションを始め直す
   */
  const gate = createSendGate(() => crashReportsEnabled(currentSettings()), {
    onDisable: () => Sentry.endSession(),
    onEnable: () => { Sentry.startSession(); Sentry.captureSession() }
  })
  // 何も送らないあいだも ON / OFF の切り替わりに気づけるよう、軽く見張る（セッションの始め直しのため）
  setInterval(() => gate.sync(), 2000).unref?.()
  const limit = createEventLimiter(profile.maxEventsPerRun)
  // 握りつぶしていた失敗・性能の異常（warning）は別に数え、クラッシュの枠を食わない
  const limitWarnings = createEventLimiter(profile.maxWarningsPerRun)
  // 外へ出るもの・画面の中身を拾うものは外す
  const DROP = new Set([
    'Screenshots',
    'Console', // console の出力（ターミナルの出力やパスが混ざる）
    'ElectronNet', // net の URL
    'NodeFetch',
    // スタックの変数の値（文字起こしや指摘の本文が入りうる）
    'LocalVariables',
    'LocalVariablesAsync',
    'LocalVariablesSync',
    'RendererEventLoopBlock',
    // 子プロセスの終了は installProcessHooks が kind のタグ付きで送る（パンくずだけ残す）
    'ChildProcess',
    'SentryMinidump'
  ])

  Sentry.init({
    dsn,
    release: packaged ? sentryRelease(version) : sentryRelease(version, { gitHash: devGitHash() }),
    // 確認用の起動（FERRET_SENTRY_FORCE・ADE_E2E）と -verify の版は verification（production のアラートと
    // クラッシュしなかった割合を汚さない）。src/shared/telemetry.ts の resolveEnvironment
    environment: resolveEnvironment({ packaged, version, forced, e2e: process.env.ADE_E2E === '1' }),
    // OFF のあいだは transport で全部止める（gate）
    // OFF のあいだはためもしない（外側）。ネットへ送る直前にも送ってよい項目だけに絞る（内側。前の版がためた minidump も送らない）
    transport: (options) => gateTransport(Sentry.makeElectronOfflineTransport((o) => filterTransport(Sentry.makeElectronTransport(o)))(options), gate.allow),
    // 利用者の情報（IP・Cookie・ヘッダ・本文・変数）は集めない（旧 sendDefaultPii: false にあたる）
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false }
    },
    attachScreenshot: false,
    maxBreadcrumbs: 30,
    integrations: (defaults) => [
      // minidump の受け口は先頭のまま、1回の起動で送る数だけ絞る
      Sentry.sentryMinidumpIntegration({ maxMinidumpsPerSession: 3 }),
      ...defaults.filter((i) => !DROP.has(i.name)),
      Sentry.childProcessIntegration({ events: [] }),
      Sentry.dedupeIntegration()
    ],
    initialScope: {
      // 端末ごとのランダムな ID だけ（影響を受けた人数・クラッシュしなかった人の割合のため。利用者の情報は含まない）
      user: { id: installId() },
      tags: {
        'os.platform': process.platform, arch: process.arch, electron: process.versions.electron,
        // 配布物の種類（OS と CPU）。Sentry の dist はソースマップの照合に使うので触らず、タグで分ける
        build: `${process.platform}-${process.arch}`,
        'app.mode': 'editor', recording: 'idle'
      }
    },
    // どのウインドウの renderer か（main のウインドウ・録画ウインドウ）
    getRendererName: (contents) => (contents.getURL().includes('/recorder/') ? 'recorder' : 'main-window'),
    // main の捕まえていない例外：E2E（画面を出さない確認）ではダイアログを出さずに終わる。
    // ふだんは Electron の既定と同じダイアログを出す（Sentry の既定の動きと同じ）
    onFatalError: (error: Error) => {
      if (process.env.ADE_E2E === '1') app.exit(1)
      else dialog.showErrorBox('A JavaScript error occurred in the main process', `Uncaught Exception:\n${error.stack ?? error.message}`)
    },
    beforeBreadcrumb: (crumb) => (gate.allow() && keepBreadcrumb(crumb) ? scrubBreadcrumb(crumb, scrubContext()) : null),
    beforeSend: async (event, hint) => {
      // 起動後に OFF にしたら、その時点から送らない（transport でも止めるが、添付や記録の前にここで捨てる）
      if (!gate.allow()) return null
      // 起動中に out/ が入れ替わった失敗（FERRET-X）: dev は送らない。配布版は kind: stale-build で1件にまとめる
      const classified = classifyStaleBuild(event, packaged)
      if (!classified) return null
      event = classified
      const minidump = (hint.attachments ?? []).find((a) => a.attachmentType === 'event.minidump')
      const native = isNativeCrashEvent(event, Boolean(minidump))
      // minidump からは例外の種類と落ちた場所のモジュール名だけを読む（本体は送らない）
      const dump = minidump && typeof minidump.data !== 'string' ? parseMinidumpCrash(minidump.data) : null
      // 届いた添付は全部捨てる（minidump のメモリの写し・renderer や scope からの添付は伏せ字を通せない。security-2 [13]）。
      // 送る添付は、このあと付ける伏せ字済みの main のログだけ（transport の filterEnvelope でも名前で絞る）
      hint.attachments = []
      // ネイティブのクラッシュは、プロセスの種類・終了の理由・版だけにする
      if (native) event = minimizeNativeCrash(event, dump)
      // 外から止められた子のプロセス（killed）はクラッシュではない（FERRET-1V）
      if (native && !shouldSendNativeCrash(event)) return null
      // 確認用の起動（FERRET_SENTRY_FORCE=1）では間引かない
      if (!forced && !sampleEvent(native, Math.random, profile.sampleRate)) return null
      if (!packaged) await remapDevFrames(event, { appPath: app.getAppPath(), rendererUrl: process.env.ELECTRON_RENDERER_URL }).catch(() => undefined)
      // 配布版：SDK の登録に無いファイル（preload など）にも debug ID を付け、ソースマップで元の行に戻せるようにする
      else attachDebugIds(event as Parameters<typeof attachDebugIds>[0], app.getAppPath())
      if (!(event.level === 'warning' ? limitWarnings : limit)(event)) return null
      // クラッシュには main の直近のログを添付する（見出し付きの行だけ・伏せ字済み）
      const log = logRing.snapshot()
      if (log && !native && isCrashEvent(event, false)) {
        hint.attachments = [...(hint.attachments ?? []), { filename: 'main-log.txt', data: log, contentType: 'text/plain' }]
      }
      return scrubEvent(event, scrubContext())
    }
  })
  installProcessHooks()
  watchEventLoop(eventLoopBlockThreshold(packaged))
  watchMainHealth()
  setReporter({
    handled: (err, tags, level) => Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { level, tags }),
    // 例外ではない異常（性能など）はスタックを付けずにそのまま送る（題名が文のまま出る）
    message: (message, tags, level, fingerprint, contexts) => Sentry.captureEvent({ message, level, tags, ...(fingerprint ? { fingerprint } : {}), ...(contexts ? { contexts } : {}) }),
    breadcrumb: (message, data) => Sentry.addBreadcrumb({ category: 'flow', message, ...(data ? { data } : {}) })
  })
  testKinds = parseSentryTestKinds(sentryEnv(process.env, 'TEST'))
  active = true
  runEarlyTests()
}

/**
 * 確認用の、アプリを止める・落とすもの（名前を書いたときだけ。src/shared/telemetry.ts の SENTRY_DESTRUCTIVE_TEST_KINDS）。
 *   hang         … 起動直後に main を 5.5 秒止める（起動が遅い・イベントループの停止の warning）
 *   uncaught     … main で捕まえていない例外（E2E ではダイアログを出さずに終わる）
 *   crash-main   … main のネイティブのクラッシュ（minidump は次の起動で送られる）
 *   crash-renderer … main のウインドウの renderer を強制的に落とす
 */
function runEarlyTests(): void {
  if (testKinds.includes('hang')) {
    // main のスレッドをわざと 5.5 秒止める（ビルドで消されない形。Node の main では Atomics.wait が使える）
    app.once('ready', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500) })
  }
}

/**
 * 確認用。FERRET_SENTRY_TEST に main が入っていれば、起動後に main で未処理の Promise の拒否を起こす。
 * renderer / boundary / ipc は renderer 側（src/renderer/lib/telemetry.ts）が起こす。
 */
export function maybeSendTestEvent(): void {
  const kinds = sentryTestKinds()
  if (kinds.includes('uncaught')) {
    setTimeout(() => { throw new Error(`Ferret Sentry test: main uncaught exception ${homedir()}`) }, 6000)
  }
  if (kinds.includes('crash-renderer')) {
    app.once('browser-window-created', (_e, win) => {
      win.webContents.once('did-finish-load', () => setTimeout(() => { if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer() }, 4000))
    })
  }
  if (kinds.includes('crash-main')) setTimeout(() => process.crash(), 8000)
  if (sentryTestKinds().includes('handled')) {
    // 握りつぶしていた失敗の経路（reportHandled）と、直前の流れのパンくず（flow）
    setTimeout(() => {
      flow('sentry test step', { step: 1 })
      reportHandled(new Error(`Ferret Sentry test: handled failure ${homedir()}`), { area: 'settings', op: 'sentry test' })
    }, 1500)
  }
  if (!sentryTestKinds().includes('main')) return
  setTimeout(() => {
    // ホームのパスを入れて、送る前に ~ へ置き換わることも確かめる
    void Promise.reject(new Error(`Ferret Sentry test: main unhandled rejection (${new Date().toISOString()}) ${homedir()}`))
  }, 1000)
}
