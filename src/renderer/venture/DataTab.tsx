import { useState } from 'react'
import { FileText, Upload } from 'lucide-react'
import { SOURCE_KINDS, type SourceKind } from '@shared/venture/model'
import type { VentureSnapshot } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useLocale, useT } from '../lib/i18n'
import { Button, useToast } from '../ui'
import { AgentRequest } from './AgentRequest'
import { useVentureApi } from './api'
import { DASH, formatCount, formatPeriodRange } from './format'
import { Card, Stat, TableScroll, tk } from './parts'
import { canonicalExampleText } from './view'

const DATA_PROMPTS = ['venture.dataFetch']

export function DataTab({ snapshot, onSnapshot, onOpenFile }: { snapshot: VentureSnapshot; onSnapshot: (s: VentureSnapshot) => void; onOpenFile?: (path: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const api = useVentureApi()
  const toast = useToast()
  const [busy, setBusy] = useState<SourceKind | null>(null)
  const { data } = snapshot

  const importFile = (source: SourceKind) => {
    if (busy) return
    setBusy(source)
    api.invoke('venture:importFile', { source }).then((outcome) => {
      if (!outcome) return
      onSnapshot(outcome.snapshot)
      const issues = outcome.issues.length
      toast({
        tone: issues > 0 ? 'warning' : 'success',
        message: t('venture.data.imported', { rows: formatCount(outcome.rows, locale), path: outcome.path }),
        detail: issues > 0 ? t('venture.data.importedIssues', { count: issues }) : undefined
      })
    }).catch((err) => toast({ tone: 'warning', message: t('venture.data.importFailed'), detail: errorMessage(err) }))
      .finally(() => setBusy(null))
  }

  return <div className="vt-stack" data-testid="venture-data">
    <Card title={t('venture.data.importTitle')} testId="venture-data-import">
      <p className="vt-muted vt-small">{t('venture.data.importNote')}</p>
      <div className="vt-row vt-wrap">
        {SOURCE_KINDS.map((s) => <Button key={s} icon={<Upload size={13} />} busy={busy === s} disabled={busy !== null && busy !== s} onClick={() => importFile(s)} data-testid={`venture-import-${s}`}>{t(tk(`venture.source.${s}`))}</Button>)}
      </div>
    </Card>

    <Card title={t('venture.data.filesTitle')} testId="venture-data-files">
      <div className="vt-stats">
        <Stat label={t('venture.data.rows')} value={formatCount(data.rowCount, locale)} />
        <Stat label={t('venture.data.issues')} value={formatCount(data.issueCount, locale)} tone={data.issueCount > 0 ? 'warning' : undefined} />
        <Stat label={t('venture.data.range')} value={formatPeriodRange(data.range)} compact />
      </div>
      {data.files.length === 0 ? <p className="vt-muted">{t('venture.data.noFiles')}</p> : <TableScroll>
        <thead><tr><th>{t('venture.col.file')}</th><th>{t('venture.col.source')}</th><th className="vt-num">{t('venture.data.rows')}</th><th className="vt-num">{t('venture.data.issues')}</th></tr></thead>
        <tbody>{data.files.map((f) => <tr key={f.path} className={f.issues > 0 ? 'vt-tr--warning' : ''}>
          <td>{onOpenFile ? <button type="button" className="st-link vt-mono vt-small" title={f.path} onClick={() => onOpenFile(f.path)}><FileText size={11} aria-hidden="true" />{f.path}</button> : <span className="vt-mono vt-small">{f.path}</span>}</td>
          <td>{t(tk(`venture.source.${f.source}`))}</td>
          <td className="vt-num">{formatCount(f.rows, locale)}</td>
          <td className="vt-num">{formatCount(f.issues, locale)}</td>
        </tr>)}</tbody>
      </TableScroll>}
    </Card>

    <Card title={t('venture.data.issuesTitle')} testId="venture-data-issues">
      {data.issues.length === 0 ? <p className="vt-issue vt-issue--ok">{t('venture.data.noIssues')}</p> : <>
        {data.issueCount > data.issues.length && <p className="vt-muted vt-small">{t('venture.data.issuesTruncated', { shown: data.issues.length, total: data.issueCount })}</p>}
        <TableScroll>
          <thead><tr><th>{t('venture.col.file')}</th><th className="vt-num">{t('venture.col.line')}</th><th>{t('venture.col.issue')}</th><th>{t('venture.col.detail')}</th></tr></thead>
          <tbody>{data.issues.map((i, n) => <tr key={`${i.file}-${i.line ?? 'f'}-${i.code}-${n}`}>
            <td className="vt-mono vt-small">{i.file}</td>
            <td className="vt-num">{i.line ?? DASH}</td>
            <td>{t(tk(`venture.issue.${i.code}`))}</td>
            <td className="vt-small">{i.detail ?? ''}</td>
          </tr>)}</tbody>
        </TableScroll>
      </>}
    </Card>

    {snapshot.recordIssues.length > 0 && <Card title={t('venture.data.recordIssuesTitle')} testId="venture-record-issues">
      <ul className="vt-list">{snapshot.recordIssues.map((r, i) => <li key={`${r.file}-${i}`} className="vt-issue vt-issue--warning"><span className="vt-mono vt-small">{r.file}</span> {r.message}</li>)}</ul>
    </Card>}

    <Card title={t('venture.data.canonicalTitle')} testId="venture-data-canonical">
      <p className="vt-muted vt-small">{t('venture.data.canonicalNote')}</p>
      <pre className="vt-pre vt-mono">{canonicalExampleText()}</pre>
    </Card>

    <AgentRequest prompts={DATA_PROMPTS} refreshKey={snapshot} testId="venture-agent-data" />
  </div>
}
