import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, Plus } from 'lucide-react'
import { CANDIDATE_STAGES, type Candidate, type CandidateStage, type ConditionKey, type NextDecision, type ResearchData } from '@shared/research/model'
import { rankCandidates } from '@shared/research/scoring'
import { nextGate } from '@shared/research/gates'
import { hasCriticalCounter } from '@shared/research/conditions'
import { nextDecision } from '@shared/research/decision'
import { useT } from '../lib/i18n'
import { Badge, Button, EmptyState, type BadgeTone } from '../ui'
import {
  FLOW_STEPS,
  droppedCount,
  filterCandidates,
  flowCounts,
  flowStepOf,
  formatAttractiveness,
  formatScore,
  funnelRows,
  progressPercent,
  sortCandidateRows,
  type CandidateRowInput,
  type CandidateSortKey,
  type FlowStep
} from './view'

const LEVEL_TONE: Record<CandidateRowInput['evidenceLevel'], BadgeTone> = { strong: 'success', moderate: 'brand', weak: 'warning', none: 'neutral' }

/**
 * 上の帯: 「いまどこか」の流れ（Discovery → Evidence → Ranking → Experiment → Learning → プロジェクトにする）と、
 * ファンネル（1000 → 100 → 20 → 5 → 1〜2 の目安と実数）を一つの流れとして見せる。
 * 選んだ候補がいる段を強く出す。段を押すと、その段で主に触る区分へ移る
 */
export function FlowFunnel({ data, selected, onPickStep }: { data: ResearchData; selected: Candidate | null; onPickStep: (step: FlowStep) => void }) {
  const t = useT()
  const counts = flowCounts(data)
  const rows = funnelRows(data.candidates, data.research.funnelTargets)
  const current = selected ? flowStepOf(selected, data.experiments) : null
  const dropped = droppedCount(data.candidates)
  return (
    <div className="rs-top" data-testid="research-top">
      <ol className="rs-flow" aria-label={t('research.flow.label')} data-testid="research-flow">
        {FLOW_STEPS.map((step, i) => (
          <li key={step} className={`rs-flow__step${current === step ? ' is-current' : ''}`} data-step={step}>
            <button type="button" className="rs-flow__btn" onClick={() => onPickStep(step)} aria-current={current === step ? 'step' : undefined} data-testid={`research-flow-${step}`}>
              <span className="rs-flow__num biz-mono">{i + 1}</span>
              <span className="rs-flow__name">{t(`research.flow.${step}` as const)}</span>
              <span className="rs-flow__count biz-num-text">{counts[step]}</span>
            </button>
            <span className="rs-flow__sub biz-muted">{t(`research.flow.${step}.sub` as const)}</span>
          </li>
        ))}
      </ol>
      <ol className="rs-funnel" aria-label={t('research.funnel.label')} data-testid="research-funnel">
        {rows.map((r) => (
          <li key={r.stage} className={`rs-funnel__stage${selected?.stage === r.stage ? ' is-current' : ''}`} data-stage={r.stage} data-testid={`research-funnel-${r.stage}`}>
            <span className="rs-funnel__name">{t(`research.enum.stage.${r.stage}` as const)}</span>
            <span className="rs-funnel__nums biz-num-text">
              <strong>{r.reached}</strong>
              <span className="biz-muted"> / {r.target ?? '—'}</span>
            </span>
            <span className="rs-funnel__bar" aria-hidden="true"><span style={{ width: `${progressPercent(r.reached, r.target)}%` }} /></span>
            <span className="rs-funnel__rate biz-muted biz-num-text">{r.rate === null ? '' : t('research.funnel.kept', { rate: `${Math.round(r.rate * 100)}%` })}</span>
          </li>
        ))}
        <li className="rs-funnel__dropped biz-muted" data-testid="research-funnel-dropped">{t('research.funnel.dropped', { n: dropped })}</li>
      </ol>
    </div>
  )
}

/** 候補の一覧（スコア/100・魅力度・足切り・証拠の信頼度・次のゲート）。押すと選ぶ */
export function CandidateList({ data, selectedId, onSelect, onNew }: { data: ResearchData; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const t = useT()
  const [sort, setSort] = useState<{ key: CandidateSortKey; dir: 'asc' | 'desc' }>({ key: 'score', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState<'all' | 'active' | CandidateStage>('active')
  const rows = useMemo(() => {
    const rank = new Map(rankCandidates(data).map((r) => [r.id, r]))
    const visible = filterCandidates(data.candidates, query, stage)
    const input = visible.map((c): CandidateRowInput & { candidate: Candidate; alarms: ConditionKey[]; decision: NextDecision } => {
      const r = rank.get(c.id)
      return {
        candidate: c,
        alarms: r?.alarms ?? hasCriticalCounter(c, data),
        decision: r?.decision ?? nextDecision(c, data).suggestion,
        id: c.id,
        title: c.title,
        stage: c.stage,
        value: r?.value ?? null,
        attractiveness: r?.attractiveness ?? null,
        held: r?.held ?? false,
        cutoffs: r?.cutoffs ?? [],
        evidenceLevel: r?.evidence.level ?? 'none',
        evidenceCount: r?.evidence.count ?? 0,
        nextGate: nextGate(c),
        updatedAt: c.updatedAt
      }
    })
    return sortCandidateRows(input, sort.key, sort.dir)
  }, [data, query, stage, sort])
  const head = (key: CandidateSortKey, label: string) => {
    const active = sort.key === key
    return (
      <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className="rs-sort" onClick={() => setSort({ key, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })} data-testid={`research-sort-${key}`}>
          {label}
          {active && (sort.dir === 'asc' ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />)}
        </button>
      </th>
    )
  }
  return (
    <section className="biz-section rs-block" aria-label={t('research.list.title')} data-testid="research-candidates">
      <header className="biz-section__head">
        <h3 className="biz-section__title">{t('research.list.title')}</h3>
        <span className="biz-count">{t('research.list.count', { n: rows.length, total: data.candidates.length })}</span>
        <div className="biz-section__actions">
          <div className="field rs-search"><input className="field__input" type="search" placeholder={t('research.list.search')} aria-label={t('research.list.search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="research-list-search" /></div>
          <select className="biz-select" aria-label={t('research.list.stageFilter')} value={stage} onChange={(e) => setStage(e.target.value as typeof stage)} data-testid="research-list-stage">
            <option value="active">{t('research.list.active')}</option>
            <option value="all">{t('research.list.all')}</option>
            {CANDIDATE_STAGES.map((s) => <option key={s} value={s}>{t(`research.enum.stage.${s}` as const)}</option>)}
          </select>
          <Button icon={<Plus size={13} />} onClick={onNew} data-testid="research-candidate-new">{t('research.list.new')}</Button>
        </div>
      </header>
      {data.candidates.length === 0 ? (
        <EmptyState size="sm" title={t('research.list.empty')} description={t('research.list.emptyHint')} testId="research-candidates-empty" />
      ) : rows.length === 0 ? (
        <p className="biz-muted">{t('research.list.noMatch')}</p>
      ) : (
        <div className="rs-scroll">
          <table className="biz-table rs-list-table">
            <thead>
              <tr>
                {head('id', 'ID')}
                <th className="biz-col-grow">{t('research.list.candidate')}</th>
                <th>{t('research.list.counter')}</th>
                <th>{t('research.list.decision')}</th>
                {head('stage', t('research.list.stage'))}
                {head('score', t('research.list.scoreAux'))}
                {head('attractiveness', t('research.list.attractiveness'))}
                <th>{t('research.list.cutoffs')}</th>
                {head('evidence', t('research.list.evidence'))}
                <th>{t('research.list.nextGate')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`biz-tr-link${r.id === selectedId ? ' is-selected' : ''}${r.stage === 'dropped' ? ' is-dropped' : ''}${r.alarms.length ? ' is-alarm' : ''}`} onClick={() => onSelect(r.id)} data-testid={`research-candidate-${r.id}`}>
                  <td><button type="button" className="biz-link biz-mono" onClick={(e) => { e.stopPropagation(); onSelect(r.id) }}>{r.id}</button></td>
                  <td className="biz-col-grow"><span className="biz-ellipsis" title={r.title}>{r.title || t('research.list.untitled')}</span></td>
                  <td data-testid={`research-candidate-${r.id}-alarm`} data-alarm={String(r.alarms.length > 0)}>
                    {r.alarms.length > 0 ? (
                      <span className="rs-alarm" title={r.alarms.map((k) => t(`research.cond.${k}` as const)).join(t('research.ws.listSep'))}>
                        <CircleAlert size={13} aria-hidden="true" />
                        <span>{t('research.list.counterN', { n: r.alarms.length })}</span>
                      </span>
                    ) : <span className="biz-muted">—</span>}
                  </td>
                  <td>
                    <Badge tone={r.decision === 'holdOrDrop' ? 'danger' : r.decision === 'invest' ? 'success' : r.decision === 'experiment' ? 'brand' : 'neutral'}>{t(`research.enum.decision.${r.decision}` as const)}</Badge>
                    {r.candidate.decision && r.candidate.decision !== r.decision && <span className="biz-muted rs-cell-note">{t('research.list.humanDecision', { decision: t(`research.enum.decision.${r.candidate.decision}` as const) })}</span>}
                  </td>
                  <td><Badge tone={r.stage === 'selected' ? 'success' : r.stage === 'dropped' ? 'danger' : 'neutral'}>{t(`research.enum.stage.${r.stage}` as const)}</Badge></td>
                  <td className="biz-num-text rs-score-cell">{r.value === null ? <span className="biz-muted">{t('research.list.noScore')}</span> : <><strong>{formatScore(r.value)}</strong><span className="biz-muted">/100</span></>}{r.held && <Badge tone="warning">{t('research.rank.held')}</Badge>}</td>
                  <td className="biz-num-text">{formatAttractiveness(r.attractiveness)}</td>
                  <td>{r.cutoffs.length ? r.cutoffs.map((k) => t(`research.enum.scoreKey.${k}` as const)).join(', ') : <span className="biz-muted">—</span>}</td>
                  <td><Badge tone={LEVEL_TONE[r.evidenceLevel]}>{t(`research.enum.evidenceLevel.${r.evidenceLevel}` as const)}</Badge> <span className="biz-muted biz-num-text">{r.evidenceCount}</span></td>
                  <td className="biz-mono">{r.candidate.promotedTo ? <Badge tone="success">{t('research.list.promoted')}</Badge> : r.nextGate ?? '—'}</td>
                  <td><ChevronRight size={14} aria-hidden="true" className="biz-muted" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
