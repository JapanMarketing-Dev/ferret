import type { Fps, ReviewItem, ReviewSession, SavedFeedback, TranscriptPiece } from '../review'

/** 確認する動画（完成動画・プレビュー）と、これまでの指摘 */
export interface ReviewTarget {
  name: string
  /** 動画のフォルダ（絶対パス） */
  dir: string
  title: string
  /** 再生する動画（チャンネルからの相対。ade-media://project/ で開く）。まだ書き出していなければ null */
  render: string | null
  fps: Fps
  /** 動画の長さ（フレーム。timeline の区間の終わり。分からなければ 0） */
  durationFrames: number
  lang: 'ja' | 'en'
  saved: SavedFeedback[]
}

/** 動画づくりの IPC（完成動画の確認・タイムコード付きの指摘）。チャネル名は `video:review:` で始める。担当: 動画タブ */
export interface VideoReviewIpc {
  'video:review:open': (name: string) => ReviewTarget
  /** 確認の声（16kHz モノラルの WAV）を置いて文字にする。id は新しく振る（指摘のフォルダ名になる） */
  'video:review:transcribe': (name: string, wav: Uint8Array | null) => { id: string; pieces: TranscriptPiece[]; warning?: string }
  /** 画面の rect（CSS ピクセル）を写して指摘 index の画像にする（ペン入りの動画のフレーム） */
  'video:review:snapshot': (name: string, id: string, index: number, rect: { x: number; y: number; width: number; height: number }) => boolean
  /** 指摘を feedback/<id>/ に書く。返す prompt は「この指摘を直して」の依頼文 */
  'video:review:save': (name: string, input: { id: string; session: ReviewSession; items: ReviewItem[] }) => { id: string; path: string; count: number; prompt: string; warnings: string[] }
  /** 保存しないで捨てる（inbox の声・画像を消す） */
  'video:review:discard': (name: string, id: string) => void
  /** 保存した指摘をもう一度 Agent へ頼むときの依頼文 */
  'video:review:prompt': (name: string, id: string) => string
}
export interface VideoReviewEvents {
  /** 指摘が増えた（保存した） */
  'video:review:changed': () => void
}

export const VIDEO_REVIEW_REQUESTS = [
  'video:review:open', 'video:review:transcribe', 'video:review:snapshot', 'video:review:save', 'video:review:discard', 'video:review:prompt'
] as const satisfies readonly (keyof VideoReviewIpc)[]
export const VIDEO_REVIEW_EVENTS = ['video:review:changed'] as const satisfies readonly (keyof VideoReviewEvents)[]
