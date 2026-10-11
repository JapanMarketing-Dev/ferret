/**
 * 「発信」（X とブログへの投稿）の型と、main と画面のあいだの約束。
 *
 * - 下書き（PostDraft）は AI が作る（「何を発信したいか」から／バックグラウンドで最近の変更から／開いた文章から）か、利用者が書く。
 *   1つの下書きに X の本文とブログの記事（題と Markdown の本文）を持つ
 * - 画像・動画はプロジェクトの中のファイル（AI がフォルダから選ぶ）か、選んで取り込んだファイル（main だけが実パスを持つ）
 * - X へは X API（利用者が自分の Client ID で認証した OAuth 2.0 のトークン）で投稿する。ブログは WordPress・EmDash の API で投稿する
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
  /** プロジェクトの中のファイルなら、プロジェクトからの相対パス（記事の本文の ![説明](相対パス) で場所を指せる） */
  ref?: string
  /** 小さな見本（data:image/png;base64,…）。作れなければ無し */
  thumbnail?: string
}

/** ブログの記事。本文は Markdown（![説明](相対パスかファイル名) で付けた画像・動画の場所を指す） */
export interface PostArticle {
  title: string
  body: string
}

export type PublishTargetKind = 'x' | BlogKind

/** 投稿した記録 */
export interface PostResultInfo {
  kind: PublishTargetKind
  /** ブログの接続先の id（X は無し） */
  targetId?: string
  /** 見せる名前（@ユーザー名・ブログの名前） */
  targetName: string
  /** 投稿を開く URL（分からなければ無し） */
  url?: string
  /** ブログで下書きとして置いたもの */
  draft?: boolean
  at: string
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
  article: PostArticle
  /** 投稿した記録（古い順） */
  results: PostResultInfo[]
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
  articleTitle?: string
  articleBody?: string
}

/** AI に作らせる指示 */
export interface PublishGenerateRequest {
  /** もとにする文章（開いているファイルの内容など）。省略時はプロジェクトの最近の変更 */
  text?: string
  /** 文章の出どころ（ファイル名など） */
  textLabel?: string
  /** 何を発信したいか（「新しい版の告知」など）。あれば、それを主題にしてフォルダから画像・動画を選ぶ */
  intent?: string
}

export type BlogKind = 'wordpress' | 'emdash'

/** ブログの接続先（画面へ返す形。パスワード・トークンは含めない） */
export interface BlogTargetInfo {
  id: string
  kind: BlogKind
  name: string
  /** サイトの URL（https://example.com。WordPress はサイトのトップ、EmDash は /_emdash の手前） */
  baseUrl: string
  /** WordPress のユーザー名 */
  username?: string
  /** EmDash の記事のコレクション（既定 posts） */
  collection?: string
}

/** ブログの接続先を足すときに画面から送るもの。URL と秘密はいつも一緒に送る（秘密を別の接続先へ向け直させない） */
export interface BlogTargetInput {
  kind: BlogKind
  name: string
  baseUrl: string
  username?: string
  /** WordPress のアプリケーションパスワード／EmDash の API トークン */
  secret: string
  collection?: string
}

export interface XConnectionInfo {
  /** 保存した Client ID（秘密ではない。X の開発者ポータルで作った Native App のもの） */
  clientId: string | null
  connected: boolean
  username?: string
  /** 開発者ポータルに登録してもらうコールバック URL */
  callbackUrl: string
}

export interface PublishConnectionsInfo {
  x: XConnectionInfo
  blogs: BlogTargetInfo[]
  /** 暗号化して保存できるか（できなければ起動中だけ覚える） */
  persisted: boolean
}

/** X へ投稿した結果 */
export interface PostXResult {
  url: string
  /** 投稿できた件数（スレッドの途中で失敗したら parts より少ない） */
  posted: number
  parts: number
  /** 途中で失敗したときの理由 */
  error?: string
}

/** ブログへ投稿した結果 */
export interface PostBlogResult {
  url?: string
  draft: boolean
}

/** X の OAuth 2.0（PKCE・Native App）。コールバックは端末の中で受ける（ポートは開発者ポータルに登録するので固定） */
export const X_OAUTH = {
  authorizeUrl: 'https://x.com/i/oauth2/authorize',
  tokenUrl: 'https://api.x.com/2/oauth2/token',
  revokeUrl: 'https://api.x.com/2/oauth2/revoke',
  apiBase: 'https://api.x.com/2',
  host: '127.0.0.1',
  port: 47815,
  path: '/x/callback',
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'] as readonly string[],
  /** 認証を待つ時間 */
  waitMs: 5 * 60 * 1000
} as const

export function xCallbackUrl(): string {
  return `http://${X_OAUTH.host}:${X_OAUTH.port}${X_OAUTH.path}`
}

/** X の Client ID の形（英数字と - _ だけ） */
export function validXClientId(raw: string): boolean {
  return /^[A-Za-z0-9_-]{8,200}$/.test(raw)
}

/**
 * ブログの URL を確かめて整える（末尾の / を外す）。https だけ（手元で動かす EmDash のため localhost・127.0.0.1 は http も可）。
 * ユーザー名・パスワード入り・? や # 入りは断る。だめなら null
 */
export function normalizeBlogUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  if (u.username || u.password || u.search || u.hash) return null
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.origin}${path}`
}

/** EmDash のコレクション名の形 */
export function validCollection(raw: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(raw)
}

export const PUBLISH_LIMITS = {
  draftsPerProject: 100,
  titleChars: 80,
  textChars: 20_000,
  intentChars: 2_000,
  articleTitleChars: 200,
  articleChars: 60_000,
  blogTargets: 20,
  blogNameChars: 80,
  blogSecretChars: 500,
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
