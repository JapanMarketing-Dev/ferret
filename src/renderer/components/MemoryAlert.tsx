import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Globe, MemoryStick, SquareTerminal, X } from 'lucide-react'
import { memoryConsumers, type MemoryAlertNotice, type MemoryConsumer } from '@shared/memoryAlert'
import { formatMemory } from '@shared/resources'
import { Button, IconButton, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { AgentIcon } from './AgentIcon'
import { getPaneDirectory, requestSleep } from '../terminal/sleepPolicy'
import { requestOpenResources } from './StatusBar'
import { getViewBoundsForToasts, subscribeViewBoundsForToasts, toastPlacement } from '../lib/toastPlacement'
import { reportHandled } from '@shared/report'

/**
 * メモリが足りないという知らせ（main の memoryWatch.ts が送る）。勝手には何も止めない。
 *
 * 大きい順に、止められるもの（Agent・シェルのターミナル、内蔵ブラウザのページ）を並べ、行ごとの「止める」で利用者が選ぶ。
 * - 続きから起動し直せる Agent（Claude Code・Codex）は、会話を残して休ませる（ペインの「続きから再開」で戻る）
 * - それ以外のターミナルは閉じる。内蔵ブラウザは空のページにする
 * - 作業中の Agent・コマンドが動いているシェルは、止める前に確かめる
 * 「あとで」は main に伝え、30 分は大きく悪くならない限り出さない。消えるまで自動では閉じない。
 * 内蔵ブラウザ（WebContentsView）は DOM の上に重なるので、トーストと同じくビューの横に置く（lib/toastPlacement.ts）。
 */

interface Pending {
  row: MemoryConsumer
  label: string
}

export function MemoryAlert() {
  const t = useT()
  const toast = useToast()
  const [notice, setNotice] = useState<MemoryAlertNotice | null>(null)
  /** 止めた行（次の知らせが来るまで隠す） */
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set())
  const [confirm, setConfirm] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.ade.invoke('memoryAlert:current').then((current) => setNotice(current)).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    return window.ade.on('memoryAlert:update', (next) => {
      setNotice(next)
      setStopped(new Set())
      if (!next) setConfirm(null)
    })
  }, [])

  const rows = useMemo(
    () => memoryConsumers(notice?.snapshot ?? null, getPaneDirectory()).filter((row) => !stopped.has(row.id)),
    // 止めたあと・知らせが変わったときに並べ直す（ペインの中身はそのときの値を読む）
    [notice, stopped]
  )

  const hostRef = useRef<HTMLDivElement>(null)
  const view = useSyncExternalStore(subscribeViewBoundsForToasts, getViewBoundsForToasts)
  const placement = toastPlacement(view, { width: window.innerWidth, height: window.innerHeight })
  const style: CSSProperties | undefined = placement.kind === 'side'
    ? (placement.side === 'right' ? { right: placement.offset, left: 'auto' } : { left: placement.offset, right: 'auto' })
    : undefined
  // 設定などのダイアログ（showModal）より上に出すため popover にする（Toast.tsx と同じ）
  useEffect(() => {
    const host = hostRef.current
    if (!host || !notice || typeof host.showPopover !== 'function') return
    if (!host.matches(':popover-open')) host.showPopover()
  }, [notice])

  const later = useCallback(() => {
    setNotice(null)
    setConfirm(null)
    void window.ade.invoke('memoryAlert:dismiss').catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
  }, [])

  const stop = useCallback(async (row: MemoryConsumer) => {
    setConfirm(null)
    setBusy(row.id)
    try {
      if (row.kind === 'agent' && row.resumable && await requestSleep(row.id)) {
        toast({ tone: 'success', message: t('memoryAlert.slept', { name: row.label }) })
      } else if (row.kind === 'page') {
        await window.ade.invoke('resources:kill', { kind: 'page' })
        toast({ tone: 'success', message: t('memoryAlert.closed', { name: t('memoryAlert.browser') }) })
      } else {
        await window.ade.invoke('resources:kill', { kind: 'terminal', id: row.id })
        toast({ tone: 'success', message: t('memoryAlert.closed', { name: row.label }) })
      }
      setStopped((prev) => new Set(prev).add(row.id))
    } catch (err) {
      reportHandled(err, { area: 'resources', op: 'stop from memory alert' })
    } finally {
      setBusy(null)
    }
  }, [t, toast])

  const ask = (row: MemoryConsumer) => {
    if (!row.busy) { void stop(row); return }
    setConfirm({ row, label: row.kind === 'agent' ? t('memoryAlert.confirmBusyAgent', { name: row.label }) : t('memoryAlert.confirmBusyShell', { name: row.label }) })
  }

  if (!notice) return null

  const stateLabel = (row: MemoryConsumer): string | null => {
    if (row.kind === 'page') return null
    if (row.kind === 'agent') return row.busy ? t('memoryAlert.state.working') : t('memoryAlert.state.idle')
    return row.busy ? t('memoryAlert.state.running') : t('memoryAlert.state.quiet')
  }
  const hintOf = (row: MemoryConsumer) => row.kind === 'page' ? t('memoryAlert.pageHint') : row.resumable ? t('memoryAlert.sleepHint') : t('memoryAlert.closeHint')
  const summary = notice.available !== null
    ? t('memoryAlert.summary', { available: formatMemory(notice.available), total: formatMemory(notice.total), ferret: notice.ferret !== null ? formatMemory(notice.ferret) : '—' })
    : t('memoryAlert.summaryNoAvailable', { ferret: notice.ferret !== null ? formatMemory(notice.ferret) : '—', total: formatMemory(notice.total) })

  return (
    <div ref={hostRef} popover="manual" className="toast-host memory-alert-host" style={style} data-testid="memory-alert-host">
      <div className={`toast toast--${notice.level === 'critical' ? 'danger' : 'warning'} memory-alert`} role="alert" data-testid="memory-alert">
        <span className="toast__icon"><MemoryStick size={16} strokeWidth={1.75} /></span>
        <div className="toast__body memory-alert__body">
          <span className="toast__message">{t('memoryAlert.title')}</span>
          <span className="toast__detail">
            {notice.level === 'critical' && <strong className="memory-alert__critical">{t('memoryAlert.critical')} · </strong>}
            {summary}
          </span>
          {rows.length === 0
            ? <span className="toast__detail">{t('memoryAlert.nothing')}</span>
            : <ul className="memory-alert__list" aria-label={t('memoryAlert.listLabel')}>
              {rows.map((row) => (
                <li key={row.id} className="memory-alert__row" data-testid="memory-alert-row">
                  <span className="memory-alert__icon" aria-hidden="true">
                    {row.kind === 'page' ? <Globe size={13} /> : row.launch ? <AgentIcon agent={row.launch} size={13} /> : <SquareTerminal size={13} />}
                  </span>
                  <span className="memory-alert__name" title={`${row.projectName} · ${row.kind === 'page' ? t('memoryAlert.browser') : row.label}`}>
                    <span className="memory-alert__project">{row.projectName}</span>
                    <span className="memory-alert__label">{row.kind === 'page' ? `${t('memoryAlert.browser')}${row.label ? ` · ${row.label}` : ''}` : row.label}</span>
                    {stateLabel(row) && <span className={`memory-alert__state${row.busy ? ' is-busy' : ''}`}>{stateLabel(row)}{row.resumable ? ` · ${t('memoryAlert.resumable')}` : ''}</span>}
                  </span>
                  <span className="memory-alert__mem">{formatMemory(row.memory)}</span>
                  <Button variant="ghost" busy={busy === row.id} disabled={busy !== null && busy !== row.id}
                    title={hintOf(row)} aria-label={t('memoryAlert.stopNamed', { name: row.label })}
                    onClick={() => ask(row)} data-testid="memory-alert-stop">
                    {t('memoryAlert.stop')}
                  </Button>
                </li>
              ))}
            </ul>}
          {confirm && <div className="memory-alert__confirm" role="alertdialog" aria-label={confirm.label}>
            <p>{confirm.label}</p>
            <div className="memory-alert__actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>{t('common.cancelShort')}</Button>
              <Button variant="danger" onClick={() => void stop(confirm.row)} data-testid="memory-alert-confirm">{t('memoryAlert.stop')}</Button>
            </div>
          </div>}
          <div className="memory-alert__actions">
            <Button variant="ghost" onClick={() => requestOpenResources()}>{t('memoryAlert.openManager')}</Button>
            <Button variant="ghost" title={t('memoryAlert.laterHint')} onClick={later} data-testid="memory-alert-later">{t('memoryAlert.later')}</Button>
          </div>
        </div>
        <IconButton label={t('memoryAlert.later')} size="sm" icon={<X size={14} strokeWidth={1.75} />} onClick={later} />
      </div>
    </div>
  )
}
