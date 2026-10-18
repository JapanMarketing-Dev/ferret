/**
 * 顧客満足のまとめ（streams/satisfaction/responses.json）。
 * - NPS = 推奨者（9〜10）の割合 − 批判者（0〜6）の割合（%）を整数に四捨五入（0.5 は大きい方へ。-0 は 0）。nps の回答の score が 0〜10 の数のものだけ数える
 * - CSAT = csat の回答の score（1〜5）の平均を小数1桁に四捨五入
 * - 範囲外・数でない（NaN・Infinity・文字）score は数えない（回答の件数には入れる）
 * - topTags … 前後の空白を除いたタグの件数（1回答の中の重複は1回）。多い順、同じなら文字の順で上位5件
 */
import type { Period, SatisfactionResponse, SatisfactionSummary } from './model'
import { dayOf, inPeriod } from './period'

export const TOP_TAGS = 5

function score(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
}

/** 回答のまとめ。period を渡せば回答の日（date の先頭の日付）が期間に入るものだけ。日付の読めない回答は期間を渡したとき数えない */
export function satisfactionSummary(responses: readonly SatisfactionResponse[], period?: Period | null): SatisfactionSummary {
  const list = (Array.isArray(responses) ? responses : []).filter((r) => {
    if (!r || typeof r !== 'object') return false
    if (!period) return true
    const d = dayOf(r.date)
    return d !== null && inPeriod(d, period)
  })
  let promoters = 0
  let passives = 0
  let detractors = 0
  let csatSum = 0
  let csatCount = 0
  let interviews = 0
  const tags = new Map<string, number>()
  for (const r of list) {
    if (r.method === 'nps') {
      const s = score(r.score, 0, 10)
      if (s !== null) {
        if (s >= 9) promoters++
        else if (s > 6) passives++
        else detractors++
      }
    } else if (r.method === 'csat') {
      const s = score(r.score, 1, 5)
      if (s !== null) {
        csatSum += s
        csatCount++
      }
    } else if (r.method === 'interview') {
      interviews++
    }
    if (Array.isArray(r.tags)) {
      const raw: unknown[] = r.tags
      const own = new Set(raw.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => t !== ''))
      for (const t of own) tags.set(t, (tags.get(t) ?? 0) + 1)
    }
  }
  const npsResponses = promoters + passives + detractors
  const nps = npsResponses > 0 ? Math.round(((promoters - detractors) / npsResponses) * 100) || 0 : null
  const csat = csatCount > 0 ? Math.round((csatSum / csatCount) * 10) / 10 : null
  const topTags = [...tags.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, TOP_TAGS)
  return { responses: list.length, nps, npsResponses, promoters, passives, detractors, csat, interviews, topTags }
}
