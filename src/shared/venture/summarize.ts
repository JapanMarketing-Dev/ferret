/**
 * ビジネスのまとめ（main の store が呼ぶ唯一の入口）。期間を決め、フェーズ・ファネル・主要な数・予算・外部操作・注意・顧客満足を出す。
 * 入力の配列が欠けていても空として扱う（壊れたファイルで画面を止めない）。
 */
import type { SummaryInput, VentureSummary } from './model'
import { ventureKpis } from './economics'
import { ventureFunnel } from './funnel'
import { budgetUsage, externalActionViews, guardrailAlerts } from './guardrails'
import { resolvePeriod } from './period'
import { venturePhase } from './phase'
import { satisfactionSummary } from './satisfaction'

function list<T>(v: readonly T[] | undefined | null): T[] {
  return Array.isArray(v) ? [...v] : []
}

export function summarizeVenture(input: SummaryInput): VentureSummary {
  const config = input.config
  const currency = typeof config?.currency === 'string' && config.currency !== '' ? config.currency : 'JPY'
  const rows = list(input.rows)
  const streams = input.streams
  const period = resolvePeriod(input.period, input.today, rows)
  const budgets = budgetUsage(rows, period, list(input.approvedBudgets), list(input.guardrails?.budgets), currency)
  const actions = externalActionViews(list(input.actions), list(input.approvals))
  return {
    period,
    phase: venturePhase(rows, period, config, input.operations ?? null),
    funnel: ventureFunnel(rows, period, config?.funnelTargets),
    kpis: ventureKpis(rows, period, config),
    budgets,
    actions,
    alerts: guardrailAlerts({
      budgets,
      approvals: list(input.approvals),
      actions,
      checks: list(streams?.checks),
      importIssues: list(input.importIssues),
      support: list(streams?.support),
      today: input.today
    }),
    satisfaction: satisfactionSummary(list(streams?.satisfaction), period)
  }
}
