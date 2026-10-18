/**
 * 採点・ランキング（docs/business-research/knowledge.md「6つの機能」の 5 採点・ランキングと経済性、model.ts の SCORE_KEYS）。
 * - 根拠のない点数を出さない: 根拠の証拠（ScoreEntry.evidence がデータ内にあり isUsableAsProof）が1件以上ある点だけを数える。
 *   点はあるが根拠の無い項目は unbacked として返し、画面で「根拠なし」と見せる。
 * - 各数値に証拠の信頼度を併記する（scoreReliability）。
 * - 高得点でも購入検証（G4）は省略できない（ここはあくまで比べる順）。
 * - 評価の主軸は成立条件の表（conditions.ts）で、このスコアは補助（第2部）。重要な条件に反証があれば点が高くても保留にする。
 * - Learning: 実測の成約率と事前の点数・証拠の関係を残し、次の候補の評価に使う（calibration）。
 */
import { summarizeEvidence, isUsableAsProof, reliabilityOf, RELIABILITY_POINTS, type EvidenceSummary } from './evidence'
import { hasCriticalCounter } from './conditions'
import { nextDecision } from './decision'
import { experimentCac } from './economics'
import { mergeMetrics, stepRate } from './funnel'
import {
  DEFAULT_CUTOFFS,
  DEFAULT_WEIGHTS,
  SCORE_KEYS,
  type ConditionKey,
  type Maybe,
  type NextDecision,
  type Reliability,
  type ResearchData,
  type ResearchEvidence,
  type Score,
  type ScoreEntry,
  type ScoreKey
} from './model'

/** 配列でなければ空（壊れた記録への備え。readonly 配列の型を保つ） */
function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

type EvidenceSource = Pick<ResearchData, 'evidence'>

function isScore(v: unknown): v is Score {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5
}

/**
 * 重みを整える。各項目を 0〜100 の整数に丸め（範囲外は端に寄せる）、数でない・欠けた項目は初期値（DEFAULT_WEIGHTS）。
 * 合計が 0 になるなら全部を初期値に戻す（割る数が無くなるため）
 */
export function normalizeWeights(w: unknown): Record<ScoreKey, number> {
  const src = w && typeof w === 'object' && !Array.isArray(w) ? (w as Record<string, unknown>) : {}
  const out = {} as Record<ScoreKey, number>
  for (const k of SCORE_KEYS) {
    const v = src[k]
    out[k] = typeof v === 'number' && !Number.isNaN(v) ? Math.round(Math.min(100, Math.max(0, v))) : DEFAULT_WEIGHTS[k]
  }
  return SCORE_KEYS.every((k) => out[k] === 0) ? { ...DEFAULT_WEIGHTS } : out
}

/** 足切りを整える（1〜5 の数か null。数でないものは初期値。範囲外は端に寄せる） */
export function normalizeCutoffs(c: unknown): Record<ScoreKey, Maybe<number>> {
  const src = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {}
  const out = {} as Record<ScoreKey, Maybe<number>>
  for (const k of SCORE_KEYS) {
    const v = src[k]
    if (v === null) out[k] = null
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(5, Math.max(1, v))
    else out[k] = DEFAULT_CUTOFFS[k]
  }
  return out
}

/** 点の根拠の証拠のうち、データ内にあり裏付けに使えるもの（ID の重複は1件） */
export function backingEvidence(entry: ScoreEntry | null | undefined, data: EvidenceSource): ResearchEvidence[] {
  const ids = Array.isArray(entry?.evidence) ? [...new Set(entry.evidence.filter((id) => typeof id === 'string'))] : []
  const list = Array.isArray(data?.evidence) ? data.evidence : []
  const out: ResearchEvidence[] = []
  for (const id of ids) {
    const e = list.find((x) => x && x.id === id)
    if (e && isUsableAsProof(e)) out.push(e)
  }
  return out
}

/** 根拠のある点（根拠が無い・点が 1〜5 でなければ null） */
export function backedScore(entry: ScoreEntry | null | undefined, data: EvidenceSource): Score | null {
  if (!entry || !isScore(entry.score)) return null
  return backingEvidence(entry, data).length > 0 ? entry.score : null
}

/** 点の横に出す証拠の信頼度（根拠の証拠のうち最も強いもの。根拠が無ければ null） */
export function scoreReliability(entry: ScoreEntry, data: ResearchData): Reliability | null {
  let best: Reliability | null = null
  for (const e of backingEvidence(entry, data)) {
    const r = reliabilityOf(e.grade)
    if (best === null || RELIABILITY_POINTS[r] > RELIABILITY_POINTS[best]) best = r
  }
  return best
}

/** 点はあるが根拠の無い項目（SCORE_KEYS の順） */
function unbackedKeys(scores: Record<ScoreKey, ScoreEntry>, data: EvidenceSource): ScoreKey[] {
  return SCORE_KEYS.filter((k) => isScore(scores?.[k]?.score) && backedScore(scores[k], data) === null)
}

/**
 * 加重スコア（100点満点）= Σ(点 × 重み) ÷ Σ(重み) × 20。
 * 根拠のある点の付いた項目だけで重みを割り直す（未採点・根拠なしの項目は 0 点にしない）。点は 1〜5 なので値は 20〜100。
 * scored は数えた項目の数。数えられる項目が無いか、その重みの合計が 0 なら value は null。小数第1位に丸める
 */
export function weightedScore(
  scores: Record<ScoreKey, ScoreEntry>,
  weights: Record<ScoreKey, number>,
  data: EvidenceSource
): { value: number | null; scored: number; unbacked: ScoreKey[] } {
  const w = normalizeWeights(weights)
  let sum = 0
  let weightSum = 0
  let scored = 0
  for (const k of SCORE_KEYS) {
    const s = backedScore(scores?.[k], data)
    if (s === null) continue
    scored++
    sum += s * w[k]
    weightSum += w[k]
  }
  const value = weightSum > 0 ? Math.round((sum / weightSum) * 20 * 10) / 10 : null
  return { value, scored, unbacked: unbackedKeys(scores, data) }
}

/**
 * 事業魅力度（比較用の概念式）= 需要 × 到達 × 利益 ÷ ((6 − 競争の余地) × (6 − 提供のしやすさ))。
 * 5項目のどれかに根拠のある点が無ければ null。値は 1/25（最低）〜125（最高）。小数第2位に丸める
 */
export function attractiveness(scores: Record<ScoreKey, ScoreEntry>, data: EvidenceSource): { value: number | null; unbacked: ScoreKey[] } {
  const get = (k: ScoreKey) => backedScore(scores?.[k], data)
  const demand = get('demand')
  const reach = get('reach')
  const profit = get('profit')
  const competition = get('competition')
  const delivery = get('delivery')
  const unbacked = unbackedKeys(scores, data)
  if (demand === null || reach === null || profit === null || competition === null || delivery === null) return { value: null, unbacked }
  const value = (demand * reach * profit) / ((6 - competition) * (6 - delivery))
  return { value: Math.round(value * 100) / 100, unbacked }
}

/**
 * 足切りに掛かった項目（点が足切りより下）。例: 顧客到達性が1点なら、ほかが高くても保留。
 * 足切りは安全側の判断なので、根拠の無い点でも数える（低い点を根拠なしで無視しない）。足切り null の項目は見ない
 */
export function cutoffHits(scores: Record<ScoreKey, ScoreEntry>, cutoffs: Record<ScoreKey, Maybe<number>>): ScoreKey[] {
  const c = normalizeCutoffs(cutoffs)
  return SCORE_KEYS.filter((k) => {
    const s = scores?.[k]?.score
    const limit = c[k]
    return isScore(s) && limit !== null && s < limit
  })
}

export interface RankRow {
  id: string
  /** 加重スコア（根拠のある点だけ。100点満点） */
  value: number | null
  attractiveness: number | null
  /** 保留: 足切りに掛かった、または重要な成立条件に反証がある */
  held: boolean
  cutoffs: ScoreKey[]
  /** 反証の警告が出ている成立条件（hasCriticalCounter） */
  alarms: ConditionKey[]
  /** 次の行動の機械の目安（nextDecision） */
  decision: NextDecision
  /** 点はあるが根拠の無い項目 */
  unbacked: ScoreKey[]
  /** その候補に結び付いた証拠のまとめ */
  evidence: EvidenceSummary
}

/**
 * 候補の並び（比べる順）。dropped を除く。保留（held＝足切り・成立条件の反証）は後ろ、加重スコアの降順、null は最後、同じなら ID の昇順。
 * 重み・足切りは research.yaml の値を整えて使う
 */
export function rankCandidates(data: ResearchData): RankRow[] {
  const weights = normalizeWeights(data?.research?.weights)
  const cutoffs = normalizeCutoffs(data?.research?.cutoffs)
  const evidence = Array.isArray(data?.evidence) ? data.evidence : []
  const rows: RankRow[] = (Array.isArray(data?.candidates) ? data.candidates : [])
    .filter((c) => c && c.stage !== 'dropped')
    .map((c) => {
      const hits = cutoffHits(c.scores, cutoffs)
      const alarms = hasCriticalCounter(c, data)
      const ws = weightedScore(c.scores, weights, data)
      return {
        id: c.id,
        value: ws.value,
        attractiveness: attractiveness(c.scores, data).value,
        held: hits.length > 0 || alarms.length > 0,
        cutoffs: hits,
        alarms,
        decision: nextDecision(c, data).suggestion,
        unbacked: ws.unbacked,
        evidence: summarizeEvidence(evidence.filter((e) => e && e.candidate === c.id))
      }
    })
  return rows.sort((a, b) => {
    if (a.held !== b.held) return a.held ? 1 : -1
    if (a.value !== b.value) {
      if (a.value === null) return 1
      if (b.value === null) return -1
      return b.value - a.value
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export interface CalibrationRow {
  candidateId: string
  /** 事前の加重スコア（根拠のある点だけ） */
  score: number | null
  evidenceLevel: EvidenceSummary['level']
  /** 実測の成約率（契約 ÷ 商談。planned を除く実験の合計） */
  measuredCloseRate: number | null
  /** 実測の CAC（experimentCac） */
  measuredCac: number | null
}

/**
 * Learning: 実測の成約率と、事前の点数・証拠の強さの関係（実験のある候補だけ。dropped も学びとして含める）。
 * 候補の並びは data.candidates の順
 */
export function calibration(data: ResearchData): CalibrationRow[] {
  const weights = normalizeWeights(data?.research?.weights)
  const experiments = Array.isArray(data?.experiments) ? data.experiments : []
  const evidence = Array.isArray(data?.evidence) ? data.evidence : []
  const rows: CalibrationRow[] = []
  for (const c of Array.isArray(data?.candidates) ? data.candidates : []) {
    if (!c) continue
    const own = experiments.filter((x) => x && x.candidate === c.id)
    if (own.length === 0) continue
    const m = mergeMetrics(own.filter((x) => x.status !== 'planned'))
    rows.push({
      candidateId: c.id,
      score: weightedScore(c.scores, weights, data).value,
      evidenceLevel: summarizeEvidence(evidence.filter((e) => e && e.candidate === c.id)).level,
      measuredCloseRate: stepRate(m.meetings, m.contracts),
      measuredCac: experimentCac(own).cac
    })
  }
  return rows
}

/**
 * 事前の点数と実測の成約率の相関（ピアソン）。両方の数がある候補だけを数える（n）。
 * n < 3、またはどちらかが全部同じ値（ばらつき 0）なら correlation は null。小数第3位に丸める
 */
export function calibrationNote(rows: readonly CalibrationRow[]): { n: number; correlation: number | null } {
  const pairs = arr(rows)
    .filter((r) => r && typeof r.score === 'number' && Number.isFinite(r.score) && typeof r.measuredCloseRate === 'number' && Number.isFinite(r.measuredCloseRate))
    .map((r) => [r.score as number, r.measuredCloseRate as number] as const)
  const n = pairs.length
  if (n < 3) return { n, correlation: null }
  if (new Set(pairs.map((p) => p[0])).size === 1 || new Set(pairs.map((p) => p[1])).size === 1) return { n, correlation: null }
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n
  const my = pairs.reduce((s, p) => s + p[1], 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  if (sxx <= 0 || syy <= 0) return { n, correlation: null }
  const r = sxy / Math.sqrt(sxx * syy)
  return { n, correlation: Math.round(Math.max(-1, Math.min(1, r)) * 1000) / 1000 }
}
