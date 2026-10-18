/**
 * Codex のセキュリティスキャン5回目（security-5）のうち Agent の起動の [2][3][5] の回帰テストと、同じ穴を機械的に止める不変条件。
 *   [2] 権限確認を省く引数・フォルダの信頼の引数は、設定の skipPermissions（と引数の欄にそのまま書いたもの）からだけ入る
 *   [3] アカウントのログインは、SSH のプロジェクトを開いていても手元のホームで動く
 *   [5] macOS / Linux でも、組み込みの Agent はプロジェクトの外の絶対パスから起動する（リモートでも同じ決まりで探す）
 * node-pty は差し替え（本物のシェル・Agent は起動しない）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  SKIP_PERMISSION_AGENTS,
  bypassArgUnits,
  defaultLaunchConfig,
  sanitizeAgentPreferences
} from '../../src/shared/agentCatalog'
import { canonicalLaunchCommand, findPermissionFlags, resolveAgentLaunchPolicy } from '../../src/shared/agentPolicy'
import { remoteTrustedLaunchLine, resolveTrustedExecutable, trustedLaunchLine } from '../../src/main/agentExecutable'
import { executionSphere } from '../../src/main/executionSphere'
import type { BuiltinAgent } from '../../src/shared/types'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false } }))
vi.mock('../../src/main/telemetry', () => ({ reportMainError: vi.fn() }))
const state = vi.hoisted(() => ({ dirs: [] as string[], spawns: [] as Array<{ file: string; args: string[]; cwd: string; env: Record<string, string> }> }))
vi.mock('../../src/main/agentDetection', () => ({ searchDirs: async () => state.dirs, shellPathIsProvisional: () => false }))
vi.mock('../../src/main/accounts', () => ({
  buildAccountLoginLaunch: () => ({ argv: ['claude', 'auth', 'login', '--claudeai'], env: {}, title: 'Claude Code login' }),
  resolveAgentEnv: () => ({}),
  resolveAgentEnvForAccount: () => ({}),
  tabAccountId: () => undefined
}))
vi.mock('../../src/main/settings', () => ({
  currentSettings: () => ({ agents: { ...DEFAULT_AGENT_PREFERENCES, startupAgents: [] }, projects: [] })
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    state.spawns.push({ file, args, cwd: options.cwd, env: options.env })
    return {
      // macOS・Linux の PID の上限より大きい、実在しない値
      pid: 4_100_000 + state.spawns.length,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
  }
}))

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const posixOnly = process.platform === 'win32' ? it.skip : it

const policy = (agent: BuiltinAgent, config: { command?: string; args?: string }, options: { skipPermissions?: boolean; projectId?: string | null } = {}) =>
  resolveAgentLaunchPolicy({
    agent,
    command: config.command ?? '',
    args: config.args ?? '',
    projectId: options.projectId === undefined ? 'p1' : options.projectId,
    skipPermissions: options.skipPermissions ?? true,
    shell: 'posix'
  })

/** argv の中の、権限確認を省く引数・フォルダの信頼の引数 */
const grants = (agent: BuiltinAgent, argv: string[]) => findPermissionFlags(agent, argv.slice(1)).filter((m) => m.kind !== 'mode')

// ───────────────────────── [2] ─────────────────────────

describe('security-5 [2] 権限確認を省く引数・フォルダの信頼は、明示の設定からだけ入る', () => {
  it('カタログの既定の起動コマンドには、権限やフォルダの信頼のフラグが無い（実行ファイルとサブコマンドだけ）', () => {
    for (const agent of BUILTIN_AGENTS) {
      const command = canonicalLaunchCommand(agent, defaultLaunchConfig(agent).command, 'posix')
      expect(command.ok, agent).toBe(true)
      const words = command.ok ? command.words.map((w) => w.value) : []
      // 画面とモデルを選ぶだけのフラグ（確かめたもの）のほかは、フラグを置かない
      const screenOrModel = (w: string): boolean => (agent === 'hermes' && w === '--tui') || (agent === 'deepseek' && ['--tui', '--provider', '-m'].includes(w))
      expect(words.slice(1).filter((w) => w.startsWith('-') && !screenOrModel(w)), agent).toEqual([])
      expect(findPermissionFlags(agent, words.slice(1)).filter((m) => m.kind !== 'mode'), agent).toEqual([])
    }
    expect(AGENT_CATALOG.muse.trustArgs).toBe('--trust-workspace')
    expect(AGENT_CATALOG['command-code'].trustArgs).toBe('--trust')
  })

  it('既定の設定で、切なら（同意が無ければ）どの Agent にも省く引数・信頼の引数を足さない', () => {
    for (const agent of BUILTIN_AGENTS) {
      const result = policy(agent, DEFAULT_AGENT_PREFERENCES.launch[agent], { skipPermissions: false })
      expect(result.ok, agent).toBe(true)
      if (result.ok) {
        expect(grants(agent, result.argv), agent).toEqual([])
        expect(result.trustFolder, agent).toBe(false)
      }
    }
  })

  it('入でも、省く引数は確かめた Agent（Claude Code / Codex）だけ。信頼の引数は登録したプロジェクトのフォルダだけ', () => {
    for (const agent of BUILTIN_AGENTS) {
      const result = policy(agent, DEFAULT_AGENT_PREFERENCES.launch[agent], { skipPermissions: true, projectId: null })
      if (!result.ok) throw new Error(agent)
      const bypass = grants(agent, result.argv).filter((m) => m.kind === 'bypass')
      expect(bypass.length > 0, agent).toBe(SKIP_PERMISSION_AGENTS.includes(agent))
      expect(grants(agent, result.argv).filter((m) => m.kind === 'trust'), agent).toEqual([])
    }
    expect(policy('muse', { args: '' }, { projectId: 'p1' })).toEqual({ ok: true, argv: ['muse', '--trust-workspace'], trustFolder: false })
    expect(policy('command-code', { args: '--model x' }, { projectId: 'p1' })).toEqual({ ok: true, argv: ['command-code', '--trust', '--model', 'x'], trustFolder: false })
    expect(policy('muse', { args: '' }, { skipPermissions: false })).toEqual({ ok: true, argv: ['muse'], trustFolder: false })
  })

  it('以前の既定（コマンドの欄に信頼の引数）の保存された設定は、今の既定のコマンドに戻す', () => {
    const prefs = sanitizeAgentPreferences({ skipPermissions: false, launch: {
      muse: { command: 'muse --trust-workspace', args: '' }, 'command-code': { command: 'command-code --trust', args: '--model x' } } })
    expect(prefs.launch.muse).toEqual({ command: 'muse', args: '' })
    expect(prefs.launch['command-code']).toEqual({ command: 'command-code', args: '--model x' })
  })

  it('コマンドの欄に書いた省く引数・信頼の引数は起動しない（欄をまたいで分けた形も）', () => {
    const cases: Array<[BuiltinAgent, string, string]> = [
      ['claude', 'claude --dangerously-skip-permissions', ''],
      ['claude', 'claude --permission-mode bypassPermissions', ''],
      ['claude', 'claude --permission-mode', 'bypassPermissions'],
      ['codex', 'codex --yolo', ''],
      ['codex', 'codex -c', 'approval_policy=never'],
      ['codex', 'codex --sandbox=danger-full-access', ''],
      ['gemini', 'gemini --dangerously-anything', ''],
      ['muse', 'muse --trust-workspace', ''],
      ['command-code', 'command-code --trust', ''],
      ['crush', 'crush --yolo', '']
    ]
    for (const [agent, command, args] of cases) {
      for (const skipPermissions of [true, false]) {
        const result = policy(agent, { command, args }, { skipPermissions })
        expect(result.ok ? 'ok' : result.reason, `${command} | ${args}`).toBe('flag-in-command')
      }
    }
    // アカウントのログインも同じ
    expect(canonicalLaunchCommand('claude', 'claude --dangerously-skip-permissions', 'posix').ok).toBe(false)
    // サブコマンドはよい
    expect(policy('rovo', {}, { skipPermissions: false })).toEqual({ ok: true, argv: ['acli', 'rovodev', 'run'], trustFolder: false })
  })

  it('引用符・バックスラッシュ・= や値をくっつけた形で書き換えたものは起動しない', () => {
    const cases: Array<[BuiltinAgent, string]> = [
      ['claude', '"--dangerously-skip-permissions"'],
      ['claude', "'--dangerously-skip-permissions' --chrome"],
      ['claude', '--danger\\ously-skip-permissions'],
      ['claude', '--dangerously-skip-permissions""'],
      ['claude', '--permission-mode "bypassPermissions"'],
      ['claude', "--permission-mode=bypass'Permissions'"],
      ['codex', `-c 'sandbox_mode="danger-full-access"'`],
      ['codex', '--config "approval_policy = never"'],
      ['codex', '"-sdanger-full-access"'],
      ['codex', '-a "never"'],
      ['muse', '"--trust-workspace"']
    ]
    for (const [agent, args] of cases) {
      for (const skipPermissions of [true, false]) {
        const result = policy(agent, { args }, { skipPermissions })
        expect(result.ok ? 'ok' : result.reason, args).toBe('disguised-flag')
      }
    }
  })

  it('同じ意味の書き方（--config・-sVALUE・TOML の空白）も見分け、入でも省く引数を重ねない', () => {
    for (const args of ['--config approval_policy=never', '-sdanger-full-access', '-c approval_policy=never', '--sandbox=danger-full-access', '-anever']) {
      const result = policy('codex', { args })
      expect(result.ok && result.argv.join(' '), args).toBe(`codex ${args}`)
      expect(bypassArgUnits('codex').length).toBeGreaterThan(0)
    }
    // `--` の後はプロンプトなので、フラグとして読まない
    const prompt = policy('claude', { args: '--chrome -- "--dangerously-skip-permissions"' }, { skipPermissions: false })
    expect(prompt.ok && prompt.argv).toEqual(['claude', '--chrome', '--', '--dangerously-skip-permissions'])
  })

  it('引数の欄にそのまま書いたものは、利用者の明示の設定として書いたとおりに使う（SECURITY.md の Agent permissions）', () => {
    const result = policy('claude', { args: '--dangerously-skip-permissions --chrome' }, { skipPermissions: false })
    expect(result).toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions', '--chrome'], trustFolder: false })
  })

  it('不変条件: main は決まりを通した argv だけで組み込みの Agent を起動する。文字列のコマンドの組み立ては自作の Agent だけ', () => {
    const terminal = read('src/main/terminal.ts')
    expect(terminal.match(/buildAgentLaunchCommand\(/g)).toHaveLength(1)
    expect(terminal).toMatch(/\} else \{\s*\/\/ カスタムの Agent[^\n]*\n\s*const custom = buildAgentLaunchCommand\(agent, configured, startupShell\)/)
    // 後ろに足せるのは main が作る決まった起動（@shared/codexAudit）の引数だけ。権限の引数は含まない
    expect(terminal).toMatch(/launchLine = await trusted\(\[\.\.\.policy\.argv, \.\.\.\(internal\.extraArgs \?\? \[\]\)\], label\)/)
    expect(read('src/main/index.ts').match(/terminals\.create\(options, \{ extraArgs \}\)/g)).toHaveLength(1)
    // 引数の決まりは一か所だけ（catalog に古い文字列の決まりを残さない）
    expect(read('src/shared/agentCatalog.ts')).not.toMatch(/export function resolveAgentLaunchPolicy/)
    expect(read('src/main/accounts/service.ts')).toMatch(/canonicalLaunchCommand\(agent,/)
  })
})

// ───────────────────────── [3] ─────────────────────────

const REMOTE = { host: 'dev-box', path: '/srv/acme-shop' }

describe('security-5 [3] アカウントのログインは SSH のプロジェクトでも手元で動く', () => {
  it('ログインは手元、ふつうのタブと Agent は SSH', () => {
    expect(executionSphere({ accountLogin: true, remote: REMOTE })).toEqual({ kind: 'local' })
    expect(executionSphere({ accountLogin: false, remote: REMOTE })).toEqual({ kind: 'ssh', target: REMOTE })
    expect(executionSphere({ accountLogin: false, remote: null })).toEqual({ kind: 'local' })
  })

  it('不変条件: ターミナルは executionSphere の結果でだけ ssh を使う（リモートのログインの流れは無い）', () => {
    const terminal = read('src/main/terminal.ts')
    expect(terminal).toMatch(/executionSphere\(\{ accountLogin: Boolean\(options\.accountLogin\), remote: this\.remote \}\)/)
    expect(terminal.match(/sshShellSpec\(/g)).toHaveLength(1)
    expect(terminal).toMatch(/sshShellSpec\(sphere\.target\)/)
  })

  posixOnly('SSH のプロジェクトを開いていても、ログインのタブは手元のシェルで、ホームから、手元の絶対パスで動く', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-sec5-login-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(bin, 'claude'), 0o755)
      state.dirs = [bin]
      state.spawns.length = 0
      const { TerminalManager } = await import('../../src/main/terminal')
      const manager = new TerminalManager(() => {}, () => {})
      manager.setRemote(REMOTE)
      await manager.create({ size: { cols: 80, rows: 24 }, accountLogin: { agent: 'claude', accountId: 'a1' } })
      await manager.create({ size: { cols: 80, rows: 24 } })
      const [login, shell] = state.spawns
      expect(login!.file).not.toBe('ssh')
      expect(login!.cwd).toBe(homedir())
      expect(Object.values(login!.env).join('\n')).toContain(`${realpathSync(bin)}/claude auth login --claudeai`)
      expect(JSON.stringify(login)).not.toContain('dev-box')
      expect(shell!.file).toBe('ssh')
      expect(shell!.args).toContain('dev-box')
      manager.disposeAll()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ───────────────────────── [5] ─────────────────────────

describe('security-5 [5] macOS / Linux でも、組み込みの Agent はプロジェクトの外の絶対パスから起動する', () => {
  let dir: string
  let project: string
  let trusted: string
  const exe = (path: string, says: string) => {
    writeFileSync(path, `#!/bin/sh\necho ${says}\n`)
    chmodSync(path, 0o755)
  }

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-sec5-path-')))
    project = join(dir, 'acme-shop')
    trusted = join(dir, 'tools', 'bin')
    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true })
    mkdirSync(join(project, 'bin'))
    mkdirSync(trusted, { recursive: true })
    for (const p of [join(project, 'claude'), join(project, 'node_modules', '.bin', 'claude'), join(project, 'bin', 'claude'), join(project, 'codex')]) exe(p, 'PROJECT')
    exe(join(trusted, 'claude'), 'TRUSTED')
    // プロジェクトの中へのリンク（フォルダもファイルも）は、プロジェクトの中とみなす
    symlinkSync(join(project, 'bin'), join(dir, 'linked-bin'))
    mkdirSync(join(dir, 'other'))
    symlinkSync(join(project, 'codex'), join(dir, 'other', 'codex'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => { state.spawns.length = 0 })

  const resolveIn = (head: string, dirs: string[]) =>
    resolveTrustedExecutable(head, { platform: 'linux', env: {}, cwd: project, dirs, home: '/Users/taro' })

  posixOnly('`.`・空・相対・プロジェクトの中・プロジェクトへのリンクの PATH の項目からは選ばない', async () => {
    const unsafe = ['', '.', './bin', 'bin', project, join(project, 'node_modules', '.bin'), join(dir, 'linked-bin')]
    expect(await resolveIn('claude', unsafe)).toEqual({ ok: false, reason: 'not-found' })
    expect(await resolveIn('claude', [...unsafe, trusted])).toEqual({ ok: true, path: join(trusted, 'claude') })
    // 外のフォルダにあっても、実体がプロジェクトの中なら使わない
    expect((await resolveIn('codex', [join(dir, 'other')])).ok).toBe(false)
    // 相対のパスや、プロジェクトの中の絶対パスを設定に書いても使わない
    expect(await resolveIn('bin/claude', [trusted])).toEqual({ ok: false, reason: 'relative' })
    expect(await resolveIn(join(project, 'claude'), [trusted])).toEqual({ ok: false, reason: 'inside-project' })
  })

  posixOnly('起動の1行は絶対パスなので、シェルの起動ファイルが PATH・関数・alias を変えても選ばれるものは変わらない', async () => {
    const found = await resolveIn('claude', [trusted])
    if (!found.ok) throw new Error('not found')
    const line = trustedLaunchLine(found.path, ['--chrome'], 'posix')
    expect(line).toBe(`${join(trusted, 'claude')} --chrome`)
    for (const startup of [`PATH=${project}:.:$PATH`, 'claude() { echo FUNCTION; }', `alias claude='echo ALIAS'`]) {
      // 起動ファイルの後に起動の1行が続くスクリプトを、ファイルにしてシェルに読ませる（-c に一時フォルダのパスを入れない）
      const script = join(dir, 'startup-then-launch.sh')
      writeFileSync(script, `${startup}\n${line}\n`)
      const out = execFileSync('/bin/sh', [script], { cwd: project, encoding: 'utf8', env: { PATH: `${project}:/usr/bin:/bin` } })
      expect(out.trim(), startup).toBe('TRUSTED')
    }
  })

  posixOnly('SSH: リモートのシェルでも、プロジェクトの外の絶対パスの PATH の項目からだけ選んで exec する', () => {
    const line = remoteTrustedLaunchLine(['claude', '--chrome', "it's"])
    const run = (path: string) => spawnSync('/bin/sh', ['-c', line], { cwd: project, encoding: 'utf8', env: { PATH: path, HOME: '/nonexistent-home' } })
    // プロジェクトの中・相対・空・リンクの項目だけなら、見つからずに止まる（プロジェクトのものは動かない）
    const refused = run(['.', '', 'bin', project, join(project, 'node_modules', '.bin'), join(dir, 'linked-bin'), '/usr/bin', '/bin'].join(':'))
    expect(refused.status).toBe(127)
    expect(refused.stdout).not.toContain('PROJECT')
    const ok = run([project, '.', trusted, '/usr/bin', '/bin'].join(':'))
    expect(ok.stdout.trim()).toBe('TRUSTED')
    // 実体がプロジェクトの中のリンクも使わない
    const linked = spawnSync('/bin/sh', ['-c', remoteTrustedLaunchLine(['codex'])], { cwd: project, encoding: 'utf8', env: { PATH: `${join(dir, 'other')}:/usr/bin:/bin` } })
    expect(linked.stdout).not.toContain('PROJECT')
    // 名前に / を含むもの（相対・プロジェクトの中のパス）は受け付けない
    expect(spawnSync('/bin/sh', ['-c', remoteTrustedLaunchLine(['./claude'])], { cwd: project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status).toBe(127)
  })

  posixOnly('main は組み込みの Agent を、プロジェクトの外の絶対パスで起動する（プロジェクトのフォルダで開いても）', async () => {
    state.dirs = ['.', project, trusted]
    const { TerminalManager } = await import('../../src/main/terminal')
    const manager = new TerminalManager(() => {}, () => {})
    manager.setCwd(project)
    await manager.create({ size: { cols: 80, rows: 24 }, agent: 'claude' })
    const command = Object.values(state.spawns[0]!.env).find((v) => v.includes('--chrome'))
    expect(command?.startsWith(`${join(trusted, 'claude')} --dangerously-skip-permissions --chrome`)).toBe(true)
    // 見つからなければ起動しない（素の名前をシェルに探させない）
    state.dirs = [project]
    await expect(manager.create({ size: { cols: 80, rows: 24 }, agent: 'claude' })).rejects.toThrow()
  })
})
