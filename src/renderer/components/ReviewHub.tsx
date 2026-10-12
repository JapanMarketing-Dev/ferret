import { useState, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus, Users } from 'lucide-react'
import { isEmptyDraft, reviewHosts, type ReviewFilter } from '@shared/reviewList'
import { formatShortcut } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'
import { ReviewFilterBar, ReviewList, loadReviewFilter, saveReviewFilter, type ReviewSession } from './ReviewList'

/**
 * 「指摘」のページ。左に新しいレビュー・MTG の取り込み・レビューの履歴（検索と絞り込み）、右に選んだレビューの指摘。
 * 以前はサイドバーのプロジェクトの下に置いていたが、見にくいのでここへ移した（2026-10-11 本人指示）。
 * 履歴は開いているプロジェクトのものだけ（別のプロジェクトはサイドバーで切り替える）。
 * 履歴の列は既定で閉じておく（ほとんど開かないため。2026-10-12 本人指示）。新しいレビュー・MTG の取り込みは、
 * 閉じていても押せるよう右の上の帯に置く。開け閉めは覚えておく
 */
const HISTORY_OPEN_KEY = 'ferret.reviewHub.historyOpen'

export function loadHistoryOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) === '1'
  } catch { // ストレージが使えない（想定内。閉じたまま）
    return false
  }
}

function saveHistoryOpen(open: boolean): void {
  try {
    localStorage.setItem(HISTORY_OPEN_KEY, open ? '1' : '0')
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

export function ReviewHub({
  sessions,
  selectedId,
  onSelect,
  onHistoryChanged,
  onNewReview,
  onImportMeeting,
  recording = false,
  children
}: {
  sessions: ReviewSession[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 名前の変更・アーカイブ・削除のあと。消した ID を渡す */
  onHistoryChanged: (deletedIds: string[]) => void
  onNewReview: () => void
  onImportMeeting?: () => void
  /** 録画中は新しいレビュー・取り込みを押せなくする */
  recording?: boolean
  children: ReactNode
}) {
  const t = useT()
  const toast = useToast()
  const [filter, setFilterState] = useState<ReviewFilter>(loadReviewFilter)
  const [filterOpen, setFilterOpen] = useState(false)
  const [historyOpen, setHistoryOpenState] = useState(loadHistoryOpen)
  const toggleHistory = () => {
    setHistoryOpenState(!historyOpen)
    saveHistoryOpen(!historyOpen)
  }
  const setFilter = (next: ReviewFilter) => {
    setFilterState(next)
    saveReviewFilter(next)
  }
  const deleteEmptyDrafts = () => {
    const ids = sessions.filter(isEmptyDraft).map((s) => s.id)
    if (ids.length === 0) return
    void window.ade.invoke('review:delete', ids).then((deleted) => {
      onHistoryChanged(deleted)
      if (deleted.length > 0) toast({ tone: 'success', message: t('sidebar.deleted', { count: deleted.length }) })
    }, (err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <div className={`rv-hub${historyOpen ? '' : ' rv-hub--closed'}`} data-testid="review-hub">
    {historyOpen && <aside className="rv-hub__side" aria-label={t('reviewHub.history')} data-testid="review-hub-history">
      <ReviewFilterBar
        filter={filter}
        onChange={setFilter}
        open={filterOpen}
        onOpenChange={setFilterOpen}
        hosts={reviewHosts(sessions)}
        emptyDraftCount={sessions.filter(isEmptyDraft).length}
        onDeleteEmpty={deleteEmptyDrafts}
      />
      <div className="rv-hub__list">
        <ReviewList active items={sessions} filter={filter} selectedId={selectedId} emptyText={t('sidebar.emptyOther')} onSelect={onSelect} onChanged={onHistoryChanged} />
      </div>
    </aside>}
    <div className="rv-hub__main">
      <div className="rv-hub__bar">
        <button type="button" className="rv-hub__toggle" aria-expanded={historyOpen} onClick={toggleHistory} data-testid="review-hub-toggle-history"
          title={historyOpen ? t('reviewHub.hideHistory') : t('reviewHub.showHistory')}>
          {historyOpen ? <PanelLeftClose size={14} strokeWidth={1.75} /> : <PanelLeftOpen size={14} strokeWidth={1.75} />}
          <span>{t('reviewHub.historyCount', { count: sessions.length })}</span>
        </button>
        <button type="button" className="sb-new-review" title={t('sidebar.newReview')} disabled={recording} onClick={onNewReview} data-testid="review-hub-new">
          <Plus size={13} strokeWidth={1.75} />
          <span>{t('sidebar.newReview')}</span>
          <kbd className="sb-new-review__key">{formatShortcut('Mod', 'Shift', 'R')}</kbd>
        </button>
        {onImportMeeting && <button type="button" className="sb-new-review sb-new-review--import" title={t('sidebar.importMeetingTip')} disabled={recording}
          onClick={onImportMeeting} data-testid="review-hub-import-meeting">
          <Users size={13} strokeWidth={1.75} />
          <span>{t('sidebar.importMeeting')}</span>
        </button>}
      </div>
      <div className="rv-hub__content">{children}</div>
    </div>
  </div>
}
