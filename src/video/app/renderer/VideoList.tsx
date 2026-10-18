import { useEffect, useState } from 'react'
import { ChevronRight, Clapperboard, Plus, X } from 'lucide-react'
import { useLocale, useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { Badge, Button, EmptyState, Field, IconButton, Modal, Row, Spinner, useToast, type BadgeTone } from '@/ui'
import { formatDate } from '@shared/i18n'
import { VIDEO_CLI } from '@video/names'
import { videoFolderName, type VideoEntry, type VideoList as VideoListData, type VideoStatus, type VideoTemplateInfo } from '../shared/library'

export const STATUS_TONE: Record<VideoStatus, BadgeTone> = { new: 'neutral', editing: 'warning', done: 'brand', posted: 'success' }

/** 一覧の行の頭（タイトルの最初の1文字） */
function initialOf(title: string): string {
  return Array.from(title.trim())[0]?.toUpperCase() ?? '·'
}

/** 動画の一覧（新しい順）。空のときは最初の動画を作る案内 */
export function VideoList({ list, projectName, onOpen, onNew, onChanged }: {
  list: VideoListData | null
  projectName: string
  onOpen: (name: string) => void
  onNew: () => void
  onChanged: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [migrating, setMigrating] = useState<string | null>(null)

  const migrate = async (v: VideoEntry) => {
    setMigrating(v.name)
    try {
      const r = await window.ade.invoke('video:migrate', v.name)
      toast(r.ok ? { tone: 'success', message: t('video.migrate.done') } : { tone: 'warning', message: t('video.migrate.failed', { error: r.message, command: `${VIDEO_CLI} migrate` }) })
      onChanged()
    } catch (err) {
      toast({ tone: 'warning', message: t('video.migrate.failed', { error: errorMessage(err), command: `${VIDEO_CLI} migrate` }) })
    } finally {
      setMigrating(null)
    }
  }

  return (
    <div className="video-list" data-testid="video-list">
      <header className="video-list__head">
        <div className="video-list__heading">
          <h2>{t('video.list.title')}</h2>
          <span className="video-list__channel" title={list?.root}>{projectName}</span>
          {list && list.videos.length > 0 && <span className="video-list__count">{t('video.list.count', { count: list.videos.length })}</span>}
        </div>
        {list && list.videos.length > 0 && <Button variant="primary" icon={<Plus size={14} />} onClick={onNew} data-testid="video-new">{t('video.list.new')}</Button>}
      </header>
      {!list ? (
        <p className="video-note" role="status"><Spinner size={12} /> {t('video.list.loading')}</p>
      ) : list.error ? (
        <p className="video-note video-note--warn" role="alert">{list.error === 'permission' ? t('video.list.noAccess') : list.error === 'notDir' ? t('video.list.missing') : t('video.list.unreadable', { error: list.error })}</p>
      ) : !list.exists ? (
        <p className="video-note video-note--warn" role="alert">{t('video.list.missing')}</p>
      ) : list.videos.length === 0 ? (
        <EmptyState title={t('video.list.emptyTitle')} description={t('video.list.emptyBody')} testId="video-list-empty"
          actions={<Button variant="primary" icon={<Plus size={14} />} onClick={onNew} data-testid="video-new">{t('video.list.new')}</Button>} />
      ) : (
        <div className="video-list__rows" role="list">
          {list.videos.map((v) => (
            <div role="listitem" key={v.dir}>
              <Row
                testId={`video-row-${v.name}`}
                leading={<span className="video-list__tile" aria-hidden="true">{initialOf(v.title)}</span>}
                title={v.title}
                meta={v.updatedAt ? t('video.list.updated', { date: formatDate(v.updatedAt) }) : undefined}
                description={v.legacy ? t('video.migrate.hint', { command: `${VIDEO_CLI} migrate` }) : <span className="video-list__dir">{v.name}</span>}
                trailing={<span className="video-list__trail">
                  {v.legacy
                    ? <>
                      <Badge tone="warning">{t('video.legacy')}</Badge>
                      <Button busy={migrating === v.name} onClick={(e) => { e.stopPropagation(); void migrate(v) }} onKeyDown={(e) => e.stopPropagation()} data-testid={`video-migrate-${v.name}`}>{t('video.migrate')}</Button>
                    </>
                    : <Badge tone={STATUS_TONE[v.status]}>{t(`video.status.${v.status}`)}</Badge>}
                  <ChevronRight size={14} aria-hidden="true" />
                </span>}
                onClick={() => onOpen(v.name)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 新しい動画: ネタ・タイトルとテンプレートを選んで、フォルダを作って `ferret-video init` */
export function NewVideoDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const t = useT()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [templates, setTemplates] = useState<VideoTemplateInfo[] | null>(null)
  const [template, setTemplate] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locale = useLocale()

  useEffect(() => {
    let alive = true
    void window.ade.invoke('video:templates').then(
      (list) => {
        if (!alive) return
        setTemplates(list)
        setTemplate((cur) => cur || (list.find((x) => x.id === 'tech') ?? list[0])?.id || '')
      },
      () => { if (alive) setTemplates([]) }
    )
    return () => { alive = false }
  }, [])

  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.ade.invoke('video:create', { title: title.trim(), ...(template ? { template } : {}) })
      if (!r.ok || !r.name) {
        setError(t('video.new.failed', { error: r.error ?? '' }))
        return
      }
      toast({ tone: 'success', message: t('video.new.created', { name: r.name }) })
      onCreated(r.name)
    } catch (err) {
      setError(t('video.new.failed', { error: errorMessage(err) }))
    } finally {
      setBusy(false)
    }
  }

  const label = (x: VideoTemplateInfo) => (locale === 'ja' ? x.name.ja : x.name.en)
  const describe = (x: VideoTemplateInfo) => (typeof x.description === 'string' ? x.description : x.description ? (locale === 'ja' ? x.description.ja : x.description.en) : '')

  return (
    <Modal className="rv-modal" label={t('video.new.title')} onClose={onClose}>
      <div className="rv-modal__panel video-new" data-testid="video-new-dialog">
        <header className="rv-modal__head">
          <h2><Clapperboard size={15} aria-hidden="true" />{t('video.new.title')}</h2>
          <IconButton label={t('common.close')} icon={<X size={16} />} onClick={onClose} />
        </header>
        <label className="video-new__field">
          <span>{t('video.new.idea')}</span>
          <Field autoFocus value={title} placeholder={t('video.new.ideaPlaceholder')} maxLength={200} data-testid="video-new-title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create() }} />
          <span className="video-note">{t('video.new.willCreate', { name: videoFolderName(title) })}</span>
        </label>
        <fieldset className="video-new__field video-new__templates">
          <legend>{t('video.new.template')}</legend>
          {templates === null && <p className="video-note" role="status"><Spinner size={12} /> {t('video.new.templatesLoading')}</p>}
          {templates?.map((x) => (
            <label key={x.id} className={`video-new__template${template === x.id ? ' is-selected' : ''}`}>
              <input type="radio" name="video-template" value={x.id} checked={template === x.id} onChange={() => setTemplate(x.id)} />
              <span className="video-new__template-name">{label(x)}</span>
              {describe(x) && <span className="video-new__template-desc">{describe(x)}</span>}
            </label>
          ))}
        </fieldset>
        {error && <p className="video-note video-note--warn" role="alert">{error}</p>}
        <footer className="video-new__foot">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void create()} data-testid="video-new-create">{t('video.new.create')}</Button>
        </footer>
      </div>
    </Modal>
  )
}
