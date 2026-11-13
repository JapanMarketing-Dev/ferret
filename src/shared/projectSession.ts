import { stripPreviewGrant } from './preview'
import { MAX_BROWSER_TABS } from './browserTabs'
import { DEFAULT_URL, type Project, type ProjectSession } from './types'

/**
 * プロジェクトごとの作業の状態（内蔵ブラウザの URL・中央のタブ・開いていたファイル・表示中のレビュー）。
 * プロジェクトを切り替えたら前の状態を覚え、戻ってきたら元に戻す。設定に保存するので再起動しても戻る。
 * 保存するのはパスと URL まで（内蔵ブラウザはタブ全部の URL と前に出ていたタブ）。ファイルの中身は持たない。
 * 戻る・進むの履歴は設定に書かず、アプリを開いている間だけ main がプロジェクトごとに持つ（restorableHistory）。
 *
 * main（URL の記録と切り替え時の遷移）と renderer（タブとファイル）の両方から使う純粋な関数だけを置く。
 */

/** 開いていたファイルとして覚える上限（設定ファイルを肥大させない） */
export const MAX_SESSION_FILES = 50

const isText = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** 相対パスとして安全なものだけ（絶対パス・親へ出るパスは捨てる） */
function isRelativePath(path: string): boolean {
  return !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !path.split(/[\\/]/).includes('..')
}

/** 設定ファイルから読んだ値を型どおりに直す。中身が何も無ければ undefined */
export function sanitizeProjectSession(raw: unknown): ProjectSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<ProjectSession>
  const session: ProjectSession = {}
  // プレビューの外部の画像の許可は保存も復元もしない（security-4 [6]）
  if (isText(r.url) && r.url !== DEFAULT_URL) session.url = stripPreviewGrant(r.url)
  if (isText(r.centerTab)) session.centerTab = r.centerTab
  if (Array.isArray(r.openFiles)) {
    const files = [...new Set(r.openFiles.filter((p): p is string => isText(p) && isRelativePath(p)))].slice(0, MAX_SESSION_FILES)
    if (files.length) session.openFiles = files
  }
  if (isText(r.reviewId, 200)) session.reviewId = r.reviewId
  if (Array.isArray(r.tabs)) {
    const tabs = r.tabs.filter((u): u is string => isText(u) && u !== DEFAULT_URL).map(stripPreviewGrant).slice(0, MAX_BROWSER_TABS)
    if (tabs.length) {
      session.tabs = tabs
      if (typeof r.activeTab === 'number' && Number.isInteger(r.activeTab) && r.activeTab > 0 && r.activeTab < tabs.length) session.activeTab = r.activeTab
    }
  }
  return Object.keys(session).length ? session : undefined
}

/** id のプロジェクトの状態に patch を重ねる（undefined の項目は消す）。一覧の他は変えない */
export function withProjectSession(projects: Project[], id: string, patch: Partial<ProjectSession>): Project[] {
  return projects.map((project) => {
    if (project.id !== id) return project
    const merged = { ...project.session, ...patch }
    for (const key of Object.keys(merged) as Array<keyof ProjectSession>) if (merged[key] === undefined || merged[key] === null) delete merged[key]
    const session = sanitizeProjectSession(merged)
    const { session: _old, ...rest } = project
    return session ? { ...rest, session } : rest
  })
}

/**
 * プロジェクトを開いたときに内蔵ブラウザで開く URL。
 * 前に開いていた URL → 登録 URL の先頭 → 空の画面 の順。
 */
export function sessionUrl(project: Pick<Project, 'urls' | 'session'>): string {
  return project.session?.url ?? project.urls.find((u) => u.url)?.url ?? DEFAULT_URL
}

/**
 * プロジェクトを開いたときに内蔵ブラウザで開くタブ（URL の並びと前に出すタブの番号）。
 * 前に開いていたタブ → 前に開いていた URL・登録 URL の先頭（sessionUrl）の1枚 の順。別のプロジェクトのタブは持ち込まない
 */
export function sessionTabs(project: Pick<Project, 'urls' | 'session'>): { urls: string[]; active: number } {
  const tabs = project.session?.tabs
  if (tabs?.length) return { urls: [...tabs], active: Math.min(project.session?.activeTab ?? 0, tabs.length - 1) }
  return { urls: [sessionUrl(project)], active: 0 }
}

/**
 * 起動時に内蔵ブラウザで開くタブ。開くプロジェクトがあれば、そのプロジェクトのタブ（sessionTabs）だけを使い、
 * 覚えたものが無ければ空の画面にする。全体の「最後の URL」（globalUrl）は別のプロジェクトで見ていたページのことがあるので、
 * プロジェクトが無いときにだけ使う（持ち込むと、そのページがこのプロジェクトの URL として覚えられてしまう）
 */
export function startupBrowserTabs(project: Pick<Project, 'urls' | 'session'> | null, globalUrl: string | undefined | null): { urls: string[]; active: number } {
  if (project) return sessionTabs(project)
  return { urls: [globalUrl || DEFAULT_URL], active: 0 }
}

/**
 * 内蔵ブラウザのタブの一覧から、設定に覚えるタブ（URL の並びと前のタブの番号）。
 * 空のタブ・読み込み途中で URL がまだ無いタブは数えない。覚えるものが無ければ null（前の値を消さない）
 */
export function recordableTabs(tabs: ReadonlyArray<{ id: string; url: string }>, activeId: string | undefined): { tabs: string[]; activeTab?: number } | null {
  const kept = tabs.filter((tab) => isRecordableUrl(tab.url)).slice(0, MAX_BROWSER_TABS)
  if (kept.length === 0) return null
  const at = kept.findIndex((tab) => tab.id === activeId)
  return { tabs: kept.map((tab) => stripPreviewGrant(tab.url)), ...(at > 0 ? { activeTab: at } : {}) }
}

/** 戻る・進むの履歴として1つのタブに持ち越す件数の上限 */
export const MAX_HISTORY_ENTRIES = 50

/**
 * タブの戻る・進むの履歴を、別のプロジェクトから戻ってきたときに開き直す形に絞る。
 * 開いてよい URL（allowed）の項目だけを残し、前に出ていた項目の前後から上限まで。残らなければ null（URL だけで開く）
 */
export function restorableHistory<T extends { url: string }>(entries: readonly T[], index: number, allowed: (url: string) => boolean): { entries: T[]; index: number } | null {
  const current = entries[index]
  const kept: T[] = []
  let at = -1
  for (const entry of entries) {
    if (!allowed(entry.url)) continue
    if (entry === current) at = kept.length
    kept.push(entry)
  }
  if (kept.length === 0) return null
  if (at < 0) at = kept.length - 1
  const from = Math.max(0, Math.min(at - Math.floor(MAX_HISTORY_ENTRIES / 2), kept.length - MAX_HISTORY_ENTRIES))
  const sliced = kept.slice(from, from + MAX_HISTORY_ENTRIES)
  return { entries: sliced, index: at - from }
}

/** URL の記録に使ってよいか（空の画面や読み込み途中は覚えない） */
export function isRecordableUrl(url: string | undefined | null): url is string {
  return !!url && url !== DEFAULT_URL
}

/*
 * 中央のタブの選択。ファイルのタブは `file:<プロジェクトの根>/<相対パス>` なので、
 * 根を外した `file:<相対パス>` で覚え、戻すときに今の根を付け直す（フォルダを動かしても戻せる）。
 */
const FILE_PREFIX = 'file:'
/** ファイル以外の中央のタブ（src/renderer/components/CenterTabs.tsx の CenterTab。settings は覚えない） */
const KNOWN_TABS = ['dashboard', 'browser', 'findings', 'visual-review', 'value-usecases'] as const

export function encodeCenterTab(tab: string, root: string | null): string | undefined {
  if (!tab.startsWith(FILE_PREFIX)) return tab
  if (!root) return undefined
  const base = `${FILE_PREFIX}${root.replace(/[\\/]+$/, '')}/`
  return tab.startsWith(base) ? `${FILE_PREFIX}${tab.slice(base.length)}` : undefined
}

export function decodeCenterTab(saved: string | undefined, root: string | null): string | undefined {
  if (!saved) return undefined
  // ファイル以外は今あるタブだけ（前の版で覚えた business などの消えたタブは戻さない）
  if (!saved.startsWith(FILE_PREFIX)) return (KNOWN_TABS as readonly string[]).includes(saved) ? saved : undefined
  const rel = saved.slice(FILE_PREFIX.length)
  if (!root || !rel || !isRelativePath(rel)) return undefined
  return `${FILE_PREFIX}${root.replace(/[\\/]+$/, '')}/${rel}`
}

/** http(s) の URL の origin（それ以外・読めないものは null） */
function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * 0.7.13 までの起動時の不具合で、別のプロジェクトのページがプロジェクトの記憶（session の url・tabs）に入り込んでいた
 * （起動時に、記憶の無いプロジェクトへ全体の最後の URL を開いていた。official_website の localhost:4321 が ferret などに入った）。
 * そのため切り替えても前のプロジェクトのページが開いて見えた。1度だけ、ほかのプロジェクトが登録している URL の origin のページを、
 * その origin を登録していないプロジェクトの記憶から外す。
 * 毎回はしない（同じポートを複数のプロジェクトで使うことがあり、自分で開いたページまで消してしまうため）
 */
export function cleanLeakedSessions(
  projects: ReadonlyArray<{ id: string; urls?: ReadonlyArray<{ url: string }> }>,
  sessions: Record<string, ProjectSession>
): Record<string, ProjectSession> {
  const registered = new Map<string, Set<string>>()
  for (const project of projects) {
    const origins = new Set<string>()
    for (const { url } of project.urls ?? []) {
      const origin = typeof url === 'string' ? httpOrigin(url) : null
      if (origin) origins.add(origin)
    }
    registered.set(project.id, origins)
  }
  const next: Record<string, ProjectSession> = {}
  for (const [id, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue
    const own = registered.get(id) ?? new Set<string>()
    const leaked = (url: string): boolean => {
      const origin = httpOrigin(url)
      if (!origin || own.has(origin)) return false
      for (const [other, origins] of registered) if (other !== id && origins.has(origin)) return true
      return false
    }
    const cleaned: ProjectSession = { ...session }
    if (Array.isArray(session.tabs)) {
      const activeUrl = session.tabs[session.activeTab ?? 0]
      const tabs = session.tabs.filter((url) => !leaked(url))
      delete cleaned.tabs
      delete cleaned.activeTab
      if (tabs.length) {
        cleaned.tabs = tabs
        const at = activeUrl === undefined ? -1 : tabs.indexOf(activeUrl)
        if (at > 0) cleaned.activeTab = at
      }
    }
    if (typeof session.url === 'string' && leaked(session.url)) {
      delete cleaned.url
      const fallback = cleaned.tabs?.[cleaned.activeTab ?? 0]
      if (fallback) cleaned.url = fallback
    }
    if (Object.keys(cleaned).length) next[id] = cleaned
  }
  return next
}
