/**
 * SSH で開くプロジェクトのコマンドの組み立て（純粋な関数。注入対策の単体テストの対象）。
 *
 * ターミナルと Agent のタブは `ssh -t -- <host> 'cd <path> && exec "$SHELL" -l'` でリモートで動かす。
 *   - ssh はシェルを通さずに spawn するので、手元のシェルは何も解釈しない
 *   - 後ろの1語はリモートのシェルが解釈する。パスは POSIX の単一引用符で必ず囲み、注入を防ぐ
 *   - host は `-` で始まるもの（ssh のオプションに化ける）や空白・引用符・制御文字を含むものを受け付けない。
 *     `--` で ssh のオプションの終わりも明示する
 * 鍵やパスワードは Ferret では扱わない（~/.ssh/config と ssh-agent に任せる）。
 */

export interface SshTarget {
  /** ~/.ssh/config の Host、または user@host（host:port は使わず、ポートは ssh の設定に書く） */
  host: string
  /** リモートのフォルダ。絶対パスか ~ で始まるパス */
  path: string
}

/** POSIX シェルの単一引用符で囲む。中の ' は '\'' にする */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** host として受け付けるか。英数字と . _ - @ : % [ ] だけで、- で始まらない */
export function isValidSshHost(host: string): boolean {
  return /^[A-Za-z0-9._@:%[\]][A-Za-z0-9._@:%[\]-]*$/.test(host) && !host.startsWith('-') && host.length <= 255
}

/** リモートのパスとして受け付けるか。/ か ~ で始まり、改行や NUL を含まない */
function isValidRemotePath(path: string): boolean {
  return (path.startsWith('/') || path === '~' || path.startsWith('~/')) && !/[\0\r\n]/.test(path) && path.length <= 4096
}

/**
 * リモートのシェルに渡すパスの式。~ はリモートの $HOME に置き換え（引用符の中では ~ が展開されないため）、
 * 残りは単一引用符で囲む。
 */
function remotePathExpression(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${shellQuote(path.slice(2))}`
  return shellQuote(path)
}

/** リモートのパスの式（~ を $HOME に置き換え、残りを引用する）。ほかのリモートのコマンドの組み立てにも使う */
export function remotePathExpr(path: string): string {
  return remotePathExpression(path)
}

/**
 * リモートで実行する1行。
 *   - tmux を渡さないとき: cd してからログインシェルに置き換わる
 *   - tmux を渡したとき: リモートに tmux があれば、その名前のセッションにつなぐ（無ければ作る）。
 *     Ferret や PC を閉じても、回線が切れても、リモートのシェルと Agent は tmux の中で動き続ける。
 *     tmux が無ければ notice を1行出して、今まで通りログインシェルで動かす
 */
export function remoteShellCommand(path: string, tmux?: { session: string; notice: string }): string {
  const cd = `cd ${remotePathExpression(path)}`
  if (!tmux) return `${cd} && exec "$SHELL" -l`
  const session = checkTmuxSessionName(tmux.session)
  return `${cd} && if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${shellQuote(session)}; ` +
    `else printf '%s\\r\\n' ${shellQuote(tmux.notice.replace(/[\0-\x1f\x7f]/g, ' '))}; exec "$SHELL" -l; fi`
}

/** tmux のセッション名として受け付けるか（英数字と _ - だけ。tmux は . と : を名前に使えない） */
export function isValidTmuxSessionName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(name)
}

function checkTmuxSessionName(name: string): string {
  if (!isValidTmuxSessionName(name)) throw new Error('invalid tmux session name')
  return name
}

/**
 * タブの tmux セッション名。ferret-<リモートのフォルダ名>-<接続先とフォルダのハッシュ>-<タブの印>。
 * タブの印（token）はタブを開いたときに決め、タブを戻すときに同じものを渡す（同じセッションにつなぎ直す）
 */
export function tmuxSessionName(target: SshTarget, token: string): string {
  const base = (target.path.split('/').filter((s) => s && s !== '~').pop() ?? 'home').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'home'
  const safeToken = token.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 32) || 'tab'
  return `ferret-${base}-${fnv1a(`${target.host}\n${target.path}`)}-${safeToken}`
}

/** tmux のセッションがあるかを確かめる1行（終了コード 0 ならある） */
export function tmuxHasSessionCommand(session: string): string {
  return `tmux has-session -t ${shellQuote(`=${checkTmuxSessionName(session)}`)}`
}

/** tmux のセッションを終わらせる1行（タブを Ferret で閉じたとき） */
export function tmuxKillSessionCommand(session: string): string {
  return `tmux kill-session -t ${shellQuote(`=${checkTmuxSessionName(session)}`)}`
}

type SshTargetCheck = { ok: true; target: SshTarget } | { ok: false; reason: 'host' | 'path' }

/** 入力を整えて確かめる（前後の空白は落とす。末尾の / は1つにまとめない＝そのまま渡す） */
export function checkSshTarget(input: { host: string; path: string }): SshTargetCheck {
  const host = input.host.trim()
  const path = input.path.trim()
  if (!isValidSshHost(host)) return { ok: false, reason: 'host' }
  if (!isValidRemotePath(path)) return { ok: false, reason: 'path' }
  return { ok: true, target: { host, path } }
}

/** ターミナルのタブで spawn するもの。確かめていない値は受け付けない。tmux を渡すとそのセッションの中で動かす */
export function sshShellSpec(target: SshTarget, tmux?: { session: string; notice: string }): { file: string; args: string[] } {
  const checked = checkSshTarget(target)
  if (!checked.ok) throw new Error(`invalid ssh target (${checked.reason})`)
  return { file: 'ssh', args: ['-t', '--', checked.target.host, remoteShellCommand(checked.target.path, tmux)] }
}

/** 一覧やタイトルに出す名前 */
export function sshTargetLabel(target: SshTarget): string {
  return `${target.host}:${target.path}`
}

/** 32bit の FNV-1a（16進）。フォルダ名を短く決めるためだけで、暗号用ではない */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * ローカルのレビューの置き場のフォルダ名（設定フォルダの remote/ の下）。host とパスごとに決まり、読める部分も残す。
 * 例: dev-box-app-1a2b3c4d
 */
export function remoteWorkspaceDirName(target: SshTarget): string {
  // 英数字と . _ - だけにし、. や .. のような名前にならないよう前後の . と - を落とす
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  const base = target.path.split('/').filter(Boolean).pop() ?? 'home'
  return [safe(target.host) || 'host', safe(base) || 'home', fnv1a(`${target.host}\n${target.path}`)].join('-')
}

/** 名前を付けなかったときの表示名（リモートのフォルダ名。~ だけなら host） */
export function sshDefaultName(target: SshTarget): string {
  return target.path.split('/').filter((s) => s && s !== '~').pop() ?? target.host
}
