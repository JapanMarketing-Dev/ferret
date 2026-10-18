import type { ErrorCode, ErrorResponse, ValidationIssue } from './contract'

export interface CspOptions {
  /** インライン style / script 用の nonce */
  nonce?: string
  /** インライン script を許可する（nonce 必須） */
  script?: boolean
  /** PostHog を使うときに許可する追加オリジン */
  extraOrigins?: readonly string[]
}

const BASE_CSP = ["default-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]

export function buildCsp(opts: CspOptions = {}): string {
  const parts = [...BASE_CSP]
  if (opts.nonce) {
    parts.push(`style-src 'nonce-${opts.nonce}'`)
    if (opts.script) {
      const extra = opts.extraOrigins ?? []
      parts.push(['script-src', `'nonce-${opts.nonce}'`, ...extra].join(' '))
      parts.push(['connect-src', "'self'", ...extra].join(' '))
    }
  }
  return parts.join('; ')
}

export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'

/** すべての応答に付けるセキュリティヘッダ */
export function applySecurityHeaders(headers: Headers, csp: string): Headers {
  headers.set('Content-Security-Policy', csp)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Permissions-Policy', PERMISSIONS_POLICY)
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
  return headers
}

export function htmlResponse(body: string, status: number, csp: string, extra?: Record<string, string>): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', ...extra })
  return new Response(body, { status, headers: applySecurityHeaders(headers, csp) })
}

export function textResponse(body: string, status: number, extra?: Record<string, string>): Response {
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })
  return new Response(body, { status, headers: applySecurityHeaders(headers, buildCsp()) })
}

export function emptyResponse(status: number, extra?: Record<string, string>): Response {
  return new Response(null, { status, headers: applySecurityHeaders(new Headers(extra), buildCsp()) })
}

export function jsonResponse(data: unknown, status = 200, extra?: Record<string, string>): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra })
  return new Response(JSON.stringify(data), { status, headers: applySecurityHeaders(headers, buildCsp()) })
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: '認証が必要です',
  not_found: '見つかりません',
  invalid_request: 'リクエストの内容が正しくありません',
  conflict: '既存のデータと矛盾します',
  payload_too_large: 'リクエスト本文が大きすぎます',
  unsupported_media_type: 'Content-Type は application/json にしてください',
  method_not_allowed: 'このメソッドは使えません',
  internal_error: 'サーバー内部でエラーが起きました',
}

export function jsonError(
  code: ErrorCode,
  status: number,
  message?: string,
  details?: ValidationIssue[],
  extra?: Record<string, string>,
): Response {
  const body: ErrorResponse = { error: { code, message: message ?? DEFAULT_MESSAGES[code] } }
  if (details && details.length > 0) body.error.details = details
  return jsonResponse(body, status, extra)
}

export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'invalid' }

/**
 * Content-Length を信用せず、ストリームを読みながら上限を超えた時点で打ち切る。
 */
export async function readBodyLimited(request: Request, limit: number): Promise<BodyResult> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null) {
    const n = Number(declared)
    if (!Number.isFinite(n) || n < 0) return { ok: false, reason: 'invalid' }
    if (n > limit) return { ok: false, reason: 'too_large' }
  }
  if (!request.body) return { ok: true, text: '' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** Content-Type のメディア型部分（小文字） */
export function mediaType(request: Request): string {
  return (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}
