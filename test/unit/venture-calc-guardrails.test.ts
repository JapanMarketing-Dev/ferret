/**
 * ガードレール（予算の消化・承認なしの外部操作・注意の一覧）
 */
import { describe, expect, it } from 'vitest'
import type {
  ApprovalView,
  BudgetCap,
  BudgetUsage,
  Channel,
  CheckResult,
  ExternalAction,
  ExternalActionView,
  MetricRow,
  SupportTicket
} from '../../src/shared/venture/model'
import { budgetUsage, externalActionViews, guardrailAlerts, type AlertInput } from '../../src/shared/venture/guardrails'

let line = 0
const spend = (date: string, channel: Channel, value: number, currency?: string): MetricRow => ({
  date,
  source: 'canonical',
  channel,
  values: { spend: value },
  file: 'agent/a.json',
  line: ++line,
  ...(currency ? { currency } : {})
})
const cap = (channel: Channel | '*', daily: number | null, monthly: number | null): BudgetCap => ({ channel, daily, monthly })
const OCT = { from: '2026-10-01', to: '2026-10-18' }
const usageOf = (list: BudgetUsage[], channel: Channel | '*'): BudgetUsage => {
  const u = list.find((x) => x.channel === channel)
  if (!u) throw new Error(`no ${channel}`)
  return u
}

describe('予算の消化（月）', () => {
  it('月の消化は period.to の月の1日〜period.to（期間の外の月初も数え、period.to の後は数えない）', () => {
    const rows = [spend('2026-09-30', 'google-ads', 999), spend('2026-10-01', 'google-ads', 100), spend('2026-10-18', 'google-ads', 200), spend('2026-10-19', 'google-ads', 5000)]
    const u = usageOf(budgetUsage(rows, { from: '2026-10-10', to: '2026-10-18' }, [cap('google-ads', null, 10000)], [], 'JPY'), 'google-ads')
    expect(u.monthSpend).toBe(300)
    expect(u.status).toBe('ok')
  })
  it('79% は ok、80% ちょうどは near', () => {
    const at = (v: number) => usageOf(budgetUsage([spend('2026-10-05', 'x', v)], OCT, [cap('x', null, 1000)], [], 'JPY'), 'x').status
    expect(at(799)).toBe('ok')
    expect(at(800)).toBe('near')
  })
  it('100% ちょうどは near（超えていない）、100% を超えたら over', () => {
    const at = (v: number) => usageOf(budgetUsage([spend('2026-10-05', 'x', v)], OCT, [cap('x', null, 1000)], [], 'JPY'), 'x').status
    expect(at(1000)).toBe('near')
    expect(at(1000.01)).toBe('over')
  })
  it('月の上限 0 は使わない意味。0 円なら ok、1 円でも over', () => {
    expect(usageOf(budgetUsage([spend('2026-10-05', 'x', 0)], OCT, [cap('x', null, 0)], [], 'JPY'), 'x').status).toBe('ok')
    expect(usageOf(budgetUsage([spend('2026-10-05', 'x', 1)], OCT, [cap('x', null, 0)], [], 'JPY'), 'x').status).toBe('over')
  })
  it('通貨違いの費用は数えない', () => {
    const u = usageOf(budgetUsage([spend('2026-10-05', 'x', 5000, 'USD'), spend('2026-10-05', 'x', 100)], OCT, [cap('x', null, 1000)], [], 'JPY'), 'x')
    expect(u.monthSpend).toBe(100)
  })
  it('NaN・負数・Infinity の費用は数えない', () => {
    const rows = [spend('2026-10-05', 'x', Number.NaN), spend('2026-10-06', 'x', -100), spend('2026-10-07', 'x', Number.POSITIVE_INFINITY), spend('2026-10-08', 'x', 10)]
    const u = usageOf(budgetUsage(rows, OCT, [cap('x', 100, 1000)], [], 'JPY'), 'x')
    expect(u.monthSpend).toBe(10)
    expect(u.maxDay).toEqual({ date: '2026-10-08', spend: 10 })
    expect(u.overDays).toEqual([])
  })
})

describe('予算の消化（日）', () => {
  it('日の上限を超えた日（ちょうどは超えない）、一番使った日', () => {
    const rows = [spend('2026-10-01', 'x', 1000), spend('2026-10-02', 'x', 1001), spend('2026-10-02', 'x', 100), spend('2026-10-03', 'x', 500)]
    const u = usageOf(budgetUsage(rows, OCT, [cap('x', 1000, null)], [], 'JPY'), 'x')
    expect(u.overDays).toEqual(['2026-10-02'])
    expect(u.maxDay).toEqual({ date: '2026-10-02', spend: 1101 })
    expect(u.status).toBe('over')
  })
  it('一番使った日が同じなら早い日', () => {
    const u = usageOf(budgetUsage([spend('2026-10-03', 'x', 5), spend('2026-10-01', 'x', 5)], OCT, [cap('x', 100, null)], [], 'JPY'), 'x')
    expect(u.maxDay).toEqual({ date: '2026-10-01', spend: 5 })
  })
  it('日の上限を超えた日は期間の中だけ（月初でも期間の外は数えない）', () => {
    const u = usageOf(budgetUsage([spend('2026-10-01', 'x', 9999)], { from: '2026-10-10', to: '2026-10-18' }, [cap('x', 100, null)], [], 'JPY'), 'x')
    expect(u.overDays).toEqual([])
    expect(u.maxDay).toBe(null)
    expect(u.monthSpend).toBe(9999)
  })
  it('期間の最終日の消化が日の上限の 80% 以上なら near', () => {
    const at = (v: number) => usageOf(budgetUsage([spend('2026-10-18', 'x', v)], OCT, [cap('x', 1000, null)], [], 'JPY'), 'x').status
    expect(at(799)).toBe('ok')
    expect(at(800)).toBe('near')
    expect(at(1000)).toBe('near')
    expect(at(1001)).toBe('over')
  })
  it('前の日に 80% 使っても、最終日が少なければ near にしない', () => {
    expect(usageOf(budgetUsage([spend('2026-10-17', 'x', 900)], OCT, [cap('x', 1000, null)], [], 'JPY'), 'x').status).toBe('ok')
  })
})

describe('上限が無い・全体の上限', () => {
  it('上限も費用も無ければ全体の行だけ（ok）', () => {
    expect(budgetUsage([], OCT, [], [], 'JPY')).toEqual([{ channel: '*', cap: null, proposed: null, monthSpend: 0, maxDay: null, overDays: [], status: 'ok' }])
  })
  it('上限が無いのに費用があれば noCap（経路と全体）', () => {
    const list = budgetUsage([spend('2026-10-05', 'meta-ads', 100)], OCT, [], [], 'JPY')
    expect(list.map((u) => u.channel)).toEqual(['*', 'meta-ads'])
    expect(usageOf(list, 'meta-ads').status).toBe('noCap')
    expect(usageOf(list, '*').status).toBe('noCap')
    expect(usageOf(list, '*').monthSpend).toBe(100)
  })
  it('全体の上限があれば、自分の上限の無い経路も noCap にしない', () => {
    const list = budgetUsage([spend('2026-10-05', 'meta-ads', 100)], OCT, [cap('*', null, 10000)], [], 'JPY')
    expect(usageOf(list, 'meta-ads').status).toBe('ok')
    expect(usageOf(list, '*').status).toBe('ok')
  })
  it('経路にだけ上限があれば、全体は noCap にしない', () => {
    const list = budgetUsage([spend('2026-10-05', 'meta-ads', 100)], OCT, [cap('meta-ads', null, 10000)], [], 'JPY')
    expect(usageOf(list, '*').status).toBe('ok')
    expect(usageOf(list, '*').cap).toBe(null)
  })
  it('上限の無い経路の費用が混ざれば、全体は noCap', () => {
    const list = budgetUsage([spend('2026-10-05', 'meta-ads', 100), spend('2026-10-05', 'x', 1)], OCT, [cap('meta-ads', null, 10000)], [], 'JPY')
    expect(usageOf(list, '*').status).toBe('noCap')
    expect(usageOf(list, 'x').status).toBe('noCap')
  })
  it('全体の上限は全部の経路の合計で見る', () => {
    const list = budgetUsage([spend('2026-10-05', 'meta-ads', 600), spend('2026-10-05', 'x', 500)], OCT, [cap('*', null, 1000)], [], 'JPY')
    expect(usageOf(list, '*').monthSpend).toBe(1100)
    expect(usageOf(list, '*').status).toBe('over')
  })
  it('承認の値が両方 null なら上限なしと同じ', () => {
    const u = usageOf(budgetUsage([spend('2026-10-05', 'x', 1)], OCT, [cap('x', null, null)], [], 'JPY'), 'x')
    expect(u.cap).toEqual({ daily: null, monthly: null })
    expect(u.status).toBe('noCap')
  })
  it('壊れた上限の値（NaN・負数・文字）は null として扱う', () => {
    const u = usageOf(budgetUsage([], OCT, [{ channel: 'x', daily: Number.NaN, monthly: '5' as unknown as number }, cap('blog', -1, 10)], [], 'JPY'), 'x')
    expect(u.cap).toEqual({ daily: null, monthly: null })
  })
  it('並びは * のあと CHANNELS の順。知らない経路の上限は出さない', () => {
    const list = budgetUsage([], OCT, [cap('x', 1, 1), cap('google-ads', 1, 1), { channel: 'nope' as Channel, daily: 1, monthly: 1 }], [], 'JPY')
    expect(list.map((u) => u.channel)).toEqual(['*', 'google-ads', 'x'])
  })
  it('期間が null なら消化 0・ok（上限と案は出す）', () => {
    const list = budgetUsage([spend('2026-10-05', 'x', 100)], null, [cap('x', 1, 1)], [cap('x', 2, 2)], 'JPY')
    expect(usageOf(list, 'x')).toMatchObject({ monthSpend: 0, status: 'ok', proposed: { daily: 2, monthly: 2 } })
  })
  it('行・上限が配列でなくても壊れない', () => {
    expect(budgetUsage(null as unknown as MetricRow[], OCT, null as unknown as BudgetCap[], undefined as unknown as BudgetCap[], 'JPY')).toHaveLength(1)
  })
})

describe('承認されていない上限の案', () => {
  it('guardrails.json の値が承認と同じなら proposed は null', () => {
    expect(usageOf(budgetUsage([], OCT, [cap('x', 100, 1000)], [cap('x', 100, 1000)], 'JPY'), 'x').proposed).toBe(null)
  })
  it('値が違えば proposed にその値', () => {
    expect(usageOf(budgetUsage([], OCT, [cap('x', 100, 1000)], [cap('x', 100, 5000)], 'JPY'), 'x').proposed).toEqual({ daily: 100, monthly: 5000 })
  })
  it('承認の無い経路の案は proposed（cap は null）', () => {
    const u = usageOf(budgetUsage([], OCT, [], [cap('meta-ads', 50, null)], 'JPY'), 'meta-ads')
    expect(u.cap).toBe(null)
    expect(u.proposed).toEqual({ daily: 50, monthly: null })
  })
  it('案に無い経路は proposed null（承認はそのまま効く）', () => {
    const u = usageOf(budgetUsage([spend('2026-10-05', 'x', 2000)], OCT, [cap('x', null, 1000)], [], 'JPY'), 'x')
    expect(u.proposed).toBe(null)
    expect(u.status).toBe('over')
  })
  it('効くのは承認の値だけ（案が大きくても over）', () => {
    const u = usageOf(budgetUsage([spend('2026-10-05', 'x', 2000)], OCT, [cap('x', null, 1000)], [cap('x', null, 100000)], 'JPY'), 'x')
    expect(u.status).toBe('over')
  })
})

describe('外部操作と承認', () => {
  const approval = (id: string, status: ApprovalView['status'], kind: ApprovalView['kind'] = 'post'): ApprovalView => ({
    id,
    kind,
    title: 't',
    detail: 'd',
    refs: [],
    createdAt: '2026-10-01T00:00:00Z',
    status
  })
  const action = (patch: Partial<ExternalAction> = {}): ExternalAction => ({ at: '2026-10-10T10:00:00Z', kind: 'post', summary: 's', ...patch })
  const flag = (a: ExternalAction, list: ApprovalView[] = []) => externalActionViews([a], list)[0].flag

  it('承認の id が無ければ noApproval', () => {
    expect(flag(action())).toBe('noApproval')
    expect(flag(action({ approvalId: '' }))).toBe('noApproval')
    expect(flag(action({ via: 'agent' }))).toBe('noApproval')
    expect(flag(action({ via: 'human' }))).toBe('noApproval')
  })
  it('Ferret の発信（人が押した）は承認の id が無くても ok', () => {
    expect(flag(action({ via: 'ferret' }))).toBe('ok')
  })
  it('承認済みで種類も同じなら ok', () => {
    expect(flag(action({ approvalId: 'A001' }), [approval('A001', 'approved')])).toBe('ok')
  })
  it('承認が見つからない・pending・rejected・changed は notApproved', () => {
    expect(flag(action({ approvalId: 'A009' }), [approval('A001', 'approved')])).toBe('notApproved')
    expect(flag(action({ approvalId: 'A001' }), [approval('A001', 'pending')])).toBe('notApproved')
    expect(flag(action({ approvalId: 'A001' }), [approval('A001', 'rejected')])).toBe('notApproved')
    expect(flag(action({ approvalId: 'A001' }), [approval('A001', 'changed')])).toBe('notApproved')
  })
  it('承認の種類が違えば kindMismatch', () => {
    expect(flag(action({ approvalId: 'A001', kind: 'adLaunch' }), [approval('A001', 'approved', 'post')])).toBe('kindMismatch')
  })
  it('via ferret でも承認の id があれば承認を確かめる', () => {
    expect(flag(action({ approvalId: 'A001', via: 'ferret' }), [approval('A001', 'rejected')])).toBe('notApproved')
  })
  it('元の項目はそのまま残し、並びも変えない。壊れた項目は飛ばす', () => {
    const list = externalActionViews([action({ summary: 'a', url: 'https://example.com' }), null as unknown as ExternalAction, action({ summary: 'b' })], [])
    expect(list.map((a) => a.summary)).toEqual(['a', 'b'])
    expect(list[0].url).toBe('https://example.com')
    expect(externalActionViews(null as unknown as ExternalAction[], null as unknown as ApprovalView[])).toEqual([])
  })
})

describe('注意の一覧', () => {
  const base = (patch: Partial<AlertInput> = {}): AlertInput => ({
    budgets: [],
    approvals: [],
    actions: [],
    checks: [],
    importIssues: [],
    support: [],
    today: '2026-10-18',
    ...patch
  })
  const usage = (patch: Partial<BudgetUsage>): BudgetUsage => ({
    channel: 'x',
    cap: { daily: null, monthly: 1000 },
    proposed: null,
    monthSpend: 0,
    maxDay: null,
    overDays: [],
    status: 'ok',
    ...patch
  })
  const ap = (id: string, status: ApprovalView['status']): ApprovalView => ({ id, kind: 'post', title: 't', detail: 'd', refs: [], createdAt: '', status })
  const ticket = (id: string, receivedAt: string, status: SupportTicket['status']): SupportTicket => ({
    id,
    receivedAt,
    channel: 'email',
    customer: '顧客A',
    subject: 's',
    summary: 's',
    kind: 'inquiry',
    status
  })
  const check = (id: string, target: string, checkId: string, result: CheckResult['result'], checkedAt: string): CheckResult => ({ id, target, checkId, result, checkedAt })
  const codes = (input: AlertInput) => guardrailAlerts(input).map((a) => a.code)

  it('何も無ければ空', () => {
    expect(guardrailAlerts(base())).toEqual([])
  })
  it('予算: over は danger、near・案・noCap は warning（経路ごと）', () => {
    const alerts = guardrailAlerts(
      base({
        budgets: [
          usage({ channel: 'x', status: 'over', monthSpend: 2000, overDays: ['2026-10-02'] }),
          usage({ channel: 'blog', status: 'near', monthSpend: 900 }),
          usage({ channel: 'email', proposed: { daily: 1, monthly: 2 } }),
          usage({ channel: '*', cap: null, status: 'noCap', monthSpend: 5 })
        ]
      })
    )
    expect(alerts.map((a) => [a.level, a.code])).toEqual([
      ['danger', 'budgetOver'],
      ['warning', 'budgetNear'],
      ['warning', 'budgetUnapproved'],
      ['warning', 'spendWithoutCap']
    ])
    expect(alerts[0].params).toMatchObject({ channel: 'x', monthSpend: 2000, monthly: 1000, overDays: 1 })
    expect(alerts[0].refs).toEqual(['2026-10-02'])
    expect(alerts[2].params).toEqual({ channel: 'email', daily: 1, monthly: 2 })
  })
  it('承認待ちは warning、承認後の変更は danger（件数と id）', () => {
    const alerts = guardrailAlerts(base({ approvals: [ap('A1', 'pending'), ap('A2', 'pending'), ap('A3', 'changed'), ap('A4', 'approved'), ap('A5', 'rejected')] }))
    expect(alerts).toEqual([
      { level: 'danger', code: 'approvalChanged', params: { count: 1 }, refs: ['A3'] },
      { level: 'warning', code: 'approvalPending', params: { count: 2 }, refs: ['A1', 'A2'] }
    ])
  })
  it('承認の通っていない外部操作は danger', () => {
    const actions: ExternalActionView[] = [
      { at: 't1', kind: 'post', summary: 'a', flag: 'ok' },
      { at: 't2', kind: 'post', summary: 'b', flag: 'noApproval' },
      { at: 't3', kind: 'post', summary: 'c', flag: 'kindMismatch' }
    ]
    expect(guardrailAlerts(base({ actions }))).toEqual([{ level: 'danger', code: 'actionWithoutApproval', params: { count: 2 }, refs: ['t2', 't3'] }])
  })
  it('チェックは同じ対象 × 項目の一番新しい結果で見る', () => {
    const checks = [
      check('CK1', 'P001', 'C01', 'fail', '2026-10-01T00:00:00Z'),
      check('CK2', 'P001', 'C01', 'pass', '2026-10-02T00:00:00Z'),
      check('CK3', 'P002', 'C01', 'pass', '2026-10-01T00:00:00Z'),
      check('CK4', 'P002', 'C01', 'fail', '2026-10-03T00:00:00Z'),
      check('CK5', 'P001', 'C02', 'na', '2026-10-03T00:00:00Z')
    ]
    expect(guardrailAlerts(base({ checks }))).toEqual([{ level: 'danger', code: 'checkFailed', params: { count: 1 }, refs: ['CK4'] }])
  })
  it('取り込みの問題は warning（件数とファイル数）', () => {
    const importIssues = [
      { file: 'a.csv', line: 2, code: 'badDate' as const },
      { file: 'a.csv', line: 3, code: 'badNumber' as const },
      { file: 'b.csv', line: null, code: 'emptyFile' as const }
    ]
    expect(guardrailAlerts(base({ importIssues }))).toEqual([{ level: 'warning', code: 'importIssues', params: { count: 3, files: 2 } }])
  })
  it('返信待ち: today より1日以上前の open・drafted・awaitingApproval', () => {
    const support = [
      ticket('T1', '2026-10-17T23:59:00+09:00', 'open'),
      ticket('T2', '2026-10-18T00:01:00+09:00', 'open'),
      ticket('T3', '2026-10-01', 'drafted'),
      ticket('T4', '2026-10-01', 'awaitingApproval'),
      ticket('T5', '2026-10-01', 'replied'),
      ticket('T6', '2026-10-01', 'closed'),
      ticket('T7', 'bad', 'open')
    ]
    expect(guardrailAlerts(base({ support }))).toEqual([{ level: 'warning', code: 'replyWaiting', params: { count: 3 }, refs: ['T1', 'T3', 'T4'] }])
  })
  it('today が壊れていれば返信待ちは出さない', () => {
    expect(codes(base({ today: 'x', support: [ticket('T1', '2026-10-01', 'open')] }))).toEqual([])
  })
  it('月をまたいだ前日（10/1 の前日は 9/30）', () => {
    expect(codes(base({ today: '2026-10-01', support: [ticket('T1', '2026-09-30', 'open')] }))).toEqual(['replyWaiting'])
  })
  it('danger を先に、同じ重さの中は ALERT_CODES の順', () => {
    const input = base({
      budgets: [usage({ channel: 'x', status: 'near' }), usage({ channel: 'blog', status: 'over' })],
      approvals: [ap('A1', 'pending'), ap('A2', 'changed')],
      actions: [{ at: 't', kind: 'post', summary: 's', flag: 'noApproval' }],
      checks: [check('CK1', 'P1', 'C1', 'fail', '2026-10-01')],
      importIssues: [{ file: 'a', line: 1, code: 'badDate' }],
      support: [ticket('T1', '2026-10-01', 'open')]
    })
    expect(codes(input)).toEqual([
      'budgetOver',
      'approvalChanged',
      'actionWithoutApproval',
      'checkFailed',
      'budgetNear',
      'approvalPending',
      'importIssues',
      'replyWaiting'
    ])
  })
  it('壊れた入力（null・配列でない）でも落ちない', () => {
    const input = {
      budgets: null,
      approvals: [null],
      actions: undefined,
      checks: [null],
      importIssues: 'x',
      support: [null],
      today: '2026-10-18'
    } as unknown as AlertInput
    expect(guardrailAlerts(input)).toEqual([])
  })
})
