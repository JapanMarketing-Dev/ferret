import { useEffect, useState } from 'react'
import type { CloudAppStatus } from '@shared/feedbackCloud'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, useToast } from '../ui'

/**
 * 設定の「Ferret アカウント」。メールに届く6桁のコードでログインすると、main（src/main/feedbackCloud/）が指摘を
 * PC とチームで共有し、skill「ferret-feedback」の feedback.md に載せる。チームの管理は Web で行うので、ここは開くボタンだけ。
 * 状態は自分で読む（トークンは画面へ来ない）
 */
export function CloudAccountSection() {
  const t = useT()
  const toast = useToast()
  const [status, setStatus] = useState<CloudAppStatus | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  /** コードを送ったメールアドレス（送るまでは null） */
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('cloud:status').then((s) => { if (!cancelled) setStatus(s) }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    return () => { cancelled = true }
  }, [])

  if (!status) return <p className="st-note">{t('usage.loading')}</p>

  const run = <T,>(task: Promise<T>, done: (value: T) => void) => {
    setBusy(true)
    void task.then(done).catch((err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(false))
  }
  const sendCode = () => {
    const value = email.trim()
    if (!value) return
    run(window.ade.invoke('cloud:start', value), () => { setSentTo(value); setCode('') })
  }
  const login = () => {
    if (!code.trim()) return
    run(window.ade.invoke('cloud:verify', code.trim()), (s) => { setStatus(s); setSentTo(null); setCode('') })
  }

  if (!status.loggedIn) {
    return <div className="st-page__group" data-testid="cloud-account">
      <p className="st-note">{t('cloud.intro')}</p>
      {sentTo === null
        ? <div className="st-row">
          <Field className="st-row__grow" type="email" inputMode="email" autoComplete="email" aria-label={t('cloud.email')} placeholder={t('cloud.emailPlaceholder')}
            value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendCode() }} data-testid="cloud-email" />
          <Button variant="primary" busy={busy} disabled={!email.trim()} onClick={sendCode} data-testid="cloud-send-code">{t('cloud.sendCode')}</Button>
        </div>
        : <>
          <p className="st-note">{t('cloud.codeSent', { email: sentTo })}</p>
          <div className="st-row">
            <Field className="st-row__grow" mono inputMode="numeric" autoComplete="one-time-code" maxLength={7} aria-label={t('cloud.code')} placeholder="123456"
              value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') login() }} data-testid="cloud-code" autoFocus />
            <Button variant="primary" busy={busy} disabled={!code.trim()} onClick={login} data-testid="cloud-login">{t('cloud.login')}</Button>
          </div>
          <div className="st-row st-row--buttons">
            <Button variant="ghost" disabled={busy} onClick={() => { setSentTo(null); setCode('') }}>{t('cloud.changeEmail')}</Button>
          </div>
        </>}
    </div>
  }

  return <div className="st-page__group" data-testid="cloud-account">
    <div className="st-row"><span className="st-row__label">{t('cloud.loggedInAs', { email: status.email ?? '' })}</span></div>
    <p className="st-note">
      {t('cloud.counts', { mine: status.mine ?? 0, team: status.team ?? 0 })}
      {' · '}
      {status.lastSyncAt ? t('cloud.lastSync', { time: new Date(status.lastSyncAt).toLocaleString() }) : t('cloud.neverSynced')}
    </p>
    {!status.persisted && <p className="st-note st-note--warn">{t('cloud.notPersisted')}</p>}
    <div className="st-row st-row--buttons">
      <Button variant="primary" onClick={() => void window.ade.invoke('cloud:openWeb').catch(() => undefined)} data-testid="cloud-manage">{t('cloud.manageTeams')}</Button>
      <Button busy={busy} onClick={() => run(window.ade.invoke('cloud:syncNow'), (s) => { setStatus(s); toast({ tone: 'success', message: t('cloud.synced') }) })} data-testid="cloud-sync">{t('cloud.syncNow')}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => run(window.ade.invoke('cloud:logout'), (s) => setStatus(s))} data-testid="cloud-logout">{t('cloud.logout')}</Button>
    </div>
  </div>
}
