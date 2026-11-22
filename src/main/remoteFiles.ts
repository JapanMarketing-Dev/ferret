import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { UserFacingError } from '@shared/errors'
import { ENTRY_NAME_PROBLEM_KEYS, entryNameProblem, hasBinaryExtension, isBinaryBuffer, isInsideGitDir, isSameOrUnder, MAX_COPY_BYTES, MAX_COPY_ENTRIES, MAX_TEXT_FILE_SIZE, nestedNameParts, nestedNameProblem, type FsCreated, type FsEntry, type FsReadResult, type FsSearchResult, type FsTransfer, type FsWriteResult } from '@shared/files'
import { t } from '@shared/i18n'
import {
  isCopyNameOf,
  isValidRemoteRelPath,
  parseRemoteBrowse,
  parseRemoteListing,
  parseRemoteReport,
  parseRemoteSearch,
  remoteBrowseCommand,
  remoteCopyCommand,
  remoteCopyInput,
  remoteCreateCommand,
  remoteCreated,
  remoteListCommand,
  remoteMkdirCommand,
  remoteMoveCommand,
  remoteMoveInput,
  remoteReadCommand,
  remoteRenameCommand,
  remoteRenameInput,
  remoteTrashCommand,
  remoteTrashInput,
  remoteWriteCommand,
  trimTrailingSlashes,
  REMOTE_COPY_TOO_LARGE_EXIT,
  REMOTE_COPY_TOO_MANY_EXIT,
  REMOTE_GIT_EXIT,
  REMOTE_INTO_ITSELF_EXIT,
  REMOTE_NOT_FOUND_EXIT,
  REMOTE_OUTSIDE_EXIT,
  REMOTE_PERMISSION_EXIT,
  REMOTE_TRASH_FAILED_EXIT,
  REMOTE_TRASH_OTHER_DISK_EXIT,
  REMOTE_WRITE_FOLDER_EXIT,
  REMOTE_WRITE_NOT_REGULAR_EXIT,
  REMOTE_WRITE_SHORT_EXIT,
  remoteSearchCommand,
  REMOTE_EXISTS_EXIT,
  REMOTE_NO_PARENT_EXIT,
  REMOTE_NOT_FOLDER_EXIT,
  type FolderListing
} from '@shared/remoteFiles'
import { isValidSshHost, tmuxCapturePaneCommand, tmuxHasSessionCommand, tmuxKillSessionCommand, tmuxLeaveCopyModeCommand, type SshTarget } from '@shared/sshCommand'
import { MAX_TRASH_ENTRIES } from './fileOps'
import { toolEnv } from './github/gh'

/**
 * SSH のプロジェクトのファイルツリー（読む・作る・名前の変更・削除（リモートのゴミ箱へ）・移動・コピー）とエディタの保存・「新しいプロジェクト」の場所選びとフォルダ作成・tmux のセッションの確かめと後始末・コピーモードを抜ける・今の画面を取る。
 * リモートで動かす1行は src/shared/remoteFiles.ts / sshCommand.ts の純粋な関数で組み立て、ここは ssh を動かすだけ。
 *
 * - 対話なし（BatchMode）で動かす。鍵やパスワードは扱わず、~/.ssh/config と ssh-agent に任せる
 * - フォルダを開くたびに ssh をつなぎ直すと遅いので、macOS・Linux では接続を使い回す（ControlMaster。少し置いて閉じる）。
 *   Windows の OpenSSH は使い回しに対応していないので、毎回つなぐ
 */

export interface SshRunResult {
  code: number
  stdout: Buffer
  stderr: string
}

export type SshRunner = (host: string, command: string, options?: { timeoutMs?: number; maxBytes?: number; input?: Buffer }) => Promise<SshRunResult>

/** 接続を使い回す ssh のオプション（Windows では空） */
export function sshMultiplexOptions(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === 'win32') return []
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${posix.join(home, '.ssh', 'ferret-cm-%C')}`, '-o', 'ControlPersist=120']
}

/** 待ち時間を過ぎて ssh を止めたときの終了コード（coreutils の timeout と同じ 124。接続できなかった 255 とは分ける） */
export const SSH_TIMEOUT_EXIT = 124

/** execFile の失敗を終了コードにする。待ち時間で止めた（killed・code が無い）なら SSH_TIMEOUT_EXIT、ssh が始まらないなどは 255 */
export function sshExitCode(error: unknown): number {
  if (!error) return 0
  const e = error as { code?: unknown; killed?: unknown }
  if (typeof e.code === 'number') return e.code
  if (e.killed === true && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return SSH_TIMEOUT_EXIT
  return 255
}

/**
 * ssh に渡すコマンド行（リモートのログインシェルが読む）。値を一切含まない決まった1行で、実際に動かす1行は標準入力の先頭で渡す
 * （remoteStdin。1行目にバイト数、続けてその中身。残りは保存の中身や値として、そのまま続く）。リモートでは /bin/sh が読んで eval する。
 * ログインシェルが fish（単一引用符の中でも \' と \\ を読む）でも tcsh（複数行の引用を読めない）でも、引用が崩れない
 */
export const REMOTE_BOOTSTRAP = `exec /bin/sh -c 'IFS= read -r ferret_n || exit 125; ferret_s=$(dd bs=1 count="$ferret_n" 2>/dev/null) || exit 125; [ "$(printf %s "$ferret_s" | wc -c)" -eq "$ferret_n" ] || exit 125; eval "$ferret_s"' ferret`

/** REMOTE_BOOTSTRAP が1行を受け取れなかった（標準入力が途中で切れた）ときの終了コード。操作の失敗と分ける */
export const SSH_SEND_FAILED_EXIT = 125

/** REMOTE_BOOTSTRAP の標準入力（動かす1行のバイト数・その中身・続く入力） */
export function remoteStdin(command: string, input?: Buffer): Buffer {
  // $(...) は末尾の改行を落とすので、先に落としてからバイト数を数える（正規表現を使わない）
  let end = command.length
  while (end > 0 && command[end - 1] === '\n') end--
  const script = Buffer.from(command.slice(0, end), 'utf8')
  return Buffer.concat([Buffer.from(`${script.length}\n`, 'utf8'), script, input ?? Buffer.alloc(0)])
}

/** ssh -o BatchMode=yes -- <host> <決まった1行> で、<1行> を動かす。終了コードと出力を返す（失敗でも例外にしない） */
export const runSsh: SshRunner = (host, command, options = {}) => {
  if (!isValidSshHost(host)) return Promise.reject(new UserFacingError(t('projectSource.errors.host')))
  const { timeoutMs = 20_000, maxBytes = MAX_TEXT_FILE_SIZE + 1024 * 1024 } = options
  const input = remoteStdin(command, options.input)
  return new Promise((resolve) => {
    const child = execFile('ssh', [...sshMultiplexOptions(), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, REMOTE_BOOTSTRAP],
      { env: toolEnv(), timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: sshExitCode(error), stdout: Buffer.from(stdout ?? []), stderr: Buffer.from(stderr ?? []).toString('utf8') })
      })
    // 標準入力で中身を渡す（保存・ファイルの操作の値）。渡さないときは閉じる（リモートの cat などが待ち続けない）
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

/** ssh の失敗を利用者向けの1行にする（ssh 自体の失敗＝255 は接続できなかった。待ち時間を過ぎたら、途中まで進んだかもしれないと伝える） */
function sshFailure(result: SshRunResult, host: string): UserFacingError {
  if (result.code === SSH_TIMEOUT_EXIT) return new UserFacingError(t('remoteFiles.errors.timeout'))
  if (result.code === SSH_SEND_FAILED_EXIT) return new UserFacingError(t('remoteFiles.errors.sendFailed'))
  const line = result.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (result.code === 255) return new UserFacingError(t('remoteFiles.errors.connect', { host, detail: line.slice(0, 200) }))
  return new UserFacingError(line ? line.slice(0, 300) : t('remoteFiles.errors.failed', { code: result.code }))
}

/** SSH のプロジェクトのフォルダの中身 */
export async function listRemoteDirectory(target: SshTarget, rel: string, run: SshRunner = runSsh): Promise<FsEntry[]> {
  const result = await run(target.host, remoteListCommand(target.path, rel))
  // リンク切れがあると ls は 1 で終わるが、一覧は出る
  if (result.code !== 0 && !(result.code === 1 && result.stdout.length > 0)) throw sshFailure(result, target.host)
  return parseRemoteListing(result.stdout.toString('utf8'), rel)
}

/** SSH のプロジェクトのファイルを読む（文字だけ。上限より大きいもの・バイナリは理由を返す） */
export async function readRemoteFile(target: SshTarget, rel: string, run: SshRunner = runSsh, limit = MAX_TEXT_FILE_SIZE): Promise<FsReadResult> {
  if (hasBinaryExtension(rel)) return { kind: 'binary', path: rel, reason: t('files.errors.binary') }
  const result = await run(target.host, remoteReadCommand(target.path, rel, limit), { maxBytes: limit + 64 * 1024 })
  if (result.code === 3) throw new UserFacingError(t('files.errors.notRegular'))
  if (result.code !== 0) throw sshFailure(result, target.host)
  if (result.stdout.length > limit) {
    return { kind: 'tooLarge', path: rel, size: result.stdout.length, reason: t('files.errors.tooLarge', { size: (result.stdout.length / 1024 / 1024).toFixed(1), limit: limit / 1024 / 1024 }) }
  }
  if (isBinaryBuffer(result.stdout)) return { kind: 'binary', path: rel, reason: t('files.errors.binary') }
  return { kind: 'text', path: rel, content: result.stdout.toString('utf8'), mtimeMs: 0 }
}

/** 保存できる大きさの上限（開けるのは MAX_TEXT_FILE_SIZE まで。編集で増えた分の幅を持たせる） */
export const MAX_REMOTE_WRITE_BYTES = MAX_TEXT_FILE_SIZE * 4

/** SSH のプロジェクトのファイルへ書く（エディタの保存・終了時の保存） */
export async function writeRemoteFile(target: SshTarget, rel: string, content: string, run: SshRunner = runSsh): Promise<FsWriteResult> {
  if (typeof content !== 'string') throw new UserFacingError(t('files.errors.badContent'))
  const data = Buffer.from(content, 'utf8')
  if (data.length > MAX_REMOTE_WRITE_BYTES) throw new UserFacingError(t('files.errors.tooLarge', { size: (data.length / 1024 / 1024).toFixed(1), limit: MAX_REMOTE_WRITE_BYTES / 1024 / 1024 }))
  let command: string
  try {
    command = remoteWriteCommand(target.path, rel, data.length)
  } catch {
    throw new UserFacingError(t('files.errors.notFound'))
  }
  const result = await run(target.host, command, { input: data, timeoutMs: 60_000 })
  if (result.code === REMOTE_WRITE_FOLDER_EXIT) throw new UserFacingError(t('files.errors.folder'))
  if (result.code === REMOTE_WRITE_NOT_REGULAR_EXIT) throw new UserFacingError(t('files.errors.notRegular'))
  if (result.code === REMOTE_WRITE_SHORT_EXIT) throw new UserFacingError(t('remoteFiles.errors.failed', { code: result.code }))
  if (result.code !== 0) throw sshFailure(result, target.host)
  return { mtimeMs: 0 }
}

/** SSH のプロジェクトでファイル名を絞り込む */
export async function searchRemoteNames(target: SshTarget, query: string, run: SshRunner = runSsh): Promise<FsSearchResult> {
  if (!query.trim()) return { mode: 'names', files: [], truncated: false }
  const result = await run(target.host, remoteSearchCommand(target.path, query.trim()), { timeoutMs: 30_000 })
  if (result.code === 255 || result.code === SSH_TIMEOUT_EXIT || result.code === SSH_SEND_FAILED_EXIT) throw sshFailure(result, target.host)
  return { mode: 'names', ...parseRemoteSearch(result.stdout.toString('utf8')) }
}

/** SSH のプロジェクトで、空のファイルか空のフォルダを作る（ファイルツリーの「新しいファイル」「新しいフォルダ」） */
export async function createRemoteEntry(target: SshTarget, parentRel: string, name: string, kind: FsEntry['kind'], run: SshRunner = runSsh): Promise<FsCreated> {
  if (kind !== 'file' && kind !== 'directory') throw new UserFacingError(t('files.errors.badContent'))
  if (typeof name !== 'string' || typeof parentRel !== 'string') throw new UserFacingError(t('files.errors.notFound'))
  const problem = nestedNameProblem(name)
  if (problem) throw new UserFacingError(t(ENTRY_NAME_PROBLEM_KEYS[problem]))
  if (isInsideGitDir(parentRel ? `${parentRel}/${name}` : name)) throw new UserFacingError(t('files.errors.gitDir'))
  let command: string
  try {
    command = remoteCreateCommand(target.path, parentRel, name, kind)
  } catch {
    throw new UserFacingError(t('files.errors.notFound'))
  }
  const result = await run(target.host, command)
  if (result.code === REMOTE_EXISTS_EXIT) throw new UserFacingError(t('files.errors.exists', { name: nestedNameParts(name).at(-1)! }))
  if (result.code === REMOTE_NOT_FOLDER_EXIT) throw new UserFacingError(t('files.errors.notFolder'))
  if (result.code === REMOTE_NO_PARENT_EXIT) throw new UserFacingError(t('files.errors.notFound'))
  if (result.code !== 0) throw sshFailure(result, target.host)
  return remoteCreated(result.stdout.toString('utf8'), parentRel, name)
}

/** 「新しいプロジェクト」の場所選び（リモート）。path が null ならホーム */
export async function browseRemoteFolders(host: string, path: string | null, run: SshRunner = runSsh): Promise<FolderListing> {
  const result = await run(host, remoteBrowseCommand(path))
  const listing = result.code === 0 || (result.code === 1 && result.stdout.length > 0) ? parseRemoteBrowse(result.stdout.toString('utf8')) : null
  if (!listing) throw sshFailure(result, host)
  return listing
}

/** リモートの親フォルダの下にフォルダを作る。作ったフォルダの絶対パスを返す */
export async function createRemoteFolder(host: string, parent: string, name: string, run: SshRunner = runSsh): Promise<string> {
  const result = await run(host, remoteMkdirCommand(parent, name))
  if (result.code === REMOTE_EXISTS_EXIT) throw new UserFacingError(t('newProject.errors.exists', { name: name.trim() }))
  if (result.code !== 0) throw sshFailure(result, host)
  const path = result.stdout.toString('utf8').trim().split('\n').pop() ?? ''
  if (!path.startsWith('/')) throw new UserFacingError(t('remoteFiles.errors.failed', { code: result.code }))
  return path
}

// ── ファイルツリーの削除（リモートのゴミ箱へ）・名前の変更・移動・コピー・パスのコピー ──

/** ゴミ箱へ・移動（同じディスクの中なので一瞬）とコピーを待つ時間 */
const REMOTE_MOVE_TIMEOUT_MS = 120_000
const REMOTE_COPY_TIMEOUT_MS = 300_000

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

function parentRel(rel: string): string {
  const slash = rel.lastIndexOf('/')
  return slash < 0 ? '' : rel.slice(0, slash)
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/**
 * 選んだもの（相対パス）を確かめる（ローカルの trashEntries・resolveSources と同じ決まり）。
 * プロジェクトのフォルダそのもの・.git の中・外へ出るパスは断る。同じものは1つにし、選んだフォルダの下にあるものは省く（親と一緒に扱う）
 */
function remoteSelection(relPaths: unknown): string[] {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRASH_ENTRIES) throw new UserFacingError(t('files.errors.badContent'))
  const rels: string[] = []
  for (const rel of relPaths) {
    if (typeof rel !== 'string' || !isValidRemoteRelPath(rel)) throw new UserFacingError(t('files.errors.notFound'))
    if (rel === '') throw new UserFacingError(t('files.errors.projectRoot'))
    if (isInsideGitDir(rel)) throw new UserFacingError(t('files.errors.gitDir'))
    if (!rels.includes(rel)) rels.push(rel)
  }
  return rels.filter((x) => !rels.some((other) => other !== x && x.startsWith(`${other}/`)))
}

/** 移動・コピーの先（相対パス。'' はプロジェクトのフォルダ）を確かめる */
function remoteDestination(destRel: unknown): string {
  if (typeof destRel !== 'string' || !isValidRemoteRelPath(destRel)) throw new UserFacingError(t('files.errors.notFound'))
  if (isInsideGitDir(destRel)) throw new UserFacingError(t('files.errors.gitDir'))
  return destRel
}

/** 標準入力で渡す値を組み立てる。組み立てを断られたら（登録したフォルダのパスがおかしいなど）「見つからない」にする（writeRemoteFile と同じ） */
function remoteInput(build: () => string): Buffer {
  try {
    return Buffer.from(build(), 'utf8')
  } catch {
    throw new UserFacingError(t('files.errors.notFound'))
  }
}

/**
 * script の終了コードを利用者向けの1行にする。names[i] は一覧の i+1 番目の名前（bad の番号で、どれで止まったかを出す）。
 * OS の文言（絶対パスを含む）は出さない。ゴミ箱へ移すときの分からない失敗は「削除できませんでした」、ほかは「〜で失敗しました」にする
 */
function remoteEntryFailure(result: SshRunResult, host: string, names: readonly string[], bad: number | null, action: 'trash' | 'other' = 'other'): UserFacingError {
  if (result.code === 255 || result.code === SSH_TIMEOUT_EXIT || result.code === SSH_SEND_FAILED_EXIT) return sshFailure(result, host)
  const name = (bad !== null ? names[bad - 1] : undefined) ?? names[0] ?? ''
  switch (result.code) {
    case REMOTE_NOT_FOUND_EXIT:
    case REMOTE_NO_PARENT_EXIT: return new UserFacingError(t('files.errors.notFound'))
    case REMOTE_NOT_FOLDER_EXIT: return new UserFacingError(t('files.errors.notFolder'))
    case REMOTE_OUTSIDE_EXIT: return new UserFacingError(t('files.errors.outside'))
    case REMOTE_GIT_EXIT: return new UserFacingError(t('files.errors.gitDir'))
    case REMOTE_INTO_ITSELF_EXIT: return new UserFacingError(t('files.errors.intoItself'))
    case REMOTE_EXISTS_EXIT: return new UserFacingError(t('files.errors.exists', { name }))
    case REMOTE_TRASH_FAILED_EXIT: return new UserFacingError(t('files.errors.trashFailed', { name }))
    case REMOTE_TRASH_OTHER_DISK_EXIT: return new UserFacingError(t('remoteFiles.errors.trashOtherDisk', { name }))
    case REMOTE_PERMISSION_EXIT: return new UserFacingError(t('remoteFiles.errors.permission', { name }))
    case REMOTE_COPY_TOO_MANY_EXIT: return new UserFacingError(t('files.errors.copyTooMany', { limit: MAX_COPY_ENTRIES.toLocaleString('en-US') }))
    case REMOTE_COPY_TOO_LARGE_EXIT: return new UserFacingError(t('files.errors.copyTooLarge', { limit: Math.round(MAX_COPY_BYTES / 1024 / 1024 / 1024) }))
    default:
      if (action === 'trash') return new UserFacingError(t('files.errors.trashFailed', { name }))
      return name ? new UserFacingError(t('remoteFiles.errors.itemFailed', { name })) : new UserFacingError(t('remoteFiles.errors.failed', { code: result.code }))
  }
}

/**
 * SSH のプロジェクトで、選んだもの（相対パス）をリモートのゴミ箱（ふつうは ~/.local/share/Trash）へ移す（ファイルツリーの削除）。移した相対パスを返す。
 * 先に全部を確かめ、1つでも断るものがあれば何も移さない（ローカルの trashEntries と同じ）
 */
export async function trashRemoteEntries(target: SshTarget, relPaths: unknown, run: SshRunner = runSsh): Promise<string[]> {
  const rels = remoteSelection(relPaths)
  const input = remoteInput(() => remoteTrashInput(target.path, rels))
  const result = await run(target.host, remoteTrashCommand(), { input, timeoutMs: REMOTE_MOVE_TIMEOUT_MS })
  const report = parseRemoteReport(result.stdout.toString('utf8'))
  if (result.code !== 0) throw remoteEntryFailure(result, target.host, rels.map(baseName), report.bad, 'trash')
  return rels.filter((_, i) => report.ok.has(i + 1))
}

/** SSH のプロジェクトで、同じフォルダの中で名前を変える（F2・右クリック）。新しい相対パスを返す（既にある名前には上書きしない） */
export async function renameRemoteEntry(target: SshTarget, relPath: unknown, newName: unknown, run: SshRunner = runSsh): Promise<string> {
  const problem = entryNameProblem(newName as string)
  if (problem) throw new UserFacingError(t(ENTRY_NAME_PROBLEM_KEYS[problem]))
  const name = newName as string
  if (typeof relPath !== 'string' || !isValidRemoteRelPath(relPath)) throw new UserFacingError(t('files.errors.notFound'))
  if (relPath === '') throw new UserFacingError(t('files.errors.projectRoot'))
  if (isInsideGitDir(relPath)) throw new UserFacingError(t('files.errors.gitDir'))
  const oldName = baseName(relPath)
  if (oldName === name) return relPath
  const input = remoteInput(() => remoteRenameInput(target.path, relPath, name, oldName.toLowerCase() === name.toLowerCase()))
  const result = await run(target.host, remoteRenameCommand(), { input, timeoutMs: 30_000 })
  if (result.code !== 0) throw remoteEntryFailure(result, target.host, [result.code === REMOTE_EXISTS_EXIT ? name : oldName], 1)
  return joinRel(parentRel(relPath), name)
}

/**
 * SSH のプロジェクトで、選んだものを destRel のフォルダへ動かす（切り取り・貼り付け、ドラッグ）。名前は変えない。from → to の組を返す
 * （もともとそのフォルダにあるものは from と to が同じ）。先に全部を確かめ、移動先に同じ名前があれば何も動かさない（ローカルの moveEntries と同じ）
 */
export async function moveRemoteEntries(target: SshTarget, relPaths: unknown, destRel: unknown, run: SshRunner = runSsh): Promise<FsTransfer[]> {
  const dest = remoteDestination(destRel)
  const sources = remoteSelection(relPaths)
  if (sources.some((source) => isSameOrUnder(dest, source))) throw new UserFacingError(t('files.errors.intoItself'))
  const moving = sources.filter((source) => parentRel(source) !== dest)
  // 違うフォルダから同じ名前を2つ動かすと、2つめが1つめに当たる。先に断る（ローカルと同じく大文字小文字は区別しない）
  const names = new Set<string>()
  for (const source of moving) {
    const key = baseName(source).toLowerCase()
    if (names.has(key)) throw new UserFacingError(t('files.errors.exists', { name: baseName(source) }))
    names.add(key)
  }
  if (moving.length === 0) return sources.map((source) => ({ from: source, to: source }))
  const input = remoteInput(() => remoteMoveInput(target.path, dest, moving))
  const result = await run(target.host, remoteMoveCommand(), { input, timeoutMs: REMOTE_MOVE_TIMEOUT_MS })
  const report = parseRemoteReport(result.stdout.toString('utf8'))
  if (result.code !== 0) throw remoteEntryFailure(result, target.host, moving.map(baseName), report.bad)
  const moved = new Map(moving.map((source, i) => [source, report.same.has(i + 1) ? source : joinRel(dest, baseName(source))]))
  return sources.map((source) => ({ from: source, to: moved.get(source) ?? source }))
}

/**
 * SSH のプロジェクトで、選んだものを destRel のフォルダへコピーする（貼り付け・複製）。同じ名前があれば「名前 copy」「名前 copy 2」にする。
 * from → to の組を返す（パイプなどの写さなかったものは含めない）。数と大きさの上限はローカルと同じ（MAX_COPY_ENTRIES・MAX_COPY_BYTES）。
 * 出力の名前が copyName の形でなければ（読み違い）、写したものとして返さない（元に戻すで関係ないものを消さないように）
 */
export async function copyRemoteEntries(target: SshTarget, relPaths: unknown, destRel: unknown, run: SshRunner = runSsh): Promise<FsTransfer[]> {
  const dest = remoteDestination(destRel)
  const sources = remoteSelection(relPaths)
  if (sources.some((source) => isSameOrUnder(dest, source))) throw new UserFacingError(t('files.errors.intoItself'))
  const input = remoteInput(() => remoteCopyInput(target.path, dest, sources))
  const result = await run(target.host, remoteCopyCommand(), { input, timeoutMs: REMOTE_COPY_TIMEOUT_MS })
  const report = parseRemoteReport(result.stdout.toString('utf8'))
  if (result.code !== 0) throw remoteEntryFailure(result, target.host, sources.map(baseName), report.bad)
  const done: FsTransfer[] = []
  for (const [i, source] of sources.entries()) {
    const name = report.ok.get(i + 1)
    if (name === undefined || report.skip.has(i + 1)) continue
    // 読み違い（壊れた出力）なら、写したものとして返さない（ツリーは読み直すので見える。元に戻すの履歴には積まない）
    if (!isCopyNameOf(name, baseName(source))) continue
    done.push({ from: source, to: joinRel(dest, name) })
  }
  return done
}

/**
 * SSH のプロジェクトの「パスをコピー」の文字列（ssh は使わない）。absolute はリモートのパス（登録したフォルダの書き方のまま。~ も残す）、
 * relative はプロジェクトからの相対パス。複数なら1行に1つ
 */
export function remotePathsForClipboard(target: SshTarget, relPaths: unknown, kind: 'absolute' | 'relative'): string {
  if (!Array.isArray(relPaths) || relPaths.length === 0 || relPaths.length > MAX_TRASH_ENTRIES) throw new UserFacingError(t('files.errors.badContent'))
  const base = trimTrailingSlashes(target.path)
  return relPaths.map((rel: unknown) => {
    if (typeof rel !== 'string' || !isValidRemoteRelPath(rel)) throw new UserFacingError(t('files.errors.notFound'))
    if (kind === 'relative') return rel === '' ? '.' : rel
    if (rel === '') return target.path
    return base === '/' ? `/${rel}` : `${base}/${rel}`
  }).join('\n')
}

/** tmux のセッションがあるか。つながらない・分からないときは null */
export async function tmuxSessionExists(host: string, session: string, run: SshRunner = runSsh): Promise<boolean | null> {
  const result = await run(host, tmuxHasSessionCommand(session), { timeoutMs: 15_000 }).catch(() => null)
  // つながらない・待ち時間を過ぎた（分からない）なら null（無いとみなして作り直さない）
  if (!result || result.code === 255 || result.code === SSH_TIMEOUT_EXIT || result.code === SSH_SEND_FAILED_EXIT) return null
  return result.code === 0
}

/** tmux のセッションを終わらせる（タブを Ferret で閉じたとき。待たない・失敗しても知らせない） */
export function killTmuxSession(host: string, session: string, run: SshRunner = runSsh): void {
  void run(host, tmuxKillSessionCommand(session), { timeoutMs: 15_000 }).catch(() => undefined)
}

/** コピーモードを抜ける・今の画面を取るのを待つ上限。接続を使い回していれば 1 往復で済む（使い回しが切れていてもつなぎ直せる長さ） */
export const TMUX_LEAVE_COPY_MODE_TIMEOUT_MS = 3000

/** 1行を動かして、終了コード 0 の出力だけを返す（つながらない・遅い・組み立てられないときは null。投げない） */
async function runTmuxLine(host: string, line: () => string, run: SshRunner): Promise<string | null> {
  try {
    const result = await run(host, line(), { timeoutMs: TMUX_LEAVE_COPY_MODE_TIMEOUT_MS })
    return result.code === 0 ? result.stdout.toString('utf8') : null
  } catch {
    return null
  }
}

/**
 * tmux のコピーモードを抜ける（Ferret が Agent へ打ち込む前。ホイールで上へ戻したままだと、貼り付けと Enter を tmux が受け取る）。
 * left: 入っていて抜けたか。screen: 今の画面（抜けた直後の renderer の画面は、描き直しが届くまで上へ戻した位置のまま）。
 * つながらない・遅い・分からないときは null。失敗しても投げない（送信を止めない）
 */
export async function leaveTmuxCopyMode(host: string, session: string, run: SshRunner = runSsh): Promise<{ left: boolean; screen: string } | null> {
  const out = await runTmuxLine(host, () => tmuxLeaveCopyModeCommand(session), run)
  if (out === null) return null
  const newline = out.indexOf('\n')
  const mode = (newline < 0 ? out : out.slice(0, newline)).trim()
  if (mode !== '1' && mode !== '0') return null
  return { left: mode === '1', screen: newline < 0 ? '' : out.slice(newline + 1).replace(/\n+$/, '') }
}

/** tmux の今の画面（コピーモードは抜けない）。取れなければ null */
export async function captureTmuxPane(host: string, session: string, run: SshRunner = runSsh): Promise<string | null> {
  const out = await runTmuxLine(host, () => tmuxCapturePaneCommand(session), run)
  return out === null ? null : out.replace(/\n+$/, '')
}
