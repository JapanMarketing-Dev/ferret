import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, MemoryStick, RotateCw, SquareTerminal, Trash2, X } from 'lucide-react'
import { resourcePollMs } from '../lib/idlePolling'
import {
  formatCpu,
  formatMemory,
  type ResourceKillTarget,
  type ResourceProject,
  type ResourceSnapshot
} from '@shared/resources'
import { Button } from '../ui'
import { StatusPopover } from './StatusPopover'
import { firstSnapshotDelay } from '../lib/resourceSnapshot'
import { useT } from '../lib/i18n'

/**
 * フッター右の Resource Manager（「メモリ · >_ ターミナル数」と、そのポップオーバー）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx,
 *           resource-usage-status-trigger.tsx, resource-usage-popover-summary.tsx,
 *           resource-usage-metrics.tsx（MIT）。
 * 見出し（再読み込み・片付け）→ 合計（CPU · Σ RSS）→ Name / CPU / RSS の表、という並びと
 * スパークラインの描き方を移植した。worktree の代わりにプロジェクトで節を切り、
 * 「Space（ディスク使用量）」と「Clean up workspaces」は持ち込んでいない。
 */

/**
 * 開いている間は細かく、閉じている間はフッターの数字を保つだけの軽い間隔で取る。
 * フッターの数字も見えていない（「…」に隠れている）間は取らない（取るたびに ps / PowerShell を起動する）
 */


function useResourceSnapshot(open: boolean, numberVisible: boolean): { snapshot: ResourceSnapshot | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const refresh = useCallback(() => {
    // 最小化・裏のあいだは取らない（Windows は取るたびに PowerShell を起動する）
    if (document.hidden) return
    void window.ade.invoke('resources:snapshot').then(setSnapshot).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
  }, [])
  const pollMs = resourcePollMs(open, numberVisible)
  useEffect(() => {
    if (pollMs === null) return
    // 開いたときはすぐ取る。閉じたまま（フッターの数字だけ）なら、起動の直後は少し待ってから
    const first = window.setTimeout(refresh, open ? 0 : firstSnapshotDelay(performance.now()))
    const timer = window.setInterval(refresh, pollMs)
    // 表に戻ったらすぐ取り直す
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [open, pollMs, refresh])
  return { snapshot, refresh }
}

// Orca由来: resource-usage-metrics.tsx の SparklineImpl（MIT）。0 からの高さで描くよう、最小値は 0 に固定した
const Sparkline = memo(function Sparkline({ samples, width = 44, height = 12 }: { samples: number[]; width?: number; height?: number }) {
  const points = useMemo(() => {
    if (samples.length < 2) return `0,${height - 0.5} ${width},${height - 0.5}`
    const max = Math.max(...samples, 1)
    const stepX = width / (samples.length - 1)
    return samples.map((v, i) => `${(i * stepX).toFixed(1)},${(height - 0.5 - (v / max) * (height - 1)).toFixed(1)}`).join(' ')
  }, [samples, width, height])
  return (
    <svg className="rm-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" preserveAspectRatio="none">
      <polyline points={points} fill="none" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
})

function Metrics({ cpu, memory }: { cpu: number; memory: number }) {
  return <>
    <span className="rm-col rm-col--cpu">{formatCpu(cpu)}</span>
    <span className="rm-col rm-col--rss">{formatMemory(memory)}</span>
  </>
}

interface Confirm {
  label: string
  target: ResourceKillTarget | 'cleanup'
}

export function ResourceManager({
  open,
  onToggle,
  onClose,
  onOpenTerminal,
  onOpenPage,
  fallbackAnchor = null,
  numberVisible = true
}: {
  open: boolean
  /** フッターの数字が見えているか（「…」に隠れていれば false。閉じている間は取らない） */
  numberVisible?: boolean
  onToggle: () => void
  onClose: () => void
  /** 行からそのターミナルへ移る（別のプロジェクトなら切り替えてから） */
  onOpenTerminal: (projectId: string | null, terminalId: string) => void
  /** 行から内蔵ブラウザのページへ移る */
  onOpenPage: (projectId: string | null) => void
  /** フッターの「…」に隠れているとき、ポップオーバーを開く位置（「…」ボタン） */
  fallbackAnchor?: HTMLElement | null
}) {
  const t = useT()
  const { snapshot, refresh } = useResourceSnapshot(open, numberVisible)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!open) setConfirm(null) }, [open])

  const runConfirmed = () => {
    if (!confirm) return
    setBusy(true)
    const job = confirm.target === 'cleanup'
      ? window.ade.invoke('resources:cleanup').then(() => undefined)
      : window.ade.invoke('resources:kill', confirm.target)
    void job.catch(() => undefined).finally(() => { // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      setBusy(false)
      setConfirm(null)
      // 止めたプロセスが消えるまで少しかかるので、すぐと少し後の2回取り直す
      refresh()
      window.setTimeout(refresh, 600)
    })
  }

  const memLabel = snapshot ? formatMemory(snapshot.totalMemory) : '—'
  const count = snapshot?.terminalCount ?? 0
  const orphans = snapshot?.orphanCount ?? 0

  const openRow = (fn: () => void) => { fn(); onClose() }

  const section = (project: ResourceProject) => (
    <div className="rm-section" key={project.id ?? '__other__'} data-testid="resource-section">
      <div className="rm-row rm-row--section">
        <span className="rm-name rm-name--section" title={project.name}>{project.name}</span>
        <Sparkline samples={project.cpuHistory} />
        <Metrics cpu={project.cpu} memory={project.memory} />
        <span className="rm-gutter" />
      </div>
      {project.terminals.map((term) => (
        <div className="rm-row rm-row--item" key={term.id} data-testid="resource-terminal">
          <button type="button" className="rm-open" title={t('resources.open', { name: term.title })} onClick={() => openRow(() => onOpenTerminal(project.id, term.id))}>
            <span className={`rm-dot${term.running ? ' is-running' : ''}`} aria-label={term.running ? t('resources.running') : t('resources.idle')} />
            <SquareTerminal size={12} aria-hidden="true" />
            <span className="rm-name" title={term.title}>{term.title}</span>
            {term.top && <span className="rm-sub" title={t('resources.topProcessHint', { name: term.top.name, cpu: formatCpu(term.top.cpu) })}>{term.top.name} {formatCpu(term.top.cpu)}</span>}
            {term.orphan && <span className="rm-badge" title={t('resources.orphanHint')}>{t('resources.orphan')}</span>}
          </button>
          <Metrics cpu={term.cpu} memory={term.memory} />
          <button type="button" className="rm-kill" aria-label={t('resources.stopNamed', { name: term.title })} title={t('resources.stop')}
            onClick={() => setConfirm({ label: t('resources.confirmStopTerminal', { name: term.title }), target: { kind: 'terminal', id: term.id } })}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
      {project.page && (
        <div className="rm-row rm-row--item" data-testid="resource-page">
          <button type="button" className="rm-open" title={project.page.url} onClick={() => openRow(() => onOpenPage(project.id))}>
            <span className="rm-dot rm-dot--none" />
            <Globe size={12} aria-hidden="true" />
            <span className="rm-name" title={project.page.url || undefined}>{project.page.title || project.page.url || t('resources.emptyPage')}</span>
          </button>
          <Metrics cpu={project.page.cpu} memory={project.page.memory} />
          <button type="button" className="rm-kill" aria-label={t('resources.closePage')} title={t('resources.closePage')}
            onClick={() => setConfirm({ label: t('resources.confirmClosePage'), target: { kind: 'page' } })}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="statusbar__btn statusbar__resources"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t('resources.triggerLabel', { memory: memLabel, count })}
      title={t('resources.triggerTitle', { memory: memLabel, count }) + (orphans ? t('resources.triggerOrphans', { count: orphans }) : '')}
      onClick={onToggle}
      data-testid="statusbar-resources"
    >
      <MemoryStick size={12} strokeWidth={2} aria-hidden="true" />
      <span className="statusbar__num">{memLabel}</span>
      <span className="statusbar__sep" aria-hidden="true">·</span>
      <SquareTerminal size={12} strokeWidth={2} aria-hidden="true" />
      <span className="statusbar__num">{count}{orphans > 0 && <span className="statusbar__orphans">({orphans})</span>}</span>
    </button>

    {open && <StatusPopover anchor={triggerRef.current} fallback={fallbackAnchor} label="Resource Manager" onClose={onClose} className="sb-pop--wide">
      <div className="rm" data-testid="resource-manager">
        <header className="rm-head">
          <span className="rm-head__title"><MemoryStick size={12} aria-hidden="true" />Resource Manager</span>
          <span className="rm-head__actions">
            <button type="button" className="rm-icon" aria-label={t('common.reload')} title={t('common.reload')} onClick={refresh}>
              <RotateCw size={12} aria-hidden="true" />
            </button>
            <button type="button" className="rm-icon rm-icon--danger" aria-label={t('resources.cleanup')}
              title={orphans ? t('resources.cleanupTitle', { count: orphans }) : t('resources.nothingToClean')} disabled={orphans === 0}
              onClick={() => setConfirm({ label: t('resources.confirmCleanup', { count: orphans }), target: 'cleanup' })}
              data-testid="resource-cleanup">
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </span>
        </header>

        {snapshot && <div className="rm-summary">
          <span className="rm-summary__value" title={t('resources.totalCpuHint')}>{formatCpu(snapshot.totalCpu)}</span>
          <span className="rm-summary__dot">·</span>
          <span className="rm-summary__value" title={t('resources.totalMemoryHint')}>{formatMemory(snapshot.totalMemory)} <span className="rm-summary__unit">Σ RSS</span></span>
          {orphans > 0 && <span className="rm-summary__warn">{t('resources.orphanCount', { count: orphans })}</span>}
        </div>}

        <div className="rm-table">
          <div className="rm-row rm-row--head">
            <span className="rm-name">Name</span>
            <span className="rm-col rm-col--cpu" title={snapshot ? t('resources.cpuColumnHint', { cores: snapshot.cores, max: `${snapshot.cores * 100}%` }) : undefined}>CPU</span>
            <span className="rm-col rm-col--rss">RSS</span>
            <span className="rm-gutter" />
          </div>
          {!snapshot && <p className="rm-empty">{t('resources.collecting')}</p>}
          {snapshot && <>
            <div className="rm-row rm-row--section">
              <span className="rm-name rm-name--section">{t('resources.app')}</span>
              <Metrics cpu={snapshot.app.cpu} memory={snapshot.app.memory} />
              <span className="rm-gutter" />
            </div>
            {snapshot.projects.map(section)}
            {snapshot.projects.length === 0 && <p className="rm-empty">{t('resources.noTerminals')}</p>}
          </>}
        </div>

        {confirm && <div className="rm-confirm" role="alertdialog" aria-label={t('resources.confirm')}>
          <p>{confirm.label}</p>
          <div className="rm-confirm__actions">
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('common.cancelShort')}</Button>
            <Button variant="danger" busy={busy} onClick={runConfirmed} data-testid="resource-confirm">{t('resources.stop')}</Button>
          </div>
        </div>}
      </div>
    </StatusPopover>}
  </>
}
