import { execFile } from 'node:child_process'
import { errorKind, reportHandled } from '@shared/report'
import { constants } from 'node:fs'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  BUILTIN_AGENTS,
  AGENT_CATALOG,
  agentLabel,
  defaultLaunchConfig,
  detectCommandsFor,
  findCustomAgent,
  isBuiltinAgent
} from '@shared/agentCatalog'
import type { AgentOption, AgentPreferences, TuiAgent } from '@shared/types'

/**
 * インストールされているエージェントの検出（「＋」メニューに出すもの・設定画面の印）。
 *
 * Orca由来: ~/bench/orca/src/main/preflight/agent-detection.ts（detectInstalledAgents）,
 *           ~/bench/orca/src/main/ipc/preflight-command-exec.ts（isCommandOnPath）,
 *           ~/bench/orca/src/shared/tui-agent-detection-commands.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * Orca と同じく、コマンドごとにプロセスを起動して which を呼ぶのではなく、PATH の各フォルダを fs で見る。
 * Finder から起動した Electron は PATH が短い（nvm や Homebrew が入らない）ので、ログインシェルの PATH を
 * 一度だけ取り、よく使うインストール先も足す（Orca の hydrateShellPath / install-dir 検出に相当）。
 */

/** ログインシェルの PATH を待つ上限。シェルの設定が重くても検出全体を止めない */
const SHELL_PATH_TIMEOUT_MS = 3000
/** 検出結果を覚えておく時間。メニューを開くたびに探し直さない */
const CACHE_TTL_MS = 30_000

/** PATH に入っていないことが多いインストール先（npm -g、bun、pipx、cargo、Homebrew、Cursor のインストーラ） */
function extraInstallDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.amp', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

let shellPathPromise: Promise<string> | null = null
/** 取れなかった時刻。重い rc で毎回待たせないよう、取り直すのは1分あけてから */
let shellPathFailedAt = 0
let shellPathReported = false
const SHELL_PATH_RETRY_MS = 60_000
/** 前回の起動で取れた PATH があるときの、裏での取り直しの上限（誰も待たないので長めでよい） */
const SHELL_PATH_REFRESH_TIMEOUT_MS = 10_000
/** 前回の起動で取れたログインシェルの PATH（userData に覚える）。null は無い */
let cachedShellPath: string | null = null
/** 今回の起動で取れた PATH（取れたら以後はこれ） */
let freshShellPath: string | null = null
let shellPathCacheFile: string | null = null

/** 覚えておける PATH か（壊れた・大きすぎる値は使わない） */
const usableShellPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 64 * 1024 && !value.includes('\0')

/**
 * ターミナルを速く開くための先読み（起動直後に1回）。前回の起動で取れたログインシェルの PATH を読み、裏で取り直しを始める。
 * ログインシェル（-il）の起動は利用者の rc 次第で 1〜3 秒かかり、Agent のタブを開くたびにそれを待っていた。
 * 前回の値があれば、Agent のタブは待たずにそれで実行ファイルを探す（今回の値が取れたら以後はそれを使い、ファイルも更新する）
 */
export async function warmLoginShellPath(cacheFile: string): Promise<void> {
  if (process.platform === 'win32') return
  shellPathCacheFile = cacheFile
  try {
    const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as { shell?: unknown; path?: unknown }
    if (raw.shell === loginShell() && usableShellPath(raw.path) && freshShellPath === null) cachedShellPath = raw.path
  } catch {
    /* 初回の起動・壊れたファイル（想定内。今回取れたら作る） */
  }
  void loginShellPath()
}

/** 今は前回の起動の PATH で探している（今回の値がまだ取れていない）。見つからなければ fresh で探し直す価値がある */
export function shellPathIsProvisional(): boolean {
  return freshShellPath === null && cachedShellPath !== null
}

function loginShell(): string {
  // 単体テストだけ、利用者の rc を読む本物のシェルを起動しない（test/setup/isolateEnv.ts）
  if (process.env.VITEST && process.env.FERRET_TEST_LOGIN_SHELL) return process.env.FERRET_TEST_LOGIN_SHELL
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/** 今回取れた PATH を次の起動のために覚える（失敗しても使うときに取り直すだけ） */
function rememberShellPath(value: string): void {
  if (!shellPathCacheFile || value === cachedShellPath) return
  cachedShellPath = value
  void writeFile(shellPathCacheFile, JSON.stringify({ shell: loginShell(), path: value }), { mode: 0o600 }).catch(() => undefined)
}

/**
 * ログインシェルが持つ PATH（取れなければ空）。前回の起動の値があれば、今回の値を待たずにそれを返す
 * （今回の値は裏で取り、取れた時点から使う）
 */
function loginShellPath(waitFresh = false): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('')
  if (freshShellPath !== null) return Promise.resolve(freshShellPath)
  const fallback = waitFresh ? null : cachedShellPath
  if (!shellPathPromise && Date.now() - shellPathFailedAt < SHELL_PATH_RETRY_MS) return Promise.resolve(fallback ?? cachedShellPath ?? '')
  shellPathPromise ??= new Promise<string>((resolve) => {
    const timeout = cachedShellPath !== null ? SHELL_PATH_REFRESH_TIMEOUT_MS : SHELL_PATH_TIMEOUT_MS
    execFile(loginShell(), ['-ilc', 'printf "__ADE_PATH__%s" "$PATH"'], { timeout, encoding: 'utf8' }, (error, stdout) => {
      // 印が出ていれば、終了コードが 0 でなくても PATH は取れている（.zlogout・rc の最後のコマンドの失敗などで 0 以外になる）
      const marker = typeof stdout === 'string' ? stdout.lastIndexOf('__ADE_PATH__') : -1
      if (marker < 0) {
        // 取れなかった（rc が重くて時間切れ・nushell など）。失敗を使い回さず、次に探すときに取り直す。
        // 使い回すと、ログインシェルの PATH にだけある Agent が＋メニューから消えたままになる（Orca #16340）
        shellPathPromise = null
        shellPathFailedAt = Date.now()
        const failure = loginShellPathFailure(error)
        if (failure && !shellPathReported) {
          shellPathReported = true
          reportHandled(failure, { area: 'agent-launch', op: 'read login shell PATH' })
        }
        return resolve(cachedShellPath ?? '')
      }
      const value = stdout.slice(marker + '__ADE_PATH__'.length).trim()
      freshShellPath = value
      if (usableShellPath(value)) rememberShellPath(value)
      resolve(value)
    })
  })
  return fallback !== null ? Promise.resolve(fallback) : shellPathPromise
}

/**
 * ログインシェルから PATH が取れなかったときに送る失敗（送らないなら null）。
 * 時間切れ（rc が重い）は利用者の環境の都合で、次に探すときに取り直すので送らない。
 * それ以外は終了コード・シグナルだけを題名にする（以前は errorKind で「Error」だけになり、何の失敗か分からなかった。Sentry FERRET-1S）
 */
export function loginShellPathFailure(error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null): Error | null {
  if (!error) return new Error('login shell PATH marker missing')
  if (error.killed || error.signal === 'SIGTERM') return null
  if (typeof error.code === 'number') return new Error(`login shell PATH exit ${error.code}`)
  if (typeof error.signal === 'string' && /^SIG[A-Z0-9]+$/.test(error.signal)) return new Error(`login shell PATH signal ${error.signal}`)
  return errorKind(error)
}

/**
 * 探すフォルダ（重なりは除く）。前回の起動のログインシェルの PATH があればそれで待たずに返す。
 * fresh なら今回のログインシェルの PATH を待つ（前回の値で見つからなかったときの探し直し）
 */
export async function searchDirs(options: { fresh?: boolean } = {}): Promise<string[]> {
  const fromShell = await loginShellPath(options.fresh === true)
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...fromShell.split(':'), ...extraInstallDirs()]
  return [...new Set(dirs.filter(Boolean))]
}

/** Windows は PATHEXT の拡張子も試す（拡張子なしが先） */
function commandExts(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').toLowerCase().split(';').filter(Boolean)] : ['']
}

/** フォルダの中の名前（探す鍵 → 実際の名前。Windows は大文字小文字を区別しないので鍵を小文字にする）。読めなければ空 */
function dirNames(dir: string, platform: NodeJS.Platform): Promise<Map<string, string>> {
  return readdir(dir).then(
    (names) => new Map(names.map((name) => [platform === 'win32' ? name.toLowerCase() : name, name])),
    () => new Map<string, string>() // 無い・読めないフォルダ（想定内）
  )
}

async function isExecutableAsync(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    // 無い・実行できない候補（想定内）
    return false
  }
}

/**
 * commands をそれぞれ dirs の前から探し、最初に見つかった実行ファイルのパスを返す（見つからないものは入れない）。
 * 各フォルダは1度だけ非同期で一覧し、名前が合ったものだけ確かめる。候補（コマンド × フォルダ × PATHEXT）ごとに
 * 同期の stat を呼ぶと、PATH が長い Windows では main が1秒以上止まっていた（FERRET-M）
 */
export async function resolveCommandsInDirs(commands: readonly string[], dirs: readonly string[], platform: NodeJS.Platform = process.platform): Promise<Map<string, string>> {
  const exts = commandExts(platform)
  const listings = await Promise.all(dirs.map((dir) => (dir ? dirNames(dir, platform) : Promise.resolve(new Map<string, string>()))))
  const found = new Map<string, string>()
  for (const command of new Set(commands)) {
    if (!command) continue
    if (/[\\/]/.test(command)) {
      // 絶対パス・相対パスはそのまま確かめる
      if (await isExecutableAsync(command, platform)) found.set(command, command)
      continue
    }
    search: for (const [i, dir] of dirs.entries()) {
      for (const ext of exts) {
        const key = command + ext
        const name = listings[i]!.get(platform === 'win32' ? key.toLowerCase() : key)
        if (!name) continue
        const path = join(dir, name)
        if (await isExecutableAsync(path, platform)) {
          found.set(command, path)
          break search
        }
      }
    }
  }
  return found
}

let cache: { at: number; checked: Set<string>; found: Set<string> } | null = null

/** 検出対象のコマンドのうち、見つかったもの */
async function foundCommands(commands: readonly string[], refresh: boolean): Promise<Set<string>> {
  const current = cache
  if (!refresh && current && Date.now() - current.at < CACHE_TTL_MS && commands.every((c) => current.checked.has(c))) {
    return current.found
  }
  const dirs = await searchDirs()
  const found = new Set((await resolveCommandsInDirs(commands, dirs)).keys())
  cache = { at: Date.now(), checked: new Set(commands), found }
  return found
}

/** 設定と検出結果を合わせた一覧（組み込み → カスタムの順） */
export async function listAgentOptions(prefs: AgentPreferences, refresh = false): Promise<AgentOption[]> {
  const ids: TuiAgent[] = [...BUILTIN_AGENTS, ...prefs.customAgents.map((custom) => custom.id)]
  const found = await foundCommands([...new Set(ids.flatMap((id) => detectCommandsFor(id, prefs)))], refresh)
  const disabled = new Set(prefs.disabledAgents)
  return ids.map((id): AgentOption => {
    const installed = detectCommandsFor(id, prefs).some((command) => found.has(command))
    if (isBuiltinAgent(id)) {
      const launch = prefs.launch[id] ?? defaultLaunchConfig(id)
      const fallback = defaultLaunchConfig(id)
      return {
        id,
        label: agentLabel(id),
        custom: false,
        installed,
        enabled: !disabled.has(id),
        command: launch.command,
        args: launch.args,
        defaultCommand: fallback.command,
        defaultArgs: fallback.args,
        homepageUrl: AGENT_CATALOG[id].homepageUrl
      }
    }
    const custom = findCustomAgent(prefs, id)
    return {
      id,
      label: agentLabel(id, prefs),
      custom: true,
      installed,
      enabled: !disabled.has(id),
      command: custom?.command ?? '',
      args: custom?.args ?? '',
      defaultCommand: null,
      defaultArgs: null,
      homepageUrl: null,
      ...(custom?.icon ? { icon: custom.icon } : {})
    }
  })
}
