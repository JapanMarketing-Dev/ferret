import type { Breadcrumb, CloudflareOptions, Event } from '@sentry/cloudflare'
import type { Env } from './env'

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi
const BEARER = /Bearer\s+\S+/gi

/** 文字列からメール・IP・Bearer トークンを伏せる */
export function redact(text: string): string {
  return text.replace(BEARER, 'Bearer [redacted]').replace(EMAIL, '[email]').replace(IPV4, '[ip]').replace(IPV6, '[ip]')
}

function stripQuery(url: string): string {
  const i = url.search(/[?#]/)
  return i === -1 ? url : url.slice(0, i)
}

function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  const { data: _data, ...rest } = b
  return { ...rest, message: b.message ? redact(b.message) : b.message }
}

/**
 * Sentry に送る前に個人情報を落とす。
 * - リクエストの本文・ヘッダ（Authorization・Cookie・CF-Connecting-IP を含む）・クエリを削除
 * - ユーザー情報（IP を含む）を削除
 * - メッセージ・例外文・パンくずのメール／IP を伏せ、パンくずの data を削除
 */
export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) {
    const url = event.request.url ? stripQuery(event.request.url) : undefined
    event.request = { method: event.request.method, url }
  }
  event.user = undefined
  event.server_name = undefined
  event.extra = undefined
  if (event.contexts) {
    const { response: _response, ...rest } = event.contexts
    event.contexts = rest
  }
  if (event.message) event.message = redact(event.message)
  if (event.logentry?.message) event.logentry.message = redact(event.logentry.message)
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redact(ex.value)
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)
  if (event.tags) {
    for (const [k, v] of Object.entries(event.tags)) {
      if (typeof v === 'string') event.tags[k] = redact(v)
    }
  }
  return event
}

export function sentryOptions(env: Env): CloudflareOptions {
  const dsn = typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.trim() !== '' ? env.SENTRY_DSN.trim() : undefined
  return {
    dsn,
    enabled: dsn !== undefined,
    // 収集の段階で個人情報を取らない（v11 の dataCollection）。beforeSend でも念のため落とす。
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
    },
    // 性能は Workers Observability のトレースで見る。Sentry はエラー検知だけ。
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  }
}
