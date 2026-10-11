import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleAlert, Copy, ExternalLink, ImagePlus, Link2, Send, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import type { PostDraftInfo, PostDraftPatch, PostDraftStatus, PublishConnectionsInfo, PublishSnapshot } from '@shared/publish'
import { PUBLISH_LIMITS, xMediaProblem } from '@shared/publish'
import { X_MAX_WEIGHT, splitForThread, xWeightedLength } from '@shared/xPost'
import { Badge, Button, Field, IconButton, Modal, Segmented, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { closePublishPanel, type PublishPanelRequest } from '../lib/publishPanel'
import { PublishConnections } from './PublishConnections'
import '../styles/github.css'
import '../styles/publish.css'

/** 打ち終えてから保存するまでの待ち */
const SAVE_DELAY_MS = 500

type EditorTab = 'x' | 'blog'

/**
 * 「発信」のパネル。「何を発信したいか」を書くと、AI が X の投稿文とブログの記事を書き、フォルダの画像・動画から合うものを選ぶ。
 * 下書きを選んで直し、X API で X に、WordPress・EmDash の API でブログに投稿する（接続先は「接続」で設定する）。
 */
export function PublishPanel({ request }: { request: PublishPanelRequest }) {
  const t = useT()
  const toast = useToast()
  const [snapshot, setSnapshot] = useState<PublishSnapshot | null>(null)
  const [connections, setConnections] = useState<PublishConnectionsInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<PostDraftStatus>('new')
  const [selectedId, setSelectedId] = useState<string | null>(request.draftId ?? null)
  const [generating, setGenerating] = useState(false)
  const [intent, setIntent] = useState('')
  const [view, setView] = useState<'drafts' | 'connections'>('drafts')

  const reload = useCallback(() => window.ade.invoke('publish:list').then((next) => {
    setSnapshot(next)
    setLoadError(null)
    return next
  }, (err) => { setLoadError(errorMessage(err)); return null }), [])
  const reloadConnections = useCallback(() => window.ade.invoke('publish:connections').then(setConnections, (err) => setLoadError(errorMessage(err))), [])
  useEffect(() => { void reload(); void reloadConnections() }, [reload, reloadConnections])
  useEffect(() => window.ade.on('publish:changed', () => { void reload() }), [reload])
  useEffect(() => { if (request.draftId) { setSelectedId(request.draftId); setFilter('new') } }, [request.draftId])

  const drafts = useMemo(() => (snapshot?.drafts ?? []).filter((d) => d.status === filter), [snapshot, filter])
  const selected = snapshot?.drafts.find((d) => d.id === selectedId) ?? drafts[0] ?? null
  const counts = useMemo(() => {
    const all = snapshot?.drafts ?? []
    return { new: all.filter((d) => d.status === 'new').length, posted: all.filter((d) => d.status === 'posted').length, dismissed: all.filter((d) => d.status === 'dismissed').length }
  }, [snapshot])

  const generate = (fromSource: boolean) => {
    if (generating) return
    setGenerating(true)
    const trimmed = intent.trim().slice(0, PUBLISH_LIMITS.intentChars)
    void window.ade.invoke('publish:generate', {
      ...(fromSource && request.sourceText ? { text: request.sourceText.slice(0, PUBLISH_LIMITS.sourceTextChars), ...(request.sourceLabel ? { textLabel: request.sourceLabel } : {}) } : {}),
      ...(trimmed ? { intent: trimmed } : {})
    }).then(async (count) => {
      const next = await reload()
      setFilter('new')
      const newest = next?.drafts.find((d) => d.status === 'new')
      if (newest) setSelectedId(newest.id)
      toast({ tone: 'success', message: t('publish.generated', { count }) })
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setGenerating(false))
  }
  const createManual = () => {
    void window.ade.invoke('publish:create', '').then(async (id) => {
      await reload()
      setFilter('new')
      setSelectedId(id)
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  const setBackground = (enabled: boolean) => {
    void window.ade.invoke('publish:setBackground', enabled).then(() => reload(), (err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const background = snapshot?.background
  return <Modal className="rv-modal" label={t('publish.title')} onClose={closePublishPanel}>
    <div className="gh-send publish" data-testid="publish-panel">
      <header className="gh-send__head">
        <h2><Send size={15} aria-hidden="true" />{t(view === 'connections' ? 'publish.connect.title' : 'publish.title')}</h2>
        <div className="publish__head-actions">
          {view === 'drafts' && <Button variant="ghost" icon={<Link2 size={14} />} onClick={() => setView('connections')} data-testid="publish-open-connections">
            {t('publish.connect.open')}
          </Button>}
          <IconButton label={t('common.close')} icon={<X size={16} />} onClick={closePublishPanel} />
        </div>
      </header>
      {loadError && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{loadError}</p>}

      {view === 'connections' ? (connections
        ? <PublishConnections info={connections} onChange={setConnections} onBack={() => setView('drafts')} />
        : <p className="st-note" role="status"><Spinner size={12} /> {t('publish.loading')}</p>) : <>
        <section className="publish__make" aria-label={t('publish.make')}>
          <textarea className="gh-send__input publish__intent" rows={3} value={intent} maxLength={PUBLISH_LIMITS.intentChars} placeholder={t('publish.intentPlaceholder')}
            aria-label={t('publish.intentLabel')} onChange={(e) => setIntent(e.target.value)} data-testid="publish-intent" />
          <div className="publish__make-actions">
            <Button variant="primary" icon={<Sparkles size={13} />} busy={generating} disabled={generating} onClick={() => generate(false)} data-testid="publish-generate">
              {t(intent.trim() ? 'publish.generateFromIntent' : 'publish.generateFromProject')}
            </Button>
            {request.sourceText && <Button icon={<Sparkles size={13} />} busy={generating} disabled={generating} onClick={() => generate(true)} data-testid="publish-generate-source"
              title={request.sourceLabel}>
              {t('publish.generateFromSource')}
            </Button>}
            <Button variant="ghost" onClick={createManual} data-testid="publish-new">{t('publish.newManual')}</Button>
            <span className="st-note">{t('publish.generateNote')}</span>
          </div>
        </section>
        <label className="st-check publish__background">
          <input type="checkbox" checked={background?.enabled ?? false} disabled={!background} onChange={(e) => setBackground(e.target.checked)} data-testid="publish-background" />
          {t('publish.background')}
          <span className="st-note publish__background-state" data-testid="publish-background-state">
            {background?.running ? <><Spinner size={10} /> {t('publish.backgroundRunning')}</>
              : background?.lastError ? t('publish.backgroundError', { reason: background.lastError })
                : background?.lastRunAt ? t('publish.backgroundLast', { time: new Date(background.lastRunAt).toLocaleString() }) : t('publish.backgroundIdle')}
          </span>
        </label>

        <div className="publish__body">
          <div className="publish__list">
            <Segmented<PostDraftStatus> ariaLabel={t('publish.filter')} value={filter} onChange={setFilter} options={[
              { value: 'new', label: t('publish.filter.new', { count: counts.new }), testId: 'publish-filter-new' },
              { value: 'posted', label: t('publish.filter.posted', { count: counts.posted }), testId: 'publish-filter-posted' },
              { value: 'dismissed', label: t('publish.filter.dismissed', { count: counts.dismissed }), testId: 'publish-filter-dismissed' }
            ]} />
            {!snapshot && !loadError && <p className="st-note" role="status"><Spinner size={12} /> {t('publish.loading')}</p>}
            {snapshot && drafts.length === 0 && <p className="st-note" data-testid="publish-empty">{t(filter === 'new' ? 'publish.emptyNew' : 'publish.emptyOther')}</p>}
            <ul className="publish__items" data-testid="publish-items">
              {drafts.map((draft) => <li key={draft.id}>
                <button type="button" className={`publish__item${selected?.id === draft.id ? ' is-selected' : ''}`} aria-current={selected?.id === draft.id} onClick={() => setSelectedId(draft.id)} data-testid="publish-item">
                  <span className="publish__item-title">{draft.title || draft.text.slice(0, 40) || t('publish.untitled')}</span>
                  <span className="publish__item-meta">
                    <Badge>{t(`publish.source.${draft.source}`)}</Badge>
                    {draft.media.length > 0 && <span>{t('publish.mediaCount', { count: draft.media.length })}</span>}
                    <time dateTime={draft.createdAt}>{new Date(draft.createdAt).toLocaleDateString()}</time>
                  </span>
                </button>
              </li>)}
            </ul>
          </div>
          {selected
            ? <DraftEditor key={selected.id} draft={selected} connections={connections} onChanged={reload} onOpenConnections={() => setView('connections')} />
            : <div className="publish__editor publish__editor--empty" />}
        </div>
      </>}
    </div>
  </Modal>
}

/** 打ち終えてから保存する（閉じる・別の下書きへ移るときも書きかけを残す） */
function useDraftSaver(id: string) {
  const toast = useToast()
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<PostDraftPatch>({})
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const patch = pending.current
    if (!Object.keys(patch).length) return
    pending.current = {}
    await window.ade.invoke('publish:update', id, patch)
  }, [id])
  useEffect(() => () => { void flush().catch(() => undefined) }, [flush])
  const queue = (patch: PostDraftPatch) => {
    pending.current = { ...pending.current, ...patch }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void flush().catch((err) => toast({ tone: 'warning', message: errorMessage(err) })) }, SAVE_DELAY_MS)
  }
  return { queue, flush }
}

function DraftEditor({ draft, connections, onChanged, onOpenConnections }: {
  draft: PostDraftInfo
  connections: PublishConnectionsInfo | null
  onChanged: () => Promise<unknown>
  onOpenConnections: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [tab, setTab] = useState<EditorTab>('x')
  const [text, setText] = useState(draft.text)
  const [articleTitle, setArticleTitle] = useState(draft.article.title)
  const [articleBody, setArticleBody] = useState(draft.article.body)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<EditorTab | null>(null)
  const [blogId, setBlogId] = useState(connections?.blogs[0]?.id ?? '')
  const [asDraft, setAsDraft] = useState(false)
  const { queue, flush } = useDraftSaver(draft.id)
  const { parts, overflow } = useMemo(() => splitForThread(text), [text])
  const total = useMemo(() => xWeightedLength(text.trim()), [text])
  const mediaProblem = xMediaProblem(draft.media)
  const blogs = connections?.blogs ?? []
  const blog = blogs.find((b) => b.id === blogId) ?? blogs[0]
  const x = connections?.x

  const act = (work: () => Promise<unknown>, done?: string) => {
    if (busy) return
    setBusy(true)
    void flush().then(work).then(() => onChanged()).then(() => { if (done) toast({ tone: 'success', message: done }) },
      (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(false))
  }
  const setStatus = (status: PostDraftStatus, done?: string) => act(() => window.ade.invoke('publish:update', draft.id, { status }), done)
  const removeMedia = (mediaId: string) => act(() => window.ade.invoke('publish:update', draft.id, { mediaOrder: draft.media.filter((m) => m.id !== mediaId).map((m) => m.id) }))
  const pickMedia = () => act(() => window.ade.invoke('publish:pickMedia', draft.id))
  const open = (url: string) => { void window.ade.invoke('app:openExternal', url).catch((err) => toast({ tone: 'warning', message: errorMessage(err) })) }

  const postX = () => {
    setConfirming(null)
    act(async () => {
      const result = await window.ade.invoke('publish:postX', draft.id)
      if (result.error) toast({ tone: 'warning', message: t('publish.x.partial', { done: result.posted, total: result.parts, reason: result.error }) })
      else toast({ tone: 'success', message: t('publish.x.posted') })
    })
  }
  const postBlog = () => {
    setConfirming(null)
    if (!blog) return
    act(async () => {
      const result = await window.ade.invoke('publish:postBlog', draft.id, blog.id, asDraft)
      toast({ tone: 'success', message: t(result.draft ? 'publish.blog.drafted' : 'publish.blog.posted', { name: blog.name }) })
    })
  }
  const copy = (index: number) => {
    void navigator.clipboard.writeText(parts[index] ?? '').then(
      () => toast({ tone: 'success', message: t('publish.copied', { index: index + 1 }) }),
      () => toast({ tone: 'warning', message: parts[index] ?? '' })
    )
  }

  return <div className="publish__editor" data-testid="publish-editor">
    {draft.basis && <p className="st-note publish__basis">{t('publish.basis', { basis: draft.basis })}</p>}
    <Segmented<EditorTab> ariaLabel={t('publish.target')} value={tab} onChange={(v) => { setTab(v); setConfirming(null) }} options={[
      { value: 'x', label: t('publish.tab.x'), testId: 'publish-tab-x' },
      { value: 'blog', label: t('publish.tab.blog'), testId: 'publish-tab-blog' }
    ]} />

    {tab === 'x' ? <>
      <label className="gh-send__field">
        <span className="gh-send__label">{t('publish.text')}</span>
        <textarea className="gh-send__input publish__text" rows={8} value={text} maxLength={PUBLISH_LIMITS.textChars}
          onChange={(e) => { setText(e.target.value); queue({ text: e.target.value }) }} data-testid="publish-text" />
        <span className={`publish__count${total > X_MAX_WEIGHT ? ' is-over' : ''}`} data-testid="publish-count">{t('publish.count', { count: total, max: X_MAX_WEIGHT })}</span>
      </label>
      {parts.length === 0 && <p className="st-note st-note--warn">{t('publish.empty')}</p>}
      {parts.length > 1 && <>
        <p className="st-note" data-testid="publish-thread">{t('publish.thread', { count: parts.length })}</p>
        {overflow && <p className="st-note st-note--warn" role="alert">{t('publish.overflow', { count: parts.length })}</p>}
        <ol className="publish__parts" data-testid="publish-parts">
          {parts.map((part, index) => <li key={index} className="publish__part">
            <div className="publish__part-head">
              <span className="gh-send__label">{t('publish.part', { index: index + 1 })}</span>
              <span className="publish__count">{t('publish.count', { count: xWeightedLength(part), max: X_MAX_WEIGHT })}</span>
              <IconButton label={t('publish.copy')} icon={<Copy size={13} />} onClick={() => copy(index)} />
            </div>
            <p className="publish__part-text">{part}</p>
          </li>)}
        </ol>
      </>}
    </> : <>
      <label className="gh-send__field">
        <span className="gh-send__label">{t('publish.articleTitle')}</span>
        <Field value={articleTitle} maxLength={PUBLISH_LIMITS.articleTitleChars} placeholder={draft.title}
          onChange={(e) => { setArticleTitle(e.target.value); queue({ articleTitle: e.target.value }) }} data-testid="publish-article-title" />
      </label>
      <label className="gh-send__field">
        <span className="gh-send__label">{t('publish.articleBody')}</span>
        <textarea className="gh-send__input publish__text publish__article" rows={14} value={articleBody} maxLength={PUBLISH_LIMITS.articleChars} placeholder={t('publish.articlePlaceholder')}
          onChange={(e) => { setArticleBody(e.target.value); queue({ articleBody: e.target.value }) }} data-testid="publish-article-body" />
        <span className="st-note">{t('publish.articleHint')}</span>
      </label>
    </>}

    <div className="gh-send__field">
      <span className="gh-send__label">{t('publish.media')}</span>
      <div className="publish__media" data-testid="publish-media">
        {draft.media.map((m) => <figure key={m.id} className="publish__thumb" title={m.ref ?? m.name}>
          {m.thumbnail ? <img src={m.thumbnail} alt={m.name} /> : <span className="publish__thumb-name">{m.name}</span>}
          {m.kind === 'video' && <figcaption>{t('publish.video')}</figcaption>}
          <IconButton className="publish__thumb-remove" label={t('publish.removeMedia', { name: m.name })} icon={<X size={12} />} disabled={busy} onClick={() => removeMedia(m.id)} />
        </figure>)}
        <Button variant="ghost" icon={<ImagePlus size={14} />} disabled={busy} onClick={pickMedia} data-testid="publish-add-media">{t('publish.addMedia')}</Button>
      </div>
      <span className="st-note">{t(tab === 'x' ? 'publish.mediaHint' : 'publish.mediaHintBlog')}</span>
      {tab === 'x' && mediaProblem && <p className="st-note st-note--warn" role="alert" data-testid="publish-media-problem">{t(`publish.mediaProblem.${mediaProblem}`)}</p>}
    </div>

    {draft.results.length > 0 && <div className="gh-send__field">
      <span className="gh-send__label">{t('publish.results')}</span>
      <ul className="publish__results" data-testid="publish-results">
        {draft.results.map((r, i) => <li key={`${r.at}-${i}`}>
          <Badge>{t(`publish.connect.kind.${r.kind}`)}</Badge>
          <span>{r.targetName}{r.draft ? ` ${t('publish.blog.draftMark')}` : ''}</span>
          <time className="st-note" dateTime={r.at}>{new Date(r.at).toLocaleString()}</time>
          {r.url && <Button variant="ghost" icon={<ExternalLink size={12} />} onClick={() => open(r.url!)}>{t('publish.open')}</Button>}
        </li>)}
      </ul>
    </div>}

    <div className="gh-send__foot publish__foot">
      {draft.status === 'new' ? <>
        <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => setStatus('dismissed')} data-testid="publish-dismiss">{t('publish.dismiss')}</Button>
        <Button icon={<Check size={13} />} disabled={busy} onClick={() => setStatus('posted', t('publish.markedPosted'))} data-testid="publish-mark-posted">{t('publish.markPosted')}</Button>
      </> : <>
        <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => act(() => window.ade.invoke('publish:remove', draft.id))} data-testid="publish-remove">{t('publish.remove')}</Button>
        <Button icon={<Undo2 size={13} />} disabled={busy} onClick={() => setStatus('new')} data-testid="publish-restore">{t('publish.restore')}</Button>
      </>}
      {tab === 'x'
        ? (x?.connected
          ? <Button variant="primary" icon={<Send size={13} />} busy={busy} disabled={busy || parts.length === 0 || mediaProblem !== null} onClick={() => setConfirming('x')} data-testid="publish-post-x">
            {t('publish.x.post')}
          </Button>
          : <Button variant="primary" icon={<Link2 size={13} />} onClick={onOpenConnections} data-testid="publish-connect-x">{t('publish.x.connectFirst')}</Button>)
        : (blog
          ? <>
            {blogs.length > 1 && <select className="st-select" aria-label={t('publish.blog.target')} value={blog.id} onChange={(e) => setBlogId(e.target.value)} data-testid="publish-blog-target">
              {blogs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>}
            <label className="st-check"><input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} data-testid="publish-blog-draft" />{t('publish.blog.asDraft')}</label>
            <Button variant="primary" icon={<Send size={13} />} busy={busy} disabled={busy || !(articleBody.trim() || text.trim())} onClick={() => setConfirming('blog')} data-testid="publish-post-blog">
              {t('publish.blog.post', { name: blog.name })}
            </Button>
          </>
          : <Button variant="primary" icon={<Link2 size={13} />} onClick={onOpenConnections} data-testid="publish-connect-blog">{t('publish.blog.addFirst')}</Button>)}
    </div>
    {confirming && <div className="publish__confirm" role="alertdialog" aria-label={t('publish.confirmTitle')} data-testid="publish-confirm">
      <span>{confirming === 'x'
        ? t(parts.length > 1 ? 'publish.x.confirmThread' : 'publish.x.confirm', { username: x?.username ?? '', count: parts.length, media: draft.media.length })
        : t(asDraft ? 'publish.blog.confirmDraft' : 'publish.blog.confirm', { name: blog?.name ?? '' })}</span>
      <Button variant="ghost" onClick={() => setConfirming(null)} data-testid="publish-confirm-cancel">{t('common.cancel')}</Button>
      <Button variant="primary" icon={<Send size={13} />} onClick={confirming === 'x' ? postX : postBlog} data-testid="publish-confirm-post">{t('publish.confirmPost')}</Button>
    </div>}
    <p className="st-note">{t(tab === 'x' ? 'publish.x.note' : 'publish.blog.note')}</p>
  </div>
}
