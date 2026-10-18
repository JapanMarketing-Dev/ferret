import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import type { MemberView } from '@shared/venture/ipc'
import type { ApprovalView, BudgetUsage, CheckItem, CheckResult, ExternalActionView, GuardrailAlert, ImportIssue, StreamRecords, SupportTicket } from '@shared/venture/model'
import { CANONICAL_EXAMPLE } from '@shared/venture/records'
import { ALERT_CODES, APPROVAL_KINDS, CHANNELS, CHECK_CATEGORIES, FUNNEL_STAGES, IMPORT_ISSUE_CODES, MEMBER_ROLES, METRIC_KEYS, SOURCE_KINDS, STREAMS, VENTURE_STAGES } from '@shared/venture/model'
import { VENTURE_PROMPTS } from '@shared/venture/prompts'
import { uiEn } from '@shared/i18n/venture/ui.en'
import {
  AGENT_TARGETS,
  PERIOD_PRESETS,
  STREAM_ORDER,
  WORKSPACE_TABS,
  alertCounts,
  budgetBar,
  budgetTone,
  candidateProjects,
  canonicalExampleText,
  funnelBarPercent,
  hasProposedBudgets,
  isFlaggedAction,
  isPeriodPreset,
  isVentureRecordPath,
  isWorkspaceTab,
  issuesByFile,
  latestCheckResults,
  membersByRole,
  needsDecision,
  parseRefs,
  sortActions,
  sortAlerts,
  sortApprovals,
  sortTickets,
  stageState,
  streamRecordCount,
  targetOf,
  touchesVentureRecords,
  videoMembers,
  waitingTickets
} from '../../src/renderer/venture/view'

const emptyStreams = (): StreamRecords => ({ ads: [], content: [], images: [], support: [], satisfaction: [], checks: [] })

describe('タブ・期間・業務の並び', () => {
  it('タブは 概要 → ガードレール → 業務 → データ → メンバー → オーケストラ', () => {
    expect(WORKSPACE_TABS).toEqual(['overview', 'guardrails', 'streams', 'data', 'members', 'orchestra'])
  })
  it('タブの名前か確かめる', () => {
    expect(isWorkspaceTab('data')).toBe(true)
    expect(isWorkspaceTab('nope')).toBe(false)
    expect(isWorkspaceTab(3)).toBe(false)
  })
  it('期間は 30日・90日・今月・全期間', () => {
    expect(PERIOD_PRESETS).toEqual(['30d', '90d', 'month', 'all'])
    expect(isPeriodPreset('month')).toBe(true)
    expect(isPeriodPreset('7d')).toBe(false)
  })
  it('業務は7つ（重複なし）', () => {
    expect(STREAM_ORDER).toHaveLength(7)
    expect(new Set(STREAM_ORDER).size).toBe(7)
  })
  it('業務の記録の件数。動画は記録を持たない', () => {
    const s = emptyStreams()
    s.images = [{ id: 'IMG01', purpose: 'p', prompt: 'x', status: 'requested' }]
    expect(streamRecordCount('image', s)).toBe(1)
    expect(streamRecordCount('ads', s)).toBe(0)
    expect(streamRecordCount('video', s)).toBeNull()
    expect(streamRecordCount('ads', null)).toBe(0)
  })
})

describe('注意', () => {
  const alerts: GuardrailAlert[] = [
    { level: 'warning', code: 'approvalPending' },
    { level: 'danger', code: 'budgetOver' },
    { level: 'warning', code: 'importIssues' },
    { level: 'danger', code: 'checkFailed' }
  ]
  it('danger を先に、同じ重さは元の順', () => {
    expect(sortAlerts(alerts).map((a) => a.code)).toEqual(['budgetOver', 'checkFailed', 'approvalPending', 'importIssues'])
  })
  it('元の配列は変えない', () => {
    sortAlerts(alerts)
    expect(alerts[0]!.code).toBe('approvalPending')
  })
  it('空・null', () => {
    expect(sortAlerts(null)).toEqual([])
    expect(alertCounts(undefined)).toEqual({ danger: 0, warning: 0, total: 0 })
  })
  it('数える', () => {
    expect(alertCounts(alerts)).toEqual({ danger: 2, warning: 2, total: 4 })
  })
})

describe('フェーズの状態', () => {
  it('true 満たした / null 未確認 / false 満たさない', () => {
    expect(stageState({ ok: true })).toBe('ok')
    expect(stageState({ ok: null })).toBe('unknown')
    expect(stageState({ ok: false })).toBe('fail')
    expect(stageState(null)).toBe('unknown')
  })
})

describe('ファネルの横棒', () => {
  const steps = [{ count: 1000 }, { count: 50 }, { count: 0 }, { count: null }]
  it('一番多い段階を 100 に', () => {
    expect(funnelBarPercent(1000, steps)).toBe(100)
    expect(funnelBarPercent(50, steps)).toBe(5)
  })
  it('0・null は 0、ごく少なくても 1 は見せる', () => {
    expect(funnelBarPercent(0, steps)).toBe(0)
    expect(funnelBarPercent(null, steps)).toBe(0)
    expect(funnelBarPercent(1, [{ count: 1_000_000 }, { count: 1 }])).toBe(1)
  })
  it('全部 null なら 0', () => {
    expect(funnelBarPercent(5, [{ count: null }])).toBe(0)
  })
})

describe('予算', () => {
  const base = (over: Partial<BudgetUsage>): BudgetUsage => ({ channel: 'google-ads', cap: { daily: 3000, monthly: 90000 }, proposed: null, monthSpend: 45000, maxDay: null, overDays: [], status: 'ok', ...over })
  it('月の消化と上限の比', () => {
    expect(budgetBar(base({}))).toEqual({ ratio: 0.5, percent: 50 })
  })
  it('超えたら長さは 100 で止める（比はそのまま）', () => {
    expect(budgetBar(base({ monthSpend: 180000 }))).toEqual({ ratio: 2, percent: 100 })
  })
  it('上限が無い・0・月の上限が null なら比は null', () => {
    expect(budgetBar(base({ cap: null })).ratio).toBeNull()
    expect(budgetBar(base({ cap: { daily: 100, monthly: 0 } })).ratio).toBeNull()
    expect(budgetBar(base({ cap: { daily: 100, monthly: null } })).ratio).toBeNull()
  })
  it('負・NaN の消化は 0 として扱う', () => {
    expect(budgetBar(base({ monthSpend: -10 }))).toEqual({ ratio: 0, percent: 0 })
    expect(budgetBar(base({ monthSpend: Number.NaN }))).toEqual({ ratio: 0, percent: 0 })
  })
  it('状態の色', () => {
    expect(budgetTone('over')).toBe('danger')
    expect(budgetTone('near')).toBe('warning')
    expect(budgetTone('noCap')).toBe('warning')
    expect(budgetTone('ok')).toBe('neutral')
  })
  it('未承認の案があるか', () => {
    expect(hasProposedBudgets([base({})])).toBe(false)
    expect(hasProposedBudgets([base({}), base({ proposed: { daily: 1, monthly: 2 } })])).toBe(true)
    expect(hasProposedBudgets(null)).toBe(false)
  })
})

describe('承認・外部への操作', () => {
  const a = (id: string, status: ApprovalView['status'], createdAt: string): ApprovalView => ({ id, status, createdAt, kind: 'post', title: id, detail: '', refs: [] })
  it('変わった → 待ち → 承認済み → 却下、同じ状態は新しい順', () => {
    const list = [a('A1', 'approved', '2026-10-01'), a('A2', 'pending', '2026-10-01'), a('A3', 'rejected', '2026-10-05'), a('A4', 'changed', '2026-09-01'), a('A5', 'pending', '2026-10-03')]
    expect(sortApprovals(list).map((x) => x.id)).toEqual(['A4', 'A5', 'A2', 'A1', 'A3'])
  })
  it('人が決めるのは待ちと変わった', () => {
    expect(needsDecision({ status: 'pending' })).toBe(true)
    expect(needsDecision({ status: 'changed' })).toBe(true)
    expect(needsDecision({ status: 'approved' })).toBe(false)
    expect(needsDecision({ status: 'rejected' })).toBe(false)
  })
  it('外部への操作は新しい順、ok 以外は目立たせる', () => {
    const acts: ExternalActionView[] = [
      { at: '2026-10-01T00:00:00Z', kind: 'post', summary: 'a', flag: 'ok' },
      { at: '2026-10-03T00:00:00Z', kind: 'post', summary: 'b', flag: 'noApproval' }
    ]
    expect(sortActions(acts).map((x) => x.summary)).toEqual(['b', 'a'])
    expect(isFlaggedAction(acts[0]!)).toBe(false)
    expect(isFlaggedAction(acts[1]!)).toBe(true)
    expect(isFlaggedAction({ flag: 'kindMismatch' })).toBe(true)
    expect(sortActions(null)).toEqual([])
  })
  it('関係する id を区切って読む（重複・空を除く）', () => {
    expect(parseRefs('T001, AD01 P001、T001')).toEqual(['T001', 'AD01', 'P001'])
    expect(parseRefs('   ')).toEqual([])
  })
})

describe('サポートの返信待ち', () => {
  const tk = (id: string, status: SupportTicket['status'], receivedAt: string): SupportTicket => ({ id, status, receivedAt, channel: 'email', customer: 'A', subject: 's', summary: 's', kind: 'inquiry' })
  const list = [tk('T1', 'replied', '2026-10-05'), tk('T2', 'open', '2026-10-03'), tk('T3', 'awaitingApproval', '2026-10-01'), tk('T4', 'closed', '2026-10-06'), tk('T5', 'drafted', '2026-10-02')]
  it('open・drafted・awaitingApproval を古い順に', () => {
    expect(waitingTickets(list).map((t) => t.id)).toEqual(['T3', 'T5', 'T2'])
  })
  it('返信待ちを上に、残りは新しい順', () => {
    expect(sortTickets(list).map((t) => t.id)).toEqual(['T3', 'T5', 'T2', 'T4', 'T1'])
  })
  it('空', () => {
    expect(waitingTickets(null)).toEqual([])
    expect(sortTickets(undefined)).toEqual([])
  })
})

describe('チェックの最新の結果', () => {
  const items: CheckItem[] = [{ id: 'C01', category: 'terms', text: 'a' }, { id: 'C02', category: 'privacy', text: 'b' }]
  const results: CheckResult[] = [
    { id: 'CK1', target: 'x', checkId: 'C01', result: 'fail', checkedAt: '2026-10-01T00:00:00Z' },
    { id: 'CK2', target: 'x', checkId: 'C01', result: 'pass', checkedAt: '2026-10-02T00:00:00Z' },
    { id: 'CK3', target: 'x', checkId: 'C99', result: 'fail', checkedAt: '2026-10-03T00:00:00Z' }
  ]
  it('項目ごとに一番新しい結果、無ければ null', () => {
    expect(latestCheckResults(items, results).map((x) => [x.item.id, x.latest?.id ?? null])).toEqual([['C01', 'CK2'], ['C02', null]])
  })
  it('空', () => {
    expect(latestCheckResults(null, results)).toEqual([])
    expect(latestCheckResults(items, null).every((x) => x.latest === null)).toBe(true)
  })
})

describe('データ', () => {
  it('問題をファイルごとに数える（多い順、同数は名前順）', () => {
    const issues: ImportIssue[] = [
      { file: 'b.csv', line: 2, code: 'badDate' },
      { file: 'a.csv', line: 3, code: 'badNumber' },
      { file: 'c.csv', line: null, code: 'emptyFile' },
      { file: 'c.csv', line: 4, code: 'duplicate' }
    ]
    expect(issuesByFile(issues)).toEqual([{ file: 'c.csv', count: 2 }, { file: 'a.csv', count: 1 }, { file: 'b.csv', count: 1 }])
    expect(issuesByFile(null)).toEqual([])
  })
  it('規定の形の見本は CANONICAL_EXAMPLE をそのまま整形したもの', () => {
    expect(JSON.parse(canonicalExampleText())).toEqual(CANONICAL_EXAMPLE)
    expect(canonicalExampleText()).toContain('\n  "version": 1')
  })
})

describe('読み直す合図のパス', () => {
  it('記録のファイル・フォルダ', () => {
    for (const p of ['venture.json', 'guardrails.json', 'approvals/requests.json', 'log/external.json', 'data/imports/ga4/a.csv', 'data/agent/x.json', 'streams/ads/campaigns.json', 'reports/2026-W42.md', 'streams']) {
      expect(isVentureRecordPath(p), p).toBe(true)
    }
  })
  it('区切り・先頭の ./ を揃える', () => {
    expect(isVentureRecordPath('streams\\support\\tickets.json')).toBe(true)
    expect(isVentureRecordPath('./venture.json')).toBe(true)
  })
  it('関係ないパス', () => {
    for (const p of ['src/index.ts', 'README.md', 'datafile.txt', 'venture.json.bak', '', 'streamsx/a.json']) {
      expect(isVentureRecordPath(p), p).toBe(false)
    }
    expect(isVentureRecordPath(null)).toBe(false)
  })
  it('一つでも当たれば読み直す', () => {
    expect(touchesVentureRecords(['src/a.ts', 'log/external.json'])).toBe(true)
    expect(touchesVentureRecords(['src/a.ts'])).toBe(false)
    expect(touchesVentureRecords(null)).toBe(false)
  })
})

describe('メンバー', () => {
  const m = (role: MemberView['role'], folder: string, projectId: string | null): MemberView => ({ role, folder, projectId, name: folder, exists: true, inOrchestra: true })
  const p = (id: string, name: string, folderPath: string, extra: Partial<Project> = {}): Project => ({ id, name, folderPath, urls: [], ...extra })
  it('役割ごと（空の役割も出す）', () => {
    const groups = membersByRole([m('dev', '/a', 'p1'), m('video', '/v', null), m('dev', '/b', null)])
    expect(groups.map((g) => [g.role, g.members.length])).toEqual([['business', 0], ['dev', 2], ['video', 1], ['publish', 0]])
  })
  it('足せるプロジェクト: オーケストラ・SSH・自分・同じ役割のものを除き、名前順', () => {
    const projects = [
      p('v', 'Venture', '/venture', { editorWorkspace: true }),
      p('s', 'Remote', '/r', { source: 'ssh' }),
      p('p1', 'Zeta', '/a'),
      p('p2', 'Alpha', '/b/'),
      p('p3', 'Beta', '/c')
    ]
    const members = [m('dev', '/a', 'p1'), m('dev', '/b', null)]
    expect(candidateProjects(projects, members, 'dev', 'v').map((x) => x.id)).toEqual(['p3'])
    expect(candidateProjects(projects, members, 'video', 'v').map((x) => x.id)).toEqual(['p2', 'p3', 'p1'])
  })
  it('自分自身（ビジネスの id）は出さない', () => {
    expect(candidateProjects([p('me', 'Me', '/me')], [], 'dev', 'me')).toEqual([])
    expect(candidateProjects(null, null, 'dev', null)).toEqual([])
  })
  it('動画チャンネルは開けるものを先に', () => {
    const list = videoMembers([m('video', '/x', null), m('dev', '/d', 'd'), m('video', '/y', 'y')])
    expect(list.map((x) => x.folder)).toEqual(['/y', '/x'])
  })
})

describe('送り先', () => {
  it('今の Agent / 新しい Claude Code / 新しい Codex', () => {
    expect(AGENT_TARGETS.map((x) => x.value)).toEqual(['active', 'claude', 'codex'])
    expect(targetOf('active')).toEqual({ kind: 'active' })
    expect(targetOf('codex')).toEqual({ kind: 'new', agent: 'codex' })
    expect(targetOf('claude')).toEqual({ kind: 'new', agent: 'claude' })
  })
})

describe('組み立てるキーが辞書にある', () => {
  const has = (key: string) => key in uiEn
  const missing = (keys: string[]) => keys.filter((k) => !has(k))
  it('経路・業務・段階・ファネル・注意・問題・元・承認の種類・役割・数の種類・分類', () => {
    const keys = [
      ...CHANNELS.map((c) => `venture.channel.${c}`), 'venture.channel.all',
      ...STREAMS.map((s) => `venture.stream.${s}`),
      ...VENTURE_STAGES.flatMap((s) => [`venture.stage.${s}`, `venture.stage.${s}.detail`]),
      ...FUNNEL_STAGES.map((s) => `venture.funnel.${s}`),
      ...ALERT_CODES.map((c) => `venture.alert.${c}`),
      ...IMPORT_ISSUE_CODES.map((c) => `venture.issue.${c}`),
      ...SOURCE_KINDS.map((s) => `venture.source.${s}`),
      ...APPROVAL_KINDS.flatMap((k) => [`venture.approvalKind.${k}`, `venture.approvalKind.${k}.hint`]),
      ...MEMBER_ROLES.flatMap((r) => [`venture.role.${r}`, `venture.role.${r}.hint`]),
      ...METRIC_KEYS.map((m) => `venture.metric.${m}`),
      ...CHECK_CATEGORIES.map((c) => `venture.checkCategory.${c}`),
      ...WORKSPACE_TABS.map((x) => `venture.tab.${x}`),
      ...PERIOD_PRESETS.map((p) => `venture.period.${p}`)
    ]
    expect(missing(keys)).toEqual([])
  })
  it('状態の名前', () => {
    const groups: Record<string, readonly string[]> = {
      stageState: ['ok', 'unknown', 'fail'],
      funnelStatus: ['ok', 'low', 'stuck', 'noData', 'first'],
      budgetStatus: ['ok', 'near', 'over', 'noCap'],
      approvalStatus: ['pending', 'approved', 'rejected', 'changed'],
      actionFlag: ['ok', 'noApproval', 'notApproved', 'kindMismatch'],
      by: ['agent', 'human', 'ferret'],
      checkResult: ['pass', 'fail', 'na'],
      adStatus: ['planned', 'draft', 'awaitingApproval', 'running', 'paused', 'ended'],
      contentStatus: ['idea', 'draft', 'review', 'approved', 'posted'],
      contentChannel: ['x', 'blog', 'youtube', 'tiktok', 'note', 'instagram', 'other'],
      imageStatus: ['requested', 'generated', 'approved', 'rejected'],
      ticketKind: ['inquiry', 'support', 'complaint', 'other'],
      ticketStatus: ['open', 'drafted', 'awaitingApproval', 'replied', 'closed'],
      satMethod: ['nps', 'csat', 'survey', 'interview'],
      'phase.reason': ['noData', 'noEvidence', 'noDeal', 'oneSlot', 'noMargin', 'noRevenue', 'noSpend', 'human'],
      'kpi.arpaSource': ['override', 'data', 'none'],
      'agent.target': AGENT_TARGETS.map((x) => x.value)
    }
    expect(missing(Object.entries(groups).flatMap(([g, values]) => values.map((v) => `venture.${g}.${v}`)))).toEqual([])
  })
  it('画面で固定に使う依頼の id がある', () => {
    expect(VENTURE_PROMPTS.some((p) => p.id === 'venture.dataFetch')).toBe(true)
    for (const s of STREAMS) expect(VENTURE_PROMPTS.some((p) => p.stream === s), s).toBe(true)
  })
})
