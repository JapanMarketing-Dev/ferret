import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, Check, ChevronDown, ChevronRight, MessageSquare, Mic, Square, Trash2 } from 'lucide-react'
import { canRespond, type PlanBox, type RecordingNote } from '@shared/visualReview'
import {
  flatStepIndex,
  isComplete,
  stepAt,
  summarizeValues,
  type ValueItem,
  type ValueReply,
  type ValueState,
  type ValueUseCaseDoc,
  type ValueUseCaseListing
} from '@shared/valueUseCase'
import type { PendingRecordingFeedback } from '@shared/visualReviewRecording'
import type { LiveTranscriptSegment, LiveTranscriptStatus } from '@shared/liveTranscript'
import { Badge, Button, EmptyState, IconButton, RecordDot, Spinner, useToast, type BadgeTone } from '../ui'
import { LiveTranscriptPanel } from './LiveTranscriptPanel'
import { InvalidPlans, ManualCopy, STATUS_TONE, Shot, formatTime, letter, useDocImages, type FeedbackBox, type Manual } from './VisualReview'
import { useT } from '../lib/i18n'
import '../styles/visualReview.css'

/**
 * 中央の「価値ユースケース」タブ（ビジュアルレビューの右）。Agent が書いた .ferret/value-usecases/<id>.json を見せる。
 * システムの存在意義 → 価値ごとのカード（誰が・なぜ・得られたと分かる条件・今の作り）→ 最初の画面からの流れ（画面・押す場所の番号付きの枠・操作・結果）。
 * 全部の流れが動けばシステムは完成。「これで作って」（承認）・「フィードバック」（文・スクリーンショットの上の囲み・声と書き込み）は、
 * 書いた Agent のターミナルへ送る（main）。見た目はビジュアルレビューと同じ（白い背景に黒い文字。部品も共用）。
 */

/** 声と書き込みのフィードバック（App のいつもの録画。ビジュアルレビューと同じ。@shared/visualReviewRecording） */
export interface ValueRecordingControls {
  /** この種類（価値ユースケース）で返しているもの。ほかの種類のときは null */
  pending: PendingRecordingFeedback | null
  /** 録画中・開始や停止の途中・ほかの種類で返している途中 */
  busy: boolean
  live: { status: LiveTranscriptStatus; segments: readonly LiveTranscriptSegment[] }
  onStart: (doc: ValueUseCaseDoc, note: RecordingNote) => void
  onNote: (docId: string, note: RecordingNote) => void
  onStop: () => void
}

const STATE_TONE: Record<ValueState | 'unknown', BadgeTone> = {
  works: 'success',
  partial: 'warning',
  broken: 'danger',
  'not-built': 'neutral',
  unknown: 'neutral'
}

export function ValueUseCases({ listing, onChanged, recording }: {
  listing: ValueUseCaseListing
  onChanged: () => void
  recording?: ValueRecordingControls
}) {
  const t = useT()
  const { docs, invalid } = listing
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [manual, setManual] = useState<Manual | null>(null)
  const recordingId = recording?.pending?.planId
  const selected = docs.find((doc) => doc.id === (recordingId ?? selectedId)) ?? docs.find((doc) => doc.id === selectedId) ?? docs[0] ?? null

  if (docs.length === 0) {
    return (
      <div className="vr vr--empty vuc" data-testid="value-usecases">
        <EmptyState title={t('valueUseCase.empty.title')} description={t('valueUseCase.empty.description')} testId="value-usecases-empty" />
        {invalid.length > 0 && <InvalidPlans invalid={invalid} title={t('valueUseCase.invalid')} />}
      </div>
    )
  }

  return (
    <div className="vr vuc" data-testid="value-usecases">
      <nav className="vr__list" aria-label={t('valueUseCase.listLabel')}>
        {docs.map((doc) => {
          const summary = summarizeValues(doc)
          return (
            <button
              key={doc.id}
              type="button"
              className="vr__item"
              aria-current={doc.id === selected?.id ? 'true' : undefined}
              onClick={() => setSelectedId(doc.id)}
              data-testid="value-usecases-item"
            >
              <span className="vr__item-title">{doc.title}</span>
              <span className="vr__item-meta">
                <Badge tone={STATUS_TONE[doc.status]}>{t(`visualReview.status.${doc.status}`)}</Badge>
                <span>{t('visualReview.revision', { n: doc.revision })}</span>
                <span>{t('valueUseCase.summary', { values: summary.values, works: summary.works })}</span>
                {(doc.updatedAt || doc.createdAt) && <span>{formatTime(doc.updatedAt || doc.createdAt)}</span>}
              </span>
            </button>
          )
        })}
        {invalid.length > 0 && <InvalidPlans invalid={invalid} title={t('valueUseCase.invalid')} />}
      </nav>
      {selected && (
        <DocDetail
          key={`${selected.id}:${selected.revision}:${selected.status}`}
          doc={selected}
          onChanged={onChanged}
          manual={manual?.id === selected.id ? manual : null}
          onManual={setManual}
          recording={recording}
        />
      )}
    </div>
  )
}

function DocDetail({ doc, onChanged, manual, onManual, recording }: {
  doc: ValueUseCaseDoc
  onChanged: () => void
  manual: Manual | null
  onManual: (manual: Manual | null) => void
  recording?: ValueRecordingControls
}) {
  const t = useT()
  const toast = useToast()
  const rels = useMemo(() => doc.values.flatMap((value) => value.flow.flatMap((step) => (step.image ? [step.image] : []))), [doc])
  const images = useDocImages(doc.id, doc.revision, rels)
  const summary = summarizeValues(doc)
  const complete = isComplete(doc)
  const mine = recording?.pending?.planId === doc.id ? recording.pending : null
  const recordingHere = mine?.phase === 'recording'
  const processingHere = mine?.phase === 'processing'
  const [modeState, setMode] = useState<'view' | 'feedback'>(recordingHere ? 'feedback' : 'view')
  const mode = recordingHere ? 'feedback' : modeState
  const [text, setText] = useState(() => (recordingHere ? mine.note.text ?? '' : ''))
  const [boxes, setBoxes] = useState<FeedbackBox[]>(() => (recordingHere ? (mine.note.boxes ?? []).map((box) => ({ ...box, note: box.note ?? '' })) : []))
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const pending = canRespond(doc)

  const currentNote = (): RecordingNote => {
    const trimmed = text.trim()
    return {
      ...(trimmed ? { text: trimmed } : {}),
      ...(boxes.length ? { boxes: boxes.map(({ note, ...box }) => ({ ...box, ...(note.trim() ? { note: note.trim() } : {}) })) } : {})
    }
  }
  const onNote = recording?.onNote
  useEffect(() => {
    if (recordingHere) onNote?.(doc.id, currentNote())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 文・囲みが変わったときだけ
  }, [recordingHere, text, boxes])

  const respond = async (reply: ValueReply): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.ade.invoke('valueUseCase:respond', doc.id, reply)
      if (result.sent) toast({ tone: 'success', message: result.message })
      else if (result.copyText) onManual({ id: doc.id, message: result.message, copyText: result.copyText })
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

  const startRecording = (): void => {
    setMode('feedback')
    recording?.onStart(doc, currentNote())
  }

  const toggle = (id: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const allCollapsed = doc.values.every((value) => collapsed.has(value.id))
  const recordBlocked = busy || !!recording?.busy || !!recording?.pending

  return (
    <article className="vr__detail" data-testid="value-usecases-detail">
      <header className="vr__head">
        <div className="vr__head-row">
          <h2 className="vr__title">{doc.title}</h2>
          <Badge tone={STATUS_TONE[doc.status]}>{t(`visualReview.status.${doc.status}`)}</Badge>
          <span className="vr__muted">{t('visualReview.revision', { n: doc.revision })}</span>
        </div>
        <div className="vuc__summary" data-testid="value-usecases-summary">
          <strong>{t('valueUseCase.summary', { values: summary.values, works: summary.works })}</strong>
          <span>{t('valueUseCase.summaryDetail', { ...summary })}</span>
          {complete && <Badge tone="success">{t('valueUseCase.complete')}</Badge>}
        </div>
      </header>

      {manual && <ManualCopy manual={manual} onClose={() => onManual(null)} />}

      {doc.purpose && (
        <section className="vr__section vuc__purpose">
          <h3>{t('valueUseCase.purpose')}</h3>
          <p>{doc.purpose}</p>
        </section>
      )}

      <div className="vr__row">
        <Button variant="ghost" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(doc.values.map((value) => value.id)))}>
          {t(allCollapsed ? 'valueUseCase.expandAll' : 'valueUseCase.collapseAll')}
        </Button>
      </div>

      {doc.values.map((value, v) => (
        <ValueCard
          key={value.id}
          doc={doc}
          value={value}
          index={v}
          open={!collapsed.has(value.id)}
          onToggle={() => toggle(value.id)}
          images={images}
          drawing={mode === 'feedback'}
          boxes={boxes}
          onDraw={(screen, box) => setBoxes((current) => [...current, { ...box, screen, note: '' }])}
        />
      ))}

      {doc.outOfScope.length > 0 && (
        <section className="vr__section">
          <h3>{t('valueUseCase.outOfScope')}</h3>
          <ul className="vr__plain">{doc.outOfScope.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </section>
      )}

      {doc.questions.length > 0 && (
        <section className="vr__section vr__questions">
          <h3>{t('valueUseCase.questions')}</h3>
          <ul className="vr__plain">{doc.questions.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </section>
      )}

      {doc.responses.length > 0 && (
        <section className="vr__section">
          <h3>{t('visualReview.history')}</h3>
          <ul className="vr__plain vr__muted">
            {doc.responses.map((response, i) => (
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
        <footer className="vr__actions" data-testid="value-usecases-actions">
          {processingHere ? (
            <div className="vr__row vr__recording-state" role="status"><Spinner size={14} />{t('valueUseCase.recording.processing')}</div>
          ) : mode === 'view' ? (
            <div className="vr__row">
              {canRespond(doc, 'approve') && <Button variant="primary" icon={<Check size={14} />} busy={busy} onClick={() => void respond({ action: 'approve' })} data-testid="value-usecases-approve">{t('visualReview.approve')}</Button>}
              <Button icon={<MessageSquare size={14} />} disabled={busy} onClick={() => setMode('feedback')} data-testid="value-usecases-feedback">{t('visualReview.feedback')}</Button>
              {recording && <Button icon={<Mic size={14} />} disabled={recordBlocked} title={t('valueUseCase.recordFeedbackTip')} onClick={startRecording} data-testid="value-usecases-record">{t('visualReview.recordFeedback')}</Button>}
            </div>
          ) : (
            <div className="vr__feedback">
              {recordingHere && recording && (
                <div className="vr__recording">
                  <div className="vr__row vr__recording-state" role="status"><RecordDot active />{t('valueUseCase.recording.active')}</div>
                  <div className="vr__live">
                    <LiveTranscriptPanel status={recording.live.status} segments={recording.live.segments} head={<span className="vr__live-head">{t('visualReview.recording.transcript')}</span>} />
                  </div>
                </div>
              )}
              <textarea
                className="vr__textarea"
                value={text}
                autoFocus
                placeholder={t('valueUseCase.feedbackPlaceholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback() } }}
                data-testid="value-usecases-feedback-text"
              />
              {rels.length > 0 && <div className="vr__muted">{t('valueUseCase.drawHint')}</div>}
              {boxes.length > 0 && (
                <ol className="vr__boxes">
                  {boxes.map((box, i) => {
                    const at = stepAt(doc, box.screen)
                    return (
                      <li key={i}>
                        <span className="vr__num vr__num--feedback">{letter(i)}</span>
                        {at && <span className="vr__muted">{t('valueUseCase.boxWhere', { value: at.value + 1, step: at.step + 1 })}</span>}
                        <input
                          className="vr__note"
                          value={box.note}
                          placeholder={t('visualReview.boxNote')}
                          onChange={(e) => setBoxes((current) => current.map((b, j) => (j === i ? { ...b, note: e.target.value } : b)))}
                        />
                        <IconButton label={t('visualReview.removeBox')} icon={<Trash2 size={14} />} size="sm" onClick={() => setBoxes((current) => current.filter((_, j) => j !== i))} />
                      </li>
                    )
                  })}
                </ol>
              )}
              {recordingHere && recording ? (
                <div className="vr__row">
                  <Button variant="primary" icon={<Square size={14} />} onClick={recording.onStop}>{t('visualReview.recording.stop')}</Button>
                </div>
              ) : (
                <div className="vr__row">
                  <Button variant="primary" busy={busy} disabled={!text.trim() && boxes.length === 0} onClick={sendFeedback} data-testid="value-usecases-feedback-send">{t('visualReview.sendFeedback')}</Button>
                  {recording && <Button icon={<Mic size={14} />} disabled={recordBlocked} title={t('valueUseCase.recordFeedbackTip')} onClick={startRecording}>{t('visualReview.recordFeedback')}</Button>}
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

/** 価値1つのカード。見出し（番号・名前・今の作り）を押すとたためる。中身は誰が・なぜ・条件と、最初の画面からの流れ */
function ValueCard({ doc, value, index, open, onToggle, images, drawing, boxes, onDraw }: {
  doc: ValueUseCaseDoc
  value: ValueItem
  index: number
  open: boolean
  onToggle: () => void
  images: Record<string, string | null>
  drawing: boolean
  boxes: FeedbackBox[]
  onDraw: (screen: number, box: PlanBox) => void
}) {
  const t = useT()
  const state = value.status ?? 'unknown'
  return (
    <section className="vuc__value" data-testid="value-usecases-value">
      <button type="button" className="vuc__value-head" aria-expanded={open} onClick={onToggle} title={t(open ? 'valueUseCase.collapse' : 'valueUseCase.expand')}>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="vuc__value-no">{index + 1}</span>
        <span className="vuc__value-name">{value.name}</span>
        <Badge tone={STATE_TONE[state]}>{t(`valueUseCase.state.${state}`)}</Badge>
      </button>
      {open && (
        <div className="vuc__value-body">
          <dl className="vuc__facts">
            {value.who && <><dt>{t('valueUseCase.who')}</dt><dd>{value.who}</dd></>}
            {value.why && <><dt>{t('valueUseCase.why')}</dt><dd>{value.why}</dd></>}
            {value.success && <><dt>{t('valueUseCase.success')}</dt><dd>{value.success}</dd></>}
          </dl>
          <h4 className="vuc__flow-title">{t('valueUseCase.flow')}</h4>
          {value.flow.length === 0 ? <div className="vr__muted">{t('valueUseCase.noFlow')}</div> : (
            <ol className="vuc__flow">
              {value.flow.map((step, s) => {
                const flat = flatStepIndex(doc, index, s)
                return (
                  <li key={s} className="vuc__step">
                    <div className="vuc__step-head">
                      <span className="vr__num vr-kind--target">{step.step}</span>
                      <span className="vuc__step-screen">{step.screen || t('valueUseCase.step', { n: step.step })}</span>
                      {step.url && <span className="vr__muted vr__url" title={step.url}>{step.url}</span>}
                    </div>
                    {step.image ? (
                      <Shot
                        src={images[step.image]}
                        annotations={step.target ? [{ ...step.target, n: step.step, kind: 'target', label: step.action }] : []}
                        drawing={drawing}
                        boxes={boxes.map((box, i) => ({ ...box, i })).filter((box) => box.screen === flat)}
                        onDraw={(box) => onDraw(flat, box)}
                      />
                    ) : <div className="vr__muted vuc__noimage">{t('valueUseCase.noImage')}</div>}
                    <dl className="vuc__facts">
                      {step.action && <><dt>{t('valueUseCase.action')}</dt><dd>{step.action}</dd></>}
                      {step.expected && <><dt>{t('valueUseCase.expected')}</dt><dd>{step.expected}</dd></>}
                    </dl>
                    {s < value.flow.length - 1 && <ArrowDown size={18} className="vuc__next" aria-hidden="true" />}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
