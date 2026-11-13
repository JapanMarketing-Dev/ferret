import { useCallback, useEffect, useRef, useState } from 'react'
import { newlyProposed, pendingCount, planMarks, type PlanListing, type VisualPlan } from '@shared/visualReview'
import { subscribeIpc } from '../lib/ipcEvents'

const EMPTY: PlanListing = { plans: [], invalid: [] }

/**
 * 開いているプロジェクトのビジュアルレビューの計画（.ferret/visual-review/）。
 * プロジェクトを開いたとき・main から visualReview:changed（Agent が計画を書いた）が届いたときに読み直す。
 * 新しく返事を待つ計画が出たら onProposed を呼ぶ（プロジェクトを開いた直後の読み込みでは呼ばない）
 */
export function useVisualReviews(folderPath: string | null, onProposed?: (plans: VisualPlan[]) => void): {
  listing: PlanListing
  pending: number
  reload: () => void
} {
  const [listing, setListing] = useState<PlanListing>(EMPTY)
  const marks = useRef<Map<string, string> | null>(null)
  const proposed = useRef(onProposed)
  proposed.current = onProposed
  const seq = useRef(0)

  const reload = useCallback(() => {
    const at = ++seq.current
    void window.ade.invoke('visualReview:list').then((next) => {
      if (at !== seq.current) return
      // 最初の読み込み（プロジェクトを開いた直後）は知らせない。前から待っているものは「新しく出た」ではない
      if (marks.current) {
        const fresh = newlyProposed(marks.current, next.plans)
        if (fresh.length > 0) proposed.current?.(fresh)
      }
      marks.current = planMarks(next.plans)
      setListing(next)
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（前の一覧のまま）
  }, [])

  useEffect(() => {
    marks.current = null
    setListing(EMPTY)
    if (!folderPath) return
    reload()
  }, [folderPath, reload])

  useEffect(() => subscribeIpc('visualReview:changed', reload, 'review'), [reload])

  return { listing, pending: pendingCount(listing.plans), reload }
}
