/**
 * 需要点 D（10点満点）・獲得点 A（8点満点）・提供条件 P の集計（手法.md 6〜7章）。
 * - U が1つでもあれば合計しない（「未完了」）。U を 0 として埋めない。
 * - D と A は足さない。P は はい／いいえ／U のまま数える。
 * - 独立した当事者は、重複グループを除き、原典を読めた証拠だけを数える。販売者の説明・分析者の推測は数えない。
 */
import {
  ACQUISITION_KEYS,
  DEMAND_KEYS,
  PROVISION_KEYS,
  UNKNOWN,
  type Evidence,
  type Hypothesis,
  type ScoreEntry
} from './model'

export type Total =
  | { complete: true; total: number; max: number }
  | { complete: false; known: number; unknown: number; max: number }

function total(entries: readonly ScoreEntry[], max: number): Total {
  const unknown = entries.filter((e) => e.score === UNKNOWN).length
  const known = entries.reduce((sum, e) => sum + (e.score === UNKNOWN ? 0 : e.score), 0)
  return unknown > 0 ? { complete: false, known, unknown, max } : { complete: true, total: known, max }
}

export function demandTotal(h: Hypothesis): Total {
  return total(DEMAND_KEYS.map((k) => h.demand[k]), 10)
}

export function acquisitionTotal(h: Hypothesis): Total {
  return total(ACQUISITION_KEYS.map((k) => h.acquisition[k]), 8)
}

/** 合計の表示（U を含めば「未完了（U 残り n）」） */
export function totalLabel(t: Total): string {
  return t.complete ? `${t.total} / ${t.max}` : `未完了（U 残り ${t.unknown}）`
}

export function provisionSummary(h: Hypothesis): { yes: number; no: number; unknown: number } {
  const values = PROVISION_KEYS.map((k) => h.provision[k].value)
  return {
    yes: values.filter((v) => v === 'はい').length,
    no: values.filter((v) => v === 'いいえ').length,
    unknown: values.filter((v) => v === UNKNOWN).length
  }
}

/** U の残り（D・A・P の合計） */
export function unknownCount(h: Hypothesis): number {
  return (
    DEMAND_KEYS.filter((k) => h.demand[k].score === UNKNOWN).length +
    ACQUISITION_KEYS.filter((k) => h.acquisition[k].score === UNKNOWN).length +
    PROVISION_KEYS.filter((k) => h.provision[k].value === UNKNOWN).length
  )
}

/** 独立当事者として数えられる証拠か（理由つき。数えないものは画面で理由を出す） */
export function countability(e: Evidence): { counts: true } | { counts: false; reason: string } {
  if (e.readStatus !== '読了') return { counts: false, reason: '原典を読めていない（発見のみ）' }
  if (!e.url.trim()) return { counts: false, reason: '原典の URL が無い' }
  if (e.sourceKind === '販売者の説明') return { counts: false, reason: '販売者の説明は別の当事者の不満として数えない' }
  if (e.sourceKind === '分析者の推測') return { counts: false, reason: '分析者の推測は証拠として数えない' }
  const group = e.dupGroup.trim()
  if (!group || group.toUpperCase() === UNKNOWN) return { counts: false, reason: '重複グループが U（独立性を確かめていない）' }
  return { counts: true }
}

/** 仮説に結びついた証拠 */
export function evidenceFor(hypothesisId: string, evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((e) => e.hypotheses.includes(hypothesisId))
}

/** 独立した当事者の数（重複グループごとに1） */
export function independentParties(hypothesisId: string, evidence: readonly Evidence[]): number {
  const groups = new Set<string>()
  for (const e of evidenceFor(hypothesisId, evidence)) {
    if (countability(e).counts) groups.add(e.dupGroup.trim())
  }
  return groups.size
}

/** 需要の根拠の原典の種類数（数えられる証拠の媒体の種類） */
export function sourceTypes(hypothesisId: string, evidence: readonly Evidence[]): number {
  const media = new Set<string>()
  for (const e of evidenceFor(hypothesisId, evidence)) {
    if (countability(e).counts && e.medium.trim()) media.add(e.medium.trim())
  }
  return media.size
}

/**
 * 追加調査を優先する初期目安（手法.md 6章）。D の全項目が確認済み、合計 8 以上、D2・D3・D4 が各 2、独立当事者 3 以上、原典 2 種類以上。
 * これは調べる順の目安で、需要認定・開発の承認ではない。満たさない条件を返す。
 */
export function priorityCheck(h: Hypothesis, evidence: readonly Evidence[]): { meets: boolean; missing: string[] } {
  const missing: string[] = []
  const d = demandTotal(h)
  if (!d.complete) missing.push(`D に U が ${d.unknown} 個残っている`)
  else if (d.total < 8) missing.push(`D の合計が ${d.total}（8 以上が目安）`)
  for (const k of ['D2', 'D3', 'D4'] as const) {
    if (h.demand[k].score !== 2) missing.push(`${k} が 2 でない`)
  }
  const parties = independentParties(h.id, evidence)
  if (parties < 3) missing.push(`独立当事者が ${parties}（3 以上が目安）`)
  const types = sourceTypes(h.id, evidence)
  if (types < 2) missing.push(`原典の種類が ${types}（2 以上が目安）`)
  return { meets: missing.length === 0, missing }
}
