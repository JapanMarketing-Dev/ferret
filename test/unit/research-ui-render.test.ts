import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale, translate, type MessageParams, type TranslationKey } from '../../src/shared/i18n'
import type { ResearchData } from '../../src/shared/research/model'
import type { ResearchSnapshot } from '../../src/shared/research/ipc'
import { emptyCandidate, emptyEvidence, emptyExperiment, emptyResearch } from '../../src/shared/research/records'
import { ResearchApiProvider, type ResearchApi } from '../../src/renderer/research/api'
import { WORKSPACE_TABS, type WorkspaceTab } from '../../src/renderer/research/view'

/**
 * 画面の描画の煙テスト（DOM なしで静的な HTML にする）。区分ごとに落ちずに描け、文言のキーや {{穴}} がそのまま出ないこと。
 * 見た目の確認は統合担当のスクリーンショットで行う
 */

// useLocale は useSyncExternalStore（サーバー描画の口が無い）なので、描画のときの言語でそのまま引く
vi.mock('../../src/renderer/lib/i18n', () => ({
  useT: () => (key: TranslationKey, params?: MessageParams) => translate(getLocale(), key, params),
  useLocale: () => getLocale()
}))

// tsconfig.test.json は JSX を持たないので、.tsx は型を通さず実行時に読む（vitest は JSX を変換できる）
const WORKSPACE_MODULE = '../../src/renderer/research/ResearchWorkspace'
const { ResearchWorkspaceBody } = (await import(/* @vite-ignore */ WORKSPACE_MODULE)) as { ResearchWorkspaceBody: FunctionComponent<Record<string, unknown>> }

const NOW = '2026-10-18T09:00:00.000Z'

function fixture(): ResearchData {
  const c = emptyCandidate('C001', NOW)
  c.title = '経理の請求書処理の代行'
  c.market = '中小企業の経理'
  c.stage = 'testing'
  c.who.companies = [
    { company: 'A社', industry: 'IT', employees: 50, situation: '経理を2名募集中', inferredProblem: '請求書処理に追われている', evidenceUrl: 'https://a.example/jobs', buyerRole: '経理部長', reachPath: '問い合わせ窓口' }
  ]
  c.who.targetCount = 120
  c.where.channels = [{ channel: 'outreach', state: 'searching', axes: { reachability: 4, intent: 3, cost: 3, repeatability: 4, scalability: 2 }, note: '' }]
  c.why.reason = '既存の会計ソフトと併用でき、導入が要らない'
  c.why.reasonEvidence = ['E001']
  c.scores.demand = { score: 4, evidence: ['E001'], reason: '契約がある' }
  c.scores.reach = { score: 1, evidence: [], reason: '' }
  c.how.monthlyPrice = 30000
  c.how.marginRate = 0.8
  c.how.estimatedCac = 50000
  c.gates.G1 = { status: 'pass', note: '', at: NOW }
  // v3: 場面（今の対処が空）・成立条件（到達に反証）・役割・無料から有料（ナレッジの例）・実行条件（供給が未確認）
  c.scene = { company: '官公庁向けの実績がある小規模IT企業', who: '営業責任者', event: '新しい入札が公示された', outcome: '検討する案件を選びたい', currentHandling: '' }
  c.conditions.problemStrong = { ...c.conditions.problemStrong, support: ['E001'], status: 'supported' }
  c.conditions.reachable = { ...c.conditions.reachable, counter: ['E001'], status: 'refuted', next: '対象を絞って接触' }
  c.roles.budgetOwner = { title: '営業部長', confirmedAuthority: '', evidence: [] }
  c.monetization = { ...c.monetization, side: 'buyer', months: 12, marginPerDeal: 300000, costPerFreeUser: 6000, conversionScenarios: [0.005, 0.02, 0.05] }
  c.execution.firstDeal = { plan: '月3万円の契約', confirmed: true }
  const c2 = { ...emptyCandidate('C002', NOW), title: '入札情報', stage: 'dropped' as const, dropReason: '到達できない' }
  const e = { ...emptyEvidence('E001', NOW), candidate: 'C001', grade: 'contract' as const, url: 'https://b.example/order', quote: '発注しました', fact: '月3万円で発注', inference: '支払意思がある', checkedAt: '2026-10-01' }
  const x = { ...emptyExperiment('X001'), candidate: 'C001', status: 'done' as const, method: 'outreach' as const, channel: 'outreach' as const, passCondition: '3社', stopCondition: '0社' }
  x.metrics = { ...x.metrics, targets: 100, contacted: 80, responded: 10, meetings: 6, proposals: 4, contracts: 2, spend: 120000 }
  return { root: '/r', research: emptyResearch('日本の B2B', NOW), candidates: [c, c2], evidence: [e], experiments: [x], problems: [{ path: 'candidates/C009.md', message: 'YAML が壊れています' }] }
}

const api: ResearchApi = {
  invoke: () => new Promise(() => {}),
  onChanged: () => () => {},
  projects: () => new Promise(() => {}),
  launchAgent: async () => null,
  openExternal: async () => {}
}

function render(tab: WorkspaceTab, candidateId: string | null): string {
  const snapshot: ResearchSnapshot = { data: fixture() }
  return renderToStaticMarkup(
    createElement(ResearchApiProvider, { value: api },
      createElement(ResearchWorkspaceBody, { snapshot, setSnapshot: () => {}, loadError: null, onOpenProject: () => {}, now: () => new Date(NOW), initialTab: tab, initialCandidateId: candidateId }))
  )
}

afterEach(() => setLocale('en'))

describe('ResearchWorkspaceBody の描画', () => {
  for (const locale of ['en', 'ja'] as const) {
    for (const tab of WORKSPACE_TABS) {
      it(`${locale}: ${tab} を候補ありで描ける。キー・{{穴}} が出ない`, () => {
        setLocale(locale)
        const html = render(tab, 'C001')
        expect(html).toContain('data-testid="research-workspace"')
        expect(html).toContain('data-testid="research-flow"')
        expect(html).toContain('data-testid="research-funnel"')
        expect(html).toContain('data-testid="research-agent"')
        expect(html).toContain(`data-testid="research-section-${tab}"`)
        expect(html).not.toMatch(/\{\{/)
        expect(html).not.toMatch(/>research\.[a-z]/)
        expect(html).not.toMatch(/"research\.[a-z]+\.[a-zA-Z.]+"/)
      })
    }
  }

  it('候補が無い区分では選ぶよう案内する', () => {
    const html = render('who', null)
    expect(html).toContain('data-testid="research-pick-candidate"')
  })

  it('区分ごとの中身（ゲート・採点・実験・台帳）', () => {
    expect(render('who', 'C001')).toContain('data-testid="research-gate-G1"')
    expect(render('why', 'C001')).toContain('data-testid="research-promote-callout"')
    const ranking = render('ranking', 'C001')
    expect(ranking).toContain('data-testid="research-score-reach"')
    expect(ranking).toMatch(/data-testid="research-score-reach" data-state="unbacked"/)
    expect(ranking).toContain('data-testid="research-how-sensitivity"')
    const exp = render('experiment', 'C001')
    expect(exp).toContain('data-testid="research-exp-row-X001"')
    expect(exp).toContain('data-testid="research-gate-G7"')
    expect(exp).toContain('data-testid="research-learning"')
    expect(render('evidence', 'C001')).toContain('data-testid="research-ev-row-E001"')
    expect(render('overview', null)).toContain('data-testid="research-candidate-C001"')
  })

  it('ビジネスのダッシュボードの実行条件（未記入なら案内、供給の注意、4点）', async () => {
    const { ExecutionPanel } = (await import(/* @vite-ignore */ '../../src/renderer/business/ExecutionPanel' as string)) as { ExecutionPanel: FunctionComponent<Record<string, unknown>> }
    const { BusinessApiProvider } = await import('../../src/renderer/business/api')
    const businessApi = { invoke: () => new Promise(() => {}), onChanged: () => () => {}, launchAgent: async () => null }
    const html = renderToStaticMarkup(createElement(BusinessApiProvider, { value: businessApi as never }, createElement(ExecutionPanel, { data: { business: {} }, onSaved: () => {} })))
    expect(html).toContain('data-testid="dash-execution"')
    expect(html).toContain('data-testid="dash-execution-empty"')
    expect(html).toContain('data-testid="dash-execution-list-supply-warning"')
    for (const k of ['supply', 'firstDeal', 'firstExperiment', 'profitOps']) expect(html).toContain(`data-testid="dash-execution-list-${k}"`)
    expect(html.indexOf('dash-execution-list-supply"')).toBeLessThan(html.indexOf('dash-execution-list-firstDeal"'))
  })

  it('v3: 場面・成立条件・次の行動・終了条件・段階・役割・収益・実行条件・証拠の評価', () => {
    setLocale('ja')
    const overview = render('overview', 'C001')
    expect(overview).toContain('data-testid="research-scene"')
    expect(overview).toContain('data-testid="research-scene-missing"')
    expect(overview).toMatch(/data-testid="research-cond-reachable" data-status="refuted" data-alarm="true"/)
    expect(overview).toMatch(/data-testid="research-cond-problemStrong" data-status="supported" data-alarm="false"/)
    expect(overview).toMatch(/data-testid="research-candidate-C001-alarm" data-alarm="true"/)
    expect(overview).toContain('data-testid="research-next-decision"')
    expect(overview).toContain('保留・除外する')
    expect(overview).toContain('data-testid="research-exit"')
    expect(overview).toContain('data-testid="research-business-stage"')
    expect(render('who', 'C001')).toContain('data-testid="research-scene-banner"')
    const who = render('who', 'C001')
    expect(who).toContain('data-testid="research-roles"')
    expect(who).toContain('data-testid="research-who-triggers"')
    const ranking = render('ranking', 'C001')
    expect(ranking).toContain('data-testid="research-conditions"')
    expect(ranking.indexOf('research-conditions')).toBeLessThan(ranking.indexOf('research-rank-scores'))
    expect(ranking).toContain('data-testid="research-money-table"')
    // ナレッジの例: 0.5% → 1,500円（-4,500円）、2% → 6,000円（0円）、5% → 15,000円（+9,000円）、損益分岐 2%
    expect(ranking).toContain('¥1,500')
    expect(ranking).toContain('-¥4,500')
    expect(ranking).toContain('+¥9,000')
    expect(ranking).toMatch(/research-money-breakeven[\s\S]*?2%/)
    const exp = render('experiment', 'C001')
    expect(exp).toContain('data-testid="research-execution-supply-warning"')
    expect(exp).toMatch(/data-testid="research-execution-firstDeal" data-confirmed="true"/)
    const ev = render('evidence', 'C001')
    expect(ev).toMatch(/data-testid="research-ev-row-E001-state" data-state="(collected|evaluated)"/)
    expect(ev).toContain('data-testid="research-ev-unevaluated"')
  })
})
