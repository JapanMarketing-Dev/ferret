import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, MessageSquare, Mic, Square, Trash2 } from 'lucide-react'
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
import { InvalidPlans, ListToggle, ManualCopy, ResponseHistory, STATUS_TONE, Shot, formatTime, letter, useDocImages, useListCollapsed, type FeedbackBox, type Manual } from './VisualReview'
import { Whiteboard } from './Whiteboard'
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
  const [listCollapsed, toggleList] = useListCollapsed()
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
    <div className={`vr vuc${listCollapsed ? ' is-list-collapsed' : ''}`} data-testid="value-usecases">
      <nav className="vr__list" aria-label={t('valueUseCase.listLabel')}>
        <ListToggle collapsed={listCollapsed} onToggle={toggleList} />
        {!listCollapsed && docs.map((doc) => {
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
        {!listCollapsed && invalid.length > 0 && <InvalidPlans invalid={invalid} title={t('valueUseCase.invalid')} />}
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

  const recordBlocked = busy || !!recording?.busy || !!recording?.pending

  const dock = (
    <div className="wb__dock" data-no-pan>
      {manual && <ManualCopy manual={manual} onClose={() => onManual(null)} />}
      {pending && (
        <footer className="vr__actions wb__actions" data-testid="value-usecases-actions">
          {processingHere ? (
            <div className="vr__row vr__recording-state" role="status"><Spinner size={14} />{t('valueUseCase.recording.processing')}</div>
          ) : mode === 'view' ? (
            <div className="vr__row">
              {doc.status === 'drafting' && <span className="vr__drafting" role="status"><Spinner size={14} />{t('visualReview.drafting')}</span>}
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
    </div>
  )

  return (
    <article className="vr__detail vr__detail--board" data-testid="value-usecases-detail">
      <Whiteboard viewKey={`value-usecases:${doc.id}`} overlay={dock} testId="value-usecases-board">
        <div className="wbl">
          <header className="wbl__card wbl__head" data-board-card>
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
            {doc.purpose && <p className="vuc__purpose"><strong>{t('valueUseCase.purpose')}</strong> {doc.purpose}</p>}
          </header>

          <div className="wbl__body">
            <div className="wbl__lanes">
              {doc.values.map((value, v) => (
                <ValueLane
                  key={value.id}
                  doc={doc}
                  value={value}
                  index={v}
                  images={images}
                  drawing={mode === 'feedback'}
                  boxes={boxes}
                  onDraw={(screen, box) => setBoxes((current) => [...current, { ...box, screen, note: '' }])}
                />
              ))}
            </div>
            {(doc.outOfScope.length > 0 || doc.questions.length > 0 || doc.responses.length > 0) && (
              <div className="wbl__side">
                {doc.questions.length > 0 && (
                  <section className="wbl__card wbl__sticky wbl__sticky--question" data-board-card>
                    <h3>{t('valueUseCase.questions')}</h3>
                    <ul className="vr__plain">{doc.questions.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </section>
                )}
                {doc.outOfScope.length > 0 && (
                  <section className="wbl__card wbl__sticky wbl__sticky--muted" data-board-card>
                    <h3>{t('valueUseCase.outOfScope')}</h3>
                    <ul className="vr__plain">{doc.outOfScope.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </section>
                )}
                {doc.responses.length > 0 && (
                  <section className="wbl__card wbl__sticky wbl__sticky--muted" data-board-card>
                    <h3>{t('visualReview.history')}</h3>
                    <ResponseHistory responses={doc.responses} />
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </Whiteboard>
    </article>
  )
}

/** 価値1つの横一列。左に価値のカード（番号・名前・今の作り・誰が・なぜ・条件）、右へ最初の画面からの手順のカードを矢印でつなぐ */
function ValueLane({ doc, value, index, images, drawing, boxes, onDraw }: {
  doc: ValueUseCaseDoc
  value: ValueItem
  index: number
  images: Record<string, string | null>
  drawing: boolean
  boxes: FeedbackBox[]
  onDraw: (screen: number, box: PlanBox) => void
}) {
  const t = useT()
  const state = value.status ?? 'unknown'
  return (
    <section className={`vuc__lane vuc-state--${state}`} data-testid="value-usecases-value">
      <div className="wbl__card vuc__value" data-board-card>
        <div className="vuc__value-head">
          <span className="vuc__value-no">{index + 1}</span>
          <span className="vuc__value-name">{value.name}</span>
        </div>
        <Badge tone={STATE_TONE[state]}>{t(`valueUseCase.state.${state}`)}</Badge>
        <dl className="vuc__facts">
          {value.who && <><dt>{t('valueUseCase.who')}</dt><dd>{value.who}</dd></>}
          {value.why && <><dt>{t('valueUseCase.why')}</dt><dd>{value.why}</dd></>}
          {value.success && <><dt>{t('valueUseCase.success')}</dt><dd>{value.success}</dd></>}
        </dl>
      </div>
      {value.flow.length === 0 ? <div className="wbl__card vuc__step vr__muted">{t('valueUseCase.noFlow')}</div> : (
        <ol className="vuc__flow">
          {value.flow.map((step, s) => {
            const flat = flatStepIndex(doc, index, s)
            return (
              <li key={s} className="vuc__flow-item">
                <ArrowRight size={22} className="vuc__next" aria-hidden="true" />
                <div className="wbl__card vuc__step" data-board-card>
                  <div className="vuc__step-head">
                    <span className="vr__num vr-kind--target">{step.step}</span>
                    <span className="vuc__step-screen">{step.screen || t('valueUseCase.step', { n: step.step })}</span>
                  </div>
                  {step.url && <span className="vr__muted vr__url" title={step.url}>{step.url}</span>}
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
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
