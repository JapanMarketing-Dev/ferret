/**
 * 保存時の検査（構想 3章「守るルール」）。
 * error は保存させない（計画値と実測値を混ぜる、同意の無い原文など）。warning は保存して画面に残す。
 */
import { ACQUISITION_KEYS, DEMAND_KEYS, PROVISION_KEYS, SCORE_LABELS, UNKNOWN, idPattern, type BusinessData, type Experiment, type Hypothesis, type RecordKind, type RecordTypes } from './model'
import { actualBeforeStart, funnelProblems, overLimits } from './experiment'

export interface Issue {
  severity: 'error' | 'warning'
  /** どの記録か（H01 など。全体なら business） */
  ref: string
  field: string
  message: string
}

function scoreIssues(h: Hypothesis, data: Pick<BusinessData, 'evidence'>): Issue[] {
  const out: Issue[] = []
  const byId = new Map(data.evidence.map((e) => [e.id, e]))
  const check = (key: string, value: unknown, evidence: string[]) => {
    if (value === UNKNOWN) return
    if (evidence.length === 0) {
      out.push({ severity: 'warning', ref: h.id, field: key, message: `${key} ${SCORE_LABELS[key as keyof typeof SCORE_LABELS]} に根拠の証拠 ID がありません` })
      return
    }
    for (const id of evidence) {
      const e = byId.get(id)
      if (!e) out.push({ severity: 'warning', ref: h.id, field: key, message: `${key} の根拠 ${id} が証拠台帳にありません` })
      else if (e.readStatus !== '読了') out.push({ severity: 'warning', ref: h.id, field: key, message: `${key} の根拠 ${id} は原典を読めていません（発見のみ）` })
    }
  }
  for (const k of DEMAND_KEYS) check(k, h.demand[k].score, h.demand[k].evidence)
  for (const k of ACQUISITION_KEYS) check(k, h.acquisition[k].score, h.acquisition[k].evidence)
  for (const k of PROVISION_KEYS) check(k, h.provision[k].value, h.provision[k].evidence)
  return out
}

/** 段階が証拠より先へ進んでいないか（進めるのは人だが、記録が無ければ知らせる） */
function stageIssues(h: Hypothesis, data: Pick<BusinessData, 'experiments' | 'interviews'>): Issue[] {
  const out: Issue[] = []
  const order = ['探索メモ', 'ネット上の有望仮説', '当事者確認済み', '有料検証済み', '継続提供の見込みあり']
  const at = order.indexOf(h.stage)
  if (at >= 2 && !data.interviews.some((i) => i.hypothesis === h.id && i.consent)) {
    out.push({ severity: 'warning', ref: h.id, field: 'stage', message: '当事者確認済みより先ですが、同意つきの聞き取りの記録がありません' })
  }
  if (at >= 3 && !data.experiments.some((x) => x.hypothesis === h.id && (x.actual.payments ?? 0) > 0)) {
    out.push({ severity: 'warning', ref: h.id, field: 'stage', message: '有料検証済みより先ですが、入金を記録した実験がありません' })
  }
  if (at >= 4 && !data.experiments.some((x) => x.hypothesis === h.id && (x.actual.repurchased ?? 0) > 0)) {
    out.push({ severity: 'warning', ref: h.id, field: 'stage', message: '継続提供の見込みありですが、再購入を記録した実験がありません' })
  }
  return out
}

/** YYYY-MM-DD（実在する日）を比べられる数にする。形が違えば null */
export function isoDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null
}

function experimentIssues(x: Experiment): Issue[] {
  const out: Issue[] = []
  for (const field of actualBeforeStart(x)) {
    out.push({ severity: 'error', ref: x.id, field: `actual.${field}`, message: '実施前（計画のみ）の実験に実測値は入れられません。計画値の欄に入れてください' })
  }
  for (const message of funnelProblems(x.actual)) out.push({ severity: 'warning', ref: x.id, field: 'actual', message: `実測: ${message}` })
  for (const message of funnelProblems(x.plan)) out.push({ severity: 'warning', ref: x.id, field: 'plan', message: `計画: ${message}` })
  for (const message of overLimits(x)) out.push({ severity: 'warning', ref: x.id, field: 'limits', message })
  if (x.status !== '計画のみ' && x.pass.length === 0) out.push({ severity: 'warning', ref: x.id, field: 'pass', message: '合格条件が決められていません（実施前に決める）' })
  if (x.status !== '計画のみ' && x.stop.length === 0) out.push({ severity: 'warning', ref: x.id, field: 'stop', message: '中止条件が決められていません（実施前に決める）' })
  const start = isoDay(x.period.start)
  const end = isoDay(x.period.end)
  if (x.period.start && start === null) out.push({ severity: 'warning', ref: x.id, field: 'period.start', message: '開始日は 2026-10-17 の形で書いてください' })
  if (x.period.end && end === null) out.push({ severity: 'warning', ref: x.id, field: 'period.end', message: '終了日は 2026-10-17 の形で書いてください' })
  if (start !== null && end !== null && start > end) out.push({ severity: 'error', ref: x.id, field: 'period', message: '終了日が開始日より前です' })
  return out
}

/** 1件を保存する前の検査（他の記録との関係も見る） */
export function validateRecord<K extends RecordKind>(kind: K, record: RecordTypes[K], data: BusinessData): Issue[] {
  const out: Issue[] = []
  if (!idPattern(kind).test(record.id)) out.push({ severity: 'error', ref: record.id, field: 'id', message: `ID「${record.id}」の形が違います` })
  const hypothesisIds = new Set(data.hypotheses.map((h) => h.id))
  const refHypothesis = (id: string, field: string) => {
    if (id && !hypothesisIds.has(id)) out.push({ severity: 'warning', ref: record.id, field, message: `仮説 ${id} がありません` })
  }
  switch (kind) {
    case 'hypothesis': {
      const h = record as Hypothesis
      out.push(...scoreIssues(h, data), ...stageIssues(h, data))
      break
    }
    case 'evidence': {
      const e = record as RecordTypes['evidence']
      for (const h of e.hypotheses) refHypothesis(h, 'hypotheses')
      if (e.readStatus === '読了' && !e.url.trim()) out.push({ severity: 'warning', ref: e.id, field: 'url', message: '原典の URL がありません' })
      if (e.url && !/^https?:\/\//i.test(e.url.trim())) out.push({ severity: 'warning', ref: e.id, field: 'url', message: '原典の URL が http(s) ではありません' })
      if (e.readStatus === '読了' && !e.quote.trim() && !e.facts.trim()) out.push({ severity: 'warning', ref: e.id, field: 'facts', message: '読了ですが、確認した事実も原文も空です' })
      break
    }
    case 'alternative':
      refHypothesis((record as RecordTypes['alternative']).hypothesis, 'hypothesis')
      break
    case 'interview': {
      const i = record as RecordTypes['interview']
      refHypothesis(i.hypothesis, 'hypothesis')
      if (!i.consent && i.transcript.trim()) out.push({ severity: 'error', ref: i.id, field: 'transcript', message: '同意が無い聞き取りの原文は保存できません' })
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(`${i.summary}\n${i.transcript}`)) out.push({ severity: 'warning', ref: i.id, field: 'summary', message: 'メールアドレスらしき文字列があります。個人情報は記録に貼らないでください' })
      break
    }
    case 'experiment': {
      const x = record as Experiment
      refHypothesis(x.hypothesis, 'hypothesis')
      out.push(...experimentIssues(x))
      break
    }
    case 'decision':
      refHypothesis((record as RecordTypes['decision']).hypothesis, 'hypothesis')
      break
    case 'approval':
      break
  }
  return out
}

/** ビジネス全体の検査（読み込みの後・ダッシュボード） */
export function validateBusiness(data: BusinessData): Issue[] {
  const out: Issue[] = []
  const lists: Array<[RecordKind, ReadonlyArray<{ id: string }>]> = [
    ['hypothesis', data.hypotheses], ['evidence', data.evidence], ['alternative', data.alternatives], ['interview', data.interviews],
    ['experiment', data.experiments], ['decision', data.decisions], ['approval', data.approvals]
  ]
  for (const [kind, items] of lists) {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) out.push({ severity: 'error', ref: item.id, field: 'id', message: `ID ${item.id} が重複しています` })
      seen.add(item.id)
      out.push(...validateRecord(kind, item as RecordTypes[typeof kind], data))
    }
  }
  if (data.business.currentHypothesis && !data.hypotheses.some((h) => h.id === data.business.currentHypothesis)) {
    out.push({ severity: 'warning', ref: 'business', field: 'currentHypothesis', message: `今の仮説 ${data.business.currentHypothesis} がありません` })
  }
  for (const p of data.problems) out.push({ severity: 'warning', ref: p.path, field: '', message: p.message })
  return out
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}
