import { delay } from '@shared/delay'
import { shellQuote, sshShellSpec, type SshTarget } from '@shared/sshCommand'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import { type TerminalAttachInfo, type TerminalCreateOptions, type TerminalSessionInfo, type TerminalSize, type TerminalTabInfo, type TuiAgent, type WindowsShell } from '@shared/types'
import { buildAgentLaunchCommand, startupShellForPath } from '@shared/agentLaunch'
import { agentForProcess, agentLabel, findCustomAgent, isBuiltinAgent } from '@shared/agentCatalog'
import { resolveAgentLaunchPolicy } from '@shared/agentPolicy'
import { currentSettings } from './settings'
import { planStartupDelivery } from './shellStartup'
import { buildAccountLoginLaunch, resolveAgentEnvForAccount, tabAccountId } from './accounts'
import { hasClaudeConversation } from './terminalRestore'
import { resolveProcessCwd } from './processCwd'
import { isInheritedAgentSessionEnv } from './inheritedAgentEnv'
import { remoteTrustedLaunchLine, resolveTrustedExecutable, trustedLaunchLine, windowsSearchPathEnv } from './agentExecutable'
import { executionSphere } from './executionSphere'
import { searchDirs, shellPathIsProvisional } from './agentDetection'
import { TerminalHistory } from './terminalHistory'
import { defaultLocaleEnv, prependPathEntry, isHostTerminalEnv, stripAppImagePaths } from './terminalEnv'
import { AGENT_MAIL_BIN_ENV } from '@shared/agentMail'
import { VIDEO_BIN_ENV } from '@video/names'
import { windowsTreeKillCommand } from './platform/windowsTreeKill'
import { applyAgentWorkspaceTrust, registeredProjectIdFor } from './agentWorkspaceTrust'
import { detectState, parseTitle, stripAnsi } from './agent/state'
import type { AgentKind } from './agent/protocol'
import { ComposerReadiness } from './agent/readiness'
import { nextLaunchAgentPhase, type LaunchAgentPhase } from './agent/launchPhase'
import { sendToAgent } from './agent/send'
import { chooseSendTarget } from './agent/sendTarget'
import { agentSubmitsPaste } from '@shared/sendTarget'
import { agentInProcessTree, hasForegroundChild, isShellProcess, parseProcessRows, parseWindowsProcessRows, type ProcessRow } from './agent/processTree'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { reportMainError } from './telemetry'
import { flow, reportHandled, timedSync, errorKind } from '@shared/report'
import { exitWhenDoneCommand } from '@shared/agentInstall'
import { isKnownCliInstallCommand } from '@shared/cliTools'
import { DECISION_ENV_PREFIXES } from '@shared/decision'

/**
 * 終わったら閉じる1回きりのコマンド（Agent のインストール）。
 * 検証起動（ADE_E2E=1）では本物のインストーラを動かさない。ADE_E2E_INSTALL_COMMAND があればそれ
 * （例: echo installing && sleep 1 && exit 0）に差し替え、無ければ実行せずに表示だけして成功にする
 */
function oneShotCommand(command: string): string {
  if (process.env.ADE_E2E !== '1') return command.trim()
  const mock = process.env.ADE_E2E_INSTALL_COMMAND?.trim()
  return mock || `echo ${shellQuote(`[E2E] ${command.trim()}`)}`
}

/**
 * 内蔵ターミナル（WS-4）。node-pty のPTYをメインプロセスで持ち、
 * renderer の xterm.js とは IPC でつなぐ。
 *
 * NF-6（大量出力中も入力が詰まらない）のため、PTY出力はそのまま転送せず、
 * 1フレーム分ためてから1回のIPCで送る。
 */

/** PTY出力をまとめる間隔。xterm.js 側の描画が1フレームに1回で足りる */
export const FLUSH_INTERVAL_MS = 16
/**
 * 画面に出ていないターミナル（裏のタブ・プロジェクト）の出力をまとめる間隔。多くの Agent を並べて動かすと、
 * 見ていないタブまで毎フレーム IPC と xterm の解析が走って CPU を使う。見えるようになったら、ためた分をすぐ送る（setVisible）
 */
export const HIDDEN_FLUSH_INTERVAL_MS = 250
/** 1回のフラッシュで送る上限。超えた分は次のフラッシュへ回す */
export const MAX_CHUNK = 256 * 1024
/** ためこみの上限。これを超えたら古い側を捨てて入力の応答を守る */
const MAX_BUFFER = 4 * 1024 * 1024
/**
 * 出力の流量制御。renderer がまだ描いていない（ack の来ていない）出力がこれを超えたら PTY を止め、
 * FLOW_LOW_WATER を下回ったら再開する。ack を待たずに送り続けると、renderer が詰まったとき（重い描画・読み込み直し）に
 * main の IPC の送り待ちが上限なく増える（0.4.16 の Windows の main のクラッシュの候補）。止めている間はシェルの書き込みが待つ
 */
export const FLOW_HIGH_WATER = 2 * 1024 * 1024
export const FLOW_LOW_WATER = 256 * 1024
/** 起動ファイルにフックを差し込めないシェルで、出力が止まってから起動コマンドを書き込むまでの間 */
const STARTUP_WRITE_QUIET_MS = 300
/** 出力が止まらなくても、ここまで待ったら書き込む */
const STARTUP_WRITE_TIMEOUT_MS = 5000

export interface ShellSpec {
  file: string
  args: string[]
}

/**
 * Windows のシェル（設定の agents.windowsShell）。既定は PowerShell（7 の pwsh があればそれ、無ければ Windows に入っている 5.1）。
 * cmd.exe は終了すると履歴を残さないので、新しいタブ・再起動のあとに ↑ で前のコマンドが出ない。PowerShell は PSReadLine が
 * 履歴をファイルに残す（Windows Terminal・VS Code と同じ履歴）。PowerShell が見つからなければ cmd.exe。
 * どれも OS の決まった場所の絶対パスだけを使う（PATH やプロジェクトのフォルダからは探さない。security-4 [1]）
 */
export function resolveWindowsShell(preference: WindowsShell, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): ShellSpec {
  const systemRoot = env.SystemRoot && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows'
  const comspec = env.COMSPEC && win32.isAbsolute(env.COMSPEC) ? env.COMSPEC : win32.join(systemRoot, 'System32', 'cmd.exe')
  if (preference === 'powershell') {
    const programFiles = env.ProgramFiles && win32.isAbsolute(env.ProgramFiles) ? env.ProgramFiles : 'C:\\Program Files'
    const candidates = [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
    const found = candidates.find((path) => exists(path))
    if (found) return { file: found, args: ['-NoLogo'] }
  }
  return { file: comspec, args: [] }
}

/**
 * ユーザーのログインシェルを決める。3つのOSで動く書き方にする。
 * - Windows: 設定の windowsShell（既定は PowerShell。resolveWindowsShell）。ログインシェルの概念がないので引数は -NoLogo だけ
 * - macOS / Linux: $SHELL をログインシェル（-l）として起動し、
 *   .zprofile / .bash_profile で入るPATH（nvm、Homebrew など）を反映させる
 */
function resolveShell(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') {
    return resolveWindowsShell(currentSettings().agents.windowsShell, process.env)
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : fallback
  return { file: shell, args: ['-l'] }
}

/** PTYに渡す環境変数。Electron固有の変数は子プロセスへ漏らさない */
function ptyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(key)) continue
    // 親の Claude Code / Codex のセッションの印は渡さない（新しいターミナルは親のエージェントの子ではない）
    if (isInheritedAgentSessionEnv(key, value)) continue
    // 別の Ferret（親）の判定モデルの中継の URL は古い合言葉なので受け継がない（旧名も）。このアプリの値は extra で渡す
    if (DECISION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    // 別の Ferret（親）の Agent どうしの依頼の合言葉・受け口も受け継がない。このアプリの値は extra で渡す
    if (key.startsWith('FERRET_AGENT_')) continue
    // Ferret を起動した端末・AppImage・Crashpad・開発起動の変数は渡さない（terminalEnv.ts）
    if (isHostTerminalEnv(key)) continue
    env[key] = value
  }
  if (process.platform === 'linux') stripAppImagePaths(env, process.env.APPDIR)
  Object.assign(env, defaultLocaleEnv(env, process.platform))
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Windows の cmd.exe に、素の名前を今のフォルダ（プロジェクト）から探させない（security-4 [1]）
  const merged: Record<string, string> = { ...env, ...extra, ...windowsSearchPathEnv() }
  // Agent どうしの依頼の CLI（タブごとのフォルダ）を PATH の先頭に置く（src/main/agentMail.ts）
  const agentBin = merged[AGENT_MAIL_BIN_ENV]
  delete merged[AGENT_MAIL_BIN_ENV]
  if (agentBin) prependPathEntry(merged, agentBin)
  // 動画づくりの CLI（ferret-video）のフォルダも PATH の先頭に置く（src/video/app/main/cli/env.ts）
  const videoBin = merged[VIDEO_BIN_ENV]
  delete merged[VIDEO_BIN_ENV]
  if (videoBin) prependPathEntry(merged, videoBin)
  return merged
}

/**
 * node-pty はネイティブモジュールなので、最初のタブを開くまで読み込まない（起動時間 NF-5）。
 * Electron のバージョンに対して正しくビルドされていない場合は、ここで原因が分かるようにする。
 */
let nodePtyPromise: Promise<typeof import('node-pty')> | null = null

async function loadNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) {
    nodePtyPromise = import('node-pty').catch((err: unknown) => {
      nodePtyPromise = null
      throw new Error(
        t('terminal.errors.nodePty'),
        { cause: err }
      )
    })
  }
  return nodePtyPromise
}

/**
 * ps の結果。送信先を選ぶときは全タブを続けて調べるので、1秒だけ使い回す（タブの数だけ ps を起動しない）
 */
let processCache: { at: number; rows: Promise<ProcessRow[]> } | null = null
/** 前面のプロセス名からプロセスツリーで同定した Agent を使い回す間（Session.agentLookup。毎秒の問い合わせで ps を毎回起動しない） */
const AGENT_LOOKUP_RETRY_MS = 5000
function processRows(): Promise<ProcessRow[]> {
  if (!processCache || Date.now() - processCache.at > 1000) {
    const rows = promisify(execFile)('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => parseProcessRows(stdout))
    processCache = { at: Date.now(), rows }
    rows.catch(() => { processCache = null }) // 失敗は使い回さない（呼び出し側が受け取る）
  }
  return processCache.rows
}

/**
 * Windows のプロセス一覧（ps が無いので PowerShell の Win32_Process）。PowerShell の起動は重く、
 * ARM64 のエミュレーションでは数秒かかるので、前の結果をすぐ返しつつ裏で取り直す（5秒に1回まで。
 * 起動のたびに CPU を使い、マウスの砂時計も点滅させるため間を空ける。Orca #10857 #12288）
 */
const WINDOWS_PROCESS_QUERY =
  "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | " +
  'ForEach-Object { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine)) }'
let windowsProcessCache: { at: number; rows: ProcessRow[] | null; pending: Promise<ProcessRow[]> | null } = { at: 0, rows: null, pending: null }
function windowsProcessRows(): Promise<ProcessRow[]> {
  const cache = windowsProcessCache
  if (!cache.pending && Date.now() - cache.at > 5000) {
    cache.pending = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })
      .then(({ stdout }) => {
        const rows = parseWindowsProcessRows(stdout)
        windowsProcessCache = { at: Date.now(), rows, pending: null }
        return rows
      }, (err: unknown) => {
        windowsProcessCache = { at: Date.now(), rows: cache.rows, pending: null }
        throw err
      })
    cache.pending.catch(() => undefined) // 前の結果を返すときは、ここでの失敗を誰も受け取らない
  }
  if (cache.rows) return Promise.resolve(cache.rows)
  return cache.pending ?? Promise.reject(new Error('process list unavailable'))
}

interface Session {
  id: string
  pty: IPty
  buffer: string[]
  bufferBytes: number
  timer: NodeJS.Timeout | null
  /** 今の timer の待ち（裏のターミナルのゆっくりのフラッシュを、たまったときに早めるかの判断） */
  timerDelay?: number
  tail: string
  screen?: { text: string; at: number }
  title?: string
  readiness: ComposerReadiness
  sending: boolean
  /** 開いたときの情報（Resource Manager などの一覧用） */
  info: TerminalSessionInfo
  /** 直近の出力。画面を読み込み直したあと、つなぎ直したタブに流し直す */
  history: TerminalHistory
  /** 起動時の Agent の推定の段階（agent/launchPhase.ts） */
  launchAgent?: LaunchAgentPhase
  /**
   * 前面のプロセス名（pty.process）からプロセスツリーで同定した Agent。名前が同じ間は ps を引き直さない
   * （公式インストーラの Claude Code は版番号の名前なので、毎秒の状態の問い合わせのたびに ps が走っていた）。
   * 見つかった・見つからなかったどちらも AGENT_LOOKUP_RETRY_MS の間だけ使い回し、シェルに戻ったら忘れる
   */
  agentLookup?: { command: string; agent: TuiAgent | null; at: number }
  /** 送ったが renderer の ack がまだの文字数（流量制御） */
  unacked: number
  /** 流量制御で PTY を止めているか */
  paused: boolean
  /** 先に起動しておいた、まだどのタブにも渡していないシェル（出力は履歴にだけためる。TerminalManager.spare） */
  spare?: boolean
}

/** 次の素のシェルのタブのために先に起動しておくシェル */
interface SpareShell {
  session: Session
  cwd: string
  /** 起動したときの文脈（spareContext）。変わっていれば使わずに作り直す */
  context: string
  at: number
  /** 起動したときの幅。渡すタブの幅と違えば、それまでの出力を流し直さない（claimSpare） */
  cols: number
}

/** 先に起動しておいたシェルを使う上限（中継の合言葉の期限 24 時間より十分短く。古ければ捨てて普通に開く） */
const SPARE_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** タブを開いてから、次のための先の起動を始めるまで（開いたばかりのシェルの rc と CPU を取り合わない） */
const SPARE_REFILL_DELAY_MS = 1500

export type { TerminalSessionInfo } from '@shared/types'

/**
 * 次のフラッシュまでの待ち。見えているターミナルは毎フレーム、裏のターミナルは HIDDEN_FLUSH_INTERVAL_MS。
 * 裏でも 1 回で送る上限（MAX_CHUNK）以上たまっていればすぐ送る（大量の出力で MAX_BUFFER を超えて古い出力を捨てない）
 */
export function flushDelayMs(hidden: boolean, bufferedBytes: number): number {
  return hidden && bufferedBytes < MAX_CHUNK ? HIDDEN_FLUSH_INTERVAL_MS : FLUSH_INTERVAL_MS
}

export class TerminalManager {
  private sessions = new Map<string, Session>()
  /**
   * kill は済んだが、まだ onExit が届いていないPTY。
   * 強制終了に切り替えるときのために、PTYと（kill前に調べた）子孫PIDを持つ。
   */
  private awaitingExit = new Map<string, { pty: IPty; descendants: number[] }>()
  /** 「全部の終了通知が届いた」を待っている人たち */
  private exitWaiters = new Set<() => void>()
  private seq = 0
  /**
   * renderer が最後に知らせたとき（terminal:visible）に画面に出ていなかったターミナル。出力をゆっくりまとめる。
   * 知らせたあとに開いたターミナルは、次の知らせまで見えているものとして扱う（開いた直後のプロンプトを待たせない）
   */
  private hidden = new Set<string>()
  private cwd: string = homedir()
  /** SSH のプロジェクトを開いているときの接続先。タブは ssh -t でリモートのシェルとして開く（src/shared/sshCommand.ts） */
  private remote: SshTarget | null = null
  /**
   * 先に起動しておいたシェル（ターミナルを速く開く）。素のシェルのタブを開くとき、rc（利用者のログインシェルの設定。
   * 重いと 1 秒以上）を読み終えたこのシェルをそのまま渡し、次の分を裏で起動しておく。macOS・Linux の手元のプロジェクトだけ
   */
  private spare: SpareShell | null = null
  private spareStarting = false
  /** 最後に開いた・合わせたタブの寸法。次のシェルはこの寸法で先に起動する（違う幅で起動すると、渡したときにプロンプトの行が崩れる） */
  private lastSize: TerminalSize | null = null
  private spareTimer: NodeJS.Timeout | null = null
  private disposed = false
  /** 先に起動しておくか（main が有効にする。単体テストでは既定の無効のまま） */
  spareShells = false
  /** 先に起動したシェルを使ってよい文脈（プロジェクト・判定モデルの設定など、タブの環境変数を決めるもの）。変われば作り直す */
  spareContext: () => string = () => ''

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void
  ) {}

  /**
   * タブを開くたびに足す環境変数（判定モデルの中継の URL など。src/main/decision/service.ts）。
   * キーのような秘密はここで渡さないこと
   */
  launchEnv: ((meta: { agent: string | null; sessionId: string }) => Promise<Record<string, string>>) | null = null

  /**
   * タブ（PTY）が終わったら呼ぶ。launchEnv で渡した合言葉など、そのタブに結び付けたものを無効にする。
   * 起動に失敗したときも呼ぶ
   */
  onSessionClosed: ((sessionId: string) => void) | null = null

  /** タブを作った（Agent どうしの依頼で開いたタブを、待っている配送へ渡す。src/main/agentMail.ts） */
  onCreated: ((id: string, options: TerminalCreateOptions) => void) | null = null

  /**
   * 上限での自動切り替え（src/main/failover/service.ts）。入力・出力・送った指示と、開いた Agent のタブを渡す
   */
  failover: {
    input(id: string, data: string): void
    output(id: string, text: string): void
    sent(id: string, text: string): void
    launched(id: string, agent: TuiAgent, token: string | null, accountId?: string | null): void
    closed(id: string): void
  } | null = null

  /**
   * 後始末が残っているPTYの数。
   * 生きているものと、kill 済みで終了通知待ちのものの両方を数える。
   */
  pendingCount(): number {
    return this.sessions.size + this.awaitingExit.size + (this.spare ? 1 : 0)
  }

  /** 開いたプロジェクトフォルダを、以降に作るタブのカレントにする */
  setCwd(dir: string | null): void {
    const next = dir ?? homedir()
    if (next !== this.cwd) this.discardSpare()
    this.cwd = next
  }

  /** SSH のプロジェクトのときだけ渡す。null ならローカルのシェル */
  setRemote(target: SshTarget | null): void {
    if (target) this.discardSpare()
    this.remote = target
  }

  /**
   * 起動直後の先読み。node-pty を読み込み、開いているプロジェクトで次のシェルを先に起動しておく
   * （最初のタブを開く要求が届くころには rc を読み終えている）
   */
  prewarm(size: TerminalSize = { cols: 80, rows: 24 }): void {
    void loadNodePty().catch(() => undefined) // 読み込めなければタブを開くときに理由を出す
    this.scheduleSpare(size, 0)
  }

  /** 先に起動しておいたシェルを捨てる（プロジェクトを替えた・使えなくなった） */
  discardSpare(): void {
    if (this.spareTimer) {
      clearTimeout(this.spareTimer)
      this.spareTimer = null
    }
    const spare = this.spare
    this.spare = null
    if (!spare) return
    const { id, pty } = spare.session
    this.onSessionClosed?.(id)
    // 終了通知が kill の中で届いても待ちが残らないよう、先に登録してから kill する
    const entry: { pty: IPty; descendants: number[] } = { pty, descendants: [] }
    this.awaitingExit.set(id, entry)
    entry.descendants = killPtyTree(pty, 'SIGHUP')
  }

  private spareEnabled(): boolean {
    return this.spareShells && !this.disposed && process.platform !== 'win32' && this.remote === null
  }

  /** 次の素のシェルを、少し待ってから先に起動する（1つだけ） */
  private scheduleSpare(size: TerminalSize, delayMs = SPARE_REFILL_DELAY_MS): void {
    if (!this.spareEnabled() || this.spare || this.spareStarting || this.spareTimer) return
    this.spareTimer = setTimeout(() => {
      this.spareTimer = null
      void this.startSpare(this.lastSize ?? size).catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'prewarm shell' }))
    }, delayMs)
    this.spareTimer.unref?.()
  }

  private async startSpare(size: TerminalSize): Promise<void> {
    if (!this.spareEnabled() || this.spare || this.spareStarting) return
    const cwd = this.cwd
    if (!existsSync(cwd)) return
    this.spareStarting = true
    const id = `t${++this.seq}`
    try {
      const nodePty = await loadNodePty()
      const context = this.spareContext()
      const launchEnv = this.launchEnv ? await this.launchEnv({ agent: null, sessionId: id }).catch(() => ({})) : {}
      // 待っている間にプロジェクトを替えた・閉じ始めた：起動しない
      if (!this.spareEnabled() || this.cwd !== cwd || this.spareContext() !== context) {
        this.onSessionClosed?.(id)
        return
      }
      const shell = resolveShell()
      const pty = nodePty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, size.cols),
        rows: Math.max(1, size.rows),
        cwd,
        env: ptyEnv(launchEnv)
      })
      const session: Session = { id, pty, buffer: [], bufferBytes: 0, timer: null,
        tail: '', readiness: new ComposerReadiness(), sending: false,
        info: { id, pid: pty.pid, cwd, title: '', agent: null }, history: new TerminalHistory(), unacked: 0, paused: false, spare: true }
      this.spare = { session, cwd, context, at: Date.now(), cols: Math.max(2, size.cols) }
      this.wirePty(session, null, null)
    } catch (err) {
      this.onSessionClosed?.(id)
      throw err
    } finally {
      this.spareStarting = false
    }
  }

  /** 素のシェルのタブに、先に起動しておいたシェルを渡す。使えなければ null（普通に起動する） */
  private claimSpare(cwd: string, size: TerminalSize, customTitle: string | undefined): TerminalTabInfo | null {
    const spare = this.spare
    if (!spare || !this.spareEnabled() || spare.cwd !== cwd) return null
    if (spare.context !== this.spareContext() || Date.now() - spare.at > SPARE_MAX_AGE_MS) {
      this.discardSpare()
      return null
    }
    this.spare = null
    const { session } = spare
    session.spare = false
    this.sessions.set(session.id, session)
    // 起動したときと幅が違えば、それまでの出力（前の幅で折り返したプロンプトと zsh の行末の印 %）は流し直さない。
    // 幅を合わせると、シェルが SIGWINCH で今の行（プロンプト）を描き直す
    const sameWidth = spare.cols === Math.max(2, size.cols)
    if (!sameWidth) session.history = new TerminalHistory()
    try {
      session.pty.resize(Math.max(2, size.cols), Math.max(1, size.rows))
    } catch {
      /* 寸法は表示したときに合わせ直す */
    }
    const title = customTitle?.trim() || `${session.id.slice(1)}: ${shellLabel(resolveShell().file)}`
    session.info.title = title
    flow('terminal create', { kind: 'shell', start: 'prewarmed' })
    return { id: session.id, title, agent: null, cwd, history: session.history.snapshot() }
  }

  /**
   * タブを1つ開く。cwd を省略すると開いているプロジェクトのフォルダ。
   * agent を指定すると、ログインシェルが立ち上がった最初のプロンプトでそのAgentを起動する
   * （Agentを終了するとシェルに戻る。Orcaと同じ）。
   */
  /** extraArgs は main だけが渡す（決まった起動の preset。renderer からは渡せない） */
  async create(options: TerminalCreateOptions, internal: { extraArgs?: readonly string[] } = {}): Promise<TerminalTabInfo> {
    const { size, agent } = options
    if (this.disposed) throw new UserFacingError(t('terminal.errors.shuttingDown'))
    this.lastSize = { cols: size.cols, rows: size.rows }
    const nodePty = await loadNodePty()
    // アカウントのログインは、プロジェクトではないフォルダで動かす（プロジェクトに置かれた同じ名前のコマンドを拾わない。security-4 [1]）
    const cwd = options.accountLogin ? homedir() : options.cwd && existsSync(options.cwd) ? options.cwd : this.cwd
    // SSH のプロジェクト：ssh -t -- <host> 'cd <path> && exec "$SHELL" -l'。Agent の起動はリモートの最初のプロンプトで打ち込む。
    // アカウントのログインは SSH のプロジェクトでも手元で動かす（security-5 [3]）
    const sphere = executionSphere({ accountLogin: Boolean(options.accountLogin), remote: this.remote })
    // 素のシェルのタブは、先に起動しておいたシェルを渡す（rc を待たない）。次の分は裏で起動しておく
    const plainShell = !options.accountLogin && !agent && !options.command?.trim() && sphere.kind === 'local'
    if (plainShell) {
      const claimed = this.claimSpare(cwd, size, options.title ?? undefined)
      this.scheduleSpare(size)
      if (claimed) return claimed
    }
    let shell = sphere.kind === 'ssh' ? sshShellSpec(sphere.target) : resolveShell()
    const startupShell = startupShellForPath(shell.file)
    let extraEnv: Record<string, string> = {}
    let pendingWrite: string | null = null
    let loginTitle: string | null = null
    /** 起動したアカウント（Claude Code / Codex）と、前の会話を続ける引数で起動したか（タブを戻すときに使う） */
    let accountId: string | null | undefined
    let resumed = false
    // 起動コマンドを、シェルの最初のプロンプトで実行させる（Agent・アカウントのログイン共通）
    const deliver = (command: string, env: Record<string, string>): void => {
      const delivery = planStartupDelivery(shell, command)
      shell = delivery.shell
      // 選んだアカウントの設定フォルダ（CLAUDE_CONFIG_DIR / CODEX_HOME）。起動の仕組みの変数を優先する
      extraEnv = { ...env, ...delivery.env }
      if (delivery.kind === 'write') pendingWrite = command
    }
    // 組み込みの Agent とログインは、決まりを通した argv の実行ファイルを信頼できる絶対パスにして起動する。
    // 見つからなければ起動しない（security-4 [1]・security-5 [5]）。リモートでは、リモートのシェルで同じ決まりで探す
    const trusted = async (argv: readonly string[], label: string): Promise<string> => {
      if (sphere.kind === 'ssh') return remoteTrustedLaunchLine(argv)
      const resolve = async (fresh: boolean) =>
        resolveTrustedExecutable(argv[0] ?? '', { env: ptyEnv(), cwd, dirs: process.platform === 'win32' ? undefined : await searchDirs({ fresh }) })
      // 前回の起動のログインシェルの PATH で待たずに探す。見つからなければ今回の PATH を待って探し直す（agentDetection.ts）
      let resolved = await resolve(false)
      if (!resolved.ok && shellPathIsProvisional()) resolved = await resolve(true)
      if (!resolved.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: t('settings.agents.notFound') }))
      return trustedLaunchLine(resolved.path, argv.slice(1), startupShell)
    }
    if (options.accountLogin) {
      const login = buildAccountLoginLaunch(options.accountLogin, startupShell)
      loginTitle = login.title
      deliver(await trusted(login.argv, login.title), login.env)
    } else if (agent) {
      const settings = currentSettings()
      const prefs = settings.agents
      // 組み込みは launch の設定、カスタムは登録した command / args
      const configured = isBuiltinAgent(agent) ? prefs.launch[agent] : findCustomAgent(prefs, agent)
      if (!configured) throw new UserFacingError(t('terminal.errors.unknownAgent', { agent: agentLabel(agent, prefs) }))
      // 権限確認を省くか・フォルダの信頼を書くかは、ここ（main）で決める（設定の skipPermissions）。
      // 組み込みは設定を一度だけ argv に分けてから決まりを当て、決まりを通した argv だけで起動する（security-5 [2]）
      const projectId = registeredProjectIdFor(cwd, settings.projects)
      const label = agentLabel(agent, prefs)
      let launchLine: string
      let trustFolder = false
      // 前と同じアカウントで開く（タブを戻したとき）。指定が無ければ今選んでいるアカウント
      accountId = tabAccountId(agent, options.accountId)
      const accountEnv = resolveAgentEnvForAccount(agent, accountId)
      if (isBuiltinAgent(agent)) {
        // 会話を続けて起動する（タブを戻したとき）。Claude Code は続ける会話がこのフォルダに無ければ普通に起動する。
        // SSH のプロジェクトでは手元から会話を確かめられないので、Claude Code は続けない
        const resume = options.resume === true && (agent !== 'claude' ||
          (sphere.kind !== 'ssh' && hasClaudeConversation(cwd, accountEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR)))
        const policy = resolveAgentLaunchPolicy({ agent, command: configured.command, args: configured.args, projectId, skipPermissions: prefs.skipPermissions, shell: startupShell, resume })
        if (!policy.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: policy.error }))
        trustFolder = policy.trustFolder
        resumed = policy.resumed === true
        launchLine = await trusted([...policy.argv, ...(internal.extraArgs ?? [])], label)
      } else {
        // カスタムの Agent は利用者が書いたコマンドそのまま（引数だけ語に分けて引用し直す）
        const custom = buildAgentLaunchCommand(agent, configured, startupShell)
        if (!custom.ok) throw new UserFacingError(t('terminal.errors.launch', { agent: label, error: custom.error }))
        launchLine = custom.command
      }
      // パンくず：自作の Agent は名前を出さない（利用者が付けた名前を送らない）
      flow('agent launch', { agent: isBuiltinAgent(agent) ? agent : 'custom' })
      // 権限確認を省いて起動するときは、登録したプロジェクトのフォルダについて Claude Code / Codex の「このフォルダを信頼しますか」も先に書いておく
      // （書く先はアカウント切り替えの CLAUDE_CONFIG_DIR / CODEX_HOME を含む、起動する環境のもの）。
      // 切にしていれば書かず、エージェント自身にフォルダのパスを見せて聞かせる
      if (trustFolder) {
        await applyAgentWorkspaceTrust({
          agent,
          cwd,
          projectFolders: settings.projects.map((project) => project.folderPath),
          env: ptyEnv(accountEnv)
        })
      }
      deliver(launchLine, accountEnv)
    } else if (options.command?.trim()) {
      // CLI のインストール（設定の「CLI」の一覧から）は E2E では本物を走らせない（oneShotCommand が差し替える）
      const line = options.exitWhenDone || isKnownCliInstallCommand(options.command) ? oneShotCommand(options.command) : options.command.trim()
      deliver(options.exitWhenDone ? exitWhenDoneCommand(line, shell.file) : line, {})
    }
    const id = `t${++this.seq}`
    // 判定モデルの中継の URL など（このタブに結び付ける）。用意できなくてもタブは開く（指示文の受け入れ確認が使えないだけ）
    const launchEnv = this.launchEnv ? await this.launchEnv({ agent: agent ? agentLabel(agent, currentSettings().agents) : null, sessionId: id }).catch((err: unknown) => {
      reportHandled(err, { area: 'terminal', op: 'prepare decision env' })
      return {}
    }) : {}
    // 待っている間（実行ファイルを探す・フォルダの信頼を書く・判定モデルの環境）に終了が始まった：起動しない。
    // 終了の後始末はその時点の PTY しか待たないので、ここで起動すると Node の環境の解体中に PTY の終了通知が届き、
    // main がネイティブに落ちる（FERRET-20：起動時にタブを戻している途中で閉じた Windows の cpp-exception）
    if (this.disposed) {
      this.onSessionClosed?.(id)
      throw new UserFacingError(t('terminal.errors.shuttingDown'))
    }
    let pty: ReturnType<typeof nodePty.spawn>
    try {
      pty = nodePty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, size.cols),
        rows: Math.max(1, size.rows),
        cwd,
        env: ptyEnv({ ...launchEnv, ...extraEnv })
      })
      hardenWindowsPty(pty)
    } catch (err) {
      // シェルの名前だけを付ける（パスは送る前に落とす。src/main/telemetry.ts）
      reportMainError(err, { kind: 'pty-spawn', shell: shellLabel(shell.file) })
      this.onSessionClosed?.(id)
      throw err
    }
    const title =
      loginTitle ??
      (options.title?.trim() || (agent ? agentLabel(agent, currentSettings().agents) : `${id.slice(1)}: ${shellLabel(shell.file)}`))
    const launched = options.accountLogin?.agent ?? agent ?? null
    const session: Session = { id, pty, buffer: [], bufferBytes: 0, timer: null,
      tail: '', readiness: new ComposerReadiness(), sending: false,
      info: { id, pid: pty.pid, cwd, title, agent: launched }, history: new TerminalHistory(), unacked: 0, paused: false }
    this.sessions.set(id, session)
    if (agent) this.failover?.launched(id, agent, options.failoverToken ?? null, accountId)
    this.onCreated?.(id, options)
    this.wirePty(session, pendingWrite, launched)
    flow('terminal create', { kind: launched ? 'agent' : 'shell' })
    // 次に開く素のシェルを裏で先に起動しておく（Agent のタブを開いたあとも）
    this.scheduleSpare(size)

    return { id, title, agent: launched, cwd, ...(accountId !== undefined ? { accountId } : {}), ...(resumed ? { resumed } : {}) }
  }

  /** PTY の出力と終了をセッションにつなぐ（普通に開いたタブと、先に起動しておいたシェルで共通） */
  private wirePty(session: Session, pendingWrite: string | null, launched: TuiAgent | null): void {
    const { id, pty } = session
    const stopStartupWrite = pendingWrite ? this.scheduleStartupWrite(session, pendingWrite) : null
    pty.onData((data) => {
      stopStartupWrite?.touch()
      this.enqueue(session, data)
    })
    pty.onExit(({ exitCode }) => {
      // パンくず：Agent の異常終了（exit code≠0）が、このあとの失敗の手がかりになる
      flow('terminal exit', { exitCode, kind: launched ? (isBuiltinAgent(launched) ? launched : 'custom') : 'shell' })
      releaseWindowsConout(pty)
      stopStartupWrite?.cancel()
      // 渡す前に終わった先の起動のシェル（rc の中の exit など）。次は普通に開く
      if (this.spare?.session === session) this.spare = null
      this.flush(session)
      this.sessions.delete(id)
      this.hidden.delete(id)
      this.awaitingExit.delete(id)
      this.onSessionClosed?.(id)
      this.failover?.closed(id)
      this.onExit(id, exitCode)
      this.notifyExitWaiters()
    })
  }

  /**
   * シェルの今のカレント（分割したペインに引き継ぐ）。シェルの中で cd していればその場所。
   * 調べられなければ開いたときのカレント
   */
  async currentCwd(id: string): Promise<string | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    return (await resolveProcessCwd(session.pty.pid)) || session.info.cwd
  }

  /** 開いているターミナルの一覧（読み取り専用。CPU・メモリの集計は呼び出し側が pid で行う） */
  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }))
  }

  /**
   * 画面を読み込み直したあと、生きているターミナルにつなぎ直す。新しくは作らず、直近の出力を返す。
   * 送りかけの出力は先に流して、履歴と画面への転送が重ならないようにする。終了していれば null
   */
  attach(id: string): TerminalAttachInfo | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.flush(session)
    return { ...session.info, history: session.history.snapshot(), size: { cols: session.pty.cols, rows: session.pty.rows } }
  }

  /**
   * フックを差し込めないシェル向け。最初の出力のあと出力が止まったら（＝プロンプトが出たら）
   * 起動コマンドを打ち込む。Orca が準備完了を待てないときに待ち時間で書き込むのと同じ考え方。
   */
  private scheduleStartupWrite(session: Session, command: string): { touch: () => void; cancel: () => void } {
    let done = false
    let quietTimer: NodeJS.Timeout | null = null
    const fire = (): void => {
      if (done) return
      done = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(deadline)
      if (this.sessions.get(session.id) === session) session.pty.write(`${command}\r`)
    }
    const deadline = setTimeout(fire, STARTUP_WRITE_TIMEOUT_MS)
    return {
      touch: () => {
        if (done) return
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(fire, STARTUP_WRITE_QUIET_MS)
      },
      cancel: () => {
        done = true
        if (quietTimer) clearTimeout(quietTimer)
        clearTimeout(deadline)
      }
    }
  }

  private enqueue(session: Session, data: string): void {
    session.history.push(data)
    // 色などの制御を外すのは1回だけ（どのターミナルの出力も main で毎回通る）
    const plain = stripAnsi(data)
    this.failover?.output(session.id, plain)
    session.tail = (session.tail + plain).slice(-8000)
    session.title = parseTitle(data) ?? session.title
    session.readiness.push(data)
    // 先に起動しておいたシェル：どのタブにも渡していないので送らない（渡すときに履歴をまとめて返す）
    if (session.spare) return
    session.buffer.push(data)
    session.bufferBytes += data.length
    while (session.bufferBytes > MAX_BUFFER && session.buffer.length > 1) {
      const dropped = session.buffer.shift()
      session.bufferBytes -= dropped?.length ?? 0
    }
    const delay = flushDelayMs(this.hidden.has(session.id), session.bufferBytes)
    if (session.timer) {
      // 裏のターミナルで 1 回分を超えてたまった。待たずに送る（古い出力を捨てない）
      if (delay === FLUSH_INTERVAL_MS && session.timerDelay !== FLUSH_INTERVAL_MS) this.flush(session)
      return
    }
    session.timerDelay = delay
    session.timer = setTimeout(() => this.flush(session), delay)
  }

  /**
   * 画面に出ているターミナル（renderer の terminal:visible）。それ以外の今あるターミナルは出力をゆっくりまとめる。
   * 見えるようになったターミナルは、ためていた出力をすぐ送る（表示を切り替えた直後に古い画面を見せない）
   */
  setVisible(ids: readonly string[]): void {
    const shown = new Set(ids)
    const hidden = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.spare || shown.has(session.id)) continue
      hidden.add(session.id)
    }
    const revealed = [...this.hidden].filter((id) => !hidden.has(id))
    this.hidden = hidden
    for (const id of revealed) {
      const session = this.sessions.get(id)
      if (session?.timer) this.flush(session)
    }
  }

  private flush(session: Session): void {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
      session.timerDelay = undefined
    }
    if (session.buffer.length === 0) return
    let payload = session.buffer.join('')
    session.buffer = []
    session.bufferBytes = 0
    if (payload.length > MAX_CHUNK) {
      const rest = payload.slice(MAX_CHUNK)
      payload = payload.slice(0, MAX_CHUNK)
      session.buffer.push(rest)
      session.bufferBytes = rest.length
      // 残りは見えているかに関わらず次のフレームで送る（ためたまま次の出力を待たない）
      session.timerDelay = FLUSH_INTERVAL_MS
      session.timer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS)
    }
    this.onData(session.id, payload)
    session.unacked += payload.length
    if (!session.paused && session.unacked > FLOW_HIGH_WATER && this.sessions.get(session.id) === session) {
      session.paused = true
      try {
        session.pty.pause()
      } catch {
        /* すでに終了している */
      }
    }
  }

  /** renderer が出力を描き終えた（terminal:ack）。止めていた PTY は、未処理が減ったら再開する */
  ack(id: string, chars: number): void {
    const session = this.sessions.get(id)
    if (!session || !Number.isFinite(chars) || chars <= 0) return
    session.unacked = Math.max(0, session.unacked - chars)
    if (session.paused && session.unacked < FLOW_LOW_WATER) this.resumeFlow(session)
  }

  /** 画面を読み込み直した。前の画面に送った出力の ack は来ないので、数え直して全部再開する */
  resetFlow(): void {
    // 前の画面が知らせた表示の状態も忘れる（新しい画面がつなぎ直してから知らせ直す）
    this.hidden.clear()
    for (const session of this.sessions.values()) {
      session.unacked = 0
      if (session.paused) this.resumeFlow(session)
    }
  }

  private resumeFlow(session: Session): void {
    session.paused = false
    try {
      session.pty.resume()
    } catch {
      /* すでに終了している */
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.failover?.input(id, data)
    session.pty.write(data)
  }

  /** 画面の末尾のテキスト（renderer が送った表示、無ければ出力の末尾）。上限の確かめと引き継ぎの指示文に使う */
  screenText(id: string): string {
    const session = this.sessions.get(id)
    return session ? (session.screen?.text ?? session.tail) : ''
  }

  updateScreen(id: string, text: string): void {
    const session = this.sessions.get(id)
    if (session && session.screen?.text !== text.slice(-10000)) session.screen = { text: text.slice(-10000), at: Date.now() }
  }

  async agentState(id: string): Promise<{ kind: AgentKind; state: string; agent: TuiAgent | null }> {
    const session = this.sessions.get(id)
    if (!session) return { kind: 'unknown', state: 'unknown', agent: null }
    const prefs = currentSettings().agents
    // PTY が終わったあとは process が undefined になる（node-pty。前面には何も居ない扱い）
    const command = session.pty.process ?? ''
    const windows = process.platform === 'win32'
    // node-pty の Windows 版の process は端末名（xterm-256color）で、前面のプロセスを表さない
    let agent = windows ? null : agentForProcess(command, prefs)
    // 名前で決まらないとき（npm 版は node、公式インストーラの Claude Code は版番号、ラッパーのスクリプトなど）は、
    // シェルの子から1段ずつコマンド行を見て同定する（agent/processTree.ts）。シェルに戻っていれば何も居ない
    let foreground = !isShellProcess(command)
    if (windows) {
      // Windows はシェルの子を見る。一覧が取れなければ、起動時の Agent で判断する（下）
      const rows = await windowsProcessRows().catch(() => null)
      if (rows) {
        foreground = hasForegroundChild(rows, session.pty.pid)
        if (foreground) agent = agentInProcessTree(rows, session.pty.pid, (line) => agentForProcess(line, prefs))
      }
    }
    // シェルに戻ったら忘れる（同じ名前の別のプロセス、例えば node で動く別のスクリプトを Agent と取り違えない）
    if (!foreground) session.agentLookup = undefined
    if (!agent && foreground && process.platform !== 'win32') {
      const cached = session.agentLookup
      if (cached && cached.command === command && Date.now() - cached.at < AGENT_LOOKUP_RETRY_MS) {
        agent = cached.agent
      } else {
        try {
          agent = agentInProcessTree(await processRows(), session.pty.pid, (line) => agentForProcess(line, prefs))
          session.agentLookup = { command, agent, at: Date.now() }
        } catch { /* ps が使えなければ下の起動時の Agent で判断する */ }
      }
    }
    // Agent として開いたタブで、シェルではない何かが前面で動いていれば、その Agent とみなす
    // （独自のラッパーや、名前を変えて動く版でも送れるように。シェルに戻っていれば送らない）。
    // いちど Agent が終わってシェルに戻ったら、以後はこの推定をしない（agent/launchPhase.ts。Orca #6355）
    if (session.info.agent) session.launchAgent = nextLaunchAgentPhase(session.launchAgent, foreground)
    if (!agent && foreground && session.info.agent && session.launchAgent !== 'ended') agent = session.info.agent
    const kind: AgentKind = agent === 'claude' ? 'claude-code' : agent === 'codex' ? 'codex' : agent ? 'generic' : 'unknown'
    return { kind, agent, state: kind === 'unknown' ? 'unknown' : detectState(kind, { title: session.title, tail: session.screen?.text ?? session.tail }) }
  }

  /**
   * 複数のターミナルの状態をまとめて調べる（renderer の毎秒の問い合わせを1回の IPC に。terminal:agentStates）。
   * ps の結果は processRows が使い回すので、タブの数だけ ps を起動しない。返す順は ids と同じ
   */
  async agentStates(ids: readonly string[]): Promise<Array<{ kind: AgentKind; state: string; agent: TuiAgent | null }>> {
    return Promise.all(ids.map((id) => this.agentState(id)))
  }

  /** その Agent が動いている、同じプロジェクトのターミナル（待機中を先に）。無ければ null */
  async findAgentTerminal(agent: TuiAgent, projectDir: string | null, exclude: string | null = null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].filter((session) => session.id !== exclude).map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(null, candidates.filter((c) => c.agent === agent), projectDir)
  }

  /**
   * 「Agentへ送信」の宛先。選んでいるターミナルに Agent が居なければ、同じプロジェクトの Agent のターミナル。
   * どこにも居なければ null（agent/sendTarget.ts）
   */
  async resolveSendTarget(preferred: string | null, projectDir: string | null): Promise<string | null> {
    const candidates = await Promise.all([...this.sessions.values()].map(async (session) => ({
      id: session.id, cwd: session.info.cwd, ...(await this.agentState(session.id))
    })))
    return chooseSendTarget(preferred, candidates, projectDir)
  }

  async sendReview(id: string, text: string): Promise<{ ok: boolean; message: string; submitted?: boolean }> {
    const session = this.sessions.get(id)
    if (!session) return { ok: false, message: t('terminal.send.openTerminal') }
    if (session.sending) return { ok: false, message: t('terminal.send.busy') }
    const { kind, agent } = await this.agentState(id)
    if (kind === 'unknown') return { ok: false, message: t('terminal.send.noAgent') }
    // Enter で送信されると確かめていない Agent は、貼り付けるだけにする（@shared/sendTarget）
    const submit = agentSubmitsPaste(agent)
    // Claude Code / Codex 以外は待機中の見え方を知らないので、確認待ちでなく、出力が落ち着いていれば送る
    // （Orca が個別の合図を持たないエージェントに使う quiet-render と同じ考え方）。結果は「確かめられない」と伝える
    const generic = kind === 'generic'
    // 作業中の Agent にもそのまま送る（Claude Code・Codex は作業中に受けた入力を積んでおき、今の作業のあとに読む）。
    // 入力欄が落ち着くのを待って断ることはしない。断るのは許可・質問の確認を出しているときだけ（本文が答えとして入ってしまう）。
    // 起動の直後など入力欄がまだ出ていないときだけ、少し（最大 5 秒）待ってから送る
    const deadline = Date.now() + 5000
    let queued = false
    while (session.readiness.status() !== 'ready') {
      const state = await this.agentState(id)
      if (state.state === 'blocked') return { ok: false, message: t('terminal.send.blocked') }
      if (state.state === 'working') { queued = true; break }
      const quiet = session.screen && Date.now() - session.screen.at >= 1500
      if (quiet && (state.state === 'idle' || (generic && state.state === 'unknown'))) break
      if (Date.now() >= deadline) break
      await delay(100)
    }
    session.sending = true
    try {
      const result = await sendToAgent({ text, submit,
        terminal: { write: (data) => { if (!this.sessions.has(id)) throw new UserFacingError(t('terminal.send.exited')); session.pty.write(data) }, onData: () => () => {} },
        getState: async () => {
          const state = (await this.agentState(id)).state
          if (state === 'blocked' || state === 'idle' || state === 'working') return state
          return generic ? 'idle' : 'unknown'
        } })
      if (result.ok) this.failover?.sent(id, text)
      if (result.ok && !result.submitted) return { ok: true, submitted: false, message: t('terminal.send.pastedNoEnter', { agent: agentLabel(agent, currentSettings().agents) }) }
      return { ok: result.ok, submitted: result.ok, message: result.ok ? t(queued ? 'terminal.send.queued' : generic ? 'terminal.send.doneUnverified' : 'terminal.send.done') : result.message }
    } finally { session.sending = false }
  }

  resize(id: string, size: TerminalSize): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.lastSize = { cols: size.cols, rows: size.rows }
    try {
      session.pty.resize(Math.max(2, size.cols), Math.max(1, size.rows))
    } catch (err) {
      // ウィンドウ縮小の途中で不正な値になることがある。無視して次のリサイズを待つ
      console.warn(`[terminal] resize 失敗 ${id}`, err)
    }
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.flush(session)
    this.sessions.delete(id)
    this.hidden.delete(id)
    // 閉じた時点で、このタブに渡した合言葉などを無効にする（SIGHUP を無視するシェルや残った子プロセスに使わせない）
    this.onSessionClosed?.(id)
    this.failover?.closed(id)
    // kill してから onExit が届くまでを「後始末中」として数える。
    // 子孫PIDは、シェルが死んで辿れなくなる前のものを控えておく。
    const descendants = killPtyTree(session.pty, 'SIGHUP')
    this.awaitingExit.set(id, { pty: session.pty, descendants })
  }

  private notifyExitWaiters(): void {
    if (this.awaitingExit.size > 0) return
    for (const waiter of [...this.exitWaiters]) waiter()
  }

  /**
   * すべてのPTYを終了する（終了通知は待たない）。
   *
   * アプリ終了の直前ではなく、できるだけ早い段階で呼ぶこと。
   * node-pty は exit を ThreadSafeFunction でJSへ返すため、Nodeの環境クリーンアップ
   * （`Environment::RunCleanup`）に重なると napi 呼び出しに失敗し、
   * 例外が外へ投げられてプロセスが abort する（SIGABRT）。
   */
  disposeAll(): void {
    this.disposed = true
    this.discardSpare()
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /**
   * すべてのPTYを終了し、**各PTYの onExit が届くまで待つ**。
   *
   * ここで待たずに Node の環境解体へ進むと、node-pty の ThreadSafeFunction が
   * 解体中に発火して abort する（SIGABRT）。
   *
   * 既定の kill は SIGHUP で、`trap '' HUP` のように無視するシェルでは終了しない。
   * そこで `escalateAfterMs` で SIGKILL に切り替え、それでも届かない場合は
   * `timeoutMs` で打ち切る（打ち切りの扱いは呼び出し側が決める）。
   */
  disposeAllAndWait(
    options: { escalateAfterMs?: number; timeoutMs?: number } = {}
  ): Promise<{ clean: boolean; pending: number; waitedMs: number }> {
    const escalateAfterMs = options.escalateAfterMs ?? 500
    const timeoutMs = options.timeoutMs ?? 2000
    const startedAt = Date.now()

    this.disposeAll()
    if (this.awaitingExit.size === 0) {
      return Promise.resolve({ clean: true, pending: 0, waitedMs: 0 })
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (clean: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(escalateTimer)
        clearTimeout(giveUpTimer)
        this.exitWaiters.delete(waiter)
        resolve({
          clean,
          pending: this.awaitingExit.size,
          waitedMs: Date.now() - startedAt
        })
      }
      const waiter = (): void => finish(true)

      // SIGHUP を無視するシェルが残っていたら、強制終了に切り替える
      const escalateTimer = setTimeout(() => {
        for (const entry of this.awaitingExit.values()) {
          killPtyTree(entry.pty, 'SIGKILL', entry.descendants)
        }
      }, escalateAfterMs)
      escalateTimer.unref?.()

      // 打ち切るときは、終了の通知が来なかった PTY の出力用の Worker（Windows。main の中の V8 のスレッド）を片付けてから返す。
      // 生きた Worker を残したまま Node の環境の解体に入らない（FERRET-1Q の候補）
      const giveUpTimer = setTimeout(() => {
        for (const entry of this.awaitingExit.values()) releaseWindowsConout(entry.pty)
        finish(false)
      }, timeoutMs)
      giveUpTimer.unref?.()

      this.exitWaiters.add(waiter)
    })
  }
}

/**
 * あるプロセスの子孫のPIDを列挙する（POSIX）。
 *
 * シェルを落とすと子プロセスの親は init に付け替えられ、辿れなくなる。
 * そのため kill の**前**に呼び、結果を控えておく。
 */
/** 直前の ps の結果。終了時に全部のタブを続けて閉じるとき、タブの数だけ同期の ps で main を止めない */
let psListingCache: { at: number; listing: string } | null = null
const PS_LISTING_REUSE_MS = 500

function descendantPids(root: number): number[] {
  let listing: string
  try {
    if (psListingCache && Date.now() - psListingCache.at < PS_LISTING_REUSE_MS) listing = psListingCache.listing
    else {
      // 同期の ps（main が止まる）。重ければ手がかりとして控える
      listing = timedSync('ps', () => execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 }))
      psListingCache = { at: Date.now(), listing }
    }
  } catch (err) {
    // 子プロセスを数えられないだけで、終了処理は pty.kill で続ける
    // 失敗の文は ps の stderr を含むので、種類だけを送る
    reportHandled(errorKind(err), { area: 'terminal', op: 'list child processes' })
    return []
  }

  const children = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!matched) continue
    const pid = Number(matched[1])
    const ppid = Number(matched[2])
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }

  const found: number[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as number
    for (const child of children.get(current) ?? []) {
      // 念のため自分自身とinitは触らない
      if (child <= 1 || child === process.pid) continue
      found.push(child)
      stack.push(child)
    }
  }
  return found
}

/**
 * PTYにぶら下がるプロセスを、シェルだけでなくまとめて終了させる。
 *
 * `pty.kill()` はシェル本体にしかシグナルを送らない。対話シェルはジョブ制御で
 * 実行中のコマンド（`sleep`、起動中のAgent など）を**別のプロセスグループ**に置くため、
 * シェルを落としてもそれらは孤児として残る。ユーザーから見れば「アプリを終了したのに
 * Agentが動き続けている」状態になり、PTYのスレーブ側も掴まれたままになる。
 *
 * そこで、シェルの子孫を先に落としてから、シェル自身のプロセスグループを落とす。
 * Windows には同じ概念が無い。node-pty の `kill()` はコンソールに付いたものしか畳まないので、
 * 先に taskkill /T でシェルの子孫ごと終わらせてから `kill()` する（windowsTreeKill.ts）。
 *
 * @param known 以前に列挙した子孫。シェルが先に死んで辿れなくなった場合に使う
 */
function killPtyTree(pty: IPty, signal: NodeJS.Signals, known: readonly number[] = []): number[] {
  if (process.platform === 'win32') {
    // 同じ PTY の kill は1回だけ（閉じるときの taskkill の後と、終了時の強制終了の両方から来る）。
    // node-pty の kill は毎回ネイティブの表を引き、コンソールのプロセス一覧を取る子プロセスも起動する
    const killPty = () => {
      if (killedWindowsPtys.has(pty)) return
      killedWindowsPtys.add(pty)
      try {
        pty.kill()
      } catch {
        /* すでに終了している */
      }
    }
    // 強制終了（終了時の切り替え）は待たずに閉じる。taskkill は最初の1回だけ
    const command = signal === 'SIGKILL' ? null : windowsTreeKillCommand(pty.pid, process.env.SystemRoot)
    if (!command) killPty()
    // 子孫が無い・すでに終わっているときも taskkill は失敗で返るだけ。どちらでも ConPTY を閉じる
    else execFile(command.file, command.args, { timeout: 3000, windowsHide: true }, killPty)
    return []
  }

  const descendants = [...new Set([...known, ...descendantPids(pty.pid)])]
  for (const pid of descendants) {
    try {
      process.kill(pid, signal)
    } catch {
      /* すでに終了している */
    }
  }

  try {
    process.kill(-pty.pid, signal)
  } catch {
    try {
      pty.kill(signal)
    } catch {
      /* すでに終了している */
    }
  }

  return descendants
}

/**
 * Windows の node-pty の中（WindowsPtyAgent）の resize・kill を包む。
 * - 同じ PTY の kill は1回だけにする。2回目の kill は ConPTY のハンドルを二重に閉じ、main がネイティブに落ちる
 *   （ヒープ破損 0xC0000374。0.4.18 の前に Windows の VM で node-pty 1.1.0・1.2.0-beta.15 の両方で再現した。
 *   0.4.16 は終了時に taskkill の後の kill と、強制終了への切り替えの kill が重なっていた）
 * - node-pty は最初の出力が届くまで resize・kill を後回しにし、最初の出力の 'data' の中でまとめて実行する。
 *   そのときにはシェルがもう終わっていると、resize は「Cannot resize a pty that has already exited」を投げ、
 *   呼び出し側の try/catch の外（ソケットのイベントの中）なので main の捕まえていない例外になる。投げさせない
 */
export function hardenWindowsPty(pty: IPty, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  const agent = (pty as unknown as { _agent?: Record<string, unknown> })._agent
  if (!agent) return
  let killed = false
  for (const name of ['resize', 'kill'] as const) {
    const original = agent[name]
    if (typeof original !== 'function') continue
    agent[name] = (...args: unknown[]) => {
      if (name === 'kill') {
        if (killed) return undefined
        killed = true
      }
      try {
        const call = () => (original as (...a: unknown[]) => unknown).apply(agent, args)
        // kill は ConPTY を閉じる（ClosePseudoConsole）・コンソールのプロセス一覧を取る子プロセスを起こすところまで main で同期に動く。
        // ターミナルを閉じた数秒後の止まり（FERRET-M の 0.6.30 の Windows：terminal close の後に 3.2s）の手がかりとして時間を控える
        return name === 'kill' ? timedSync('pty:kill', call) : call()
      } catch {
        // 終わった PTY への resize・kill（想定内）
        return undefined
      }
    }
  }
}

/** Windows で kill 済みの PTY（killPtyTree の二重の kill を防ぐ） */
const killedWindowsPtys = new WeakSet<IPty>()

/**
 * Windows: シェルが自分で終わったときも、node-pty が PTY ごとに main に作る出力用の Worker（V8 をもう1つ持つスレッド）を片付ける。
 * node-pty（1.2.0-beta.15 まで）はこれを kill() の中でしか片付けず、`exit` で閉じたシェル・終わったら閉じる
 * インストール・ログインのたびに main に Worker が残り続けた（メモリの増加。0.4.16 の Windows の main のクラッシュの候補）。
 * kill() は呼ばない（終わった PTY の kill はコンソールのプロセス一覧を取る子プロセスを起動する）。dispose は何度呼んでもよい。
 * 中の名前は版を固定して test/unit/terminal-windows-release.test.ts で確かめる
 */
export function releaseWindowsConout(pty: IPty, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return
  try {
    (pty as unknown as { _agent?: { _conoutSocketWorker?: { dispose?: () => void } } })._agent?._conoutSocketWorker?.dispose?.()
  } catch {
    /* すでに片付いている */
  }
}

function shellLabel(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file
  return base.replace(/\.exe$/i, '')
}
