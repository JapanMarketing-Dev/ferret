import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Eraser, Mic, Pause, PenLine, Play, Save, Send, Square, Trash2, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { Badge, Button, EmptyState, IconButton, RecordDot, Segmented, Spinner, useToast } from '@/ui'
import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR } from '@shared/annotation'
import { paintShape, preparePenContext } from '@shared/annotationPaint'
import type { Shape } from '@shared/annotationShapes'
import { projectMediaUrl } from '@shared/fileViewer'
import {
  boxPoints, buildReviewItems, contentRect, frameAtTime, frameToSeconds, normalizePoint, simplifyStroke, splitRemarks, timecode,
  type Rect, type ReviewItem, type ReviewSession, type ReviewStroke
} from '../../shared/review'
import type { ReviewTarget } from '../../shared/ipc/review'
import { sendVideoPrompt } from '../agentSend'
import { startMicCapture, type MicCapture } from './micCapture'

type Tool = 'pen' | 'rect'
type Phase = 'idle' | 'recording' | 'transcribing' | 'confirm' | 'saving'

/** 画面に描く形（動画の絵に対して 0..1） */
type Mark = { kind: 'pen'; points: [number, number][] } | { kind: 'rect'; box: Rect }

const PEN_COLOR = DEFAULT_ANNOTATION_COLOR
const PEN_HEX = ANNOTATION_COLORS[PEN_COLOR]

interface Props {
  name: string
  reviewRecording: boolean
  onClose: () => void
  /** 保存した（一覧の指摘を読み直す） */
  onSaved: () => void
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** 動画を frame へ動かし、絵が出るまで待つ */
async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  video.pause()
  if (Math.abs(video.currentTime - seconds) < 0.001) return
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = seconds
    // 動かせない（読み込み前）ときに止まり続けない
    window.setTimeout(done, 3000)
  })
}

/**
 * 完成動画の確認（担当: 動画タブ）。再生・停止しながらマイクで話し、動画の上にペンで囲むと、
 * 話の区切りごとにタイムコード付きの指摘になる。確かめてから feedback/<id>/ に保存し、Agent に直してもらう
 */
export function ReviewView({ name, reviewRecording, onClose, onSaved }: Props) {
  const t = useT()
  const toast = useToast()
  const [target, setTarget] = useState<ReviewTarget | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [tool, setTool] = useState<Tool>('pen')
  const [elapsed, setElapsed] = useState(0)
  const [items, setItems] = useState<ReviewItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const marks = useRef<Mark[]>([])
  const drawing = useRef<{ start: [number, number]; points: [number, number][]; atMs: number } | null>(null)
  const session = useRef<{ startMs: number; data: Pick<ReviewSession, 'playback' | 'strokes' | 'notes'>; mic: MicCapture | null; id?: string; audioStartMs: number } | null>(null)
  const feedbackId = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.ade.invoke('video:review:open', name).then(
      (r) => { if (alive) setTarget(r) },
      (err: unknown) => { if (alive) setLoadError(errorMessage(err)) }
    )
    return () => { alive = false }
  }, [name])

  const fps = target?.fps ?? { num: 30, den: 1 }
  const now = () => (session.current ? performance.now() - session.current.startMs : 0)
  const frameNow = () => frameAtTime(video.current?.currentTime ?? 0, fps)

  const pictureRect = useCallback((): Rect => {
    const c = canvas.current
    const v = video.current
    if (!c || !v) return { x: 0, y: 0, w: 1, h: 1 }
    return contentRect(c.clientWidth, c.clientHeight, v.videoWidth, v.videoHeight)
  }, [])

  const redraw = useCallback(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(c.clientWidth * dpr)
    const h = Math.round(c.clientHeight * dpr)
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, c.clientWidth, c.clientHeight)
    preparePenContext(g)
    const r = pictureRect()
    const X = (x: number) => r.x + x * r.w
    const Y = (y: number) => r.y + y * r.h
    const all = [...marks.current]
    const d = drawing.current
    if (d && tool === 'pen') all.push({ kind: 'pen', points: d.points })
    if (d && tool === 'rect' && d.points.length) {
      const [a, b] = [d.start, d.points[d.points.length - 1]!]
      all.push({ kind: 'rect', box: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) } })
    }
    all.forEach((m, i) => {
      const shape: Shape = m.kind === 'pen'
        ? { key: i, id: String(i), color: PEN_COLOR, kind: 'pen', points: m.points.map(([x, y]) => [X(x), Y(y)] as [number, number]) }
        : { key: i, id: String(i), color: PEN_COLOR, kind: 'rect', rect: [X(m.box.x), Y(m.box.y), m.box.w * r.w, m.box.h * r.h] }
      paintShape(g, shape)
    })
  }, [pictureRect, tool])

  const showStrokes = useCallback((strokes: readonly ReviewStroke[]) => {
    marks.current = strokes.map((s) => ({ kind: 'pen', points: s.points }))
    redraw()
  }, [redraw])

  // 再生・停止・移動を記録する。囲みはそのフレームのものなので、動かしたら消す
  useEffect(() => {
    const v = video.current
    if (!v || phase !== 'recording') return
    const push = (state?: 'playing' | 'paused') => {
      session.current?.data.playback.push({ atMs: Math.round(now()), state: state ?? (v.paused ? 'paused' : 'playing'), frame: frameNow() })
    }
    const clear = () => {
      marks.current = []
      redraw()
    }
    const onPlay = () => { push('playing'); clear() }
    const onPause = () => push('paused')
    const onSeeked = () => { push(); clear() }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeked', onSeeked)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeked', onSeeked)
    }
  }, [phase, redraw, fps.num, fps.den])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(c)
    return () => ro.disconnect()
  }, [redraw, target])

  useEffect(() => {
    if (phase !== 'recording') return
    const id = window.setInterval(() => setElapsed(now()), 250)
    return () => window.clearInterval(id)
  }, [phase])

  // 閉じたらマイクを離す
  useEffect(() => () => {
    void session.current?.mic?.stop()
    session.current = null
  }, [])

  const start = async () => {
    setNotice(null)
    let mic: MicCapture | null = null
    if (!reviewRecording) {
      try {
        mic = await startMicCapture()
      } catch (err) {
        setNotice(t('video.review.micFailed', { error: errorMessage(err) }))
      }
    }
    session.current = { startMs: performance.now(), data: { playback: [], strokes: [], notes: [] }, mic, audioStartMs: 0 }
    session.current.data.playback.push({ atMs: 0, state: video.current && !video.current.paused ? 'playing' : 'paused', frame: frameNow() })
    marks.current = []
    redraw()
    setElapsed(0)
    setPhase('recording')
  }

  const stop = async () => {
    const s = session.current
    if (!s) return
    setPhase('transcribing')
    video.current?.pause()
    const wav = s.mic ? await s.mic.stop() : null
    const first = s.mic?.firstSampleAt()
    s.audioStartMs = first !== undefined ? Math.max(0, Math.round(first - s.startMs)) : 0
    s.mic = null
    marks.current = []
    redraw()
    try {
      const r = await window.ade.invoke('video:review:transcribe', name, wav)
      feedbackId.current = r.id
      if (r.warning && wav) setNotice(t('video.review.noSpeech', { reason: r.warning }))
      const remarks = splitRemarks(r.pieces, s.audioStartMs, target?.lang ?? 'ja')
      setItems(buildReviewItems(s.data, remarks, fps, target?.durationFrames || undefined))
      setPhase('confirm')
    } catch (err) {
      toast({ tone: 'danger', message: t('video.review.saveFailed', { error: errorMessage(err) }) })
      setPhase('idle')
      session.current = null
    }
  }

  const discard = () => {
    const id = feedbackId.current
    if (id) void window.ade.invoke('video:review:discard', name, id).catch(() => undefined)
    feedbackId.current = null
    session.current = null
    setItems([])
    marks.current = []
    redraw()
    setPhase('idle')
  }

  const save = async (fix: boolean) => {
    const s = session.current
    const id = feedbackId.current
    const v = video.current
    const c = canvas.current
    if (!s || !id || !v || !c || !items.length) return
    setPhase('saving')
    try {
      const numbered = items.map((it, i) => ({ ...it, index: i + 1 }))
      // 指摘ごとに、そのフレームへ動かして囲みを描き、画面を写す（ペン入りの画像）
      for (const it of numbered) {
        await seekTo(v, frameToSeconds(it.frame + 0.5, fps))
        showStrokes(it.strokes)
        await nextFrame()
        await nextFrame()
        const box = c.getBoundingClientRect()
        const r = pictureRect()
        await window.ade.invoke('video:review:snapshot', name, id, it.index, { x: box.left + r.x, y: box.top + r.y, width: r.w, height: r.h }).catch(() => false)
      }
      const body: ReviewSession = { schema: 1, createdAt: new Date(performance.timeOrigin + s.startMs).toISOString(), audioStartMs: s.audioStartMs, ...s.data }
      const r = await window.ade.invoke('video:review:save', name, { id, session: body, items: numbered })
      feedbackId.current = null
      session.current = null
      setItems([])
      marks.current = []
      redraw()
      setPhase('idle')
      toast({ tone: 'success', message: t('video.review.saved', { count: r.count }), detail: r.path })
      if (r.warnings.length) toast({ tone: 'warning', message: t('video.review.registerWarning', { error: r.warnings[0]! }) })
      onSaved()
      if (fix) {
        const sent = await sendVideoPrompt(r.prompt, (agent) => toast({ tone: 'info', message: t('video.detail.starting', { agent }) }))
        toast(sent.ok ? { tone: 'success', message: t('video.detail.sent') } : { tone: 'warning', message: sent.message })
      }
    } catch (err) {
      toast({ tone: 'danger', message: t('video.review.saveFailed', { error: errorMessage(err) }) })
      setPhase('confirm')
    }
  }

  const pos = (e: React.PointerEvent): [number, number] => {
    const b = canvas.current!.getBoundingClientRect()
    return normalizePoint(e.clientX - b.left, e.clientY - b.top, pictureRect())
  }
  const down = (e: React.PointerEvent) => {
    if (phase !== 'recording') return
    video.current?.pause()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const p = pos(e)
    drawing.current = { start: p, points: [p], atMs: now() }
  }
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return
    drawing.current.points.push(pos(e))
    redraw()
  }
  const up = () => {
    const d = drawing.current
    drawing.current = null
    const s = session.current
    if (!d || !s) return
    const stroke = (points: [number, number][]) =>
      s.data.strokes.push({ id: `s${s.data.strokes.length + 1}`, startMs: Math.round(d.atMs), endMs: Math.round(now()), frame: frameNow(), color: PEN_HEX, width: 0.005, points })
    if (tool === 'pen' && d.points.length > 1) {
      const points = simplifyStroke(d.points)
      marks.current.push({ kind: 'pen', points })
      stroke(points)
    } else if (tool === 'rect') {
      const [a, b] = [d.start, d.points[d.points.length - 1]!]
      const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) }
      if (box.w > 0.005 && box.h > 0.005) {
        marks.current.push({ kind: 'rect', box })
        stroke(boxPoints(box))
      }
    }
    redraw()
  }

  const clearMarks = () => {
    marks.current = []
    redraw()
  }

  const seekItem = (it: ReviewItem) => {
    const v = video.current
    if (!v) return
    void seekTo(v, frameToSeconds(it.frame + 0.5, fps)).then(() => showStrokes(it.strokes))
  }

  const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
  const closing = () => {
    if (phase === 'recording' || phase === 'confirm') discard()
    onClose()
  }

  const head = (
    <header className="video-review__head">
      <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={closing} disabled={phase === 'saving' || phase === 'transcribing'} data-testid="video-review-back">
        {target?.title ?? name}
      </Button>
      <span className="video-review__title">{t('video.review.title')}</span>
    </header>
  )

  if (loadError) return <div className="video-review">{head}<p className="video-note video-note--warn" role="alert">{loadError}</p></div>
  if (!target) return <div className="video-review">{head}<p className="video-note" role="status"><Spinner size={12} /> {t('video.detail.loading')}</p></div>
  if (!target.render) {
    return <div className="video-review">{head}
      <EmptyState title={t('video.review.noVideoTitle')} description={t('video.review.noVideoBody')} testId="video-review-empty" />
    </div>
  }

  const drawingOn = phase === 'recording'
  return (
    <div className="video-review" data-testid="video-review">
      {head}
      <div className="video-review__body">
        <div className="video-review__stage">
          <div className="video-review__player">
            <video ref={video} className="video-review__video" src={projectMediaUrl(target.render)} controls={phase !== 'saving'} preload="auto"
              onLoadedMetadata={() => redraw()} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} data-testid="video-review-player" />
            <canvas ref={canvas} className={`video-review__canvas${drawingOn ? ' is-drawing' : ''}`} aria-hidden="true"
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          </div>
          <div className={`video-review__bar${drawingOn ? ' is-active' : ''}`}>
            {phase === 'idle' && <>
              <Button variant="primary" icon={<Mic size={14} />} onClick={() => void start()} data-testid="video-review-start">{t('video.review.start')}</Button>
              <span className="video-note">{reviewRecording ? t('video.review.busyReview') : t('video.review.startHint')}</span>
            </>}
            {phase === 'recording' && <>
              <span className="video-review__rec" role="status">
                <RecordDot active={!!session.current?.mic} size={7} />
                <span>{session.current?.mic ? t('video.review.listening') : t('video.review.pen')}</span>
                <span className="video-review__time">{mmss(elapsed)}</span>
              </span>
              <IconButton label={playing ? t('video.review.pause') : t('video.review.play')} icon={playing ? <Pause size={15} /> : <Play size={15} />}
                onClick={() => { const v = video.current; if (v) void (v.paused ? v.play().catch(() => undefined) : v.pause()) }} data-testid="video-review-play" />
              <Segmented ariaLabel={t('video.review.pen')} value={tool} onChange={setTool} options={[
                { value: 'pen', label: t('video.review.pen'), icon: <PenLine size={14} /> },
                { value: 'rect', label: t('video.review.rect'), icon: <Square size={14} /> }
              ]} />
              <Button variant="ghost" icon={<Eraser size={14} />} onClick={clearMarks}>{t('video.review.clear')}</Button>
              <span className="video-review__spacer" />
              <Button variant="record" selected icon={<Square size={11} fill="currentColor" />} onClick={() => void stop()} data-testid="video-review-stop">{t('video.review.stop')}</Button>
            </>}
            {phase === 'transcribing' && <span className="video-note" role="status"><Spinner size={12} /> {t('video.review.transcribing')}</span>}
            {phase === 'saving' && <span className="video-note" role="status"><Spinner size={12} /> {t('video.review.saving')}</span>}
            {phase === 'confirm' && <span className="video-note">{t('video.review.itemsHelp')}</span>}
          </div>
          {notice && <p className="video-note video-note--warn" role="alert">{notice}</p>}
        </div>

        {(phase === 'confirm' || phase === 'saving') && (
          <aside className="video-review__items" aria-label={t('video.review.itemsTitle', { count: items.length })} data-testid="video-review-items">
            <div className="video-review__items-head">
              <h3>{t('video.review.itemsTitle', { count: items.length })}</h3>
              <IconButton label={t('video.review.discard')} icon={<X size={15} />} onClick={discard} disabled={phase === 'saving'} />
            </div>
            {items.length === 0 && <p className="video-note">{t('video.review.noItems')}</p>}
            <ol className="video-review__list">
              {items.map((it, i) => (
                <li key={`${it.atMs}-${i}`} className="video-item">
                  <div className="video-item__top">
                    <button type="button" className="video-item__tc" onClick={() => seekItem(it)} title={t('video.review.seek', { time: timecode(it.frame, fps) })}>
                      {i + 1}. {timecode(it.frame, fps)}
                    </button>
                    {it.strokes.length > 0 && <Badge tone="neutral" icon={<PenLine size={11} />}>{t('video.review.withPen')}</Badge>}
                    <span className="video-review__spacer" />
                    <IconButton size="sm" label={t('video.review.deleteItem')} icon={<Trash2 size={13} />} disabled={phase === 'saving'}
                      onClick={() => setItems((xs) => xs.filter((_, k) => k !== i))} />
                  </div>
                  {it.speech
                    ? <p className="video-item__said"><span>{t('video.review.spoken')}</span>「{it.speech}」</p>
                    : !it.notes.length && <p className="video-item__said is-muted">{t('video.review.penOnly')}</p>}
                  {it.notes.map((n, k) => <p key={k} className="video-item__said"><span>{t('video.review.notes')}</span>{n}</p>)}
                  <label className="video-item__req">
                    <span>{t('video.review.request')}</span>
                    <textarea rows={2} value={it.request ?? ''} placeholder={t('video.review.requestPlaceholder')} disabled={phase === 'saving'}
                      onChange={(e) => { const request = e.target.value; setItems((xs) => xs.map((x, k) => (k === i ? { ...x, request } : x))) }} />
                  </label>
                </li>
              ))}
            </ol>
            <div className="video-review__items-foot">
              <Button variant="ghost" icon={<Trash2 size={14} />} onClick={discard} disabled={phase === 'saving'}>{t('video.review.discard')}</Button>
              <span className="video-review__spacer" />
              <Button icon={<Save size={14} />} onClick={() => void save(false)} disabled={!items.length || phase === 'saving'} data-testid="video-review-save">{t('video.review.saveOnly')}</Button>
              <Button variant="primary" icon={<Send size={14} />} busy={phase === 'saving'} onClick={() => void save(true)} disabled={!items.length} data-testid="video-review-save-fix">
                {t('video.review.saveAndFix')}
              </Button>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
