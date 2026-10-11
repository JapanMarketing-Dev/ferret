import type { CaptureSourceInfo, DesktopAppInfo } from './types'
import { matchWatchedWindow } from './captureTracks'
import { matchWindowSource } from './projectTargets'

/**
 * まだ画面に出ていない（起動していない・ウインドウが無い）デスクトップアプリを、録画の対象の選択画面で名前から選ぶための純粋な処理。
 * main（recording/apps.ts）が OS の決まった場所を読み、ここで名前を付けて並べる。Electron・fs に依存させない（単体テストで確かめる）。
 *
 *   macOS   … /Applications・/System/Applications・~/Applications（とその1段下のフォルダ）の .app
 *   Windows … スタートメニュー（全員分と自分の分）のショートカット（.lnk）
 *   Linux   … XDG の applications フォルダの .desktop（NoDisplay・Hidden・アプリ以外は出さない）
 */

/** 一覧に出す数の上限（読みすぎない） */
export const MAX_DESKTOP_APPS = 2000

/** 区切り（/ と \）のどちらでも最後の名前を取る */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** パスからアプリの名前（Foo.app → Foo、Foo.lnk → Foo、foo.desktop → foo） */
export function appNameFromPath(path: string): string {
  return baseName(path).replace(/\.(app|lnk|desktop)$/i, '').trim()
}

/** スタートメニューのうち、アプリではないショートカット（アンインストール・説明書・Web へのリンクなど） */
const START_MENU_NOISE = /(uninstall|アンインストール|readme|release notes|help|manual|documentation|website|license|ヘルプ|説明書|ライセンス)/i

export function isStartMenuNoise(name: string): boolean {
  return START_MENU_NOISE.test(name)
}

/**
 * .desktop ファイル（[Desktop Entry]）を読む。アプリとして出さないものは null。
 * 名前は Name[ja_JP] → Name[ja] → Name の順（locale は 'ja-JP' のような形でもよい）
 */
export function parseDesktopEntry(text: string, locale = ''): { name: string } | null {
  let inEntry = false
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!values.has(key)) values.set(key, line.slice(eq + 1).trim())
  }
  if ((values.get('Type') ?? 'Application') !== 'Application') return null
  if (/^true$/i.test(values.get('NoDisplay') ?? '') || /^true$/i.test(values.get('Hidden') ?? '')) return null
  // 端末の中で動くもの（Terminal=true）はウインドウを持たない
  if (/^true$/i.test(values.get('Terminal') ?? '')) return null
  const [lang, region] = locale.replace('-', '_').split('_')
  const keys = [lang && region ? `Name[${lang}_${region.toUpperCase()}]` : '', lang ? `Name[${lang}]` : '', 'Name'].filter(Boolean)
  for (const key of keys) {
    const name = values.get(key)?.trim()
    if (name) return { name: name.slice(0, 200) }
  }
  return null
}

/** 同じ名前のアプリは1つにする（最初に見つけたもの。呼ぶ側が優先する場所から先に渡す）。名前の順に並べる */
export function dedupeApps(apps: readonly DesktopAppInfo[]): DesktopAppInfo[] {
  const seen = new Set<string>()
  const out: DesktopAppInfo[] = []
  for (const app of apps) {
    const key = app.name.normalize('NFKC').toLowerCase()
    if (!app.name || seen.has(key)) continue
    seen.add(key)
    out.push(app)
  }
  const order = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  return out.sort((a, b) => order.compare(a.name, b.name)).slice(0, MAX_DESKTOP_APPS)
}

/** 検索欄の文字で絞る。空白で区切った語がすべて名前かパスに含まれるもの。名前の前方一致を先に出す */
export function filterApps(apps: readonly DesktopAppInfo[], query: string): DesktopAppInfo[] {
  const words = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...apps]
  const hits = apps.filter((app) => {
    const hay = `${app.name}\n${app.path}`.normalize('NFKC').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  const first = words[0]!
  const starts = (app: DesktopAppInfo) => (app.name.normalize('NFKC').toLowerCase().startsWith(first) ? 0 : 1)
  return hits.map((app, i) => ({ app, i })).sort((a, b) => starts(a.app) - starts(b.app) || a.i - b.i).map((x) => x.app)
}

/** macOS でアプリを起動・前面へ出す引数（/usr/bin/open に渡す。シェルを通さないので、パスはそのまま1つの引数） */
export function macOpenArgs(appPath: string): string[] {
  return ['-a', appPath]
}

/** Info.plist のバンドル ID を読む引数（/usr/bin/plutil。読むだけ） */
export function plutilBundleIdArgs(infoPlist: string): string[] {
  return ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist]
}

/** plutil の出力をバンドル ID として受け取る（形が違えば捨てる） */
export function parseBundleId(text: string): string | undefined {
  const value = text.trim()
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(value) && value.includes('.') ? value : undefined
}

/**
 * 起動したアプリのウインドウを、録画の候補から探す。
 * バンドル ID が分かれば（macOS）それで、無ければアプリ名・ウインドウの題名で探す（matchWindowSource と同じ決め方）。
 * excludeIds（起動する前からあったウインドウ）は、ほかに無いときだけ選ぶ（新しく開いたウインドウを先にする）
 */
export function matchLaunchedWindow(sources: readonly CaptureSourceInfo[], app: { name: string; bundleId?: string }, excludeIds: ReadonlySet<string> = new Set()): CaptureSourceInfo | null {
  const pick = (list: readonly CaptureSourceInfo[]): CaptureSourceInfo | null => {
    if (app.bundleId) {
      const byBundle = matchWatchedWindow(list, app.bundleId)
      if (byBundle) return byBundle
      // バンドル ID の分かるウインドウがあるのに当たらなければ、名前では探さない（似た名前の別のアプリを取り違えない）
      if (list.some((s) => s.bundleId)) return null
    }
    return matchWindowSource(list, app.name)
  }
  const windows = sources.filter((s) => s.kind === 'window')
  return pick(windows.filter((s) => !excludeIds.has(s.id))) ?? pick(windows)
}
