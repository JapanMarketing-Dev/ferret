import { LinuxTreeWatcher } from './linuxTreeWatch'
import { resolveTrustedExecutable } from './agentExecutable'
import { spawn } from 'node:child_process'
import { FileTooLargeError, NotRegularFileError, readFileBounded } from './boundedFile'
import { assertHandleInside, assertStillInside, createContained, openContained } from './containedFile'
import { constants as fsConstants, existsSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { readDirEntries } from './dirEntries'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_LISTED_FILES,
  MAX_TEXT_FILE_SIZE,
  hasBinaryExtension,
  isBinaryBuffer,
  isCollapsedByDefault,
  isSameOrUnder,
  shouldIncludePath,
  type FsChangedEvent,
  type FsEntry,
  type FsFileList,
  type FsReadResult,
  type FsSearchMode,
  type FsSearchResult,
  type FsWriteResult
} from '@shared/files'
import { prepareQuickOpenFiles, rankPreparedQuickOpenFiles, type PreparedQuickOpenFiles } from '@shared/quickOpen'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { SLOW_OP_MS, noteSlowOp, reportHandled } from '@shared/report'
import { progressChangedIds } from '@shared/findingProgress'
import { isVisualReviewPath } from '@shared/visualReview'

/**
 * ファイルエディタの読み書き（fs:list / fs:read / fs:write / fs:files / fs:search / fs:changed）。
 *
 * renderer から来るのはプロジェクトからの相対パスだけ。ここで必ず
 *   1. 文字の上で（`..` を解決して）プロジェクトの中か
 *   2. シンボリックリンクを辿った実体もプロジェクトの中か
 * を確かめてから触る。どちらかで外に出るなら断る。
 */

/** 外に出るパスを断るときの文言（画面にそのまま出る） */
/** 画面の言語で返す（呼んだ時点の言語） */
function outsideMessage(): string {
  return t('files.errors.outside')
}

/**
 * 1つのフォルダで一覧に出す項目の上限（security-4 [9]）。プロジェクトを開くと根の一覧は自動で読むので、
 * 項目が極端に多いフォルダでも読む・並べる・送る量をここで止める（Quick Open の MAX_LISTED_FILES と同じ考え）
 */
export const MAX_DIRECTORY_ENTRIES = 5000

/** ファイル名の検索で返す上限 */
const MAX_NAME_MATCHES = 500

/**
 * target が root の中（root 自身を含む）なら root からの相対パス（`/` 区切り）を返す。外なら null。
 * 文字の上だけで判定する純粋関数。
 */
export function relativeInside(root: string, target: string): string | null {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

/** renderer から来た相対パスの形を確かめる。絶対パス・NUL・ドライブ指定は断る */
function assertRelativeInput(relPath: unknown): asserts relPath is string {
  if (typeof relPath !== 'string' || relPath.includes('\0') || isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(outsideMessage())
  }
}

/**
 * 相対パスをプロジェクトの中の絶対パスへ直す。外に出るなら例外。
 * allowMissing のときは、まだ無いファイル（新規作成）でも、存在する一番近い親で実体を確かめる。
 */
export async function resolveInside(root: string, relPath: unknown, options: { allowMissing?: boolean } = {}): Promise<string> {
  assertRelativeInput(relPath)
  const absolute = resolve(root, relPath)
  if (relativeInside(root, absolute) === null) throw new Error(outsideMessage())

  const realRoot = await realpath(root)
  let probe = absolute
  for (;;) {
    try {
      const real = await realpath(probe)
      if (relativeInside(realRoot, real) === null) throw new Error(outsideMessage())
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      if (!options.allowMissing) throw err
      const parent = dirname(probe)
      if (parent === probe) throw new Error(outsideMessage())
      probe = parent
    }
  }
  return absolute
}

function toRel(root: string, absolute: string): string {
  return relativeInside(root, absolute) ?? ''
}

// ─── 一覧 ─────────────────────────────────────────────

/**
 * 一覧を読むフォルダを開く（security-7 [13]）。確かめたパスを開き直すと、そのあいだに途中のフォルダを差し替えて
 * 外のフォルダの名前を読ませられるので、読む前と読んだ後で実体（dev・ino）とプロジェクトの中であることを確かめる（finish）。
 * Linux は、開いたフォルダの fd（/proc/self/fd/N）から読むので、差し替えても開いたものだけを読む
 */
async function openListedDir(root: string, dir: string): Promise<{ path: string; finish: () => Promise<void> }> {
  const real = await assertStillInside(root, dir)
  const before = await stat(real)
  if (!before.isDirectory()) throw new UserFacingError(t('files.errors.notRegular'))
  const same = (s: { dev: number; ino: number }) => s.dev === before.dev && s.ino === before.ino
  let pinned: FileHandle | null = null
  if (process.platform === 'linux') {
    pinned = await open(real, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
    if (!same(await pinned.stat())) {
      await pinned.close()
      throw new UserFacingError(t('files.errors.outside'))
    }
  }
  return {
    path: pinned ? `/proc/self/fd/${pinned.fd}` : real,
    finish: async () => {
      try {
        // 読み終えた時点でも同じフォルダで、プロジェクトの中にある。違えば読んだ名前は使わない
        const now = await assertStillInside(root, dir)
        if (now !== real || !same(await stat(now))) throw new UserFacingError(t('files.errors.outside'))
      } finally {
        await pinned?.close()
      }
    }
  }
}

export async function listDirectory(root: string, relDir: string,
  /** 単体テスト用: 読む上限を小さくする（5000 個のファイルを作らずに上限の動きを確かめる） */
  limit = MAX_DIRECTORY_ENTRIES): Promise<FsEntry[]> {
  const dir = await resolveInside(root, relDir)
  const listed = await openListedDir(root, dir)
  // 上限まで読む（macOS・Linux は opendir で少しずつ。Windows は readdir。dirEntries.ts・FERRET-1Q）
  const entries: FsEntry[] = []
  try {
    const { entries: dirents } = await readDirEntries(listed.path, limit)
    for (const dirent of dirents) {
      const absolute = join(dir, dirent.name)
      let kind: FsEntry['kind'] | null = dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : null
      if (dirent.isSymbolicLink()) {
        // 外を指すリンクは一覧にも出さない（開けないものを見せない）
        try {
          await resolveInside(root, toRel(root, absolute))
          kind = (await stat(absolute)).isDirectory() ? 'directory' : 'file'
        } catch {
          // 外を指す・切れたリンク（想定内）
          kind = null
        }
      }
      if (!kind) continue
      entries.push({
        name: dirent.name,
        path: toRel(root, absolute),
        kind,
        ...(kind === 'directory' && isCollapsedByDefault(dirent.name) ? { collapsed: true } : {})
      })
    }
  } catch (err) {
    await listed.finish().catch(() => undefined)
    throw err
  }
  await listed.finish()
  // フォルダが先、名前は自然順（file2 < file10）
  return entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : NAME_ORDER.compare(a.name, b.name)))
}

/** 名前の自然順。比べるたびに localeCompare へ options を渡すと照合の表を毎回作るので、1つを使い回す */
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// ─── 読み書き ─────────────────────────────────────────────

export async function readTextFile(root: string, relPath: string): Promise<FsReadResult> {
  const file = await resolveInside(root, relPath)
  const path = toRel(root, file)
  const info = await stat(file)
  if (info.isDirectory()) throw new UserFacingError(t('files.errors.folder'))
  if (hasBinaryExtension(path)) return { kind: 'binary', path, reason: t('files.errors.binary') }
  if (info.size > MAX_TEXT_FILE_SIZE) {
    return {
      kind: 'tooLarge',
      path,
      size: info.size,
      reason: t('files.errors.tooLarge', { size: (info.size / 1024 / 1024).toFixed(1), limit: MAX_TEXT_FILE_SIZE / 1024 / 1024 })
    }
  }
  // 普通のファイルだけを、上限までしか読まない（パイプを開いて止まらない・読んでいる間に伸びても止まる。boundedFile.ts）
  let buffer: Buffer
  try {
    // 開いたものが確かめたプロジェクトの中の実体かを見る（security-4 [5]）
    buffer = await readFileBounded(file, MAX_TEXT_FILE_SIZE, { afterOpen: (handle) => assertHandleInside(handle, root, file) })
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      return { kind: 'tooLarge', path, size: err.sizeBytes ?? info.size, reason: t('files.errors.tooLarge', { size: ((err.sizeBytes ?? info.size) / 1024 / 1024).toFixed(1), limit: MAX_TEXT_FILE_SIZE / 1024 / 1024 }) }
    }
    // パイプ・ソケット・デバイスは開かない。理由はエディタのタブにそのまま出る
    if (err instanceof NotRegularFileError) throw new UserFacingError(t('files.errors.notRegular'))
    throw err
  }
  if (isBinaryBuffer(buffer)) return { kind: 'binary', path, reason: t('files.errors.binary') }
  return { kind: 'text', path, content: buffer.toString('utf8'), mtimeMs: info.mtimeMs }
}

export async function writeTextFile(root: string, relPath: string, content: string): Promise<FsWriteResult> {
  if (typeof content !== 'string') throw new UserFacingError(t('files.errors.badContent'))
  const file = await resolveInside(root, relPath, { allowMissing: true })
  // 既にあるパスが普通のファイルでなければ書かない（名前付きパイプへ書くと main が止まる）。新しいファイルは作る
  const existing = await stat(file).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return null; throw err })
  if (existing?.isDirectory()) throw new UserFacingError(t('files.errors.folder'))
  if (existing && !existing.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
  // 開いたものがプロジェクトの中の実体かを確かめてから書く（確かめたあとでリンクに差し替えられても外へ書かない。security-4 [5]）。
  // 上書きで中身を差し替える（rename で置き換えるとリンクや権限が変わり、監視も途切れる）
  const handle = await openForWrite(root, file)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    await handle.truncate(0)
    // 開いたばかりの fd の位置は 0。writeFile は全部を書き切るまで続ける
    await handle.writeFile(content, 'utf8')
    return { mtimeMs: (await handle.stat()).mtimeMs }
  } finally {
    await handle.close()
  }
}

/** 既にあれば確かめて開き、無ければ確かめた親の下に作る（作るあいだに作られたら、もう一度開く） */
async function openForWrite(root: string, file: string): Promise<FileHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openContained(root, file, 'write')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EISDIR') throw new UserFacingError(t('files.errors.folder'))
      if (code !== 'ENOENT' || attempt > 0) throw err
    }
    try {
      return await createContained(root, file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

// ─── rg ─────────────────────────────────────────────

/**
 * rg の場所。Finder から起動するとシェルの PATH を引き継がないので、よくある場所も見る。
 * Agent と同じ決まりで、絶対パスでプロジェクト（root）の外の、実行できるファイルだけを使う（security-7 [15]。
 * PATH の `.`・相対の項目・プロジェクトの中のフォルダ・プロジェクトの中を指すリンクからは選ばない）。
 * 見つからなければ null（Node で歩く遅い経路に切り替える）。プロジェクトごとに少しの間覚える
 */
const RG_CACHE_MS = 5 * 60_000
const rgPaths = new Map<string, { path: string | null; at: number }>()
export async function findRg(root: string): Promise<string | null> {
  const hit = rgPaths.get(root)
  if (hit && Date.now() - hit.at < RG_CACHE_MS) return hit.path
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  const resolved = await resolveTrustedExecutable('rg', { env: process.env, cwd: root, dirs: process.platform === 'win32' ? undefined : dirs })
  // Windows で .cmd / .bat は cmd.exe を通すことになるので使わない
  const path = resolved.ok && !/\.(cmd|bat)$/i.test(resolved.path) ? resolved.path : null
  rgPaths.set(root, { path, at: Date.now() })
  return path
}

/**
 * 一覧（クイックオープン・名前の検索）に出さないフォルダ（プロジェクトの根からの相対）。
 * Agent が作る worktree はリポジトリの丸ごとの写しなので、入れると同じ名前のファイルが worktree の数だけ並び、
 * 上限もそれで埋まって目当てのファイルが出なくなる（.gitignore に書いていないプロジェクトでも外す）。
 * 変更の監視（shouldIncludePath）からは外さない（worktree の中のファイルを開いて編集することはある）
 */
const LISTING_EXCLUDED_ROOT_DIRS = ['.claude/worktrees']

/** 一覧から外すか（`/` 区切りの相対パス） */
export function isExcludedFromListing(rel: string): boolean {
  return !shouldIncludePath(rel) || LISTING_EXCLUDED_ROOT_DIRS.some((dir) => isSameOrUnder(rel, dir))
}

/** 除外するディレクトリを rg のグロブにする */
const RG_EXCLUDES = [
  ...['.git', 'node_modules', '.ferret', '.ade-movie'].flatMap((dir) => ['--glob', `!**/${dir}/**`]),
  ...LISTING_EXCLUDED_ROOT_DIRS.flatMap((dir) => ['--glob', `!/${dir}/**`])
]

/**
 * rg を走らせ、1行ごとに onLine を呼ぶ。onLine が false を返したら打ち切る。
 * timeoutMs を過ぎても終わらなければ（ネットワークのドライブ・巨大なフォルダ）止めて、そこまでで返す。
 * 戻り値は打ち切ったか（上限・時間切れ）。
 */
function runRg(rg: string, cwd: string, args: string[], onLine: (line: string) => boolean, timeoutMs = Infinity): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    // Windows で検索のたびにコンソールの窓が一瞬出ないようにする
    const child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buffer = ''
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill()
    }
    const timer = Number.isFinite(timeoutMs) ? setTimeout(stop, timeoutMs) : null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line && !onLine(line)) {
          stop()
          return
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', () => {
      if (timer) clearTimeout(timer)
      if (!stopped && buffer) onLine(buffer)
      resolvePromise(stopped)
    })
  })
}

// ─── ファイル一覧（クイックオープン・名前の検索）─────────────────────

/**
 * 索引に持つ上限。⌘P へ送るのは MAX_LISTED_FILES まで（IPC を詰まらせない）だが、
 * 名前の検索（fs:search）はこの上限まで全部から探す（大きなフォルダで、送った分の外にあるファイルも見つける）
 */
export const MAX_INDEXED_FILES = 200_000
/** 一覧を作るのにかける時間の上限。過ぎたらそこまでで返す（いつまでも「読み込み中」にしない） */
export const LIST_TIMEOUT_MS = 8000

export interface FileIndex {
  /** 相対パス。浅い・短いものが先（空の問い合わせで上に出るもの） */
  files: string[]
  /** 上限・時間切れで打ち切った */
  truncated: boolean
}

interface ListOptions {
  limit: number
  timeoutMs: number
}

/** 浅い・短いものが先、同じなら名前順（rg は並列に歩くので、出てくる順は毎回違う） */
function compareListed(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * rg が無いときの一覧。重いディレクトリ・worktree は降りない。シンボリックリンクは辿らない（ループしない）。
 * 上限か時間切れで止める
 */
export async function walkFiles(root: string, { limit, timeoutMs }: ListOptions): Promise<FileIndex> {
  const deadline = Date.now() + timeoutMs
  const files: string[] = []
  const queue = ['']
  // shift() は長い待ち行列で遅いので、読む位置を進める
  for (let head = 0; head < queue.length; head++) {
    if (Date.now() > deadline) return { files, truncated: true }
    const relDir = queue[head]!
    let dirents
    try {
      dirents = await readdir(join(root, relDir), { withFileTypes: true })
    } catch {
      // 読めないフォルダ（権限など）は飛ばす（想定内）
      continue
    }
    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (!isCollapsedByDefault(dirent.name) && !isExcludedFromListing(rel)) queue.push(rel)
      } else if (dirent.isFile()) {
        files.push(rel)
        if (files.length >= limit) return { files, truncated: true }
      }
    }
  }
  return { files, truncated: false }
}

/** プロジェクトのファイルを全部（上限・時間の上限まで）並べる。rg があれば .gitignore に従う */
export async function buildFileIndex(root: string, options: ListOptions = { limit: MAX_INDEXED_FILES, timeoutMs: LIST_TIMEOUT_MS }): Promise<FileIndex> {
  const realRoot = await realpath(root)
  const started = Date.now()
  const rg = await findRg(realRoot)
  let index: FileIndex | null = null
  if (rg) {
    const files: string[] = []
    // .gitignore に従う。隠しファイル（.env.example など）は出す
    const truncated = await runRg(rg, realRoot, ['--files', '--hidden', ...RG_EXCLUDES], (line) => {
      const rel = line.replace(/\\/g, '/').replace(/^\.\//, '')
      if (!isExcludedFromListing(rel)) files.push(rel)
      return files.length < options.limit
    }, options.timeoutMs).catch((err: unknown) => { reportHandled(err, { area: 'files', op: 'list files with rg' }); return null })
    if (truncated !== null) index = { files, truncated }
  }
  index ??= await walkFiles(realRoot, { limit: options.limit, timeoutMs: Math.max(1000, options.timeoutMs - (Date.now() - started)) })
  index.files.sort(compareListed)
  // 一覧に時間がかかったら手がかりに残す（巨大なフォルダ・ネットワークのドライブ）
  noteSlowOp('fs-index', Date.now() - started)
  return index
}

/**
 * プロジェクトごとのファイルの索引。⌘P を開くたび・検索欄で打つたびに歩き直さない。
 *   - 変更の監視（ProjectWatcher）が知らせたら古いことにする（invalidate）。読み直しは次に使うときに行う
 *   - 古い索引があれば、読み直しが freshWaitMs で終わらないときは古いものをすぐ返し、読み直しは続けて次から使う
 *   - 監視が止まっていても古いままにならないよう、maxAgeMs を過ぎたら読み直す
 *   - 同じプロジェクトの読み直しは1本にまとめる
 */
export class FileIndexCache {
  private entries = new Map<string, { index: FileIndex | null; builtAt: number; stale: boolean; building: Promise<FileIndex> | null }>()

  constructor(
    private readonly build: (root: string) => Promise<FileIndex> = (root) => buildFileIndex(root),
    private readonly options: { freshWaitMs: number; maxAgeMs: number; maxRoots: number } = { freshWaitMs: 300, maxAgeMs: 60_000, maxRoots: 4 },
    private readonly now: () => number = Date.now
  ) {}

  async get(root: string): Promise<FileIndex> {
    let entry = this.entries.get(root)
    if (!entry) {
      entry = { index: null, builtAt: 0, stale: true, building: null }
      this.entries.set(root, entry)
      // 開いたプロジェクトの数だけ持たない（古いものから捨てる）
      while (this.entries.size > this.options.maxRoots) this.entries.delete(this.entries.keys().next().value!)
    }
    const old = entry.index
    if (old && !entry.stale && this.now() - entry.builtAt < this.options.maxAgeMs) return old
    const building = entry.building ?? this.rebuild(root, entry)
    if (!old) return building
    let timer: NodeJS.Timeout | undefined
    const waited = new Promise<null>((resolveWait) => { timer = setTimeout(() => resolveWait(null), this.options.freshWaitMs) })
    try {
      // 読み直しに失敗したら古いものを使う（失敗は rebuild が残す）
      return (await Promise.race([building.catch(() => old), waited])) ?? old
    } finally {
      clearTimeout(timer)
    }
  }

  /** 古いことにする。root を省くと全部 */
  invalidate(root?: string): void {
    for (const [key, entry] of this.entries) if (root === undefined || key === root) entry.stale = true
  }

  private rebuild(root: string, entry: { index: FileIndex | null; builtAt: number; stale: boolean; building: Promise<FileIndex> | null }): Promise<FileIndex> {
    // 読み直している間に届いた変更は、次の読み直しで拾う（stale を先に下ろしておく）
    entry.stale = false
    const startedAt = this.now()
    const building = this.build(root).then(
      (index) => {
        entry.index = index
        entry.builtAt = startedAt
        return index
      },
      (err: unknown) => {
        entry.stale = true
        if (entry.index) reportHandled(err, { area: 'files', op: 'rebuild file index' })
        throw err
      }
    ).finally(() => { if (entry.building === building) entry.building = null })
    entry.building = building
    return building
  }
}

const fileIndex = new FileIndexCache()

/** 開いているプロジェクトのファイルが増えた・消えた・名前が変わった（変更の監視から呼ぶ） */
export function invalidateFileIndex(root?: string): void {
  fileIndex.invalidate(root)
}

/** ⌘P の一覧。送るのは MAX_LISTED_FILES まで（それより多いときは truncated。絞り込みは fs:search で全部から） */
export async function listFiles(root: string): Promise<FsFileList> {
  const index = await fileIndex.get(root)
  const truncated = index.truncated || index.files.length > MAX_LISTED_FILES
  return { files: truncated ? index.files.slice(0, MAX_LISTED_FILES) : index.files, truncated }
}

// ─── ファイル名の検索 ─────────────────────────────

/** 索引ごとに、絞り込み用の下ごしらえを覚えておく（打鍵のたびに数十万件の小文字を作り直さない） */
const preparedByIndex = new WeakMap<FileIndex, PreparedQuickOpenFiles>()

export async function searchFiles(root: string, query: string, mode: FsSearchMode): Promise<FsSearchResult> {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) return { mode, files: [], truncated: false }
  const index = await fileIndex.get(root)
  let prepared = preparedByIndex.get(index)
  if (!prepared) {
    prepared = prepareQuickOpenFiles(index.files)
    preparedByIndex.set(index, prepared)
  }
  const ranked = rankPreparedQuickOpenFiles(trimmed, prepared, MAX_NAME_MATCHES)
  return { mode, files: ranked.map((r) => r.path), truncated: index.truncated || ranked.length >= MAX_NAME_MATCHES }
}

// ─── 外部の変更の監視 ─────────────────────────────────────

/** まとめて通知するまでの待ち。Agent が続けて何ファイルも書くときに1回へまとめる */
const CHANGE_BATCH_MS = 150

/**
 * プロジェクトフォルダの変更を見張り、相対パスをまとめて知らせる。
 * Orca は @parcel/watcher を使うが、依存（ネイティブモジュール）を増やさないため
 * Node の fs.watch(recursive) を使う（macOS / Windows は OS の仕組み、Linux も Node 20 以降で対応）。
 */
/** 1回で renderer へ送る変更の上限（ビルドなどで大量に変わったとき） */
const MAX_PENDING_PATHS = 1000
/** これを超える通知が1回のまとまりで来たら、通知の嵐として控える */
const WATCH_BURST_EVENTS = 2000
/** 監視がエラーで止まったとき、張り直すまでの待ち（回を追うごとに倍）と回数の上限 */
const REWATCH_DELAY_MS = 2000
const REWATCH_MAX_ATTEMPTS = 5

export class ProjectWatcher {
  private watcher: FSWatcher | LinuxTreeWatcher | null = null
  private pending = new Set<string>()
  /** このまとまりで上限を超えて捨てた通知があった */
  private overflow = false
  /** 進み具合（progress.json）が変わったレビューのID。.ferret/ は変更通知の対象外なので別に拾う */
  private progress = new Set<string>()
  /** ビジュアルレビューの計画のフォルダ（.ferret/visual-review/）が変わった（@shared/visualReview） */
  private visualReview = false
  private timer: NodeJS.Timeout | null = null
  /** このまとまりで届いた通知の数と、最初の通知の時刻（ビルドや npm install の通知の嵐を、main の停止の手がかりに残す） */
  private burst = { events: 0, since: 0 }
  /** 監視がエラーで止まったあとの張り直し（Orca #17878 #24044: 止まったまま外部の変更が届かなくなる） */
  private rewatch: { timer: NodeJS.Timeout | null; attempts: number } = { timer: null, attempts: 0 }

  constructor(private readonly onChange: (event: FsChangedEvent) => void,
    /** Agent が .ferret/reviews/<id>/progress.json を書いたとき（指摘の進み具合。@shared/findingProgress） */
    private readonly onReviewProgress?: (ids: string[]) => void,
    /** Agent が .ferret/visual-review/ に計画・画像を書いたとき（ビジュアルレビューのタブを読み直す） */
    private readonly onVisualReview?: () => void) {}

  /** 監視の通知1件（まとめて flush で知らせる） */
  private readonly onFsEvent = (_event: string, filename: string | Buffer | null): void => {
    if (this.burst.events++ === 0) this.burst.since = Date.now()
    if (!filename) return
    const rel = String(filename).split(sep).join('/')
    if (this.onReviewProgress) for (const id of progressChangedIds([rel])) {
      this.progress.add(id)
      this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
    }
    if (this.onVisualReview && isVisualReviewPath(rel)) {
      this.visualReview = true
      this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
    }
    if (!shouldIncludePath(rel)) return
    // 通知の嵐で一覧が膨らみすぎないようにする（renderer へ送る量と、受け取ったあとの読み直しを抑える）。
    // 捨てた分があることは overflow で知らせる（捨てたパスに開いているファイルがあっても、取り込みを漏らさない）
    if (this.pending.size >= MAX_PENDING_PATHS && !this.pending.has(rel)) {
      this.overflow = true
      return
    }
    this.pending.add(rel)
    this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
  }

  watch(root: string | null, attempt = 0): void {
    this.close()
    this.rewatch.attempts = attempt
    if (!root) return
    try {
      const onEvent = this.onFsEvent
      // Linux の recursive は node_modules まで全部に inotify を張るので、対象のフォルダにだけ張る（linuxTreeWatch.ts）
      this.watcher = process.platform === 'linux'
        ? new LinuxTreeWatcher(root, onEvent, (err) => reportHandled(err, { area: 'files', op: 'watch project folder (limit)' }))
        : watch(root, { recursive: true }, onEvent)
      // 監視できなくなっても（フォルダの削除など）アプリは止めない。フォルダがまだあれば、間を空けて張り直す
      this.watcher.on('error', (err: unknown) => {
        this.close()
        reportHandled(err, { area: 'files', op: 'project watcher stopped' })
        if (attempt >= REWATCH_MAX_ATTEMPTS) return
        this.rewatch.timer = setTimeout(() => {
          this.rewatch.timer = null
          if (existsSync(root)) this.watch(root, attempt + 1)
        }, REWATCH_DELAY_MS * 2 ** attempt)
        this.rewatch.timer.unref?.()
      })
    } catch (err) {
      console.warn('[files] フォルダの変更を見張れません', err)
      reportHandled(err, { area: 'files', op: 'watch project folder' })
      this.watcher = null
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.rewatch.timer) clearTimeout(this.rewatch.timer)
    this.rewatch.timer = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.overflow = false
    this.progress.clear()
    this.visualReview = false
  }

  private flush(): void {
    this.timer = null
    // 1回のまとまりで通知が多すぎたら、重い処理の手がかりとして控える（何件・何 ms のあいだか）
    if (this.burst.events >= WATCH_BURST_EVENTS) noteSlowOp(`fswatch-burst:${this.burst.events}`, Math.max(SLOW_OP_MS, Date.now() - this.burst.since))
    this.burst = { events: 0, since: 0 }
    if (this.progress.size > 0) {
      const ids = [...this.progress]
      this.progress.clear()
      this.onReviewProgress?.(ids)
    }
    if (this.visualReview) {
      this.visualReview = false
      this.onVisualReview?.()
    }
    if (this.pending.size === 0 && !this.overflow) return
    const paths = [...this.pending]
    const overflow = this.overflow
    this.pending.clear()
    this.overflow = false
    this.onChange(overflow ? { paths, overflow } : { paths })
  }
}
