import { useState } from 'react'
import { ArrowLeft, Check, CircleAlert, Copy, LogIn, LogOut, Plus, Trash2 } from 'lucide-react'
import type { BlogKind, PublishConnectionsInfo } from '@shared/publish'
import { PUBLISH_LIMITS } from '@shared/publish'
import { Badge, Button, Field, IconButton, Segmented, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { VideoPublishConnections } from '@video/app/renderer/publish/VideoPublishConnections'

/**
 * 発信の接続先。X は利用者が自分の X の開発者ポータルで作った Native App の Client ID を入れ、既定のブラウザで認証する。
 * ブログは WordPress（アプリケーションパスワード）か EmDash（API トークン）。接続を確かめてから登録する（PublishPanel.tsx から開く）
 */
export function PublishConnections({ info, onChange, onBack }: {
  info: PublishConnectionsInfo | null
  onChange: (next: PublishConnectionsInfo) => void
  onBack: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [clientId, setClientId] = useState(info?.x.clientId ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [kind, setKind] = useState<BlogKind>('wordpress')
  const [blog, setBlog] = useState({ name: '', baseUrl: '', username: '', secret: '', collection: 'posts' })

  const run = (key: string, work: () => Promise<PublishConnectionsInfo | void>, done?: string) => {
    if (busy) return
    setBusy(key)
    void work().then((next) => {
      if (next) onChange(next)
      if (done) toast({ tone: 'success', message: done })
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(null))
  }
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast({ tone: 'success', message: t('publish.connect.copied') }), () => toast({ tone: 'warning', message: text }))
  }
  const x = info?.x
  const savedId = x?.clientId ?? ''
  const addBlog = () => run('blog', async () => {
    const next = await window.ade.invoke('publish:addBlog', {
      kind, name: blog.name, baseUrl: blog.baseUrl, secret: blog.secret,
      ...(kind === 'wordpress' ? { username: blog.username } : { collection: blog.collection })
    })
    setBlog({ name: '', baseUrl: '', username: '', secret: '', collection: 'posts' })
    return next
  }, t('publish.connect.blogAdded'))

  return <div className="publish-connect" data-testid="publish-connections">
    <div>
      <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack} data-testid="publish-connect-back">{t('publish.connect.back')}</Button>
    </div>
    {info && !info.persisted && <p className="st-note st-note--warn"><CircleAlert size={12} aria-hidden="true" />{t('publish.connect.notPersisted')}</p>}

    <section className="publish-connect__section" aria-labelledby="publish-connect-x">
      <h3 id="publish-connect-x">{t('publish.connect.xTitle')}</h3>
      <ol className="publish-connect__steps">
        <li>{t('publish.connect.xStep1')}</li>
        <li>{t('publish.connect.xStep2')}</li>
        <li className="publish-connect__callback">
          {t('publish.connect.xStep3')}
          <code data-testid="publish-x-callback">{x?.callbackUrl ?? ''}</code>
          <IconButton label={t('publish.copy')} icon={<Copy size={13} />} onClick={() => copy(x?.callbackUrl ?? '')} />
        </li>
        <li>{t('publish.connect.xStep4')}</li>
      </ol>
      <div className="publish-connect__row">
        <Field className="publish-connect__grow" mono value={clientId} maxLength={200} placeholder={t('publish.connect.clientIdPlaceholder')} aria-label={t('publish.connect.clientId')}
          onChange={(e) => setClientId(e.target.value)} data-testid="publish-x-client-id" />
        <Button disabled={busy !== null || clientId.trim() === savedId} busy={busy === 'clientId'}
          onClick={() => run('clientId', () => window.ade.invoke('publish:setXClientId', clientId.trim()), t('publish.connect.clientIdSaved'))} data-testid="publish-x-client-id-save">
          {t('publish.connect.save')}
        </Button>
      </div>
      <div className="publish-connect__row">
        {x?.connected
          ? <>
            <span className="publish-connect__status" data-testid="publish-x-status"><Check size={14} aria-hidden="true" />{t('publish.connect.xConnected', { username: x.username ?? '' })}</span>
            <Button variant="ghost" icon={<LogOut size={13} />} disabled={busy !== null} busy={busy === 'disconnect'}
              onClick={() => run('disconnect', () => window.ade.invoke('publish:disconnectX'), t('publish.connect.xDisconnected'))} data-testid="publish-x-disconnect">
              {t('publish.connect.xDisconnect')}
            </Button>
          </>
          : <span className="st-note" data-testid="publish-x-status">{t('publish.connect.xNotConnected')}</span>}
        <Button variant={x?.connected ? 'default' : 'primary'} icon={<LogIn size={13} />} disabled={!savedId || (busy !== null && busy !== 'connect')} busy={busy === 'connect'}
          onClick={() => run('connect', () => window.ade.invoke('publish:connectX'), t('publish.connect.xDone'))} data-testid="publish-x-connect">
          {x?.connected ? t('publish.connect.xReconnect') : t('publish.connect.xConnect')}
        </Button>
        {busy === 'connect' && <Button variant="ghost" onClick={() => void window.ade.invoke('publish:cancelConnectX')} data-testid="publish-x-cancel">{t('common.cancel')}</Button>}
      </div>
      {busy === 'connect' && <p className="st-note" role="status">{t('publish.connect.xWaiting')}</p>}
    </section>

    <VideoPublishConnections />
    <section className="publish-connect__section" aria-labelledby="publish-connect-blog">
      <h3 id="publish-connect-blog">{t('publish.connect.blogTitle')}</h3>
      {info?.blogs.length ? <ul className="publish-connect__blogs" data-testid="publish-blogs">
        {info.blogs.map((b) => <li key={b.id}>
          <Badge>{t(`publish.connect.kind.${b.kind}`)}</Badge>
          <span className="publish-connect__blog-name">{b.name}</span>
          <span className="st-note publish-connect__blog-url">{b.baseUrl}{b.collection ? ` · ${b.collection}` : ''}</span>
          <IconButton label={t('publish.connect.blogRemove', { name: b.name })} icon={<Trash2 size={13} />} disabled={busy !== null}
            onClick={() => run('remove', () => window.ade.invoke('publish:removeBlog', b.id))} />
        </li>)}
      </ul> : <p className="st-note">{t('publish.connect.blogEmpty')}</p>}

      <div className="publish-connect__form">
        <Segmented<BlogKind> ariaLabel={t('publish.connect.blogKind')} value={kind} onChange={setKind} options={[
          { value: 'wordpress', label: t('publish.connect.kind.wordpress'), testId: 'publish-blog-kind-wordpress' },
          { value: 'emdash', label: t('publish.connect.kind.emdash'), testId: 'publish-blog-kind-emdash' }
        ]} />
        <p className="st-note">{t(kind === 'wordpress' ? 'publish.connect.wordpressHint' : 'publish.connect.emdashHint')}</p>
        <Field value={blog.name} maxLength={PUBLISH_LIMITS.blogNameChars} placeholder={t('publish.connect.blogName')} aria-label={t('publish.connect.blogName')}
          onChange={(e) => setBlog({ ...blog, name: e.target.value })} data-testid="publish-blog-name" />
        <Field mono value={blog.baseUrl} placeholder="https://example.com" aria-label={t('publish.connect.blogUrl')}
          onChange={(e) => setBlog({ ...blog, baseUrl: e.target.value })} data-testid="publish-blog-url" />
        {kind === 'wordpress'
          ? <Field value={blog.username} maxLength={100} placeholder={t('publish.connect.username')} aria-label={t('publish.connect.username')} autoComplete="off"
            onChange={(e) => setBlog({ ...blog, username: e.target.value })} data-testid="publish-blog-username" />
          : <Field mono value={blog.collection} maxLength={64} placeholder="posts" aria-label={t('publish.connect.collection')}
            onChange={(e) => setBlog({ ...blog, collection: e.target.value })} data-testid="publish-blog-collection" />}
        <Field type="password" mono value={blog.secret} maxLength={PUBLISH_LIMITS.blogSecretChars} autoComplete="off"
          placeholder={t(kind === 'wordpress' ? 'publish.connect.appPassword' : 'publish.connect.token')} aria-label={t(kind === 'wordpress' ? 'publish.connect.appPassword' : 'publish.connect.token')}
          onChange={(e) => setBlog({ ...blog, secret: e.target.value })} data-testid="publish-blog-secret" />
        <div>
          <Button icon={<Plus size={13} />} busy={busy === 'blog'} disabled={busy !== null || !blog.name.trim() || !blog.baseUrl.trim() || !blog.secret.trim() || (kind === 'wordpress' && !blog.username.trim())}
            onClick={addBlog} data-testid="publish-blog-add">
            {t('publish.connect.blogAdd')}
          </Button>
        </div>
      </div>
    </section>
  </div>
}
