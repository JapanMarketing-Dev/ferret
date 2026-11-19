/**
 * メールアドレスでログインして、自分の指摘を PC をまたいで、チームの指摘をメンバーをまたいで共有する（Cloudflare Worker workers/feedback-cloud）。
 * アプリ（src/main/feedbackCloud/）・Worker・Worker が配る Web 画面が同じ決まりを使う。この形・大きさ・code の正本。
 *
 * - ログインはメールに届く6桁のコード（パスワードなし）。アプリは Bearer のトークン、Web は HttpOnly の cookie
 * - 送る指摘は、プロジェクトの名前・どこで・題・日時・文だけ。手元のファイルのパス（ユーザー名を含む）は送らない
 * - 1台（deviceId）ごとに「今の指摘の全部」を置き換えで送る。消した指摘はその台の分から消える
 * - 読むときは、自分の全部の台の分と、入っているチームのメンバーの分を返す
 */
import type { FeedbackSource } from './feedbackSkill'

export const CLOUD_BASE = 'https://account.ferretade.dev'

export const CLOUD_LIMITS = {
  emailChars: 254,
  nameChars: 60,
  teamNameChars: 60,
  deviceNameChars: 60,
  projectChars: 120,
  titleChars: 200,
  textChars: 2000,
  /** 1台が置ける指摘の数（新しい順にこの数まで） */
  entriesPerDevice: 3000,
  /** 1人が置ける台の数 */
  devicesPerUser: 20,
  /** 1人が入れるチーム・1チームの人数 */
  teamsPerUser: 20,
  membersPerTeam: 100,
  /** ログインのコードの有効時間と、1つのコードで試せる回数 */
  codeTtlMs: 15 * 60 * 1000,
  codeAttempts: 5,
  /** アプリのトークンは 1 年、Web の cookie は 30 日 */
  appSessionMs: 365 * 24 * 60 * 60 * 1000,
  webSessionMs: 30 * 24 * 60 * 60 * 1000,
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** 送る本文の上限（指摘の全部を1回で送る） */
  uploadBytes: 4 * 1024 * 1024,
  /** 指摘1件に付ける画像の数と、画像1枚の大きさ */
  imagesPerEntry: 4,
  imageBytes: 5 * 1024 * 1024,
  /** POST /v1/images/missing に1回で渡せる hash の数 */
  imageCheckHashes: 200,
  /** 1人が置ける画像の合計（同じ画像を2人が上げれば、2人ともに数える。超えると PUT は limit） */
  imageQuotaBytes: 1024 * 1024 * 1024
} as const

/** 画像の形式（SVG は <img> でだけ出し、Worker は sandbox の CSP 付きで返す） */
export const CLOUD_IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' } as const
export type CloudImageType = keyof typeof CLOUD_IMAGE_TYPES

/**
 * 指摘に付ける画像。中身の SHA-256 で指す（同じ画像は1回だけ上げる）。
 * box は人が囲んだ場所（画像の width×height の座標で x,y,w,h）。録画の指摘の画像は枠が描き込み済みなので box は無い。
 * 上げ方: POST /v1/images/missing {hashes} → {missing}、PUT /v1/images/<hash>（本文は画像のバイト、content-type は CLOUD_IMAGE_TYPES）。
 * 読み方: GET /v1/images/<hash>（自分か、同じチームの人が上げた画像だけ）
 */
export interface CloudImage {
  hash: string
  type: CloudImageType
  box?: { x: number; y: number; w: number; h: number; width: number; height: number }
}

export const CLOUD_SOURCES: readonly FeedbackSource[] = ['visual-review', 'value-usecases', 'recording', 'agent-prompt']

export const CODE_PATTERN = /^\d{6}$/
/** アプリのトークン・招待のトークン（256 bit の16進） */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/
/** 台・チーム・ユーザーの id（128 bit の16進） */
export const ID_PATTERN = /^[0-9a-f]{32}$/
/** 指摘の key（文の SHA-256 の16進） */
export const ENTRY_KEY_PATTERN = /^[0-9a-f]{64}$/
/** 画像の hash（中身の SHA-256 の16進） */
export const IMAGE_HASH_PATTERN = /^[0-9a-f]{64}$/

export const CLOUD_ERROR_STATUS = {
  bad_request: 400,
  bad_email: 400,
  bad_code: 400,
  code_expired: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  limit: 409,
  rate_limited: 429,
  mail_failed: 502,
  server: 500
} as const

export type CloudErrorCode = keyof typeof CLOUD_ERROR_STATUS

/** 送る指摘の1件 */
export interface CloudEntry {
  key: string
  project: string
  source: FeedbackSource
  title?: string
  /** ISO 8601 */
  at?: string
  text: string
  /** その状態の画像（どの状態に何の指摘か）。最大 CLOUD_LIMITS.imagesPerEntry */
  images?: CloudImage[]
}

/** PUT /v1/feedback の本文 */
export interface CloudUpload {
  deviceId: string
  deviceName: string
  entries: CloudEntry[]
}

/** 読んだ指摘（誰の・どの台の） */
export interface CloudEntryRead extends CloudEntry {
  deviceId: string
  deviceName: string
  /** 書いた人（自分のものでは自分） */
  author: { id: string; name: string; email: string }
}

export interface CloudTeamSummary {
  id: string
  name: string
  role: 'owner' | 'member'
  members: Array<{ id: string; name: string; email: string; role: 'owner' | 'member' }>
  /** まだ受けていない招待（持ち主だけに返す） */
  invites?: Array<{ email: string; expiresAt: string }>
}

export interface CloudMe {
  id: string
  email: string
  name: string
  teams: CloudTeamSummary[]
  devices: Array<{ id: string; name: string; updatedAt: string; entries: number }>
}

/** GET /v1/feedback の答え */
export interface CloudFeedback {
  me: { id: string; email: string; name: string }
  /** 自分の全部の台の指摘 */
  mine: CloudEntryRead[]
  /** チームごとの、自分以外のメンバーの指摘 */
  teams: Array<{ id: string; name: string; entries: CloudEntryRead[] }>
}

/** メールアドレスを小文字にして確かめる。合わなければ null */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (!email || email.length > CLOUD_LIMITS.emailChars) return null
  // 1つの @・空白と制御文字なし・ドメインに点
  if (!/^[^\s@<>()",;:\\[\]\u0000-\u001f\u007f]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null
  return email
}

/** 1行の文を整える（制御文字を空白に・前後の空白を落とす）。長すぎれば切る。文字列でなければ null */
export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

/** 複数行の文を整える（改行は残す） */
export function cleanBlock(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

/** 指摘の key（プロジェクト・どこで・文から。同じ指摘は同じ key になる） */
export async function cloudEntryKey(entry: { project: string; source: FeedbackSource; text: string }): Promise<string> {
  const bytes = new TextEncoder().encode(`${entry.project}\n${entry.source}\n${entry.text}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 送られた指摘を1件確かめる。合わなければ null */
export function sanitizeCloudEntry(raw: unknown): CloudEntry | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.key !== 'string' || !ENTRY_KEY_PATTERN.test(r.key)) return null
  if (!CLOUD_SOURCES.includes(r.source as FeedbackSource)) return null
  const project = cleanLine(r.project, CLOUD_LIMITS.projectChars)
  const text = cleanBlock(r.text, CLOUD_LIMITS.textChars)
  if (!project || !text) return null
  const title = r.title === undefined ? '' : cleanLine(r.title, CLOUD_LIMITS.titleChars)
  if (title === null) return null
  let at: string | undefined
  if (typeof r.at === 'string' && r.at) {
    const ms = Date.parse(r.at)
    if (!Number.isFinite(ms)) return null
    at = new Date(ms).toISOString()
  }
  const images = sanitizeCloudImages(r.images)
  return { key: r.key, project, source: r.source as FeedbackSource, ...(title ? { title } : {}), ...(at ? { at } : {}), text, ...(images.length ? { images } : {}) }
}

/** 指摘に付いた画像を確かめる。合わないものは落とし、hash の重複を除いて上限まで */
export function sanitizeCloudImages(raw: unknown): CloudImage[] {
  if (!Array.isArray(raw)) return []
  const out: CloudImage[] = []
  const seen = new Set<string>()
  const num = (v: unknown, max = 100_000) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null)
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.hash !== 'string' || !IMAGE_HASH_PATTERN.test(r.hash) || seen.has(r.hash)) continue
    if (typeof r.type !== 'string' || !Object.hasOwn(CLOUD_IMAGE_TYPES, r.type)) continue
    let box: CloudImage['box']
    if (r.box && typeof r.box === 'object') {
      const b = r.box as Record<string, unknown>
      const [x, y, w, h, width, height] = [num(b.x), num(b.y), num(b.w), num(b.h), num(b.width), num(b.height)]
      if (x !== null && y !== null && w && h && width && height) box = { x, y, w, h, width, height }
    }
    seen.add(r.hash)
    out.push({ hash: r.hash, type: r.type as CloudImageType, ...(box ? { box } : {}) })
    if (out.length >= CLOUD_LIMITS.imagesPerEntry) break
  }
  return out
}

/** PUT /v1/feedback の本文を確かめる。合わなければ null。指摘は key で重複を除き、新しい順に上限まで */
export function sanitizeCloudUpload(raw: unknown): CloudUpload | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.deviceId !== 'string' || !ID_PATTERN.test(r.deviceId)) return null
  const deviceName = cleanLine(r.deviceName, CLOUD_LIMITS.deviceNameChars)
  if (!deviceName) return null
  if (!Array.isArray(r.entries)) return null
  const seen = new Set<string>()
  const entries: CloudEntry[] = []
  for (const item of r.entries) {
    const e = sanitizeCloudEntry(item)
    if (!e || seen.has(e.key)) continue
    seen.add(e.key)
    entries.push(e)
  }
  entries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  return { deviceId: r.deviceId, deviceName, entries: entries.slice(0, CLOUD_LIMITS.entriesPerDevice) }
}

/** メールアドレスの @ の前（名前が無いときの表示名） */
export function defaultName(email: string): string {
  return email.split('@')[0]!.slice(0, CLOUD_LIMITS.nameChars)
}

/** 設定の画面へ返すログインの状態（cloud:status。トークンは渡さない） */
export interface CloudAppStatus {
  loggedIn: boolean
  email?: string
  /** ログインを覚えておけるか（暗号化できない環境・dev 起動では、その起動の間だけ） */
  persisted: boolean
  /** 最後に同期できた日時（ISO 8601） */
  lastSyncAt?: string
  /** 自分の指摘の数（全部の PC の分） */
  mine?: number
  /** チームのメンバーの指摘の数 */
  team?: number
}
