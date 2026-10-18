/**
 * Claude Code / Codex 以外のエージェント（Orca の TUI_AGENT_CONFIG を移植したカタログ）と、カスタムエージェント。
 * CLI もシェルも起動しない（PATH の検出は一時フォルダに置いた空の実行ファイルで確かめる）。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  ORCA_SUPPORTED_AGENTS,
  agentForProcess,
  agentLabel,
  detectCommandsFor,
  firstCommandWord,
  newCustomAgentId,
  sanitizeAgentPreferences
} from '@shared/agentCatalog'
import { buildAgentLaunchCommand } from '@shared/agentLaunch'
import type { AgentPreferences } from '@shared/types'
import { listAgentOptions, resolveCommandsInDirs } from '../../src/main/agentDetection'
import { detectState } from '../../src/main/agent/state'

const prefsWithCustom: AgentPreferences = {
  ...DEFAULT_AGENT_PREFERENCES,
  customAgents: [{ id: 'custom:my-agent', name: 'My Agent', command: 'my-agent', args: '--auto' }]
}

describe('カタログ（Orca の既定値）', () => {
  it('主要なものを含み、公式ドキュメント（2026-10）どおりの検出コマンドと権限確認を省く引数を持つ', () => {
    for (const agent of ['antigravity', 'gemini', 'opencode', 'cursor', 'copilot', 'devin', 'aider', 'grok', 'qwen-code', 'amp', 'droid', 'kiro'] as const) {
      expect(BUILTIN_AGENTS).toContain(agent)
    }
    expect(AGENT_CATALOG.gemini).toMatchObject({ detectCmd: 'gemini', yoloArgs: '--approval-mode=yolo' })
    // Gemini CLI の個人ログインの終了で、Google の Agent は Antigravity（agy 1.3.4 の --help で確認）を主要に置く
    expect(AGENT_CATALOG.antigravity).toMatchObject({ detectCmd: 'agy', yoloArgs: '--dangerously-skip-permissions', popular: true })
    expect(AGENT_CATALOG.gemini.popular).toBeUndefined()
    // DeepSeek の公式の連携先（Hermes Agent・OpenClaw）を主要に置く。どちらも対話の画面を開くサブコマンドで起動する
    expect(AGENT_CATALOG.hermes).toMatchObject({ detectCmd: 'hermes', launchCmd: 'hermes --tui', yoloArgs: '--yolo', popular: true })
    expect(AGENT_CATALOG.openclaw).toMatchObject({ detectCmd: 'openclaw', launchCmd: 'openclaw chat', yoloArgs: '', popular: true })
    // Cursor の CLI は agent に改名（旧名 cursor-agent も見つける）
    expect(AGENT_CATALOG.cursor).toMatchObject({ detectCmd: 'agent', aliases: ['cursor-agent'], yoloArgs: '--force' })
    expect(AGENT_CATALOG.devin).toMatchObject({ detectCmd: 'devin', yoloArgs: '--permission-mode bypass --respect-workspace-trust false' })
    expect(AGENT_CATALOG['qwen-code']).toMatchObject({ detectCmd: 'qwen', yoloArgs: '--yolo' })
    expect(AGENT_CATALOG.grok.yoloArgs).toBe('--permission-mode bypassPermissions')
    expect(AGENT_CATALOG.aider.yoloArgs).toBe('--yes-always')
    expect(AGENT_CATALOG.opencode.yoloArgs).toBe('--auto')
    // 確かめられなかったフラグは空にしておく
    expect(AGENT_CATALOG.amp.yoloArgs).toBe('')
    expect(AGENT_CATALOG.droid.yoloArgs).toBe('')
  })

  it('どの項目も名前・検出コマンド・入れ方（コマンドかページ）を持ち、id は重ならない', () => {
    expect(new Set(BUILTIN_AGENTS).size).toBe(BUILTIN_AGENTS.length)
    expect([...BUILTIN_AGENTS].sort()).toEqual(Object.keys(AGENT_CATALOG).sort())
    for (const id of BUILTIN_AGENTS) {
      const entry = AGENT_CATALOG[id]
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(entry.label.trim(), id).not.toBe('')
      expect(entry.detectCmd, id).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(entry.homepageUrl, id).toMatch(/^https:\/\//)
      // ソースから入れるしかないもの（zcode）以外は1行の入れ方がある
      if (id !== 'zcode') expect(entry.install.trim(), id).not.toBe('')
      // Windows の入れ方は、あるなら空でなく、POSIX のシェル向け（curl … | bash / sh）や Homebrew を含まない
      if (entry.installWindows !== undefined) {
        expect(entry.installWindows.trim(), id).not.toBe('')
        expect(entry.installWindows, id).not.toMatch(/\|\s*(?:ba|z)?sh\b|^\s*sh\s+-c\b|^\s*brew\s/)
      }
      expect(typeof entry.yoloArgs).toBe('string')
    }
    // 主要なものは先頭にまとまっている
    expect(BUILTIN_AGENTS.slice(0, 10)).toEqual(['claude', 'codex', 'antigravity', 'cursor', 'copilot', 'devin', 'opencode', 'amp', 'droid', 'kiro'])
  })

  it('Orca の README「Supported Agents」のすべてに項目があり、表示名も揃っている', () => {
    // ~/bench/orca/README.md の順（Charm は製品名を添えて Charm (Crush)）
    const orcaReadme = [
      'Claude Code', 'Codex', 'Grok', 'Cursor', 'GitHub Copilot', 'Muse',
      'DeepSeek Harness', 'ZCode', 'OpenCode', 'MiMo Code', 'Amp', 'OpenClaude',
      'Antigravity', 'Pi', 'oh-my-pi', 'Hermes Agent', 'Devin', 'Goose',
      'Auggie', 'Autohand Code', 'Charm (Crush)', 'Cline', 'CodeBuddy', 'Codebuff',
      'Freebuff', 'Command Code', 'Continue', 'Droid', 'Kilocode', 'Kimi',
      'Kiro', 'Mistral Vibe', 'Qwen Code', 'Rovo Dev'
    ]
    expect(ORCA_SUPPORTED_AGENTS.map((id) => AGENT_CATALOG[id]?.label)).toEqual(orcaReadme)
    for (const id of ORCA_SUPPORTED_AGENTS) expect(BUILTIN_AGENTS).toContain(id)
    // Orca に無く足したものも残す
    for (const id of ['junie', 'openhands', 'roo', 'letta', 'forge', 'blackbox'] as const) expect(BUILTIN_AGENTS).toContain(id)
  })

  it('DeepSeek Harness は npm の dsh。端末の画面は dsh tui で、Orca の旧名でも見つける', () => {
    expect(AGENT_CATALOG.dsh).toMatchObject({ detectCmd: 'dsh', aliases: ['dsh-tui', 'dst'], launchCmd: 'dsh tui', yoloArgs: '', install: 'npm install -g @deepseek-ai/dsh' })
    expect(DEFAULT_AGENT_PREFERENCES.launch.dsh).toEqual({ command: 'dsh tui', args: '' })
    expect(agentForProcess('dsh')).toBe('dsh')
    expect(agentForProcess('dsh-tui')).toBe('dsh')
  })

  it('既定の起動コマンドはカタログから作る', () => {
    // 権限確認を省く引数は既定に入れない（security-3 [1]）
    expect(DEFAULT_AGENT_PREFERENCES.launch['qwen-code']).toEqual({ command: 'qwen', args: '' })
    expect(DEFAULT_AGENT_PREFERENCES.startupAgents).toEqual(['claude', 'codex'])
  })
})

describe('sanitizeAgentPreferences', () => {
  it('以前の形（claude / codex の launch と startupAgents だけ）を引き継ぎ、新しい項目は既定で埋める', () => {
    const prefs = sanitizeAgentPreferences({
      launch: { claude: { command: 'claude', args: '' }, codex: { command: '/opt/codex', args: '--foo' } },
      startupAgents: ['codex']
    })
    // 以前の既定（空の引数）のままなら今の既定にする
    expect(prefs.launch.claude).toEqual({ command: 'claude', args: '--chrome' })
    expect(prefs.launch.codex).toEqual({ command: '/opt/codex', args: '--foo' })
    expect(prefs.launch.gemini).toEqual({ command: 'gemini', args: '' })
    expect(prefs.customAgents).toEqual([])
    expect(prefs.disabledAgents).toEqual([])
    expect(prefs.startupAgents).toEqual(['codex'])
  })

  it('id の無いカスタムは名前とコマンドが必須。書きかけでも id があれば残す。id が壊れていれば名前から作り直し、重なりを避ける', () => {
    const prefs = sanitizeAgentPreferences({
      customAgents: [
        { id: 'custom:my-agent', name: 'My Agent', command: ' my-agent ', args: ' --auto ', processName: ' ' },
        { id: 'custom:my-agent', name: 'My Agent', command: 'other' },
        { id: 'bad id', name: 'Wrapper', command: 'npx -y wrapper' },
        { name: '', command: 'x' },
        { name: 'No command', command: '  ' },
        // 設定画面で書きかけ（id はある）
        { id: 'custom:draft', name: '', command: '' }
      ],
      startupAgents: ['custom:my-agent', 'custom:gone', 'custom:draft', 'gemini'],
      disabledAgents: ['amp', 'nope']
    })
    expect(prefs.customAgents.map((custom) => custom.id)).toEqual(['custom:my-agent', 'custom:my-agent-2', 'custom:wrapper', 'custom:draft'])
    expect(prefs.customAgents[0]).toEqual({ id: 'custom:my-agent', name: 'My Agent', command: 'my-agent', args: '--auto' })
    expect(prefs.startupAgents).toEqual(['custom:my-agent', 'gemini'])
    // 新しい版で増えたかもしれない id は無効の一覧に残す（形の壊れたものだけ落とす）
    expect(prefs.disabledAgents).toEqual(['amp', 'nope'])
  })

  it('知らない id（新旧の版のエージェント）を安全に扱う: 起動設定と無効は残し、起動時に開くものからは外す', () => {
    const prefs = sanitizeAgentPreferences({
      launch: { 'future-agent': { command: 'future', args: '--x' }, 'Bad Id!': { command: 'x', args: '' }, gemini: 'broken' },
      startupAgents: ['future-agent', 'codex'],
      disabledAgents: ['future-agent', 'Bad Id!', 42]
    })
    expect(prefs.launch['future-agent' as never]).toEqual({ command: 'future', args: '--x' })
    expect(prefs.launch['Bad Id!' as never]).toBeUndefined()
    expect(prefs.launch.gemini).toEqual({ command: 'gemini', args: '' })
    expect(prefs.startupAgents).toEqual(['codex'])
    expect(prefs.disabledAgents).toEqual(['future-agent'])
  })

  it('カスタムのアイコン文字は2文字までに切り詰め、空なら持たない', () => {
    const prefs = sanitizeAgentPreferences({
      customAgents: [
        { id: 'custom:a', name: 'A', command: 'a', icon: ' XYZ ' },
        { id: 'custom:b', name: 'B', command: 'b', icon: '  ' }
      ]
    })
    expect(prefs.customAgents[0]?.icon).toBe('XY')
    expect(prefs.customAgents[1]).not.toHaveProperty('icon')
  })

  it('名前から id を作る（記号は - に、空なら agent）', () => {
    expect(newCustomAgentId('Kimi Code!', [])).toBe('custom:kimi-code')
    expect(newCustomAgentId('日本語だけ', [])).toBe('custom:agent')
    expect(newCustomAgentId('x', ['custom:x', 'custom:x-2'])).toBe('custom:x-3')
  })

  it('表示名はカスタムなら登録した名前', () => {
    expect(agentLabel('gemini')).toBe('Gemini CLI')
    expect(agentLabel('custom:my-agent', prefsWithCustom)).toBe('My Agent')
    expect(agentLabel('custom:gone', prefsWithCustom)).toBe('gone')
  })
})

describe('起動コマンド', () => {
  it('組み込みはコマンドが空なら既定、カスタムは空なら理由を返す', () => {
    expect(buildAgentLaunchCommand('gemini', { command: '', args: '--yolo' }, 'posix')).toEqual({
      ok: true,
      command: 'gemini --yolo'
    })
    expect(buildAgentLaunchCommand('custom:x', { command: ' ', args: '' }, 'posix').ok).toBe(false)
    expect(buildAgentLaunchCommand('kiro', DEFAULT_AGENT_PREFERENCES.launch.kiro, 'posix')).toEqual({ ok: true, command: 'kiro-cli chat' })
    expect(buildAgentLaunchCommand('custom:x', { command: 'npx -y foo', args: '--a b' }, 'posix')).toEqual({
      ok: true,
      command: 'npx -y foo --a b'
    })
  })

  it('権限確認を省く引数は、既定では付けない（付けるのは main の起動の決まりだけ。security-3 [1]）', () => {
    expect(DEFAULT_AGENT_PREFERENCES.launch.amp).toEqual({ command: 'amp', args: '' })
    expect(buildAgentLaunchCommand('amp', DEFAULT_AGENT_PREFERENCES.launch.amp, 'posix')).toEqual({ ok: true, command: 'amp' })
    expect(buildAgentLaunchCommand('devin', DEFAULT_AGENT_PREFERENCES.launch.devin, 'posix')).toEqual({ ok: true, command: 'devin' })
    // 利用者が空にしたら付けない
    expect(buildAgentLaunchCommand('devin', { command: 'devin', args: '  ' }, 'posix')).toEqual({ ok: true, command: 'devin' })
  })

  it('検出に使うコマンドは、組み込みは detectCmd、カスタムは先頭語（環境変数の代入は飛ばす）', () => {
    expect(detectCommandsFor('qwen-code', prefsWithCustom)).toEqual(['qwen'])
    expect(detectCommandsFor('custom:my-agent', prefsWithCustom)).toEqual(['my-agent'])
    expect(firstCommandWord('FOO=1 BAR=2 my-tool --x')).toBe('my-tool')
  })
})

describe('前面プロセスからの同定（Orca の agent-process-recognition）', () => {
  it('プロセス名・パス・拡張子から同定する', () => {
    expect(agentForProcess('claude')).toBe('claude')
    expect(agentForProcess('/opt/homebrew/bin/gemini')).toBe('gemini')
    expect(agentForProcess('cursor-agent')).toBe('cursor')
    expect(agentForProcess('qwen')).toBe('qwen-code')
    expect(agentForProcess('C:\\tools\\copilot.exe')).toBe('copilot')
    expect(agentForProcess('codex-aarch64-apple-darwin')).toBe('codex')
    expect(agentForProcess('zsh')).toBeNull()
  })

  it('node / python で動くCLIは、スクリプトかモジュールから同定する', () => {
    expect(agentForProcess('node /opt/homebrew/bin/gemini --yolo')).toBe('gemini')
    expect(agentForProcess('node /usr/lib/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini')
    expect(agentForProcess('node /usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex')
    expect(agentForProcess('python3 -m aider --yes-always')).toBe('aider')
    expect(agentForProcess('node /tmp/server.js')).toBeNull()
  })

  it('カスタムはプロセス名（無ければコマンドの先頭語）で同定し、npx などの実行系だけでは決めない', () => {
    expect(agentForProcess('my-agent --auto', prefsWithCustom)).toBe('custom:my-agent')
    const viaNpx: AgentPreferences = {
      ...DEFAULT_AGENT_PREFERENCES,
      customAgents: [{ id: 'custom:w', name: 'W', command: 'npx -y wrapper', args: '' }]
    }
    expect(agentForProcess('npx', viaNpx)).toBeNull()
    const named: AgentPreferences = {
      ...DEFAULT_AGENT_PREFERENCES,
      customAgents: [{ id: 'custom:w', name: 'W', command: 'npx -y wrapper', args: '', processName: 'wrapper' }]
    }
    expect(agentForProcess('node /x/bin/wrapper', named)).toBe('custom:w')
  })
})

describe('状態の検出（Claude Code / Codex 以外）', () => {
  it('確認待ちと処理中は汎用の手がかりで見て、それ以外は不明にする', () => {
    expect(detectState('generic', { tail: 'Do you want to proceed?\n' })).toBe('blocked')
    expect(detectState('generic', { tail: 'Thinking… (esc to interrupt)' })).toBe('working')
    expect(detectState('generic', { title: '⠙ gemini' })).toBe('working')
    expect(detectState('generic', { title: 'gemini - my-project', tail: '> ' })).toBe('unknown')
  })
})

describe('インストールの検出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-agent-detect-'))
  const make = (name: string, mode = 0o755) => {
    writeFileSync(join(dir, name), '#!/bin/sh\n')
    chmodSync(join(dir, name), mode)
  }
  make('gemini')
  make('my-agent')
  make('not-executable', 0o644)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.skipIf(process.platform === 'win32')('PATH のフォルダにある実行ファイルだけを見つける', async () => {
    const found = await resolveCommandsInDirs(['gemini', 'not-executable', 'amp'], [dir])
    expect([...found]).toEqual([['gemini', join(dir, 'gemini')]])
    // 無いフォルダ・空の名前・空の一覧でも投げずに見つからない
    expect((await resolveCommandsInDirs(['gemini'], [join(dir, 'missing'), ''])).size).toBe(0)
    expect((await resolveCommandsInDirs(['gemini'], [])).size).toBe(0)
  })

  it('前のフォルダを先に見る。Windows は PATHEXT の拡張子を大文字小文字を区別せずに試す', async () => {
    const second = mkdtempSync(join(tmpdir(), 'ade-agent-detect-2-'))
    try {
      writeFileSync(join(second, 'gemini'), '')
      writeFileSync(join(second, 'Codex.CMD'), '')
      expect((await resolveCommandsInDirs(['gemini'], [dir, second], 'darwin')).get('gemini')).toBe(join(dir, 'gemini'))
      const original = process.env.PATHEXT
      process.env.PATHEXT = '.EXE;.CMD'
      try {
        expect((await resolveCommandsInDirs(['codex'], [dir, second], 'win32')).get('codex')).toBe(join(second, 'Codex.CMD'))
      } finally {
        if (original === undefined) delete process.env.PATHEXT
        else process.env.PATHEXT = original
      }
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('一覧は組み込み → カスタムの順で、検出と無効を合わせる', async () => {
    const original = process.env.PATH
    process.env.PATH = dir
    try {
      const options = await listAgentOptions({ ...prefsWithCustom, disabledAgents: ['gemini'] }, true)
      const gemini = options.find((o) => o.id === 'gemini')
      expect(gemini).toMatchObject({ installed: true, enabled: false, custom: false, defaultArgs: '' })
      expect(options.find((o) => o.id === 'custom:my-agent')).toMatchObject({ installed: true, enabled: true, custom: true, label: 'My Agent' })
      expect(options.map((o) => o.id).slice(0, 2)).toEqual(['claude', 'codex'])
      expect(options[options.length - 1]?.id).toBe('custom:my-agent')
    } finally {
      process.env.PATH = original
    }
  })
})

describe('agentForProcess: 公式インストーラの Claude Code', () => {
  it('前面プロセス名が版番号（2.1.288）なら名前では決めない。実体のパスなら claude', async () => {
    const { agentForProcess, isVersionProcessName } = await import('../../src/shared/agentCatalog')
    expect(isVersionProcessName('2.1.288')).toBe(true)
    expect(agentForProcess('2.1.288')).toBeNull()
    expect(agentForProcess('/Users/me/.local/share/claude/versions/2.1.288 --resume x')).toBe('claude')
  })
})
