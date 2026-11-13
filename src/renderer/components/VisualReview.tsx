import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowRight, Check, Copy, MessageSquare, Mic, Square, Trash2, X } from 'lucide-react'
import {
  canRespond,
  clampBox,
  type PlanBox,
  type PlanListing,
  type PlanStatus,
  type RecordingNote,
  type VisualPlan,
  type VisualPlanReply
} from '@shared/visualReview'
import type { PendingRecordingFeedback } from '@shared/visualReviewRecording'
import type { LiveTranscriptSegment, LiveTranscriptStatus } from '@shared/liveTranscript'
import { Badge, Button, EmptyState, IconButton, RecordDot, Spinner, useToast, type BadgeTone } from '../ui'
import { LiveTranscriptPanel } from './LiveTranscriptPanel'
import { useT } from '../lib/i18n'
import '../styles/visualReview.css'

/**
 * 中央の「ビジュアルレビュー」タブ。Agent が作る前に書いた計画（.ferret/visual-review/<id>.json）を、
 * 今の画面の上の番号付きの枠と、変更の一覧（前 → 後）で見せる。
 * 「これで作って」（承認）・「フィードバック」（文と、画像の上で囲んだ場所）は、計画を書いた Agent のターミナルへ送る（main）。
 * 送れなかったら、ターミナルへ貼れる文を出す。
 */

export type FeedbackBox = PlanBox & { screen: number; note: string }
export type Manual = { id: string; message: string; copyText: string }

/**
 * 声と書き込みのフィードバック（App のいつもの録画。@shared/visualReviewRecording）。
 * 押すと App が画面全体の録画を始め、このタブを見せたまま話して画像の上を囲む。止めると App が計画に添えて送る
 */
export interface PlanRecordingControls {
  pending: PendingRecordingFeedback | null
  /** 録画中・開始や停止の途中（ほかの録画を含む） */
  busy: boolean
  live: { status: LiveTranscriptStatus; segments: readonly LiveTranscriptSegment[] }
  onStart: (plan: VisualPlan, note: RecordingNote) => void
  /** 録画中に打った文・囲み（止めたときの最新を送る） */
  onNote: (planId: string, note: RecordingNote) => void
  onStop: () => void
}

export const STATUS_TONE: Record<PlanStatus, BadgeTone> = {
  proposed: 'warning',
  approved: 'success',
  'changes-requested': 'neutral',
  done: 'brand'
}

export function VisualReview({ listing, onChanged, recording }: {
  listing: PlanListing
  /** 返事のあとに一覧を読み直す */
  onChanged: () => void
  recording?: PlanRecordingControls
}) {
  const t = useT()
  const { plans, invalid } = listing
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 送れなかったときの貼る文。返事で計画の状態が変わって詳細を作り直しても消えないよう、ここで持つ
  const [manual, setManual] = useState<Manual | null>(null)
  // 選んでいたものが消えたら（または未選択なら）、いちばん新しい計画を選ぶ。声と書き込みで返している間はその計画を見せる
  const recordingId = recording?.pending?.planId
  const selected = plans.find((plan) => plan.id === (recordingId ?? selectedId)) ?? plans.find((plan) => plan.id === selectedId) ?? plans[0] ?? null

  if (plans.length === 0) {
    return (
      <div className="vr vr--empty" data-testid="visual-review">
        <EmptyState
          title={t('visualReview.empty.title')}
          description={t('visualReview.empty.description')}
          testId="visual-review-empty"
        />
        {invalid.length > 0 && <InvalidPlans invalid={invalid} />}
      </div>
    )
  }

  return (
    <div className="vr" data-testid="visual-review">
      <nav className="vr__list" aria-label={t('visualReview.listLabel')}>
        {plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            className="vr__item"
            aria-current={plan.id === selected?.id ? 'true' : undefined}
            onClick={() => setSelectedId(plan.id)}
            data-testid="visual-review-item"
          >
            <span className="vr__item-title">{plan.title}</span>
            <span className="vr__item-meta">
              <Badge tone={STATUS_TONE[plan.status]}>{t(`visualReview.status.${plan.status}`)}</Badge>
              <span>{t('visualReview.revision', { n: plan.revision })}</span>
              {plan.createdAt && <span>{formatTime(plan.createdAt)}</span>}
            </span>
          </button>
        ))}
        {invalid.length > 0 && <InvalidPlans invalid={invalid} />}
      </nav>
      {selected && (
        <PlanDetail
          key={`${selected.id}:${selected.revision}:${selected.status}`}
          plan={selected}
          onChanged={onChanged}
          manual={manual?.id === selected.id ? manual : null}
          onManual={setManual}
          recording={recording}
        />
      )}
    </div>
  )
}

export function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function InvalidPlans({ invalid, title }: { invalid: PlanListing['invalid']; title?: string }) {
  const t = useT()
  return (
    <div className="vr__invalid" data-testid="visual-review-invalid">
      <div className="vr__invalid-title">{title ?? t('visualReview.invalid')}</div>
      {invalid.map((item) => <div key={item.file} className="vr__invalid-row"><code>{item.file}</code> {item.reason}</div>)}
    </div>
  )
}

/** 計画の画像（main から data URL で）。版が変われば読み直す */
function usePlanImages(plan: VisualPlan): Record<string, string | null> {
  return useDocImages(plan.id, plan.revision, plan.screens.map((screen) => screen.image))
}

/** 文書（計画・価値ユースケース）の画像を main から data URL で読む。画像の並びと版が同じなら読み直さない（ちらつかせない） */
export function useDocImages(id: string, revision: number, rels: readonly string[]): Record<string, string | null> {
  const [images, setImages] = useState<Record<string, string | null>>({})
  const key = `${id}:${revision}:${rels.join('|')}`
  useEffect(() => {
    let alive = true
    setImages({})
    for (const rel of new Set(rels)) {
      void window.ade.invoke('visualReview:image', rel).then((url) => {
        if (alive) setImages((current) => ({ ...current, [rel]: url }))
      }).catch(() => { if (alive) setImages((current) => ({ ...current, [rel]: null })) })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key に rels を含む
  }, [key])
  return images
}

function PlanDetail({ plan, onChanged, manual, onManual, recording }: {
  plan: VisualPlan
  onChanged: () => void
  manual: Manual | null
  onManual: (manual: Manual | null) => void
  recording?: PlanRecordingControls
}) {
  const t = useT()
  const toast = useToast()
  const images = usePlanImages(plan)
  // この計画を声と書き込みで返している（録画中・まとめている途中）
  const mine = recording?.pending?.planId === plan.id ? recording.pending : null
  const recordingHere = mine?.phase === 'recording'
  const processingHere = mine?.phase === 'processing'
  // 録画中にタブを離れて戻ってきたら、控えてある文・囲みから描き直す
  const [modeState, setMode] = useState<'view' | 'feedback'>(recordingHere ? 'feedback' : 'view')
  const mode = recordingHere ? 'feedback' : modeState
  const [text, setText] = useState(() => (recordingHere ? mine.note.text ?? '' : ''))
  const [boxes, setBoxes] = useState<FeedbackBox[]>(() => (recordingHere ? (mine.note.boxes ?? []).map((box) => ({ ...box, note: box.note ?? '' })) : []))
  const [busy, setBusy] = useState(false)
  const pending = canRespond(plan)

  const currentNote = (): RecordingNote => {
    const trimmed = text.trim()
    return {
      ...(trimmed ? { text: trimmed } : {}),
      ...(boxes.length ? { boxes: boxes.map(({ note, ...box }) => ({ ...box, ...(note.trim() ? { note: note.trim() } : {}) })) } : {})
    }
  }
  // 録画中に打った文・囲みは、その都度 App へ控える（止めたときの最新を送る）
  const onNote = recording?.onNote
  useEffect(() => {
    if (recordingHere) onNote?.(plan.id, currentNote())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 文・囲みが変わったときだけ
  }, [recordingHere, text, boxes])

  // 番号は画面をまたいで通しにする（一覧と画像の上の数字を合わせる）
  const numbered = useMemo(() => {
    let n = 0
    return plan.screens.map((screen) => screen.annotations.map((annotation) => ({ ...annotation, n: ++n })))
  }, [plan])

  const respond = async (reply: VisualPlanReply): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.ade.invoke('visualReview:respond', plan.id, reply)
      if (result.sent) toast({ tone: 'success', message: result.message })
      else if (result.copyText) onManual({ id: plan.id, message: result.message, copyText: result.copyText })
      setMode('view')
      onChanged()
    } catch (err) {
      toast({ tone: 'danger', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const sendFeedback = (): void => {
    const note = currentNote()
    if (!note.text && !note.boxes) return
    void respond({ action: 'feedback', ...note })
  }

  /** 声と書き込みで返す。録画を始め、計画は見せたまま（囲めるようにフィードバックの形にする） */
  const startRecording = (): void => {
    setMode('feedback')
    recording?.onStart(plan, currentNote())
  }

  return (
    <article className="vr__detail" data-testid="visual-review-detail">
      <header className="vr__head">
        <div className="vr__head-row">
          <h2 className="vr__title">{plan.title}</h2>
          <Badge tone={STATUS_TONE[plan.status]}>{t(`visualReview.status.${plan.status}`)}</Badge>
          <span className="vr__muted">{t('visualReview.revision', { n: plan.revision })}</span>
        </div>
        {plan.request && <blockquote className="vr__request"><span className="vr__muted">{t('visualReview.request')}</span> {plan.request}</blockquote>}
      </header>

      {manual && <ManualCopy manual={manual} onClose={() => onManual(null)} />}

      {plan.screens.map((screen, index) => (
        <section key={`${index}:${screen.image}`} className="vr__screen">
          <div className="vr__screen-head">
            <span className="vr__screen-no">{t('visualReview.screen', { n: index + 1 })}</span>
            {screen.caption && <span>{screen.caption}</span>}
            {screen.url && <span className="vr__muted vr__url" title={screen.url}>{screen.url}</span>}
          </div>
          <Shot
            src={images[screen.image]}
            annotations={numbered[index] ?? []}
            drawing={mode === 'feedback'}
            boxes={boxes.map((box, i) => ({ ...box, i })).filter((box) => box.screen === index)}
            onDraw={(box) => setBoxes((current) => [...current, { ...box, screen: index, note: '' }])}
          />
        </section>
      ))}

      {numbered.some((list) => list.length > 0) && (
        <section className="vr__section">
          <h3>{t('visualReview.changes')}</h3>
          <ol className="vr__changes">
            {numbered.flat().map((item) => (
              <li key={item.n} className={`vr__change vr-kind--${item.kind}`}>
                <span className="vr__num">{item.n}</span>
                <div>
                  <div className="vr__change-label"><span className="vr__kind">{t(`visualReview.kind.${item.kind}`)}</span> {item.label}</div>
                  <BeforeAfter before={item.before} after={item.after} />
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {plan.behaviour.length > 0 && (
        <section className="vr__section">
          <h3>{t('visualReview.behaviour')}</h3>
          <ul className="vr__plain">
            {plan.behaviour.map((item, i) => <li key={i}><BeforeAfter before={item.before} after={item.after} /></li>)}
          </ul>
        </section>
      )}

      {plan.outOfScope.length > 0 && (
        <section className="vr__section">
          <h3>{t('visualReview.outOfScope')}</h3>
          <ul className="vr__plain">{plan.outOfScope.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </section>
      )}

      {plan.questions.length > 0 && (
        <section className="vr__section vr__questions">
          <h3>{t('visualReview.questions')}</h3>
          <ul className="vr__plain">{plan.questions.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </section>
      )}

      {plan.responses.length > 0 && (
        <section className="vr__section">
          <h3>{t('visualReview.history')}</h3>
          <ul className="vr__plain vr__muted">
            {plan.responses.map((response, i) => (
              <li key={i}>
                {formatTime(response.at)} · {t('visualReview.revision', { n: response.revision })} · {t(response.action === 'approve' ? 'visualReview.approved' : response.kind === 'recording' ? 'visualReview.recordedFeedback' : 'visualReview.feedbackSent')}
                {response.text ? `: ${response.text}` : ''}
                {response.review && <> · {t('visualReview.recordedFindings', { count: response.review.findings.length })} · <code>{response.review.dir}</code></>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {pending && (
        <footer className="vr__actions" data-testid="visual-review-actions">
          {processingHere ? (
            <div className="vr__row vr__recording-state" role="status" data-testid="visual-review-processing"><Spinner size={14} />{t('visualReview.recording.processing')}</div>
          ) : mode === 'view' ? (
            <div className="vr__row">
              {canRespond(plan, 'approve') && <Button variant="primary" icon={<Check size={14} />} busy={busy} onClick={() => void respond({ action: 'approve' })} data-testid="visual-review-approve">{t('visualReview.approve')}</Button>}
              <Button icon={<MessageSquare size={14} />} disabled={busy} onClick={() => setMode('feedback')} data-testid="visual-review-feedback">{t('visualReview.feedback')}</Button>
              {recording && <Button icon={<Mic size={14} />} disabled={busy || recording.busy || !!recording.pending} title={t('visualReview.recordFeedbackTip')} onClick={startRecording} data-testid="visual-review-record">{t('visualReview.recordFeedback')}</Button>}
            </div>
          ) : (
            <div className="vr__feedback">
              {recordingHere && recording && (
                <div className="vr__recording" data-testid="visual-review-recording">
                  <div className="vr__row vr__recording-state" role="status"><RecordDot active />{t('visualReview.recording.active')}</div>
                  <div className="vr__live">
                    <LiveTranscriptPanel status={recording.live.status} segments={recording.live.segments} head={<span className="vr__live-head">{t('visualReview.recording.transcript')}</span>} />
                  </div>
                </div>
              )}
              <textarea
                className="vr__textarea"
                value={text}
                autoFocus
                placeholder={t('visualReview.feedbackPlaceholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback() } }}
                data-testid="visual-review-feedback-text"
              />
              <div className="vr__muted">{plan.screens.length > 0 ? t('visualReview.drawHint') : null}</div>
              {boxes.length > 0 && (
                <ol className="vr__boxes">
                  {boxes.map((box, i) => (
                    <li key={i}>
                      <span className="vr__num vr__num--feedback">{letter(i)}</span>
                      <span className="vr__muted">{t('visualReview.screen', { n: box.screen + 1 })}</span>
                      <input
                        className="vr__note"
                        value={box.note}
                        placeholder={t('visualReview.boxNote')}
                        onChange={(e) => setBoxes((current) => current.map((b, j) => (j === i ? { ...b, note: e.target.value } : b)))}
                      />
                      <IconButton label={t('visualReview.removeBox')} icon={<Trash2 size={14} />} size="sm" onClick={() => setBoxes((current) => current.filter((_, j) => j !== i))} />
                    </li>
                  ))}
                </ol>
              )}
              {recordingHere && recording ? (
                <div className="vr__row">
                  <Button variant="primary" icon={<Square size={14} />} onClick={recording.onStop} data-testid="visual-review-record-stop">{t('visualReview.recording.stop')}</Button>
                </div>
              ) : (
                <div className="vr__row">
                  <Button variant="primary" busy={busy} disabled={!text.trim() && boxes.length === 0} onClick={sendFeedback} data-testid="visual-review-feedback-send">{t('visualReview.sendFeedback')}</Button>
                  {recording && <Button icon={<Mic size={14} />} disabled={busy || recording.busy || !!recording.pending} title={t('visualReview.recordFeedbackTip')} onClick={startRecording} data-testid="visual-review-record">{t('visualReview.recordFeedback')}</Button>}
                  <Button variant="ghost" disabled={busy} onClick={() => { setMode('view'); setBoxes([]) }}>{t('common.cancel')}</Button>
                </div>
              )}
            </div>
          )}
        </footer>
      )}
    </article>
  )
}

export const letter = (i: number): string => String.fromCharCode(65 + (i % 26))

/** Agent のターミナルへ送れなかったときの、貼る文とコピーのボタン */
export function ManualCopy({ manual, onClose }: { manual: Manual; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  return (
    <div className="vr__manual" role="status" data-testid="visual-review-manual">
      <div>{manual.message}</div>
      <pre className="vr__manual-text">{manual.copyText}</pre>
      <div className="vr__row">
        <Button icon={<Copy size={14} />} onClick={() => { void navigator.clipboard.writeText(manual.copyText).then(() => toast({ tone: 'success', message: t('visualReview.copied') })).catch(() => undefined) }}>{t('visualReview.copy')}</Button>
        <IconButton label={t('common.close')} icon={<X size={14} />} onClick={onClose} />
      </div>
    </div>
  )
}

function BeforeAfter({ before, after }: { before?: string; after: string }) {
  return (
    <div className="vr__ba">
      {before && <><span className="vr__before">{before}</span><ArrowRight size={13} className="vr__arrow" aria-hidden="true" /></>}
      <span className="vr__after">{after}</span>
    </div>
  )
}

/** 画像と番号付きの枠。drawing の間は、ドラッグで場所を囲める（フィードバック）。価値ユースケースも使う */
export function Shot({ src, annotations, drawing, boxes, onDraw }: {
  src: string | null | undefined
  annotations: Array<PlanBox & { n: number; kind: string; label: string }>
  drawing: boolean
  boxes: Array<FeedbackBox & { i: number }>
  onDraw: (box: PlanBox) => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const point = (e: ReactPointerEvent): { x: number; y: number } => {
    const rect = ref.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }
  const draftBox = draft ? clampBox({ x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) }) : null

  if (src === undefined) return <div className="vr__shot vr__shot--loading" aria-busy="true" />
  if (src === null) return <div className="vr__shot vr__shot--missing">{t('visualReview.imageMissing')}</div>

  return (
    <div
      ref={ref}
      className={`vr__shot${drawing ? ' is-drawing' : ''}`}
      onPointerDown={drawing ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = point(e); setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }) } : undefined}
      onPointerMove={drawing && draft ? (e) => { const p = point(e); setDraft((d) => (d ? { ...d, x1: p.x, y1: p.y } : d)) } : undefined}
      onPointerUp={drawing && draft ? () => {
        // 小さすぎる（ただのクリック）は枠にしない
        if (draftBox && Math.abs(draft.x1 - draft.x0) > 0.01 && Math.abs(draft.y1 - draft.y0) > 0.01) onDraw(draftBox)
        setDraft(null)
      } : undefined}
    >
      <img src={src} alt="" draggable={false} />
      {annotations.map((a) => (
        <div key={a.n} className={`vr__box vr-kind--${a.kind}`} style={boxStyle(a)} title={a.label}>
          <span className="vr__num">{a.n}</span>
        </div>
      ))}
      {boxes.map((box) => (
        <div key={`f${box.i}`} className="vr__box vr__box--feedback" style={boxStyle(box)}>
          <span className="vr__num vr__num--feedback">{letter(box.i)}</span>
        </div>
      ))}
      {draftBox && <div className="vr__box vr__box--feedback" style={boxStyle(draftBox)} />}
    </div>
  )
}

const boxStyle = (box: PlanBox): CSSProperties => ({
  left: `${box.x * 100}%`,
  top: `${box.y * 100}%`,
  width: `${box.w * 100}%`,
  height: `${box.h * 100}%`
})
