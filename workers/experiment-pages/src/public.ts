import { isValidSlug } from './contract'
import { hmacHex, randomNonce } from './crypto'
import { getPublishedPage, insertInterest, recordEvent, takeCounter } from './db'
import { type Env, hashSalt } from './env'
import { messagePage, notFoundPage, renderPage, thanksPage } from './html'
import { buildCsp, emptyResponse, htmlResponse, mediaType, readBodyLimited } from './http'
import { parseInterestForm } from './interest'
import { log } from './log'
import { resolvePosthog } from './posthog'
import { jstDay, utcHour } from './time'
import { clientIp, isBot, isSameOriginRequest } from './visitor'

export const IP_LIMIT_PER_HOUR = 5
export const SLUG_LIMIT_PER_DAY = 200
export const MAX_FORM_BYTES = 32 * 1024
/** 表示・CTA の回数制限（超えてもページは返すが、数えない・書かない） */
export const VIEW_IP_LIMIT_PER_HOUR = 60
export const CTA_IP_LIMIT_PER_HOUR = 30
export const EVENT_SLUG_LIMIT_PER_DAY = 20_000
/** 重複除外ハッシュの行数の上限（slug・日・種類ごと） */
export const SEEN_CAP_PER_DAY = 5_000

function simple(status: number, body: (nonce: string) => string, extra?: Record<string, string>): Response {
  const nonce = randomNonce()
  return htmlResponse(body(nonce), status, buildCsp({ nonce }), extra)
}

/** 未登録・下書き・不正な slug で同じ形の 404 を返す */
export function notFound(): Response {
  return simple(404, notFoundPage)
}

/** 訪問者の重複除外ハッシュ。IP・日付・slug だけから作る（UA を変えても別人にならない） */
async function visitorHash(salt: string, request: Request, day: string, slug: string): Promise<string> {
  return hmacHex(salt, `visit|${day}|${slug}|${clientIp(request)}`)
}

/**
 * IP ごと（1 時間）→ slug ごと（1 日）の順に、上限未満なら 1 増やして true。
 * 上限に達したカウンタには書かない。IP が上限なら slug のカウンタには触れない
 */
async function underEventLimits(
  env: Env,
  salt: string,
  request: Request,
  slug: string,
  kind: 'view' | 'cta',
  now: Date,
): Promise<boolean> {
  const ipKey = `${kind === 'view' ? 'vip' : 'cip'}:${await hmacHex(salt, `rl|${clientIp(request)}`)}`
  const ipLimit = kind === 'view' ? VIEW_IP_LIMIT_PER_HOUR : CTA_IP_LIMIT_PER_HOUR
  if (!(await takeCounter(env.DB, ipKey, utcHour(now), new Date(now.getTime() + 2 * 3_600_000).toISOString(), ipLimit)))
    return false
  const slugKey = `${kind === 'view' ? 'vslug' : 'cslug'}:${slug}`
  if (
    !(await takeCounter(
      env.DB,
      slugKey,
      jstDay(now),
      new Date(now.getTime() + 2 * 86_400_000).toISOString(),
      EVENT_SLUG_LIMIT_PER_DAY,
    ))
  ) {
    log('warn', 'event_rate_limited', { slug, kind, scope: 'slug' })
    return false
  }
  return true
}

async function countEvent(env: Env, request: Request, slug: string, kind: 'view' | 'cta', now: Date): Promise<void> {
  const salt = hashSalt(env)
  if (!salt) {
    log('warn', 'hash_salt_missing', { slug })
    return
  }
  if (isBot(request.headers.get('User-Agent'))) return
  if (!(await underEventLimits(env, salt, request, slug, kind, now))) return
  const day = jstDay(now)
  const hash = await visitorHash(salt, request, day, slug)
  await recordEvent(env.DB, slug, day, kind, hash, SEEN_CAP_PER_DAY)
}

export async function handlePage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  now: Date,
): Promise<Response> {
  if (!isValidSlug(slug)) return notFound()
  const page = await getPublishedPage(env.DB, slug)
  if (!page) return notFound()
  ctx.waitUntil(
    countEvent(env, request, slug, 'view', now).catch((err) => log('error', 'count_view_failed', { slug, err })),
  )
  const nonce = randomNonce()
  const posthog = resolvePosthog(env)
  const html = renderPage({ slug, title: page.title, content: page.content, nonce, posthog })
  return htmlResponse(html, 200, buildCsp({ nonce, script: true, extraOrigins: posthog?.origins ?? [] }))
}

export async function handleCta(request: Request, env: Env, slug: string, now: Date): Promise<Response> {
  if (!isSameOriginRequest(request)) return simple(403, (n) => messagePage(n, '送信できません', '不正な送信元です。'))
  if (!isValidSlug(slug)) return notFound()
  const page = await getPublishedPage(env.DB, slug)
  if (!page) return notFound()
  await countEvent(env, request, slug, 'cta', now)
  return emptyResponse(204)
}

export async function handleInterest(request: Request, env: Env, slug: string, now: Date): Promise<Response> {
  if (!isSameOriginRequest(request)) return simple(403, (n) => messagePage(n, '送信できません', '不正な送信元です。'))
  if (!isValidSlug(slug)) return notFound()
  const page = await getPublishedPage(env.DB, slug)
  if (!page) return notFound()

  const salt = hashSalt(env)
  if (!salt) {
    log('error', 'hash_salt_missing', { slug })
    return simple(503, (n) => messagePage(n, '受付を停止しています', '時間をおいてもう一度お試しください。'))
  }
  if (mediaType(request) !== 'application/x-www-form-urlencoded') {
    return simple(415, (n) => messagePage(n, '送信できません', 'フォームから送信してください。', slug))
  }
  const body = await readBodyLimited(request, MAX_FORM_BYTES)
  if (!body.ok) {
    const status = body.reason === 'too_large' ? 413 : 400
    return simple(status, (n) =>
      messagePage(n, '送信できません', '入力内容が大きすぎるか、形式が正しくありません。', slug),
    )
  }

  // 回数制限（D1 の固定窓カウンタ）。IP はハッシュにしてから数える。
  const ipKey = `ip:${await hmacHex(salt, `rl|${clientIp(request)}`)}`
  if (
    !(await takeCounter(
      env.DB,
      ipKey,
      utcHour(now),
      new Date(now.getTime() + 2 * 3_600_000).toISOString(),
      IP_LIMIT_PER_HOUR,
    ))
  ) {
    log('warn', 'interest_rate_limited', { slug, scope: 'ip' })
    return simple(429, (n) => messagePage(n, '送信回数の上限です', 'しばらく時間をおいてからお試しください。'), {
      'Retry-After': '3600',
    })
  }
  if (
    !(await takeCounter(
      env.DB,
      `slug:${slug}`,
      jstDay(now),
      new Date(now.getTime() + 2 * 86_400_000).toISOString(),
      SLUG_LIMIT_PER_DAY,
    ))
  ) {
    log('warn', 'interest_rate_limited', { slug, scope: 'slug' })
    return simple(
      429,
      (n) => messagePage(n, '送信回数の上限です', '本日の受付は終了しました。明日以降にお試しください。'),
      {
        'Retry-After': '86400',
      },
    )
  }

  const parsed = parseInterestForm(new URLSearchParams(body.text))
  if (parsed.kind === 'honeypot') {
    log('info', 'interest_honeypot', { slug })
    return simple(200, (n) => thanksPage(n, slug, ''))
  }
  if (parsed.kind === 'invalid') {
    return simple(400, (n) => messagePage(n, '入力内容を確認してください', parsed.messages, slug))
  }
  const v = parsed.value
  await insertInterest(
    env.DB,
    {
      slug,
      experimentId: page.experimentId,
      day: jstDay(now),
      name: v.name,
      company: v.company,
      email: v.email,
      message: v.message,
    },
    now,
  )
  log('info', 'interest_stored', { slug, experimentId: page.experimentId })
  return simple(200, (n) => thanksPage(n, slug, v.name))
}
