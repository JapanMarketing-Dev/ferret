import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { UserFacingError } from '@shared/errors'
import { hasBinaryExtension, isBinaryBuffer, MAX_TEXT_FILE_SIZE, type FsEntry, type FsReadResult, type FsSearchResult } from '@shared/files'
import { t } from '@shared/i18n'
import {
  parseRemoteBrowse,
  parseRemoteListing,
  parseRemoteSearch,
  remoteBrowseCommand,
  remoteListCommand,
  remoteMkdirCommand,
  remoteReadCommand,
  remoteSearchCommand,
  REMOTE_EXISTS_EXIT,
  type FolderListing
} from '@shared/remoteFiles'
import { isValidSshHost, tmuxHasSessionCommand, tmuxKillSessionCommand, type SshTarget } from '@shared/sshCommand'
import { toolEnv } from './github/gh'

/**
 * SSH のプロジェクトのファイルツリー（読むだけ）・「新しいプロジェクト」の場所選びとフォルダ作成・tmux のセッションの確かめと後始末。
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

export type SshRunner = (host: string, command: string, options?: { timeoutMs?: number; maxBytes?: number }) => Promise<SshRunResult>

/** 接続を使い回す ssh のオプション（Windows では空） */
export function sshMultiplexOptions(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === 'win32') return []
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${posix.join(home, '.ssh', 'ferret-cm-%C')}`, '-o', 'ControlPersist=120']
}

/** ssh -o BatchMode=yes -- <host> <1行> を動かす。終了コードと出力を返す（失敗でも例外にしない） */
export const runSsh: SshRunner = (host, command, options = {}) => {
  if (!isValidSshHost(host)) return Promise.reject(new UserFacingError(t('projectSource.errors.host')))
  const { timeoutMs = 20_000, maxBytes = MAX_TEXT_FILE_SIZE + 1024 * 1024 } = options
  return new Promise((resolve) => {
    execFile('ssh', [...sshMultiplexOptions(), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, command],
      { env: toolEnv(), timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 255) : 0
        resolve({ code, stdout: Buffer.from(stdout ?? []), stderr: Buffer.from(stderr ?? []).toString('utf8') })
      })
  })
}

/** ssh の失敗を利用者向けの1行にする（ssh 自体の失敗＝255 は接続できなかった） */
function sshFailure(result: SshRunResult, host: string): UserFacingError {
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

/** SSH のプロジェクトでファイル名を絞り込む */
export async function searchRemoteNames(target: SshTarget, query: string, run: SshRunner = runSsh): Promise<FsSearchResult> {
  if (!query.trim()) return { mode: 'names', files: [], truncated: false }
  const result = await run(target.host, remoteSearchCommand(target.path, query.trim()), { timeoutMs: 30_000 })
  if (result.code === 255) throw sshFailure(result, target.host)
  return { mode: 'names', ...parseRemoteSearch(result.stdout.toString('utf8')) }
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

/** tmux のセッションがあるか。つながらない・分からないときは null */
export async function tmuxSessionExists(host: string, session: string, run: SshRunner = runSsh): Promise<boolean | null> {
  const result = await run(host, tmuxHasSessionCommand(session), { timeoutMs: 15_000 }).catch(() => null)
  if (!result || result.code === 255) return null
  return result.code === 0
}

/** tmux のセッションを終わらせる（タブを Ferret で閉じたとき。待たない・失敗しても知らせない） */
export function killTmuxSession(host: string, session: string, run: SshRunner = runSsh): void {
  void run(host, tmuxKillSessionCommand(session), { timeoutMs: 15_000 }).catch(() => undefined)
}
