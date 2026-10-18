import { describe, expect, it } from 'vitest'
import { KeepGoing, type KeepGoingDeps } from '../../src/main/research/keepGoing'

/**
 * 「参入先を決め切る」を送ったターミナルを、どの Agent でも決め切るまで止めない見張り。
 * 時計と状態を台本で動かし、止まったとき・作業中・権限の確認・閉じた・上限・Stop フックを確かめる
 */

const OPTIONS = { pollMs: 1000, settlePolls: 2, quietMs: 5000, noStartMs: 20_000, max: 3 }
const ID = 't1'

/** 1回のポーリングごとの状態（足りなければ最後のものを使う） */
interface Tick { state: string; screen?: string; exists?: boolean }

function harness(script: Tick[], opts: { agent?: string; missing?: string[][]; hook?: boolean } = {}) {
  let clock = 0
  let i = -1
  const sent: string[] = []
  const missing = opts.missing ?? [['conclusion.md がまだ無い']]
  let checks = 0
  const tick = () => script[Math.min(i, script.length - 1)]!
  const deps: KeepGoingDeps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; i++ },
    exists: () => (i < 0 ? true : tick().exists ?? true),
    agentState: async () => ({ kind: 'generic', state: tick().state, agent: opts.agent ?? 'hermes' }),
    screenText: () => (i < 0 ? 'start' : tick().screen ?? 'same'),
    send: async (_id, text) => { sent.push(text); return { ok: true, message: '' } },
    check: async () => missing[Math.min(checks++, missing.length - 1)]!,
    hasClaudeHook: async () => opts.hook ?? false
  }
  // 台本が尽きたらターミナルを閉じる（無限に回さない）
  const guarded: KeepGoingDeps = { ...deps, exists: (id) => i < script.length + 200 && deps.exists(id) }
  return { loop: new KeepGoing(guarded, OPTIONS), sent, checks: () => checks }
}

const working = (n: number, screen = 'w'): Tick[] => Array.from({ length: n }, (_, k) => ({ state: 'working', screen: `${screen}${k}` }))
const idle = (n: number): Tick[] => Array.from({ length: n }, () => ({ state: 'idle', screen: 'done' }))

describe('どの Agent でも、決め切るまで止めない', () => {
  it('作業して手を止めたら判定し、足りなければ足りないものを書いた続きを送る。決め切ったら終える', async () => {
    const h = harness([...working(3), ...idle(2), ...working(3, 'x'), ...idle(2)], { missing: [['実験が無い'], []] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('settled')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toContain('まだ止まらない')
    expect(h.sent[0]).toContain('- 実験が無い')
    expect(h.sent[0]).toContain('（1/3）')
  })

  it('作業中（working）と権限の確認（blocked）の間は送らない', async () => {
    const h = harness([...working(5), { state: 'blocked', screen: 'b' }, { state: 'blocked', screen: 'b' }, { state: 'blocked', screen: 'b' }, ...idle(2)], { missing: [[]] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('settled')
    expect(h.sent).toEqual([])
    expect(h.checks()).toBe(1)
  })

  it('状態が分からない Agent は、作業のあと画面が quietMs 変わらなければ止まったとみなす', async () => {
    const quiet: Tick[] = Array.from({ length: 6 }, () => ({ state: 'unknown', screen: 'still' }))
    const h = harness([{ state: 'unknown', screen: 'a' }, { state: 'unknown', screen: 'b' }, ...quiet], { missing: [[]] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('settled')
    expect(h.checks()).toBe(1)
  })

  it('画面が動いている間（出力が続く）は、状態が分からなくても止まったとみなさない', async () => {
    const busy: Tick[] = Array.from({ length: 30 }, (_, k) => ({ state: 'unknown', screen: `out${k}` }))
    const h = harness([...busy, { state: 'unknown', exists: false }], { missing: [[]] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('closed')
    expect(h.checks()).toBe(0)
  })

  it('送っても何も起きなければ noStartMs で止まったとみなす（貼っただけで送信されなかったときなど）', async () => {
    const h = harness(Array.from({ length: 25 }, () => ({ state: 'idle', screen: 'start' })), { missing: [[]] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('settled')
  })

  it('上限まで続けさせたら、それ以上は送らない', async () => {
    const round = [...working(2), ...idle(2)]
    const h = harness([...round, ...round.map((t) => ({ ...t, screen: `${t.screen}2` })), ...round.map((t) => ({ ...t, screen: `${t.screen}3` })), ...round.map((t) => ({ ...t, screen: `${t.screen}4` }))], { missing: [['足りない']] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('limit')
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]).toContain('（3/3）')
  })

  it('ターミナルを閉じたら終える', async () => {
    const h = harness([...working(2), { state: 'unknown', exists: false }])
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('closed')
    expect(h.sent).toEqual([])
  })

  it('Claude Code で Stop フックが入っているフォルダはフックに任せる。フックが無ければ Claude Code も見張る', async () => {
    expect(await harness(working(2), { agent: 'claude', hook: true }).loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('hook')
    const h = harness([...working(2), ...idle(2)], { agent: 'claude', hook: false, missing: [[]] })
    expect(await h.loop.start({ terminalId: ID, root: '/r', locale: 'ja' })).toBe('settled')
  })

  it('同じターミナルへ送り直したら、前の見張りは止まる', async () => {
    let clock = 0
    const deps: KeepGoingDeps = {
      now: () => clock,
      sleep: async (ms) => { clock += ms; await Promise.resolve() },
      exists: () => true,
      agentState: async () => ({ kind: 'generic', state: 'working', agent: 'codex' }),
      screenText: () => String(clock),
      send: async () => ({ ok: true, message: '' }),
      check: async () => [],
      hasClaudeHook: async () => false
    }
    const loop = new KeepGoing(deps, OPTIONS)
    const first = loop.start({ terminalId: ID, root: '/r', locale: 'ja' })
    loop.stop(ID)
    expect(await first).toBe('replaced')
    expect(loop.watching(ID)).toBe(false)
  })

  it('英語の画面なら英語で続けさせる', async () => {
    const h = harness([...working(2), ...idle(2), ...working(2, 'y'), ...idle(2)], { missing: [['no experiment'], []] })
    await h.loop.start({ terminalId: ID, root: '/r', locale: 'en' })
    expect(h.sent[0]).toContain('Do not stop yet')
  })
})
