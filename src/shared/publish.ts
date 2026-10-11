/**
 * 「発信」（X への投稿。ブログは CMS ができたら同じ下書きから出す）の型と、main と画面のあいだの約束。
 *
 * - 下書き（PostDraft）は AI が作る（バックグラウンドで最近の変更から／開いた文章から）か、利用者が書く
 * - 画像・動画はプロジェクトの中のファイル（相対パス）か、選んで取り込んだファイル（main だけが実パスを持つ）
 * - X への投稿は内蔵ブラウザで X の投稿画面を開き、本文（スレッドも）とメディアを入れる。「ポスト」は利用者が押す
 */

export type PostDraftSource = 'ai-background' | 'ai-text' | 'manual'
export type PostDraftStatus = 'new' | 'posted' | 'dismissed'
export type PostMediaKind = 'image' | 'video'

export interface PostMediaInfo {
  /** 下書きの中での識別子 */
  id: string
  kind: PostMediaKind
  /** 見せる名前（ファイル名） */
  name: string
  bytes: number
  /** 小さな見本（data:image/png;base64,…）。作れなければ無し */
  thumbnail?: string
}

/** 画面へ返す下書き（メディアの実パスは含めない） */
export interface PostDraftInfo {
  id: string
  createdAt: string
  updatedAt: string
  source: PostDraftSource
  status: PostDraftStatus
  /** 一覧に出す短い題（AI が付ける。手書きは本文の先頭） */
  title: string
  /** 本文（長ければ X ではスレッドに分ける。src/shared/xPost.ts） */
  text: string
  media: PostMediaInfo[]
  /** AI が何をもとに書いたか（コミットの範囲・ファイル名など。一覧の補足） */
  basis?: string
  postedAt?: string
}

export interface PublishBackgroundInfo {
  enabled: boolean
  running: boolean
  lastRunAt?: string
  /** 直近の失敗（AI が使えない・変更が無いなど）。成功したら消える */
  lastError?: string
}

export interface PublishSnapshot {
  drafts: PostDraftInfo[]
  background: PublishBackgroundInfo
}

/** 画面から送る下書きの変更 */
export interface PostDraftPatch {
  title?: string
  text?: string
  status?: PostDraftStatus
  /** 残すメディアの id（並び順）。省略時は変えない */
  mediaOrder?: string[]
}

/** AI に作らせる指示 */
export interface PublishGenerateRequest {
  /** もとにする文章（開いているファイルの内容など）。省略時はプロジェクトの最近の変更 */
  text?: string
  /** 文章の出どころ（ファイル名など） */
  textLabel?: string
  /** 利用者からの一言（「リリースの告知で」など） */
  hint?: string
}

export type XComposeResult =
  /** 投稿画面に入れ終えた（利用者が「ポスト」を押す） */
  | { status: 'filled'; parts: number; media: number }
  /** X にログインしていない（内蔵ブラウザでログインしてもらう） */
  | { status: 'login' }
  /** 画面の形が変わって入れられなかった。本文だけ入れた投稿画面（intent）を開いた */
  | { status: 'fallback'; reason: string }

export const PUBLISH_LIMITS = {
  draftsPerProject: 100,
  titleChars: 80,
  textChars: 20_000,
  hintChars: 500,
  sourceTextChars: 40_000,
  /** X の1件の投稿に付けられる数 */
  xImages: 4,
  xVideos: 1,
  xImageBytes: 5 * 1024 * 1024,
  xGifBytes: 15 * 1024 * 1024,
  xVideoBytes: 512 * 1024 * 1024,
  /** バックグラウンドで作るのは、未使用の下書きがこれより少ないときだけ */
  backgroundMaxPending: 12,
  /** 1回のバックグラウンドの生成で作る数 */
  backgroundBatch: 3,
  /** バックグラウンドの生成の最短の間隔 */
  backgroundIntervalMs: 2 * 60 * 60 * 1000
} as const

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'] as const

export function mediaKindOf(path: string): PostMediaKind | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image'
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video'
  return null
}

/** X の1件に付けられる組み合わせか（画像は4枚まで・動画は1本で画像と混ぜない）。問題なければ null */
export function xMediaProblem(media: ReadonlyArray<{ kind: PostMediaKind; bytes: number; name: string }>): 'tooMany' | 'mixed' | 'tooLarge' | null {
  const images = media.filter((m) => m.kind === 'image')
  const videos = media.filter((m) => m.kind === 'video')
  if (videos.length && images.length) return 'mixed'
  if (images.length > PUBLISH_LIMITS.xImages || videos.length > PUBLISH_LIMITS.xVideos) return 'tooMany'
  const tooLarge = media.some((m) => m.kind === 'video' ? m.bytes > PUBLISH_LIMITS.xVideoBytes
    : m.bytes > (m.name.toLowerCase().endsWith('.gif') ? PUBLISH_LIMITS.xGifBytes : PUBLISH_LIMITS.xImageBytes))
  return tooLarge ? 'tooLarge' : null
}
