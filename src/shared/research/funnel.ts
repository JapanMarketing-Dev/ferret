/**
 * 実験のファネル（docs/business-research/knowledge.md 第1原則の100社実験・第5原則の B2B 直接営業の8段階）。
 * 件数を増やすのではなく、どの段階がボトルネックかを特定する。
 * 実測の数は null（未計測）を保ったまま扱い、0 と混ぜない。
 */
import { CHANNELS, METRIC_KEYS, type Channel, type ExperimentMetrics, type MetricKey, type ResearchExperiment } from './model'
import { experimentCac } from './economics'

/** 配列でなければ空（壊れた記録への備え。readonly 配列の型を保つ） */
function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

export interface FunnelStep {
  from: MetricKey
  to: MetricKey
  fromCount: number | null
  toCount: number | null
  /** to ÷ from（from が 0・どちらか未計測・不正・数が逆転していれば null） */
  rate: number | null
}

/** 0 以上の有限の数ならその数、それ以外は null */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** 率 = 後 ÷ 前。前が 0、後が前より大きい（数の逆転）、どちらかが未計測・負・NaN なら null */
export function stepRate(fromCount: number | null, toCount: number | null): number | null {
  const a = count(fromCount)
  const b = count(toCount)
  if (a === null || b === null || a === 0 || b > a) return null
  return b / a
}

function uniqueKeys(keys: readonly MetricKey[]): MetricKey[] {
  return [...new Set(Array.isArray(keys) ? keys.filter((k) => (METRIC_KEYS as readonly string[]).includes(k)) : [])]
}

/** 隣り合う段階ごとの数と率（keys の重複・知らないキーは除く） */
export function funnelSteps(metrics: ExperimentMetrics, keys: readonly MetricKey[]): FunnelStep[] {
  const list = uniqueKeys(keys)
  const steps: FunnelStep[] = []
  for (let i = 1; i < list.length; i++) {
    const from = list[i - 1]
    const to = list[i]
    const fromCount = count(metrics?.[from])
    const toCount = count(metrics?.[to])
    steps.push({ from, to, fromCount, toCount, rate: stepRate(fromCount, toCount) })
  }
  return steps
}

/** 最初の段階から最後の段階までの率（例: 1,000社 → 契約5 で 0.5%）。段階が2つ未満なら null */
export function overallRate(metrics: ExperimentMetrics, keys: readonly MetricKey[]): number | null {
  const list = uniqueKeys(keys)
  if (list.length < 2) return null
  return stepRate(count(metrics?.[list[0]]), count(metrics?.[list[list.length - 1]]))
}

/**
 * 隣り合う段階の目安率（仮の目安。実測が溜まれば channelLearning の値で見直す）。
 * B2B 直接営業: ナレッジの例「1,000社 → 反応50 → 商談20 → 契約5」（反応 5%・商談化 40%・成約 25%）を土台に、
 *   抽出→接触 60%、提案 50%、継続 80%、拡大（アップセル・紹介）10%。
 * Who の100社実験: 担当者到達 30%、商談 20%、課題一致 50%、購入意思 30%。
 */
export const DEFAULT_BENCHMARKS: Partial<Record<`${MetricKey}>${MetricKey}`, number>> = {
  'targets>contacted': 0.6,
  'contacted>responded': 0.05,
  'responded>meetings': 0.4,
  'meetings>proposals': 0.5,
  'proposals>contracts': 0.25,
  'contracts>retained': 0.8,
  'retained>expanded': 0.1,
  'targets>reachedBuyer': 0.3,
  'reachedBuyer>meetings': 0.2,
  'meetings>problemMatch': 0.5,
  'problemMatch>purchaseIntent': 0.3
}

/**
 * ボトルネックから考える改善の向き（ナレッジ「反応率が低い→ターゲットか訴求。商談率が高いのに成約率が低い→価格・機能・信頼・導入負担」）
 * - reach:     接触・担当者への到達が低い → 到達経路（窓口・名簿・経路）を見直す
 * - message:   反応・商談化が低い → 訴求（文面・切り口）を見直す
 * - targeting: 反応はあるのに商談・提案・課題一致に進まない → 対象（セグメント・トリガー）がずれている
 * - offer:     商談はあるのに購入意思・成約が低い → 価格・機能・信頼・導入負担
 * - retention: 継続が低い → 提供価値・オンボーディング
 * - expansion: 拡大（アップセル・紹介）が低い
 */
export type BottleneckHint = 'targeting' | 'message' | 'reach' | 'offer' | 'retention' | 'expansion'

/** 段階の組 → 改善の向き。組に無ければ to の段階で決める */
export function bottleneckHint(from: MetricKey, to: MetricKey): BottleneckHint {
  if (from === 'responded' && to === 'meetings') return 'targeting'
  switch (to) {
    case 'contacted':
    case 'reachedBuyer':
      return 'reach'
    case 'responded':
    case 'meetings':
      return 'message'
    case 'proposals':
    case 'problemMatch':
      return 'targeting'
    case 'purchaseIntent':
    case 'contracts':
      return 'offer'
    case 'retained':
      return 'retention'
    case 'expanded':
      return 'expansion'
    default:
      return 'message'
  }
}

/**
 * 目安に対して一番低い段階（率 ÷ 目安が最小。同じなら前の段階）。率か目安の無い段階は比べない。
 * ratio が 1 以上ならすべての段階が目安に届いている（それでも最も余裕の少ない段階を返す）。比べられる段階が無ければ null
 */
export function findBottleneck(
  metrics: ExperimentMetrics,
  keys: readonly MetricKey[],
  benchmarks: Partial<Record<`${MetricKey}>${MetricKey}`, number>> = DEFAULT_BENCHMARKS
): { step: FunnelStep; ratio: number; hint: BottleneckHint } | null {
  let found: { step: FunnelStep; ratio: number; hint: BottleneckHint } | null = null
  for (const step of funnelSteps(metrics, keys)) {
    const bench = benchmarks?.[`${step.from}>${step.to}`]
    if (step.rate === null || typeof bench !== 'number' || !Number.isFinite(bench) || bench <= 0) continue
    const ratio = step.rate / bench
    if (found === null || ratio < found.ratio) found = { step, ratio, hint: bottleneckHint(step.from, step.to) }
  }
  return found
}

/** 実験の数を合計する（項目ごとに、測れた実験の数だけを足す。どの実験も未計測なら null のまま） */
export function mergeMetrics(experiments: readonly ResearchExperiment[]): ExperimentMetrics {
  const out = Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as ExperimentMetrics
  for (const x of arr(experiments)) {
    if (!x || !x.metrics) continue
    for (const k of METRIC_KEYS) {
      const v = count(x.metrics[k])
      if (v !== null) out[k] = (out[k] ?? 0) + v
    }
  }
  return out
}

/** 実測の数を持つ実験（planned は数が無いので除く） */
function measured(experiments: readonly ResearchExperiment[]): ResearchExperiment[] {
  return arr(experiments).filter((x) => x && x.status !== 'planned')
}

/**
 * Learning: 経路ごとの実測の率（次の候補の採点・経路の評価に戻すための材料）。
 * planned を除いた実験を経路（channel）ごとにまとめる。経路の無い実験は数えない。並びは CHANNELS の順。
 * - responseRate: 反応 ÷ 接触 / meetingRate: 商談 ÷ 反応 / closeRate: 契約 ÷ 商談 / cac: experimentCac と同じ数え方
 */
export function channelLearning(experiments: readonly ResearchExperiment[]): Array<{
  channel: Channel
  experiments: number
  responseRate: number | null
  meetingRate: number | null
  closeRate: number | null
  cac: number | null
}> {
  const groups = new Map<Channel, ResearchExperiment[]>()
  for (const x of measured(experiments)) {
    if (!x.channel || !(CHANNELS as readonly string[]).includes(x.channel)) continue
    groups.set(x.channel, [...(groups.get(x.channel) ?? []), x])
  }
  return CHANNELS.filter((c) => groups.has(c)).map((channel) => {
    const list = groups.get(channel) as ResearchExperiment[]
    const m = mergeMetrics(list)
    return {
      channel,
      experiments: list.length,
      responseRate: stepRate(m.contacted, m.responded),
      meetingRate: stepRate(m.responded, m.meetings),
      closeRate: stepRate(m.meetings, m.contracts),
      cac: experimentCac(list).cac
    }
  })
}

/**
 * 改善の効果を言えるか（ナレッジ「AI が改善案を出しただけでは効果があったとは言えない。A/B テストや段階的展開などの比較が必要。
 * 初期は有意差が出ないこともあるので、定量データとヒアリングを組み合わせる」）。上から順に判定する:
 * 1. 比較の仕方が none → needsComparison
 * 2. まだ実施していない（planned）・試行数（contacted、無ければ targets）が未計測 → inconclusive
 * 3. 試行数が minSample（既定 30。少数では率がぶれる目安）未満で聞き取りが無い → needsInterviews
 * 4. 購入意思か契約が1件以上 → proven
 * 5. それ以外 → inconclusive
 */
export function improvementVerdict(exp: ResearchExperiment, minSample = 30): 'proven' | 'needsComparison' | 'needsInterviews' | 'inconclusive' {
  if (!exp || typeof exp !== 'object') return 'inconclusive'
  const min = typeof minSample === 'number' && Number.isFinite(minSample) && minSample > 0 ? minSample : 30
  if (exp.comparison === 'none' || !exp.comparison) return 'needsComparison'
  if (exp.status === 'planned') return 'inconclusive'
  const sample = count(exp.metrics?.contacted) ?? count(exp.metrics?.targets)
  if (sample === null) return 'inconclusive'
  const interviews = count(exp.interviews)
  if (sample < min && !(interviews !== null && interviews > 0)) return 'needsInterviews'
  const intent = count(exp.metrics?.purchaseIntent) ?? 0
  const contracts = count(exp.metrics?.contracts) ?? 0
  return intent > 0 || contracts > 0 ? 'proven' : 'inconclusive'
}
