import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Play, RotateCw, Sparkles } from 'lucide-react'
import { designSystemRequest, isLocalStorybookUrl, type DesignSystemStatus } from '@shared/designSystem'
import { Button, EmptyState, IconButton, Spinner, useToast } from '../ui'
import { useLocale, useT } from '../lib/i18n'
import { requestTerminalCommand } from '../lib/terminalCommand'
import '../styles/designSystem.css'

/** 起動を待つ間・動いていない間に、動いているかを聞き直す間隔 */
const POLL_MS = 2500

/**
 * デザインシステムのタブ。開いているプロジェクトの Storybook をそのまま埋め込む。
 * - 動いている … タブいっぱいに出す（手元の URL だけ。index.html の CSP の frame-src も手元だけ）
 * - 置いてあるが止まっている … ［起動する］でターミナルに起動の1行を打つ（出力が見え、人が止められる）
 * - 無い … ［Agent に作ってもらう］で、skill ferret-design-system を使う依頼を Agent へ送る
 */
export function DesignSystem({ folderPath }: { folderPath: string | null }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const [status, setStatus] = useState<DesignSystemStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [asking, setAsking] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = await window.ade.invoke('designSystem:status')
      if (alive.current) setStatus(next)
      if (next?.state === 'running') setStarting(false)
    } catch {
      // 失敗は main の IPC が Sentry へ送る。次の聞き直しで戻る
    }
  }, [])

  useEffect(() => {
    alive.current = true
    setStatus(null)
    void load()
    return () => { alive.current = false }
  }, [folderPath, load])

  // 動いていない間は聞き直す（ターミナルで起動した・Agent が作った、を拾う）。動いたら止める
  useEffect(() => {
    if (status?.state === 'running') return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.state, load])

  const start = () => {
    if (!status?.command) return
    const ok = requestTerminalCommand({ command: status.command, title: 'Storybook' })
    if (!ok) toast({ tone: 'warning', message: t('designSystem.noTerminal', { command: status.command }) })
    else setStarting(true)
  }

  const askAgent = async () => {
    setAsking(true)
    try {
      const result = await window.ade.invoke('agent:sendText', designSystemRequest(locale === 'ja' ? 'ja' : 'en'))
      toast({ tone: result.ok ? 'success' : 'warning', message: result.ok ? t('designSystem.asked') : result.message })
    } catch (err) {
      toast({ tone: 'danger', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setAsking(false)
    }
  }

  if (!folderPath) return <div className="ds" data-testid="design-system"><EmptyState title={t('designSystem.noProject')} testId="design-system-empty" /></div>
  if (!status) return <div className="ds ds--loading" data-testid="design-system"><Spinner size={16} /></div>

  if (status.state === 'running' && isLocalStorybookUrl(status.url)) {
    return (
      <div className="ds" data-testid="design-system">
        <div className="ds__bar">
          <span className="ds__url" title={status.url}>{status.url}</span>
          <IconButton label={t('designSystem.reload')} onClick={() => setFrameKey((k) => k + 1)} icon={<RotateCw size={14} />} data-testid="design-system-reload" />
          <IconButton label={t('designSystem.openInBrowser')} onClick={() => void window.ade.invoke('browser:navigate', status.url).catch(() => undefined)} icon={<ExternalLink size={14} />} data-testid="design-system-open" />
        </div>
        <iframe
          key={frameKey}
          className="ds__frame"
          src={status.url}
          title={t('centerTabs.designSystem')}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          data-testid="design-system-frame"
        />
      </div>
    )
  }

  if (status.state === 'stopped') {
    return (
      <div className="ds" data-testid="design-system">
        <EmptyState
          title={starting ? t('designSystem.starting') : t('designSystem.stopped.title')}
          description={status.command ? <code className="ds__cmd">{status.command}</code> : t('designSystem.stopped.noCommand')}
          actions={status.command && <Button variant="primary" icon={<Play size={14} />} busy={starting} onClick={start} data-testid="design-system-start">{t('designSystem.start')}</Button>}
          testId="design-system-stopped"
        />
      </div>
    )
  }

  return (
    <div className="ds" data-testid="design-system">
      <EmptyState
        title={t('designSystem.none.title')}
        description={t('designSystem.none.description')}
        actions={<Button variant="primary" icon={<Sparkles size={14} />} busy={asking} onClick={() => void askAgent()} data-testid="design-system-ask">{t('designSystem.askAgent')}</Button>}
        testId="design-system-none"
      />
    </div>
  )
}
