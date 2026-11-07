/**
 * エージェントが40種以上あるときの並べ方・たたみ方・検索（オンボーディングと設定の Agents 節）と、
 * カタログ外のエージェントのタイトルからの状態判定（Orca の agent-title-core 移植）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentOption, TuiAgent } from '@shared/types'
import { listAgents, matchesAgentQuery } from '../../src/renderer/lib/agentListing'
import { detectGenericScreenState, detectGenericTitleState, detectState } from '../../src/main/agent/state'

function option(id: TuiAgent, label: string, extra: Partial<AgentOption> = {}): AgentOption {
  return {
    id,
    label,
    custom: id.startsWith('custom:'),
    installed: false,
    enabled: true,
    command: id,
    args: '',
    defaultCommand: null,
    defaultArgs: null,
    homepageUrl: null,
    ...extra
  }
}

// カタログの順（主要なもの → 残り）→ カスタム、で渡される
const options: AgentOption[] = [
  option('claude', 'Claude Code', { installed: true }),
  option('codex', 'Codex'),
  option('devin', 'Devin'),
  option('cursor', 'Cursor CLI', { command: 'agent' }),
  option('aider', 'Aider'),
  option('goose', 'Goose', { installed: true }),
  option('zcode', 'ZCode'),
  option('custom:my-agent', 'My Agent')
]

describe('listAgents', () => {
  it('見つかったもの → 主要なもの → 残りの順。同じ順位の中は渡された順', () => {
    const { visible } = listAgents(options, { showAll: true })
    expect(visible.map((o) => o.id)).toEqual(['claude', 'goose', 'codex', 'devin', 'cursor', 'aider', 'zcode', 'custom:my-agent'])
  })

  it('普段は残りをたたみ、たたんだ数を返す。カスタムと選んでいるものは常に見せる', () => {
    const { visible, hiddenCount } = listAgents(options, { selected: ['zcode'] })
    expect(visible.map((o) => o.id)).toEqual(['claude', 'goose', 'codex', 'devin', 'cursor', 'zcode', 'custom:my-agent'])
    expect(hiddenCount).toBe(1)
    expect(listAgents(options).hiddenCount).toBe(2)
  })

  it('検索中はたたんだものも含めて絞り込み、たたみ数は 0', () => {
    expect(listAgents(options, { query: 'aid' })).toEqual({ visible: [options[4]], hiddenCount: 0 })
    expect(listAgents(options, { query: 'nothing-matches' }).visible).toEqual([])
    // 空白だけなら検索しない
    expect(listAgents(options, { query: '   ' }).hiddenCount).toBe(2)
  })
})

describe('matchesAgentQuery', () => {
  it('名前・id・コマンド・カタログの検出コマンドと別名で、大文字小文字を問わず、語をすべて含めば一致', () => {
    expect(matchesAgentQuery(options[2]!, 'DEVIN')).toBe(true)
    // Cursor は旧名 cursor-agent でも見つかる
    expect(matchesAgentQuery(options[3]!, 'cursor-agent')).toBe(true)
    expect(matchesAgentQuery(options[3]!, 'cursor cli')).toBe(true)
    expect(matchesAgentQuery(options[3]!, 'cursor devin')).toBe(false)
    expect(matchesAgentQuery(options[7]!, 'my')).toBe(true)
    expect(matchesAgentQuery(options[0]!, '')).toBe(true)
  })
})

describe('detectGenericTitleState（カタログ外のエージェントのタイトル）', () => {
  it('記号・スピナー・単独の語から判定し、パスの中の語は数えない', () => {
    expect(detectGenericTitleState('✋ Gemini')).toBe('blocked')
    expect(detectGenericTitleState('✦ Gemini')).toBe('working')
    expect(detectGenericTitleState('⠋ droid')).toBe('working')
    expect(detectGenericTitleState('kimi - Thinking')).toBe('working')
    expect(detectGenericTitleState('◇ Ready')).toBe('idle')
    expect(detectGenericTitleState('agent: done')).toBe('idle')
    expect(detectGenericTitleState('~/work/ready')).toBe('unknown')
    expect(detectGenericTitleState('zsh')).toBe('unknown')
    expect(detectGenericTitleState('')).toBe('unknown')
    expect(detectGenericTitleState(undefined)).toBe('unknown')
  })
})

describe('タイトル・画面からの汎用エージェントの状態（実際の表示から。2026-11-07 採取）', () => {
  it('Hermes / DeepSeek: ⏳ は作業中、✓ は待機。要約に running などの語があっても ✓ を優先する', () => {
    expect(detectGenericTitleState('⏳ Write a 300-word story abou… · deepseek-v4-pro · …/scratchpad')).toBe('working')
    expect(detectGenericTitleState('⏳ deepseek-v4-pro · …/scratchpad')).toBe('working')
    expect(detectGenericTitleState('✓ Ferret escapes midnight mis… · deepseek-v4-pro · …/scratchpad')).toBe('idle')
    expect(detectGenericTitleState('✓ Fix running tests · deepseek-v4-pro')).toBe('idle')
    expect(detectGenericTitleState('Hermes')).toBe('unknown')
    expect(detectState('generic', { title: '⏳ deepseek-v4-pro · …', tail: '' })).toBe('working')
  })

  const screen = (...bottom: string[]) => ['本文の行', '', ...bottom].join('\n')

  it('Devin・Antigravity・DeepSeek Harness・OpenCode・OpenClaw の作業中の状態行', () => {
    expect(detectGenericScreenState(screen('⡆⠀ Typing · 3s (esc twice to interrupt)', '❭ Guide Devin while it works'))).toBe('working')
    expect(detectGenericScreenState(screen('⣽  Generating...', '>', 'esc to cancel'))).toBe('working')
    expect(detectGenericScreenState(screen('⣟  Working...', '>'))).toBe('working')
    expect(detectGenericScreenState(screen(' ╰─ interrupt: ctrl+c ──────╯', ' ⠼⠴⠦ deepseek-flash'))).toBe('working')
    expect(detectGenericScreenState(screen('   ⬝⬝■■■■■■ esc interrupt          $0.00  ctrl+p commands'))).toBe('working')
    expect(detectGenericScreenState(screen(' ⠇ running • 9s | local ready', ' agent main | session main'))).toBe('working')
    expect(detectGenericScreenState(screen(' ⠦ hobnobbing… • 3s | local ready'))).toBe('working')
  })

  it('待機中の表示は作業中にしない', () => {
    expect(detectGenericScreenState(screen('❭ Ask Devin to build features, fix bugs, or work on your code', 'SWE-2 Flash Medium'))).toBe('unknown')
    expect(detectGenericScreenState(screen(' ╰─ deepseek-official · deepseek-flash ───╯', ' ·  deepseek-flash   ctx 10K/1M 1%'))).toBe('unknown')
    expect(detectGenericScreenState(screen(' local ready | idle', ' agent main | session main'))).toBe('unknown')
    expect(detectGenericScreenState(screen('/…/scratchpad/w  shift+tab agents  ctrl+p commands'))).toBe('unknown')
    expect(detectGenericScreenState('')).toBe('unknown')
  })

  it('画面の上の方（本文）に同じ語があっても、下の 10 行に無ければ作業中にしない', () => {
    const body = ['press esc interrupt to stop', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), '❭ Ask Devin'].join('\n')
    expect(detectGenericScreenState(body)).toBe('unknown')
  })

  it('タイトルが状態を示していればそちらを優先する（画面は見ない）', () => {
    expect(detectState('generic', { title: '◇  Ready (w)', tail: screen('esc interrupt') })).toBe('idle')
    expect(detectState('generic', { title: 'Qwen - w', tail: screen('⣽  Generating...') })).toBe('working')
  })
})
