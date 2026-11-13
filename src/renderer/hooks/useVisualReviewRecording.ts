import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewData } from '@shared/review'
import type { RecordingNote, ReviewDocKind, VisualPlan } from '@shared/visualReview'
import { beginRecordingFeedback, linkFinishedReview, updateRecordingNote, type PendingRecordingFeedback } from '@shared/visualReviewRecording'
import { organizeRunner } from '../lib/importedReview'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/** 録画が止まってから review:ready を待つ時間。これを過ぎても届かなければ（開始・停止の失敗）待つのをやめる */
const ABANDON_MS = 1500

/**
 * ビジュアルレビューの「声と書き込みでフィードバック」（@shared/visualReviewRecording）。
 * begin で待っている計画を控え、録画（App のいつものワンクリック録画）が止まって review:ready が届いたら、
 * いつもの整理をしてから main に計画へ添えてもらう（visualReview:attachRecording）。添えられなくてもレビューは残る（知らせるだけ）。
 * 録画が始まらなかった・止められなかった（review:ready が来ない）ときは、待つのをやめる（失敗は App の run が知らせている）。
 * 価値ユースケースの文書にも同じ流れで返す（kind が 'value-usecases'。添えるのは valueUseCase:attachRecording）
 */
export function useVisualReviewRecording({ folderPath, active, onReviewUpdated }: {
  folderPath: string | null
  /** 録画中・開始や停止の途中 */
  active: boolean
  /** 整理でレビューが変わった（開いている指摘を差し替える） */
  onReviewUpdated: (review: ReviewData) => void
}): {
  pending: PendingRecordingFeedback | null
  /** 声と書き込みの録画（の後のまとめ）の途中なら、返す先のタブ（ビジュアルレビュー・価値ユースケース）。録画を止めたあとに開くタブを決める */
  activeTab: () => ReviewDocKind | null
  /** 始めてよければ控えて true（このあと App が録画を始める） */
  begin: (kind: ReviewDocKind, plan: Pick<VisualPlan, 'id' | 'status' | 'revision'>, note: RecordingNote) => boolean
  updateNote: (kind: ReviewDocKind, planId: string, note: RecordingNote) => void
} {
  const t = useT()
  const toast = useToast()
  const [pending, setPending] = useState<PendingRecordingFeedback | null>(null)
  const ref = useRef<PendingRecordingFeedback | null>(null)
  const set = useCallback((next: PendingRecordingFeedback | null) => { ref.current = next; setPending(next) }, [])
  const folderRef = useRef(folderPath)
  folderRef.current = folderPath
  const activeRef = useRef(active)
  activeRef.current = active
  const updated = useRef(onReviewUpdated)
  updated.current = onReviewUpdated

  const begin = useCallback((kind: ReviewDocKind, plan: Pick<VisualPlan, 'id' | 'status' | 'revision'>, note: RecordingNote): boolean => {
    const result = beginRecordingFeedback({ current: ref.current, plan, folderPath: folderRef.current, recording: activeRef.current, note, kind })
    if (!result.ok) {
      if (result.reason === 'busy') toast({ tone: 'warning', message: t('visualReview.recording.busy') })
      return false
    }
    set(result.pending)
    return true
  }, [set, toast, t])

  const updateNote = useCallback((kind: ReviewDocKind, planId: string, note: RecordingNote) => {
    const next = updateRecordingNote(ref.current, planId, note, kind)
    if (next !== ref.current) set(next)
  }, [set])

  // 録画が止まった（・始まらなかった）のに review:ready が来なければ、待つのをやめる
  useEffect(() => {
    if (active || ref.current?.phase !== 'recording') return
    const timer = setTimeout(() => { if (!activeRef.current && ref.current?.phase === 'recording') set(null) }, ABANDON_MS)
    return () => clearTimeout(timer)
  }, [active, pending, set])

  useEffect(() => window.ade.on('review:ready', (review) => {
    const current = ref.current
    const link = linkFinishedReview(current, { reviewId: review.id, folderPath: folderRef.current })
    if (link === 'ignore' || !current) return
    if (link !== 'attach') {
      set(null)
      toast({ tone: 'warning', message: t('visualReview.recording.keptOtherProject'), duration: 0 })
      return
    }
    set({ ...current, phase: 'processing' })
    void (async () => {
      try {
        // いつもの整理（発言から指摘をまとめる）。使えなければルールの下書きのまま添える（失敗は main の IPC が Sentry へ送る）
        if (review.canOrganize) {
          const organized = await window.ade.invoke('review:organize', review.id, await organizeRunner()).catch(() => null)
          if (organized) updated.current(organized)
        }
        const outcome = await window.ade.invoke(current.kind === 'value-usecases' ? 'valueUseCase:attachRecording' : 'visualReview:attachRecording', current.planId, review.id, current.note, current.revision)
        if (outcome.state === 'sent') toast({ tone: 'success', message: outcome.message })
        else if (outcome.state === 'manual') {
          // 計画には書けた。Agent に届かなかったので、貼る文をクリップボードへ
          await navigator.clipboard.writeText(outcome.copyText).catch(() => undefined)
          toast({ tone: 'warning', message: `${outcome.message} ${t('visualReview.copied')}`, duration: 0 })
        } else toast({ tone: 'warning', message: outcome.message, duration: 0 })
      } catch (err) {
        toast({ tone: 'danger', message: t('visualReview.recording.failed', { message: errorMessage(err) }), duration: 0 })
      } finally {
        set(null)
      }
    })()
  }), [set, toast, t])

  const activeTab = useCallback(() => ref.current?.kind ?? null, [])
  return { pending, activeTab, begin, updateNote }
}
