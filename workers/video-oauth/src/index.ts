/**
 * 動画の投稿（TikTok）のトークンの交換（Cloudflare Worker）。旧 Solocut の tools/oauth-worker を移したもの（Movie_ADE の docs/14）。
 * TikTok の Login Kit for Desktop は /v2/oauth/token/ にクライアントシークレットが要るが、シークレットはアプリに入れられないので、ここが足す。
 *
 *   POST /oauth/tiktok/token    form: client_key, code, code_verifier, redirect_uri → authorization_code の交換
 *   POST /oauth/tiktok/refresh  form: client_key, refresh_token                     → リフレッシュ
 *   POST /oauth/tiktok/revoke   form: client_key, token                             → 取り消し（接続の解除）
 *
 * - client_key で本番（TIKTOK_CLIENT_KEY / _SECRET）かサンドボックス（TIKTOK_SANDBOX_CLIENT_KEY / _SECRET）かを選ぶ。どちらでもないキーは 400
 * - デスクトップのアプリに登録した2つのリダイレクト以外は受けない
 * - TikTok の JSON を状態コードごとそのまま返す。何もログに出さず、保存もしない（Cache-Control: no-store、observability はオフ）
 * - CORS は出さない（アプリの main から呼ぶ）
 */

export interface Env {
  TIKTOK_CLIENT_KEY?: string
  TIKTOK_CLIENT_SECRET?: string
  TIKTOK_SANDBOX_CLIENT_KEY?: string
  TIKTOK_SANDBOX_CLIENT_SECRET?: string
}

/** 設定済みのキーとシークレットの組（本番が先）。片方が欠けた組は使わない */
export function clients(env: Env): { key: string; secret: string }[] {
  const out: { key: string; secret: string }[] = []
  for (const [k, sec] of [
    [env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET],
    [env.TIKTOK_SANDBOX_CLIENT_KEY, env.TIKTOK_SANDBOX_CLIENT_SECRET]
  ] as const) {
    const key = k?.trim()
    const secret = sec?.trim()
    if (key && secret) out.push({ key, secret })
  }
  return out
}

export const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/'
export const TIKTOK_REVOKE = 'https://open.tiktokapis.com/v2/oauth/revoke/'
export const REDIRECT_URIS = ['http://127.0.0.1:47823/tiktok/callback', 'http://localhost:47823/tiktok/callback']
export const MAX_BODY = 8 * 1024

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS })
const fail = (status: number, error: string, description?: string) => json(status, { error, ...(description ? { error_description: description } : {}) })

async function readForm(req: Request): Promise<URLSearchParams | Response> {
  const type = req.headers.get('content-type') ?? ''
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) return fail(413, 'too_large')
  const text = await req.text()
  if (text.length > MAX_BODY) return fail(413, 'too_large')
  if (type.includes('application/json')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>
      if (!o || typeof o !== 'object' || Array.isArray(o)) return fail(400, 'invalid_request', 'body must be an object')
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') p.set(k, v)
      return p
    } catch {
      return fail(400, 'invalid_request', 'malformed JSON')
    }
  }
  return new URLSearchParams(text)
}

const field = (p: URLSearchParams, k: string, max = 2048): string | null => {
  const v = p.get(k)
  return v && v.length <= max ? v : null
}

async function upstream(url: string, body: URLSearchParams, fetchFn: typeof fetch): Promise<Response> {
  let r: Response
  try {
    r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }, body: body.toString() })
  } catch {
    return fail(502, 'upstream_unreachable')
  }
  const text = await r.text()
  if (!text) return new Response(null, { status: r.status === 200 ? 204 : r.status, headers: { 'Cache-Control': 'no-store' } })
  try {
    JSON.parse(text)
  } catch {
    return fail(502, 'upstream_invalid')
  }
  return new Response(text, { status: r.status, headers: HEADERS })
}

export async function handle(req: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const route = /^\/oauth\/tiktok\/(token|refresh|revoke)$/.exec(path)?.[1]
  if (!route) return fail(404, 'not_found')
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } })
  const configured = clients(env)
  if (!configured.length) return fail(500, 'not_configured')
  const form = await readForm(req)
  if (form instanceof Response) return form
  const sent = form.get('client_key')
  if (!sent) return fail(400, 'invalid_request', 'client_key is required')
  const client = configured.find((c) => c.key === sent)
  if (!client) return fail(400, 'invalid_client')
  const { key, secret } = client

  if (route === 'token') {
    const code = field(form, 'code')
    const verifier = field(form, 'code_verifier', 128)
    const redirect = field(form, 'redirect_uri', 512)
    if (!code || !verifier || !redirect) return fail(400, 'invalid_request', 'code, code_verifier and redirect_uri are required')
    if (verifier.length < 43 || !/^[A-Za-z0-9\-._~]+$/.test(verifier)) return fail(400, 'invalid_request', 'bad code_verifier')
    if (!REDIRECT_URIS.includes(redirect)) return fail(400, 'invalid_request', 'redirect_uri is not registered')
    const body = new URLSearchParams({ client_key: key, client_secret: secret, code, grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier })
    return upstream(TIKTOK_TOKEN, body, fetchFn)
  }
  if (route === 'refresh') {
    const refresh = field(form, 'refresh_token')
    if (!refresh) return fail(400, 'invalid_request', 'refresh_token is required')
    return upstream(TIKTOK_TOKEN, new URLSearchParams({ client_key: key, client_secret: secret, grant_type: 'refresh_token', refresh_token: refresh }), fetchFn)
  }
  const token = field(form, 'token')
  if (!token) return fail(400, 'invalid_request', 'token is required')
  return upstream(TIKTOK_REVOKE, new URLSearchParams({ client_key: key, client_secret: secret, token }), fetchFn)
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env).catch(() => fail(500, 'internal_error'))
  }
}
