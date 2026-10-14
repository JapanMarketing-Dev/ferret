/**
 * ターミナルで xterm より先に受けるキー（純粋な関数。単体テストの対象）。
 *
 * Orca の terminal-shortcut-policy.ts / keybindings（terminal.copySelection・terminal.paste）と同じ割り当て:
 *   - Shift+Enter: 前面の Agent が「入力の改行」として受けるキー列を送る（agentNewlineData）。xterm は Enter と同じ CR を送るため、
 *     Claude Code などで改行できず送信になる（Orca #2412 #9703 #12541）。シェル（cmd.exe・PowerShell は ESC で行を消す）では今どおり CR。
 *     どの Agent が前面かは terminalClient が押した時点で問い合わせ直して決める（返事が無ければ最後に分かった状態）
 *   - Windows / Linux: Ctrl+Shift+C と「選択があるときの Ctrl+C」でコピー。選択が無い Ctrl+C は今どおり中断（^C）（Orca #5611 #5352）
 *   - Windows / Linux: Ctrl+V・Ctrl+Shift+V・Shift+Insert で貼り付け。xterm は Ctrl+V を ^V として送ってしまう（Orca #560）
 *   - macOS: ⌘← / ⌘→ は行頭・行末（Ctrl+A / Ctrl+E）、⌘⌫ は行頭まで消す（Ctrl+U）。xterm は何も送らない（Orca #5797）
 *   - macOS: ⌥⌦ は次の単語を消す（ESC d）。xterm の既定 ESC[3;3~ はシェルに ~ を入れる（Orca #21491）
 * ⌘C / ⌘V（macOS）はメニューの標準ロールが受けるので、ここでは扱わない。
 * 変換中（IME）のキーは何もしない（確定の Enter などを横取りしない）。
 */

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '@shared/bracketedPaste'
import type { TuiAgent } from '@shared/types'

export interface TerminalKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
}

type TerminalKeyAction = { kind: 'send'; data: string } | { kind: 'copy' } | { kind: 'paste' } | { kind: 'newline' }

interface TerminalKeyContext {
  hasSelection: boolean
}

/**
 * Agent ごとの「入力の改行（送信しない）」のキー列。各 CLI のキー割り当てで確かめたもの:
 *   - LF（Ctrl+J）: ESC を含まないので、ESC が中断・取り消しになる Agent でも誤って止めない。確かめられたものはこちら
 *       claude   https://code.claude.com/docs/en/interactive-mode （Multiline input: Ctrl+J は設定なしで全端末）
 *       codex    openai/codex codex-rs/tui/src/keymap.rs（insert_newline の既定に ctrl-j）
 *       gemini   google-gemini/gemini-cli packages/cli/src/ui/key/keyBindings.ts（NEWLINE に ctrl+j）
 *       antigravity https://antigravity.google/docs/cli/reference （Shift+Enter か Ctrl+J で改行）
 *       qwen     QwenLM/qwen-code packages/cli/src/ui/components/shared/text-buffer.ts（input === '\n' で改行）
 *       cursor   https://cursor.com/docs/cli/reference/terminal-setup （Ctrl+J は全端末で改行）
 *       crush    charmbracelet/crush internal/ui/model/keys.go（Newline に ctrl+j。alt+enter は無い）
 *       kimi     MoonshotAI/kimi-cli src/kimi_cli/ui/shell/prompt.py（c-j で改行）
 *   - ESC+CR（Meta+Enter）: 1回の書き込みで送る（ESC と CR が別々に読まれると Esc になる）
 *       copilot  https://docs.github.com/en/copilot/reference/cli-command-reference （Option/Alt+Enter で改行）
 *       opencode keybind.ts の input_newline に alt+return
 *       aider    aider/io.py（escape, enter で改行。LF は prompt_toolkit が Enter として送信する）
 *       そのほか・利用者が登録した Agent: 確かめた10本のうち crush 以外すべてで改行になる、最も広く効くもの
 */
const LF_NEWLINE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'antigravity', 'qwen-code', 'cursor', 'crush', 'kimi'])

/** Shift+Enter で送るキー列。Agent が前面にいなければ Enter と同じ CR（シェルでは実行） */
export function agentNewlineData(agent: TuiAgent | null): string {
  if (!agent) return '\r'
  return LF_NEWLINE_AGENTS.has(agent) ? '\n' : '\x1b\r'
}

export function terminalKeyAction(event: TerminalKeyEvent, platform: string, context: TerminalKeyContext): TerminalKeyAction | null {
  if (event.isComposing || event.keyCode === 229) return null
  const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  if (key === 'Enter' && shift && !ctrl && !meta && !alt) return { kind: 'newline' }

  if (platform === 'darwin') {
    if (meta && !ctrl && !alt && !shift) {
      if (key === 'ArrowLeft') return { kind: 'send', data: '\x01' }
      if (key === 'ArrowRight') return { kind: 'send', data: '\x05' }
      if (key === 'Backspace') return { kind: 'send', data: '\x15' }
    }
    if (alt && !ctrl && !meta && !shift && key === 'Delete') return { kind: 'send', data: '\x1bd' }
    return null
  }

  if (meta || alt) return null
  if (ctrl && shift && key === 'c') return { kind: 'copy' }
  if (ctrl && !shift && key === 'c' && context.hasSelection) return { kind: 'copy' }
  if (ctrl && key === 'v') return { kind: 'paste' }
  if (!ctrl && shift && key === 'Insert') return { kind: 'paste' }
  return null
}

/**
 * Windows で Agent が前面にいるときの複数行の貼り付け（Orca #5274）。xterm はアプリがブラケットペーストを有効にした
 * （DECSET 2004）ときだけ枠で包むが、Windows の ConPTY はその知らせを xterm まで通さないことがあり、包まれない改行が
 * 1行ずつの送信になる。改行を含むときは自分で枠に包み（改行は xterm と同じく CR）、PTY へそのまま書く文字列を返す。
 * ほか（macOS / Linux、1行、xterm が既に包む、シェルだけ）は null（xterm の term.paste に任せる）。
 * 本文の中の枠の印は消す（貼った文字で枠を閉じて、後ろをキー入力として実行させない）
 */
export function windowsAgentPasteData(text: string, platform: string, context: { agentForeground: boolean; bracketedPasteMode: boolean }): string | null {
  if (platform !== 'win32' || !context.agentForeground || context.bracketedPasteMode || !/[\r\n]/.test(text)) return null
  const body = text.replace(/\r?\n/g, '\r').replace(/\x1b\[20[01]~/g, '')
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`
}

/** terminal:agentState の返事から、前面の Agent（居なければ null） */
export function foregroundAgentOf(state: { kind: string; agent?: TuiAgent | null } | null | undefined): TuiAgent | null {
  return state && state.kind !== 'unknown' ? state.agent ?? null : null
}

/**
 * 前面の Agent をその場で問い合わせ直す。1秒ごとの問い合わせの間に Agent が起動・終了していても、Shift+Enter を取り違えない。
 * 返事が来ない・失敗したときは最後に分かった状態に倒す（失敗しない Promise を返す）
 */
export function freshForegroundAgent(
  query: () => Promise<{ kind: string; agent?: TuiAgent | null } | null>,
  lastKnown: TuiAgent | null,
  timeoutMs: number
): Promise<TuiAgent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(lastKnown), timeoutMs)
    query().then(
      (state) => { clearTimeout(timer); resolve(foregroundAgentOf(state)) },
      () => { clearTimeout(timer); resolve(lastKnown) }
    )
  })
}

/**
 * ⌘⇧T（Windows・Linux は Ctrl+Shift+T）。最後に閉じたターミナルを開き直す。ターミナルにフォーカスがあるときだけ TerminalPane が拾う
 * （メニューの accelerator にはしない。内蔵ブラウザ・エディタにフォーカスがあるときは奪わない）。
 * 内蔵ブラウザのタブのキー（⌘T・⌘W・⌘1〜9。@shared/browserTabs）は Shift を使わないので重ならない
 */
export function isReopenTerminalKey(event: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): boolean {
  if (event.code !== 'KeyT' || !event.shiftKey || event.altKey) return false
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
