import { useCallback, useEffect, useRef, useState } from 'react'
import { newlyProposed, pendingCount, planMarks, type PlanListing, type ReviewDocHead, type VisualPlan } from '@shared/visualReview'
import type { ValueUseCaseDoc, ValueUseCaseListing } from '@shared/valueUseCase'
import { subscribeIpc } from '../lib/ipcEvents'

/**
 * Agent が書いて人の返事を待つ文書（ビジュアルレビューの計画・価値ユースケース）を読む共通の形。
 * プロジェクトを開いたとき・main から changed が届いたときに読み直す。
 * 新しく返事を待つ文書が出たら onProposed を呼ぶ（プロジェクトを開いた直後の読み込みでは呼ばない）
 */
function useReviewDocs<L, T extends ReviewDocHead>(folderPath: string | null, opts: {
  empty: L
  load: () => Promise<L>
  docs: (listing: L) => readonly T[]
  changed: 'visualReview:changed' | 'valueUseCase:changed'
  onProposed?: (docs: T[]) => void
}): { listing: L; pending: number; reload: () => void } {
  const [listing, setListing] = useState<L>(opts.empty)
  const marks = useRef<Map<string, string> | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const seq = useRef(0)

  const reload = useCallback(() => {
    const at = ++seq.current
    void latest.current.load().then((next) => {
      if (at !== seq.current) return
      const docs = latest.current.docs(next)
      // 最初の読み込み（プロジェクトを開いた直後）は知らせない。前から待っているものは「新しく出た」ではない
      if (marks.current) {
        const fresh = newlyProposed(marks.current, docs)
        if (fresh.length > 0) latest.current.onProposed?.(fresh)
      }
      marks.current = planMarks(docs)
      setListing(next)
    }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る（前の一覧のまま）
  }, [])

  useEffect(() => {
    marks.current = null
    setListing(latest.current.empty)
    if (!folderPath) return
    reload()
  }, [folderPath, reload])

  useEffect(() => subscribeIpc(opts.changed, reload, 'review'), [opts.changed, reload])

  return { listing, pending: pendingCount(opts.docs(listing)), reload }
}

const EMPTY_PLANS: PlanListing = { plans: [], invalid: [] }
const EMPTY_VALUES: ValueUseCaseListing = { docs: [], invalid: [] }

/** 開いているプロジェクトのビジュアルレビューの計画（.ferret/visual-review/） */
export function useVisualReviews(folderPath: string | null, onProposed?: (plans: VisualPlan[]) => void): {
  listing: PlanListing
  pending: number
  reload: () => void
} {
  return useReviewDocs(folderPath, {
    empty: EMPTY_PLANS,
    load: () => window.ade.invoke('visualReview:list'),
    docs: (listing) => listing.plans,
    changed: 'visualReview:changed',
    onProposed
  })
}

/** 開いているプロジェクトの価値ユースケース（.ferret/value-usecases/） */
export function useValueUseCases(folderPath: string | null, onProposed?: (docs: ValueUseCaseDoc[]) => void): {
  listing: ValueUseCaseListing
  pending: number
  reload: () => void
} {
  return useReviewDocs(folderPath, {
    empty: EMPTY_VALUES,
    load: () => window.ade.invoke('valueUseCase:list'),
    docs: (listing) => listing.docs,
    changed: 'valueUseCase:changed',
    onProposed
  })
}
