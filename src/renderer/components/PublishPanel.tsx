import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleAlert, Copy, ImagePlus, Send, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import type { PostDraftInfo, PostDraftStatus, PublishSnapshot } from '@shared/publish'
import { PUBLISH_LIMITS, xMediaProblem } from '@shared/publish'
import { X_MAX_WEIGHT, splitForThread, xWeightedLength } from '@shared/xPost'
import { Badge, Button, IconButton, Modal, Segmented, Spinner, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { closePublishPanel, type PublishPanelRequest } from '../lib/publishPanel'
import '../styles/github.css'
import '../styles/publish.css'

/** 本文を打ち終えてから保存するまでの待ち */
const SAVE_DELAY_MS = 500

/**
 * 「発信」のパネル。AI が作り置いた下書き（バックグラウンドで最近の変更から）と手で書いた下書きを選び、
 * 直して、画像・動画を付けて X に投稿する（内蔵ブラウザの X の投稿画面に本文とメディアを入れ、「ポスト」は利用者が押す）。
 * ブログ（japan-marketing.co.jp の CMS）は CMS ができたら同じ下書きから出す。
 */
export function PublishPanel({ request, onShowBrowser }: { request: PublishPanelRequest; onShowBrowser: () => void }) {
  const t = useT()
  const toast = useToast()
  const [snapshot, setSnapshot] = useState<PublishSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<PostDraftStatus>('new')
  const [selectedId, setSelectedId] = useState<string | null>(request.draftId ?? null)
  const [generating, setGenerating] = useState(false)
  const [hint, setHint] = useState('')

  const reload = useCallback(() => window.ade.invoke('publish:list').then((next) => {
    setSnapshot(next)
    setLoadError(null)
    return next
  }, (err) => { setLoadError(errorMessage(err)); return null }), [])
  useEffect(() => { void reload() }, [reload])
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
    const trimmedHint = hint.trim().slice(0, PUBLISH_LIMITS.hintChars)
    void window.ade.invoke('publish:generate', {
      ...(fromSource && request.sourceText ? { text: request.sourceText.slice(0, PUBLISH_LIMITS.sourceTextChars), ...(request.sourceLabel ? { textLabel: request.sourceLabel } : {}) } : {}),
      ...(trimmedHint ? { hint: trimmedHint } : {})
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
        <h2><Send size={15} aria-hidden="true" />{t('publish.title')}</h2>
        <IconButton label={t('common.close')} icon={<X size={16} />} onClick={closePublishPanel} />
      </header>
      {loadError && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{loadError}</p>}

      <section className="publish__make" aria-label={t('publish.make')}>
        <input className="gh-send__input publish__hint" value={hint} maxLength={PUBLISH_LIMITS.hintChars} placeholder={t('publish.hintPlaceholder')}
          onChange={(e) => setHint(e.target.value)} data-testid="publish-hint" />
        {request.sourceText && <Button icon={<Sparkles size={13} />} busy={generating} disabled={generating} onClick={() => generate(true)} data-testid="publish-generate-source"
          title={request.sourceLabel}>
          {t('publish.generateFromSource')}
        </Button>}
        <Button icon={<Sparkles size={13} />} busy={generating} disabled={generating} onClick={() => generate(false)} data-testid="publish-generate">
          {t('publish.generateFromProject')}
        </Button>
        <Button variant="ghost" onClick={createManual} data-testid="publish-new">{t('publish.newManual')}</Button>
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
        {selected ? <DraftEditor key={selected.id} draft={selected} onChanged={reload} onShowBrowser={onShowBrowser} /> : <div className="publish__editor publish__editor--empty" />}
      </div>
    </div>
  </Modal>
}

function DraftEditor({ draft, onChanged, onShowBrowser }: { draft: PostDraftInfo; onChanged: () => Promise<unknown>; onShowBrowser: () => void }) {
  const t = useT()
  const toast = useToast()
  const [text, setText] = useState(draft.text)
  const [busy, setBusy] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const pending = useRef<string | null>(null)
  const { parts, overflow } = useMemo(() => splitForThread(text), [text])
  const total = useMemo(() => xWeightedLength(text.trim()), [text])
  const mediaProblem = xMediaProblem(draft.media)

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const value = pending.current
    if (value === null) return
    pending.current = null
    await window.ade.invoke('publish:update', draft.id, { text: value })
  }, [draft.id])
  // 閉じる・別の下書きへ移るときも書きかけを残す
  useEffect(() => () => { void flush().catch(() => undefined) }, [flush])

  const edit = (value: string) => {
    setText(value)
    pending.current = value
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flush().catch((err) => toast({ tone: 'warning', message: errorMessage(err) })) }, SAVE_DELAY_MS)
  }
  const act = (work: () => Promise<unknown>, done?: string) => {
    if (busy) return
    setBusy(true)
    void flush().then(work).then(() => onChanged()).then(() => { if (done) toast({ tone: 'success', message: done }) },
      (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(false))
  }
  const setStatus = (status: PostDraftStatus, done?: string) => act(() => window.ade.invoke('publish:update', draft.id, { status }), done)
  const removeMedia = (mediaId: string) => act(() => window.ade.invoke('publish:update', draft.id, { mediaOrder: draft.media.filter((m) => m.id !== mediaId).map((m) => m.id) }))
  const pickMedia = () => act(() => window.ade.invoke('publish:pickMedia', draft.id))
  const postX = () => {
    if (busy || parts.length === 0) return
    setBusy(true)
    void flush().then(() => window.ade.invoke('publish:composeX', draft.id, parts)).then((result) => {
      onShowBrowser()
      closePublishPanel()
      if (result.status === 'filled' && result.parts < parts.length) toast({ tone: 'warning', message: t('publish.x.filledPartial', { done: result.parts, total: parts.length }) })
      else if (result.status === 'filled') toast({ tone: 'success', message: t('publish.x.filled') })
      else if (result.status === 'login') toast({ tone: 'warning', message: t('publish.x.login') })
      else toast({ tone: 'warning', message: t('publish.x.fallback', { reason: result.reason }) })
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) })).finally(() => setBusy(false))
  }
  const copy = (index: number) => {
    void navigator.clipboard.writeText(parts[index] ?? '').then(
      () => toast({ tone: 'success', message: t('publish.copied', { index: index + 1 }) }),
      () => toast({ tone: 'warning', message: parts[index] ?? '' })
    )
  }

  return <div className="publish__editor" data-testid="publish-editor">
    {draft.basis && <p className="st-note publish__basis">{t('publish.basis', { basis: draft.basis })}</p>}
    <label className="gh-send__field">
      <span className="gh-send__label">{t('publish.text')}</span>
      <textarea className="gh-send__input publish__text" rows={9} value={text} maxLength={PUBLISH_LIMITS.textChars} onChange={(e) => edit(e.target.value)} data-testid="publish-text" />
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

    <div className="gh-send__field">
      <span className="gh-send__label">{t('publish.media')}</span>
      <div className="publish__media" data-testid="publish-media">
        {draft.media.map((m) => <figure key={m.id} className="publish__thumb" title={m.name}>
          {m.thumbnail ? <img src={m.thumbnail} alt={m.name} /> : <span className="publish__thumb-name">{m.name}</span>}
          {m.kind === 'video' && <figcaption>{t('publish.video')}</figcaption>}
          <IconButton className="publish__thumb-remove" label={t('publish.removeMedia', { name: m.name })} icon={<X size={12} />} disabled={busy} onClick={() => removeMedia(m.id)} />
        </figure>)}
        <Button variant="ghost" icon={<ImagePlus size={14} />} disabled={busy} onClick={pickMedia} data-testid="publish-add-media">{t('publish.addMedia')}</Button>
      </div>
      <span className="st-note">{t('publish.mediaHint')}</span>
      {mediaProblem && <p className="st-note st-note--warn" role="alert" data-testid="publish-media-problem">{t(`publish.mediaProblem.${mediaProblem}`)}</p>}
    </div>

    <div className="gh-send__foot publish__foot">
      {draft.status === 'new' ? <>
        <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => setStatus('dismissed')} data-testid="publish-dismiss">{t('publish.dismiss')}</Button>
        <Button icon={<Check size={13} />} disabled={busy} onClick={() => setStatus('posted', t('publish.markedPosted'))} data-testid="publish-mark-posted">{t('publish.markPosted')}</Button>
      </> : <>
        <Button variant="ghost" icon={<Trash2 size={13} />} disabled={busy} onClick={() => act(() => window.ade.invoke('publish:remove', draft.id))} data-testid="publish-remove">{t('publish.remove')}</Button>
        <Button icon={<Undo2 size={13} />} disabled={busy} onClick={() => setStatus('new')} data-testid="publish-restore">{t('publish.restore')}</Button>
      </>}
      <Button variant="primary" icon={<Send size={13} />} busy={busy} disabled={busy || parts.length === 0 || mediaProblem !== null} onClick={postX} data-testid="publish-post-x">
        {t('publish.x.post')}
      </Button>
    </div>
    <p className="st-note">{t('publish.x.note')}</p>
  </div>
}
