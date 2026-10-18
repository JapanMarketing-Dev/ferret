/**
 * 無料から有料へのつながりの採算（docs/business-research/knowledge.md 第2部 原則⑤「利用が収益につながるか」）。
 * 同じ期間に獲得した企業群で見る: 無料利用企業1社あたりの期待限界利益 = 有料化率 × 有料取引1社の限界利益、
 * 差し引き = 期待限界利益 − 無料利用企業1社の獲得・提供・成約前の対応費。
 * ナレッジの例（12か月・限界利益30万円・対応費6,000円）: 0.5% → 1,500円（−4,500円）/ 2% → 6,000円（0円＝固定費前の損益分岐）/ 5% → 15,000円（＋9,000円）。
 * 無料登録者数だけでは採算を判断できない。確かめるのは有料化率・取引の利益・成約しない利用者も含めた費用。
 */
import type { Monetization } from './model'

function nonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** 0〜1 の率（範囲外・NaN は null） */
function rateOf(v: unknown): number | null {
  const n = nonNeg(v)
  return n !== null && n <= 1 ? n : null
}

/** 円の計算の誤差（0.005 × 300000 = 1500.0000000000002 など）を丸める（小数第2位。丸めであふれる巨大値はそのまま） */
function yen(v: number): number | null {
  if (!Number.isFinite(v)) return null
  const r = Math.round(v * 100) / 100
  return Number.isFinite(r) ? r : v
}

/**
 * 有料化率 rate のときの、無料利用企業1社あたりの期待限界利益（expected）と、対応費を引いた差し引き（net）。
 * rate が 0〜1 の外・限界利益が未確認なら expected も net も null。対応費が未確認なら net だけ null
 */
export function expectedMargin(m: Monetization, rate: number): { expected: number | null; net: number | null } {
  const r = rateOf(rate)
  const margin = nonNeg(m?.marginPerDeal)
  if (r === null || margin === null) return { expected: null, net: null }
  const expected = yen(r * margin)
  const cost = nonNeg(m?.costPerFreeUser)
  return { expected, net: expected === null || cost === null ? null : yen(expected - cost) }
}

/** 試算する有料化率を整える（0〜1 の数だけ・重複を除いて昇順） */
export function conversionRates(scenarios: unknown): number[] {
  if (!Array.isArray(scenarios)) return []
  const set = new Set<number>()
  for (const v of scenarios) {
    const r = rateOf(v)
    if (r !== null) set.add(r)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 有料化率ごとの試算表（conversionScenarios の重複・範囲外を除いて昇順）。
 * breakEven は差し引きが 0 以上（固定費前の損益分岐に届く）。差し引きが出せなければ false
 */
export function monetizationTable(m: Monetization): Array<{ rate: number; expected: number | null; net: number | null; breakEven: boolean }> {
  return conversionRates(m?.conversionScenarios).map((rate) => {
    const { expected, net } = expectedMargin(m, rate)
    return { rate, expected, net, breakEven: net !== null && net >= 0 }
  })
}

/**
 * 損益分岐の有料化率 = 対応費 ÷ 有料取引1社の限界利益（例: 6,000 ÷ 300,000 = 2%）。
 * 限界利益が 0・負・未確認、対応費が負・未確認なら { rate: null, reachable: null }。
 * 1 を超える率もそのまま返し、reachable を false にする（全員が有料になっても届かない＝到達不能）
 */
export function breakEvenRate(m: Monetization): { rate: number | null; reachable: boolean | null } {
  const margin = nonNeg(m?.marginPerDeal)
  const cost = nonNeg(m?.costPerFreeUser)
  if (margin === null || margin === 0 || cost === null) return { rate: null, reachable: null }
  const rate = cost / margin
  if (!Number.isFinite(rate)) return { rate: null, reachable: null }
  return { rate, reachable: rate <= 1 }
}
