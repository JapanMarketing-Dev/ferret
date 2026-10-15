import { sanitizeBrowserExtensions } from '@shared/browserExtensions'
import { sanitizeGithubPreferences } from '@shared/repoCreate'
import { sanitizeLimitFailover } from '@shared/failover'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { IS_PACKAGED } from './runtime'
import { sanitizeStarPrompt } from '@shared/starPrompt'
import {
  DEFAULT_AGENT_PREFERENCES,
  DEFAULT_SPLIT_RATIO,
  DEFAULT_URL,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  type AgentPreferences,
  type Project,
  type Settings
} from '@shared/types'
import { sanitizeAgentPreferences } from '@shared/agentCatalog'
import { sanitizeCaptureTarget } from '@shared/captureTarget'
import { isAnnotationColor } from '@shared/annotation'
import { normalizeThemePreference } from '@shared/theme'
import { DEFAULT_LAYOUT, sanitizeLayout } from '@shared/layout'
import { normalizeLocalePreference } from '@shared/i18n'
import { normalizeSttLanguage } from '@shared/sttLanguages'
import { migrateLegacySettings } from './projects'
import { sanitizeProjectSession } from '@shared/projectSession'
import { sanitizeAgentRequestPrefs } from '@shared/agentRequests'
import { sanitizeOrchestraRules } from '@shared/orchestrator'
import { sanitizeProjectKind, sanitizeProjectTargets } from '@shared/projectTargets'
import { sanitizeProjectSource } from '@shared/projectSource'
import { sanitizeAgentAccounts } from './accounts/sanitize'
import { normalizeBaseUrl, sanitizeCostLimit, sanitizeEndpointMap } from './pipeline/stt/endpoint'
import { isLlmApiProvider, isOrganizeRunnerId, isSttRemoteProvider } from '@shared/aiProviders'
import { migrateOnboarding, sanitizeOnboarding } from '@shared/onboarding'
import { sanitizeDecisionPreferences } from '@shared/decision'
import { errorKind, reportHandled, timedSync } from '@shared/report'
import type { SettingsFileError, SettingsFileInfo } from '@shared/types'
import { SettingsFileStore, configDirOverride, legacyConfigDir, mergeSettings, migrateLegacyConfigDir, plaintextKeyPaths, relocateMisplacedDevConfig, resolveConfigDir, splitSettings } from './settingsFile'
import { sanitizeBrowserProfile } from '@shared/browserProfile'
import { sanitizeMobileRemotePrefs } from '@shared/mobileRemote'

/**
 * 設定の読み書き。
 * 利用者の設定は ~/.ferret/settings.json（どの OS でも同じ。FERRET_CONFIG_DIR で上書き）、
 * 再起動で戻す作業の状態（開いていたフォルダ・URL・タブ）は同じフォルダの state.json に分けて置く（settingsFile.ts）。
 * settings.json は利用者の Claude Code などが直接書き換える前提で、外部の変更はその場で取り込む（watchSettings）。
 * 以前の置き場所（userData/settings.json）は初回だけ読んで移し、ファイルは消さずに残す。
 * 依存を増やさないため electron-store は使わず、小さなJSONを自前で読み書きする。
 */

/**
 * E2E（ADE_E2E=1）ではAgentタブを自動で開かない。CLI の有無に左右されず、
 * 最初のタブがいつも素のシェルになるようにする（ターミナルのE2Eはプロンプトを待つ）
 */
// 通し確認（tools/qa/flow-check.mjs）は偽の claude / codex で起動時のタブを確かめるので ADE_E2E_STARTUP_AGENTS=1 で残す
const SKIP_STARTUP_AGENTS = process.env.ADE_E2E === '1' && process.env.ADE_E2E_STARTUP_AGENTS !== '1'

/**
 * E2E では初回起動のセットアップを出さない（全面を覆って既存の操作が通らなくなる）。
 * セットアップ自体を撮るときだけ ADE_E2E_ONBOARDING=1 で出す
 */
const SKIP_ONBOARDING = process.env.ADE_E2E === '1' && process.env.ADE_E2E_ONBOARDING !== '1'

const DEFAULTS: Settings = {
  folderPath: null,
  url: DEFAULT_URL,
  splitRatio: DEFAULT_SPLIT_RATIO,
  layout: DEFAULT_LAYOUT,
  theme: 'system',
  locale: 'system',
  viewport: 'desktop',
  projects: [],
  activeProjectId: null,
  agents: SKIP_STARTUP_AGENTS ? { ...DEFAULT_AGENT_PREFERENCES, startupAgents: [] } : DEFAULT_AGENT_PREFERENCES
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((p): Project[] => {
    if (!p || typeof p !== 'object') return []
    const r = p as Partial<Project>
    if (!str(r.id) || !str(r.folderPath) || seen.has(r.id)) return []
    seen.add(r.id)
    // 確認先は名前が自由で件数の上限なし。URL だけの頃の {id, label, url} もそのまま通る（src/shared/projectTargets.ts）
    const urls = sanitizeProjectTargets(r.urls)
    const kind = sanitizeProjectKind(r.kind)
    // どこから開いたか（今のものは local）。ssh は接続先を確かめ、github の URL は資格情報を落とす
    const origin = sanitizeProjectSource(r)
    const session = sanitizeProjectSession(r.session)
    // ☆ と時刻（並び順に使う）。読めない時刻は捨てる
    const stamp = (v: unknown) => (str(v) && Number.isFinite(Date.parse(v)) ? v : undefined)
    const addedAt = stamp(r.addedAt)
    const lastOpenedAt = stamp(r.lastOpenedAt)
    return [{ id: r.id, name: str(r.name) ? r.name : r.folderPath.split(/[\\/]/).pop() ?? r.folderPath, folderPath: r.folderPath, kind, ...origin, urls, ...(session ? { session } : {}),
      ...(r.starred === true ? { starred: true as const } : {}), ...(r.orchestrator === true ? { orchestrator: true as const } : {}), ...(r.editorWorkspace === true ? { editorWorkspace: true as const } : {}), ...(r.orchestraExcluded === true ? { orchestraExcluded: true as const } : {}), ...(str(r.orchestraId) && r.editorWorkspace !== true ? { orchestraId: r.orchestraId } : {}), ...(sanitizeBrowserProfile(r.browserProfile) ? { browserProfile: sanitizeBrowserProfile(r.browserProfile) } : {}), ...(Array.isArray(r.members) && r.members.some(str) ? { members: [...new Set(r.members.filter(str))] } : {}), ...(addedAt ? { addedAt } : {}), ...(lastOpenedAt ? { lastOpenedAt } : {}) }]
  })
}

function sanitizeAgents(raw: unknown): AgentPreferences {
  const agents = sanitizeAgentPreferences(raw)
  return SKIP_STARTUP_AGENTS ? { ...agents, startupAgents: [] } : agents
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

function clampRatio(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, n))
}

/** CLI の runner（codex / claude-code）に渡すモデル名。空は既定 */
function sanitizeCliModels(raw: unknown): NonNullable<Settings['organizer']>['cliModels'] {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: Partial<Record<'codex' | 'claude-code', string>> = {}
  for (const id of ['codex', 'claude-code'] as const) {
    const v = r[id]
    if (typeof v === 'string' && /^[\w.:/@\[\]-]{1,200}$/.test(v.trim())) out[id] = v.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/** フィードバックモードの右パネルの開閉と幅。既定（開いていて 0.78）なら書かない */
function sanitizeFeedbackTargets(raw: unknown): Settings['feedbackTargets'] {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: NonNullable<Settings['feedbackTargets']> = {}
  if (r.visible === false) out.visible = false
  if (typeof r.ratio === 'number' && Number.isFinite(r.ratio)) out.ratio = Math.min(0.95, Math.max(0.3, r.ratio))
  return Object.keys(out).length ? out : undefined
}

/** 読み込んだJSONを型どおりに直す。壊れた値は既定値へ戻す（単体テストから使うため export） */
export function sanitize(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const r = raw as Partial<Settings>
  return {
    ...(typeof r.whisperModel === 'string' ? { whisperModel: r.whisperModel } : {}),
    ...(r.capture ? { capture: {
      captureMic: r.capture.captureMic !== false, captureSystemAudio: r.capture.captureSystemAudio === true,
      transcription: isSttRemoteProvider(r.capture.transcription) ? r.capture.transcription : 'local' as const,
      // auto か whisper の対応言語のコード（src/shared/sttLanguages.ts）。知らない値は auto
      language: normalizeSttLanguage(r.capture.language),
      micDeviceId: typeof r.capture.micDeviceId === 'string' ? r.capture.micDeviceId : undefined,
      keepDays: Number.isFinite(r.capture.keepDays) ? Math.min(3650, Math.max(0, Math.round(r.capture.keepDays))) : 7,
      stayFeedbackOnStop: r.capture.stayFeedbackOnStop === true,
      // 何もない時間を削る（既定は削る）。書かれていなければ書き足さない
      ...(typeof r.capture.trimIdle === 'boolean' ? { trimIdle: r.capture.trimIdle } : {}),
      // 録画中の文字起こしの表示（既定は出す）。書かれていなければ書き足さない
      ...(typeof r.capture.showLiveTranscript === 'boolean' ? { showLiveTranscript: r.capture.showLiveTranscript } : {}),
      ...(Number.isFinite(r.capture.trimIdleSeconds) ? { trimIdleSeconds: Math.min(60, Math.max(1, Math.round(r.capture.trimIdleSeconds!))) } : {}),
      captureTarget: sanitizeCaptureTarget(r.capture.captureTarget),
      ...(isAnnotationColor(r.capture.annotationColor) ? { annotationColor: r.capture.annotationColor } : {}),
      // 文字起こしの接続先。キー本体は settings.json に入れない（pipeline/stt/keys.ts）
      ...(() => {
        // 以前の baseUrl / model（OpenAI 互換だけ）は sttEndpoints.compatible へ移す
        const raw = r.capture.sttEndpoints && typeof r.capture.sttEndpoints === 'object' ? { ...r.capture.sttEndpoints } : {}
        if (!raw.compatible && (typeof r.capture.baseUrl === 'string' || typeof r.capture.model === 'string')) {
          raw.compatible = { baseUrl: normalizeBaseUrl(r.capture.baseUrl) ?? undefined, model: r.capture.model }
        }
        const sttEndpoints = sanitizeEndpointMap(raw, isSttRemoteProvider)
        const costLimitUsd = sanitizeCostLimit(r.capture.costLimitUsd)
        return { ...(sttEndpoints ? { sttEndpoints } : {}), ...(costLimitUsd !== undefined ? { costLimitUsd } : {}) }
      })()
    } } : {}),
    folderPath: typeof r.folderPath === 'string' && r.folderPath.length > 0 ? r.folderPath : null,
    url: typeof r.url === 'string' && r.url.length > 0 ? r.url : DEFAULTS.url,
    splitRatio: clampRatio(r.splitRatio),
    layout: sanitizeLayout(r.layout, r.terminalDock),
    theme: normalizeThemePreference(r.theme),
    locale: normalizeLocalePreference(r.locale),
    viewport: r.viewport === 'mobile' ? 'mobile' : 'desktop',
    ...(() => {
      const projects = sanitizeProjects(r.projects)
      const activeProjectId = projects.some((p) => p.id === r.activeProjectId) ? r.activeProjectId! : null
      return { projects, activeProjectId }
    })(),
    agents: sanitizeAgents(r.agents),
    // 未設定は ON のまま書かない。明示の OFF だけを残す
    ...(r.crashReports === false ? { crashReports: false } : {}),
    ...(r.crashReportsNoticeShown === true ? { crashReportsNoticeShown: true } : {}),
    // GitHub のリポジトリの既定の置き場。決めていなければ書かない
    ...(() => {
      const github = sanitizeGithubPreferences(r.github)
      return github ? { github } : {}
    })(),
    // 内蔵ブラウザの拡張機能（展開済みのフォルダ）。空なら書かない
    ...(() => {
      const browserExtensions = sanitizeBrowserExtensions(r.browserExtensions)
      return browserExtensions ? { browserExtensions } : {}
    })(),
    // 自動更新のダウンロード。未設定は ON のまま書かない。明示の OFF だけを残す
    ...(r.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(() => {
      const onboarding = sanitizeOnboarding(r.onboarding)
      return onboarding ? { onboarding } : {}
    })(),
    ...(r.agentAccounts ? { agentAccounts: sanitizeAgentAccounts(r.agentAccounts) } : {}),
    // 上限での自動切り替え。未設定は既定（入）のまま書かない
    ...(r.limitFailover && typeof r.limitFailover === 'object' ? { limitFailover: sanitizeLimitFailover(r.limitFailover) } : {}),
    // 空・空白だけは「未設定」（既定文を使う）。長すぎる値は切り詰める
    ...(typeof r.agentPrompt === 'string' && r.agentPrompt.trim() ? { agentPrompt: r.agentPrompt.trim().slice(0, 2000) } : {}),
    ...(() => { const requests = sanitizeAgentRequestPrefs(r.agentRequests); return requests ? { agentRequests: requests } : {} })(),
    ...(() => { const orchestra = sanitizeOrchestraRules(r.orchestra); return orchestra ? { orchestra } : {} })(),
    // 判定モデルの接続先。未設定は書かない（既定は Ollama + clef-flash、無効）。キー本体は入れない
    ...(r.decision && typeof r.decision === 'object' ? { decision: sanitizeDecisionPreferences(r.decision) } : {}),
    // 「指摘を整理」の実行方法と API の接続先。キー本体は入れない（pipeline/stt/keys.ts）
    ...(r.organizer && typeof r.organizer === 'object' ? (() => {
      const endpoints = sanitizeEndpointMap(r.organizer.endpoints, isLlmApiProvider)
      const runner = isOrganizeRunnerId(r.organizer.runner) ? r.organizer.runner : undefined
      const cliModels = sanitizeCliModels(r.organizer.cliModels)
      return runner || endpoints || cliModels ? { organizer: { ...(runner ? { runner } : {}), ...(cliModels ? { cliModels } : {}), ...(endpoints ? { endpoints } : {}) } } : {}
    })() : {}),
    ...(() => {
      const starPrompt = sanitizeStarPrompt(r.starPrompt)
      return starPrompt ? { starPrompt } : {}
    })(),
    ...(() => {
      const feedbackTargets = sanitizeFeedbackTargets(r.feedbackTargets)
      return feedbackTargets ? { feedbackTargets } : {}
    })(),
    // スマホから操作。既定（閉じる・既定のポート）なら書かない。合言葉は settings.json に入れない（src/main/mobileRemote.ts）
    ...(() => {
      const mobileRemote = sanitizeMobileRemotePrefs(r.mobileRemote)
      return mobileRemote ? { mobileRemote } : {}
    })()
  }
}

/**
 * 設定フォルダ。E2E・--user-data-dir の起動は userData の下にして、本物の ~/.ferret に触れない。
 * dev 起動は ~/.ferret/dev（配布版の設定を開発中の変更で書き換えない）。
 * 最初に呼ばれたときに、改名前の ~/.movie-ade からの引っ越しを1度だけ行う（読む人より先に）。
 */
export function configDir(): string {
  const dir = resolveConfigDir({ env: process.env, isPackaged: packagedBuild(), isolatedUserData: isolatedUserData() })
  if (!configDirPrepared) {
    configDirPrepared = true
    migrateFromLegacyConfigDirOnce(dir)
  }
  return dir
}

let configDirPrepared = false

/** 改名前の ~/.movie-ade（dev は ~/.movie-ade/dev）を写す。上書きの指定・E2E のときはしない。旧フォルダは残す */
function migrateFromLegacyConfigDirOnce(dir: string): void {
  if (isolatedUserData() || configDirOverride(process.env)) return
  const legacy = legacyConfigDir({ isPackaged: packagedBuild() })
  if (!packagedBuild()) relocateDevConfigOnce(legacy)
  try {
    const moved = migrateLegacyConfigDir({ from: legacy, to: dir })
    if (moved) console.info(`[settings] 以前の設定（${legacy}）を ${moved} へ写しました（以前のフォルダは残しています）`)
  } catch (err) {
    reportHandled(errorKind(err), { area: 'settings', op: 'migrate legacy config dir' })
  }
}

/** 配布版か（src/main/runtime.ts） */
function packagedBuild(): boolean {
  return IS_PACKAGED
}

function isolatedUserData(): string | null {
  return process.env.ADE_E2E === '1' || app.commandLine?.hasSwitch?.('user-data-dir') ? app.getPath('userData') : null
}

/** bd1d49b の dev 起動が ~/.movie-ade 直下に書いた設定を、1度だけ dev/ へ移す（改名の引っ越しの前。上書きの指定・E2E のときはしない） */
function relocateDevConfigOnce(dir: string): void {
  if (packagedBuild() || isolatedUserData() || configDirOverride(process.env)) return
  try {
    const moved = relocateMisplacedDevConfig({ root: dirname(dir), devDir: dir })
    if (moved) console.info(`[settings] 開発版の設定を ${moved} へ移しました（写しを ${dirname(dir)}/backup-dev-relocate-* に残しています）`)
  } catch (err) {
    reportHandled(errorKind(err), { area: 'settings', op: 'relocate dev settings' })
  }
}

let store: SettingsFileStore | null = null
let externalListener: ((settings: Settings) => void) | null = null
let errorListener: ((error: SettingsFileError | null) => void) | null = null

/** 読み込んだ直後の後処理（旧設定の folderPath → プロジェクト、セットアップを出すか） */
function finishLoad(settings: Settings): Settings {
  return migrateOnboarding(migrateLegacySettings(settings), { skip: SKIP_ONBOARDING })
}

/** 取り込んだ settings.json に、今の作業の状態（開いているフォルダ・タブ）を重ねる */
function applyConfig(config: Record<string, unknown>): Settings {
  const { state } = splitSettings(currentSettings())
  cache = migrateOnboarding(sanitize(mergeSettings(config, state)), { skip: SKIP_ONBOARDING })
  return cache
}

function fileStore(): SettingsFileStore {
  if (!store) {
    const dir = configDir()
    store = new SettingsFileStore({
      dir,
      writtenBy: packagedBuild() ? 'packaged' : 'dev',
      legacyFile: join(app.getPath('userData'), 'settings.json'),
      sanitize,
      onExternalChange: (config) => externalListener?.(applyConfig(config)),
      // 利用者の書き間違いはクラッシュではないので Sentry へは送らない（画面に行つきで出す）
      onErrorChange: (error) => errorListener?.(error)
    })
  }
  return store
}

/** 起動経路で1度だけ読む。失敗（権限など）は既定値で続行する */
export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const result = fileStore().load()
    cache = finishLoad(result.settings)
    if (result.migrated) console.info(`[settings] 以前の設定を ${fileStore().settingsPath} へ移しました（以前のファイルは残しています）`)
  } catch (err) {
    // 中身にパスを含むので種類だけを送る
    reportHandled(errorKind(err), { area: 'settings', op: 'read settings' })
    cache = finishLoad({ ...DEFAULTS })
  }
  return cache
}

/**
 * settings.json の外部の変更（利用者のエディタ・Claude Code など）を取り込み始める。
 * onChange は取り込んだあとの設定、onError は壊れた（null は直った）ときに呼ぶ。
 */
export function watchSettings(onChange: (settings: Settings) => void, onError: (error: SettingsFileError | null) => void): void {
  externalListener = onChange
  errorListener = onError
  const s = fileStore()
  s.watch()
  // 読み込みから監視を始めるまでの間の変更（起動直後の Agent の書き込みなど）を取りこぼさない
  s.checkNow()
  if (!s.loaded) retryUnreadSettings(s)
}

/** 起動時に settings.json を読めなかったとき、読めるまで間を空けて読み直す（変更が無いと監視は気づかない。issue #5） */
export const UNREAD_SETTINGS_RETRY_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const

function retryUnreadSettings(s: SettingsFileStore, attempt = 0): void {
  if (s.loaded || attempt >= UNREAD_SETTINGS_RETRY_MS.length) return
  setTimeout(() => {
    s.checkNow()
    retryUnreadSettings(s, attempt + 1)
  }, UNREAD_SETTINGS_RETRY_MS[attempt]).unref?.()
}

/** 設定のページに出す settings.json の場所と状態 */
export function settingsFileInfo(): SettingsFileInfo {
  const s = fileStore()
  return { path: s.settingsPath, dir: s.dir, schemaPath: s.schemaPath, statePath: s.statePath, error: s.error,
    plaintextKeys: plaintextKeyPaths(splitSettings(currentSettings()).config) }
}

/** アプリ内のエディタで開く生の settings.json */
export function readSettingsText(): string {
  return fileStore().readText()
}

/** アプリ内のエディタからの保存。壊れていれば書かずにエラーを返す。保存できたら外部の変更と同じく取り込む */
export function writeSettingsText(text: string): SettingsFileError | null {
  const result = fileStore().writeText(text)
  if (!result.ok) return result.error
  externalListener?.(applyConfig(result.config))
  return null
}

export function currentSettings(): Settings {
  return cache ?? { ...DEFAULTS }
}

/** 書き込みは起動後の操作でしか起きないため、まとめて遅延保存する */
export function updateSettings(patch: Partial<Settings>): void {
  cache = sanitize({ ...currentSettings(), ...patch })
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persist()
  }, 300)
  writeTimer.unref?.()
}

export async function persist(): Promise<void> {
  try {
    // 一時ファイル＋rename で書く。settings.json が壊れている間は state.json だけ（利用者のファイルを上書きしない）
    timedSync('settings:save', () => fileStore().saveSync(currentSettings()))
  } catch (err) {
    console.warn('[settings] 保存に失敗しました', err)
    reportHandled(err, { area: 'settings', op: 'save settings' })
  }
}

/**
 * 終了時に未書き込みの変更を取りこぼさない。
 * `before-quit` は非同期の完了を待たないので、ここだけは同期で書く。
 */
export function flushSettingsSync(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    fileStore().saveSync(currentSettings())
  } catch (err) {
    console.warn('[settings] 保存に失敗しました', err)
    reportHandled(err, { area: 'settings', op: 'save settings on quit' })
  }
  store?.close()
}
