import { useState, type Ref } from 'react'
import { Check, CheckCircle2, Circle, CircleDot, Eye, ListFilter, MessageSquare, Send, X } from 'lucide-react'
import { countProgress, lastShownEvent, lastVerdict, type FindingProgress, type ProgressEntry, type ProgressMap, type ReviewVerdict } from '@shared/findingProgress'
import { REPLY_MAX } from '@shared/agentPrompt'
import { verdictKeySends } from '@shared/verdictKeys'
import type { TranslationKey } from '@shared/i18n'
import { Button, Tooltip } from '../ui'
import { useT } from '../lib/i18n'
import { FINDING_STATUSES, isStatusShown, onlyStatus, selectStatus, type HiddenStatuses } from '@shared/findingStatusFilter'

/**
 * Findings の進み具合（未対応・対応中・人の確認待ち・完了）。ReviewFindings から使う。
 * Agent は人に質問しない（判定モデルは Agent 自身の確認）。人がするのは確認待ちの BEFORE / AFTER を見て OK / NG を付けることだけ。
 * 値は progress.json（Agent と利用者のどちらも書く。@shared/findingProgress）。旗（要確認）とは別物
 */

const LABEL: Record<FindingProgress, TranslationKey> = {
  todo: 'review.progress.todo',
  in_progress: 'review.progress.inProgress',
  done: 'review.progress.done',
  human_review: 'review.progress.humanReview'
}
const ICON = { todo: Circle, in_progress: CircleDot, done: CheckCircle2, human_review: Eye } as const

/** カードの見出しの横。押すと 未対応 → 対応中 → 完了 → 未対応（確認待ちは対応中へ） */
export function ProgressToggle({ n, progress, disabled, onChange }: {
  n: number
  progress: FindingProgress
  disabled?: boolean
  onChange: () => void
}) {
  const t = useT()
  const Icon = ICON[progress]
  const state = t(LABEL[progress])
  return <Tooltip side="top" label={t('review.progress.toggle', { n, state })}>
    <button type="button" className={`rv-progress rv-progress--${progress}`} disabled={disabled} data-testid={`review-progress-${n}`}
      aria-label={t('review.progress.toggle', { n, state })} onClick={onChange}>
      <Icon size={12} strokeWidth={2.25} aria-hidden="true" />{state}
    </button>
  </Tooltip>
}

/**
 * 一覧の上の「進み具合で絞り込む」。チップを押すとその進み具合の表示と非表示を切り替え、
 * 横の「だけ」でそれだけを出す。件数0の進み具合も出す（隠したまま忘れないように）。保存は呼び出し側
 */
export function StatusFilterBar({ counts, hidden, onChange }: {
  counts: Record<FindingProgress, number>
  hidden: HiddenStatuses
  onChange: (hidden: FindingProgress[]) => void
}) {
  const t = useT()
  return <div className="rv-status-filter" role="group" aria-label={t('review.statusFilter.label')} data-testid="findings-status-filter">
    {FINDING_STATUSES.map((status) => {
      const Icon = ICON[status]
      const state = t(LABEL[status])
      // 押したものだけを出す（絞り込み）。何も選んでいなければ全部
      const selected = hidden.length > 0 && isStatusShown(hidden, status)
      return <span key={status} className={`rv-status-filter__item rv-status-filter__item--${status}`}>
        <button type="button" className="rv-status-filter__chip" aria-pressed={selected} title={t('review.statusFilter.toggle', { state })}
          onClick={() => onChange(selectStatus(hidden, status))} data-testid={`findings-status-filter-${status}`}>
          <Icon size={12} strokeWidth={2.25} aria-hidden="true" /><span className="rv-status-filter__label">{state}</span><span className="rv-status-filter__count">{counts[status]}</span>
        </button>
        <button type="button" className="rv-status-filter__only" aria-label={t('review.statusFilter.only', { state })} title={t('review.statusFilter.only', { state })}
          onClick={() => onChange(onlyStatus(status))} data-testid={`findings-status-only-${status}`}>
          <ListFilter size={11} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </span>
    })}
    {hidden.length > 0 && <button type="button" className="rv-status-filter__reset" onClick={() => onChange([])} data-testid="findings-status-filter-all">
      {t('review.statusFilter.all')}
    </button>}
  </div>
}

/** ヘッダーの「2 / 5 done · 3 to review」と細い進捗バー。Agent へ送る指摘だけを数え、done は人が OK したものだけ */
export function ProgressSummary({ items, progress }: {
  items: ReadonlyArray<{ id: string; include: boolean }>
  progress: ProgressMap | undefined
}) {
  const t = useT()
  const count = countProgress(items, progress)
  if (count.total === 0) return null
  const pct = (n: number) => `${Math.round((n / count.total) * 100)}%`
  return <Tooltip side="bottom" label={t('review.progress.summaryTip')}>
    <span className={`rv-progress-sum${count.done === count.total ? ' is-complete' : ''}`} data-testid="review-progress-summary">
      <span className="rv-progress-sum__text">{t('review.progress.summary', { done: count.done, total: count.total })}</span>
      {count.humanReview > 0 && <span className="rv-progress-sum__review" data-testid="review-progress-human-review">
        <Eye size={12} strokeWidth={2.25} aria-hidden="true" />{t('review.progress.summaryHumanReview', { count: count.humanReview })}
      </span>}
      <span className="rv-progress-sum__bar" role="progressbar" aria-valuemin={0} aria-valuemax={count.total} aria-valuenow={count.done}
        aria-label={t('review.progress.summary', { done: count.done, total: count.total })}>
        <span className="rv-progress-sum__done" style={{ width: pct(count.done) }} />
        <span className="rv-progress-sum__review-bar" style={{ width: pct(count.humanReview) }} />
        <span className="rv-progress-sum__doing" style={{ width: pct(count.inProgress) }} />
      </span>
    </span>
  </Tooltip>
}

const VERDICT_LABEL: Record<ReviewVerdict, TranslationKey> = { ok: 'review.verdict.ok', ng: 'review.verdict.ng', comment: 'review.verdict.comment' }

/**
 * 「Agent が直しました。確認してください」（human_review）。人が OK（完了）/ NG（コメントつきで差し戻し）/ Comment（判断せずにメモ）を付ける。
 * NG と Comment は本文が必須。コメントを書いて Enter・⌘/Ctrl+Enter・［Agent に送信］は、NG を付けてその1件をすぐ Agent へ送る（変換の確定の Enter は除く）。BEFORE / AFTER の画像は ReviewShots が出す
 */
export function VerdictPanel({ n, entry, busy, onVerdict, inputRef }: {
  n: number
  entry: ProgressEntry
  busy?: boolean
  onVerdict: (verdict: ReviewVerdict, text?: string, sendNow?: boolean) => Promise<boolean>

  /** 確認モードで N を押したときに、ここへ入力を移す */
  inputRef?: Ref<HTMLTextAreaElement>
}) {
  const t = useT()
  const [body, setBody] = useState('')
  // 開き直した（reopen）あとの古い OK は出さない（今の確認とは別の判断なので）
  const shown = lastShownEvent(entry)
  const last = shown && !(shown.verdict === 'ok' && lastVerdict(entry) !== 'ok') ? shown as typeof shown & { verdict: ReviewVerdict } : undefined
  const submit = (verdict: ReviewVerdict, sendNow?: boolean) => void onVerdict(verdict, verdict === 'ok' ? body.trim() || undefined : body.trim(), sendNow).then((ok) => ok && setBody(''))
  return <div className="rv-verdict" role="group" aria-label={t('review.verdict.title')} data-testid={`review-verdict-${n}`}>
    <p className="rv-verdict__title"><Eye size={14} strokeWidth={2.25} aria-hidden="true" />{t('review.verdict.title')}</p>
    {entry.note && <p className="rv-verdict__note">{entry.note}</p>}
    {last && <p className="rv-verdict__last">{t('review.verdict.last', { verdict: t(VERDICT_LABEL[last.verdict]) })}{last.text ? ` — ${last.text}` : ''}</p>}
    <textarea ref={inputRef} className="rv-verdict__input" aria-label={t('review.verdict.label', { n })} placeholder={t('review.compare.placeholder')}
      value={body} maxLength={REPLY_MAX} rows={2} disabled={busy} onChange={(e) => setBody(e.target.value)} data-testid={`review-verdict-input-${n}`}
      onKeyDown={(e) => {
        /*
         * コメントを書いて Enter（または ⌘/Ctrl+Enter）で、NG を付けてその1件をすぐ Agent へ送る（ユーザーの指示）。
         * 日本語の変換を確定する Enter（isComposing・keyCode 229）では送らない。Shift+Enter は改行
         */
        if (verdictKeySends({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
          e.preventDefault()
          if (body.trim() && !busy) submit('ng', true)
        }
        // 確認モードの Esc（終了）より先に、入力欄から抜けるだけにする
        // 比べる画面（dialog）でも、Esc は閉じずに入力欄から抜けるだけ（preventDefault で dialog の cancel を止める）
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur() }
      }} />
    <div className="rv-verdict__actions">
      <Tooltip side="bottom" label={t('review.verdict.okTip')}>
        <Button variant="default" className="rv-verdict__ok" icon={<Check size={13} />} disabled={busy} data-testid={`review-verdict-ok-${n}`} onClick={() => submit('ok')}>{t('review.verdict.ok')}</Button>
      </Tooltip>
      <Tooltip side="bottom" label={t('review.verdict.ngTip')}>
        <Button variant="default" className="rv-verdict__ng" icon={<X size={13} />} disabled={busy || !body.trim()} data-testid={`review-verdict-ng-${n}`} onClick={() => submit('ng')}>{t('review.verdict.ng')}</Button>
      </Tooltip>
      <Tooltip side="bottom" label={t('review.verdict.sendNowTip')}>
        <Button variant="default" className="rv-verdict__send" icon={<Send size={13} />} disabled={busy || !body.trim()} data-testid={`review-verdict-send-${n}`} onClick={() => submit('ng', true)}>{t('review.verdict.sendNow')}</Button>
      </Tooltip>
      <Tooltip side="bottom" label={t('review.verdict.commentTip')}>
        <Button variant="ghost" icon={<MessageSquare size={13} />} disabled={busy || !body.trim()} data-testid={`review-verdict-comment-${n}`} onClick={() => submit('comment')}>{t('review.verdict.comment')}</Button>
      </Tooltip>
    </div>
  </div>
}

/** NG を付けて、まだ Agent へ送っていない指摘。コメントを見せ、この1件だけ送る操作を置く（まとめて送るのはヘッダー） */
export function QueuedPanel({ n, entry, busy, onSendOne }: {
  n: number
  entry: ProgressEntry
  busy?: boolean
  onSendOne: () => void
}) {
  const t = useT()
  const comment = lastVerdict(entry) === 'ng' ? entry.history?.filter((e) => e.verdict === 'ng').at(-1)?.text : undefined
  return <div className="rv-queued" data-testid={`review-queued-${n}`}>
    <span className="rv-queued__label">{t('review.verdict.queued')}</span>
    {comment && <span className="rv-queued__text">{comment}</span>}
    <Button variant="ghost" icon={<Send size={13} />} disabled={busy} data-testid={`review-queued-send-${n}`} onClick={onSendOne}>{t('review.verdict.sendOne')}</Button>
  </div>
}

/** ヘッダーの「確認する（n）」（確認待ちだけを順に見る）と「NG をまとめて送る（n）」 */
export function ReviewActions({ humanReview, queued, reviewMode, busy, onToggleReviewMode, onSendQueued }: {
  humanReview: number
  queued: number
  reviewMode: boolean
  busy?: boolean
  onToggleReviewMode: () => void
  onSendQueued: () => void
}) {
  const t = useT()
  if (!humanReview && !queued && !reviewMode) return null
  return <div className="rv-review-actions">
    {(humanReview > 0 || reviewMode) && <Tooltip side="bottom" label={t('review.reviewMode.tip')}>
      <Button variant={reviewMode ? 'default' : 'ghost'} icon={<Eye size={13} />} aria-pressed={reviewMode} data-testid="review-mode-toggle" onClick={onToggleReviewMode}>
        {reviewMode ? t('review.reviewMode.exit') : t('review.reviewMode.open', { count: humanReview })}
      </Button>
    </Tooltip>}
    {queued > 0 && <Tooltip side="bottom" label={t('review.verdict.sendBatchTip')}>
      <Button variant="default" icon={<Send size={13} />} disabled={busy} data-testid="review-send-ng" onClick={onSendQueued}>{t('review.verdict.sendBatch', { count: queued })}</Button>
    </Tooltip>}
  </div>
}

