import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Circle, CircleAlert, Clapperboard, Eye, FolderOpen, LoaderCircle, Minus, Send, Sparkles, Video } from 'lucide-react'
import { useT, type TFunction } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { subscribeIpc } from '@/lib/ipcEvents'
import { Badge, Button, Card, IconButton, Progress, Spinner, Tooltip, useToast } from '@/ui'
import { VIDEO_CLI } from '@video/names'
import { tabEn } from '@shared/i18n/video/tab.en'
import { progressOf, type VideoDetail as VideoDetailData, type VideoStep } from '../shared/library'
import type { SavedFeedback } from '../shared/review'
import { sendVideoPrompt } from './agentSend'
import { ReviewView } from './review/ReviewView'
import { STATUS_TONE } from './VideoList'

const RecordView = lazy(() => import('./record/RecordView').then((m) => ({ default: m.RecordView })))
const PublishView = lazy(() => import('./publish/PublishView').then((m) => ({ default: m.PublishView })))

type Overlay = 'record' | 'review' | 'publish' | null

/** 手順の名前（知らない手順はそのまま出す） */
export function stepLabel(t: TFunction, step: string): string {
  const key = `video.step.${step}`
  return key in tabEn ? t(key as keyof typeof tabEn) : step
}

const STEP_ICON: Record<VideoStep['state'], React.ReactNode> = {
  done: <Check size={12} aria-hidden="true" />,
  skipped: <Minus size={12} aria-hidden="true" />,
  running: <LoaderCircle size={12} aria-hidden="true" />,
  'needs-human': <CircleAlert size={12} aria-hidden="true" />,
  todo: <Circle size={10} aria-hidden="true" />
}

/** 動画1本の画面（担当: 動画タブ）。進み具合と、撮る・完成させて・確認・投稿・フォルダを開く */
export function VideoDetail({ name, reviewRecording, onBack }: { name: string; reviewRecording: boolean; onBack: () => void }) {
  const t = useT()
  const toast = useToast()
  const [detail, setDetail] = useState<VideoDetailData | null>(null)
  const [saved, setSaved] = useState<SavedFeedback[]>([])
  const [error, setError] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [sending, setSending] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.ade.invoke('video:detail', name).then((d) => { setDetail(d); setError(null) }, (err: unknown) => setError(errorMessage(err)))
    void window.ade.invoke('video:review:open', name).then((r) => setSaved(r.saved), () => undefined)
  }, [name])

  useEffect(load, [load])

  // Agent が手順を進めた・書き出した・指摘を対応済みにしたら読み直す（まとめて1回）
  useEffect(() => {
    let timer: number | undefined
    const later = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 600)
    }
    const prefix = `${name}/`
    const offFs = subscribeIpc('fs:changed', (event) => {
      if (event.paths.some((p) => p.replace(/\\/g, '/').startsWith(prefix) && !p.includes('/media/takes/'))) later()
    }, 'video')
    const offReview = subscribeIpc('video:review:changed', later, 'video')
    return () => {
      window.clearTimeout(timer)
      offFs()
      offReview()
    }
  }, [name, load])

  const send = async (key: string, text: () => Promise<string>) => {
    setSending(key)
    try {
      const r = await sendVideoPrompt(await text(), (agent) => toast({ tone: 'info', message: t('video.detail.starting', { agent }) }))
      toast(r.ok ? { tone: 'success', message: t('video.detail.sent') } : { tone: 'warning', message: r.message })
    } catch (err) {
      toast({ tone: 'warning', message: errorMessage(err) })
    } finally {
      setSending(null)
    }
  }

  const openFolder = () => void window.ade.invoke('video:openFolder', name).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))

  const entry = detail?.entry
  const title = entry?.title ?? name
  const videoDir = entry?.dir ?? ''

  if (overlay === 'review') {
    return <ReviewView name={name} reviewRecording={reviewRecording} onClose={() => { setOverlay(null); load() }} onSaved={load} />
  }

  if (overlay === 'record' && videoDir) {
    return <Suspense fallback={null}>
      <RecordView videoDir={videoDir} videoTitle={title} onClose={() => { setOverlay(null); load() }} onRecorded={() => load()} />
    </Suspense>
  }
  if (overlay === 'publish' && videoDir) {
    return <Suspense fallback={null}>
      <PublishView videoDir={videoDir} videoTitle={title} onClose={() => { setOverlay(null); load() }} />
    </Suspense>
  }

  const steps = detail?.steps ?? []
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length
  const legacy = entry?.legacy === true

  return (
    <div className="video-detail" data-testid="video-detail">
      <header className="video-detail__head">
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack} data-testid="video-back">{t('video.back')}</Button>
      </header>
      <div className="video-detail__title">
        <div>
          <h2>{title}</h2>
          <span className="video-list__dir">{name}</span>
        </div>
        {entry && (legacy ? <Badge tone="warning">{t('video.legacy')}</Badge> : <Badge tone={STATUS_TONE[entry.status]}>{t(`video.status.${entry.status}`)}</Badge>)}
        <span className="video-review__spacer" />
        <Tooltip label={t('video.detail.openFolder')}>
          <IconButton label={t('video.detail.openFolder')} icon={<FolderOpen size={15} />} onClick={openFolder} data-testid="video-open-folder" />
        </Tooltip>
      </div>

      {error && <ErrorNote message={t('video.detail.loadError')} detail={error} />}
      {legacy && <p className="video-note video-note--warn" role="status">{t('video.detail.legacy')} <code>{VIDEO_CLI} migrate</code></p>}

      <div className="video-detail__actions">
        <ActionCard icon={<Video size={16} />} label={t('video.detail.record')} disabled={legacy || reviewRecording} hint={reviewRecording ? t('video.detail.recordBusy') : undefined}
          onClick={() => setOverlay('record')} testId="video-action-record" tone="record" />
        <ActionCard icon={<Sparkles size={16} />} label={t('video.detail.finish')} hint={t('video.detail.finishHint')} disabled={legacy} busy={sending === 'finish'} primary
          onClick={() => void send('finish', () => window.ade.invoke('video:finishPrompt', name))} testId="video-action-finish" />
        <ActionCard icon={<Eye size={16} />} label={t('video.detail.review')} hint={detail?.render ? t('video.detail.reviewHint') : t('video.detail.noRender')} disabled={legacy || !detail?.render}
          onClick={() => setOverlay('review')} testId="video-action-review" />
        <ActionCard icon={<Send size={16} />} label={t('video.detail.publish')} disabled={legacy || !detail?.render}
          hint={detail?.render ? undefined : t('video.detail.noRender')} onClick={() => setOverlay('publish')} testId="video-action-publish" />
      </div>

      <Card title={t('video.detail.progress')} className="video-detail__card">
        {!detail ? <p className="video-note" role="status"><Spinner size={12} /> {t('video.detail.loading')}</p> : <>
          {steps.length > 0 ? <>
            <Progress value={progressOf(steps)} label={t('video.detail.stepsDone', { done, total: steps.length })} />
            <ol className="video-steps" data-testid="video-steps">
              {steps.map((s) => (
                <li key={s.step} className={`video-step video-step--${s.state}`} title={s.note ?? t(`video.stepState.${s.state}`)}>
                  {STEP_ICON[s.state]}
                  <span>{stepLabel(t, s.step)}</span>
                </li>
              ))}
            </ol>
          </> : <p className="video-note">{t('video.detail.noSteps')}</p>}
          {detail.next && detail.next.step !== 'done' && (
            <div className="video-next">
              <span className="video-next__label">{t('video.detail.next')}</span>
              <strong>{stepLabel(t, detail.next.step)}</strong>
              {detail.next.why && <span className="video-next__why">{detail.next.why}</span>}
            </div>
          )}
          {detail.error && detail.error !== 'legacy' && <ErrorNote message={t('video.detail.statusError')} detail={detail.error} />}
        </>}
      </Card>

      <Card title={t('video.detail.feedback')} className="video-detail__card">
        {saved.length === 0 ? <p className="video-note">{t('video.detail.feedbackEmpty')}</p> : (
          <ul className="video-feedback" data-testid="video-feedback">
            {saved.map((f) => (
              <li key={f.id} className="video-feedback__row">
                <Clapperboard size={14} aria-hidden="true" />
                <code>{f.id}</code>
                <span className="video-note">{t('video.detail.feedbackItems', { count: f.count })}</span>
                <Badge tone={f.status === 'done' ? 'success' : 'neutral'}>{t(f.status === 'done' ? 'video.detail.feedbackDone' : 'video.detail.feedbackOpen')}</Badge>
                <span className="video-review__spacer" />
                {f.status === 'open' && <Button busy={sending === f.id} onClick={() => void send(f.id, () => window.ade.invoke('video:review:prompt', name, f.id))}>{t('video.detail.askFix')}</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>

    </div>
  )
}

/** 利用者向けの短い文。CLI の詳細（パス入りの英語）は開いたときだけ出す */
function ErrorNote({ message, detail }: { message: string; detail: string }) {
  const t = useT()
  return (
    <div className="video-note video-note--warn video-error" role="alert">
      <span>{message}</span>
      <details className="video-error__details">
        <summary>{t('video.detail.errorDetails')}</summary>
        <code>{detail}</code>
      </details>
    </div>
  )
}

function ActionCard({ icon, label, hint, onClick, disabled, busy, primary, tone, testId }: {
  icon: React.ReactNode
  label: string
  hint?: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  primary?: boolean
  tone?: 'record'
  testId: string
}) {
  return (
    <div className={`video-action${primary ? ' video-action--primary' : ''}`}>
      <Button variant={primary ? 'primary' : tone === 'record' ? 'record' : 'default'} icon={icon} disabled={disabled} busy={busy} onClick={onClick} data-testid={testId}>
        {label}
      </Button>
      {hint && <span className="video-action__hint">{hint}</span>}
    </div>
  )
}
