import { trimTrailingSlashes } from './remoteFiles'

/**
 * 外（Finder・デスクトップ・エクスプローラー）からウインドウへ落としたファイル・フォルダの扱い。
 * パスの受け取りは preload（webUtils.getPathForFile）→ main（drop:inspect。src/main/droppedPaths.ts）で確かめる。
 * ここはターミナルへ入れる文字列の組み立てなど、どちらからも使う純粋な関数だけを置く。
 */

/** main が確かめた、落とされたもの1つ */
export interface DroppedEntry {
  /** 絶対パス（OS の書き方のまま） */
  path: string
  kind: 'file' | 'dir'
  /** 開いているプロジェクトの中なら、その根からの相対パス（'/' 区切り）。外なら null */
  relPath: string | null
}

/** 一度に受け取る数の上限（それより多い分は捨てる） */
export const MAX_DROPPED_PATHS = 200

/** ターミナルの入力の読み方。Windows の既定のシェルは cmd.exe */
export type ShellQuoting = 'posix' | 'cmd' | 'powershell'

/**
 * どのシェルの書き方で入れるか。SSH のプロジェクトはリモートのシェル（posix）。
 * Windows で PowerShell を開いたタブ（タブ名に pwsh / powershell が入る）は PowerShell の書き方
 */
export function shellQuotingFor(platform: string, options: { remote?: boolean; title?: string } = {}): ShellQuoting {
  if (options.remote || platform !== 'win32') return 'posix'
  return /\b(pwsh|powershell)\b/i.test(options.title ?? '') ? 'powershell' : 'cmd'
}

/** 引用しなくてよい文字（英数字・日本語などの文字・よく使う記号） */
const POSIX_SAFE = /^[\p{L}\p{N}_\-./:@%+=,]+$/u
const WINDOWS_SAFE = /^[\p{L}\p{N}_\-.\\/:]+$/u

/**
 * 1つのパスを、そのシェルで1語として読まれる形にする。
 * - posix（zsh / bash）: '…' で囲み、中の ' は '\'' にする。~ や $ も展開されない
 * - cmd: "…" で囲む（Windows のファイル名に " は使えない）
 * - PowerShell: '…' で囲み、中の ' は '' にする（"…" だと $ や ` が展開される）
 */
export function quoteShellPath(path: string, quoting: ShellQuoting): string {
  if (quoting === 'posix') {
    if (POSIX_SAFE.test(path)) return path
    return `'${path.replace(/'/g, `'\\''`)}'`
  }
  if (WINDOWS_SAFE.test(path)) return path
  if (quoting === 'cmd') return `"${path.replace(/"/g, '')}"`
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * ターミナルの入力に入れる文字列。空白区切りで、最後に空白を1つ付ける（iTerm・VS Code と同じ）。
 * 改行などの制御文字を含むパスは入れない（貼った時点で実行されないように）
 */
export function shellPathsText(paths: readonly string[], quoting: ShellQuoting): string {
  const usable = paths.filter((p) => p.length > 0 && !/[\u0000-\u001f\u007f]/.test(p))
  if (usable.length === 0) return ''
  return `${usable.map((p) => quoteShellPath(p, quoting)).join(' ')} `
}

/**
 * ファイルツリーから落とした相対パス（'/' 区切り）を、ターミナルに入れるパスにする。
 * ターミナルの今の作業フォルダがプロジェクトの根なら相対パス、別の場所（cd した・分からない）なら絶対パス。
 * Windows は区切りを \ にする。プロジェクトの根そのもの（''）は相対なら '.'
 */
export function treePathsForTerminal(relPaths: readonly string[], options: { root: string; cwd: string | null; platform: string }): string[] {
  const win = options.platform === 'win32'
  const sep = win ? '\\' : '/'
  const trim = (p: string) => p.replace(/[\\/]+$/, '') || p
  const key = (p: string) => {
    const t = trim(p)
    return win || options.platform === 'darwin' ? t.toLowerCase() : t
  }
  const atRoot = options.cwd !== null && key(options.cwd) === key(options.root)
  const root = trim(options.root)
  return relPaths.map((rel) => {
    const native = rel.split('/').filter(Boolean).join(sep)
    if (atRoot) return native || '.'
    return native ? `${root}${sep}${native}` : root
  })
}

/**
 * SSH のプロジェクトで、ファイルツリーから落とした相対パスをターミナルに入れる文字にする。
 * リモートのシェルの作業フォルダは分からないので、いつも登録したリモートのフォルダからのパスにする（区切りは /。手元のレビューの置き場のパスではない）。
 * フォルダが ~ で始まるときは ~/ を引用の外に出す（引用すると ~ が展開されない）。制御文字を含むパスは入れない
 */
export function remoteTreePathsText(relPaths: readonly string[], remoteRoot: string): string {
  const root = trimTrailingSlashes(remoteRoot) || '/'
  const words = relPaths.filter((rel) => !/[\u0000-\u001f\u007f]/.test(rel)).map((rel) => {
    const path = rel ? (root === '/' ? `/${rel}` : `${root}/${rel}`) : root
    if (path === '~') return '~'
    if (path.startsWith('~/')) return `~/${quoteShellPath(path.slice(2), 'posix')}`
    return quoteShellPath(path, 'posix')
  })
  return words.length > 0 ? `${words.join(' ')} ` : ''
}
