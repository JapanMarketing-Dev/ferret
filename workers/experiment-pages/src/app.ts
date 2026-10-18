import * as Sentry from '@sentry/cloudflare'
import { handleAdmin } from './admin'
import type { Env } from './env'
import { emptyResponse, jsonError, textResponse } from './http'
import { log } from './log'
import { handleCta, handleInterest, handlePage, notFound } from './public'
import { runRetention } from './retention'

const ROBOTS = 'User-agent: *\nDisallow: /api/\n'

async function route(request: Request, env: Env, ctx: ExecutionContext, now: Date): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  if (path === '/api' || path.startsWith('/api/')) return handleAdmin(request, env, url, now)

  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'p' && parts.length === 2) {
    if (method !== 'GET') return textResponse('Method Not Allowed', 405, { Allow: 'GET' })
    return handlePage(request, env, ctx, parts[1] ?? '', now)
  }
  if (parts[0] === 'p' && parts.length === 3 && (parts[2] === 'cta' || parts[2] === 'interest')) {
    if (method !== 'POST') return textResponse('Method Not Allowed', 405, { Allow: 'POST' })
    return parts[2] === 'cta'
      ? handleCta(request, env, parts[1] ?? '', now)
      : handleInterest(request, env, parts[1] ?? '', now)
  }
  if (path === '/robots.txt' && method === 'GET') {
    return textResponse(ROBOTS, 200, { 'Cache-Control': 'public, max-age=86400' })
  }
  if (path === '/favicon.ico') return emptyResponse(204, { 'Cache-Control': 'public, max-age=86400' })
  return notFound()
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Date = new Date(),
): Promise<Response> {
  try {
    return await route(request, env, ctx, now)
  } catch (err) {
    Sentry.captureException(err)
    log('error', 'unhandled', { path: new URL(request.url).pathname, err })
    if (new URL(request.url).pathname.startsWith('/api')) return jsonError('internal_error', 500)
    return textResponse('サーバー内部でエラーが起きました', 500)
  }
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  try {
    await runRetention(env.DB, new Date(controller.scheduledTime))
  } catch (err) {
    Sentry.captureException(err)
    log('error', 'retention_failed', { err })
    throw err
  }
}
