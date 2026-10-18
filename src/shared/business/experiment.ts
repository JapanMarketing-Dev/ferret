/**
 * 実験の計算（手法.md 11章）。計画値と実測値は混ぜない。顧客 0 件の CAC は「未成立」で、0 円にしない。
 */
import { FUNNEL_KEYS, FUNNEL_LABELS, type Condition, type Experiment, type ExperimentNumbers } from './model'

export type Money =
  | { kind: 'value'; yen: number }
  | { kind: '未成立'; reason: string }
  | { kind: '未計測'; reason: string }

/** 獲得費（広告・外注・紹介料・営業工数の原価）。どれも未計測なら未計測 */
export function acquisitionCost(n: ExperimentNumbers): Money {
  const parts = [n.adCost, n.outsourceCost]
  const sales = n.salesHours !== null && n.hourlyCost !== null ? n.salesHours * n.hourlyCost : null
  if (n.salesHours !== null && n.salesHours > 0 && n.hourlyCost === null) return { kind: '未計測', reason: '営業時間の原価（1時間あたり）が未入力' }
  const known = [...parts, sales].filter((v): v is number => v !== null)
  if (known.length === 0) return { kind: '未計測', reason: '獲得費が未入力' }
  return { kind: 'value', yen: known.reduce((a, b) => a + b, 0) }
}

/** CAC = 獲得費 ÷ 新規有料顧客数。0 社なら未成立 */
export function cac(n: ExperimentNumbers): Money {
  if (n.paid === null) return { kind: '未計測', reason: '有料顧客数が未入力' }
  if (n.paid === 0) return { kind: '未成立', reason: '有料顧客が 0 社' }
  const cost = acquisitionCost(n)
  if (cost.kind !== 'value') return cost
  return { kind: 'value', yen: Math.round(cost.yen / n.paid) }
}

/** 提供後に残る額 = 税抜売上 − 提供変動費 */
export function marginAfterDelivery(n: ExperimentNumbers): Money {
  if (n.revenue === null) return { kind: '未計測', reason: '入金額が未入力' }
  if (n.deliveryCost === null) return { kind: '未計測', reason: '提供の変動費が未入力' }
  return { kind: 'value', yen: n.revenue - n.deliveryCost }
}

export type Payback =
  | { kind: 'months'; months: number }
  | { kind: '回収不能'; reason: string }
  | { kind: '未成立'; reason: string }
  | { kind: '未計測'; reason: string }

/** 回収月数の目安 = CAC ÷ 月次の提供後利益（安定継続を仮定。継続実績が無ければ仮定値） */
export function paybackMonths(n: ExperimentNumbers): Payback {
  const c = cac(n)
  if (c.kind !== 'value') return c
  if (n.monthlyPrice === null || n.monthlyVariableCost === null) return { kind: '未計測', reason: '月額か月次の変動費が未入力' }
  const monthly = n.monthlyPrice - n.monthlyVariableCost
  if (monthly <= 0) return { kind: '回収不能', reason: '月次の提供後利益が 0 以下' }
  return { kind: 'months', months: Math.round((c.yen / monthly) * 10) / 10 }
}

export function moneyLabel(m: Money | Payback): string {
  switch (m.kind) {
    case 'value':
      return `${m.yen.toLocaleString('ja-JP')} 円`
    case 'months':
      return `約 ${m.months} か月`
    default:
      return m.kind
  }
}

/** 経路の段ごとの数と、前の段からの割合（分母が 0・未計測なら割合は出さない） */
export function funnel(n: ExperimentNumbers): Array<{ key: (typeof FUNNEL_KEYS)[number]; label: string; value: number | null; rate: number | null }> {
  return FUNNEL_KEYS.map((key, i) => {
    const value = n[key]
    const prev = i > 0 ? n[FUNNEL_KEYS[i - 1]!] : null
    const rate = i > 0 && value !== null && prev !== null && prev > 0 ? Math.round((value / prev) * 1000) / 10 : null
    return { key, label: FUNNEL_LABELS[key], value, rate }
  })
}

/** 段の数は前の段を超えない（返信は接触以下、など）。矛盾を返す */
export function funnelProblems(n: ExperimentNumbers): string[] {
  const out: string[] = []
  for (let i = 1; i < FUNNEL_KEYS.length; i++) {
    const key = FUNNEL_KEYS[i]!
    const prevKey = FUNNEL_KEYS[i - 1]!
    const v = n[key]
    const p = n[prevKey]
    // 入金は有料顧客より少ないことがあり、成果受入は入金を待たないこともあるので、前の段が「有料顧客」までの間だけ比べる
    if (i > FUNNEL_KEYS.indexOf('paid')) continue
    if (v !== null && p !== null && v > p) out.push(`${FUNNEL_LABELS[key]}（${v}）が${FUNNEL_LABELS[prevKey]}（${p}）より多い`)
  }
  if (n.repurchased !== null && n.paid !== null && n.repurchased > n.paid) out.push(`${FUNNEL_LABELS.repurchased}（${n.repurchased}）が${FUNNEL_LABELS.paid}（${n.paid}）より多い`)
  return out
}

function metricValue(n: ExperimentNumbers, metric: Condition['metric']): number | null {
  if (metric === 'cac') {
    const c = cac(n)
    return c.kind === 'value' ? c.yen : null
  }
  return n[metric]
}

const METRIC_LABELS: Record<Condition['metric'], string> = {
  ...FUNNEL_LABELS,
  interest: '関心表明',
  quoteRequests: '見積依頼',
  revenue: '入金額',
  cac: 'CAC'
}

export function conditionLabel(c: Condition): string {
  return `${METRIC_LABELS[c.metric]} ${c.op === '>=' ? '≥' : '≤'} ${c.value.toLocaleString('ja-JP')}`
}

export type ConditionResult = { condition: Condition; label: string; state: '満たす' | '満たさない' | '未計測' }

function evaluate(n: ExperimentNumbers, conditions: readonly Condition[]): ConditionResult[] {
  return conditions.map((condition) => {
    const v = metricValue(n, condition.metric)
    const label = conditionLabel(condition)
    if (v === null) return { condition, label, state: '未計測' }
    const ok = condition.op === '>=' ? v >= condition.value : v <= condition.value
    return { condition, label, state: ok ? '満たす' : '満たさない' }
  })
}

export type ExperimentJudgement =
  | { verdict: '合格'; pass: ConditionResult[]; stop: ConditionResult[] }
  | { verdict: '中止'; pass: ConditionResult[]; stop: ConditionResult[] }
  | { verdict: '判定できない'; reason: string; pass: ConditionResult[]; stop: ConditionResult[] }

/**
 * 事前に決めた条件で照合する（チェック S9）。実測値だけを使う。
 * 中止条件を1つでも満たせば中止。合格条件をすべて満たし、中止条件をすべて測れていれば合格。条件が無い・未計測が残れば判定できない。
 */
export function judge(x: Experiment): ExperimentJudgement {
  const pass = evaluate(x.actual, x.pass)
  const stop = evaluate(x.actual, x.stop)
  if (x.status === '計画のみ') return { verdict: '判定できない', reason: '実施前（計画のみ）', pass, stop }
  if (x.pass.length === 0) return { verdict: '判定できない', reason: '合格条件が事前に決められていない', pass, stop }
  if (stop.some((r) => r.state === '満たす')) return { verdict: '中止', pass, stop }
  if (pass.every((r) => r.state === '満たす')) {
    // 中止条件が測れていないまま合格にしない（例: 獲得費を入れていないので CAC の上限を確かめられない）
    if (stop.some((r) => r.state === '未計測')) return { verdict: '判定できない', reason: '中止条件の指標に未計測がある', pass, stop }
    return { verdict: '合格', pass, stop }
  }
  if (pass.some((r) => r.state === '未計測')) return { verdict: '判定できない', reason: '合格条件の指標に未計測がある', pass, stop }
  return { verdict: '判定できない', reason: '合格条件を満たしていない（実施中なら続ける）', pass, stop }
}

/** 実施前に実測値が入っていないか（計画値と実測値を混ぜない） */
export function actualBeforeStart(x: Experiment): string[] {
  if (x.status !== '計画のみ') return []
  return (Object.keys(x.actual) as Array<keyof ExperimentNumbers>).filter((k) => x.actual[k] !== null)
}

/** 上限（費用・工数）を超えていないか */
export function overLimits(x: Experiment): string[] {
  const out: string[] = []
  const cost = acquisitionCost(x.actual)
  const spent = (cost.kind === 'value' ? cost.yen : 0) + (x.actual.deliveryCost ?? 0)
  if (x.limits.yen !== null && spent > x.limits.yen) out.push(`費用 ${spent.toLocaleString('ja-JP')} 円が上限 ${x.limits.yen.toLocaleString('ja-JP')} 円を超えた`)
  if (x.limits.hours !== null && x.actual.salesHours !== null && x.actual.salesHours > x.limits.hours) out.push(`工数 ${x.actual.salesHours} 時間が上限 ${x.limits.hours} 時間を超えた`)
  return out
}
