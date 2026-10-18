import { useState, type ReactNode } from 'react'
import { ClipboardCheck, ExternalLink, FileText, Film, Headphones, Image, Megaphone, PenLine, Smile } from 'lucide-react'
import type { Stream } from '@shared/venture/model'
import { promptsForStream } from '@shared/venture/prompts'
import type { VentureSnapshot } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useLocale, useT } from '../lib/i18n'
import { Badge, Button, CountBadge, useToast } from '../ui'
import { AgentRequest } from './AgentRequest'
import { DASH, formatCount, formatDateTime, formatMoney } from './format'
import { Card, Stat, TableScroll, channelLabel, tk } from './parts'
import { STREAM_ORDER, WAITING_TICKET_STATUSES, sortTickets, streamRecordCount, videoMembers, waitingTickets } from './view'

const STREAM_ICONS: Record<Stream, ReactNode> = {
  ads: <Megaphone size={14} />,
  content: <PenLine size={14} />,
  image: <Image size={14} />,
  video: <Film size={14} />,
  support: <Headphones size={14} />,
  satisfaction: <Smile size={14} />,
  checks: <ClipboardCheck size={14} />
}

const PROMPTS_BY_STREAM: Record<Stream, string[]> = Object.fromEntries(STREAM_ORDER.map((s) => [s, promptsForStream(s).map((p) => p.id)])) as Record<Stream, string[]>

export function StreamsTab({ snapshot, onOpenFile, onOpenProject }: {
  snapshot: VentureSnapshot
  onOpenFile?: (path: string) => void
  onOpenProject: (projectId: string) => void
}) {
  const t = useT()
  const [stream, setStream] = useState<Stream>('ads')
  const waiting = waitingTickets(snapshot.streams.support).length
  return <div className="vt-streams" data-testid="venture-streams">
    <nav className="vt-streams__nav" aria-label={t('venture.tab.streams')}>
      {STREAM_ORDER.map((s) => {
        const count = streamRecordCount(s, snapshot.streams)
        return <button key={s} type="button" className={`vt-streams__item${s === stream ? ' is-selected' : ''}`} aria-pressed={s === stream} onClick={() => setStream(s)} data-testid={`venture-stream-${s}`}>
          <span aria-hidden="true">{STREAM_ICONS[s]}</span>
          <span className="vt-streams__name">{t(tk(`venture.stream.${s}`))}</span>
          {s === 'support' && waiting > 0 ? <CountBadge count={waiting} tone="warning" /> : count !== null && count > 0 ? <span className="vt-muted vt-small">{count}</span> : null}
        </button>
      })}
    </nav>
    <div className="vt-streams__main vt-stack">
      <StreamBody stream={stream} snapshot={snapshot} onOpenFile={onOpenFile} onOpenProject={onOpenProject} />
      <AgentRequest key={stream} prompts={PROMPTS_BY_STREAM[stream]} refreshKey={snapshot} testId={`venture-agent-${stream}`} />
    </div>
  </div>
}

function FileLink({ path, onOpenFile }: { path?: string; onOpenFile?: (path: string) => void }) {
  if (!path) return <>{DASH}</>
  if (!onOpenFile) return <span className="vt-mono vt-small">{path}</span>
  return <button type="button" className="st-link vt-mono vt-small" title={path} onClick={() => onOpenFile(path)}><FileText size={11} aria-hidden="true" />{path.split('/').pop()}</button>
}

function UrlLink({ url }: { url?: string }) {
  const toast = useToast()
  if (!url) return <>{DASH}</>
  return <button type="button" className="st-link" title={url} onClick={() => void window.ade.invoke('app:openExternal', url).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))}><ExternalLink size={11} aria-hidden="true" /></button>
}

function StreamBody({ stream, snapshot, onOpenFile, onOpenProject }: { stream: Stream; snapshot: VentureSnapshot; onOpenFile?: (path: string) => void; onOpenProject: (projectId: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const currency = snapshot.config.currency
  const s = snapshot.streams
  const title = t(tk(`venture.stream.${stream}`))
  const status = (group: string, value: string) => t(tk(`venture.${group}.${value}`))
  const empty = <p className="vt-muted">{t('venture.streams.empty')}</p>

  if (stream === 'ads') return <Card title={title} testId="venture-records-ads">
    {s.ads.length === 0 ? empty : <TableScroll>
      <thead><tr><th>ID</th><th>{t('venture.col.channel')}</th><th>{t('venture.col.name')}</th><th>{t('venture.col.status')}</th><th className="vt-num">{t('venture.col.dailyBudget')}</th><th>{t('venture.col.landing')}</th><th>{t('venture.col.approval')}</th><th>{t('venture.col.note')}</th></tr></thead>
      <tbody>{s.ads.map((a) => <tr key={a.id}>
        <td className="vt-mono">{a.id}</td><td>{channelLabel(t, a.channel)}</td><td>{a.name}</td>
        <td><Badge tone={a.status === 'awaitingApproval' ? 'warning' : a.status === 'running' ? 'success' : 'neutral'}>{status('adStatus', a.status)}</Badge></td>
        <td className="vt-num">{formatMoney(a.dailyBudget ?? null, currency, locale)}</td>
        <td><UrlLink url={a.landingUrl} /></td><td className="vt-mono">{a.approvalId ?? DASH}</td><td>{a.note ?? ''}</td>
      </tr>)}</tbody>
    </TableScroll>}
  </Card>

  if (stream === 'content') return <Card title={title} testId="venture-records-content">
    <p className="vt-issue vt-issue--info">{t('venture.streams.contentNote')}</p>
    {s.content.length === 0 ? empty : <TableScroll>
      <thead><tr><th>ID</th><th>{t('venture.col.channel')}</th><th>{t('venture.col.title')}</th><th>{t('venture.col.status')}</th><th>{t('venture.col.due')}</th><th>{t('venture.col.draft')}</th><th>URL</th><th>{t('venture.col.approval')}</th></tr></thead>
      <tbody>{s.content.map((c) => <tr key={c.id}>
        <td className="vt-mono">{c.id}</td><td>{t(tk(`venture.contentChannel.${c.channel}`))}</td><td>{c.title}</td>
        <td><Badge tone={c.status === 'review' ? 'warning' : c.status === 'posted' || c.status === 'approved' ? 'success' : 'neutral'}>{status('contentStatus', c.status)}</Badge></td>
        <td className="vt-nowrap">{c.due ?? DASH}</td><td><FileLink path={c.file} onOpenFile={onOpenFile} /></td><td><UrlLink url={c.url} /></td><td className="vt-mono">{c.approvalId ?? DASH}</td>
      </tr>)}</tbody>
    </TableScroll>}
  </Card>

  if (stream === 'image') return <Card title={title} testId="venture-records-image">
    {s.images.length === 0 ? empty : <TableScroll>
      <thead><tr><th>ID</th><th>{t('venture.col.purpose')}</th><th>{t('venture.col.prompt')}</th><th>{t('venture.col.status')}</th><th>{t('venture.col.output')}</th><th>{t('venture.col.usage')}</th></tr></thead>
      <tbody>{s.images.map((r) => <tr key={r.id}>
        <td className="vt-mono">{r.id}</td><td>{r.purpose}</td><td className="vt-clamp" title={r.prompt}>{r.prompt}</td>
        <td><Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : r.status === 'generated' ? 'warning' : 'neutral'}>{status('imageStatus', r.status)}</Badge></td>
        <td><FileLink path={r.output} onOpenFile={onOpenFile} /></td><td>{r.usage ?? ''}</td>
      </tr>)}</tbody>
    </TableScroll>}
  </Card>

  if (stream === 'video') {
    const members = videoMembers(snapshot.members)
    return <Card title={title} testId="venture-records-video">
      <div className="vt-stats">
        <Stat label={t('venture.streams.videoCount')} value={formatCount(snapshot.videoCount, locale)} testId="venture-video-count" />
      </div>
      {members.length === 0 ? <p className="vt-muted">{t('venture.streams.videoNoMember')}</p> : <ul className="vt-list">
        {members.map((m) => <li key={m.folder} className="vt-row">
          <span>{m.name}</span><span className="vt-muted vt-mono vt-small" title={m.folder}>{m.folder}</span>
          {m.projectId
            ? <Button icon={<Film size={13} />} onClick={() => onOpenProject(m.projectId!)} data-testid="venture-video-open">{t('venture.streams.videoOpen')}</Button>
            : <span className="vt-muted vt-small">{t('venture.members.notRegistered')}</span>}
        </li>)}
      </ul>}
      <p className="vt-muted vt-small">{t('venture.streams.videoNote')}</p>
    </Card>
  }

  if (stream === 'support') {
    const waitingCount = waitingTickets(s.support).length
    return <Card title={<>{title} {waitingCount > 0 && <Badge tone="warning">{t('venture.streams.waiting', { count: waitingCount })}</Badge>}</>} testId="venture-records-support">
      {s.support.length === 0 ? empty : <TableScroll>
        <thead><tr><th>ID</th><th>{t('venture.col.received')}</th><th>{t('venture.col.channel')}</th><th>{t('venture.col.customer')}</th><th>{t('venture.col.subject')}</th><th>{t('venture.col.kind')}</th><th>{t('venture.col.status')}</th><th>{t('venture.col.draft')}</th><th>{t('venture.col.approval')}</th></tr></thead>
        <tbody>{sortTickets(s.support).map((ticket) => {
          const isWaiting = WAITING_TICKET_STATUSES.has(ticket.status)
          return <tr key={ticket.id} className={isWaiting ? 'vt-tr--warning' : ''}>
            <td className="vt-mono">{ticket.id}</td><td className="vt-nowrap">{formatDateTime(ticket.receivedAt, locale)}</td><td>{ticket.channel}</td><td>{ticket.customer}</td>
            <td><span>{ticket.subject}</span><br /><span className="vt-muted vt-small">{ticket.summary}</span></td>
            <td>{status('ticketKind', ticket.kind)}</td>
            <td><Badge tone={isWaiting ? 'warning' : 'neutral'}>{status('ticketStatus', ticket.status)}</Badge></td>
            <td><FileLink path={ticket.draft} onOpenFile={onOpenFile} /></td><td className="vt-mono">{ticket.approvalId ?? DASH}</td>
          </tr>
        })}</tbody>
      </TableScroll>}
    </Card>
  }

  if (stream === 'satisfaction') {
    const sum = snapshot.summary.satisfaction
    return <Card title={title} testId="venture-records-satisfaction">
      <div className="vt-stats">
        <Stat label="NPS" value={sum.nps === null ? DASH : formatCount(Math.round(sum.nps), locale)} hint={t('venture.sat.npsHint', { promoters: sum.promoters, passives: sum.passives, detractors: sum.detractors })} testId="venture-sat-nps" />
        <Stat label="CSAT" value={sum.csat === null ? DASH : formatCount(Math.round(sum.csat * 10) / 10, locale)} hint={t('venture.sat.csatHint')} testId="venture-sat-csat" />
        <Stat label={t('venture.sat.responses')} value={formatCount(sum.responses, locale)} hint={t('venture.sat.interviews', { count: sum.interviews })} testId="venture-sat-responses" />
      </div>
      {sum.topTags.length > 0 && <p className="vt-row">{sum.topTags.map((x) => <Badge key={x.tag}>{x.tag} · {x.count}</Badge>)}</p>}
      {s.satisfaction.length === 0 ? empty : <TableScroll>
        <thead><tr><th>ID</th><th>{t('venture.col.date')}</th><th>{t('venture.col.method')}</th><th className="vt-num">{t('venture.col.score')}</th><th>{t('venture.col.comment')}</th><th>{t('venture.col.segment')}</th><th>{t('venture.col.tags')}</th></tr></thead>
        <tbody>{s.satisfaction.map((r) => <tr key={r.id}>
          <td className="vt-mono">{r.id}</td><td className="vt-nowrap">{r.date}</td><td>{status('satMethod', r.method)}</td>
          <td className="vt-num">{formatCount(r.score ?? null, locale)}</td><td>{r.comment ?? ''}</td><td>{r.segment ?? ''}</td><td>{(r.tags ?? []).join(', ')}</td>
        </tr>)}</tbody>
      </TableScroll>}
    </Card>
  }

  return <Card title={title} testId="venture-records-checks">
    {s.checks.length === 0 ? empty : <TableScroll>
      <thead><tr><th>ID</th><th>{t('venture.col.target')}</th><th>{t('venture.col.checkId')}</th><th>{t('venture.col.result')}</th><th>{t('venture.col.note')}</th><th>{t('venture.col.checkedAt')}</th></tr></thead>
      <tbody>{[...s.checks].sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : -1)).map((c) => <tr key={c.id} className={c.result === 'fail' ? 'vt-tr--danger' : ''}>
        <td className="vt-mono">{c.id}</td><td className="vt-mono vt-small">{c.target}</td><td className="vt-mono">{c.checkId}</td>
        <td><Badge tone={c.result === 'pass' ? 'success' : c.result === 'fail' ? 'danger' : 'neutral'}>{status('checkResult', c.result)}</Badge></td>
        <td>{c.note ?? ''}</td><td className="vt-nowrap">{formatDateTime(c.checkedAt, locale)}</td>
      </tr>)}</tbody>
    </TableScroll>}
  </Card>
}
