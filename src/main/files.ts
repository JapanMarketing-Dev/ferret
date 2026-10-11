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
  shouldIncludePath,
  type FsChangedEvent,
  type FsEntry,
  type FsFileList,
  type FsReadResult,
  type FsSearchMode,
  type FsSearchResult,
  type FsWriteResult
} from '@shared/files'
import { rankQuickOpenFiles } from '@shared/quickOpen'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { SLOW_OP_MS, noteSlowOp, reportHandled } from '@shared/report'
import { progressChangedIds } from '@shared/findingProgress'

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

export async function listDirectory(root: string, relDir: string): Promise<FsEntry[]> {
  const dir = await resolveInside(root, relDir)
  const listed = await openListedDir(root, dir)
  // 上限まで読む（macOS・Linux は opendir で少しずつ。Windows は readdir。dirEntries.ts・FERRET-1Q）
  const entries: FsEntry[] = []
  try {
    const { entries: dirents } = await readDirEntries(listed.path, MAX_DIRECTORY_ENTRIES)
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

/** 除外するディレクトリを rg のグロブにする */
const RG_EXCLUDES = ['.git', 'node_modules', '.ferret', '.ade-movie'].flatMap((dir) => ['--glob', `!**/${dir}/**`])

/**
 * rg を走らせ、1行ごとに onLine を呼ぶ。onLine が false を返したら打ち切る。
 * 戻り値は打ち切ったか。
 */
function runRg(rg: string, cwd: string, args: string[], onLine: (line: string) => boolean): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    // Windows で検索のたびにコンソールの窓が一瞬出ないようにする
    const child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buffer = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line && !onLine(line)) {
          stopped = true
          child.kill()
          return
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.on('error', reject)
    child.on('close', () => {
      if (!stopped && buffer) onLine(buffer)
      resolvePromise(stopped)
    })
  })
}

// ─── ファイル一覧（クイックオープン）─────────────────────

/** rg が無いときの一覧。重いディレクトリは降りない */
async function walkFiles(root: string, limit: number): Promise<FsFileList> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0) {
    const relDir = queue.shift()!
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
        if (!isCollapsedByDefault(dirent.name)) queue.push(rel)
      } else if (dirent.isFile()) {
        files.push(rel)
        if (files.length >= limit) return { files, truncated: true }
      }
    }
  }
  return { files, truncated: false }
}

export async function listFiles(root: string): Promise<FsFileList> {
  const realRoot = await realpath(root)
  const rg = await findRg(realRoot)
  if (!rg) return walkFiles(realRoot, MAX_LISTED_FILES)
  const files: string[] = []
  // .gitignore に従う。隠しファイル（.env.example など）は出す
  const truncated = await runRg(rg, realRoot, ['--files', '--hidden', ...RG_EXCLUDES], (line) => {
    const rel = line.replace(/\\/g, '/').replace(/^\.\//, '')
    if (shouldIncludePath(rel)) files.push(rel)
    return files.length < MAX_LISTED_FILES
  }).catch((err: unknown) => { reportHandled(err, { area: 'files', op: 'list files with rg' }); return null })
  if (truncated === null) return walkFiles(realRoot, MAX_LISTED_FILES)
  return { files, truncated }
}

// ─── ファイル名の検索 ─────────────────────────────

export async function searchFiles(root: string, query: string, mode: FsSearchMode): Promise<FsSearchResult> {
  const realRoot = await realpath(root)
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) return { mode, files: [], truncated: false }
  const listing = await listFiles(realRoot)
  const ranked = rankQuickOpenFiles(trimmed, listing.files, MAX_NAME_MATCHES)
  return { mode, files: ranked.map((r) => r.path), truncated: listing.truncated || ranked.length >= MAX_NAME_MATCHES }
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
  /** 進み具合（progress.json）が変わったレビューのID。.ferret/ は変更通知の対象外なので別に拾う */
  private progress = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  /** このまとまりで届いた通知の数と、最初の通知の時刻（ビルドや npm install の通知の嵐を、main の停止の手がかりに残す） */
  private burst = { events: 0, since: 0 }
  /** 監視がエラーで止まったあとの張り直し（Orca #17878 #24044: 止まったまま外部の変更が届かなくなる） */
  private rewatch: { timer: NodeJS.Timeout | null; attempts: number } = { timer: null, attempts: 0 }

  constructor(private readonly onChange: (event: FsChangedEvent) => void,
    /** Agent が .ferret/reviews/<id>/progress.json を書いたとき（指摘の進み具合。@shared/findingProgress） */
    private readonly onReviewProgress?: (ids: string[]) => void) {}

  watch(root: string | null, attempt = 0): void {
    this.close()
    this.rewatch.attempts = attempt
    if (!root) return
    try {
      const onEvent = (_event: string, filename: string | Buffer | null): void => {
        if (this.burst.events++ === 0) this.burst.since = Date.now()
        if (!filename) return
        const rel = String(filename).split(sep).join('/')
        if (this.onReviewProgress) for (const id of progressChangedIds([rel])) {
          this.progress.add(id)
          this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
        }
        if (!shouldIncludePath(rel)) return
        // 通知の嵐で一覧が膨らみすぎないようにする（renderer へ送る量と、受け取ったあとの読み直しを抑える）
        if (this.pending.size >= MAX_PENDING_PATHS) return
        this.pending.add(rel)
        this.timer ??= setTimeout(() => this.flush(), CHANGE_BATCH_MS)
      }
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
    this.progress.clear()
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
    if (this.pending.size === 0) return
    const paths = [...this.pending]
    this.pending.clear()
    this.onChange({ paths })
  }
}
