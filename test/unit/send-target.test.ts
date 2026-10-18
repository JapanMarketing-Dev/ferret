/**
 * 「Agentへ送信」の宛先を選ぶ（有効な Agent すべて＋動いているタブ）。
 * 一覧の作り方・覚えた宛先・依頼の読み方・未対応の Agent（貼るだけで Enter を押さない）。
 */
import { describe, expect, it } from 'vitest'
import {
  AUTO_TARGET,
  agentSubmitsPaste,
  buildSendTargetOptions,
  defaultLaunchAgent,
  parseSendRequest,
  parseSendTarget,
  resolveRememberedTarget,
  sendTargetKey,
  type RunningAgentTerminal, isInsideDir, projectTerminals } from '../../src/shared/sendTarget'
import { chooseSendTarget } from '../../src/main/agent/sendTarget'
import { sendToAgent } from '../../src/main/agent/send'
import { sanitizePastePayload } from '../../src/main/agent/sanitize'
import type { AgentOption, TuiAgent } from '../../src/shared/types'

const option = (id: TuiAgent, over: Partial<AgentOption> = {}): AgentOption => ({
  id, label: id, custom: id.startsWith('custom:'), installed: true, enabled: true, command: id, args: '',
  defaultCommand: null, defaultArgs: null, homepageUrl: null, ...over
})
const run = (id: string, agent: TuiAgent | null, index = 1): RunningAgentTerminal => ({ id, agent, index })

describe('宛先の一覧', () => {
  it('動いている Agent を先に、そのあと有効でインストール済みの Agent（無効・未インストールは出さない）', () => {
    const agents = [option('claude'), option('codex'), option('gemini'), option('aider', { enabled: false }), option('amp', { installed: false }), option('custom:my-bot')]
    const list = buildSendTargetOptions(agents, [run('t1', 'codex'), run('t2', null, 2)])
    expect(list.map((o) => [o.key, o.running])).toEqual([
      ['agent:codex', true],
      ['agent:claude', false],
      ['agent:gemini', false],
      ['agent:custom:my-bot', false]
    ])
  })

  it('同じ Agent のタブが2つ以上あるときだけ、タブごとに出す', () => {
    const list = buildSendTargetOptions([option('claude')], [run('t1', 'claude', 1), run('t3', 'claude', 3)])
    expect(list.map((o) => [o.key, o.tab])).toEqual([['terminal:t1', 1], ['terminal:t3', 3]])
    expect(list[0]!.target).toEqual({ kind: 'terminal', terminalId: 't1', agent: 'claude' })
  })

  it('有効でなくても動いている Agent は出す（今そこで動いているので送れる）', () => {
    const list = buildSendTargetOptions([option('gemini', { enabled: false })], [run('t1', 'gemini')])
    expect(list.map((o) => o.key)).toEqual(['agent:gemini'])
  })
})

describe('覚えた宛先', () => {
  const agents = [option('claude'), option('gemini'), option('aider', { enabled: false })]

  it('動いているタブ・有効な Agent ならそのまま', () => {
    expect(resolveRememberedTarget({ kind: 'agent', agent: 'gemini' }, agents, [])).toEqual({ kind: 'agent', agent: 'gemini' })
    expect(resolveRememberedTarget({ kind: 'terminal', terminalId: 't1', agent: 'claude' }, agents, [run('t1', 'claude')])).toEqual({ kind: 'terminal', terminalId: 't1', agent: 'claude' })
  })

  it('タブが閉じていればその Agent（送るときに起動）、無効にした Agent なら自動', () => {
    expect(resolveRememberedTarget({ kind: 'terminal', terminalId: 't9', agent: 'gemini' }, agents, [])).toEqual({ kind: 'agent', agent: 'gemini' })
    expect(resolveRememberedTarget({ kind: 'agent', agent: 'aider' }, agents, [])).toEqual(AUTO_TARGET)
    expect(resolveRememberedTarget({ kind: 'terminal', terminalId: 't9', agent: null }, agents, [])).toEqual(AUTO_TARGET)
    expect(resolveRememberedTarget(null, agents, [])).toEqual(AUTO_TARGET)
  })

  it('保存した値・IPC の値は型どおりに読み、壊れていれば捨てる', () => {
    expect(parseSendTarget({ kind: 'agent', agent: 'gemini' })).toEqual({ kind: 'agent', agent: 'gemini' })
    expect(parseSendTarget({ kind: 'agent', agent: 'custom:my-bot' })).toEqual({ kind: 'agent', agent: 'custom:my-bot' })
    expect(parseSendTarget({ kind: 'agent', agent: '../../etc' })).toBeNull()
    expect(parseSendTarget({ kind: 'terminal', terminalId: '' })).toBeNull()
    expect(parseSendTarget('agent:claude')).toBeNull()
    expect(sendTargetKey({ kind: 'terminal', terminalId: 't2', agent: null })).toBe('terminal:t2')
  })
})

describe('送信の依頼（review:send の2つ目の引数）', () => {
  it('古い形（ターミナルの id・null）は自動として読む', () => {
    expect(parseSendRequest('t3')).toEqual({ target: AUTO_TARGET, focusedTerminalId: 't3' })
    expect(parseSendRequest(null)).toEqual({ target: AUTO_TARGET, focusedTerminalId: null })
  })

  it('宛先と差し替える本文を読む。本文は上限で切り、空なら既定の指示文を使う', () => {
    const r = parseSendRequest({ target: { kind: 'agent', agent: 'gemini' }, focusedTerminalId: 't1', text: 'x'.repeat(30_000) })
    expect(r.target).toEqual({ kind: 'agent', agent: 'gemini' })
    expect(r.text).toHaveLength(20_000)
    expect(parseSendRequest({ target: { kind: 'nope' }, text: '  ' })).toEqual({ target: AUTO_TARGET, focusedTerminalId: null })
  })
})

describe('宛先の決め方（main）', () => {
  const c = (id: string, agent: TuiAgent | null, state = 'idle', cwd = '/p') => ({
    id, cwd, state, agent, kind: agent === 'claude' ? 'claude-code' as const : agent === 'codex' ? 'codex' as const : agent ? 'generic' as const : 'unknown' as const
  })

  it('Agent を選んだら、その Agent が動いている同じプロジェクトのタブ（待機中を先に）。無ければ null で起動へ', () => {
    const all = [c('t1', 'claude'), c('t2', 'gemini', 'working'), c('t3', 'gemini', 'idle'), c('t4', 'gemini', 'idle', '/other')]
    const pick = (agent: TuiAgent) => chooseSendTarget(null, all.filter((x) => x.agent === agent), '/p')
    expect(pick('gemini')).toBe('t3')
    expect(pick('aider')).toBeNull()
  })

  it('自動で何も居なければ、有効な startupAgents の先頭を起動する（無ければ Claude Code）', () => {
    expect(defaultLaunchAgent(['codex', 'claude'], [])).toBe('codex')
    expect(defaultLaunchAgent(['codex', 'claude'], ['codex'])).toBe('claude')
    expect(defaultLaunchAgent([], [])).toBe('claude')
  })
})

describe('未対応の Agent（Enter で送信されると確かめていない）', () => {
  it('確かめた Agent だけ Enter を送る。ほかの組み込み・カスタム・不明は貼るだけ', () => {
    for (const agent of ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'opencode', 'antigravity', 'hermes', 'openclaw'] as TuiAgent[]) expect(agentSubmitsPaste(agent), agent).toBe(true)
    for (const agent of ['aider', 'goose', 'custom:my-bot'] as TuiAgent[]) expect(agentSubmitsPaste(agent), agent).toBe(false)
    expect(agentSubmitsPaste(null)).toBe(false)
  })

  it('submit: false なら、ブラケットペーストで貼るだけで Enter を送らない', async () => {
    const writes: string[] = []
    const result = await sendToAgent({ text: 'Read feedback.md', submit: false, getState: () => 'idle', sleep: async () => undefined,
      terminal: { write: (data) => { writes.push(data) }, onData: () => () => {} } })
    expect(result).toMatchObject({ ok: true, submitted: false })
    expect(writes).toEqual(['\x1b[200~Read feedback.md\x1b[201~'])
  })

  it('既定（submit 省略）は貼ったあと Enter を別に送る', async () => {
    const writes: string[] = []
    const result = await sendToAgent({ text: 'Read feedback.md', getState: () => 'idle', sleep: async () => undefined,
      terminal: { write: (data) => { writes.push(data) }, onData: () => () => {} } })
    expect(result).toMatchObject({ ok: true, submitted: true })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe('\r')
  })
})

describe('貼り付ける本文の整え方（ページの文字からの指示の注入）', () => {
  it('8ビットの CSI（U+009B）などの C1 制御文字を落とし、ペーストの枠の外へ出させない', () => {
    const out = sanitizePastePayload('fix the header\u009b201~rm -rf ~\r')
    expect(out).not.toMatch(/[\u0080-\u009f]/)
    expect(out).toBe('fix the header201~rm -rf ~\r')
  })

  it('文字の向きを変える制御文字を落とす。ESC は見える文字にする', () => {
    expect(sanitizePastePayload('a\u202eb\u2066c\u2069d')).toBe('abcd')
    expect(sanitizePastePayload('x\x1b[201~y')).toBe('x␛[201~y')
  })
})

describe('宛先の候補は開いているプロジェクトのターミナルだけ', () => {
  const list = [
    { id: 'a', cwd: '/work/other' },
    { id: 'b', cwd: '/work/reply' },
    { id: 'c', cwd: '/work/reply/server' },
    { id: 'd', cwd: '/work/reply-old' }
  ]

  it('ほかのプロジェクト・名前が前方だけ同じフォルダのタブは出さず、番号はこのプロジェクトの中で振り直す', () => {
    expect(projectTerminals(list, '/work/reply/')).toEqual([
      { id: 'b', cwd: '/work/reply', index: 1 },
      { id: 'c', cwd: '/work/reply/server', index: 2 }
    ])
  })

  it('プロジェクトを開いていなければ全部', () => {
    expect(projectTerminals(list, null).map((x) => x.index)).toEqual([1, 2, 3, 4])
  })

  it('Windows の区切りでも中と分かる', () => {
    expect(isInsideDir('C:\\work\\reply\\app', 'C:\\work\\reply')).toBe(true)
    expect(isInsideDir('C:\\work\\replyx', 'C:\\work\\reply')).toBe(false)
  })
})
