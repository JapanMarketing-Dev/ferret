import { useEffect, useState } from 'react'
import type { MobileRemoteState } from '@shared/mobileRemote'
import { MOBILE_REMOTE_DEFAULT_PORT, isValidPort } from '@shared/mobileRemote'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, useToast } from '../ui'

/**
 * 設定の「スマホから操作」。入れると main（src/main/mobileRemote.ts）が同じ Wi‑Fi・Tailscale からの HTTP の口を開き、
 * ここにスマホで開くリンクと、その QR コードを出す。状態は自分で読み、切り替えはすぐ main へ送る（remote:set）。
 * リンクには合言葉が入るので、画面に出すだけでログには書かない
 */
export function RemoteSection() {
  const t = useT()
  const toast = useToast()
  const [state, setState] = useState<MobileRemoteState | null>(null)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('remote:state').then((s) => { if (!cancelled) setState(s) }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    const off = window.ade.on('remote:changed', (s) => setState(s))
    return () => { cancelled = true; off() }
  }, [])

  if (!state) return <p className="st-note">{t('usage.loading')}</p>

  const run = (task: Promise<MobileRemoteState>, done?: string) => {
    setBusy(true)
    void task
      .then((s) => { setState(s); if (done) toast({ tone: 'success', message: done }) })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
      .finally(() => setBusy(false))
  }
  const savePort = (value: string) => {
    setPortDraft(null)
    const port = Number(value.trim())
    if (!value.trim() || port === state.port) return
    if (!isValidPort(port)) {
      toast({ tone: 'warning', message: t('remote.portInvalid') })
      return
    }
    run(window.ade.invoke('remote:set', { port }))
  }
  const reset = () => {
    if (!window.confirm(t('remote.resetConfirm'))) return
    run(window.ade.invoke('remote:resetToken'), t('remote.resetDone'))
  }
  const copy = (url: string) => void navigator.clipboard.writeText(url).then(() => toast({ tone: 'success', message: t('common.copied') }), () => {})

  return <div className="st-page__group remote-settings" data-testid="remote-settings">
    <p className="st-note">{t('remote.intro')}</p>
    <label className="st-row st-row--switch">
      <span className="st-row__label">{t('remote.enable')}</span>
      <input type="checkbox" role="switch" className="st-switch" checked={state.enabled} disabled={busy}
        onChange={(e) => run(window.ade.invoke('remote:set', { enabled: e.target.checked }))} data-testid="remote-enabled" />
    </label>
    <div className="st-row">
      <span className="st-row__label">{t('remote.port')}</span>
      <Field className="remote-settings__port" type="number" inputMode="numeric" min={1024} max={65535} mono
        aria-label={t('remote.port')} placeholder={String(MOBILE_REMOTE_DEFAULT_PORT)}
        value={portDraft ?? String(state.port)} disabled={busy}
        onChange={(e) => setPortDraft(e.target.value)}
        onBlur={(e) => savePort(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        data-testid="remote-port" />
    </div>
    {state.enabled && state.error && <p className="st-note st-note--warn" role="alert">{t(`remote.error.${state.error}`, { port: state.port })}</p>}
    {state.running && state.urls.length === 0 && <p className="st-note st-note--warn">{t('remote.noAddress')}</p>}
    {state.running && state.urls.length > 0 && <>
      <p className="st-note">{t('remote.running', { port: state.port })}</p>
      <div className="remote-settings__share">
        {state.qr && <svg className="remote-settings__qr" viewBox={`0 0 ${state.qr.size} ${state.qr.size}`} role="img" aria-label={t('remote.qrLabel')}
          shapeRendering="crispEdges" data-testid="remote-qr">
          <rect width={state.qr.size} height={state.qr.size} fill="#fff" />
          <path d={state.qr.path} fill="#000" />
        </svg>}
        <ul className="remote-settings__urls">
          {state.urls.map((url) => <li key={url}>
            <code className="remote-settings__url">{url}</code>
            <Button variant="ghost" onClick={() => copy(url)}>{t('remote.copy')}</Button>
          </li>)}
        </ul>
      </div>
      <div className="st-row">
        <Button variant="default" disabled={busy} onClick={reset} data-testid="remote-reset">{t('remote.reset')}</Button>
      </div>
    </>}
    <p className="st-note st-note--warn">{t('remote.warning')}</p>
    <p className="st-note">{t('remote.firewall')}</p>
  </div>
}
