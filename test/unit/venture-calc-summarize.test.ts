/**
 * ビジネスのまとめ（main の store が呼ぶ唯一の入口）と既定の設定
 */
import { describe, expect, it } from 'vitest'
import { CHECK_CATEGORIES, type Channel, type MetricRow, type SummaryInput } from '../../src/shared/venture/model'
import { defaultGuardrails, defaultVentureConfig, emptyStreams } from '../../src/shared/venture/defaults'
import { summarizeVenture } from '../../src/shared/venture/summarize'

let line = 0
const row = (date: string, channel: Channel, values: MetricRow['values'], extra: Partial<MetricRow> = {}): MetricRow => ({
  date,
  source: 'canonical',
  channel,
  values,
  file: 'agent/a.json',
  line: ++line,
  ...extra
})
const input = (patch: Partial<SummaryInput> = {}): SummaryInput => ({
  config: defaultVentureConfig('テスト', '2026-10-01T00:00:00Z'),
  guardrails: defaultGuardrails('ja'),
  approvedBudgets: [],
  rows: [],
  importIssues: [],
  approvals: [],
  actions: [],
  streams: emptyStreams(),
  operations: null,
  today: '2026-10-18',
  period: '30d',
  ...patch
})

describe('既定の設定', () => {
  it('venture.json の既定', () => {
    const c = defaultVentureConfig('名前', '2026-10-01T00:00:00Z')
    expect(c).toEqual({
      version: 1,
      name: '名前',
      createdAt: '2026-10-01T00:00:00Z',
      currency: 'JPY',
      members: [],
      economics: { marginRate: null, ltvMonths: [6, 12, 24, 36], monthlyRevenuePerCustomer: null }
    })
  })
  it('ltvMonths は毎回新しい配列（書き換えても既定は変わらない）', () => {
    const a = defaultVentureConfig('a', '')
    a.economics.ltvMonths.push(99)
    expect(defaultVentureConfig('b', '').economics.ltvMonths).toEqual([6, 12, 24, 36])
  })
  it('ガードレールの既定: 予算なし、チェックは 8〜12 項目で C01 から連番、4つの分類を全部含む', () => {
    for (const locale of ['ja', 'en'] as const) {
      const g = defaultGuardrails(locale)
      expect(g.version).toBe(1)
      expect(g.budgets).toEqual([])
      expect(g.checks.length).toBeGreaterThanOrEqual(8)
      expect(g.checks.length).toBeLessThanOrEqual(12)
      expect(g.checks.map((c) => c.id)).toEqual(g.checks.map((_, i) => `C${String(i + 1).padStart(2, '0')}`))
      expect(new Set(g.checks.map((c) => c.category))).toEqual(new Set(CHECK_CATEGORIES))
      expect(g.checks.every((c) => c.text.trim().length > 0)).toBe(true)
    }
  })
  it('日本語と英語で id・分類がそろい、文は違う', () => {
    const ja = defaultGuardrails('ja')
    const en = defaultGuardrails('en')
    expect(en.checks.map((c) => [c.id, c.category])).toEqual(ja.checks.map((c) => [c.id, c.category]))
    expect(en.checks[0].text).not.toBe(ja.checks[0].text)
    expect(ja.checks.some((c) => c.text.includes('景品表示法'))).toBe(true)
    expect(ja.checks.some((c) => c.text.includes('薬機法'))).toBe(true)
  })
  it('空の記録', () => {
    expect(emptyStreams()).toEqual({ ads: [], content: [], images: [], support: [], satisfaction: [], checks: [] })
  })
})

describe('まとめ', () => {
  it('データが無ければ空のまとめ（30d の期間は決まる）', () => {
    const s = summarizeVenture(input())
    expect(s.period).toEqual({ from: '2026-09-19', to: '2026-10-18' })
    expect(s.phase.reached).toBe(null)
    expect(s.phase.current).toBe('demand')
    expect(s.funnel.bottleneck).toBe(null)
    expect(s.kpis.cac).toBe(null)
    expect(s.budgets.map((b) => b.channel)).toEqual(['*'])
    expect(s.actions).toEqual([])
    expect(s.alerts).toEqual([])
    expect(s.satisfaction.responses).toBe(0)
  })
  it('all でデータが無ければ期間は null', () => {
    expect(summarizeVenture(input({ period: 'all' })).period).toBe(null)
  })
  it('一通りのデータで各部をまとめる', () => {
    const config = defaultVentureConfig('テスト', '2026-10-01T00:00:00Z')
    config.economics.marginRate = 0.7
    const rows = [
      row('2026-09-15', 'google-ads', { impressions: 5000, clicks: 100, leads: 5, spend: 20000 }),
      row('2026-10-05', 'google-ads', { impressions: 10000, clicks: 200, leads: 10, spend: 40000 }),
      row('2026-10-06', 'x', { impressions: 3000, clicks: 30, leads: 2 }),
      row('2026-09-20', 'stripe', { revenue: 30000 }, { source: 'stripe', customer: 'cus_a', paymentId: 'ch_1' }),
      row('2026-10-10', 'stripe', { revenue: 30000 }, { source: 'stripe', customer: 'cus_b', paymentId: 'ch_2' }),
      row('2026-10-12', 'stripe', { revenue: 30000 }, { source: 'stripe', customer: 'cus_a', paymentId: 'ch_3' })
    ]
    const s = summarizeVenture(
      input({
        config,
        rows,
        period: 'month',
        approvedBudgets: [{ channel: 'google-ads', daily: null, monthly: 45000 }],
        approvals: [{ id: 'A001', kind: 'post', title: 't', detail: 'd', refs: [], createdAt: '', status: 'pending' }],
        actions: [{ at: '2026-10-11T00:00:00Z', kind: 'post', summary: 'X に投稿', via: 'agent' }],
        streams: { ...emptyStreams(), satisfaction: [{ id: 'R1', date: '2026-10-12', method: 'nps', score: 9 }] },
        operations: null
      })
    )
    expect(s.period).toEqual({ from: '2026-10-01', to: '2026-10-18' })
    expect(s.phase.reached).toBe('unitEconomics')
    expect(s.phase.checks.unitEconomics.params).toMatchObject({ revenue: 60000, spend: 40000, profit: 2000 })
    expect(s.funnel.steps.find((x) => x.stage === 'contracts')?.count).toBe(1)
    expect(s.funnel.steps.find((x) => x.stage === 'retained')?.count).toBe(1)
    expect(s.kpis.newCustomers).toBe(1)
    expect(s.kpis.cac).toBe(40000)
    expect(s.budgets.find((b) => b.channel === 'google-ads')?.status).toBe('near')
    expect(s.actions[0].flag).toBe('noApproval')
    expect(s.alerts.map((a) => a.code)).toEqual(['actionWithoutApproval', 'budgetNear', 'approvalPending'])
    expect(s.satisfaction.nps).toBe(100)
  })
  it('guardrails.json の案が承認と違えば budgetUnapproved', () => {
    const guardrails = { ...defaultGuardrails('ja'), budgets: [{ channel: '*' as const, daily: null, monthly: 100000 }] }
    const s = summarizeVenture(input({ guardrails, approvedBudgets: [{ channel: '*', daily: null, monthly: 50000 }] }))
    expect(s.alerts.map((a) => a.code)).toEqual(['budgetUnapproved'])
  })
  it('運営を pass にしても、前の段階が未確認なら reached は進まない', () => {
    expect(summarizeVenture(input({ operations: 'pass' })).phase.reached).toBe(null)
  })
  it('ファネルの目安は venture.json の funnelTargets を使う', () => {
    const config = defaultVentureConfig('テスト', '')
    config.funnelTargets = { clicks: 0.5 }
    const s = summarizeVenture(input({ config, rows: [row('2026-10-01', 'x', { impressions: 100, clicks: 10 })] }))
    expect(s.funnel.steps[1]).toMatchObject({ target: 0.5, status: 'low' })
    expect(s.funnel.bottleneck).toBe('clicks')
  })
  it('通貨は venture.json のもの（違う通貨の費用は数えない）', () => {
    const config = defaultVentureConfig('テスト', '')
    config.currency = 'USD'
    const s = summarizeVenture(input({ config, rows: [row('2026-10-01', 'x', { spend: 100 }, { currency: 'JPY' }), row('2026-10-01', 'x', { spend: 5 }, { currency: 'usd' })] }))
    expect(s.kpis.currency).toBe('USD')
    expect(s.kpis.spend).toBe(5)
    expect(s.budgets[0].monthSpend).toBe(5)
  })
  it('期間の外の顧客満足は入れない', () => {
    const streams = { ...emptyStreams(), satisfaction: [{ id: 'R1', date: '2026-01-01', method: 'nps' as const, score: 0 }] }
    expect(summarizeVenture(input({ streams })).satisfaction.responses).toBe(0)
  })
  it('返信待ちのサポートと取り込みの問題が注意に出る', () => {
    const streams = {
      ...emptyStreams(),
      support: [{ id: 'T1', receivedAt: '2026-10-10', channel: 'email', customer: '顧客A', subject: 's', summary: 's', kind: 'inquiry' as const, status: 'open' as const }]
    }
    const s = summarizeVenture(input({ streams, importIssues: [{ file: 'a.csv', line: 3, code: 'badDate' }] }))
    expect(s.alerts.map((a) => a.code)).toEqual(['importIssues', 'replyWaiting'])
  })
  it('入力の配列が欠けていても落ちない', () => {
    const broken = {
      ...input(),
      guardrails: undefined,
      approvedBudgets: undefined,
      rows: null,
      importIssues: undefined,
      approvals: undefined,
      actions: null,
      streams: undefined,
      operations: undefined
    } as unknown as SummaryInput
    const s = summarizeVenture(broken)
    expect(s.phase.current).toBe('demand')
    expect(s.alerts).toEqual([])
  })
  it('today が壊れていれば期間は null（全期間で集計し、落ちない）', () => {
    const s = summarizeVenture(input({ today: 'bad', rows: [row('2026-10-01', 'x', { leads: 1 })] }))
    expect(s.period).toBe(null)
    expect(s.phase.reached).toBe('demand')
    expect(s.funnel.steps[2].count).toBe(1)
  })
})
