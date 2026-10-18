import {
  type InterestListResponse,
  isValidSlug,
  MAX_ADMIN_BODY_BYTES,
  type PageListResponse,
  validatePutPageRequest,
  validateStatsRange,
} from './contract'
import { constantTimeEqual } from './crypto'
import { deleteInterest, getPage, getStats, listInterests, listPages, unpublishPage, upsertPage } from './db'
import { type Env, MIN_SECRET_LENGTH } from './env'
import { emptyResponse, jsonError, jsonResponse, mediaType, readBodyLimited } from './http'
import { log } from './log'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BEARER = /^Bearer ([\x21-\x7e]+)$/
const UNUSABLE = '\u0000admin-token-not-configured'

/**
 * Bearer トークンの照合。トークン未設定・32 文字未満なら常に拒否する。
 * 未設定でも比較処理は同じように走らせ、応答時間で設定の有無が分からないようにする。
 */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.length >= MIN_SECRET_LENGTH
  const match = BEARER.exec(request.headers.get('Authorization') ?? '')
  const presented = match?.[1] ?? ''
  const equal = await constantTimeEqual(presented, configured ? (env.ADMIN_TOKEN as string) : UNUSABLE)
  return configured && match !== null && equal
}

function methodNotAllowed(allow: string): Response {
  return jsonError('method_not_allowed', 405, undefined, undefined, { Allow: allow })
}

function badSlug(): Response {
  return jsonError('invalid_request', 400, 'slug は英小文字・数字・ハイフンの 3〜48 文字にしてください', [
    { path: 'slug', message: '^[a-z0-9-]{3,48}$ に合いません' },
  ])
}

function pageNotFound(): Response {
  return jsonError('not_found', 404, 'ページが見つかりません')
}

function strictParams(url: URL, allowed: readonly string[]): Response | null {
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key)) {
      return jsonError('invalid_request', 400, 'クエリに未知の項目があります', [
        { path: key, message: '未知の項目です' },
      ])
    }
    if (url.searchParams.getAll(key).length > 1) {
      return jsonError('invalid_request', 400, 'クエリの項目が重複しています', [
        { path: key, message: '重複しています' },
      ])
    }
  }
  return null
}

export async function handleAdmin(request: Request, env: Env, url: URL, now: Date): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return jsonError('unauthorized', 401, undefined, undefined, { 'WWW-Authenticate': 'Bearer' })
  }

  // 本文は 32KB まで。GET などでも本文を送ってきたら同じ上限で拒否する。
  const body = await readBodyLimited(request, MAX_ADMIN_BODY_BYTES)
  if (!body.ok) {
    return body.reason === 'too_large'
      ? jsonError('payload_too_large', 413, `リクエスト本文は ${MAX_ADMIN_BODY_BYTES} バイト以内にしてください`)
      : jsonError('invalid_request', 400, 'リクエスト本文を読み取れません')
  }

  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const method = request.method

  // /api/pages
  if (parts.length === 2 && parts[1] === 'pages') {
    if (method !== 'GET') return methodNotAllowed('GET')
    const q = strictParams(url, [])
    if (q) return q
    const res: PageListResponse = { pages: await listPages(env.DB) }
    return jsonResponse(res)
  }

  // /api/pages/:slug[/action]
  if (parts.length >= 3 && parts.length <= 4 && parts[1] === 'pages') {
    const slug = decodeSegment(parts[2] ?? '')
    const action = parts[3]
    if (action === undefined) {
      if (method === 'GET') {
        if (!isValidSlug(slug)) return badSlug()
        const q = strictParams(url, [])
        if (q) return q
        const page = await getPage(env.DB, slug)
        return page ? jsonResponse(page) : pageNotFound()
      }
      if (method === 'PUT') {
        if (!isValidSlug(slug)) return badSlug()
        return putPage(request, env, slug, body.text, now)
      }
      return methodNotAllowed('GET, PUT')
    }
    if (action === 'unpublish') {
      if (method !== 'POST') return methodNotAllowed('POST')
      if (!isValidSlug(slug)) return badSlug()
      const page = await unpublishPage(env.DB, slug, now)
      if (!page) return pageNotFound()
      log('info', 'page_unpublished', { slug })
      return jsonResponse(page)
    }
    if (action === 'stats') {
      if (method !== 'GET') return methodNotAllowed('GET')
      if (!isValidSlug(slug)) return badSlug()
      const q = strictParams(url, ['from', 'to'])
      if (q) return q
      const range = validateStatsRange(url.searchParams.get('from'), url.searchParams.get('to'))
      if (!range.ok) return jsonError('invalid_request', 400, '期間の指定が正しくありません', range.issues)
      const page = await getPage(env.DB, slug)
      if (!page) return pageNotFound()
      return jsonResponse(await getStats(env.DB, page, range.value.from, range.value.to))
    }
    if (action === 'interests') {
      if (method !== 'GET') return methodNotAllowed('GET')
      if (!isValidSlug(slug)) return badSlug()
      const q = strictParams(url, ['limit'])
      if (q) return q
      const rawLimit = url.searchParams.get('limit')
      let limit = 500
      if (rawLimit !== null) {
        if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000) {
          return jsonError('invalid_request', 400, 'limit は 1〜1000 の整数にしてください', [
            { path: 'limit', message: '1〜1000 の整数' },
          ])
        }
        limit = Number(rawLimit)
      }
      const page = await getPage(env.DB, slug)
      if (!page) return pageNotFound()
      const res: InterestListResponse = { slug, interests: await listInterests(env.DB, slug, limit) }
      return jsonResponse(res)
    }
  }

  // /api/interests/:id
  if (parts.length === 3 && parts[1] === 'interests') {
    if (method !== 'DELETE') return methodNotAllowed('DELETE')
    const id = decodeSegment(parts[2] ?? '')
    if (!UUID.test(id)) {
      return jsonError('invalid_request', 400, 'id の形式が正しくありません', [{ path: 'id', message: 'UUID' }])
    }
    const deleted = await deleteInterest(env.DB, id)
    if (!deleted) return jsonError('not_found', 404, '関心表明が見つかりません')
    log('info', 'interest_deleted')
    return emptyResponse(204)
  }

  return jsonError('not_found', 404)
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return ''
  }
}

async function putPage(request: Request, env: Env, slug: string, text: string, now: Date): Promise<Response> {
  if (mediaType(request) !== 'application/json') return jsonError('unsupported_media_type', 415)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return jsonError('invalid_request', 400, 'JSON として読み取れません')
  }
  const parsed = validatePutPageRequest(json)
  if (!parsed.ok) return jsonError('invalid_request', 400, '入力内容が正しくありません', parsed.issues)
  const result = await upsertPage(env.DB, slug, parsed.value, now)
  if (result.kind === 'conflict') {
    return jsonError('conflict', 409, `この slug は別の実験（${result.existingExperimentId}）に使われています`)
  }
  log('info', 'page_saved', { slug, status: result.page.status, created: result.kind === 'created' })
  return jsonResponse(result.page, result.kind === 'created' ? 201 : 200)
}
