/**
 * Agent へ送る許可の札（src/main/venture/sendPass.ts）と、ターミナルへ送る・ダイアログの確認（src/main/venture/sender.ts）
 */
import { describe, expect, it } from 'vitest'
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { MAX_SEND_PASSES, SEND_TICKET_MS, createSendPasses, parseSendTarget, sha256Hex } from '../../src/main/venture/sendPass'
import { dialogConfirm, terminalSender } from '../../src/main/venture/sender'
import { t } from '../../src/shared/i18n'
import { UserFacingError } from '../../src/shared/errors'

const msg = { needsAction: () => 'needs', badPrompt: () => 'prompt', badText: () => 'text', badTarget: () => 'target', noRoot: () => 'root' }

function setup(over: { consent?: () => boolean; root?: () => string | null } = {}) {
  let clock = 1_000_000
  let root: string | null = '/biz'
  let consents = 0
  const passes = createSendPasses({
    root: over.root ?? (() => root),
    consent: over.consent ?? (() => { consents++; return true }),
    now: () => new Date(clock),
    isPromptId: (id): id is string => id === 'ads.plan' || id === 'venture.review',
    messages: msg
  })
  return {
    passes,
    advance: (ms: number) => { clock += ms },
    setRoot: (r: string | null) => { root = r },
    consents: () => consents
  }
}

const text = 'Do the plan'
const arm = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  s.passes.arm({ promptId: 'ads.plan', textHash: sha256Hex(text), target: { kind: 'active' }, ...over })

describe('parseSendTarget', () => {
  it.each([
    [{ kind: 'active' }, { kind: 'active' }],
    [{ kind: 'terminal', id: 't1' }, { kind: 'terminal', id: 't1' }],
    [{ kind: 'new', agent: 'claude' }, { kind: 'new', agent: 'claude' }],
    [{ kind: 'new', agent: 'codex' }, { kind: 'new', agent: 'codex' }],
    [{ kind: 'active', extra: 1 }, { kind: 'active' }]
  ])('%j', (raw, want) => {
    expect(parseSendTarget(raw, () => 'bad')).toEqual(want)
  })
  it.each([
    [null], [undefined], ['active'], [{}], [{ kind: 'terminal' }], [{ kind: 'terminal', id: '' }], [{ kind: 'terminal', id: 'x'.repeat(201) }],
    [{ kind: 'new', agent: 'gemini' }], [{ kind: 'shell' }]
  ])('断る %j', (raw) => {
    expect(() => parseSendTarget(raw, () => 'bad')).toThrow('bad')
  })
})

describe('createSendPasses', () => {
  it('札は合うときだけ1回通る', () => {
    const s = setup()
    const { ticket } = arm(s)
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(true)
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })

  it('本文が違えば通らず、札は消える', () => {
    const s = setup()
    const { ticket } = arm(s)
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text: `${text}!`, target: { kind: 'active' } })).toBe(false)
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })

  it('依頼の id が違えば通らない', () => {
    const s = setup()
    const { ticket } = arm(s)
    expect(s.passes.use({ ticket, promptId: 'venture.review', text, target: { kind: 'active' } })).toBe(false)
  })

  it('送り先が違えば通らない', () => {
    const s = setup()
    const { ticket } = arm(s, { target: { kind: 'terminal', id: 't1' } })
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text, target: { kind: 'terminal', id: 't2' } })).toBe(false)
    const second = arm(s, { target: { kind: 'terminal', id: 't1' } })
    expect(s.passes.use({ ticket: second.ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })

  it('new の札は起動したターミナルへの送りに使える（active には使えない）', () => {
    const s = setup()
    const a = arm(s, { target: { kind: 'new', agent: 'codex' } })
    expect(s.passes.use({ ticket: a.ticket, promptId: 'ads.plan', text, target: { kind: 'terminal', id: 'tNew' } })).toBe(true)
    const b = arm(s, { target: { kind: 'new', agent: 'codex' } })
    expect(s.passes.use({ ticket: b.ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
    const c = arm(s, { target: { kind: 'new', agent: 'codex' } })
    expect(s.passes.use({ ticket: c.ticket, promptId: 'ads.plan', text, target: { kind: 'terminal', id: '' } })).toBe(false)
  })

  it('フォルダが替わったら通らない', () => {
    const s = setup()
    const { ticket } = arm(s)
    s.setRoot('/other')
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })

  it('60秒で切れる（ちょうどは通る）', () => {
    const s = setup()
    const a = arm(s)
    s.advance(SEND_TICKET_MS)
    expect(s.passes.use({ ticket: a.ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(true)
    const b = arm(s)
    s.advance(SEND_TICKET_MS + 1)
    expect(s.passes.use({ ticket: b.ticket, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })

  it('知らない札・形の違う要求は false', () => {
    const s = setup()
    expect(s.passes.use({ ticket: 'nope', promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
    expect(s.passes.use(null)).toBe(false)
    expect(s.passes.use('x')).toBe(false)
    expect(s.passes.use({ ticket: 5 })).toBe(false)
    const { ticket } = arm(s)
    expect(s.passes.use({ ticket, promptId: 'ads.plan', text: 5, target: { kind: 'active' } })).toBe(false)
  })

  it('操作の直後でなければ札を作らない', () => {
    const s = setup({ consent: () => false })
    expect(() => arm(s)).toThrow('needs')
  })

  it('依頼の id・ハッシュ・送り先・フォルダを確かめてから許可を使う（許可を無駄にしない）', () => {
    const s = setup()
    expect(() => arm(s, { promptId: 'nope' })).toThrow('prompt')
    expect(() => arm(s, { textHash: 'abc' })).toThrow('text')
    expect(() => arm(s, { textHash: sha256Hex(text).toUpperCase() })).toThrow('text')
    expect(() => arm(s, { target: { kind: 'x' } })).toThrow('target')
    s.setRoot(null)
    expect(() => arm(s)).toThrow('root')
    expect(s.consents()).toBe(0)
  })

  it('形の違う入力は断る', () => {
    const s = setup()
    expect(() => s.passes.arm(null)).toThrow('prompt')
    expect(() => s.passes.arm('x')).toThrow('prompt')
  })

  it('札は乱数で毎回違う', () => {
    const s = setup()
    const a = arm(s).ticket
    const b = arm(s).ticket
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(24)
  })

  it(`札は ${MAX_SEND_PASSES} 個まで（古いものから捨てる）`, () => {
    const s = setup()
    const first = arm(s).ticket
    for (let i = 0; i < MAX_SEND_PASSES; i++) arm(s)
    expect(s.passes.use({ ticket: first, promptId: 'ads.plan', text, target: { kind: 'active' } })).toBe(false)
  })
})

describe('terminalSender', () => {
  type T = Parameters<typeof terminalSender>[0]
  const terms = (over: Partial<{ active: string | null; agents: Record<string, string | null>; ok: boolean; throws: boolean }> = {}) => {
    const sent: Array<{ id: string; text: string }> = []
    const agents = over.agents ?? { t1: 'claude' }
    const m = {
      resolveSendTarget: async () => (over.active === undefined ? 't1' : over.active),
      agentState: async (id: string) => {
        if (!(id in agents)) throw new Error('gone')
        return { kind: agents[id] ? 'tui' : 'unknown', state: 'idle', agent: agents[id] }
      },
      sendReview: async (id: string, text: string) => {
        if (over.throws) throw new Error('boom')
        sent.push({ id, text })
        return { ok: over.ok ?? true, message: over.ok === false ? '' : 'sent' }
      }
    }
    return { m: m as unknown as ReturnType<T>, sent }
  }

  it('active は開いているプロジェクトの Agent へ', async () => {
    const { m, sent } = terms()
    const out = await terminalSender(() => m, () => '/biz').send({ kind: 'active' }, 'hello')
    expect(out).toEqual({ ok: true, message: 'sent', label: 'Claude Code' })
    expect(sent).toEqual([{ id: 't1', text: 'hello' }])
  })

  it('ターミナルが無ければ送らない', async () => {
    const out = await terminalSender(() => null, () => '/biz').send({ kind: 'active' }, 'x')
    expect(out).toEqual({ ok: false, message: t('venture.error.sendNoTerminal'), label: '' })
  })

  it('new はここでは起動しない', async () => {
    const { m, sent } = terms()
    const out = await terminalSender(() => m, () => null).send({ kind: 'new', agent: 'codex' }, 'x')
    expect(out.ok).toBe(false)
    expect(out.label).toBe('Codex')
    expect(sent).toEqual([])
  })

  it('Agent の動いていないターミナル・閉じたタブには送らない', async () => {
    const { m, sent } = terms({ agents: { t1: 'claude', t9: null } })
    const s = terminalSender(() => m, () => null)
    expect((await s.send({ kind: 'terminal', id: 't9' }, 'x')).ok).toBe(false)
    expect((await s.send({ kind: 'terminal', id: 'gone' }, 'x')).message).toBe(t('venture.error.sendNoAgent'))
    expect(sent).toEqual([])
  })

  it('active の Agent がいなければ送らない', async () => {
    const { m } = terms({ active: null })
    expect((await terminalSender(() => m, () => null).send({ kind: 'active' }, 'x')).message).toBe(t('venture.error.sendNoAgent'))
  })

  it('送れなかった・投げたときは ok:false（送ったとは言わない）', async () => {
    const a = terms({ ok: false })
    expect(await terminalSender(() => a.m, () => null).send({ kind: 'active' }, 'x')).toMatchObject({ ok: false, message: t('venture.error.sendFailed') })
    const b = terms({ throws: true })
    expect(await terminalSender(() => b.m, () => null).send({ kind: 'active' }, 'x')).toMatchObject({ ok: false, message: t('venture.error.sendFailed') })
  })
})

describe('dialogConfirm', () => {
  const win = (destroyed = false) => ({ isDestroyed: () => destroyed }) as unknown as BrowserWindow
  const req = { message: 'Approve?', detail: 'd', confirmLabel: 'Approve' }

  it('既定のボタンは「やめる」、する を押したときだけ true', async () => {
    const seen: MessageBoxOptions[] = []
    const yes = dialogConfirm({ window: () => win(), showMessageBox: async (_w, o) => { seen.push(o); return { response: 0 } } })
    expect(await yes(req)).toBe(true)
    expect(seen[0]).toMatchObject({ buttons: ['Approve', t('venture.dialog.cancel')], defaultId: 1, cancelId: 1, message: 'Approve?', detail: 'd' })
    const no = dialogConfirm({ window: () => win(), showMessageBox: async () => ({ response: 1 }) })
    expect(await no(req)).toBe(false)
    const esc = dialogConfirm({ window: () => win(), showMessageBox: async () => ({ response: 5 }) })
    expect(await esc(req)).toBe(false)
  })

  it('窓が無い・閉じたなら確かめられないので false', async () => {
    let asked = 0
    const show = async () => { asked++; return { response: 0 } }
    expect(await dialogConfirm({ window: () => null, showMessageBox: show })(req)).toBe(false)
    expect(await dialogConfirm({ window: () => win(true), showMessageBox: show })(req)).toBe(false)
    expect(asked).toBe(0)
  })

  it('E2E の答え yes / no（それ以外の値は無視してダイアログ）', async () => {
    let asked = 0
    const show = async () => { asked++; return { response: 1 } }
    expect(await dialogConfirm({ window: () => win(), showMessageBox: show, e2eAnswer: 'yes' })(req)).toBe(true)
    expect(await dialogConfirm({ window: () => win(), showMessageBox: show, e2eAnswer: 'no' })(req)).toBe(false)
    expect(asked).toBe(0)
    expect(await dialogConfirm({ window: () => win(), showMessageBox: show, e2eAnswer: 'maybe' })(req)).toBe(false)
    expect(asked).toBe(1)
  })

  it('ダイアログが投げたら投げる（はいにしない）', async () => {
    const c = dialogConfirm({ window: () => win(), showMessageBox: async () => { throw new UserFacingError('x') } })
    await expect(c(req)).rejects.toThrow('x')
  })
})
