import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Plus, Save, Trash2 } from 'lucide-react'
import {
  BEHAVIOR_LEVELS,
  EVIDENCE_GRADES,
  EVIDENCE_KINDS,
  EVIDENCE_STATES,
  GRADE_RELIABILITY,
  PRINCIPLE_KEYS,
  READING_KEYS,
  READING_LEVELS,
  nextResearchId,
  type ResearchData,
  type ResearchEvidence
} from '@shared/research/model'
import type { ResearchIssue, ResearchSnapshot } from '@shared/research/ipc'
import { emptyEvidence } from '@shared/research/records'
import { isEvaluated, isUsableAsProof, summarizeEvidence } from '@shared/research/evidence'
import type { Issue } from '@shared/business/rules'
import { errorMessage } from '../lib/errors'
import { useT, type TFunction } from '../lib/i18n'
import { Badge, Button, EmptyState, IconButton, useToast, type BadgeTone } from '../ui'
import { useResearchApi } from './api'
import { Block, EnumSelect, toFieldIssues, Txt } from './fields'
import { evidenceCompleteness, evidenceDraftIssues, evidenceForCandidate, hostOf, isHttpUrl, localDate, readingTone, sameJson, timingNotes, type DraftIssue } from './view'

const RELIABILITY_TONE: Record<string, BadgeTone> = { high: 'success', fairlyHigh: 'success', medium: 'brand', lowMedium: 'warning', low: 'neutral' }

/**
 * 証拠台帳。URL・原文・確認日・観測した事実・推論・証拠の種類（強さ8段階＋企業の事実）を1件ずつ。
 * 事実と推論は分けて書く。AI の推測（aiInference）は裏付けに数えない
 */
export function EvidenceLedger({ data, candidateId, onSnapshot, now }: { data: ResearchData; candidateId: string | null; onSnapshot: (s: ResearchSnapshot) => void; now: () => Date }) {
  const t = useT()
  const [scope, setScope] = useState<'candidate' | 'all'>(candidateId ? 'candidate' : 'all')
  useEffect(() => { if (!candidateId) setScope('all') }, [candidateId])
  const [stateFilter, setStateFilter] = useState<'all' | 'collected' | 'evaluated'>('all')
  const scoped = useMemo(() => evidenceForCandidate(data.evidence, scope === 'candidate' ? candidateId : null), [data.evidence, scope, candidateId])
  const list = stateFilter === 'all' ? scoped : scoped.filter((e) => (stateFilter === 'evaluated') === isEvaluated(e))
  const unevaluated = scoped.filter((e) => !isEvaluated(e)).length
  const summary = summarizeEvidence(list)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draftNew, setDraftNew] = useState<ResearchEvidence | null>(null)
  const open = draftNew && draftNew.id === openId ? draftNew : data.evidence.find((e) => e.id === openId) ?? null
  const create = () => {
    const d = now()
    const id = nextResearchId('evidence', data.evidence.map((e) => e.id))
    const e = { ...emptyEvidence(id, d.toISOString()), candidate: candidateId ?? '', checkedAt: localDate(d) }
    setDraftNew(e)
    setOpenId(id)
  }
  return (
    <>
      <Block
        title={t('research.ev.title')}
        note={t('research.ev.note')}
        testId="research-evidence"
        actions={
          <>
            {candidateId && (
              <select className="biz-select" aria-label={t('research.ev.scope')} value={scope} onChange={(e) => setScope(e.target.value as 'candidate' | 'all')} data-testid="research-ev-scope">
                <option value="candidate">{t('research.ev.scopeCandidate', { id: candidateId })}</option>
                <option value="all">{t('research.ev.scopeAll')}</option>
              </select>
            )}
            <select className="biz-select" aria-label={t('research.ev.stateFilter')} value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)} data-testid="research-ev-state-filter">
              <option value="all">{t('research.ev.stateAll')}</option>
              <option value="collected">{t('research.enum.evidenceState.collected')}</option>
              <option value="evaluated">{t('research.enum.evidenceState.evaluated')}</option>
            </select>
            <Button icon={<Plus size={13} />} onClick={create} data-testid="research-ev-new">{t('research.ev.new')}</Button>
          </>
        }
      >
        <dl className="rs-kv" data-testid="research-ev-summary">
          <div><dt>{t('research.ev.count')}</dt><dd className="biz-num-text">{summary.count}</dd></div>
          <div data-testid="research-ev-unevaluated"><dt>{t('research.ev.unevaluated')}</dt><dd className="biz-num-text">{unevaluated > 0 ? <Badge tone="warning">{unevaluated}</Badge> : 0}</dd></div>
          <div><dt>{t('research.ev.best')}</dt><dd>{summary.best ? <Badge tone={RELIABILITY_TONE[summary.best]}>{t(`research.enum.reliability.${summary.best}` as const)}</Badge> : '—'}</dd></div>
          <div><dt>{t('research.ev.level')}</dt><dd>{t(`research.enum.evidenceLevel.${summary.level}` as const)}</dd></div>
          <div><dt>{t('research.ev.independent')}</dt><dd className="biz-num-text">{summary.independentSources}</dd></div>
          <div><dt>{t('research.ev.spendAndComplaint')}</dt><dd>{summary.spendAndComplaint ? t('research.ws.yes') : t('research.ws.no')}</dd></div>
        </dl>
        {list.length === 0 && !draftNew ? (
          <EmptyState size="sm" title={t('research.ev.empty')} description={t('research.ev.emptyHint')} />
        ) : (
          <div className="rs-scroll">
            <table className="biz-table rs-list-table rs-ledger">
              <thead>
                <tr>
                  <th>ID</th>
                  {scope === 'all' && <th>{t('research.list.candidate')}</th>}
                  <th>{t('research.ev.state')}</th>
                  <th>{t('research.ev.reading')}</th>
                  <th>{t('research.ev.items')}</th>
                  <th>{t('research.ev.grade')}</th>
                  <th>{t('research.ev.reliability')}</th>
                  <th className="rs-th-fact">{t('research.ev.fact')}</th>
                  <th className="rs-th-inference">{t('research.ev.inference')}</th>
                  <th>{t('research.ev.source')}</th>
                  <th>{t('research.ev.checkedAt')}</th>
                  <th>{t('research.ev.proof')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => {
                  const rel = GRADE_RELIABILITY[e.grade]
                  return (
                    <tr key={e.id} className={`biz-tr-link${e.id === openId ? ' is-selected' : ''}`} onClick={() => setOpenId(e.id)} data-testid={`research-ev-row-${e.id}`}>
                      <td><button type="button" className="biz-link biz-mono" onClick={(ev) => { ev.stopPropagation(); setOpenId(e.id) }}>{e.id}</button></td>
                      {scope === 'all' && <td className="biz-mono">{e.candidate || '—'}</td>}
                      <td data-testid={`research-ev-row-${e.id}-state`} data-state={isEvaluated(e) ? 'evaluated' : 'collected'}>
                        {isEvaluated(e) ? <Badge tone="success">{t('research.enum.evidenceState.evaluated')}</Badge> : <Badge tone="warning">{t('research.ev.unevaluated')}</Badge>}
                      </td>
                      <td><ReadingDots reading={e.reading} /></td>
                      <td className="biz-num-text">{evidenceCompleteness(e).filled}/11</td>
                      <td>{t(`research.enum.grade.${e.grade}` as const)}{e.dupGroup && <span className="biz-muted rs-cell-note">{t('research.ev.dupGroupShort', { group: e.dupGroup })}</span>}</td>
                      <td>{rel ? <Badge tone={RELIABILITY_TONE[rel]}>{t(`research.enum.reliability.${rel}` as const)}</Badge> : '—'}</td>
                      <td className="rs-cell-text"><span className="rs-clamp" title={e.fact || e.quote}>{e.fact || e.quote || '—'}</span></td>
                      <td className="rs-cell-text"><span className="rs-clamp" title={e.inference}>{e.inference || '—'}</span></td>
                      <td>{hostOf(e.url) || e.source || '—'}</td>
                      <td className="biz-num-text biz-nowrap">{e.checkedAt || '—'}</td>
                      <td>{isUsableAsProof(e) ? <Badge tone="success">{t('research.ev.usable')}</Badge> : <Badge>{t('research.ev.notUsable')}</Badge>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      {open && (
        <EvidenceEditor
          key={open.id}
          initial={open}
          isNew={draftNew?.id === open.id && !data.evidence.some((e) => e.id === open.id)}
          candidates={data.candidates.map((c) => ({ id: c.id, title: c.title }))}
          today={localDate(now())}
          onSaved={(s) => { onSnapshot(s); setDraftNew(null) }}
          onDeleted={(s) => { onSnapshot(s); setOpenId(null) }}
          onClose={() => { setOpenId(null); setDraftNew(null) }}
        />
      )}
    </>
  )
}

function draftToIssues(t: TFunction, list: readonly DraftIssue[], field: DraftIssue['field']): Issue[] {
  return list.filter((i) => i.field === field).map((i) => ({ severity: i.level, ref: '', field: i.field, message: t(`research.ws.draft.${i.id}` as const) }))
}

function EvidenceEditor({ initial, isNew, candidates, today, onSaved, onDeleted, onClose }: {
  initial: ResearchEvidence
  isNew: boolean
  candidates: ReadonlyArray<{ id: string; title: string }>
  today: string
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
  useEffect(() => {
    if (sameJson(draft, base) && !sameJson(initial, base)) { setDraft(initial); setBase(initial) }
    // biome-ignore lint/correctness/useExhaustiveDependencies: initial が変わったときだけ
  }, [initial])
  const dirty = isNew || !sameJson(draft, base)
  const set = (patch: Partial<ResearchEvidence>) => setDraft((d) => ({ ...d, ...patch }))
  const local = evidenceDraftIssues(draft, today)
  const blocking = local.some((i) => i.level === 'error')
  const fieldIssues = (f: DraftIssue['field']) => [...draftToIssues(t, local, f), ...toFieldIssues(t, issues, f)]

  const save = async () => {
    setBusy('save')
    try {
      const res = await api.invoke('research:saveRecord', 'evidence', draft, null)
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
      onDeleted(await api.invoke('research:deleteRecord', 'evidence', draft.id))
      toast({ tone: 'success', message: t('research.ws.deleted', { id: draft.id }) })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.deleteFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(null)
      setConfirmDelete(false)
    }
  }
  const rel = GRADE_RELIABILITY[draft.grade]
  const completeness = evidenceCompleteness(draft)
  const timing = timingNotes(draft, today)
  return (
    <Block
      title={t('research.ev.editor', { id: draft.id })}
      testId="research-ev-editor"
      actions={
        <>
          {dirty && <Badge tone="warning">{t('research.ws.unsaved')}</Badge>}
          {!isNew && (confirmDelete ? (
            <span className="biz-inline-confirm">
              <span>{t('research.ws.confirmDelete')}</span>
              <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()} data-testid="research-ev-delete-confirm">{t('research.ws.delete')}</Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('research.ws.cancel')}</Button>
            </span>
          ) : <Button variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)} data-testid="research-ev-delete">{t('research.ws.delete')}</Button>)}
          <Button variant="ghost" onClick={onClose}>{t('research.ws.close')}</Button>
          <Button variant="primary" icon={<Save size={13} />} disabled={!dirty || blocking} busy={busy === 'save'} onClick={() => void save()} data-testid="research-ev-save">{t('research.ws.save')}</Button>
        </>
      }
    >
      {issues.filter((i) => !['url', 'quote', 'fact', 'inference', 'checkedAt', 'grade'].includes(i.field)).length > 0 && (
        <ul className="biz-issues">{toFieldIssues(t, issues.filter((i) => !['url', 'quote', 'fact', 'inference', 'checkedAt', 'grade'].includes(i.field))).map((i) => <li key={`${i.field}:${i.message}`} className={`biz-issue biz-issue--${i.severity}`}>{i.message}</li>)}</ul>
      )}
      <div className="biz-form">
        <EnumSelect label={t('research.list.candidate')} allowNull value={draft.candidate || null} options={candidates.map((c) => c.id)} labelOf={(id) => `${id} ${candidates.find((c) => c.id === id)?.title ?? ''}`} onChange={(v) => set({ candidate: v ?? '' })} testId="research-ev-candidate" />
        <EnumSelect label={t('research.ev.principle')} value={draft.principle} options={PRINCIPLE_KEYS} labelOf={(v) => t(`research.enum.principle.${v}` as const)} onChange={(v) => v && set({ principle: v })} />
        <EnumSelect label={t('research.ev.kind')} value={draft.kind} options={EVIDENCE_KINDS} labelOf={(v) => t(`research.enum.evidenceKind.${v}` as const)} onChange={(v) => v && set({ kind: v })} />
        <div className="biz-field">
          <span className="biz-field__label">{t('research.ev.grade')}</span>
          <div className="biz-field__control">
            <EnumSelect compact label={t('research.ev.grade')} value={draft.grade} options={EVIDENCE_GRADES} labelOf={(v) => t(`research.enum.grade.${v}` as const)} onChange={(v) => v && set({ grade: v })} testId="research-ev-grade" />
            <span className="rs-inline"><Badge tone={RELIABILITY_TONE[rel]}>{t(`research.enum.reliability.${rel}` as const)}</Badge> <span className="biz-muted">{t(`research.enum.grade.${draft.grade}.means` as const)}</span></span>
            {draftToIssues(t, local, 'grade').map((i) => <span key={i.message} className="biz-issue biz-issue--warning">{i.message}</span>)}
          </div>
        </div>
        <div className="biz-field biz-field--wide">
          <span className="biz-field__label">URL</span>
          <div className="biz-field__control">
            <div className="rs-url">
              <div className={`field${fieldIssues('url').some((i) => i.severity === 'error') ? ' is-invalid' : ''}`}>
                <input className="field__input field__input--mono" type="url" aria-label="URL" value={draft.url} spellCheck={false} onChange={(e) => set({ url: e.target.value })} data-testid="research-ev-url" />
              </div>
              {isHttpUrl(draft.url) && <IconButton size="sm" label={t('research.ev.openUrl')} icon={<ExternalLink size={13} />} onClick={() => void api.openExternal(draft.url.trim())} data-testid="research-ev-open-url" />}
            </div>
            {fieldIssues('url').map((i) => <span key={i.message} className={`biz-issue biz-issue--${i.severity}`}>{i.message}</span>)}
          </div>
        </div>
        <Txt label={t('research.ev.source')} placeholder={t('research.ev.sourcePlaceholder')} value={draft.source} onChange={(v) => set({ source: v })} />
        <Txt label={t('research.ev.checkedAt')} type="date" value={draft.checkedAt} onChange={(v) => set({ checkedAt: v })} issues={fieldIssues('checkedAt')} testId="research-ev-checked" />
        <Txt label={t('research.ev.quote')} tip={t('research.ev.quoteTip')} value={draft.quote} onChange={(v) => set({ quote: v })} rows={3} issues={fieldIssues('quote')} testId="research-ev-quote" />
        <Txt label={t('research.ev.fact')} tip={t('research.ev.factTip')} value={draft.fact} onChange={(v) => set({ fact: v })} rows={2} issues={fieldIssues('fact')} testId="research-ev-fact" />
      </div>
      <h4 className="rs-subhead" data-testid="research-ev-collect-head">
        {t('research.ev.collectTitle')}
        <span className="biz-muted rs-subhead__meta">{t('research.ev.itemsFilled', { n: completeness.filled, total: completeness.total })}</span>
      </h4>
      <p className="biz-muted rs-hint">{t('research.ev.collectNote')}</p>
      <div className="biz-form" data-testid="research-ev-items">
        <Txt label={t('research.ev.subject')} placeholder={t('research.ev.subjectPlaceholder')} value={draft.subject} onChange={(v) => set({ subject: v })} wide testId="research-ev-subject" />
        <Txt label={t('research.ev.problem')} value={draft.problem} onChange={(v) => set({ problem: v })} rows={2} />
        <Txt label={t('research.ev.event')} placeholder={t('research.ev.eventPlaceholder')} value={draft.event} onChange={(v) => set({ event: v })} rows={2} />
        <Txt label={t('research.ev.behavior')} value={draft.behavior} onChange={(v) => set({ behavior: v })} rows={2} testId="research-ev-behavior" />
        <EnumSelect label={t('research.ev.behaviorLevel')} tip={t('research.ev.behaviorLevelTip')} value={draft.behaviorLevel} options={BEHAVIOR_LEVELS} labelOf={(v) => t(`research.enum.behaviorLevel.${v}` as const)} onChange={(v) => v && set({ behaviorLevel: v })} testId="research-ev-behavior-level" />
        <Txt label={t('research.ev.amount')} placeholder={t('research.ev.amountPlaceholder')} value={draft.amount} onChange={(v) => set({ amount: v })} wide />
        <Txt label={t('research.ev.eventDate')} type="date" value={draft.eventDate} onChange={(v) => set({ eventDate: v })} testId="research-ev-event-date" />
        <Txt label={t('research.ev.publishedAt')} type="date" value={draft.publishedAt} onChange={(v) => set({ publishedAt: v })} issues={timing.map((n) => ({ severity: 'warning' as const, ref: '', field: '', message: t(`research.ev.timing.${n}` as const) }))} testId="research-ev-published" />
        <Txt label={t('research.ev.publisher')} placeholder={t('research.ev.publisherPlaceholder')} value={draft.publisher} onChange={(v) => set({ publisher: v })} wide />
        <Txt label={t('research.ev.inference')} tip={t('research.ev.inferenceTip')} value={draft.inference} onChange={(v) => set({ inference: v })} rows={2} issues={fieldIssues('inference')} testId="research-ev-inference" />
        <Txt label={t('research.ev.counter')} tip={t('research.ev.counterTip')} value={draft.counter} onChange={(v) => set({ counter: v })} rows={2} testId="research-ev-counter" />
        <Txt label={t('research.ev.unknowns')} tip={t('research.ev.unknownsTip')} value={draft.unknowns} onChange={(v) => set({ unknowns: v })} rows={2} />
      </div>
      <h4 className="rs-subhead" data-testid="research-ev-evaluate-head">
        {t('research.ev.evaluateTitle')}
        {isEvaluated(draft) ? <Badge tone="success">{t('research.enum.evidenceState.evaluated')}</Badge> : <Badge tone="warning">{t('research.ev.unevaluated')}</Badge>}
      </h4>
      <p className="biz-muted rs-hint">{t('research.ev.evaluateNote')}</p>
      <div className="rs-reading" data-testid="research-ev-reading">
        {READING_KEYS.map((k) => (
          <div key={k} className={`rs-reading__row rs-reading__row--${draft.reading[k] ?? 'unset'}`} data-reading={k}>
            <span className="rs-reading__name" title={t(`research.enum.reading.${k}.tip` as const)}>{t(`research.enum.reading.${k}` as const)}</span>
            <span className="biz-muted rs-reading__tip">{t(`research.enum.reading.${k}.tip` as const)}</span>
            <EnumSelect compact allowNull label={t(`research.enum.reading.${k}` as const)} value={draft.reading[k]} options={READING_LEVELS} labelOf={(v) => t(`research.enum.readingLevel.${v}` as const)} onChange={(v) => set({ reading: { ...draft.reading, [k]: v } })} testId={`research-ev-reading-${k}`} />
          </div>
        ))}
      </div>
      {(draft.reading.match === 'ng' || draft.reading.timing === 'ng') && <p className="biz-issue biz-issue--warning">{t('research.ev.readingNg')}</p>}
      <div className="biz-form">
        <EnumSelect label={t('research.ev.state')} value={draft.state} options={EVIDENCE_STATES} labelOf={(v) => t(`research.enum.evidenceState.${v}` as const)} onChange={(v) => v && set({ state: v })} testId="research-ev-state" />
        <Txt label={t('research.ev.dupGroup')} tip={t('research.ev.dupGroupTip')} placeholder={t('research.ev.dupGroupPlaceholder')} value={draft.dupGroup} onChange={(v) => set({ dupGroup: v })} mono testId="research-ev-dup" />
      </div>
    </Block>
  )
}

/** 読む5観点を小さな点で（ok 緑・weak 黄・ng 赤・未評価は空） */
function ReadingDots({ reading }: { reading: ResearchEvidence['reading'] }) {
  const t = useT()
  const tone = readingTone(reading, READING_KEYS)
  return (
    <span className="rs-dots" title={READING_KEYS.map((k) => `${t(`research.enum.reading.${k}` as const)}: ${reading?.[k] ? t(`research.enum.readingLevel.${reading[k]!}` as const) : t('research.ev.unset')}`).join(' / ')} data-tone={tone}>
      {READING_KEYS.map((k) => <span key={k} className={`rs-dot rs-dot--${reading?.[k] ?? 'unset'}`} aria-hidden="true" />)}
      <span className="biz-sr">{t(`research.ev.readingTone.${tone}` as const)}</span>
    </span>
  )
}
