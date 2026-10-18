/**
 * いまのステップの出口条件を、記録から機械的に確かめる（目安）。最後に進めるのは人。
 * 画面のステップパネルとダッシュボード、Agent へ渡す context.md が同じ結果を使う。
 */
import { STEP_IDS, stepById, type BusinessData, type Hypothesis, type StepId } from './model'
import { acquisitionTotal, demandTotal, independentParties, totalLabel, unknownCount } from './scoring'
import { judge } from './experiment'

export interface ExitCheck {
  label: string
  done: boolean
}

export function currentHypothesis(data: BusinessData): Hypothesis | null {
  const id = data.business.currentHypothesis
  return (id && data.hypotheses.find((h) => h.id === id)) || data.hypotheses[0] || null
}

/** ステップの出口のチェックリスト */
export function exitChecks(step: StepId, data: BusinessData): ExitCheck[] {
  const h = currentHypothesis(data)
  const hid = h?.id ?? ''
  const ev = data.evidence.filter((e) => !hid || e.hypotheses.includes(hid))
  const xs = data.experiments.filter((x) => !hid || x.hypothesis === hid)
  switch (step) {
    case 'S1':
      return [
        { label: 'ビジネス名がある', done: !!data.business.name.trim() },
        { label: '対象の1文（誰が・どの場面で・何を完了したいか）がある', done: data.business.target.trim().length >= 10 }
      ]
    case 'S2':
      return [
        { label: '原典の URL 付きの証拠がある', done: data.evidence.some((e) => /^https?:\/\//.test(e.url)) },
        { label: '原典を読んだ証拠（読了）がある', done: data.evidence.some((e) => e.readStatus === '読了') },
        { label: '検索履歴（検索語・期間・採否）がある', done: data.searches.length > 0 }
      ]
    case 'S3':
      return [
        { label: '課題仮説（H01…）がある', done: data.hypotheses.length > 0 },
        { label: '課題の1文がある', done: !!h?.problem.trim() },
        { label: '証拠が仮説に結びついている', done: ev.length > 0 },
        { label: '独立した当事者を数えられる（1 以上）', done: !!h && independentParties(h.id, data.evidence) > 0 }
      ]
    case 'S4':
      return [
        { label: '代替比較（ALT01…）がある', done: data.alternatives.some((a) => !hid || a.hypothesis === hid) },
        { label: '最大の反証が書かれている', done: !!h?.biggestCounter.trim() },
        { label: '現行手段で解消できない理由、または棄却の理由がある', done: !!h && (!!h.whyUnsolved.trim() || h.verdict === '棄却') }
      ]
    case 'S5':
      return [
        { label: 'D・A・P のどれかを採点した', done: !!h && unknownCount(h) < 13 },
        { label: '次に確かめることが書かれている', done: !!h?.next.trim() },
        { label: '判定（進める／追加調査／保留／棄却）を決めた', done: !!h?.verdict }
      ]
    case 'S6':
      return [
        { label: '提供の1文がある', done: !!h?.offer.trim() },
        { label: '実験（X01…）に価格・合格条件・中止条件がある', done: xs.some((x) => !!x.price.trim() && x.pass.length > 0 && x.stop.length > 0) }
      ]
    case 'S7':
      return [
        { label: '同意つきの聞き取りの記録がある', done: data.interviews.some((i) => i.consent && (!hid || i.hypothesis === hid)) },
        { label: '聞き取りから証拠を起こした', done: data.interviews.some((i) => i.evidence.length > 0) }
      ]
    case 'S8':
      return [
        { label: '実施中か完了の実験がある', done: xs.some((x) => x.status === '実施中' || x.status === '完了') },
        { label: '経路ごとの接触数の実測がある', done: xs.some((x) => x.actual.contacts !== null) }
      ]
    case 'S9':
      return [
        { label: '事前の条件で合格か中止かを判定できた', done: xs.some((x) => { const j = judge(x); return j.verdict === '合格' || j.verdict === '中止' }) }
      ]
    case 'S10':
      return [
        { label: '結論（C01…）を書いた', done: data.decisions.some((d) => !hid || d.hypothesis === hid) },
        { label: '変えるもの（対象・成果・価格・経路）を1つ決めた', done: data.business.loops.some((l) => l.loop === data.business.loop && l.changed !== null) }
      ]
  }
}

export function nextStep(step: StepId): StepId | null {
  const i = STEP_IDS.indexOf(step)
  return i >= 0 && i < STEP_IDS.length - 1 ? STEP_IDS[i + 1]! : null
}

/** ステップパネルに出す要約 */
export interface StepSummary {
  step: StepId
  name: string
  loop: number
  hypothesis: { id: string; name: string; stage: string } | null
  counts: { hypotheses: number; evidence: number; readEvidence: number; alternatives: number; interviews: number; experiments: number; pendingApprovals: number }
  demand: string
  acquisition: string
  unknowns: number
  independentParties: number
  next: string
  checks: ExitCheck[]
}

export function summarize(data: BusinessData): StepSummary {
  const step = data.business.step
  const h = currentHypothesis(data)
  return {
    step,
    name: stepById(step).name,
    loop: data.business.loop,
    hypothesis: h ? { id: h.id, name: h.name, stage: h.stage } : null,
    counts: {
      hypotheses: data.hypotheses.length,
      evidence: data.evidence.length,
      readEvidence: data.evidence.filter((e) => e.readStatus === '読了').length,
      alternatives: data.alternatives.length,
      interviews: data.interviews.length,
      experiments: data.experiments.length,
      pendingApprovals: data.approvals.filter((a) => a.status === '待ち').length
    },
    demand: h ? totalLabel(demandTotal(h)) : '—',
    acquisition: h ? totalLabel(acquisitionTotal(h)) : '—',
    unknowns: h ? unknownCount(h) : 0,
    independentParties: h ? independentParties(h.id, data.evidence) : 0,
    next: h?.next.trim() || '',
    checks: exitChecks(step, data)
  }
}
