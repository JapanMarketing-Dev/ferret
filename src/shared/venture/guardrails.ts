/**
 * ガードレール（docs/venture.md 3・4章）。予算の消化、承認なしの外部操作、目立たせる注意。
 *
 * 予算（budgetUsage）:
 * - 効く上限は人が承認した値（approvedBudgets）だけ。guardrails.json の値（proposedBudgets）が違えば proposed に入れる
 *   （guardrails.json に無い経路は「案なし」で proposed は null）。
 * - 月の消化は period.to の月の1日〜period.to。日の消化は期間の中の日ごと。金額はビジネスの通貨か未指定の行だけ。
 * - status: over … 月の消化が月の上限を超えた（ちょうど 100% は超えていないので near）か、日の上限を超えた日がある /
 *   near … 月の消化が上限の 80% 以上、または period.to の日の消化が日の上限の 80% 以上 /
 *   noCap … その費用にかかる上限が無い（経路は自分の上限も '*' の上限も無いとき、'*' は自分の上限が無く、上限の無い経路に費用があるとき）/
 *   ok … ほか。上限 0 は「使わない」で、1 円でも使えば over。
 */
import {
  ALERT_CODES,
  CHANNELS,
  type ApprovalView,
  type BudgetCap,
  type BudgetUsage,
  type Channel,
  type CheckResult,
  type ExternalAction,
  type ExternalActionView,
  type GuardrailAlert,
  type ImportIssue,
  type MetricRow,
  type Period,
  type SupportTicket
} from './model'
import { cleanNumber, channelOf, rowValue, validRows } from './metrics'
import { addDays, dayOf, monthStart } from './period'

/** 注意（near）にする消化の割合 */
export const BUDGET_NEAR_RATIO = 0.8

type Limits = { daily: number | null; monthly: number | null }

function limitsOf(cap: BudgetCap | undefined): Limits | null {
  if (!cap || typeof cap !== 'object') return null
  return { daily: cleanNumber(cap.daily), monthly: cleanNumber(cap.monthly) }
}

function findCap(list: readonly BudgetCap[], channel: Channel | '*'): BudgetCap | undefined {
  return (Array.isArray(list) ? list : []).find((b) => b && b.channel === channel)
}

function hasLimit(l: Limits | null): boolean {
  return l !== null && (l.daily !== null || l.monthly !== null)
}

/** 期間の日ごとの費用（経路で絞る。'*' は全部） */
function spendByDay(rows: readonly MetricRow[], channel: Channel | '*', currency: string, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (channel !== '*' && channelOf(r) !== channel) continue
    if (r.date < from || r.date > to) continue
    const v = rowValue(r, 'spend', currency)
    if (v === null) continue
    out.set(r.date, (out.get(r.date) ?? 0) + v)
  }
  return out
}

/** 経路ごとと全体（'*'）の予算の消化。並びは '*' のあと CHANNELS の順。上限・案・費用のどれも無い経路は出さない */
export function budgetUsage(
  rows: readonly MetricRow[],
  period: Period | null,
  approvedBudgets: readonly BudgetCap[],
  proposedBudgets: readonly BudgetCap[],
  currency: string
): BudgetUsage[] {
  const valid = validRows(rows)
  const approved = Array.isArray(approvedBudgets) ? approvedBudgets : []
  const proposedList = Array.isArray(proposedBudgets) ? proposedBudgets : []
  const monthFrom = period ? monthStart(period.to) : null
  // 期間か、期間の最終日の月に入る行（月の消化は期間の外の月初からも数える）
  const from = period && monthFrom ? (monthFrom < period.from ? monthFrom : period.from) : null
  const inScope = period && from ? valid.filter((r) => r.date >= from && r.date <= period.to) : []

  const spentChannels = new Set<Channel>()
  for (const r of inScope) if ((rowValue(r, 'spend', currency) ?? 0) > 0) spentChannels.add(channelOf(r))
  const listed = new Set<Channel | '*'>(['*'])
  for (const b of [...approved, ...proposedList]) if (b && (b.channel === '*' || (CHANNELS as readonly string[]).includes(b.channel))) listed.add(b.channel)
  for (const c of spentChannels) listed.add(c)

  const globalCap = limitsOf(findCap(approved, '*'))
  const order: Array<Channel | '*'> = ['*', ...CHANNELS]
  return order
    .filter((c) => listed.has(c))
    .map((channel) => {
      const cap = limitsOf(findCap(approved, channel))
      const prop = limitsOf(findCap(proposedList, channel))
      const proposed = prop !== null && (cap === null || prop.daily !== cap.daily || prop.monthly !== cap.monthly) ? prop : null
      if (!period || !monthFrom) {
        return { channel, cap, proposed, monthSpend: 0, maxDay: null, overDays: [], status: 'ok' as const }
      }
      const monthDays = spendByDay(inScope, channel, currency, monthFrom, period.to)
      const periodDaysMap = spendByDay(inScope, channel, currency, period.from, period.to)
      let monthSpend = 0
      for (const v of monthDays.values()) monthSpend += v
      let maxDay: BudgetUsage['maxDay'] = null
      for (const date of [...periodDaysMap.keys()].sort()) {
        const spend = periodDaysMap.get(date) as number
        if (maxDay === null || spend > maxDay.spend) maxDay = { date, spend }
      }
      const overDays =
        cap?.daily != null ? [...periodDaysMap.entries()].filter(([, v]) => v > (cap.daily as number)).map(([d]) => d).sort() : []

      let status: BudgetUsage['status'] = 'ok'
      if (hasLimit(cap)) {
        const l = cap as Limits
        const lastDay = periodDaysMap.get(period.to) ?? 0
        const monthOver = l.monthly !== null && monthSpend > l.monthly
        const monthNear = l.monthly !== null && monthSpend > 0 && monthSpend >= l.monthly * BUDGET_NEAR_RATIO
        const dayNear = l.daily !== null && lastDay > 0 && lastDay >= l.daily * BUDGET_NEAR_RATIO
        if (monthOver || overDays.length > 0) status = 'over'
        else if (monthNear || dayNear) status = 'near'
      } else {
        const uncovered =
          channel === '*'
            ? [...spentChannels].some((c) => !hasLimit(limitsOf(findCap(approved, c))))
            : spentChannels.has(channel) && !hasLimit(globalCap)
        if (uncovered) status = 'noCap'
      }
      return { channel, cap, proposed, monthSpend, maxDay, overDays, status }
    })
}

/**
 * 外部へ送った操作に、通した承認の状態を付ける。
 * approvalId なし → noApproval（via 'ferret' は Ferret の発信で人が押したものなので ok）/
 * 承認が見つからない・approved 以外（pending・rejected・changed）→ notApproved / 承認の種類が違う → kindMismatch / ほか ok
 */
export function externalActionViews(actions: readonly ExternalAction[], approvals: readonly ApprovalView[]): ExternalActionView[] {
  const list = Array.isArray(approvals) ? approvals : []
  return (Array.isArray(actions) ? actions : [])
    .filter((a) => a !== null && typeof a === 'object')
    .map((a) => {
      let flag: ExternalActionView['flag'] = 'ok'
      if (typeof a.approvalId !== 'string' || a.approvalId === '') {
        if (a.via !== 'ferret') flag = 'noApproval'
      } else {
        const ap = list.find((x) => x && x.id === a.approvalId)
        if (!ap || ap.status !== 'approved') flag = 'notApproved'
        else if (ap.kind !== a.kind) flag = 'kindMismatch'
      }
      return { ...a, flag }
    })
}

/** 返信を待っている状態のサポート */
const WAITING_TICKET = new Set<SupportTicket['status']>(['open', 'drafted', 'awaitingApproval'])

export interface AlertInput {
  budgets: readonly BudgetUsage[]
  approvals: readonly ApprovalView[]
  actions: readonly ExternalActionView[]
  checks: readonly CheckResult[]
  importIssues: readonly ImportIssue[]
  support: readonly SupportTicket[]
  /** YYYY-MM-DD */
  today: string
}

function arr<T>(v: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(v) ? v : []
}

/**
 * 目立たせる注意（danger を先に、同じ重さの中は ALERT_CODES の順）。
 * budgetOver・budgetNear・budgetUnapproved・spendWithoutCap は経路ごとに1件、ほかは種類ごとに1件（params.count と refs）。
 * - checkFailed … 同じ対象 × 同じチェック項目の一番新しい結果（checkedAt）が fail
 * - replyWaiting … open・drafted・awaitingApproval のサポートで、受けた日が today より1日以上前
 * - actionWithoutApproval … externalActionViews の flag が ok 以外（refs は操作の日時）
 */
export function guardrailAlerts(input: AlertInput): GuardrailAlert[] {
  const out: GuardrailAlert[] = []
  for (const b of arr(input.budgets)) {
    const channel = b.channel
    if (b.status === 'over') {
      out.push({ level: 'danger', code: 'budgetOver', params: { channel, monthSpend: b.monthSpend, monthly: b.cap?.monthly ?? '', daily: b.cap?.daily ?? '', overDays: b.overDays.length }, refs: [...b.overDays] })
    }
    if (b.status === 'near') out.push({ level: 'warning', code: 'budgetNear', params: { channel, monthSpend: b.monthSpend, monthly: b.cap?.monthly ?? '', daily: b.cap?.daily ?? '' } })
    if (b.proposed) out.push({ level: 'warning', code: 'budgetUnapproved', params: { channel, daily: b.proposed.daily ?? '', monthly: b.proposed.monthly ?? '' } })
    if (b.status === 'noCap') out.push({ level: 'warning', code: 'spendWithoutCap', params: { channel, monthSpend: b.monthSpend } })
  }

  const approvals = arr(input.approvals).filter((a) => a && typeof a === 'object')
  const pending = approvals.filter((a) => a.status === 'pending')
  if (pending.length > 0) out.push({ level: 'warning', code: 'approvalPending', params: { count: pending.length }, refs: pending.map((a) => a.id) })
  const changed = approvals.filter((a) => a.status === 'changed')
  if (changed.length > 0) out.push({ level: 'danger', code: 'approvalChanged', params: { count: changed.length }, refs: changed.map((a) => a.id) })

  const bad = arr(input.actions).filter((a) => a && a.flag !== 'ok')
  if (bad.length > 0) out.push({ level: 'danger', code: 'actionWithoutApproval', params: { count: bad.length }, refs: bad.map((a) => a.at) })

  const latest = new Map<string, CheckResult>()
  for (const c of arr(input.checks)) {
    if (!c || typeof c !== 'object') continue
    const key = `${c.target}\u0000${c.checkId}`
    const prev = latest.get(key)
    if (!prev || String(c.checkedAt ?? '') >= String(prev.checkedAt ?? '')) latest.set(key, c)
  }
  const failed = [...latest.values()].filter((c) => c.result === 'fail')
  if (failed.length > 0) out.push({ level: 'danger', code: 'checkFailed', params: { count: failed.length }, refs: failed.map((c) => c.id) })

  const issues = arr(input.importIssues).filter((i) => i && typeof i === 'object')
  if (issues.length > 0) {
    out.push({ level: 'warning', code: 'importIssues', params: { count: issues.length, files: new Set(issues.map((i) => i.file)).size } })
  }

  const yesterday = addDays(input.today, -1)
  if (yesterday !== null) {
    const waiting = arr(input.support).filter((t) => {
      if (!t || !WAITING_TICKET.has(t.status)) return false
      const d = dayOf(t.receivedAt)
      return d !== null && d <= yesterday
    })
    if (waiting.length > 0) out.push({ level: 'warning', code: 'replyWaiting', params: { count: waiting.length }, refs: waiting.map((t) => t.id) })
  }

  const rank = (a: GuardrailAlert): number => (a.level === 'danger' ? 0 : 1)
  const codeIndex = (a: GuardrailAlert): number => ALERT_CODES.indexOf(a.code)
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || codeIndex(x.a) - codeIndex(y.a) || x.i - y.i)
    .map((x) => x.a)
}

