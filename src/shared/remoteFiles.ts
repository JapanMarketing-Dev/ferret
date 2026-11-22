import { entryNameProblem, isCollapsedByDefault, isInsideGitDir, MAX_COPY_BYTES, MAX_COPY_ENTRIES, nestedNameParts, nestedNameProblem, type FsEntry } from './files'
import { remotePathExpr, shellQuote } from './sshCommand'

/**
 * SSH のプロジェクトのファイルツリーと、「新しいプロジェクト」の場所選びで、リモートで動かす1行の組み立てと出力の読み取り
 * （純粋な関数。注入対策の単体テストの対象）。ssh を動かすのは src/main/remoteFiles.ts。
 *
 * - リモートのパスや名前は、必ず POSIX の単一引用符で囲んでリモートのシェルに渡す
 * - 相対パスは / で始まらず、.. を含まないものだけ（プロジェクトのフォルダの外を読ませない）
 * - 一覧は `ls -1ApL`（1行1つ・. と .. を除く・フォルダの末尾に /・リンクは先をたどる）。改行を含む名前は扱わない
 * - 削除（ゴミ箱へ）・名前の変更・移動・コピーは、決まった script を /bin/sh に渡し、パスは位置引数と標準入力で渡す（下の shScript）
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

// ── 削除（リモートのゴミ箱へ）・名前の変更・移動・コピー ──

/** リモートのファイルの操作の終了コード（無い・プロジェクトの外を指すリンク・.git の中・フォルダをそれ自身の中へ・ゴミ箱へ移せない・コピーの上限） */
export const REMOTE_NOT_FOUND_EXIT = 23
export const REMOTE_OUTSIDE_EXIT = 24
export const REMOTE_GIT_EXIT = 25
export const REMOTE_INTO_ITSELF_EXIT = 26
export const REMOTE_TRASH_FAILED_EXIT = 27
export const REMOTE_COPY_TOO_MANY_EXIT = 28
export const REMOTE_COPY_TOO_LARGE_EXIT = 29
/** ゴミ箱と別のディスク（ファイルシステム）にあるので移さない（ホームへのコピーになり、遅く・ホームを埋めるため） */
export const REMOTE_TRASH_OTHER_DISK_EXIT = 30
/** 変える権限が無い（元・先のフォルダに書けない） */
export const REMOTE_PERMISSION_EXIT = 31

/**
 * 何行にもなる処理は、POSIX の /bin/sh に決まった script を渡して動かす。
 * リモートのログインシェルが読むコマンド行は、値を一切含まない決まった1行（`/bin/sh -c '<script>' ferret`）だけにし、
 * プロジェクトのフォルダ・移動先・名前・選んだものの一覧は、すべて標準入力で1行に1つずつ渡す（remoteInputText）。
 * fish は単一引用符の中でも \' と \\ を読むので、値をコマンド行に載せると引用が崩れる。script にも \' と \\ を書かない（ここで確かめる）
 */
function shScript(lines: readonly string[]): string {
  const script = lines.join('\n')
  if (/\\[\\']|\\$/.test(script)) throw new Error('remote script must not contain a backslash before a quote or another backslash')
  return `/bin/sh -c ${shellQuote(script)} ferret`
}

/** 標準入力で渡す値（1行に1つ）。NUL・CR・LF を含む値は渡さない（行がずれて別の値に化けるため） */
export function remoteInputText(values: readonly string[]): string {
  for (const value of values) {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('invalid remote value')
  }
  return values.map((value) => `${value}\n`).join('')
}

/** プロジェクトのフォルダ（SshTarget.path）として受け付けるか。/ か ~ で始まる */
function checkRoot(root: string): string {
  if (typeof root !== 'string' || !(root.startsWith('/') || root === '~' || root.startsWith('~/')) || /[\0\r\n]/.test(root) || root.length > 4096) throw new Error('invalid remote path')
  return root
}

/** 変える対象として受け付ける相対パス（プロジェクトのフォルダそのもの・.git の中は断る） */
function checkTarget(rel: string): string {
  const target = checkRel(rel)
  if (!target || isInsideGitDir(target)) throw new Error('invalid remote path')
  return target
}

/** 移動・コピーの先として受け付けるか（プロジェクトからの相対パス。根は .。.git の中は断る） */
function checkDestination(destRel: string): string {
  const dest = checkRel(destRel)
  if (isInsideGitDir(dest)) throw new Error('invalid remote path')
  return dest || '.'
}

/**
 * どの処理にも付ける前置き。標準入力の1行目（プロジェクトのフォルダ。~ はリモートの $HOME）へ移り、その実体のパスを基準にする。
 *   ferret_at <相対パス>     … 親フォルダの実体のパス（ferret_dir）と名前（ferret_name）。親へ移れなければ「無い」
 *   ferret_where <実体のパス> … プロジェクトの中で、どの深さの .git の中でもなければ 0（外を指すリンクの先・.git の中は断る）
 *   ferret_check <相対パス>   … 上の2つと、そのものがある（切れたリンクも含む）ことを確かめる
 *   ferret_say <種類> <番号> [名前] … 結果の1行（echo は \ を読み替えるので printf で出す）
 * CDPATH があると cd が移った先を出し、$(cd … && pwd -P) が2行になるので外す
 */
const PRELUDE: readonly string[] = [
  'unset CDPATH',
  `IFS= read -r ferret_arg || exit ${REMOTE_NO_PARENT_EXIT}`,
  'case $ferret_arg in "~") ferret_root=$HOME ;; "~/"*) ferret_root=$HOME/${ferret_arg#??} ;; *) ferret_root=$ferret_arg ;; esac',
  `cd -- "$ferret_root" 2>/dev/null && ferret_root=$(pwd -P) || exit ${REMOTE_NO_PARENT_EXIT}`,
  'if [ "$ferret_root" = / ]; then ferret_base=; else ferret_base=$ferret_root; fi',
  `ferret_at() { case $1 in */*) ferret_name=\${1##*/}; ferret_dir=$(cd -- "\${1%/*}" 2>/dev/null && pwd -P) || return ${REMOTE_NOT_FOUND_EXIT} ;; *) ferret_name=$1; ferret_dir=$ferret_root ;; esac; }`,
  `ferret_where() { case $1/ in "$ferret_base"/.git/*|"$ferret_base"/*/.git/*) return ${REMOTE_GIT_EXIT} ;; "$ferret_base"/*) return 0 ;; esac; return ${REMOTE_OUTSIDE_EXIT}; }`,
  `ferret_check() { ferret_at "$1" || return $?; ferret_where "$ferret_dir" || return $?; [ -e "$ferret_dir/$ferret_name" ] || [ -L "$ferret_dir/$ferret_name" ] || return ${REMOTE_NOT_FOUND_EXIT}; }`,
  `ferret_say() { if [ "$#" -gt 2 ]; then printf '%s %s %s\\n' "$1" "$2" "$3"; else printf '%s %s\\n' "$1" "$2"; fi; }`,
  // ferret_fail <番号> <終了コード>: どれで止まったかを出して終わる
  'ferret_fail() { ferret_say bad "$1"; exit "$2"; }'
]

/** 標準入力の残り（選んだものの相対パス。1行に1つ）を位置引数にする。空なら終わる */
const READ_LIST: readonly string[] = [
  'while IFS= read -r ferret_line || [ -n "$ferret_line" ]; do set -- "$@" "$ferret_line"; done',
  '[ "$#" -gt 0 ] || exit 1'
]

/** 移動・コピーの先（標準入力の2行目。根は .）の実体のパス（ferret_dest）。フォルダでない・書けないなら断る */
const DESTINATION: readonly string[] = [
  `IFS= read -r ferret_arg || exit ${REMOTE_NOT_FOUND_EXIT}`,
  `ferret_dest=$(cd -- "$ferret_arg" 2>/dev/null && pwd -P) || { [ -e "$ferret_arg" ] && exit ${REMOTE_NOT_FOLDER_EXIT}; exit ${REMOTE_NOT_FOUND_EXIT}; }`,
  'ferret_where "$ferret_dest" || exit $?',
  `[ -w "$ferret_dest" ] || exit ${REMOTE_PERMISSION_EXIT}`,
  // ferret_into <パス>: フォルダ（リンクではない）なら、先がその中（それ自身を含む）のとき 1
  'ferret_into() { [ -d "$1" ] && [ ! -L "$1" ] || return 0; ferret_src=$(cd -- "$1" 2>/dev/null && pwd -P) || return 0; case $ferret_dest/ in "$ferret_src"/*) return 1 ;; esac; return 0; }',
  // ferret_movable <パス>: 元のフォルダに書ける。フォルダを別の親へ動かすなら、そのフォルダ自身にも書ける（.. を書き換えるため）
  'ferret_movable() { [ -w "$ferret_dir" ] || return 1; [ -d "$1" ] && [ ! -L "$1" ] && [ "$ferret_dir" != "$ferret_dest" ] && { [ -w "$1" ] || return 1; }; return 0; }'
]

/** 一覧の i 番目（1 から）を確かめる。断るなら `bad <i>` を出して終わる */
const CHECK_ITEM = 'ferret_check "$ferret_rel" || ferret_fail "$ferret_i" "$?"'

/**
 * 1文字ずつ URL の形に直す awk（ゴミ箱の .trashinfo の Path。freedesktop.org の Trash の決まりで RFC 2396 の形）。
 * od -tx1 の16進を読み、英数字と - . / _ ~ はそのまま、ほかは %XX にする（日本語の名前もバイトごとに直す）
 */
const URL_ENCODE_AWK = 'BEGIN { h = "0123456789abcdef" } { for (i = 1; i <= NF; i++) { v = (index(h, substr($i, 1, 1)) - 1) * 16 + index(h, substr($i, 2, 1)) - 1; '
  + 'if ((v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 45 || v == 46 || v == 47 || v == 95 || v == 126) printf "%c", v; else printf "%%%s", toupper($i) } }'

/** ゴミ箱に入れるときに、同じ名前があれば別の名前（名前.2・名前.3 …）を探す回数の上限 */
const MAX_TRASH_NAME_TRIES = 1000
/** ゴミ箱の中の名前の長さの上限（バイト。info/<名前>.trashinfo がファイル名の上限 255 を超えないように。長い名前は ferret-trash.N にし、元の名前は Path に残す） */
const MAX_TRASH_NAME_BYTES = 200

/**
 * SSH のプロジェクトで、選んだもの（相対パス）をリモートのゴミ箱へ移す1行（ファイルツリーの削除）。標準入力は remoteTrashInput。
 * ゴミ箱は freedesktop.org の Trash の決まり（$XDG_DATA_HOME/Trash、無ければ ~/.local/share/Trash）。
 * Ubuntu などのデスクトップのゴミ箱から、元の場所へ戻せる（info/<名前>.trashinfo に元のパスと日時を書き、files/<名前> へ移す）。
 * 先に全部を確かめ、1つでも断るもの（無い・外・.git の中・権限が無い・ゴミ箱と別のディスク）があれば何も移さない。
 * 移せたものは `ok <番号>`、断ったもの・失敗したものは `bad <番号>` を出す
 */
export function remoteTrashCommand(): string {
  return shScript([
    ...PRELUDE,
    ...READ_LIST,
    'ferret_trash=${XDG_DATA_HOME:-}',
    'case $ferret_trash in /*) ;; *) ferret_trash=$HOME/.local/share ;; esac',
    'ferret_trash=$ferret_trash/Trash',
    `( umask 077; mkdir -p -- "$ferret_trash/files" "$ferret_trash/info" ) 2>/dev/null || ferret_fail 1 ${REMOTE_TRASH_FAILED_EXIT}`,
    // ディスクの見分け（df -P の装置とマウント先）。違えば mv がホームへのコピーになるので移さない
    `ferret_disk() { df -P "$1" 2>/dev/null | awk 'NR == 2 { print $1 " " $NF }'; }`,
    'ferret_trash_disk=$(ferret_disk "$ferret_trash/files")',
    'ferret_i=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    `  [ -w "$ferret_dir" ] || ferret_fail "$ferret_i" ${REMOTE_PERMISSION_EXIT}`,
    `  if [ -d "$ferret_dir/$ferret_name" ] && [ ! -L "$ferret_dir/$ferret_name" ] && [ ! -w "$ferret_dir/$ferret_name" ]; then ferret_fail "$ferret_i" ${REMOTE_PERMISSION_EXIT}; fi`,
    `  [ -z "$ferret_trash_disk" ] || [ "$(ferret_disk "$ferret_dir")" = "$ferret_trash_disk" ] || ferret_fail "$ferret_i" ${REMOTE_TRASH_OTHER_DISK_EXIT}`,
    'done',
    'ferret_date=$(date +%Y-%m-%dT%H:%M:%S)',
    `ferret_url() { printf '%s' "$1" | LC_ALL=C od -An -v -tx1 | LC_ALL=C awk '${URL_ENCODE_AWK}'; }`,
    'ferret_i=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    '  ferret_path=$ferret_dir/$ferret_name',
    '  ferret_uri=$(ferret_url "$ferret_path")',
    `  ferret_base_name=$ferret_name; [ "$(printf '%s' "$ferret_name" | wc -c)" -le ${MAX_TRASH_NAME_BYTES} ] || ferret_base_name=ferret-trash`,
    '  ferret_info=; ferret_t=$ferret_base_name; ferret_k=1',
    // 同じ名前が無い番号を探し、.trashinfo を noclobber（O_EXCL）で作って名前を押さえてから移す（決まりの順）。切れたリンクも「ある」とみなす
    `  while [ "$ferret_k" -le ${MAX_TRASH_NAME_TRIES} ]; do`,
    '    ferret_try=$ferret_trash/info/$ferret_t.trashinfo',
    '    if [ ! -e "$ferret_try" ] && [ ! -L "$ferret_try" ] && [ ! -e "$ferret_trash/files/$ferret_t" ] && [ ! -L "$ferret_trash/files/$ferret_t" ]; then',
    `      if ( set -C; printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' "$ferret_uri" "$ferret_date" > "$ferret_try" ) 2>/dev/null; then ferret_info=$ferret_try; break; fi`,
    '      [ -e "$ferret_try" ] || [ -L "$ferret_try" ] || break',
    '    fi',
    '    ferret_k=$((ferret_k + 1)); ferret_t=$ferret_base_name.$ferret_k',
    '  done',
    `  [ -n "$ferret_info" ] || ferret_fail "$ferret_i" ${REMOTE_TRASH_FAILED_EXIT}`,
    // 上書きしない（-n）。動かなかった（元が残る）なら .trashinfo を消して断る
    '  mv -n -- "$ferret_path" "$ferret_trash/files/$ferret_t" 2>/dev/null',
    // 移せたかは files/<名前> で見る（名前は .trashinfo で押さえてある。元の場所にすぐ作り直されても、移せたものを失敗にしない）
    `  if [ ! -e "$ferret_trash/files/$ferret_t" ] && [ ! -L "$ferret_trash/files/$ferret_t" ]; then rm -f -- "$ferret_info"; ferret_fail "$ferret_i" ${REMOTE_TRASH_FAILED_EXIT}; fi`,
    '  ferret_say ok "$ferret_i"',
    'done'
  ])
}

/** remoteTrashCommand の標準入力（プロジェクトのフォルダ・選んだものの相対パス） */
export function remoteTrashInput(root: string, rels: readonly string[]): string {
  return remoteInputText([checkRoot(root), ...rels.map(checkTarget)])
}

/**
 * SSH のプロジェクトで、名前を同じフォルダの中で変える1行。標準入力は remoteRenameInput。既にある名前には上書きしない（終了コード 17）。
 * 大文字小文字だけの変更は、そのフォルダに新しい綴りちょうどの項目が無い（大文字小文字を区別しないファイルシステムで同じものが見えている）ときだけ通す
 * （リンクはたどらずに名前で比べる）。そのときは同じフォルダの一時的な名前を経由する（mv Foo foo がフォルダ foo の中へ動かそうとするため）
 */
export function remoteRenameCommand(): string {
  return shScript([
    ...PRELUDE,
    'IFS= read -r ferret_rel && IFS= read -r ferret_new && IFS= read -r ferret_case || exit 1',
    'ferret_check "$ferret_rel" || exit $?',
    `[ -w "$ferret_dir" ] || exit ${REMOTE_PERMISSION_EXIT}`,
    'ferret_from=$ferret_dir/$ferret_name; ferret_to=$ferret_dir/$ferret_new',
    'if [ -e "$ferret_to" ] || [ -L "$ferret_to" ]; then',
    `  [ "$ferret_case" = 1 ] || exit ${REMOTE_EXISTS_EXIT}`,
    `  if ( cd -- "$ferret_dir" && ls -1a ) | grep -Fxq -- "$ferret_new"; then exit ${REMOTE_EXISTS_EXIT}; fi`,
    '  ferret_tmp=$ferret_dir/.ferret-rename-$$',
    '  if [ -e "$ferret_tmp" ] || [ -L "$ferret_tmp" ]; then exit 1; fi',
    '  mv -n -- "$ferret_from" "$ferret_tmp" 2>/dev/null || exit 1',
    '  if [ -e "$ferret_from" ] || [ -L "$ferret_from" ]; then exit 1; fi',
    '  mv -n -- "$ferret_tmp" "$ferret_to" 2>/dev/null',
    '  if [ -e "$ferret_tmp" ] || [ -L "$ferret_tmp" ]; then mv -n -- "$ferret_tmp" "$ferret_from" 2>/dev/null; exit 1; fi',
    '  exit 0',
    'fi',
    'mv -n -- "$ferret_from" "$ferret_to" 2>/dev/null || exit 1',
    // -n で動かなかった（確かめてから動かすまでに同じ名前ができた）
    `if [ -e "$ferret_from" ] || [ -L "$ferret_from" ]; then exit ${REMOTE_EXISTS_EXIT}; fi`
  ])
}

/** remoteRenameCommand の標準入力。caseOnly は大文字小文字だけの変更 */
export function remoteRenameInput(root: string, rel: string, newName: string, caseOnly: boolean): string {
  if (entryNameProblem(newName)) throw new Error('invalid name')
  return remoteInputText([checkRoot(root), checkTarget(rel), newName, caseOnly ? '1' : '0'])
}

/**
 * SSH のプロジェクトで、選んだもの（相対パス）を移動先のフォルダへ動かす1行（切り取り・貼り付け、ドラッグ）。標準入力は remoteMoveInput。名前は変えない。
 * 先に全部を確かめ、先に同じ名前がある・フォルダをそれ自身の中へ動かす・権限が無いなら何も動かさない。上書きはしない（-n）。
 * 動かしたものは `ok <番号>`、もともとそのフォルダにあったものは `same <番号>`、断ったもの・失敗したものは `bad <番号>` を出す
 */
export function remoteMoveCommand(): string {
  const occupied = `if [ -e "$ferret_dest/$ferret_name" ] || [ -L "$ferret_dest/$ferret_name" ]; then ferret_fail "$ferret_i" ${REMOTE_EXISTS_EXIT}; fi`
  return shScript([
    ...PRELUDE,
    ...DESTINATION,
    ...READ_LIST,
    'ferret_i=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    '  [ "$ferret_dir" = "$ferret_dest" ] && continue',
    `  ferret_into "$ferret_dir/$ferret_name" || ferret_fail "$ferret_i" ${REMOTE_INTO_ITSELF_EXIT}`,
    `  ferret_movable "$ferret_dir/$ferret_name" || ferret_fail "$ferret_i" ${REMOTE_PERMISSION_EXIT}`,
    `  ${occupied}`,
    'done',
    'ferret_i=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    '  if [ "$ferret_dir" = "$ferret_dest" ]; then ferret_say same "$ferret_i"; continue; fi',
    `  ${occupied}`,
    '  mv -n -- "$ferret_dir/$ferret_name" "$ferret_dest/$ferret_name" 2>/dev/null || ferret_fail "$ferret_i" 1',
    `  if [ -e "$ferret_dir/$ferret_name" ] || [ -L "$ferret_dir/$ferret_name" ]; then ferret_fail "$ferret_i" ${REMOTE_EXISTS_EXIT}; fi`,
    '  ferret_say ok "$ferret_i"',
    'done'
  ])
}

/** remoteMoveCommand の標準入力（プロジェクトのフォルダ・移動先・選んだものの相対パス） */
export function remoteMoveInput(root: string, destRel: string, rels: readonly string[]): string {
  return remoteInputText([checkRoot(root), checkDestination(destRel), ...rels.map(checkTarget)])
}

/** コピーで重ならない名前を探す回数の上限 */
const MAX_COPY_NAME_TRIES = 10_000

/**
 * SSH のプロジェクトで、選んだもの（相対パス）を先のフォルダへコピーする1行（貼り付け・複製）。標準入力は remoteCopyInput。
 * 同じ名前があれば「名前 copy」「名前 copy 2」にする（@shared/files の copyName と同じ形。上書きはしない）。
 * 写す先は先に作って押さえ（フォルダは mkdir、ファイルは noclobber）、そこへ中身を写す。失敗したら押さえたものだけを消す。
 * リンクはリンクのまま写し、パイプ・ソケット・デバイスは写さない（`skip <番号>`。ローカルと同じ）。
 * 先に全部を確かめ、フォルダをそれ自身の中へコピーする・数と大きさの上限（ローカルと同じ MAX_COPY_ENTRIES・MAX_COPY_BYTES）を超えるなら何も写さない。
 * 写したものは `ok <番号> <新しい名前>`、断ったもの・失敗したものは `bad <番号>` を出す
 */
export function remoteCopyCommand(): string {
  return shScript([
    ...PRELUDE,
    ...DESTINATION,
    ...READ_LIST,
    // ferret_copyname <名前> <番号> <f か d>: 「a.ts」→「a copy.ts」「a copy 2.ts」。フォルダと、先頭のドットだけの名前は拡張子を分けない
    'ferret_copyname() { ferret_stem=$1; ferret_ext=; if [ "$3" = f ]; then case $1 in ?*.*) ferret_ext=.${1##*.}; ferret_stem=${1%.*} ;; esac; fi; '
      + 'if [ "$2" -gt 1 ]; then ferret_cn="$ferret_stem copy $2$ferret_ext"; else ferret_cn="$ferret_stem copy$ferret_ext"; fi; }',
    'ferret_i=0; ferret_count=0; ferret_kb=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    `  ferret_into "$ferret_dir/$ferret_name" || ferret_fail "$ferret_i" ${REMOTE_INTO_ITSELF_EXIT}`,
    // 数は上限＋1で打ち切る（node_modules などを最後まで歩かない）。大きさは数が収まったときだけ測る
    `  ferret_n=$(find "$ferret_dir/$ferret_name" 2>/dev/null | head -n ${MAX_COPY_ENTRIES + 1} | wc -l); ferret_count=$((ferret_count + \${ferret_n:-0}))`,
    `  [ "$ferret_count" -le ${MAX_COPY_ENTRIES} ] || ferret_fail "$ferret_i" ${REMOTE_COPY_TOO_MANY_EXIT}`,
    `  ferret_n=$(du -sk "$ferret_dir/$ferret_name" 2>/dev/null | awk '{ print $1 }'); ferret_kb=$((ferret_kb + \${ferret_n:-0}))`,
    `  [ "$ferret_kb" -le ${Math.floor(MAX_COPY_BYTES / 1024)} ] || ferret_fail "$ferret_i" ${REMOTE_COPY_TOO_LARGE_EXIT}`,
    'done',
    'ferret_i=0',
    'for ferret_rel in "$@"; do',
    '  ferret_i=$((ferret_i + 1))',
    `  ${CHECK_ITEM}`,
    '  ferret_src=$ferret_dir/$ferret_name',
    '  if [ -L "$ferret_src" ]; then ferret_kind=l; elif [ -d "$ferret_src" ]; then ferret_kind=d; elif [ -f "$ferret_src" ]; then ferret_kind=f; else ferret_say skip "$ferret_i"; continue; fi',
    '  ferret_split=f; [ "$ferret_kind" = d ] && ferret_split=d',
    '  ferret_cn=$ferret_name; ferret_k=0',
    // 空いている名前を探し、フォルダは mkdir・ファイルは noclobber で作って押さえる（確かめてから作るまでに作られても、他人のものに写さない・消さない）
    '  while :; do',
    '    if [ ! -e "$ferret_dest/$ferret_cn" ] && [ ! -L "$ferret_dest/$ferret_cn" ]; then',
    '      case $ferret_kind in',
    '        d) mkdir -- "$ferret_dest/$ferret_cn" 2>/dev/null && break ;;',
    '        f) ( set -C; : > "$ferret_dest/$ferret_cn" ) 2>/dev/null && break ;;',
    '        l) break ;;',
    '      esac',
    '      [ -e "$ferret_dest/$ferret_cn" ] || [ -L "$ferret_dest/$ferret_cn" ] || ferret_fail "$ferret_i" 1',
    '    fi',
    '    ferret_k=$((ferret_k + 1))',
    `    [ "$ferret_k" -le ${MAX_COPY_NAME_TRIES} ] || ferret_fail "$ferret_i" ${REMOTE_EXISTS_EXIT}`,
    '    ferret_copyname "$ferret_name" "$ferret_k" "$ferret_split"',
    '  done',
    '  ferret_to=$ferret_dest/$ferret_cn',
    '  case $ferret_kind in',
    // -p（権限・日時を保つ）を受け付けない FS（vfat など）では、つけずに写し直す
    '    d) { cp -RPp -- "$ferret_src/." "$ferret_to" 2>/dev/null || cp -RP -- "$ferret_src/." "$ferret_to" 2>/dev/null; } || { rm -rf -- "$ferret_to"; ferret_fail "$ferret_i" 1; } ;;',
    '    f) { cp -Pp -- "$ferret_src" "$ferret_to" 2>/dev/null || cp -P -- "$ferret_src" "$ferret_to" 2>/dev/null; } || { rm -f -- "$ferret_to"; ferret_fail "$ferret_i" 1; } ;;',
    // リンクは1回の symlink で作るので、失敗したら作ったものは無い（同じ名前のほかのものを消さない）
    '    l) cp -RP -- "$ferret_src" "$ferret_to" 2>/dev/null || ferret_fail "$ferret_i" 1 ;;',
    '  esac',
    '  ferret_say ok "$ferret_i" "$ferret_cn"',
    'done'
  ])
}

/** remoteCopyCommand の標準入力（プロジェクトのフォルダ・コピー先・選んだものの相対パス） */
export function remoteCopyInput(root: string, destRel: string, rels: readonly string[]): string {
  return remoteInputText([checkRoot(root), checkDestination(destRel), ...rels.map(checkTarget)])
}

/** 削除・移動・コピーの script の出力。ok は番号（1 から）→ 新しい名前（コピーだけ。ほかは ''）、same はもともと先にあったもの、skip は写さなかったもの、bad は断った・失敗したもの */
export interface RemoteReport {
  ok: Map<number, string>
  same: Set<number>
  skip: Set<number>
  bad: number | null
}

/** script の出力を読む（ログインシェルの設定が出した行など、知らない行は無視する） */
export function parseRemoteReport(stdout: string): RemoteReport {
  const report: RemoteReport = { ok: new Map(), same: new Set(), skip: new Set(), bad: null }
  for (const line of stdout.split('\n')) {
    const ok = /^ok (\d+)(?: (.+))?$/.exec(line)
    if (ok) { report.ok.set(Number(ok[1]), ok[2] ?? ''); continue }
    const mark = /^(same|skip|bad) (\d+)$/.exec(line)
    if (!mark) continue
    if (mark[1] === 'same') report.same.add(Number(mark[2]))
    else if (mark[1] === 'skip') report.skip.add(Number(mark[2]))
    else report.bad = Number(mark[2])
  }
  return report
}

/**
 * コピーの出力の名前が、元の名前か「名前 copy」「名前 copy N」（copyName の形）か。違えば読み違い（壊れた出力）とみなし、
 * 元に戻すの履歴に積まない（⌘Z で関係ないものを消さないように）
 */
export function isCopyNameOf(name: string, original: string): boolean {
  if (name === original) return true
  if (!name || name.includes('/') || /[\0\r\n]/.test(name)) return false
  return (['file', 'directory'] as const).some((kind) => {
    // copyName と同じ分け方（ファイルだけ、最後のドットから拡張子。先頭のドットだけなら分けない）
    const dot = kind === 'file' ? original.lastIndexOf('.') : -1
    const [stem, ext] = dot > 0 ? [original.slice(0, dot), original.slice(dot)] : [original, '']
    const head = `${stem} copy`
    if (name.length < head.length + ext.length || !name.startsWith(head) || !name.endsWith(ext)) return false
    const middle = name.slice(head.length, name.length - ext.length)
    // 「stem copy ext」か「stem copy N ext」（N は 2 以上）
    return middle === '' || (/^ [1-9]\d*$/.test(middle) && Number(middle.slice(1)) > 1)
  })
}

/** 末尾の / を落とす（正規表現を使わない。/ だけなら /） */
export function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}
