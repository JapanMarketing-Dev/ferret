import { CircleCheck, CircleHelp, CircleX, OctagonAlert, TriangleAlert } from 'lucide-react'
import { FUNNEL_STAGES, VENTURE_STAGES, type GuardrailAlert, type OperationsDecision } from '@shared/venture/model'
import { promptsForStream } from '@shared/venture/prompts'
import type { VentureSnapshot } from '@shared/venture/ipc'
import { useLocale, useT } from '../lib/i18n'
import { Badge, Button } from '../ui'
import { AgentRequest } from './AgentRequest'
import { useVentureApi } from './api'
import { DASH, formatCount, formatMoney, formatMonths, formatParams, formatRate, formatRatio } from './format'
import { Card, Stat, TableScroll, channelLabel, tk, useVentureAction } from './parts'
import { funnelBarPercent, sortAlerts, stageState } from './view'

const VENTURE_PROMPTS = promptsForStream('venture').map((p) => p.id)

/** 注意の一覧（danger を赤・warning を黄で上に） */
export function AlertList({ alerts, currency, testId = 'venture-alerts' }: { alerts: readonly GuardrailAlert[]; currency: string; testId?: string }) {
  const t = useT()
  const locale = useLocale()
  const sorted = sortAlerts(alerts)
  if (sorted.length === 0) return <p className="vt-issue vt-issue--ok" data-testid={testId}>{t('venture.alert.none')}</p>
  return <ul className="vt-alerts" data-testid={testId}>
    {sorted.map((a, i) => {
      const params = formatParams(a.params, currency, locale)
      if (typeof a.params?.channel === 'string') params.channel = channelLabel(t, a.params.channel)
      return <li key={`${a.code}-${i}`} className={`vt-alert vt-alert--${a.level}`} role={a.level === 'danger' ? 'alert' : undefined} data-testid={`venture-alert-${a.code}`}>
        {a.level === 'danger' ? <OctagonAlert size={14} aria-hidden="true" /> : <TriangleAlert size={14} aria-hidden="true" />}
        <span className="vt-alert__text">{t(tk(`venture.alert.${a.code}`), params)}</span>
        {a.refs && a.refs.length > 0 && <span className="vt-alert__refs vt-mono" title={a.refs.join(', ')}>{a.refs.slice(0, 6).join(', ')}{a.refs.length > 6 ? ' …' : ''}</span>}
      </li>
    })}
  </ul>
}

export function OverviewTab({ snapshot, onSnapshot }: { snapshot: VentureSnapshot; onSnapshot: (s: VentureSnapshot) => void }) {
  const t = useT()
  const locale = useLocale()
  const { summary, config } = snapshot
  const currency = summary.kpis.currency || config.currency
  const money = (v: number | null | undefined) => formatMoney(v, currency, locale)
  const { phase, funnel, kpis } = summary
  const { busy, run } = useVentureAction(onSnapshot)
  const api = useVentureApi()
  const decideOperations = (decision: OperationsDecision) => void run(`ops-${decision}`, () => api.invoke('venture:decideOperations', { decision }))

  return <div className="vt-stack" data-testid="venture-overview">
    <Card title={t('venture.overview.alerts')} testId="venture-overview-alerts">
      <AlertList alerts={summary.alerts} currency={currency} />
    </Card>

    <Card title={t('venture.overview.phase')} testId="venture-phase">
      <ol className="vt-phase">
        {VENTURE_STAGES.map((stage) => {
          const check = phase.checks[stage]
          const state = stageState(check)
          const params = formatParams(check?.params, currency, locale)
          return <li key={stage} className={`vt-phase__step vt-phase__step--${state}${phase.current === stage ? ' is-current' : ''}`} data-testid={`venture-phase-${stage}`}>
            <span className="vt-phase__icon" aria-hidden="true">{state === 'ok' ? <CircleCheck size={16} /> : state === 'fail' ? <CircleX size={16} /> : <CircleHelp size={16} />}</span>
            <span className="vt-phase__body">
              <span className="vt-phase__name">{t(tk(`venture.stage.${stage}`))}
                <Badge tone={state === 'ok' ? 'success' : state === 'fail' ? 'danger' : 'neutral'}>{t(tk(`venture.stageState.${state}`))}</Badge>
                {phase.current === stage && <Badge tone="brand">{t('venture.phase.current')}</Badge>}
              </span>
              {check?.params && <span className="vt-muted vt-small">{t(tk(`venture.stage.${stage}.detail`), params)}</span>}
              {check?.reason && <span className="vt-muted vt-small">{t(tk(`venture.phase.reason.${check.reason}`))}</span>}
              {stage === 'operations' && <span className="vt-row">
                <Button busy={busy === 'ops-pass'} onClick={() => decideOperations('pass')} data-testid="venture-ops-pass">{t('venture.phase.opsPass')}</Button>
                <Button variant="ghost" busy={busy === 'ops-fail'} onClick={() => decideOperations('fail')} data-testid="venture-ops-fail">{t('venture.phase.opsFail')}</Button>
                {check?.ok !== null && check?.ok !== undefined && <Button variant="ghost" busy={busy === 'ops-null'} onClick={() => decideOperations(null)} data-testid="venture-ops-clear">{t('venture.phase.opsClear')}</Button>}
              </span>}
            </span>
          </li>
        })}
      </ol>
      <p className="vt-muted vt-small">{t('venture.phase.note')}</p>
    </Card>

    <Card title={t('venture.overview.funnel')} testId="venture-funnel">
      <ul className="vt-funnel">
        {funnel.steps.map((step) => {
          const stuck = funnel.bottleneck === step.stage
          return <li key={step.stage} className={`vt-funnel__row vt-funnel__row--${step.status}${stuck ? ' is-bottleneck' : ''}`} data-testid={`venture-funnel-${step.stage}`}>
            <span className="vt-funnel__label">{t(tk(`venture.funnel.${step.stage}`))}</span>
            <span className="vt-funnel__bar" aria-hidden="true"><span style={{ width: `${funnelBarPercent(step.count, funnel.steps)}%` }} /></span>
            <span className="vt-funnel__count vt-num">{formatCount(step.count, locale)}</span>
            <span className="vt-funnel__rate vt-num" title={t('venture.funnel.rateHint')}>{step.status === 'first' ? '' : formatRate(step.rate, locale)}</span>
            <span className="vt-funnel__target vt-muted vt-num">{step.target === null ? '' : t('venture.funnel.target', { rate: formatRate(step.target, locale) })}</span>
            <span className="vt-funnel__status">
              {stuck && <Badge tone="danger">{t('venture.funnel.bottleneck')}</Badge>}
              {!stuck && step.status !== 'first' && step.status !== 'ok' && <Badge tone={step.status === 'stuck' ? 'danger' : step.status === 'low' ? 'warning' : 'neutral'}>{t(tk(`venture.funnelStatus.${step.status}`))}</Badge>}
            </span>
            {step.substitute && <span className="vt-funnel__sub vt-muted vt-small">{t('venture.funnel.substitute', { metric: t(tk(`venture.metric.${step.substitute}`)) })}</span>}
          </li>
        })}
      </ul>
      {funnel.byChannel.length > 0 && <>
        <h4 className="vt-subtitle">{t('venture.funnel.byChannel')}</h4>
        <TableScroll testId="venture-funnel-channels">
          <thead><tr><th>{t('venture.col.channel')}</th>{FUNNEL_STAGES.map((s) => <th key={s} className="vt-num">{t(tk(`venture.funnel.${s}`))}</th>)}</tr></thead>
          <tbody>
            {funnel.byChannel.map((row) => <tr key={row.channel}>
              <td>{channelLabel(t, row.channel)}</td>
              {FUNNEL_STAGES.map((s) => {
                const step = row.steps.find((x) => x.stage === s)
                return <td key={s} className={`vt-num${step?.status === 'stuck' ? ' vt-text-danger' : ''}`} title={step && step.rate !== null ? formatRate(step.rate, locale) : undefined}>{formatCount(step?.count ?? null, locale)}</td>
              })}
            </tr>)}
          </tbody>
        </TableScroll>
      </>}
    </Card>

    <Card title={t('venture.overview.kpis')} testId="venture-kpis">
      <div className="vt-stats">
        <Stat label={t('venture.kpi.spend')} value={money(kpis.spend)} testId="venture-kpi-spend" />
        <Stat label={t('venture.kpi.revenue')} value={money(kpis.revenue)} testId="venture-kpi-revenue" />
        <Stat label={t('venture.kpi.newCustomers')} value={formatCount(kpis.newCustomers, locale)} testId="venture-kpi-customers" />
        <Stat label={t('venture.kpi.cac')} value={money(kpis.cac)} hint={t('venture.kpi.cacHint')} testId="venture-kpi-cac" />
        <Stat label={t('venture.kpi.arpa')} value={money(kpis.arpa)} hint={kpis.arpaSource ? t(tk(`venture.kpi.arpaSource.${kpis.arpaSource}`)) : t('venture.kpi.arpaSource.none')} testId="venture-kpi-arpa" />
        <Stat label={t('venture.kpi.margin')} value={formatRate(kpis.marginRate, locale)} hint={kpis.marginRate === null ? t('venture.kpi.marginMissing') : undefined} testId="venture-kpi-margin" />
        <Stat label={t('venture.kpi.payback')} value={formatMonths(kpis.paybackMonths, locale)} testId="venture-kpi-payback" />
      </div>
      {kpis.ltv.length > 0 && <>
        <h4 className="vt-subtitle">{t('venture.kpi.ltvTitle')}</h4>
        <TableScroll testId="venture-ltv">
          <thead><tr><th>{t('venture.kpi.ltvMonths')}</th><th className="vt-num">{t('venture.kpi.ltv')}</th><th className="vt-num">{t('venture.kpi.ltvToCac')}</th></tr></thead>
          <tbody>
            {kpis.ltv.map((row) => <tr key={row.months}>
              <td>{formatMonths(row.months, locale)}</td>
              <td className="vt-num">{money(row.value)}</td>
              <td className={`vt-num${row.ltvToCac !== null && row.ltvToCac < 1 ? ' vt-text-danger' : ''}`}>{formatRatio(row.ltvToCac, locale)}</td>
            </tr>)}
          </tbody>
        </TableScroll>
      </>}
    </Card>

    <Card title={t('venture.overview.acquisition')} testId="venture-acquisition">
      {kpis.channels.length === 0 ? <p className="vt-muted">{t('venture.overview.acquisitionEmpty')}</p> : <TableScroll>
        <thead><tr>
          <th>{t('venture.col.channel')}</th><th className="vt-num">{t('venture.kpi.spend')}</th><th className="vt-num">{t('venture.funnel.leads')}</th>
          <th className="vt-num">{t('venture.funnel.contracts')}</th><th className="vt-num">{t('venture.kpi.revenue')}</th><th className="vt-num">{t('venture.kpi.cac')}</th>
        </tr></thead>
        <tbody>
          {kpis.channels.map((c) => <tr key={c.channel}>
            <td>{channelLabel(t, c.channel)}</td>
            <td className="vt-num">{money(c.spend)}</td>
            <td className="vt-num">{formatCount(c.leads, locale)}</td>
            <td className="vt-num">{formatCount(c.contracts, locale)}</td>
            <td className="vt-num">{money(c.revenue)}</td>
            <td className="vt-num">{c.cac === null ? DASH : money(c.cac)}</td>
          </tr>)}
        </tbody>
      </TableScroll>}
    </Card>

    <AgentRequest prompts={VENTURE_PROMPTS} refreshKey={snapshot} testId="venture-agent-overall" />
  </div>
}
