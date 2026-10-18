/**
 * 実験ランディングページ Worker の管理 API 契約。
 *
 * デスクトップアプリ（business-ADE）から型と検証関数だけを import できるよう、
 * このファイルは依存ゼロ（Workers の API も使わない）に保つ。
 */

// ---------------------------------------------------------------------------
// 上限値
// ---------------------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/
export const EXPERIMENT_ID_PATTERN = /^X\d{2,4}$/
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const MAX_BULLETS = 8
export const MAX_STATS_RANGE_DAYS = 366
export const MAX_ADMIN_BODY_BYTES = 32 * 1024

export const LIMITS = {
  title: 120,
  headline: 120,
  subhead: 300,
  bullet: 200,
  priceText: 120,
  ctaLabel: 40,
  formIntro: 500,
  consentText: 1000,
  footerNote: 500,
} as const

export const INTEREST_LIMITS = {
  name: 100,
  company: 200,
  email: 254,
  message: 2000,
} as const

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type PageStatus = 'draft' | 'published'

/** ページ本文。すべてプレーンテキスト（HTML は受け付けず、表示時にエスケープする）。 */
export interface PageContent {
  headline: string
  subhead: string
  bullets: string[]
  priceText: string
  ctaLabel: string
  formIntro: string
  consentText: string
  footerNote: string
}

/** PUT /api/pages/:slug */
export interface PutPageRequest {
  experimentId: string
  title: string
  content: PageContent
  status: PageStatus
}

/** GET /api/pages/:slug・PUT・unpublish の応答 */
export interface PageResponse {
  slug: string
  experimentId: string
  title: string
  content: PageContent
  status: PageStatus
  createdAt: string
  updatedAt: string
  /** 公開中のときだけ ISO 8601。下書きは null。 */
  publishedAt: string | null
  /** 公開 URL のパス（例: /p/my-page） */
  path: string
}

export interface PageSummary {
  slug: string
  experimentId: string
  title: string
  status: PageStatus
  updatedAt: string
  publishedAt: string | null
}

/** GET /api/pages */
export interface PageListResponse {
  pages: PageSummary[]
}

/** GET /api/pages/:slug/stats?from=YYYY-MM-DD&to=YYYY-MM-DD（日付は日本時間・両端を含む） */
export interface StatsResponse {
  slug: string
  experimentId: string
  from: string
  to: string
  /** ボットを除いた表示回数（再読み込みも数える） */
  views: number
  /** 日ごとの重複を除いた訪問者数の合計 */
  uniqueVisitors: number
  /** 日ごとの重複を除いた CTA クリック数の合計 */
  ctaClicks: number
  /** 関心表明の件数（保持期間 180 日を過ぎたものは数えない） */
  interests: number
}

export interface Interest {
  id: string
  slug: string
  experimentId: string
  name: string
  company: string
  email: string
  message: string
  createdAt: string
}

/** GET /api/pages/:slug/interests（個人情報を含む） */
export interface InterestListResponse {
  slug: string
  interests: Interest[]
}

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'method_not_allowed'
  | 'internal_error'

/** すべての API エラーの形 */
export interface ErrorResponse {
  error: { code: ErrorCode; message: string; details?: ValidationIssue[] }
}

export interface ValidationIssue {
  path: string
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

// 改行（\n）以外の制御文字と、表示を乱す双方向制御文字を拒否する。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const FORBIDDEN_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push({ path: path ? `${path}.${key}` : key, message: '未知の項目です' })
    }
  }
}

function checkText(
  value: unknown,
  path: string,
  max: number,
  required: boolean,
  issues: ValidationIssue[],
  allowNewline = true,
): string {
  if (typeof value !== 'string') {
    issues.push({ path, message: '文字列で指定してください' })
    return ''
  }
  if (required && value.trim().length === 0) {
    issues.push({ path, message: '必須です' })
  }
  if ([...value].length > max) {
    issues.push({ path, message: `${max}文字以内にしてください` })
  }
  if (FORBIDDEN_CHARS.test(value) || (!allowNewline && value.includes('\n'))) {
    issues.push({ path, message: '使えない制御文字が含まれています' })
  }
  return value
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug)
}

export function isValidExperimentId(id: unknown): id is string {
  return typeof id === 'string' && EXPERIMENT_ID_PATTERN.test(id)
}

const CONTENT_KEYS = [
  'headline',
  'subhead',
  'bullets',
  'priceText',
  'ctaLabel',
  'formIntro',
  'consentText',
  'footerNote',
] as const

export function validatePageContent(input: unknown, path = 'content'): ValidationResult<PageContent> {
  const issues: ValidationIssue[] = []
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path, message: 'オブジェクトで指定してください' }] }
  }
  checkKeys(input, CONTENT_KEYS, path, issues)
  for (const key of CONTENT_KEYS) {
    if (!(key in input)) issues.push({ path: `${path}.${key}`, message: '必須です' })
  }
  const headline = checkText(input.headline, `${path}.headline`, LIMITS.headline, true, issues, false)
  const subhead = checkText(input.subhead, `${path}.subhead`, LIMITS.subhead, false, issues)
  const priceText = checkText(input.priceText, `${path}.priceText`, LIMITS.priceText, false, issues, false)
  const ctaLabel = checkText(input.ctaLabel, `${path}.ctaLabel`, LIMITS.ctaLabel, true, issues, false)
  const formIntro = checkText(input.formIntro, `${path}.formIntro`, LIMITS.formIntro, false, issues)
  const consentText = checkText(input.consentText, `${path}.consentText`, LIMITS.consentText, true, issues)
  const footerNote = checkText(input.footerNote, `${path}.footerNote`, LIMITS.footerNote, false, issues)
  const bullets: string[] = []
  if (!Array.isArray(input.bullets)) {
    if ('bullets' in input) issues.push({ path: `${path}.bullets`, message: '配列で指定してください' })
  } else {
    if (input.bullets.length > MAX_BULLETS) {
      issues.push({ path: `${path}.bullets`, message: `${MAX_BULLETS}個以内にしてください` })
    }
    input.bullets.forEach((b, i) => {
      bullets.push(checkText(b, `${path}.bullets[${i}]`, LIMITS.bullet, true, issues, false))
    })
  }
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: { headline, subhead, bullets, priceText, ctaLabel, formIntro, consentText, footerNote },
  }
}

const PUT_KEYS = ['experimentId', 'title', 'content', 'status'] as const

export function validatePutPageRequest(input: unknown): ValidationResult<PutPageRequest> {
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: '', message: 'JSON オブジェクトで指定してください' }] }
  }
  const issues: ValidationIssue[] = []
  checkKeys(input, PUT_KEYS, '', issues)
  if (!isValidExperimentId(input.experimentId)) {
    issues.push({ path: 'experimentId', message: 'X01 の形（X と数字 2〜4 桁）で指定してください' })
  }
  const title = checkText(input.title, 'title', LIMITS.title, true, issues, false)
  if (input.status !== 'draft' && input.status !== 'published') {
    issues.push({ path: 'status', message: "'draft' か 'published' を指定してください" })
  }
  const content = validatePageContent(input.content)
  if (!content.ok) issues.push(...content.issues)
  if (issues.length > 0 || !content.ok) return { ok: false, issues }
  return {
    ok: true,
    value: {
      experimentId: input.experimentId as string,
      title,
      content: content.value,
      status: input.status as PageStatus,
    },
  }
}

/** YYYY-MM-DD が実在する日付かどうか */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  if (y < 2000 || y > 2100) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** 2 つの日付の差（日数）。to - from。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export function validateStatsRange(from: unknown, to: unknown): ValidationResult<{ from: string; to: string }> {
  const issues: ValidationIssue[] = []
  if (!isValidDate(from)) issues.push({ path: 'from', message: 'YYYY-MM-DD の実在する日付で指定してください' })
  if (!isValidDate(to)) issues.push({ path: 'to', message: 'YYYY-MM-DD の実在する日付で指定してください' })
  if (issues.length > 0) return { ok: false, issues }
  const span = daysBetween(from as string, to as string)
  if (span < 0) return { ok: false, issues: [{ path: 'to', message: 'to は from 以降にしてください' }] }
  if (span + 1 > MAX_STATS_RANGE_DAYS) {
    return { ok: false, issues: [{ path: 'to', message: `期間は${MAX_STATS_RANGE_DAYS}日以内にしてください` }] }
  }
  return { ok: true, value: { from: from as string, to: to as string } }
}

export function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    isPlainObject(value) &&
    isPlainObject(value.error) &&
    typeof value.error.code === 'string' &&
    typeof value.error.message === 'string'
  )
}
