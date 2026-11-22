import type { BuiltinAgent } from './types'
import {
  AGENT_CATALOG,
  BYPASS_FLAG_PREFIXES,
  SKIP_PERMISSION_AGENTS,
  bypassArgUnits,
  defaultLaunchConfig,
  permissionModeFlags,
  trustArgUnits
} from './agentCatalog'
import { tokenizeStartupWords, type AgentStartupShell, type StartupWord } from './agentLaunch'
import { t } from './i18n'
import { resumeArgs } from './terminalRestore'

/**
 * 組み込みの Agent を起動するときの決まり（security-3 [1]・security-5 [2]）。main の terminal.ts とアカウントのログインが使う。
 *
 * 設定の command（実行ファイルとサブコマンド）と args を、シェルと同じ分け方で一度だけ語（argv）に分け、
 * その語の並びに決まりを当て、決まりを通した argv だけから起動の1行を作る（文字列のまま決まりを当てない）。
 *   - 権限確認を省く引数は、設定の skipPermissions が入のときに SKIP_PERMISSION_AGENTS へだけ足す。
 *     引数で確認の仕方を選んでいれば足さない。自動起動も手で開くのも同じ
 *   - フォルダの信頼（Claude Code / Codex の設定ファイル、Muse・Command Code の引数）は、skipPermissions が入で、
 *     登録したプロジェクトのフォルダそのもので開くときだけ
 *   - 利用者が引数の欄にそのまま書いた引数は、書いたとおりに使う（SECURITY.md の Agent permissions）
 *   - Ferret のターミナルで見やすくする引数（Codex の --no-alt-screen。AGENT_CATALOG の terminalArgs）は、対話の画面を開くときに足す
 *   - 権限確認を省く引数・フォルダの信頼の引数を、コマンドの欄に書いたもの、引用符やバックスラッシュで書き換えたもの
 *     （`"--dangerously-skip-permissions"`、`--permission-mode "bypassPermissions"` など）は起動しない
 */

export type AgentLaunchRefusal = 'no-command' | 'bad-quote' | 'flag-in-command' | 'disguised-flag'

export type AgentLaunchPolicy =
  /** resumed: 会話を続ける引数を足した（resume を頼んだときだけ付く） */
  | { ok: true; argv: string[]; trustFolder: boolean; resumed?: true }
  | { ok: false; reason: AgentLaunchRefusal; error: string }

type MatchKind = 'bypass' | 'trust' | 'mode'

interface FlagMatch {
  kind: MatchKind
  /** 当たった語の位置と数 */
  start: number
  length: number
  flag: string
}

/** 同じ意味の長い名前（Codex の --config は -c） */
const FLAG_ALIASES: Readonly<Record<string, string>> = { '--config': '-c' }

const alias = (flag: string): string => FLAG_ALIASES[flag] ?? flag

const unquote = (value: string): string => /^(["'])(.*)\1$/.exec(value)?.[2] ?? value

/**
 * 値をくらべる形にする。Codex の -c は TOML の値なので、`sandbox_mode = "danger-full-access"` も
 * `sandbox_mode=danger-full-access` と同じ意味になる（=の前後の空白と、値・名前を囲む引用符は意味を変えない）
 */
function normalizeValue(value: string): string {
  const eq = value.indexOf('=')
  if (eq < 0) return unquote(value.trim())
  return `${unquote(value.slice(0, eq).trim())}=${unquote(value.slice(eq + 1).trim())}`
}

interface FlagReading {
  flag: string
  value: string | null
  length: number
}

/** i 番目の語をフラグとして読める形をすべて返す（`--f v`・`--f=v`・`-s v`・`-sv`・値なし） */
function readFlag(words: readonly string[], i: number): FlagReading[] {
  const word = words[i]!
  if (!word.startsWith('-') || word === '-' || word === '--') return []
  const next = i + 1 < words.length ? words[i + 1]! : null
  const readings: FlagReading[] = []
  if (word.startsWith('--')) {
    const eq = word.indexOf('=')
    if (eq > 0) return [{ flag: alias(word.slice(0, eq)), value: word.slice(eq + 1), length: 1 }]
    readings.push({ flag: alias(word), value: null, length: 1 })
  } else {
    const flag = alias(word.slice(0, 2))
    if (word.length > 2) return [{ flag, value: word.slice(2).replace(/^=/, ''), length: 1 }]
    readings.push({ flag, value: null, length: 1 })
  }
  if (next !== null) readings.push({ flag: readings[0]!.flag, value: next, length: 2 })
  return readings
}

function unitMatches(unit: readonly string[], reading: FlagReading): boolean {
  if (alias(unit[0]!) !== reading.flag) return false
  // 値の無い単位（--yolo）は、`--yolo=…` の形も同じとみなす
  if (unit.length === 1) return reading.length === 1
  return reading.value !== null && normalizeValue(reading.value) === normalizeValue(unit.slice(1).join(' '))
}

/** 語の並びから、権限確認を省く引数・フォルダの信頼の引数・確認の仕方を選ぶフラグを探す（`--` より後はプロンプトなので見ない） */
export function findPermissionFlags(agent: BuiltinAgent, words: readonly string[]): FlagMatch[] {
  const bypass = bypassArgUnits(agent)
  const trust = trustArgUnits(agent)
  const modes = permissionModeFlags(agent).map(alias)
  const matches: FlagMatch[] = []
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--') break
    for (const reading of readFlag(words, i)) {
      const at = (kind: MatchKind): FlagMatch => ({ kind, start: i, length: reading.length, flag: words.slice(i, i + reading.length).join(' ') })
      if (BYPASS_FLAG_PREFIXES.some((prefix) => reading.flag.startsWith(prefix)) || bypass.some((unit) => unitMatches(unit, reading))) matches.push(at('bypass'))
      else if (trust.some((unit) => unitMatches(unit, reading))) matches.push(at('trust'))
      else if (reading.length === 1 && modes.includes(reading.flag)) matches.push(at('mode'))
    }
  }
  return matches
}

const words = (args: string): string[] => args.trim().split(/\s+/).filter(Boolean)

/** 対話の画面を開かない Codex のサブコマンド（terminalArgs を足さない。codex --help、0.171.0） */
const CODEX_NON_TUI_COMMANDS = ['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'doctor', 'update', 'features', 'help']

/** Ferret のターミナル向けにいつも足す引数（AGENT_CATALOG の terminalArgs）。足さないときは空 */
export function terminalArgsFor(agent: BuiltinAgent, commandTail: readonly string[], args: readonly string[]): string[] {
  const extra = words(AGENT_CATALOG[agent].terminalArgs ?? '')
  if (extra.length === 0) return []
  const before = [...commandTail, ...args]
  const end = before.indexOf('--')
  const flagsPart = end < 0 ? before : before.slice(0, end)
  if (agent === 'codex' && flagsPart.some((word) => CODEX_NON_TUI_COMMANDS.includes(word))) return []
  return extra.filter((flag) => !flagsPart.some((word) => word === flag || word.startsWith(`${flag}=`)))
}

function refuse(reason: AgentLaunchRefusal, error: string): AgentLaunchPolicy {
  return { ok: false, reason, error }
}

/**
 * 設定のコマンドの欄を語に分ける。先頭が実行ファイル、残りはサブコマンド（acli rovodev run など）。
 * コマンドの欄に権限確認を省く引数・フォルダの信頼の引数があれば起動しない（アカウントのログインも同じ）
 */
export function canonicalLaunchCommand(
  agent: BuiltinAgent,
  command: string,
  shell: AgentStartupShell
): { ok: true; words: StartupWord[] } | { ok: false; reason: AgentLaunchRefusal; error: string } {
  const backslash = shell === 'posix' ? 'escape' : 'literal'
  const parsed = tokenizeStartupWords(command.trim() || defaultLaunchConfig(agent).command, backslash)
  if (!parsed.ok) return { ok: false, reason: 'bad-quote', error: t('agentLaunch.errors.badArgs', { error: parsed.error }) }
  if (parsed.words.length === 0) return { ok: false, reason: 'no-command', error: t('agentLaunch.errors.noCommand') }
  const tail = parsed.words.slice(1).map((word) => word.value)
  const found = findPermissionFlags(agent, tail).find((match) => match.kind !== 'mode')
  if (found) return { ok: false, reason: 'flag-in-command', error: t('agentLaunch.errors.flagInCommand', { flag: found.flag }) }
  return { ok: true, words: parsed.words }
}

export function resolveAgentLaunchPolicy(input: {
  agent: BuiltinAgent
  /** 設定のコマンドの欄（空なら既定） */
  command: string
  /** 設定の引数の欄 */
  args: string
  /** cwd が登録済みのプロジェクトのフォルダそのものならその id。それ以外（サブフォルダ・ホーム）は null */
  projectId: string | null
  skipPermissions: boolean
  /** 起動するシェル（Windows のシェルではバックスラッシュをパスの区切りとして読む） */
  shell: AgentStartupShell
  /** 前の会話を続けて起動する（ターミナルを戻したとき。@shared/terminalRestore の resumeArgs）。続けられなければ普通に起動する */
  resume?: boolean
}): AgentLaunchPolicy {
  const { agent } = input
  const command = canonicalLaunchCommand(agent, input.command, input.shell)
  if (!command.ok) return refuse(command.reason, command.error)
  const parsedArgs = tokenizeStartupWords(input.args.trim(), input.shell === 'posix' ? 'escape' : 'literal')
  if (!parsedArgs.ok) return refuse('bad-quote', t('agentLaunch.errors.badArgs', { error: parsedArgs.error }))
  const [head, ...tail] = command.words
  const args = parsedArgs.words
  // コマンドの欄の残りと引数の欄を1つの並びとして見る（欄をまたいで分けた書き方も同じに読む）
  const all = [...tail, ...args]
  const matches = findPermissionFlags(agent, all.map((word) => word.value))
  for (const match of matches) {
    if (match.kind === 'mode') continue
    // コマンドの欄から始まるもの（`--permission-mode` をコマンドに、値を引数に書いた形など）
    if (match.start < tail.length) return refuse('flag-in-command', t('agentLaunch.errors.flagInCommand', { flag: match.flag }))
    // 引用符やバックスラッシュで書いたものは、利用者がそのフラグを書いたとはみなさない
    if (all.slice(match.start, match.start + match.length).some((word) => !word.plain)) {
      return refuse('disguised-flag', t('agentLaunch.errors.disguisedFlag', { flag: match.flag }))
    }
  }
  const skip = input.skipPermissions && SKIP_PERMISSION_AGENTS.includes(agent)
  const choosesMode = matches.some((match) => match.kind !== 'trust')
  const yolo = skip && !choosesMode ? words(AGENT_CATALOG[agent].yoloArgs) : []
  const inProject = input.skipPermissions && input.projectId !== null
  const trust = inProject && !matches.some((match) => match.kind === 'trust') ? words(AGENT_CATALOG[agent].trustArgs ?? '') : []
  const display = terminalArgsFor(agent, tail.map((word) => word.value), args.map((word) => word.value))
  const rest = [...trust, ...yolo, ...display, ...args.map((word) => word.value)]
  const resume = input.resume ? resumeArgs(agent, tail.map((word) => word.value), rest) : null
  const argv = [head!.value, ...(resume?.lead ?? []), ...tail.map((word) => word.value), ...rest, ...(resume?.trail ?? [])]
  return { ok: true, argv, trustFolder: skip && input.projectId !== null, ...(resume ? { resumed: true as const } : {}) }
}
