import { useState } from 'react'
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react'
import { APPROVAL_KINDS, CHANNELS, type ApprovalKind, type ApprovalView, type Channel } from '@shared/venture/model'
import type { VentureSnapshot } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useLocale, useT } from '../lib/i18n'
import { Badge, Button, Field, useToast } from '../ui'
import { useVentureApi } from './api'
import { DASH, formatDateTime, formatMoney, formatRate, parseAmount } from './format'
import { Card, TableScroll, channelLabel, tk, useVentureAction } from './parts'
import { budgetBar, budgetTone, hasProposedBudgets, isFlaggedAction, latestCheckResults, needsDecision, parseRefs, sortActions, sortApprovals } from './view'

type Props = { snapshot: VentureSnapshot; onSnapshot: (s: VentureSnapshot) => void }

export function GuardrailsTab({ snapshot, onSnapshot }: Props) {
  return <div className="vt-stack" data-testid="venture-guardrails">
    <Budgets snapshot={snapshot} onSnapshot={onSnapshot} />
    <ApprovalKinds />
    <Approvals snapshot={snapshot} onSnapshot={onSnapshot} />
    <RequestApprovalForm onSnapshot={onSnapshot} />
    <ExternalLog snapshot={snapshot} />
    <Checks snapshot={snapshot} />
  </div>
}

function Budgets({ snapshot, onSnapshot }: Props) {
  const t = useT()
  const locale = useLocale()
  const api = useVentureApi()
  const { busy, run } = useVentureAction(onSnapshot)
  const currency = snapshot.summary.kpis.currency || snapshot.config.currency
  const money = (v: number | null | undefined) => formatMoney(v, currency, locale)
  const budgets = snapshot.summary.budgets
  const [channel, setChannel] = useState<Channel | '*'>('*')
  const [daily, setDaily] = useState('')
  const [monthly, setMonthly] = useState('')
  const d = parseAmount(daily)
  const m = parseAmount(monthly)
  const invalid = d === undefined || m === undefined
  const capText = (cap: { daily: number | null; monthly: number | null } | null) =>
    cap ? t('venture.budget.capValue', { daily: cap.daily === null ? DASH : money(cap.daily), monthly: cap.monthly === null ? DASH : money(cap.monthly) }) : DASH

  const setBudget = () => {
    if (invalid) return
    void run('setBudget', () => api.invoke('venture:setBudget', { channel, daily: d ?? null, monthly: m ?? null }), t('venture.budget.saved')).then((next) => {
      if (next) { setDaily(''); setMonthly('') }
    })
  }

  return <Card
    title={t('venture.budget.title')}
    testId="venture-budgets"
    actions={hasProposedBudgets(budgets) && <Button variant="primary" icon={<ShieldCheck size={13} />} busy={busy === 'approveBudgets'} onClick={() => void run('approveBudgets', () => api.invoke('venture:approveBudgets'), t('venture.budget.approved'))} data-testid="venture-budget-approve">{t('venture.budget.approve')}</Button>}
  >
    <p className="vt-muted vt-small">{t('venture.budget.note')}</p>
    {budgets.length === 0 ? <p className="vt-muted">{t('venture.budget.empty')}</p> : <TableScroll testId="venture-budget-table">
      <thead><tr>
        <th>{t('venture.col.channel')}</th><th>{t('venture.budget.cap')}</th><th>{t('venture.budget.proposed')}</th>
        <th>{t('venture.budget.month')}</th><th>{t('venture.budget.maxDay')}</th><th>{t('venture.col.status')}</th>
      </tr></thead>
      <tbody>
        {budgets.map((b) => {
          const bar = budgetBar(b)
          const tone = budgetTone(b.status)
          return <tr key={b.channel} className={`vt-tr--${tone}`} data-testid={`venture-budget-${b.channel === '*' ? 'all' : b.channel}`}>
            <td>{channelLabel(t, b.channel)}</td>
            <td>{capText(b.cap)}</td>
            <td>{b.proposed ? <Badge tone="warning">{capText(b.proposed)}</Badge> : ''}</td>
            <td className="vt-budget__month">
              <span className="vt-num">{money(b.monthSpend)}{bar.ratio !== null && ` / ${formatRate(bar.ratio, locale, 0)}`}</span>
              {bar.ratio !== null && <span className={`vt-meter vt-meter--${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.percent)} aria-label={t('venture.budget.month')}><span style={{ width: `${bar.percent}%` }} /></span>}
            </td>
            <td>{b.maxDay ? `${b.maxDay.date} ${money(b.maxDay.spend)}` : DASH}{b.overDays.length > 0 && <span className="vt-text-danger vt-small"> {t('venture.budget.overDays', { count: b.overDays.length })}</span>}</td>
            <td><Badge tone={tone === 'neutral' ? 'success' : tone}>{t(tk(`venture.budgetStatus.${b.status}`))}</Badge></td>
          </tr>
        })}
      </tbody>
    </TableScroll>}
    <h4 className="vt-subtitle">{t('venture.budget.formTitle')}</h4>
    <div className="vt-form-row">
      <label className="vt-field">
        <span>{t('venture.col.channel')}</span>
        <select className="vt-select" value={channel} onChange={(e) => setChannel(e.target.value as Channel | '*')} data-testid="venture-budget-channel">
          <option value="*">{t('venture.channel.all')}</option>
          {CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(t, c)}</option>)}
        </select>
      </label>
      <label className="vt-field">
        <span>{t('venture.budget.daily', { currency })}</span>
        <Field inputMode="decimal" value={daily} invalid={d === undefined} placeholder={t('venture.budget.noLimit')} onChange={(e) => setDaily(e.target.value)} data-testid="venture-budget-daily" />
      </label>
      <label className="vt-field">
        <span>{t('venture.budget.monthly', { currency })}</span>
        <Field inputMode="decimal" value={monthly} invalid={m === undefined} placeholder={t('venture.budget.noLimit')} onChange={(e) => setMonthly(e.target.value)} data-testid="venture-budget-monthly" />
      </label>
      <Button disabled={invalid} busy={busy === 'setBudget'} onClick={setBudget} data-testid="venture-budget-set">{t('venture.budget.set')}</Button>
    </div>
    {invalid && <p className="vt-issue vt-issue--warning">{t('venture.budget.invalid')}</p>}
    <p className="vt-muted vt-small">{t('venture.confirmInMain')}</p>
  </Card>
}

function ApprovalKinds() {
  const t = useT()
  return <Card title={t('venture.kinds.title')} testId="venture-approval-kinds">
    <p className="vt-muted vt-small">{t('venture.kinds.note')}</p>
    <ul className="vt-kinds">
      {APPROVAL_KINDS.map((k) => <li key={k}><Badge>{t(tk(`venture.approvalKind.${k}`))}</Badge><span className="vt-muted vt-small">{t(tk(`venture.approvalKind.${k}.hint`))}</span></li>)}
    </ul>
  </Card>
}

function Approvals({ snapshot, onSnapshot }: Props) {
  const t = useT()
  const sorted = sortApprovals(snapshot.approvals)
  const waiting = sorted.filter(needsDecision).length
  return <Card title={<>{t('venture.approvals.title')} {waiting > 0 && <Badge tone="warning">{t('venture.approvals.waiting', { count: waiting })}</Badge>}</>} testId="venture-approvals">
    <p className="vt-muted vt-small">{t('venture.confirmInMain')}</p>
    {sorted.length === 0 ? <p className="vt-muted">{t('venture.approvals.empty')}</p> : <ul className="vt-approvals">
      {sorted.map((a) => <ApprovalRow key={a.id} approval={a} onSnapshot={onSnapshot} />)}
    </ul>}
  </Card>
}

const APPROVAL_TONE: Record<ApprovalView['status'], 'warning' | 'danger' | 'success' | 'neutral'> = { pending: 'warning', changed: 'danger', approved: 'success', rejected: 'neutral' }

function ApprovalRow({ approval: a, onSnapshot }: { approval: ApprovalView; onSnapshot: (s: VentureSnapshot) => void }) {
  const t = useT()
  const locale = useLocale()
  const api = useVentureApi()
  const { busy, run } = useVentureAction(onSnapshot)
  const [answer, setAnswer] = useState('')
  const decide = (decision: 'approve' | 'reject') =>
    void run(decision, () => api.invoke('venture:decide', { approvalId: a.id, decision, answer: answer.trim() }), t(decision === 'approve' ? 'venture.approvals.approvedToast' : 'venture.approvals.rejectedToast', { id: a.id }))
  return <li className={`vt-approval vt-approval--${a.status}`} data-testid={`venture-approval-${a.id}`}>
    <div className="vt-approval__head">
      <span className="vt-mono">{a.id}</span>
      <Badge>{t(tk(`venture.approvalKind.${a.kind}`))}</Badge>
      <Badge tone={APPROVAL_TONE[a.status]}>{t(tk(`venture.approvalStatus.${a.status}`))}</Badge>
      <span className="vt-approval__title">{a.title}</span>
    </div>
    <details className="vt-approval__detail">
      <summary>{t('venture.approvals.detail')}</summary>
      <pre className="vt-pre">{a.detail || DASH}</pre>
    </details>
    <p className="vt-muted vt-small">
      {t('venture.approvals.meta', { at: formatDateTime(a.createdAt, locale), by: a.by ? t(tk(`venture.by.${a.by}`)) : DASH, refs: a.refs.length > 0 ? a.refs.join(', ') : DASH })}
      {a.decidedAt && ` · ${t('venture.approvals.decided', { at: formatDateTime(a.decidedAt, locale) })}`}
      {a.answer && ` · ${a.answer}`}
    </p>
    {a.status === 'changed' && <p className="vt-issue vt-issue--danger">{t('venture.approvals.changedNote')}</p>}
    {needsDecision(a) && <div className="vt-form-row">
      <Field className="vt-grow" value={answer} maxLength={500} placeholder={t('venture.approvals.answer')} aria-label={t('venture.approvals.answer')} onChange={(e) => setAnswer(e.target.value)} data-testid={`venture-approval-answer-${a.id}`} />
      <Button variant="primary" icon={<Check size={13} />} busy={busy === 'approve'} disabled={busy !== null} onClick={() => decide('approve')} data-testid={`venture-approval-approve-${a.id}`}>{t('venture.approvals.approve')}</Button>
      <Button variant="danger" icon={<X size={13} />} busy={busy === 'reject'} disabled={busy !== null} onClick={() => decide('reject')} data-testid={`venture-approval-reject-${a.id}`}>{t('venture.approvals.reject')}</Button>
    </div>}
  </li>
}

function RequestApprovalForm({ onSnapshot }: { onSnapshot: (s: VentureSnapshot) => void }) {
  const t = useT()
  const api = useVentureApi()
  const toast = useToast()
  const [kind, setKind] = useState<ApprovalKind>('budgetChange')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [refs, setRefs] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = title.trim() !== '' && detail.trim() !== ''
  const submit = () => {
    if (!ready || busy) return
    setBusy(true)
    api.invoke('venture:requestApproval', { kind, title: title.trim(), detail: detail.trim(), refs: parseRefs(refs) }).then((next) => {
      onSnapshot(next)
      setTitle(''); setDetail(''); setRefs('')
      toast({ tone: 'success', message: t('venture.request.done') })
    }).catch((err) => toast({ tone: 'warning', message: t('venture.action.failed'), detail: errorMessage(err) }))
      .finally(() => setBusy(false))
  }
  return <Card title={t('venture.request.title')} testId="venture-request-approval">
    <div className="vt-form-grid">
      <label className="vt-field">
        <span>{t('venture.request.kind')}</span>
        <select className="vt-select" value={kind} onChange={(e) => setKind(e.target.value as ApprovalKind)} data-testid="venture-request-kind">
          {APPROVAL_KINDS.map((k) => <option key={k} value={k}>{t(tk(`venture.approvalKind.${k}`))}</option>)}
        </select>
      </label>
      <label className="vt-field">
        <span>{t('venture.request.titleLabel')}</span>
        <Field value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="venture-request-title" />
      </label>
      <label className="vt-field vt-field--wide">
        <span>{t('venture.request.detail')}</span>
        <textarea className="vt-textarea" rows={4} value={detail} maxLength={20000} onChange={(e) => setDetail(e.target.value)} data-testid="venture-request-detail" />
      </label>
      <label className="vt-field vt-field--wide">
        <span>{t('venture.request.refs')}</span>
        <Field mono value={refs} placeholder="T001, AD01" onChange={(e) => setRefs(e.target.value)} data-testid="venture-request-refs" />
      </label>
    </div>
    <div className="vt-row">
      <Button disabled={!ready} busy={busy} onClick={submit} data-testid="venture-request-submit">{t('venture.request.submit')}</Button>
      <span className="vt-muted vt-small">{t('venture.request.note')}</span>
    </div>
  </Card>
}

function ExternalLog({ snapshot }: { snapshot: VentureSnapshot }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const actions = sortActions(snapshot.summary.actions)
  const openUrl = (url: string) => void window.ade.invoke('app:openExternal', url).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))
  return <Card title={t('venture.external.title')} testId="venture-external">
    {actions.length === 0 ? <p className="vt-muted">{t('venture.external.empty')}</p> : <TableScroll>
      <thead><tr>
        <th>{t('venture.external.at')}</th><th>{t('venture.request.kind')}</th><th>{t('venture.external.summary')}</th>
        <th>{t('venture.external.approval')}</th><th>{t('venture.external.result')}</th><th>{t('venture.external.via')}</th><th>{t('venture.col.status')}</th>
      </tr></thead>
      <tbody>
        {actions.map((a, i) => <tr key={`${a.at}-${i}`} className={isFlaggedAction(a) ? 'vt-tr--danger' : ''}>
          <td className="vt-nowrap">{formatDateTime(a.at, locale)}</td>
          <td>{t(tk(`venture.approvalKind.${a.kind}`))}</td>
          <td>{a.summary}{a.url && <> <button type="button" className="st-link" title={a.url} onClick={() => openUrl(a.url!)}><ExternalLink size={11} aria-hidden="true" /></button></>}</td>
          <td className="vt-mono">{a.approvalId ?? DASH}</td>
          <td>{a.result ?? DASH}</td>
          <td>{a.via ? t(tk(`venture.by.${a.via}`)) : DASH}</td>
          <td><Badge tone={isFlaggedAction(a) ? 'danger' : 'success'}>{t(tk(`venture.actionFlag.${a.flag}`))}</Badge></td>
        </tr>)}
      </tbody>
    </TableScroll>}
  </Card>
}

function Checks({ snapshot }: { snapshot: VentureSnapshot }) {
  const t = useT()
  const locale = useLocale()
  const rows = latestCheckResults(snapshot.guardrails.checks, snapshot.streams.checks)
  return <Card title={t('venture.checks.title')} testId="venture-checks">
    {rows.length === 0 ? <p className="vt-muted">{t('venture.checks.empty')}</p> : <TableScroll>
      <thead><tr><th>ID</th><th>{t('venture.checks.category')}</th><th>{t('venture.checks.text')}</th><th>{t('venture.checks.latest')}</th></tr></thead>
      <tbody>
        {rows.map(({ item, latest }) => <tr key={item.id} className={latest?.result === 'fail' ? 'vt-tr--danger' : ''}>
          <td className="vt-mono">{item.id}</td>
          <td>{t(tk(`venture.checkCategory.${item.category}`))}</td>
          <td>{item.text}</td>
          <td>{latest ? <>
            <Badge tone={latest.result === 'pass' ? 'success' : latest.result === 'fail' ? 'danger' : 'neutral'}>{t(tk(`venture.checkResult.${latest.result}`))}</Badge>
            <span className="vt-muted vt-small"> {formatDateTime(latest.checkedAt, locale)} {latest.target}</span>
            {latest.note && <span className="vt-small"> {latest.note}</span>}
          </> : <span className="vt-muted">{t('venture.checks.notYet')}</span>}</td>
        </tr>)}
      </tbody>
    </TableScroll>}
  </Card>
}
