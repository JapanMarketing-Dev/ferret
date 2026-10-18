import type { ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  CHANNEL_AXES,
  CHANNELS,
  CUSTOMER_STATES,
  DEMAND_FACTORS,
  DEMAND_LEVELS,
  DIFFERENTIATORS,
  PROBLEM_TYPES,
  ROLE_KEYS,
  SEGMENT_AXES,
  STATE_CHANNELS,
  TRIGGER_KINDS,
  WHO_CONDITIONS,
  WHY_RESEARCH_ITEMS,
  type Candidate,
  type ChannelPlan,
  type PrincipleKey,
  type ResearchData,
  type ResearchSection,
  type SearchKeyword,
  type TargetCompany,
  type TriggerEvent
} from '@shared/research/model'
import { isUsableAsProof, summarizeEvidence } from '@shared/research/evidence'
import { quantify, switchingMargin } from '@shared/research/economics'
import type { PrincipleStatus } from '@shared/research/principles'
import { useT } from '../lib/i18n'
import { Badge, Button, IconButton } from '../ui'
import { Block, CheckList, EnumSelect, IdListField, NumField, ScoreSelect, TriSelect, Txt } from './fields'
import { formatCount, formatYen, removeAt, updateAt } from './view'

export type EditCandidate = (fn: (c: Candidate) => Candidate) => void

const GUIDE_PARTS = ['theory', 'research', 'judge', 'experiment', 'done'] as const

/**
 * 区分の頭の「理論 → ネット調査 → 判定方法 → 実験方法」と完了条件（knowledge.md の要約）。
 * 開いたままにしておくと長いので、最初は畳んで見出しの1行だけ出す
 */
export function SectionGuide({ section }: { section: ResearchSection }) {
  const t = useT()
  return (
    <details className="rs-guide" data-testid={`research-guide-${section}`}>
      <summary className="rs-guide__summary">
        <span className="rs-guide__lead">{t(`research.section.${section}.lead` as const)}</span>
        <span className="biz-muted rs-guide__toggle">{t('research.guide.toggle')}</span>
      </summary>
      <ol className="rs-guide__steps">
        {GUIDE_PARTS.map((part) => (
          <li key={part} className={`rs-guide__step rs-guide__step--${part}`}>
            <span className="rs-guide__label">{t(`research.guide.part.${part}` as const)}</span>
            <span className="rs-guide__text">{t(`research.guide.${section}.${part}` as const)}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/** 5原則の完了条件（リサーチと実験の2列） */
export function PrincipleChecks({ principle, status }: { principle: PrincipleKey; status: PrincipleStatus }) {
  const t = useT()
  return (
    <div className="rs-done" data-testid={`research-checks-${principle}`}>
      <div className="rs-done__col">
        <h4 className="rs-done__title">
          {t('research.ws.checks.research')}
          <Badge tone={status.researchDone ? 'success' : 'neutral'}>{status.researchDone ? t('research.ws.checks.done') : t('research.ws.checks.notYet')}</Badge>
        </h4>
        <CheckList checks={status.research} principle={principle} testId={`research-checks-${principle}-research`} />
      </div>
      <div className="rs-done__col">
        <h4 className="rs-done__title">
          {t('research.ws.checks.experiment')}
          <Badge tone={status.experimentDone ? 'success' : 'neutral'}>{status.experimentDone ? t('research.ws.checks.done') : t('research.ws.checks.notYet')}</Badge>
        </h4>
        <CheckList checks={status.experiment} principle={principle} testId={`research-checks-${principle}-experiment`} />
      </div>
    </div>
  )
}

function RowActions({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <IconButton size="sm" label={label} icon={<Trash2 size={13} />} onClick={onRemove} />
}

function AddButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return <Button variant="ghost" icon={<Plus size={13} />} onClick={onClick} data-testid={testId}>{children}</Button>
}

// ================================================================ 概要（候補そのもの）

export function OverviewForm({ c, edit }: { c: Candidate; edit: EditCandidate }) {
  const t = useT()
  return (
    <div className="biz-form" data-testid="research-overview-form">
      <Txt label={t('research.field.title')} value={c.title} onChange={(v) => edit((x) => ({ ...x, title: v }))} wide testId="research-field-title" />
      <Txt label={t('research.field.market')} value={c.market} onChange={(v) => edit((x) => ({ ...x, market: v }))} wide />
      <Txt label={t('research.field.problem')} value={c.problem} onChange={(v) => edit((x) => ({ ...x, problem: v }))} rows={2} />
      <Txt label={t('research.field.customer')} value={c.customer} onChange={(v) => edit((x) => ({ ...x, customer: v }))} wide />
      <Txt label={t('research.field.aiFit')} value={c.aiFit} onChange={(v) => edit((x) => ({ ...x, aiFit: v }))} rows={2} />
      <Txt label={t('research.field.deliverable')} tip={t('research.field.deliverableTip')} placeholder={t('research.field.deliverablePlaceholder')} value={c.deliverable} onChange={(v) => edit((x) => ({ ...x, deliverable: v }))} rows={2} testId="research-field-deliverable" />
      <div className="biz-field biz-field--wide">
        <span className="biz-field__label">{t('research.field.existingServices')}</span>
        <div className="biz-field__control">
          <table className="biz-table rs-edit-table" data-testid="research-existing-services">
            <thead><tr><th>{t('research.field.serviceName')}</th><th>URL</th><th>{t('research.field.servicePrice')}</th><th /></tr></thead>
            <tbody>
              {c.existingServices.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びで編集する（ID が無い）
                <tr key={i}>
                  <td><input className="biz-cell-input" aria-label={t('research.field.serviceName')} value={s.name} onChange={(e) => edit((x) => ({ ...x, existingServices: updateAt(x.existingServices, i, { name: e.target.value }) }))} /></td>
                  <td><input className="biz-cell-input biz-mono" aria-label="URL" value={s.url} onChange={(e) => edit((x) => ({ ...x, existingServices: updateAt(x.existingServices, i, { url: e.target.value }) }))} /></td>
                  <td><input className="biz-cell-input" aria-label={t('research.field.servicePrice')} value={s.price} onChange={(e) => edit((x) => ({ ...x, existingServices: updateAt(x.existingServices, i, { price: e.target.value }) }))} /></td>
                  <td><RowActions label={t('research.ws.removeRow')} onRemove={() => edit((x) => ({ ...x, existingServices: removeAt(x.existingServices, i) }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddButton onClick={() => edit((x) => ({ ...x, existingServices: [...x.existingServices, { name: '', url: '', price: '' }] }))} testId="research-add-service">{t('research.ws.addRow')}</AddButton>
        </div>
      </div>
    </div>
  )
}

// ================================================================ 1 Who 顧客・企業の発見

const EMPTY_COMPANY: TargetCompany = { company: '', industry: '', employees: null, situation: '', inferredProblem: '', evidenceUrl: '', buyerRole: '', reachPath: '' }
const COMPANY_TEXT_FIELDS = ['company', 'industry', 'situation', 'inferredProblem', 'evidenceUrl', 'buyerRole', 'reachPath'] as const

export function WhoForm({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const who = c.who
  const set = (patch: Partial<typeof who>) => edit((x) => ({ ...x, who: { ...x.who, ...patch } }))
  const listed = who.companies.filter((x) => x.company.trim()).length
  return (
    <>
      <Block title={t('research.who.segment')} note={t('research.who.segmentNote')} testId="research-who-segment">
        <div className="biz-form">
          {SEGMENT_AXES.map((axis) => (
            <Txt key={axis} label={t(`research.enum.segmentAxis.${axis}` as const)} tip={t(`research.enum.segmentAxis.${axis}.tip` as const)} value={who.segment[axis]} onChange={(v) => set({ segment: { ...who.segment, [axis]: v } })} wide testId={`research-who-segment-${axis}`} />
          ))}
        </div>
      </Block>
      <Block
        title={t('research.who.companies')}
        note={t('research.who.companiesNote', { listed, target: data.research.minTargetCount })}
        actions={<AddButton onClick={() => set({ companies: [...who.companies, { ...EMPTY_COMPANY }] })} testId="research-who-add-company">{t('research.ws.addRow')}</AddButton>}
        testId="research-who-companies"
      >
        {who.companies.length === 0 ? <p className="biz-muted">{t('research.who.noCompanies')}</p> : (
          <div className="rs-scroll">
            <table className="biz-table rs-edit-table rs-edit-table--wide">
              <thead>
                <tr>
                  {COMPANY_TEXT_FIELDS.slice(0, 2).map((f) => <th key={f}>{t(`research.who.company.${f}` as const)}</th>)}
                  <th>{t('research.who.company.employees')}</th>
                  {COMPANY_TEXT_FIELDS.slice(2).map((f) => <th key={f} className={f === 'situation' ? 'rs-th-fact' : f === 'inferredProblem' ? 'rs-th-inference' : undefined}>{t(`research.who.company.${f}` as const)}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {who.companies.map((co, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びで編集する
                  <tr key={i}>
                    {COMPANY_TEXT_FIELDS.slice(0, 2).map((f) => (
                      <td key={f}><input className="biz-cell-input" aria-label={t(`research.who.company.${f}` as const)} value={co[f]} onChange={(e) => set({ companies: updateAt(who.companies, i, { [f]: e.target.value }) })} /></td>
                    ))}
                    <td><NumField compact kind="integer" label={t('research.who.company.employees')} value={co.employees} onChange={(v) => set({ companies: updateAt(who.companies, i, { employees: v }) })} /></td>
                    {COMPANY_TEXT_FIELDS.slice(2).map((f) => (
                      <td key={f}><input className={`biz-cell-input${f === 'evidenceUrl' ? ' biz-mono' : ''}`} aria-label={t(`research.who.company.${f}` as const)} value={co[f]} onChange={(e) => set({ companies: updateAt(who.companies, i, { [f]: e.target.value }) })} /></td>
                    ))}
                    <td><RowActions label={t('research.ws.removeRow')} onRemove={() => set({ companies: removeAt(who.companies, i) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="biz-muted rs-hint">{t('research.who.factNote')}</p>
        <div className="biz-form">
          <NumField label={t('research.who.targetCount')} kind="integer" value={who.targetCount} onChange={(v) => set({ targetCount: v })} unit={t('research.ws.unit.companies')} testId="research-who-target-count" />
          <Txt label={t('research.who.targetListSource')} value={who.targetListSource} onChange={(v) => set({ targetListSource: v })} wide />
        </div>
      </Block>
      <Block title={t('research.who.conditions')} note={t('research.who.conditionsNote')} testId="research-who-conditions">
        <div className="biz-form">
          {WHO_CONDITIONS.map((k) => (
            <TriSelect key={k} label={t(`research.enum.whoCondition.${k}` as const)} value={who.conditions[k]} onChange={(v) => set({ conditions: { ...who.conditions, [k]: v } })} testId={`research-who-condition-${k}`} />
          ))}
        </div>
      </Block>
      <Block title={t('research.roles.title')} note={t('research.roles.note')} testId="research-roles">
        <div className="rs-scroll">
          <table className="biz-table rs-edit-table">
            <thead><tr><th>{t('research.roles.role')}</th><th>{t('research.roles.titleCol')}</th><th>{t('research.roles.authority')}</th><th>{t('research.rank.evidence')}</th></tr></thead>
            <tbody>
              {ROLE_KEYS.map((k) => {
                const r = c.roles[k]
                const setRole = (patch: Partial<typeof r>) => edit((x) => ({ ...x, roles: { ...x.roles, [k]: { ...x.roles[k], ...patch } } }))
                return (
                  <tr key={k} data-testid={`research-role-${k}`} data-confirmed={String(r.confirmedAuthority.trim() !== '')}>
                    <th title={t(`research.enum.role.${k}.tip` as const)}>{t(`research.enum.role.${k}` as const)}</th>
                    <td><input className="biz-cell-input" aria-label={t('research.roles.titleOf', { role: t(`research.enum.role.${k}` as const) })} placeholder={t('research.roles.titlePlaceholder')} value={r.title} onChange={(e) => setRole({ title: e.target.value })} /></td>
                    <td><input className="biz-cell-input" aria-label={t('research.roles.authorityOf', { role: t(`research.enum.role.${k}` as const) })} placeholder={t('research.roles.authorityPlaceholder')} value={r.confirmedAuthority} onChange={(e) => setRole({ confirmedAuthority: e.target.value })} /></td>
                    <td className="rs-score-table__ids"><IdListField label={t('research.rank.evidence')} prefix="E" value={r.evidence} known={data.evidence.map((e) => e.id)} onChange={(v) => setRole({ evidence: v })} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="biz-muted rs-hint">{t('research.roles.caution')}</p>
      </Block>
      <TriggersBlock c={c} edit={edit} testId="research-who-triggers" />
    </>
  )
}

// ================================================================ 2 What 需要・支出・不満の証拠

export function WhatForm({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const what = c.what
  const set = (patch: Partial<typeof what>) => edit((x) => ({ ...x, what: { ...x.what, ...patch } }))
  const q = quantify(what.quantification)
  const summary = summarizeEvidence(data.evidence.filter((e) => e.candidate === c.id))
  return (
    <>
      <Block title={t('research.what.jtbd')} note={t('research.what.jtbdNote')} testId="research-what-jtbd">
        <div className="biz-form">
          {(['surface', 'job', 'purpose'] as const).map((k) => (
            <Txt key={k} label={t(`research.what.jtbd.${k}` as const)} placeholder={t(`research.what.jtbd.${k}.example` as const)} value={what.jtbd[k]} onChange={(v) => set({ jtbd: { ...what.jtbd, [k]: v } })} wide />
          ))}
        </div>
      </Block>
      <Block title={t('research.what.factors')} note={t('research.what.factorsNote')} testId="research-what-factors">
        <div className="biz-form">
          {DEMAND_FACTORS.map((f) => (
            <ScoreSelect key={f} label={t(`research.enum.demandFactor.${f}` as const)} value={what.factors[f]} onChange={(v) => set({ factors: { ...what.factors, [f]: v } })} testId={`research-what-factor-${f}`} />
          ))}
          <EnumSelect label={t('research.what.problemType')} value={what.problemType} options={PROBLEM_TYPES} labelOf={(v) => t(`research.enum.problemType.${v}` as const)} onChange={(v) => v && set({ problemType: v })} />
          <EnumSelect label={t('research.what.demandLevel')} value={what.demandLevel} options={DEMAND_LEVELS} labelOf={(v) => t(`research.enum.demandLevel.${v}` as const)} onChange={(v) => v && set({ demandLevel: v })} />
        </div>
      </Block>
      <Block title={t('research.what.quantification')} note={t('research.what.quantificationNote')} testId="research-what-quant">
        <div className="biz-form">
          <NumField label={t('research.what.hoursPerMonth')} value={what.quantification.hoursPerMonth} onChange={(v) => set({ quantification: { ...what.quantification, hoursPerMonth: v } })} unit={t('research.ws.unit.hours')} />
          <NumField label={t('research.what.hourlyCost')} kind="yen" value={what.quantification.hourlyCost} onChange={(v) => set({ quantification: { ...what.quantification, hourlyCost: v } })} />
          <NumField label={t('research.what.reductionRate')} kind="rate" value={what.quantification.reductionRate} onChange={(v) => set({ quantification: { ...what.quantification, reductionRate: v } })} />
          <NumField label={t('research.what.cashSpendMonthly')} kind="yen" value={what.quantification.cashSpendMonthly} onChange={(v) => set({ quantification: { ...what.quantification, cashSpendMonthly: v } })} />
          <NumField label={t('research.what.opportunityMonthly')} kind="yen" value={what.quantification.opportunityMonthly} onChange={(v) => set({ quantification: { ...what.quantification, opportunityMonthly: v } })} />
        </div>
        <dl className="rs-kv" data-testid="research-what-quant-result">
          <div><dt>{t('research.what.monthlyTimeCost')}</dt><dd className="biz-num-text">{formatYen(q.monthlyTimeCost)}</dd></div>
          <div><dt>{t('research.what.theoreticalSaving')}</dt><dd className="biz-num-text">{formatYen(q.theoreticalSaving)}</dd></div>
          <div><dt>{t('research.what.cashSpend')}</dt><dd className="biz-num-text">{formatYen(q.cashSpend)}</dd></div>
          <div><dt>{t('research.what.opportunity')}</dt><dd className="biz-num-text">{formatYen(q.opportunity)}</dd></div>
        </dl>
        <Txt label={t('research.what.improvement')} value={what.improvement} onChange={(v) => set({ improvement: v })} rows={2} />
      </Block>
      <Block title={t('research.what.evidence')} note={t('research.what.evidenceNote')} testId="research-what-evidence">
        <dl className="rs-kv">
          <div><dt>{t('research.ev.count')}</dt><dd className="biz-num-text">{formatCount(summary.count)}</dd></div>
          <div><dt>{t('research.ev.spend')}</dt><dd className="biz-num-text">{formatCount(summary.spend)}</dd></div>
          <div><dt>{t('research.ev.complaint')}</dt><dd className="biz-num-text">{formatCount(summary.complaint)}</dd></div>
          <div><dt>{t('research.ev.independent')}</dt><dd className="biz-num-text">{formatCount(summary.independentSources)}</dd></div>
          <div><dt>{t('research.ev.level')}</dt><dd><Badge tone={summary.level === 'strong' ? 'success' : summary.level === 'none' ? 'neutral' : summary.level === 'weak' ? 'warning' : 'brand'}>{t(`research.enum.evidenceLevel.${summary.level}` as const)}</Badge></dd></div>
          <div><dt>{t('research.ev.spendAndComplaint')}</dt><dd>{summary.spendAndComplaint ? t('research.ws.yes') : t('research.ws.no')}</dd></div>
        </dl>
      </Block>
    </>
  )
}

// ================================================================ 3 Where 集客経路ときっかけ

const EMPTY_AXES = { reachability: null, intent: null, cost: null, repeatability: null, scalability: null }

export function WhereForm({ c, edit }: { c: Candidate; edit: EditCandidate }) {
  const t = useT()
  const where = c.where
  const set = (patch: Partial<typeof where>) => edit((x) => ({ ...x, where: { ...x.where, ...patch } }))
  const setChannel = (i: number, patch: Partial<ChannelPlan>) => set({ channels: updateAt(where.channels, i, patch) })
  return (
    <>
      <Block
        title={t('research.where.channels')}
        note={t('research.where.channelsNote')}
        actions={<AddButton onClick={() => set({ channels: [...where.channels, { channel: 'outreach', state: null, axes: { ...EMPTY_AXES }, note: '' }] })} testId="research-where-add-channel">{t('research.ws.addRow')}</AddButton>}
        testId="research-where-channels"
      >
        {where.channels.length === 0 ? <p className="biz-muted">{t('research.where.noChannels')}</p> : (
          <div className="rs-scroll">
            <table className="biz-table rs-edit-table">
              <thead>
                <tr>
                  <th>{t('research.where.channel')}</th>
                  <th>{t('research.where.state')}</th>
                  {CHANNEL_AXES.map((a) => <th key={a} title={t(`research.enum.channelAxis.${a}.tip` as const)}>{t(`research.enum.channelAxis.${a}` as const)}</th>)}
                  <th>{t('research.ws.note')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {where.channels.map((ch, i) => {
                  const fits = ch.state ? STATE_CHANNELS[ch.state].includes(ch.channel) : null
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びで編集する
                    <tr key={i} data-testid="research-where-channel-row">
                      <td><EnumSelect compact label={t('research.where.channel')} value={ch.channel} options={CHANNELS} labelOf={(v) => t(`research.enum.channel.${v}` as const)} onChange={(v) => v && setChannel(i, { channel: v })} /></td>
                      <td>
                        <EnumSelect compact allowNull label={t('research.where.state')} value={ch.state} options={CUSTOMER_STATES} labelOf={(v) => t(`research.enum.customerState.${v}` as const)} onChange={(v) => setChannel(i, { state: v })} />
                        {fits === false && <span className="biz-issue biz-issue--warning rs-cell-note">{t('research.where.stateMismatch', { channels: STATE_CHANNELS[ch.state!].map((x) => t(`research.enum.channel.${x}` as const)).join(', ') })}</span>}
                      </td>
                      {CHANNEL_AXES.map((a) => (
                        <td key={a}><ScoreSelect compact label={t(`research.enum.channelAxis.${a}` as const)} value={ch.axes[a]} onChange={(v) => setChannel(i, { axes: { ...ch.axes, [a]: v } })} /></td>
                      ))}
                      <td><input className="biz-cell-input" aria-label={t('research.ws.note')} value={ch.note} onChange={(e) => setChannel(i, { note: e.target.value })} /></td>
                      <td><RowActions label={t('research.ws.removeRow')} onRemove={() => set({ channels: removeAt(where.channels, i) })} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      <TriggersBlock c={c} edit={edit} testId="research-where-triggers" />
      <Block
        title={t('research.where.keywords')}
        note={t('research.where.keywordsNote')}
        actions={<AddButton onClick={() => set({ keywords: [...where.keywords, { keyword: '', volume: null, intent: 'unknown', competitors: '', ads: null, enterable: null }] })} testId="research-where-add-keyword">{t('research.ws.addRow')}</AddButton>}
        testId="research-where-keywords"
      >
        {where.keywords.length === 0 ? <p className="biz-muted">{t('research.where.noKeywords')}</p> : (
          <KeywordRows c={c} edit={edit} />
        )}
      </Block>
      <AvailabilityBlock c={c} edit={edit} />
    </>
  )
}

/** 今動く理由・購入のきっかけ（Who と Where の両方に出す。同じ記録 where.triggers） */
export function TriggersBlock({ c, edit, testId }: { c: Candidate; edit: EditCandidate; testId: string }) {
  const t = useT()
  const where = c.where
  const set = (patch: Partial<typeof where>) => edit((x) => ({ ...x, where: { ...x.where, ...patch } }))
  const setTrigger = (i: number, patch: Partial<TriggerEvent>) => set({ triggers: updateAt(where.triggers, i, patch) })
  return (
      <Block
        title={t('research.where.triggers')}
        note={t('research.where.triggersNote')}
        actions={<AddButton onClick={() => set({ triggers: [...where.triggers, { kind: 'contractRenewal', company: '', url: '', observedAt: '', note: '' }] })} testId={`${testId}-add`}>{t('research.ws.addRow')}</AddButton>}
        testId={testId}
      >
        {where.triggers.length === 0 ? <p className="biz-muted">{t('research.where.noTriggers')}</p> : (
          <div className="rs-scroll">
            <table className="biz-table rs-edit-table">
              <thead><tr><th>{t('research.where.triggerKind')}</th><th>{t('research.who.company.company')}</th><th>URL</th><th>{t('research.where.observedAt')}</th><th>{t('research.ws.note')}</th><th /></tr></thead>
              <tbody>
                {where.triggers.map((tr, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びで編集する
                  <tr key={i}>
                    <td><EnumSelect compact label={t('research.where.triggerKind')} value={tr.kind} options={TRIGGER_KINDS} labelOf={(v) => t(`research.enum.triggerKind.${v}` as const)} onChange={(v) => v && setTrigger(i, { kind: v })} /></td>
                    <td><input className="biz-cell-input" aria-label={t('research.who.company.company')} value={tr.company} onChange={(e) => setTrigger(i, { company: e.target.value })} /></td>
                    <td><input className="biz-cell-input biz-mono" aria-label="URL" value={tr.url} onChange={(e) => setTrigger(i, { url: e.target.value })} /></td>
                    <td><input className="biz-cell-input" type="date" aria-label={t('research.where.observedAt')} value={tr.observedAt} onChange={(e) => setTrigger(i, { observedAt: e.target.value })} /></td>
                    <td><input className="biz-cell-input" aria-label={t('research.ws.note')} value={tr.note} onChange={(e) => setTrigger(i, { note: e.target.value })} /></td>
                    <td><RowActions label={t('research.ws.removeRow')} onRemove={() => set({ triggers: removeAt(where.triggers, i) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
  )
}

function KeywordRows({ c, edit }: { c: Candidate; edit: EditCandidate }) {
  const t = useT()
  const where = c.where
  const set = (patch: Partial<typeof where>) => edit((x) => ({ ...x, where: { ...x.where, ...patch } }))
  const setKeyword = (i: number, patch: Partial<SearchKeyword>) => set({ keywords: updateAt(where.keywords, i, patch) })
  return (
          <div className="rs-scroll">
            <table className="biz-table rs-edit-table">
              <thead><tr><th>{t('research.where.keyword')}</th><th>{t('research.where.volume')}</th><th>{t('research.where.intent')}</th><th>{t('research.where.competitors')}</th><th>{t('research.where.ads')}</th><th>{t('research.where.enterable')}</th><th /></tr></thead>
              <tbody>
                {where.keywords.map((k, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は並びで編集する
                  <tr key={i}>
                    <td><input className="biz-cell-input" aria-label={t('research.where.keyword')} value={k.keyword} onChange={(e) => setKeyword(i, { keyword: e.target.value })} /></td>
                    <td><NumField compact kind="integer" label={t('research.where.volume')} value={k.volume} onChange={(v) => setKeyword(i, { volume: v })} /></td>
                    <td><EnumSelect compact label={t('research.where.intent')} value={k.intent} options={['info', 'purchase', 'unknown'] as const} labelOf={(v) => t(`research.enum.intent.${v}` as const)} onChange={(v) => v && setKeyword(i, { intent: v })} /></td>
                    <td><input className="biz-cell-input" aria-label={t('research.where.competitors')} value={k.competitors} onChange={(e) => setKeyword(i, { competitors: e.target.value })} /></td>
                    <td><TriCell label={t('research.where.ads')} value={k.ads} onChange={(v) => setKeyword(i, { ads: v })} /></td>
                    <td><TriCell label={t('research.where.enterable')} value={k.enterable} onChange={(v) => setKeyword(i, { enterable: v })} /></td>
                    <td><RowActions label={t('research.ws.removeRow')} onRemove={() => set({ keywords: removeAt(where.keywords, i) })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
  )
}

function AvailabilityBlock({ c, edit }: { c: Candidate; edit: EditCandidate }) {
  const t = useT()
  const where = c.where
  const set = (patch: Partial<typeof where>) => edit((x) => ({ ...x, where: { ...x.where, ...patch } }))
  return (
      <Block title={t('research.where.availability')} testId="research-where-availability">
        <div className="biz-form">
          <Txt label={t('research.where.mental')} tip={t('research.where.mentalTip')} value={where.mentalAvailability} onChange={(v) => set({ mentalAvailability: v })} rows={2} />
          <Txt label={t('research.where.physical')} tip={t('research.where.physicalTip')} value={where.physicalAvailability} onChange={(v) => set({ physicalAvailability: v })} rows={2} />
          <Txt label={t('research.where.summary')} placeholder={t('research.where.summaryPlaceholder')} value={where.summary} onChange={(v) => set({ summary: v })} rows={2} testId="research-where-summary" />
        </div>
      </Block>
  )
}

function TriCell({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  const t = useT()
  return (
    <select className="biz-select" aria-label={label} value={value === null ? '' : value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}>
      <option value="">{t('research.ws.undecided')}</option>
      <option value="yes">{t('research.ws.yes')}</option>
      <option value="no">{t('research.ws.no')}</option>
    </select>
  )
}

// ================================================================ 4 Why 競合・差別化

export function WhyForm({ c, edit, data }: { c: Candidate; edit: EditCandidate; data: ResearchData }) {
  const t = useT()
  const why = c.why
  const set = (patch: Partial<typeof why>) => edit((x) => ({ ...x, why: { ...x.why, ...patch } }))
  const sw = why.switching
  const setSw = (patch: Partial<typeof sw>) => set({ switching: { ...sw, ...patch } })
  const margin = switchingMargin(sw)
  const evidenceIds = data.evidence.map((e) => e.id)
  const proofs = why.reasonEvidence.map((id) => data.evidence.find((e) => e.id === id)).filter((e) => e !== undefined && isUsableAsProof(e)).length
  return (
    <>
      <Block title={t('research.why.switching')} note={t('research.why.switchingNote')} testId="research-why-switching">
        <div className="biz-form">
          <NumField label={t('research.why.expectedValue')} kind="yen" value={sw.expectedValue} onChange={(v) => setSw({ expectedValue: v })} />
          <NumField label={t('research.why.adoptionCost')} kind="yen" value={sw.adoptionCost} onChange={(v) => setSw({ adoptionCost: v })} />
          <NumField label={t('research.why.switchingRisk')} kind="yen" value={sw.switchingRisk} onChange={(v) => setSw({ switchingRisk: v })} />
          <NumField label={t('research.why.statusQuoValue')} kind="yen" value={sw.statusQuoValue} onChange={(v) => setSw({ statusQuoValue: v })} />
          <TriSelect label={t('research.why.coexists')} value={sw.coexists} onChange={(v) => setSw({ coexists: v })} />
        </div>
        <p className="rs-formula" data-testid="research-why-margin">
          <span className="biz-muted">{t('research.why.formula')}</span>{' '}
          <strong className="biz-num-text">{formatYen(margin.margin)}</strong>{' '}
          {margin.switches !== null && <Badge tone={margin.switches ? 'success' : 'danger'}>{margin.switches ? t('research.why.switches') : t('research.why.stays')}</Badge>}
        </p>
      </Block>
      <Block title={t('research.why.differentiators')} note={t('research.why.differentiatorsNote')} testId="research-why-diff">
        <div className="rs-diffs">
          {DIFFERENTIATORS.map((kind) => {
            const i = why.differentiators.findIndex((d) => d.kind === kind)
            const on = i >= 0
            return (
              <div key={kind} className={`rs-diff${on ? ' is-on' : ''}`}>
                <label className="rs-diff__head">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => set({ differentiators: e.target.checked ? [...why.differentiators, { kind, note: '' }] : why.differentiators.filter((d) => d.kind !== kind) })}
                    data-testid={`research-why-diff-${kind}`}
                  />
                  <span>{t(`research.enum.differentiator.${kind}` as const)}</span>
                  <span className="biz-muted rs-diff__caution">{t(`research.enum.differentiator.${kind}.caution` as const)}</span>
                </label>
                {on && <input className="biz-cell-input" aria-label={t('research.ws.note')} value={why.differentiators[i]!.note} onChange={(e) => set({ differentiators: updateAt(why.differentiators, i, { note: e.target.value }) })} />}
              </div>
            )
          })}
        </div>
      </Block>
      <Block title={t('research.why.findings')} note={t('research.why.findingsNote')} testId="research-why-findings">
        <div className="biz-form">
          {WHY_RESEARCH_ITEMS.map((k) => (
            <Txt key={k} label={t(`research.enum.whyItem.${k}` as const)} tip={t(`research.enum.whyItem.${k}.tip` as const)} value={why.findings[k]} onChange={(v) => set({ findings: { ...why.findings, [k]: v } })} rows={2} />
          ))}
        </div>
      </Block>
      <Block title={t('research.why.reason')} note={t('research.why.reasonNote')} testId="research-why-reason">
        <div className="biz-form">
          <Txt label={t('research.why.reasonField')} value={why.reason} onChange={(v) => set({ reason: v })} rows={2} testId="research-why-reason-text" />
          <IdListField label={t('research.why.reasonEvidence')} prefix="E" value={why.reasonEvidence} known={evidenceIds} onChange={(v) => set({ reasonEvidence: v })} testId="research-why-reason-evidence" />
        </div>
        <p className={`biz-issue biz-issue--${proofs > 0 ? 'ok' : 'warning'}`}>{t('research.why.proofs', { n: proofs })}</p>
      </Block>
    </>
  )
}
