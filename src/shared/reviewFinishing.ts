/**
 * 録画を止めたあと、裏でレビューを作る進み具合（main の finishStoppedReview → 画面の右下のカード）。
 * 段階は 音声の保存 → 残りの文字起こし → 指摘と画像のまとめ。割合は実際の処理の進み（残りの区切りの数・書いた画像の枚数）から出す。
 * 録画が終わったあと本当に動いているか分からず不安、という声から（2026-11-17）
 */

export type ReviewFinishStage = 'audio' | 'transcribe' | 'review'

export interface ReviewFinishJob {
  /** レビューのフォルダの id（追記の録画なら足し先のレビュー） */
  id: string
  /** 0〜100 の整数。下がらない */
  percent: number
  stage: ReviewFinishStage
  /** 文字起こしで、まだ済んでいない区切りの数（文字起こしの段階だけ） */
  pendingChunks?: number
  /** 録ったプロジェクトの名前（別のプロジェクトへ移っても、どの録画か分かるように） */
  projectName?: string
}

/** 段階ごとの割合の幅（音声の保存 0〜5、文字起こし 5〜85、まとめ 85〜100） */
const STAGE_RANGE: Record<ReviewFinishStage, readonly [number, number]> = {
  audio: [0, 5],
  transcribe: [5, 85],
  review: [85, 100]
}

/** その段階の中の進み（0〜1）から、全体の割合（0〜100 の整数）。まとめが済むまでは 100 にしない */
export function finishPercent(stage: ReviewFinishStage, fraction: number): number {
  const [from, to] = STAGE_RANGE[stage]
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return Math.min(99, Math.floor(from + (to - from) * f))
}

/** 文字起こしの段階の進み（0〜1）。始めたときに残っていた区切りの数と、いま残っている数から */
export function transcribeFraction(initialPending: number, pending: number): number {
  if (!(initialPending > 0)) return 1
  const left = Math.min(initialPending, Math.max(0, pending))
  return (initialPending - left) / initialPending
}

/** 前の割合より下げない（区切りが足されて割合が戻って見えないように） */
export function nextPercent(previous: number, next: number): number {
  return Math.max(previous, Math.min(100, Math.max(0, Math.round(next))))
}
