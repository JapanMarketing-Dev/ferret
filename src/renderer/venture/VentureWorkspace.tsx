import { useState, type ReactNode } from 'react'
import { Briefcase, RefreshCw } from 'lucide-react'
import type { Project } from '@shared/types'
import type { PeriodPreset } from '@shared/venture/model'
import { useLocale, useT } from '../lib/i18n'
import { Badge, Button, CountBadge, IconButton, Segmented, Spinner } from '../ui'
import { DataTab } from './DataTab'
import { GuardrailsTab } from './GuardrailsTab'
import { MembersTab } from './MembersTab'
import { OverviewTab } from './OverviewTab'
import { StreamsTab } from './StreamsTab'
import { formatPeriodRange } from './format'
import { tk } from './parts'
import { useVenture } from './useVenture'
import { PERIOD_PRESETS, WORKSPACE_TABS, alertCounts, waitingTickets, type WorkspaceTab } from './view'

/**
 * ビジネスの画面（中央の「ダッシュボード」のタブ。docs/venture.md 7章）。
 * 上に 名前・今のフェーズ・期間の切替・注意の数、その下にタブ（概要・ガードレール・業務・データ・メンバー・オーケストラ）
 */
export function VentureWorkspace({ projects, onOpenFile, onOpenProject, orchestra }: {
  projects: readonly Project[]
  onOpenFile?: (path: string) => void
  onOpenProject: (projectId: string) => void
  /** 今までのオーケストラのダッシュボード（「オーケストラ」のタブにそのまま出す） */
  orchestra: ReactNode
}) {
  const t = useT()
  const locale = useLocale()
  const [tab, setTab] = useState<WorkspaceTab>('overview')
  const [period, setPeriod] = useState<PeriodPreset>('30d')
  const { snapshot, error, loading, reload, setSnapshot } = useVenture(period)
  const counts = alertCounts(snapshot?.summary.alerts)
  const waitingApprovals = snapshot?.approvals.filter((a) => a.status === 'pending' || a.status === 'changed').length ?? 0
  const waitingReplies = waitingTickets(snapshot?.streams.support).length

  const tabBadge = (id: WorkspaceTab): number => (id === 'guardrails' ? waitingApprovals : id === 'streams' ? waitingReplies : id === 'data' ? (snapshot?.data.issueCount ?? 0) : 0)

  let body: ReactNode
  if (tab === 'orchestra') body = orchestra
  else if (!snapshot) {
    body = error
      ? <div className="vt-state" role="alert" data-testid="venture-load-error">
        <p className="vt-issue vt-issue--danger">{t('venture.load.failedLong', { reason: error })}</p>
        <Button icon={<RefreshCw size={13} />} onClick={reload}>{t('venture.load.retry')}</Button>
      </div>
      : <div className="vt-state" role="status"><Spinner size={16} /><span className="vt-muted">{t('venture.load.loading')}</span></div>
  } else if (tab === 'overview') body = <OverviewTab snapshot={snapshot} onSnapshot={setSnapshot} />
  else if (tab === 'guardrails') body = <GuardrailsTab snapshot={snapshot} onSnapshot={setSnapshot} />
  else if (tab === 'streams') body = <StreamsTab snapshot={snapshot} onOpenFile={onOpenFile} onOpenProject={onOpenProject} />
  else if (tab === 'data') body = <DataTab snapshot={snapshot} onSnapshot={setSnapshot} onOpenFile={onOpenFile} />
  else body = <MembersTab snapshot={snapshot} projects={projects} onSnapshot={setSnapshot} onOpenProject={onOpenProject} />

  const current = snapshot?.summary.phase.current
  return <div className="vt" data-testid="venture-workspace">
    <header className="vt__head">
      <div className="vt__title-row">
        <Briefcase size={16} aria-hidden="true" />
        <h2 className="vt__title" title={snapshot?.root}>{snapshot?.config.name ?? t('venture.title')}</h2>
        {current && <Badge tone="brand">{t('venture.head.phase', { stage: t(tk(`venture.stage.${current}`)) })}</Badge>}
        {counts.danger > 0 && <Badge tone="danger">{t('venture.head.danger', { count: counts.danger })}</Badge>}
        {counts.warning > 0 && <Badge tone="warning">{t('venture.head.warning', { count: counts.warning })}</Badge>}
        <span className="vt-spacer" />
        <Segmented<PeriodPreset>
          ariaLabel={t('venture.head.period')}
          value={period}
          onChange={setPeriod}
          options={PERIOD_PRESETS.map((p) => ({ value: p, label: t(tk(`venture.period.${p}`)), testId: `venture-period-${p}` }))}
        />
        <IconButton label={t('common.reload')} icon={loading ? <Spinner size={14} /> : <RefreshCw size={14} />} disabled={loading} onClick={reload} data-testid="venture-reload" />
      </div>
      {snapshot && <p className="vt-muted vt-small">{t('venture.head.periodRange', { range: formatPeriodRange(snapshot.summary.period) })}{snapshot.config.currency && ` · ${snapshot.config.currency}`}</p>}
      {snapshot && error && <p className="vt-issue vt-issue--warning" role="alert" data-testid="venture-stale">{t('venture.load.stale', { reason: error })}</p>}
      {snapshot && snapshot.recordIssues.length > 0 && <p className="vt-issue vt-issue--warning">{t('venture.head.recordIssues', { count: snapshot.recordIssues.length })}</p>}
      <nav className="vt-tabs" role="tablist" aria-label={t('venture.title')}>
        {WORKSPACE_TABS.map((id) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`vt-tabs__tab${tab === id ? ' is-selected' : ''}`} onClick={() => setTab(id)} data-testid={`venture-tab-${id}`}>
          {t(tk(`venture.tab.${id}`))}
          <CountBadge count={tabBadge(id)} tone={id === 'data' ? 'warning' : 'brand'} />
        </button>)}
      </nav>
    </header>
    <div className={`vt__body${tab === 'orchestra' ? ' vt__body--orchestra' : ''}`} role="tabpanel" lang={locale}>
      {body}
    </div>
  </div>
}
