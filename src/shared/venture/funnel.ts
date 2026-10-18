/**
 * ファネル（docs/venture.md 4章）。表示 → クリック → 問い合わせ・リード → 商談 → 契約 → 継続 → 紹介・拡大。
 *
 * 代わりの数: clicks のデータが無く sessions があれば sessions を、leads のデータが無く conversions があれば conversions を
 * その段階の数として使う（FunnelStep.substitute に使った数の種類を入れる。画面で分かるように）。
 *
 * status の決まり:
 * - first … 先頭（表示）
 * - noData … その段階のデータが1行も無い
 * - stuck … 0 なのに、それより前のどこかの段階に 1 以上の数がある（流れがそこで止まっている）
 * - low … 前の段階からの率が目安未満
 * - ok … ほか（率が出せない・目安が無いときも ok）
 * 率は前の段階が 0 か null なら null。bottleneck は最初の stuck、無ければ（率 / 目安）が一番低い low。
 */
import { FUNNEL_STAGES, type Channel, type FunnelResult, type FunnelStage, type FunnelStep, type MetricKey, type MetricRow, type Period } from './model'
import { cleanNumber, totals as sumTotals, totalsByChannel, type Totals } from './metrics'

/**
 * 段階ごとの目安の率（前の段階からの率）。一般的な目安で、業種・商材・経路で大きく違う（venture.json の funnelTargets で上書きする）
 */
export const FUNNEL_DEFAULT_TARGETS: Readonly<Partial<Record<FunnelStage, number>>> = {
  clicks: 0.02,
  leads: 0.03,
  meetings: 0.3,
  contracts: 0.25,
  retained: 0.7,
  referrals: 0.1
}

/** その段階のデータが無いときに代わりに使う数 */
const SUBSTITUTES: Partial<Record<FunnelStage, MetricKey>> = { clicks: 'sessions', leads: 'conversions' }

/** 既定の目安に、正しい値（有限で 0 以上）だけ上書きした目安 */
export function funnelTargets(targets?: Partial<Record<FunnelStage, number>> | null): Partial<Record<FunnelStage, number>> {
  const out: Partial<Record<FunnelStage, number>> = { ...FUNNEL_DEFAULT_TARGETS }
  if (targets && typeof targets === 'object') {
    for (const s of FUNNEL_STAGES) {
      const v = cleanNumber(targets[s])
      if (v !== null) out[s] = v
    }
  }
  return out
}

/** 合計から段階の並びを作る */
export function funnelSteps(t: Totals, targets: Partial<Record<FunnelStage, number>>): FunnelStep[] {
  const steps: FunnelStep[] = []
  let seenPositive = false
  FUNNEL_STAGES.forEach((stage, i) => {
    let count = t[stage] ?? null
    let substitute: MetricKey | undefined
    const sub = SUBSTITUTES[stage]
    if (count === null && sub && t[sub] !== undefined) {
      count = t[sub] as number
      substitute = sub
    }
    const target = i === 0 ? null : (targets[stage] ?? null)
    const prev = i === 0 ? null : steps[i - 1].count
    const rate = i === 0 || count === null || prev === null || prev === 0 ? null : count / prev
    let status: FunnelStep['status']
    if (i === 0) status = 'first'
    else if (count === null) status = 'noData'
    else if (count === 0 && seenPositive) status = 'stuck'
    else if (rate !== null && target !== null && rate < target) status = 'low'
    else status = 'ok'
    if (count !== null && count > 0) seenPositive = true
    const step: FunnelStep = { stage, count, rate, target, status }
    if (substitute) step.substitute = substitute
    steps.push(step)
  })
  return steps
}

/** 止まっている段階（最初の stuck、無ければ 率 / 目安 が一番低い low。同じなら前の段階） */
export function funnelBottleneck(steps: readonly FunnelStep[]): FunnelStage | null {
  const stuck = steps.find((s) => s.status === 'stuck')
  if (stuck) return stuck.stage
  let best: { stage: FunnelStage; ratio: number } | null = null
  for (const s of steps) {
    if (s.status !== 'low' || s.rate === null || s.target === null || s.target <= 0) continue
    const ratio = s.rate / s.target
    if (best === null || ratio < best.ratio) best = { stage: s.stage, ratio }
  }
  return best ? best.stage : null
}

/** ファネルに関係する数が1つでもあるか */
function hasFunnelData(t: Totals): boolean {
  return FUNNEL_STAGES.some((s) => t[s] !== undefined) || t.sessions !== undefined || t.conversions !== undefined
}

/**
 * 期間のファネル。byChannel は経路ごと（表示の多い順、同じなら契約の多い順、それも同じなら CHANNELS の順）。
 * ファネルの数が1つも無い経路（費用だけなど）は byChannel に出さない。
 * 金額を使わないので通貨は見ない（契約・継続の出し方は metrics.ts のとおり）
 */
export function ventureFunnel(rows: readonly MetricRow[], period: Period | null, targets?: Partial<Record<FunnelStage, number>> | null): FunnelResult {
  const tg = funnelTargets(targets)
  const steps = funnelSteps(sumTotals(rows, period, ''), tg)
  const channels = totalsByChannel(rows, period, '')
    .filter((c) => hasFunnelData(c.totals))
    .map((c, order) => ({ channel: c.channel, totals: c.totals, order }))
    .sort((a, b) => (b.totals.impressions ?? 0) - (a.totals.impressions ?? 0) || (b.totals.contracts ?? 0) - (a.totals.contracts ?? 0) || a.order - b.order)
  const byChannel: Array<{ channel: Channel; steps: FunnelStep[] }> = channels.map((c) => ({ channel: c.channel, steps: funnelSteps(c.totals, tg) }))
  return { steps, bottleneck: funnelBottleneck(steps), byChannel }
}
