import type { AgentLaunchConfig, TuiAgent } from './types'
import { defaultLaunchConfig, isBuiltinAgent } from './agentCatalog'
import { t } from './i18n'
import { quotePowerShellLiteral, quoteWindowsCmdArgument } from './shellQuote'

/**
 * Agent起動コマンドの組み立て（純粋関数だけ。main と単体テストから使う）。
 *
 * Orca由来: ~/bench/orca/src/shared/tui-agent-startup-shell.ts,
 *           ~/bench/orca/src/shared/tui-agent-launch-command.ts,
 *           ~/bench/orca/src/shared/commit-message-prompt.ts（tokenizeCustomCommandTemplate）,
 *           ~/bench/orca/src/shared/powershell-native-argument.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、コマンド本体（command）は利用者が書いたシェル文字列のまま使い、
 * 引数（args）だけを一度トークンに分けてから1つずつクォートし直す。
 * 設定欄の文字列をシェルに直接解釈させないので、どのシェルでも同じ意味になる。
 * セッションオプション・プロンプト注入・SSH などは本システムでは扱わないので持ち込んでいない。
 */

/** 'posix' は sh / bash / zsh / dash / fish のどれでも正しく読める書き方を出す（Orcaと同じ） */
export type AgentStartupShell = 'posix' | 'powershell' | 'cmd'

/** 起動するシェルのパスから、コマンドの書き方を決める */
export function startupShellForPath(shellPath: string): AgentStartupShell {
  const base = (shellPath.split(/[\\/]/).pop() ?? shellPath).toLowerCase().replace(/\.exe$/, '')
  if (base === 'pwsh' || base === 'powershell') return 'powershell'
  if (base === 'cmd') return 'cmd'
  return 'posix'
}

type StartupCommandTokens = { ok: true; tokens: string[] } | { ok: false; error: string }

/** 分けた1語。plain は引用符もバックスラッシュも使わずに書かれていたか（権限の引数を隠した書き方を見分ける。security-5 [2]） */
export interface StartupWord {
  value: string
  plain: boolean
}

type StartupWords = { ok: true; words: StartupWord[] } | { ok: false; error: string }

/**
 * Unix シェル風の分かち書き。`a"b"c` は1語 `abc`、クォート内の空白は区切らない。
 * Orca の tokenizeCustomCommandTemplate（backslash: 'escape'）から、
 * 位置情報（spans）を除いて抜き出した。
 *
 * クォートの書き方は OS で変えない。ただし Windows のシェル（cmd / PowerShell）では、バックスラッシュを
 * パスの区切りとしてそのまま残す（backslash: 'literal'）。エスケープにすると `C:\Users\me\x.toml` が `C:Usersmex.toml` になる
 */
export function tokenizeStartupWords(value: string, backslash: 'escape' | 'literal' = 'escape'): StartupWords {
  const words: StartupWord[] = []
  let current = ''
  let plain = true
  let inToken = false
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < value.length) {
    const ch = value[i]!
    if (quote) {
      // ダブルクォートの中だけ、バックスラッシュで次の1文字を取り込む
      if (backslash === 'escape' && ch === '\\' && quote === '"' && i + 1 < value.length) {
        current += value[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        // クォートを抜けても語は続く（`a"b"c` → `abc`）
        quote = null
        inToken = true
        i++
        continue
      }
      current += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      plain = false
      i++
      continue
    }
    if (backslash === 'escape' && ch === '\\' && i + 1 < value.length) {
      current += value[i + 1]
      inToken = true
      plain = false
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        words.push({ value: current, plain })
        current = ''
        plain = true
        inToken = false
      }
      i++
      continue
    }
    current += ch
    inToken = true
    i++
  }

  if (quote) return { ok: false, error: t('agentLaunch.errors.unclosedQuote') }
  if (inToken) words.push({ value: current, plain })
  return { ok: true, words }
}

export function tokenizeStartupCommand(value: string, backslash: 'escape' | 'literal' = 'escape'): StartupCommandTokens {
  const result = tokenizeStartupWords(value, backslash)
  return result.ok ? { ok: true, tokens: result.words.map((word) => word.value) } : result
}

/**
 * どの Unix シェルでも文字どおりに読まれる1引数を作る。
 * fish はシングルクォート内の `\\` と `\'` をエスケープとして扱うため、sh の `'\''` は使えない。
 * バックスラッシュは `"\\"`、アポストロフィは `"'"` として、シングルクォートの区間の間に挟む。
 */
function quotePortableUnixArg(value: string): string {
  if (!value) return "''"
  const parts: string[] = []
  let literal = ''
  const flushLiteral = (): void => {
    if (literal) {
      parts.push(`'${literal}'`)
      literal = ''
    }
  }
  for (const char of value) {
    if (char === "'") {
      flushLiteral()
      parts.push(`"'"`)
    } else if (char === '\\') {
      flushLiteral()
      parts.push(`"\\\\"`)
    } else {
      literal += char
    }
  }
  flushLiteral()
  return parts.join('')
}


/**
 * どの Unix シェルでも特別な意味を持たない文字だけの引数（`--yolo`、`/opt/bin/x`、`--mode=auto` など）。
 * 引用せずそのまま出して、プロンプトに表示される起動コマンドを読みやすくする。
 * `%`（古い fish のプロセス展開）、`~`、先頭の `=`（zsh の =コマンド 展開）、`*?[]{}` などは含めない。
 * Orca の quoteStartupArg は常に引用するが、ここは見え方のために安全な場合だけ省く（意味は同じ）
 */
const POSIX_SAFE_ARG = /^[A-Za-z0-9_@+,./:-][A-Za-z0-9_@+,./:=-]*$/

export function quoteStartupArg(value: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') return quotePowerShellLiteral(value)
  if (shell === 'cmd') return quoteWindowsCmdArgument(value)
  return POSIX_SAFE_ARG.test(value) ? value : quotePortableUnixArg(value)
}


type AgentLaunchCommand = { ok: true; command: string } | { ok: false; error: string }

/**
 * 設定（command + args）から、シェルへ流し込む1行を作る。
 * command が空なら組み込みの既定（claude / codex / gemini …）を使う。カスタムで空なら理由を返す。
 * args の書き方が壊れていれば理由を返す。
 */
export function buildAgentLaunchCommand(
  agent: TuiAgent,
  config: AgentLaunchConfig | undefined,
  shell: AgentStartupShell
): AgentLaunchCommand {
  const command = config?.command.trim() || (isBuiltinAgent(agent) ? defaultLaunchConfig(agent).command : '')
  if (!command) return { ok: false, error: t('agentLaunch.errors.noCommand') }
  const args = config?.args.trim() ?? ''
  if (!args) return { ok: true, command }
  const tokenized = tokenizeStartupCommand(args, shell === 'posix' ? 'escape' : 'literal')
  if (!tokenized.ok) return { ok: false, error: t('agentLaunch.errors.badArgs', { error: tokenized.error }) }
  const suffix = tokenized.tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
  return { ok: true, command: suffix ? `${command} ${suffix}` : command }
}
