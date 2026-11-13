/**
 * ファイルエディタ（エクスプローラ・クイックオープン・Monaco）が main と renderer で共有する型と規則。
 *
 * パスは常に「プロジェクトフォルダからの相対パス（`/` 区切り）」でやり取りする。
 * renderer から絶対パスを送らせないことで、プロジェクトの外を読ませる経路を減らす
 * （最終的な検査は main の src/main/files.ts が行う）。
 */

import type { TranslationKey } from './i18n'

/** ディレクトリの1項目 */
export interface FsEntry {
  name: string
  /** プロジェクトからの相対パス（`/` 区切り） */
  path: string
  kind: 'file' | 'directory'
  /** 既定で畳んでおく重いディレクトリ（.git・node_modules など）。開けば中身は読める */
  collapsed?: boolean
}

/** fs:read の結果。開けないファイルは理由を返す（例外にしない） */
export type FsReadResult =
  | { kind: 'text'; path: string; content: string; mtimeMs: number }
  | { kind: 'binary'; path: string; reason: string }
  | { kind: 'tooLarge'; path: string; size: number; reason: string }

export interface FsWriteResult {
  mtimeMs: number
}

/** fs:files（クイックオープン用のファイル一覧） */
export interface FsFileList {
  files: string[]
  /** 上限で打ち切った */
  truncated: boolean
}

/** 検索はファイル名だけ（内容検索は持たない。動画フィードバックに絞るため） */
export type FsSearchMode = 'names'

export interface FsSearchResult {
  mode: FsSearchMode
  /** 一致したファイル（相対パス。良い順） */
  files: string[]
  truncated: boolean
}

/** 外部の変更（Agent の書き換えなど）。まとめて通知する */
export interface FsChangedEvent {
  /** 変わったパス（相対）。ディレクトリの増減も含む */
  paths: string[]
  /** 通知が多すぎて paths に入れきれなかった（どのファイルが変わったか分からない。開いているものは全部確かめ直す） */
  overflow?: boolean
}

// Orca由来: src/main/ipc/filesystem/filesystem-file-content-inspection.ts（MIT）
// 先頭 8KB に NUL があればバイナリとみなす（git と同じ判定）
const BINARY_PROBE_BYTES = 8192

/**
 * 開ける大きさの上限。Monaco は数MBを超えると重くなるため、Orca（50MB）より小さく絞る。
 * 録画の素材などを誤って開いて固まるのを防ぐ。
 */
export const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024

/** クイックオープンの一覧の上限（巨大なリポジトリで IPC が詰まらないように） */
export const MAX_LISTED_FILES = 20_000

// Orca由来: src/shared/binary-buffer.ts（MIT）
export function isBinaryBuffer(buffer: Uint8Array): boolean {
  const len = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * 拡張子だけでバイナリと分かるもの。中身を読まずに断れる（録画の mp4 など大きいものが多い）。
 * Orca由来: src/shared/binary-file-extensions.ts（MIT）から抜粋
 */
const BINARY_EXTENSIONS = new Set([
  '.7z', '.bz2', '.gz', '.jar', '.rar', '.tar', '.tgz', '.xz', '.zip', '.zst',
  '.aac', '.avi', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.wav', '.webm', '.pcm',
  '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.xls', '.xlsx',
  '.eot', '.otf', '.ttc', '.ttf', '.woff', '.woff2',
  '.a', '.bin', '.class', '.dll', '.dylib', '.exe', '.lockb', '.node', '.o', '.pyc', '.so', '.wasm',
  '.sqlite', '.db',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tiff', '.heic', '.psd'
])

export function hasBinaryExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

// ─── 一覧から外す／畳むディレクトリ ─────────────────────────────

/**
 * 道具が作るキャッシュや状態。人が手で編集しないもの。
 * Orca由来: src/shared/quick-open-filter.ts の HIDDEN_DIR_BLOCKLIST（MIT）
 * .vscode・.idea は人が設定を編集することがあるので、ここでは外さない。
 */
const HEAVY_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.turbo',
  // このアプリが録画を置く場所（.ade-movie は改名前）。巨大な動画と音声が入る
  '.ferret',
  '.ade-movie'
])

/** エクスプローラで既定では畳む（中身を先読みしない）ディレクトリ */
export function isCollapsedByDefault(name: string): boolean {
  return HEAVY_DIRS.has(name)
}

/**
 * クイックオープン・検索・変更通知の対象にしてよいか（`/` 区切りの相対パス）。
 * Orca由来: src/shared/quick-open-filter.ts の shouldIncludeQuickOpenPath（MIT）
 */
export function shouldIncludePath(path: string): boolean {
  let start = 0
  const len = path.length
  while (start < len) {
    let end = path.indexOf('/', start)
    if (end === -1) end = len
    if (HEAVY_DIRS.has(path.substring(start, end))) return false
    start = end + 1
  }
  return true
}

// ─── ファイルツリーからの作成・名前の変更・削除 ─────────────────────

/** Windows で使えない名前（拡張子が付いていても使えない）。どの OS でも断り、リポジトリを Windows で開けなくしない */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
/** Windows で使えない文字と、パスの区切り。制御文字は別に見る */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*]/
/** 1つの名前の長さの上限（多くのファイルシステムで 255 バイト） */
const MAX_ENTRY_NAME_BYTES = 255

/** 作成・名前の変更で使う名前の誤り。null なら使える */
type EntryNameProblem = 'empty' | 'dots' | 'chars' | 'control' | 'reserved' | 'trailing' | 'tooLong' | 'git'

/**
 * ファイル・フォルダの名前（1階層分）を確かめる。renderer は入力中の案内に、main は最終的な検査に使う。
 * 区切り（/ \）を含む名前・`.` `..`・制御文字・Windows の予約名と使えない文字・末尾の空白やドット・.git は断る。
 */
export function entryNameProblem(name: string): EntryNameProblem | null {
  if (typeof name !== 'string' || name.trim() === '') return 'empty'
  if (name === '.' || name === '..') return 'dots'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control'
  if (FORBIDDEN_NAME_CHARS.test(name)) return 'chars'
  if (/[ .]$/.test(name)) return 'trailing'
  if (WINDOWS_RESERVED_NAME.test(name)) return 'reserved'
  if (name.toLowerCase() === '.git') return 'git'
  if (new TextEncoder().encode(name).length > MAX_ENTRY_NAME_BYTES) return 'tooLong'
  return null
}

/** 名前の誤りを画面に出す文言のキー */
export const ENTRY_NAME_PROBLEM_KEYS: Record<EntryNameProblem, TranslationKey> = {
  empty: 'files.errors.name.empty',
  dots: 'files.errors.name.dots',
  chars: 'files.errors.name.chars',
  control: 'files.errors.name.control',
  reserved: 'files.errors.name.reserved',
  trailing: 'files.errors.name.trailing',
  tooLong: 'files.errors.name.tooLong',
  git: 'files.errors.gitDir'
}

/** `/` 区切りの相対パスが .git の中（.git そのものを含む）か。大文字小文字は区別しない（macOS・Windows） */
export function isInsideGitDir(path: string): boolean {
  return path.split('/').some((part) => part.toLowerCase() === '.git')
}

/** path が base そのものか、その下か（`/` 区切りの相対パス） */
export function isSameOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`)
}

/** 名前を変えたとき、base の下にあった path の新しいパス。下でなければ null */
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null
}

/** fs:create の結果。path は作ったもの、top は今回新しくできたいちばん上（「a/b/c.ts」で a が無かったなら a。元に戻すときに消す） */
export interface FsCreated {
  path: string
  top: string
}

/** 移動・コピー・取り込みの1件。from は元（取り込みでは元の名前）、to は新しい相対パス。from と to が同じなら何もしていない */
export interface FsTransfer {
  from: string
  to: string
}

/** 1回でコピー・取り込みできる数（ファイルとフォルダの合計）と大きさの上限。大きなフォルダを誤って落として固まらないように */
export const MAX_COPY_ENTRIES = 10_000
export const MAX_COPY_BYTES = 1024 * 1024 * 1024

/**
 * 新しいファイルの名前に「a/b/c.ts」のように `/` を含めたときの、1階層ずつの名前。
 * 空の階層（`a//b`・先頭や末尾の `/`）と `\` は区切りとして認めない（entryNameProblem が断る）
 */
export function nestedNameParts(name: string): string[] {
  return typeof name === 'string' ? name.split('/') : [name]
}

/** 入れ子の名前の誤り。どこか1階層でも使えなければ、その誤り */
export function nestedNameProblem(name: string): EntryNameProblem | null {
  for (const part of nestedNameParts(name)) {
    const problem = entryNameProblem(part)
    if (problem) return problem
  }
  return null
}

/**
 * コピーで重ならない名前（Finder・VS Code と同じ形）。n は 1 から: 「a.ts」→「a copy.ts」→「a copy 2.ts」。
 * 拡張子は最後のドットから（先頭のドットだけの「.env」は拡張子とみなさない）。フォルダは拡張子を分けない
 */
export function copyName(name: string, n: number, kind: FsEntry['kind']): string {
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`
}

/** taken（同じフォルダにある名前）と重ならない名前。重ならなければそのまま。大文字小文字は区別しない（macOS・Windows） */
export function uniqueName(name: string, kind: FsEntry['kind'], taken: Iterable<string>): string {
  const lower = new Set([...taken].map((x) => x.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  for (let n = 1; ; n++) {
    const candidate = copyName(name, n, kind)
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}
