import { useEffect, useMemo, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import {
  B2B_FUNNEL,
  CHANNELS,
  COMPARISON_METHODS,
  EXPERIMENT_METHODS,
  EXPERIMENT_STATUSES,
  METRIC_KEYS,
  PRINCIPLE_KEYS,
  WHO_FUNNEL,
  nextResearchId,
  type Candidate,
  type MetricKey,
  type ResearchData,
  type ResearchExperiment
} from '@shared/research/model'
import type { ResearchIssue, ResearchSnapshot } from '@shared/research/ipc'
import { emptyExperiment } from '@shared/research/records'
import { experimentCac } from '@shared/research/economics'
import { channelLearning, findBottleneck, funnelSteps, improvementVerdict, overallRate } from '@shared/research/funnel'
import { calibration, calibrationNote } from '@shared/research/scoring'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, EmptyState, useToast } from '../ui'
import { useResearchApi } from './api'
import { Block, EnumSelect, NumField, toFieldIssues, Txt } from './fields'
import { barWidths, formatPercent, formatRatio, formatScore, formatYen, isIsoDate, sameJson } from './view'

const VERDICT_TONE = { proven: 'success', needsComparison: 'warning', needsInterviews: 'warning', inconclusive: 'neutral' } as const

/**
 * 6 市場実験と学習（Experiment＋Learning）。
 * 実験は事前に合格条件と中止条件を決める。実測の数（ファネル8段階・Who の100社実験）からボトルネックと CAC を出し、
 * 比較の仕方（A/B・段階的展開）が無ければ「効果があった」とは言わない。学びは経路ごとの率と、事前の点数・証拠との関係で次の採点に戻す
 */
export function ExperimentSection({ c, data, onSnapshot }: { c: Candidate; data: ResearchData; onSnapshot: (s: ResearchSnapshot) => void }) {
  const t = useT()
  const mine = useMemo(() => data.experiments.filter((x) => x.candidate === c.id).sort((a, b) => a.id.localeCompare(b.id)), [data.experiments, c.id])
  const [openId, setOpenId] = useState<string | null>(null)
  const [draftNew, setDraftNew] = useState<ResearchExperiment | null>(null)
  const open = draftNew && draftNew.id === openId ? draftNew : mine.find((x) => x.id === openId) ?? null
  const spend = experimentCac(mine)
  const create = () => {
    const id = nextResearchId('experiment', data.experiments.map((x) => x.id))
    const x = { ...emptyExperiment(id), candidate: c.id }
    setDraftNew(x)
    setOpenId(id)
  }
  return (
    <>
      <Block
        title={t('research.exp.list')}
        note={t('research.exp.listNote')}
        actions={<Button icon={<Plus size={13} />} onClick={create} data-testid="research-exp-new">{t('research.exp.new')}</Button>}
        testId="research-exp-list"
      >
        {mine.length === 0 && !draftNew ? (
          <EmptyState size="sm" title={t('research.exp.empty')} description={t('research.exp.emptyHint')} />
        ) : (
          <table className="biz-table rs-list-table">
            <thead><tr><th>ID</th><th>{t('research.exp.method')}</th><th>{t('research.exp.channel')}</th><th>{t('research.exp.status')}</th><th className="biz-col-grow">{t('research.exp.hypothesis')}</th><th>{t('research.exp.contracts')}</th><th>CAC</th><th>{t('research.exp.verdict')}</th></tr></thead>
            <tbody>
              {mine.map((x) => {
                const v = improvementVerdict(x)
                const cac = experimentCac([x]).cac
                return (
                  <tr key={x.id} className={`biz-tr-link${x.id === openId ? ' is-selected' : ''}`} onClick={() => setOpenId(x.id)} data-testid={`research-exp-row-${x.id}`}>
                    <td><button type="button" className="biz-link biz-mono" onClick={(e) => { e.stopPropagation(); setOpenId(x.id) }}>{x.id}</button></td>
                    <td>{t(`research.enum.method.${x.method}` as const)}</td>
                    <td>{x.channel ? t(`research.enum.channel.${x.channel}` as const) : '—'}</td>
                    <td><Badge tone={x.status === 'done' ? 'success' : x.status === 'running' ? 'brand' : x.status === 'stopped' ? 'danger' : 'neutral'}>{t(`research.enum.expStatus.${x.status}` as const)}</Badge></td>
                    <td className="biz-col-grow"><span className="biz-ellipsis" title={x.hypothesis}>{x.hypothesis || '—'}</span></td>
                    <td className="biz-num-text">{x.metrics.contracts ?? '—'}</td>
                    <td className="biz-num-text">{formatYen(cac)}</td>
                    <td><Badge tone={VERDICT_TONE[v]}>{t(`research.enum.verdict.${v}` as const)}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <dl className="rs-kv">
          <div><dt>{t('research.exp.totalSpend')}</dt><dd className="biz-num-text">{formatYen(spend.spend)}</dd></div>
          <div><dt>{t('research.exp.totalCustomers')}</dt><dd className="biz-num-text">{spend.customers ?? '—'}</dd></div>
          <div><dt>{t('research.exp.measuredCac')}</dt><dd className="biz-num-text">{formatYen(spend.cac)}</dd></div>
        </dl>
      </Block>
      {open && (
        <ExperimentEditor
          key={open.id}
          initial={open}
          isNew={draftNew?.id === open.id && !mine.some((x) => x.id === open.id)}
          onSaved={(s) => { onSnapshot(s); setDraftNew(null) }}
          onDeleted={(s) => { onSnapshot(s); setOpenId(null) }}
          onClose={() => { setOpenId(null); setDraftNew(null) }}
        />
      )}
      <LearningBlock data={data} />
    </>
  )
}

function ExperimentEditor({ initial, isNew, onSaved, onDeleted, onClose }: {
  initial: ResearchExperiment
  isNew: boolean
  onSaved: (s: ResearchSnapshot) => void
  onDeleted: (s: ResearchSnapshot) => void
  onClose: () => void
}) {
  const t = useT()
  const api = useResearchApi()
  const toast = useToast()
  const [draft, setDraft] = useState(initial)
  const [base, setBase] = useState(initial)
  const [issues, setIssues] = useState<ResearchIssue[]>([])
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 保存済みの記録が外で変わったら（Agent が書いた）、直していなければ合わせる
  useEffect(() => {
    if (sameJson(draft, base) && !sameJson(initial, base)) { setDraft(initial); setBase(initial) }
    // biome-ignore lint/correctness/useExhaustiveDependencies: initial が変わったときだけ
  }, [initial])
  const dirty = isNew || !sameJson(draft, base)
  const set = (patch: Partial<ResearchExperiment>) => setDraft((d) => ({ ...d, ...patch }))
  const setMetric = (k: MetricKey, v: number | null) => setDraft((d) => ({ ...d, metrics: { ...d.metrics, [k]: v } }))
  const periodIssue = (draft.period.start && !isIsoDate(draft.period.start)) || (draft.period.end && !isIsoDate(draft.period.end))
    ? 'dateForm'
    : draft.period.start && draft.period.end && draft.period.end < draft.period.start ? 'periodOrder' : null

  const save = async () => {
    setBusy('save')
    try {
      const res = await api.invoke('research:saveRecord', 'experiment', draft, null)
      setIssues(res.issues)
      if (res.ok) {
        setBase(draft)
        onSaved(res.snapshot)
        toast({ tone: res.issues.length ? 'warning' : 'success', message: res.issues.length ? t('research.ws.savedWithWarnings') : t('research.ws.saved') })
      } else toast({ tone: 'danger', message: t('research.ws.notSavedIssues') })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    setBusy('delete')
    try {
      onDeleted(await api.invoke('research:deleteRecord', 'experiment', draft.id))
      toast({ tone: 'success', message: t('research.ws.deleted', { id: draft.id }) })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.deleteFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(null)
      setConfirmDelete(false)
    }
  }

  const verdict = improvementVerdict(draft)
  return (
    <Block
      title={t('research.exp.editor', { id: draft.id })}
      testId="research-exp-editor"
      actions={
        <>
          {dirty && <Badge tone="warning">{t('research.ws.unsaved')}</Badge>}
          {!isNew && (confirmDelete ? (
            <span className="biz-inline-confirm">
              <span>{t('research.ws.confirmDelete')}</span>
              <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()} data-testid="research-exp-delete-confirm">{t('research.ws.delete')}</Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('research.ws.cancel')}</Button>
            </span>
          ) : <Button variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)} data-testid="research-exp-delete">{t('research.ws.delete')}</Button>)}
          <Button variant="ghost" onClick={onClose}>{t('research.ws.close')}</Button>
          <Button variant="primary" icon={<Save size={13} />} disabled={!dirty} busy={busy === 'save'} onClick={() => void save()} data-testid="research-exp-save">{t('research.ws.save')}</Button>
        </>
      }
    >
      {issues.length > 0 && <ul className="biz-issues" data-testid="research-exp-issues">{toFieldIssues(t, issues).map((i) => <li key={`${i.field}:${i.message}`} className={`biz-issue biz-issue--${i.severity}`}>{i.field ? `${i.field}: ` : ''}{i.message}</li>)}</ul>}
      <div className="biz-form">
        <EnumSelect label={t('research.exp.principle')} value={draft.principle} options={PRINCIPLE_KEYS} labelOf={(v) => t(`research.enum.principle.${v}` as const)} onChange={(v) => v && set({ principle: v })} />
        <EnumSelect label={t('research.exp.method')} value={draft.method} options={EXPERIMENT_METHODS} labelOf={(v) => t(`research.enum.method.${v}` as const)} onChange={(v) => v && set({ method: v })} testId="research-exp-method" />
        <EnumSelect label={t('research.exp.channel')} allowNull value={draft.channel} options={CHANNELS} labelOf={(v) => t(`research.enum.channel.${v}` as const)} onChange={(v) => set({ channel: v })} />
        <EnumSelect label={t('research.exp.status')} value={draft.status} options={EXPERIMENT_STATUSES} labelOf={(v) => t(`research.enum.expStatus.${v}` as const)} onChange={(v) => v && set({ status: v })} testId="research-exp-status" />
        <Txt label={t('research.exp.hypothesis')} placeholder={t('research.exp.hypothesisPlaceholder')} value={draft.hypothesis} onChange={(v) => set({ hypothesis: v })} rows={2} testId="research-exp-hypothesis" issues={toFieldIssues(t, issues, 'hypothesis')} />
        <Txt label={t('research.exp.passCondition')} placeholder={t('research.exp.passPlaceholder')} value={draft.passCondition} onChange={(v) => set({ passCondition: v })} rows={2} testId="research-exp-pass" issues={toFieldIssues(t, issues, 'passCondition')} />
        <Txt label={t('research.exp.stopCondition')} placeholder={t('research.exp.stopPlaceholder')} value={draft.stopCondition} onChange={(v) => set({ stopCondition: v })} rows={2} testId="research-exp-stop" issues={toFieldIssues(t, issues, 'stopCondition')} />
        {(!draft.passCondition.trim() || !draft.stopCondition.trim()) && draft.status !== 'planned' && <p className="biz-issue biz-issue--warning">{t('research.exp.conditionsFirst')}</p>}
        <Txt label={t('research.exp.start')} type="date" value={draft.period.start} onChange={(v) => set({ period: { ...draft.period, start: v } })} />
        <Txt label={t('research.exp.end')} type="date" value={draft.period.end} onChange={(v) => set({ period: { ...draft.period, end: v } })} issues={periodIssue ? [{ severity: 'error', ref: '', field: '', message: t(`research.ws.draft.${periodIssue}` as const) }] : []} />
        <EnumSelect label={t('research.exp.comparison')} tip={t('research.exp.comparisonTip')} value={draft.comparison} options={COMPARISON_METHODS} labelOf={(v) => t(`research.enum.comparison.${v}` as const)} onChange={(v) => v && set({ comparison: v })} testId="research-exp-comparison" />
        <NumField label={t('research.exp.interviews')} kind="integer" value={draft.interviews} onChange={(v) => set({ interviews: v })} />
      </div>
      <h4 className="rs-subhead">{t('research.exp.metrics')}</h4>
      <p className="biz-muted rs-hint">{t('research.exp.metricsNote')}</p>
      <div className="rs-metrics" data-testid="research-exp-metrics">
        {METRIC_KEYS.map((k) => (
          <NumField key={k} label={t(`research.enum.metric.${k}` as const)} kind={k === 'spend' || k === 'revenue' ? 'yen' : 'integer'} value={draft.metrics[k]} onChange={(v) => setMetric(k, v)} testId={`research-exp-metric-${k}`} />
        ))}
      </div>
      <div className="rs-funnels">
        <FunnelView title={t('research.exp.b2bFunnel')} x={draft} keys={B2B_FUNNEL} testId="research-exp-funnel-b2b" />
        <FunnelView title={t('research.exp.whoFunnel')} x={draft} keys={WHO_FUNNEL} testId="research-exp-funnel-who" />
      </div>
      <div className="rs-verdict" data-testid="research-exp-verdict" data-verdict={verdict}>
        <Badge tone={VERDICT_TONE[verdict]}>{t(`research.enum.verdict.${verdict}` as const)}</Badge>
        <span className="biz-muted">{t(`research.enum.verdict.${verdict}.hint` as const)}</span>
      </div>
      <Txt label={t('research.exp.learning')} placeholder={t('research.exp.learningPlaceholder')} value={draft.learning} onChange={(v) => set({ learning: v })} rows={3} testId="research-exp-learning" />
    </Block>
  )
}

function FunnelView({ title, x, keys, testId }: { title: string; x: ResearchExperiment; keys: readonly MetricKey[]; testId: string }) {
  const t = useT()
  const steps = funnelSteps(x.metrics, keys)
  const widths = barWidths(keys.map((k) => x.metrics[k]))
  const neck = findBottleneck(x.metrics, keys)
  const overall = overallRate(x.metrics, keys)
  return (
    <div className="rs-xfunnel" data-testid={testId}>
      <h5 className="rs-xfunnel__title">{title} <span className="biz-muted">{t('research.exp.overall', { rate: formatPercent(overall) })}</span></h5>
      <ol className="rs-xfunnel__steps">
        {keys.map((k, i) => {
          const step = i > 0 ? steps[i - 1] : undefined
          const isNeck = neck !== null && neck.ratio < 1 && step !== undefined && neck.step.to === step.to && neck.step.from === step.from
          return (
            <li key={k} className={`rs-xfunnel__step${isNeck ? ' is-neck' : ''}`} data-metric={k}>
              <span className="rs-xfunnel__label">{t(`research.enum.metric.${k}` as const)}</span>
              <span className="rs-xfunnel__bar" aria-hidden="true"><span style={{ width: `${widths[i]}%` }} /></span>
              <span className="rs-xfunnel__value biz-num-text">{x.metrics[k] ?? '—'}</span>
              <span className="rs-xfunnel__rate biz-num-text">{step ? formatPercent(step.rate) : ''}</span>
            </li>
          )
        })}
      </ol>
      {neck && neck.ratio >= 1 ? (
        <p className="biz-issue biz-issue--ok" data-testid={`${testId}-neck`}>{t('research.exp.allAtBenchmark', { from: t(`research.enum.metric.${neck.step.from}` as const), to: t(`research.enum.metric.${neck.step.to}` as const) })}</p>
      ) : neck ? (
        <p className="biz-issue biz-issue--warning" data-testid={`${testId}-neck`}>
          {t('research.exp.bottleneck', { from: t(`research.enum.metric.${neck.step.from}` as const), to: t(`research.enum.metric.${neck.step.to}` as const), ratio: formatRatio(neck.ratio) })}
          {' '}{t(`research.enum.hint.${neck.hint}` as const)}
        </p>
      ) : <p className="biz-muted">{t('research.exp.noBottleneck')}</p>}
    </div>
  )
}

/** Learning: 経路ごとの実測の率と、事前の点数・証拠と実測の成約率の関係（次の候補の評価に使う） */
function LearningBlock({ data }: { data: ResearchData }) {
  const t = useT()
  const byChannel = channelLearning(data.experiments)
  const rows = calibration(data)
  const note = calibrationNote(rows)
  return (
    <Block title={t('research.learn.title')} note={t('research.learn.note')} testId="research-learning">
      <h4 className="rs-subhead">{t('research.learn.byChannel')}</h4>
      {byChannel.length === 0 ? <p className="biz-muted">{t('research.learn.noChannel')}</p> : (
        <table className="biz-table" data-testid="research-learning-channels">
          <thead><tr><th>{t('research.exp.channel')}</th><th>{t('research.learn.experiments')}</th><th>{t('research.learn.responseRate')}</th><th>{t('research.learn.meetingRate')}</th><th>{t('research.learn.closeRate')}</th><th>CAC</th></tr></thead>
          <tbody>
            {byChannel.map((r) => (
              <tr key={r.channel}>
                <th>{t(`research.enum.channel.${r.channel}` as const)}</th>
                <td className="biz-num-text">{r.experiments}</td>
                <td className="biz-num-text">{formatPercent(r.responseRate)}</td>
                <td className="biz-num-text">{formatPercent(r.meetingRate)}</td>
                <td className="biz-num-text">{formatPercent(r.closeRate)}</td>
                <td className="biz-num-text">{formatYen(r.cac)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="rs-subhead">{t('research.learn.calibration')}</h4>
      {rows.length === 0 ? <p className="biz-muted">{t('research.learn.noCalibration')}</p> : (
        <table className="biz-table" data-testid="research-learning-calibration">
          <thead><tr><th>{t('research.list.candidate')}</th><th>{t('research.list.score')}</th><th>{t('research.list.evidence')}</th><th>{t('research.learn.closeRate')}</th><th>CAC</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.candidateId}>
                <th className="biz-mono">{r.candidateId}</th>
                <td className="biz-num-text">{formatScore(r.score)}</td>
                <td>{t(`research.enum.evidenceLevel.${r.evidenceLevel}` as const)}</td>
                <td className="biz-num-text">{formatPercent(r.measuredCloseRate)}</td>
                <td className="biz-num-text">{formatYen(r.measuredCac)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="biz-muted rs-hint" data-testid="research-learning-note">
        {note.correlation === null ? t('research.learn.correlationNone', { n: note.n }) : t('research.learn.correlation', { n: note.n, r: note.correlation.toFixed(2) })}
      </p>
    </Block>
  )
}
