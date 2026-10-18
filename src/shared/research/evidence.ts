/**
 * 証拠の強さの集計（docs/business-research/knowledge.md 第2原則「証拠の強弱」）。
 * - 行動の証拠（契約・有料利用・予算付きの募集）を重く見る。AI の推測は「調査すべき仮説」であり裏付けにしない。
 * - 原典（http(s) の URL）と、原文か観測した事実のどちらかが無いものは裏付けに数えない。
 * - 独立性: 同じ dupGroup（同じ発表・転載のまとまり）は1件。dupGroup が空なら URL のホスト名で数える（同じ媒体から何件集めても1つ）。
 * - 収集（collected）と評価（evaluated）は別の工程（第2部「収集と評価は別の工程にする」）。読む5観点（reading）は評価の工程で付く。
 */
import {
  COMPLAINT_GRADES,
  GRADE_RELIABILITY,
  READING_KEYS,
  RELIABILITY_LEVELS,
  SPEND_GRADES,
  type EvidenceGrade,
  type Reliability,
  type ResearchEvidence
} from './model'

/** 配列でなければ空（壊れた記録への備え。readonly 配列の型を保つ） */
function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

/** 信頼性の5区分の点（high 5 … low 1）。並べ替えと「最も強いもの」の比較に使う */
export const RELIABILITY_POINTS: Record<Reliability, number> = {
  high: 5,
  fairlyHigh: 4,
  medium: 3,
  lowMedium: 2,
  low: 1
}

/** 証拠の種類 → 信頼性（ナレッジの表）。知らない種類は最も弱い low として扱う */
export function reliabilityOf(grade: EvidenceGrade): Reliability {
  return Object.prototype.hasOwnProperty.call(GRADE_RELIABILITY, grade) ? GRADE_RELIABILITY[grade] : 'low'
}

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

/** http(s) の URL ならホスト名（先頭の www. を除き小文字）。それ以外は null */
export function evidenceHost(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  return host === '' ? null : host
}

/**
 * 独立性を数えるための鍵。dupGroup があればそれ（同じ発表・転載は1件）、無ければ URL のホスト名。どちらも無ければ null
 */
export function evidenceSourceKey(e: ResearchEvidence): string | null {
  if (!e || typeof e !== 'object') return null
  if (filled(e.dupGroup)) return `group:${e.dupGroup.trim().toLowerCase()}`
  const host = evidenceHost(e.url)
  return host === null ? null : `host:${host}`
}

/**
 * 読む5観点の集計（第2部 8章「証拠を読む5点」: 対象との一致・行動の具体性・時点の適切さ・独立性・選ばれ方の偏り）。
 * unset は未評価（null・知らない値・欠け）
 */
export function readingScore(e: ResearchEvidence): { ok: number; weak: number; ng: number; unset: number } {
  const out = { ok: 0, weak: 0, ng: 0, unset: 0 }
  const reading = e && typeof e === 'object' && e.reading && typeof e.reading === 'object' ? e.reading : null
  for (const k of READING_KEYS) {
    const v = reading?.[k]
    if (v === 'ok' || v === 'weak' || v === 'ng') out[v]++
    else out.unset++
  }
  return out
}

/** 評価の工程を済ませた証拠か（state が evaluated） */
export function isEvaluated(e: ResearchEvidence): boolean {
  return !!e && typeof e === 'object' && e.state === 'evaluated'
}

/**
 * 裏付けに使える証拠か（点数の根拠・成立条件の支持と反証・「選ばれる理由」の裏付け・証拠の強さの集計に数えるもの）。
 * 条件: AI の推測（aiInference）でない／url が http(s)／原文（quote）か観測した事実（fact）がある／
 * 読む5観点で「対象との一致（match）」か「時点の適切さ（timing）」が ng でない（対象違い・古い事例を現在の証拠にしない）。
 * 未評価（state collected）でも使える（評価で ng が付いたら外れる）。独立性・偏りの ng は数え方（独立数・強さ）で扱い、ここでは外さない
 */
export function isUsableAsProof(e: ResearchEvidence): boolean {
  if (!e || typeof e !== 'object') return false
  if (e.grade === 'aiInference') return false
  if (!Object.prototype.hasOwnProperty.call(GRADE_RELIABILITY, e.grade)) return false
  if (evidenceHost(e.url) === null) return false
  if (e.reading && typeof e.reading === 'object' && (e.reading.match === 'ng' || e.reading.timing === 'ng')) return false
  return filled(e.quote) || filled(e.fact)
}

export interface EvidenceSummary {
  /** 件数（ID の重複は1件） */
  count: number
  /** 信頼性ごとの件数（裏付けに使えないものも含めた全件） */
  byReliability: Record<Reliability, number>
  /** 裏付けに使える証拠のうち最も強い信頼性（無ければ null） */
  best: Reliability | null
  /** 証拠の強さ（下の基準） */
  level: 'strong' | 'moderate' | 'weak' | 'none'
  /** 支出を示す裏付け（SPEND_GRADES）の件数 */
  spend: number
  /** 不満を示す裏付け（COMPLAINT_GRADES）の件数 */
  complaint: number
  /** 既存支出と不満が同時に確認できる（ナレッジ「既存支出と不満が同時に確認できる市場を重視」） */
  spendAndComplaint: boolean
  /** 裏付けに使える証拠の独立した出どころの数（同じ dupGroup は1つ。dupGroup が空ならホスト名で数える） */
  independentSources: number
}

/**
 * 証拠の一覧をまとめる。best・level・spend・complaint・independentSources は裏付けに使える証拠（isUsableAsProof）だけで数える。
 * level の基準:
 * - strong:   信頼性 high（契約・有料利用・予算付きの募集）が1件以上、かつ独立した出どころが2つ以上
 * - moderate: high か fairlyHigh（競合の導入事例）が1件以上（出どころが1つだけの high を含む）、
 *             または medium 以上が独立した出どころ2つ以上から確認できる
 * - weak:     裏付けに使える証拠はあるが上に届かない（SNS の不満だけ、出どころ1つの中程度の証拠など）
 * - none:     裏付けに使える証拠が無い（AI の推測だけ・URL 無しを含む）
 */
export function summarizeEvidence(list: readonly ResearchEvidence[]): EvidenceSummary {
  const byReliability = Object.fromEntries(RELIABILITY_LEVELS.map((r) => [r, 0])) as Record<Reliability, number>
  const seen = new Set<string>()
  const hosts = new Set<string>()
  const mediumHosts = new Set<string>()
  let count = 0
  let bestPoints = 0
  let spend = 0
  let complaint = 0
  for (const e of arr(list)) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.id === 'string' && e.id !== '') {
      if (seen.has(e.id)) continue
      seen.add(e.id)
    }
    count++
    const r = reliabilityOf(e.grade)
    byReliability[r]++
    if (!isUsableAsProof(e)) continue
    const key = evidenceSourceKey(e) as string
    hosts.add(key)
    if (RELIABILITY_POINTS[r] >= RELIABILITY_POINTS.medium) mediumHosts.add(key)
    bestPoints = Math.max(bestPoints, RELIABILITY_POINTS[r])
    if (SPEND_GRADES.includes(e.grade)) spend++
    if (COMPLAINT_GRADES.includes(e.grade)) complaint++
  }
  const best = RELIABILITY_LEVELS.find((r) => RELIABILITY_POINTS[r] === bestPoints) ?? null
  const independentSources = hosts.size
  let level: EvidenceSummary['level'] = 'none'
  if (best === 'high' && independentSources >= 2) level = 'strong'
  else if (best === 'high' || best === 'fairlyHigh' || mediumHosts.size >= 2) level = 'moderate'
  else if (best !== null) level = 'weak'
  return {
    count,
    byReliability,
    best,
    level,
    spend,
    complaint,
    spendAndComplaint: spend > 0 && complaint > 0,
    independentSources
  }
}
