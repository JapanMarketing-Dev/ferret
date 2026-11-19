/**
 * Ferret アカウントの Worker（workers/feedback-cloud）と話す。Electron に依存させない（単体テストで偽の fetch を渡すため）。
 * トークンは Authorization ヘッダーでだけ送り、URL・ログ・エラーメッセージに出さない。Origin は付けない（Web の cookie と分ける）
 */
import {
  CLOUD_BASE,
  CLOUD_ERROR_STATUS,
  CODE_PATTERN,
  TOKEN_PATTERN,
  cleanLine,
  sanitizeCloudEntry,
  type CloudEntryRead,
  type CloudErrorCode,
  type CloudFeedback,
  type CloudMe,
  type CloudUpload
} from '@shared/feedbackCloud'

export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>

/** Worker が返した失敗。code だけを持つ（本文・トークンは持たない） */
export class CloudApiError extends Error {
  constructor(readonly code: CloudErrorCode | 'network' | 'bad_response', readonly status = 0) {
    super(`feedback cloud: ${code}`)
  }
}

export interface CloudClientOptions {
  fetch: CloudFetch
  base?: string
  userAgent?: string
  timeoutMs?: number
}

const ERROR_CODES = new Set(Object.keys(CLOUD_ERROR_STATUS))

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 読んだ指摘を1件確かめる。合わなければ null */
export function sanitizeEntryRead(raw: unknown): CloudEntryRead | null {
  const entry = sanitizeCloudEntry(raw)
  if (!entry || !isObject(raw)) return null
  const author = isObject(raw.author) ? raw.author : null
  const deviceName = cleanLine(raw.deviceName, 60)
  if (typeof raw.deviceId !== 'string' || deviceName === null || !author) return null
  const name = cleanLine(author.name, 60)
  if (typeof author.id !== 'string' || name === null || typeof author.email !== 'string') return null
  return { ...entry, deviceId: raw.deviceId, deviceName, author: { id: author.id, name, email: author.email } }
}

function sanitizeMe(raw: unknown): CloudMe | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.email !== 'string' || typeof raw.name !== 'string') return null
  if (!Array.isArray(raw.teams) || !Array.isArray(raw.devices)) return null
  return raw as unknown as CloudMe
}

function sanitizeFeedback(raw: unknown): CloudFeedback | null {
  if (!isObject(raw) || !isObject(raw.me) || !Array.isArray(raw.mine) || !Array.isArray(raw.teams)) return null
  const me = raw.me
  if (typeof me.id !== 'string' || typeof me.email !== 'string' || typeof me.name !== 'string') return null
  const entries = (list: unknown): CloudEntryRead[] => (Array.isArray(list) ? list.flatMap((e) => sanitizeEntryRead(e) ?? []) : [])
  const teams = raw.teams.flatMap((t) => {
    if (!isObject(t) || typeof t.id !== 'string') return []
    const name = cleanLine(t.name, 60)
    return name === null ? [] : [{ id: t.id, name, entries: entries(t.entries) }]
  })
  return { me: { id: me.id, email: me.email, name: me.name }, mine: entries(raw.mine), teams }
}

export class CloudClient {
  private readonly base: string

  constructor(private readonly opt: CloudClientOptions) {
    this.base = opt.base ?? CLOUD_BASE
  }

  private async call(path: string, init: RequestInit, token?: string): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers)
    if (token !== undefined) {
      if (!TOKEN_PATTERN.test(token)) throw new CloudApiError('unauthorized')
      headers.set('authorization', `Bearer ${token}`)
    }
    if (this.opt.userAgent) headers.set('user-agent', this.opt.userAgent)
    let res: Response
    try {
      res = await this.opt.fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.opt.timeoutMs ?? 30_000) })
    } catch {
      throw new CloudApiError('network')
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new CloudApiError(res.ok ? 'bad_response' : statusCode(res.status), res.status)
    }
    if (!isObject(body)) throw new CloudApiError('bad_response', res.status)
    if (!res.ok || body.ok === false) {
      const code = typeof body.code === 'string' && ERROR_CODES.has(body.code) ? body.code as CloudErrorCode : statusCode(res.status)
      throw new CloudApiError(code, res.status)
    }
    return body
  }

  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  }

  /** メールにコードを送ってもらう */
  async start(email: string): Promise<void> {
    await this.call('/v1/auth/start', this.json('POST', { email, client: 'app' }))
  }

  /** コードを確かめて、トークンと自分の情報を受け取る */
  async verify(email: string, code: string): Promise<{ token: string; me: CloudMe }> {
    if (!CODE_PATTERN.test(code)) throw new CloudApiError('bad_code')
    const body = await this.call('/v1/auth/verify', this.json('POST', { email, code, client: 'app' }))
    const me = sanitizeMe(body.me)
    if (typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token) || !me) throw new CloudApiError('bad_response')
    return { token: body.token, me }
  }

  async logout(token: string): Promise<void> {
    await this.call('/v1/auth/logout', { method: 'POST' }, token)
  }

  async me(token: string): Promise<CloudMe> {
    const body = await this.call('/v1/me', { method: 'GET' }, token)
    // 自分の情報はそのまま、または { ok, me } で返る
    const me = sanitizeMe(isObject(body.me) ? body.me : body)
    if (!me) throw new CloudApiError('bad_response')
    return me
  }

  /** この PC の指摘を置き換えで送る。置いた数を返す */
  async upload(token: string, upload: CloudUpload): Promise<number> {
    const body = await this.call('/v1/feedback', this.json('PUT', upload), token)
    return typeof body.stored === 'number' ? body.stored : upload.entries.length
  }

  /** 自分の全部の PC の指摘と、チームのメンバーの指摘 */
  async download(token: string): Promise<CloudFeedback> {
    const body = await this.call('/v1/feedback', { method: 'GET' }, token)
    const feedback = sanitizeFeedback(isObject(body.feedback) ? body.feedback : body)
    if (!feedback) throw new CloudApiError('bad_response')
    return feedback
  }
}

/** 本文の読めない失敗を、状態の番号から code にする */
function statusCode(status: number): CloudErrorCode | 'bad_response' {
  if (status === 401) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status === 413) return 'too_large'
  return status >= 500 ? 'server' : 'bad_response'
}
