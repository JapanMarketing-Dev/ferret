import { isCollapsedByDefault, isInsideGitDir, nestedNameParts, nestedNameProblem, type FsEntry } from './files'
import { remotePathExpr, shellQuote } from './sshCommand'

/**
 * SSH のプロジェクトのファイルツリーと、「新しいプロジェクト」の場所選びで、リモートで動かす1行の組み立てと出力の読み取り
 * （純粋な関数。注入対策の単体テストの対象）。ssh を動かすのは src/main/remoteFiles.ts。
 *
 * - リモートのパスや名前は、必ず POSIX の単一引用符で囲んでリモートのシェルに渡す
 * - 相対パスは / で始まらず、.. を含まないものだけ（プロジェクトのフォルダの外を読ませない）
 * - 一覧は `ls -1ApL`（1行1つ・. と .. を除く・フォルダの末尾に /・リンクは先をたどる）。改行を含む名前は扱わない
 */

/** 1つのフォルダで一覧に出す上限（ローカルの fs:list と同じ考え方） */
export const MAX_REMOTE_ENTRIES = 5000
/** 名前の絞り込みで返す上限 */
export const MAX_REMOTE_SEARCH = 200

/** プロジェクトからの相対パスとして受け付けるか。'' はプロジェクトのフォルダそのもの */
export function isValidRemoteRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length > 4096 || /[\0\r\n]/.test(rel)) return false
  if (rel === '') return true
  if (rel.startsWith('/') || rel.startsWith('~') || rel.startsWith('-')) return false
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

function checkRel(rel: string): string {
  if (!isValidRemoteRelPath(rel)) throw new Error('invalid remote path')
  return rel
}

/** プロジェクトのフォルダへ移る式 */
function cdRoot(root: string): string {
  return `cd ${remotePathExpr(root)}`
}

/** フォルダの中身の一覧を出す1行 */
export function remoteListCommand(root: string, rel: string): string {
  const dir = checkRel(rel)
  return `${cdRoot(root)} && cd -- ${shellQuote(dir || '.')} && LC_ALL=C ls -1ApL`
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** `ls -1ApL` の出力をツリーの行にする（フォルダが先、名前は自然順） */
export function parseRemoteListing(stdout: string, rel: string, limit = MAX_REMOTE_ENTRIES): FsEntry[] {
  const entries: FsEntry[] = []
  for (const line of stdout.split('\n')) {
    if (entries.length >= limit) break
    if (!line || line === './' || line === '../') continue
    const directory = line.endsWith('/')
    const name = directory ? line.slice(0, -1) : line
    if (!name || name.includes('/') || name === '.' || name === '..') continue
    const path = rel ? `${rel}/${name}` : name
    entries.push({ name, path, kind: directory ? 'directory' : 'file', ...(directory && isCollapsedByDefault(name) ? { collapsed: true } : {}) })
  }
  return entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : NAME_ORDER.compare(a.name, b.name)))
}

/** ファイルを上限＋1バイトまで読む1行（普通のファイルでなければ終了コード 3） */
export function remoteReadCommand(root: string, rel: string, limit: number): string {
  const file = checkRel(rel)
  if (!file) throw new Error('invalid remote path')
  const quoted = shellQuote(file)
  return `${cdRoot(root)} && { test -f ${quoted} || exit 3; } && head -c ${Math.max(0, Math.floor(limit)) + 1} -- ${quoted}`
}

/** glob の特別な文字を打ち消す（find -iname に渡す） */
function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]]/g, (c) => `\\${c}`)
}

/** ファイル名で絞り込む1行（.git・node_modules の中は見ない。上限＋1件まで） */
export function remoteSearchCommand(root: string, query: string): string {
  const q = query.replace(/[\0\r\n/]/g, '').slice(0, 200)
  return `${cdRoot(root)} && find . \\( -name .git -o -name node_modules \\) -prune -o -type f -iname ${shellQuote(`*${escapeGlob(q)}*`)} -print 2>/dev/null | head -n ${MAX_REMOTE_SEARCH + 1}`
}

/** find の出力を相対パスの一覧にする */
export function parseRemoteSearch(stdout: string): { files: string[]; truncated: boolean } {
  const files = stdout.split('\n').filter((line) => line.startsWith('./') && line.length > 2).map((line) => line.slice(2))
  return { files: files.slice(0, MAX_REMOTE_SEARCH), truncated: files.length > MAX_REMOTE_SEARCH }
}

/** 「新しいプロジェクト」の場所選びの一覧（フォルダだけ。. で始まるものは出さない） */
export interface FolderListing {
  /** いまの場所（絶対パス） */
  path: string
  /** 上のフォルダ。いちばん上なら null */
  parent: string | null
  /** 中のフォルダの名前（自然順） */
  folders: string[]
}

/** リモートの場所の一覧を出す1行。path が null ならホーム。1行目に絶対パス、そのあとに中身 */
export function remoteBrowseCommand(path: string | null): string {
  if (path !== null && !isAbsoluteRemote(path)) throw new Error('invalid remote path')
  const target = path === null ? '"$HOME"' : remotePathExpr(path)
  return `cd ${target} && pwd && LC_ALL=C ls -1pL`
}

function isAbsoluteRemote(path: string): boolean {
  return (path.startsWith('/') || path === '~' || path.startsWith('~/')) && !/[\0\r\n]/.test(path) && path.length <= 4096
}

/** POSIX のパスの親（/ なら null） */
export function posixParent(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return null
  const slash = trimmed.lastIndexOf('/')
  return slash <= 0 ? '/' : trimmed.slice(0, slash)
}

/** remoteBrowseCommand の出力を読む */
export function parseRemoteBrowse(stdout: string): FolderListing | null {
  const lines = stdout.split('\n')
  const path = lines[0]?.trim() ?? ''
  if (!path.startsWith('/')) return null
  const folders = lines.slice(1)
    .filter((line) => line.endsWith('/') && line.length > 1)
    .map((line) => line.slice(0, -1))
    .filter((name) => !name.startsWith('.') && !name.includes('/'))
    .sort((a, b) => NAME_ORDER.compare(a, b))
  return { path, parent: posixParent(path), folders }
}

/** 新しく作るフォルダの名前として受け付けるか（区切りや制御文字・. と .. を除く） */
export function isValidNewFolderName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= 255 && trimmed !== '.' && trimmed !== '..' && !/[/\\\0-\x1f\x7f]/.test(trimmed)
}

/** リモートにフォルダを作る終了コード（既にある） */
export const REMOTE_EXISTS_EXIT = 17

/** 親（絶対パス）の下にフォルダを作り、作ったフォルダの絶対パスを出す1行。既にあれば終了コード 17 */
export function remoteMkdirCommand(parent: string, name: string): string {
  if (!parent.startsWith('/') || /[\0\r\n]/.test(parent)) throw new Error('invalid remote path')
  if (!isValidNewFolderName(name)) throw new Error('invalid folder name')
  const quoted = shellQuote(name.trim())
  return `cd -- ${shellQuote(parent)} && { test -e ${quoted} && exit ${REMOTE_EXISTS_EXIT}; mkdir -- ${quoted}; } && cd -- ${quoted} && pwd`
}

/** リモートにファイル・フォルダを作る終了コード（途中にファイルがあってフォルダを作れない） */
export const REMOTE_NOT_FOLDER_EXIT = 20
/** リモートにファイル・フォルダを作る終了コード（親フォルダが無い） */
export const REMOTE_NO_PARENT_EXIT = 21

/**
 * SSH のプロジェクトで、parentRel のフォルダに空のファイルか空のフォルダを作る1行（ファイルツリーの「新しいファイル」「新しいフォルダ」）。
 * 名前に「a/b/c.ts」のように / を含めれば、途中の無いフォルダも作る（ローカルの createEntry と同じ）。
 * 最後のものが既にあれば終了コード 17（上書きしない。ファイルは set -C の > で作るので、あいだに作られても上書きしない）。
 * 新しく作った途中のフォルダのうち、いちばん上の番号（0 から）を `top <番号>` として出す（元に戻す用。無ければ出さない）
 */
export function remoteCreateCommand(root: string, parentRel: string, name: string, kind: FsEntry['kind']): string {
  const parent = checkRel(parentRel)
  if (kind !== 'file' && kind !== 'directory') throw new Error('invalid kind')
  if (nestedNameProblem(name)) throw new Error('invalid name')
  const parts = nestedNameParts(name)
  if (isInsideGitDir(parent ? `${parent}/${name}` : name)) throw new Error('invalid name')
  const steps = ['ferret_top=', cdRoot(root), `{ cd -- ${shellQuote(parent || '.')} || exit ${REMOTE_NO_PARENT_EXIT}; }`]
  parts.slice(0, -1).forEach((part, index) => {
    const q = shellQuote(part)
    steps.push(`{ if [ -e ${q} ]; then [ -d ${q} ] || exit ${REMOTE_NOT_FOLDER_EXIT}; else mkdir -- ${q} || exit 1; [ -n "$ferret_top" ] || { ferret_top=1; echo 'top ${index}'; }; fi; }`, `cd -- ${q}`)
  })
  const last = shellQuote(parts.at(-1)!)
  steps.push(`{ if [ -e ${last} ] || [ -L ${last} ]; then exit ${REMOTE_EXISTS_EXIT}; fi; }`)
  steps.push(kind === 'file' ? `( set -C; : > ${last} ) 2>/dev/null || { [ -e ${last} ] && exit ${REMOTE_EXISTS_EXIT}; exit 1; }` : `mkdir -- ${last}`)
  return steps.join(' && ')
}

/** remoteCreateCommand の出力から、作ったものと新しくできたいちばん上の相対パス */
export function remoteCreated(stdout: string, parentRel: string, name: string): { path: string; top: string } {
  const parts = nestedNameParts(name)
  const join = (count: number) => [parentRel, ...parts.slice(0, count)].filter(Boolean).join('/')
  const match = /^top (\d+)$/m.exec(stdout)
  const topIndex = match ? Number(match[1]) : -1
  return { path: join(parts.length), top: topIndex >= 0 && topIndex < parts.length ? join(topIndex + 1) : join(parts.length) }
}

/** リモートのファイルへ書く終了コード（フォルダ・普通のファイルでないものには書かない／届いた大きさが違う） */
export const REMOTE_WRITE_FOLDER_EXIT = 4
export const REMOTE_WRITE_NOT_REGULAR_EXIT = 3
export const REMOTE_WRITE_SHORT_EXIT = 22

/**
 * SSH のプロジェクトのファイルへ、標準入力で受けた内容を書く1行（エディタの保存）。
 * 回線が途中で切れても元のファイルを壊さないよう、同じフォルダの一時ファイルへ受けて大きさ（bytes）を確かめてから、
 * 元のファイルへ上書きする（rename で置き換えないので、リンク・権限・持ち主はそのまま。ローカルの writeTextFile と同じ）。
 * 無ければ新しく作る
 */
export function remoteWriteCommand(root: string, rel: string, bytes: number): string {
  const file = checkRel(rel)
  if (!file) throw new Error('invalid remote path')
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid size')
  const q = shellQuote(file)
  const slash = file.lastIndexOf('/')
  const dir = shellQuote(slash < 0 ? '.' : file.slice(0, slash))
  return [
    cdRoot(root),
    `{ [ -d ${q} ] && exit ${REMOTE_WRITE_FOLDER_EXIT}; [ -e ${q} ] && [ ! -f ${q} ] && exit ${REMOTE_WRITE_NOT_REGULAR_EXIT}; :; }`,
    `ferret_tmp=$(mktemp ${dir}/.ferret-save.XXXXXX)`,
    `{ cat > "$ferret_tmp" && [ "$(wc -c < "$ferret_tmp" | tr -d ' ')" = '${bytes}' ] || { rm -f -- "$ferret_tmp"; exit ${REMOTE_WRITE_SHORT_EXIT}; }; }`,
    `{ cat -- "$ferret_tmp" > ${q}; ferret_rc=$?; rm -f -- "$ferret_tmp"; exit $ferret_rc; }`
  ].join(' && ')
}
