import { useEffect, useState } from 'react'
import { Check, CircleAlert, ExternalLink, LogIn, LogOut } from 'lucide-react'
import { Button, useToast } from '@/ui'
import { useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { PUBLISH_TARGETS, TARGET_LABEL, TIKTOK_UPLOAD_PAGE, type PublishTargetId, type VideoPublishAccounts } from '../../shared/publish'
import './publish.css'

/**
 * 発信の「接続」に並べる YouTube・TikTok の行（動画の投稿に使う）。「接続」で既定のブラウザに同意画面が開き、戻れば終わり。
 * OAuth のクライアントは Ferret に組み込み（利用者は作らない）。組み込まれていない版では、そう書く（TikTok は手で上げる口を出す）。
 * 接続しても何も投稿しない。投稿は動画の確認画面の「OK・投稿する」から（担当: 投稿）。
 */
export function VideoPublishConnections() {
  const t = useT()
  const toast = useToast()
  const [acc, setAcc] = useState<VideoPublishAccounts | null>(null)
  const [busy, setBusy] = useState<{ target: PublishTargetId; kind: 'connect' | 'disconnect' } | null>(null)

  useEffect(() => {
    let alive = true
    void window.ade.invoke('video:publish:accounts').then((a) => { if (alive) setAcc(a) }, () => undefined)
    return () => { alive = false }
  }, [])

  const run = (target: PublishTargetId, kind: 'connect' | 'disconnect') => {
    if (busy) return
    setBusy({ target, kind })
    const label = TARGET_LABEL[target]
    void window.ade.invoke(kind === 'connect' ? 'video:publish:connect' : 'video:publish:disconnect', target).then((next) => {
      setAcc(next)
      toast({ tone: 'success', message: t(kind === 'connect' ? 'video.publish.connectDone' : 'video.publish.disconnected', { target: label }) })
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(null))
  }

  return <section className="publish-connect__section vpub-connect" aria-labelledby="video-publish-connect-title" data-testid="video-publish-connections">
    <h3 id="video-publish-connect-title">{t('video.publish.accounts.title')}</h3>
    <p className="st-note">{t('video.publish.accounts.hint')}</p>
    {acc && !acc.persisted && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('video.publish.accounts.notPersisted')}</p>}
    {PUBLISH_TARGETS.map((target) => {
      const a = acc?.[target]
      const label = TARGET_LABEL[target]
      const waiting = busy?.target === target && busy.kind === 'connect'
      return <div key={target} className="vpub-connect__row" data-target={target} data-testid={`video-publish-account-${target}`}>
        <div className="vpub-connect__main">
          <strong>{label}</strong>
          {!a
            ? <span className="st-note">…</span>
            : a.connected
              ? <span className="publish-connect__status"><Check size={14} aria-hidden="true" />{a.name ?? t('video.publish.connected')}</span>
              : <span className="st-note">{a.configured ? t('video.publish.notConnected') : target === 'tiktok' ? t('video.publish.ttPreparing') : t('video.publish.ytNoClient')}</span>}
          {target === 'tiktok' && a?.connected && <span className="st-note">{a.directPost ? t('video.publish.ttDirect') : t('video.publish.ttInboxNote')}</span>}
          {waiting && <span className="st-note" role="status">{t('video.publish.connectWaiting')}</span>}
        </div>
        <div className="vpub-connect__actions">
          {a?.connected && <Button variant="ghost" icon={<LogOut size={13} />} disabled={busy !== null} busy={busy?.target === target && busy.kind === 'disconnect'}
            onClick={() => run(target, 'disconnect')} data-testid={`video-publish-disconnect-${target}`}>{t('video.publish.disconnect')}</Button>}
          {a?.configured
            ? <Button variant={a.connected ? 'default' : 'primary'} icon={<LogIn size={13} />} disabled={busy !== null && !waiting} busy={waiting}
              onClick={() => run(target, 'connect')} data-testid={`video-publish-connect-${target}`}>{t('video.publish.connectTo', { target: label })}</Button>
            : a && target === 'tiktok'
              ? <Button icon={<ExternalLink size={13} />} onClick={() => void window.ade.invoke('app:openExternal', TIKTOK_UPLOAD_PAGE)}>{t('video.publish.ttManual')}</Button>
              : a && <Button disabled title={t('video.publish.ytNoClient')}>{t('video.publish.connectTo', { target: label })}</Button>}
          {waiting && <Button variant="ghost" onClick={() => void window.ade.invoke('video:publish:cancelConnect')} data-testid={`video-publish-cancel-${target}`}>{t('common.cancel')}</Button>}
        </div>
      </div>
    })}
  </section>
}
