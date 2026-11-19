/**
 * メールでログインして、自分の指摘を PC をまたいで・チームの指摘をメンバーをまたいで共有する（Cloudflare Worker）。
 * 形・大きさ・code の正本は src/shared/feedbackCloud.ts、手順は README.md。
 *
 * ログイン（アプリは Origin なし。Web はこの Worker が配る画面から同じオリジンで）:
 *   POST   /v1/auth/start                    {email, client} 6桁のコードをメールで送る（ユーザーがいてもいなくても同じ答え）
 *   POST   /v1/auth/verify                   {email, code, client} app → {token, me}・web → cookie と {me}
 *   POST   /v1/auth/logout                   セッションを消す
 * ログインのあと（アプリは Authorization: Bearer <token>、Web は cookie __Host-ferret_session）:
 *   GET    /v1/me                            CloudMe
 *   PATCH  /v1/me                            {name}
 *   PUT    /v1/feedback                      CloudUpload その PC の指摘を置き換える → {stored}
 *   GET    /v1/feedback                      CloudFeedback（自分の全部の PC の分と、チームのほかのメンバーの分）
 *   DELETE /v1/devices/<id>                  PC とその指摘を消す
 *   POST   /v1/images/missing                {hashes} → {missing}: まだ自分が上げていない画像（CLOUD_LIMITS.imageCheckHashes まで）
 *   PUT    /v1/images/<hash>                 本文は画像のバイト（content-type は CLOUD_IMAGE_TYPES）。中身の SHA-256 が hash と合うこと
 *   GET    /v1/images/<hash>                 自分か、同じチームの人が上げた画像だけ（Web の <img> は cookie で読む）
 *   POST   /v1/teams                         {name} チームを作る（作った人が持ち主）
 *   PATCH  /v1/teams/<id>                    {name}（持ち主）
 *   DELETE /v1/teams/<id>                    （持ち主）
 *   POST   /v1/teams/<id>/invites            {email} 招待のメールを送る（持ち主）
 *   DELETE /v1/teams/<id>/invites            {email} 招待を取り消す（持ち主）
 *   DELETE /v1/teams/<id>/members/<userId>   持ち主が外す・自分が抜ける（最後の持ち主は抜けられない）
 *   GET    /v1/invites/<token>               {teamName, email, inviter}（ログイン無しで。招待の画面が使う）
 *   POST   /v1/invites/<token>/accept        招待されたアドレスでログインしている人がメンバーになる
 * 画面:
 *   GET    /  /invite/<token>                静的な HTML（中身は /assets/app.js が上の API から読む）
 *
 * 守り:
 *   - コードは 6 桁、15 分、5 回まで。置くのは AUTH_SECRET の HMAC だけで、比べるのは長さのそろった定数時間の比較
 *   - 試みの回数は UPDATE ... RETURNING で数えてから比べる（同時に送っても回数を超えない）。合ったコードは消してから使う（二度使えない）
 *   - トークン（256 bit）は SHA-256 だけを置く。cookie は HttpOnly・Secure・SameSite=Lax・__Host-
 *   - Origin が PUBLIC_BASE 以外の要求は断る。Bearer の要求に Origin があれば断る。cookie で状態を変える要求は Origin が PUBLIC_BASE であること（CSRF）
 *   - 頻度の上限は狭い順に予約し、断られたら先に取った予約を戻す（feedback-relay と同じ決まり）
 *   - 画面は厳しい CSP（自分のスクリプトだけ）・noindex・Referrer を送らない。文字は textContent で出す
 *   - 失敗は短い code だけを返し、メールアドレス・IP・本文・トークン・コードはログに出さない
 *   - 画像は中身を上げた人だけが持ち主になる（hash を知っているだけでは読めない）。形式は先頭のバイトで確かめ、
 *     SVG はスクリプトらしいものを断る。返すときは sandbox の CSP・nosniff を付ける（画面では <img> でだけ出す）
 *   - 毎日の cron で、どの指摘からも指されなくなった持ち主の行を消し、持ち主のいなくなった画像を R2 から消す
 */
import {
  CLOUD_ERROR_STATUS,
  CLOUD_IMAGE_TYPES,
  CLOUD_LIMITS,
  CODE_PATTERN,
  ID_PATTERN,
  IMAGE_HASH_PATTERN,
  TOKEN_PATTERN,
  cleanLine,
  defaultName,
  normalizeEmail,
  sanitizeCloudImages,
  sanitizeCloudUpload,
  type CloudImageType,
  type CloudEntryRead,
  type CloudErrorCode,
  type CloudFeedback,
  type CloudMe,
  type CloudTeamSummary
} from '../../../src/shared/feedbackCloud'
import type { FeedbackSource } from '../../../src/shared/feedbackSkill'
import { FeedbackLimiter, limiterKey, sourceIdentity, type LimiterResult, type Window } from '../../feedback-relay/src/limiter'
import type { D1PreparedStatement, Env, ScheduledContext } from './env'
import {
  CLEANUP_BATCH,
  CLEANUP_ROUNDS,
  COOKIE_NAME,
  IMAGE_CHECK_PER_USER,
  IMAGE_GRACE_MS,
  IMAGE_PUT_PER_USER,
  INSERT_CHUNK_BYTES,
  INVITE_PER_USER,
  READ_LIMIT,
  SESSIONS_PER_USER,
  START_PER_EMAIL,
  START_PER_IP,
  UPLOAD_PER_USER,
  VERIFY_PER_EMAIL,
  VERIFY_PER_IP
} from './limits'
import { APP_CSS, APP_HTML, APP_JS } from './page'

export { FeedbackLimiter }

export type Deps = { now: () => number; random: (bytes: number) => string }

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const defaultDeps: Deps = {
  now: () => Date.now(),
  random: (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' }
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data:",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"
].join('; ')

function fail(code: CloudErrorCode, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status: CLOUD_ERROR_STATUS[code], headers: { ...JSON_HEADERS, ...extra } })
}

function json(body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...JSON_HEADERS, ...extra } })
}

class Rejection extends Error {
  constructor(readonly code: CloudErrorCode, readonly headers: Record<string, string> = {}) {
    super(code)
  }
}

type Ctx = { request: Request; env: Env; deps: Deps; now: number }
type Session = { userId: string; email: string; name: string; kind: 'app' | 'web'; tokenHash: string }

export async function handle(request: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const path = new URL(request.url).pathname
  try {
    // ほかのサイトからの要求は断る（CORS は出さない）
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== env.PUBLIC_BASE) return fail('forbidden')
    if (path === '/' || /^\/invite\/[^/]+$/.test(path)) return servePage(request)
    if (path.startsWith('/assets/')) return serveAsset(request, path)
    if (path.startsWith('/v1/')) return await api({ request, env, deps, now: deps.now() }, path.slice(4).split('/'))
    return fail('not_found')
  } catch (e) {
    if (e instanceof Rejection) return fail(e.code, e.headers)
    console.error('feedback-cloud: internal error', e instanceof Error ? e.name : typeof e)
    return fail('server')
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_controller: unknown, env: Env, ctx: ScheduledContext) => {
    ctx.waitUntil(cleanupImages(env, Date.now()).catch((e) => {
      console.error('feedback-cloud: cleanup failed', e instanceof Error ? e.name : typeof e)
    }))
  }
}

/* ── 画面 ─────────────────────────────────── */

function servePage(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('not_found')
  return new Response(request.method === 'HEAD' ? null : APP_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', ...SECURITY_HEADERS
    }
  })
}

function serveAsset(request: Request, path: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('not_found')
  const asset = path === '/assets/app.js' ? { body: APP_JS, type: 'text/javascript; charset=utf-8' }
    : path === '/assets/app.css' ? { body: APP_CSS, type: 'text/css; charset=utf-8' } : null
  if (!asset) return fail('not_found')
  return new Response(request.method === 'HEAD' ? null : asset.body, { headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS } })
}

/* ── 道具 ─────────────────────────────────── */

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))))
}

/** 長さのそろった文字列を定数時間で比べる */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const codeHash = (env: Env, email: string, code: string) => hmacHex(env.AUTH_SECRET, `login\u0000${email}\u0000${code}`)

/** 6桁のコード（偏りが出ないよう、1e6 の倍数に収まらない値は引き直す） */
function makeCode(deps: Deps): string {
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    const n = parseInt(deps.random(4), 16)
    if (n < ceiling) return String(n % 1_000_000).padStart(6, '0')
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

async function ask(env: Env, name: string, op: 'hit' | 'release', windows: readonly Window[], now: number): Promise<LimiterResult> {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name))
  const res = await stub.fetch(new Request('https://limiter.internal/', { method: 'POST', body: JSON.stringify({ op, windows, now }), headers: { 'content-type': 'application/json' } }))
  if (!res.ok) throw new Error('limiter failed')
  return (await res.json()) as LimiterResult
}

type Check = { kind: string; value: string; windows: readonly Window[] }

/** 枠を狭い順に1つずつ予約する。断られたら先に取った予約を戻す（feedback-relay と同じ決まり） */
async function admit(ctx: Ctx, checks: readonly Check[]): Promise<void> {
  const taken: Array<{ name: string; windows: readonly Window[] }> = []
  for (const check of checks) {
    const name = await limiterKey(ctx.env.RATE_LIMIT_SALT, check.kind, check.value)
    const result = await ask(ctx.env, name, 'hit', check.windows, ctx.now)
    if (!result.allowed) {
      await Promise.allSettled(taken.map((t) => ask(ctx.env, t.name, 'release', t.windows, ctx.now)))
      throw new Rejection('rate_limited', { 'retry-after': String(result.retryAfterSec) })
    }
    taken.push({ name, windows: check.windows })
  }
}

const ipOf = (request: Request) => sourceIdentity(request.headers.get('cf-connecting-ip') ?? 'unknown')

/** 本文を上限まで読む。超えたら null（全部は読まない） */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > max) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

async function readJson(request: Request, max = 8 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) throw new Rejection('bad_request')
  const raw = await readCapped(request, max)
  if (!raw) throw new Rejection('too_large')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new Rejection('bad_request')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Rejection('bad_request')
  return value as Record<string, unknown>
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

const sessionCookie = (token: string) => `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(CLOUD_LIMITS.webSessionMs / 1000)}`
const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

/** ログインの前の要求。app は Origin なし、web は自分の画面から（ログインの CSRF も防ぐ） */
function clientOf(ctx: Ctx, raw: unknown): 'app' | 'web' {
  if (raw !== 'app' && raw !== 'web') throw new Rejection('bad_request')
  const origin = ctx.request.headers.get('origin')
  if (raw === 'app' ? origin !== null : origin !== ctx.env.PUBLIC_BASE) throw new Rejection('forbidden')
  return raw
}

/** ログインしている人。state を変える cookie の要求は Origin が自分であること */
async function authenticate(ctx: Ctx): Promise<Session> {
  const { request, env } = ctx
  const auth = request.headers.get('authorization')
  let token: string
  let kind: 'app' | 'web'
  if (auth !== null) {
    if (request.headers.has('origin')) throw new Rejection('forbidden')
    const m = /^Bearer ([0-9a-f]{64})$/.exec(auth)
    if (!m) throw new Rejection('unauthorized')
    token = m[1]!
    kind = 'app'
  } else {
    const changes = request.method !== 'GET' && request.method !== 'HEAD'
    if (changes && request.headers.get('origin') !== env.PUBLIC_BASE) throw new Rejection('forbidden')
    const raw = readCookie(request, COOKIE_NAME)
    if (!raw || !TOKEN_PATTERN.test(raw)) throw new Rejection('unauthorized')
    token = raw
    kind = 'web'
  }
  const tokenHash = await sha256Hex(token)
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.kind = ? AND s.expires_at > ?'
  ).bind(tokenHash, kind, ctx.now).first<{ id: string; email: string; name: string }>()
  if (!row) throw new Rejection('unauthorized')
  return { userId: row.id, email: row.email, name: row.name, kind, tokenHash }
}

/* ── API の振り分け ───────────────────────────── */

async function api(ctx: Ctx, parts: string[]): Promise<Response> {
  const m = ctx.request.method
  const [a, b, c, d] = parts
  const n = parts.length
  if (a === 'auth' && n === 2 && m === 'POST') {
    if (b === 'start') return authStart(ctx)
    if (b === 'verify') return authVerify(ctx)
    if (b === 'logout') return logout(ctx)
  }
  if (a === 'me' && n === 1) {
    if (m === 'GET') return json({ ok: true, me: await loadMe(ctx, await authenticate(ctx)) })
    if (m === 'PATCH') return renameMe(ctx)
  }
  if (a === 'feedback' && n === 1) {
    if (m === 'GET') return readFeedback(ctx)
    if (m === 'PUT') return upload(ctx)
  }
  if (a === 'devices' && n === 2 && m === 'DELETE') return deleteDevice(ctx, b!)
  if (a === 'images' && n === 2) {
    if (b === 'missing' && m === 'POST') return missingImages(ctx)
    if (m === 'PUT') return putImage(ctx, b!)
    if (m === 'GET') return getImage(ctx, b!)
  }
  if (a === 'teams') {
    if (n === 1 && m === 'POST') return createTeam(ctx)
    if (n === 2 && m === 'PATCH') return renameTeam(ctx, b!)
    if (n === 2 && m === 'DELETE') return deleteTeam(ctx, b!)
    if (n === 3 && c === 'invites' && m === 'POST') return invite(ctx, b!)
    if (n === 3 && c === 'invites' && m === 'DELETE') return cancelInvite(ctx, b!)
    if (n === 4 && c === 'members' && m === 'DELETE') return removeMember(ctx, b!, d!)
  }
  if (a === 'invites') {
    if (n === 2 && m === 'GET') return readInvite(ctx, b!)
    if (n === 3 && c === 'accept' && m === 'POST') return acceptInvite(ctx, b!)
  }
  return fail('not_found')
}

/* ── ログイン ─────────────────────────────── */

async function sendMail(env: Env, to: string, subject: string, text: string): Promise<void> {
  try {
    await env.EMAIL.send({ from: { email: env.MAIL_FROM, name: 'Ferret' }, to, subject, text, html: textToHtml(text) })
  } catch (e) {
    // アドレスは出さない。種類だけ
    console.error('feedback-cloud: mail failed', (e as { code?: string }).code ?? (e instanceof Error ? e.name : typeof e))
    throw new Rejection('mail_failed')
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

function textToHtml(text: string): string {
  const body = escapeHtml(text).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')
  return `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;font-size:15px;line-height:1.7;color:#1f2328">${body}</div>`
}

async function authStart(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.request)
  clientOf(ctx, body.client)
  const email = normalizeEmail(body.email)
  if (!email) throw new Rejection('bad_email')
  await admit(ctx, [
    { kind: 'cloud-start-email', value: email, windows: START_PER_EMAIL },
    { kind: 'cloud-start-ip', value: ipOf(ctx.request), windows: START_PER_IP }
  ])
  const code = makeCode(ctx.deps)
  const hash = await codeHash(ctx.env, email, code)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM login_codes WHERE expires_at <= ?').bind(ctx.now),
    ctx.env.DB.prepare(
      'INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ' +
      'ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at'
    ).bind(email, hash, ctx.now + CLOUD_LIMITS.codeTtlMs, ctx.now)
  ])
  const minutes = Math.round(CLOUD_LIMITS.codeTtlMs / 60000)
  await sendMail(ctx.env, email, `Ferret のログインコード: ${code}`, [
    `Ferret のログインコードです（${minutes}分有効）。`,
    '',
    code,
    '',
    '心当たりがなければ、このメールは捨ててください。',
    '',
    `Your Ferret sign-in code is ${code} (valid for ${minutes} minutes).`
  ].join('\n'))
  return json({ ok: true })
}

async function authVerify(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx
  const body = await readJson(ctx.request)
  const client = clientOf(ctx, body.client)
  const email = normalizeEmail(body.email)
  if (!email) throw new Rejection('bad_email')
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!CODE_PATTERN.test(code)) throw new Rejection('bad_code')
  await admit(ctx, [
    { kind: 'cloud-verify-email', value: email, windows: VERIFY_PER_EMAIL },
    { kind: 'cloud-verify-ip', value: ipOf(ctx.request), windows: VERIFY_PER_IP }
  ])
  // 先に試みを数える（同時に送っても回数を超えない）
  const row = await env.DB.prepare(
    'UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND expires_at > ? AND attempts < ? RETURNING code_hash, attempts'
  ).bind(email, now, CLOUD_LIMITS.codeAttempts).first<{ code_hash: string; attempts: number }>()
  if (!row) {
    await env.DB.prepare('DELETE FROM login_codes WHERE email = ? AND (expires_at <= ? OR attempts >= ?)').bind(email, now, CLOUD_LIMITS.codeAttempts).run()
    throw new Rejection('code_expired')
  }
  if (!sameText(await codeHash(env, email, code), row.code_hash)) {
    if (row.attempts >= CLOUD_LIMITS.codeAttempts) await env.DB.prepare('DELETE FROM login_codes WHERE email = ? AND code_hash = ?').bind(email, row.code_hash).run()
    throw new Rejection('bad_code')
  }
  // 合ったコードは消してから使う（同じコードで二度ログインさせない）
  const used = await env.DB.prepare('DELETE FROM login_codes WHERE email = ? AND code_hash = ?').bind(email, row.code_hash).run()
  if ((used.meta?.changes ?? 0) !== 1) throw new Rejection('code_expired')

  const token = ctx.deps.random(32)
  const tokenHash = await sha256Hex(token)
  const ttl = client === 'app' ? CLOUD_LIMITS.appSessionMs : CLOUD_LIMITS.webSessionMs
  const userOf = 'SELECT id FROM users WHERE email = ?'
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(ctx.deps.random(16), email, defaultName(email), now),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = (${userOf}) AND expires_at <= ?`).bind(email, now),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, kind, expires_at, created_at) SELECT ?, id, ?, ?, ? FROM users WHERE email = ?`)
      .bind(tokenHash, client, now + ttl, now, email),
    env.DB.prepare(
      `DELETE FROM sessions WHERE user_id = (${userOf}) AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = (${userOf}) ORDER BY created_at DESC, token_hash LIMIT ?)`
    ).bind(email, email, SESSIONS_PER_USER)
  ])
  const user = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; name: string }>()
  if (!user) throw new Error('user missing')
  const me = await loadMe(ctx, { userId: user.id, email: user.email, name: user.name, kind: client, tokenHash })
  if (client === 'app') return json({ ok: true, token, me })
  return json({ ok: true, me }, { 'set-cookie': sessionCookie(token) })
}

async function logout(ctx: Ctx): Promise<Response> {
  let session: Session | null = null
  try {
    session = await authenticate(ctx)
  } catch (e) {
    // 切れたセッションでも cookie は消す（CSRF の拒否はそのまま返す）
    if (!(e instanceof Rejection) || e.code !== 'unauthorized') throw e
  }
  if (session) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run()
  const web = !ctx.request.headers.has('authorization')
  return json({ ok: true }, web ? { 'set-cookie': clearCookie() } : {})
}

/* ── 自分 ─────────────────────────────────── */

type TeamRow = { id: string; name: string; role: 'owner' | 'member' }

async function loadTeams(ctx: Ctx, userId: string): Promise<CloudTeamSummary[]> {
  const { env } = ctx
  const [teams, members, invites] = await Promise.all([
    env.DB.prepare('SELECT t.id, t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.created_at, t.id')
      .bind(userId).all<TeamRow>(),
    env.DB.prepare(
      'SELECT m.team_id, u.id, u.name, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id ' +
      "WHERE m.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?) ORDER BY m.role = 'owner' DESC, m.joined_at, u.email"
    ).bind(userId).all<{ team_id: string; id: string; name: string; email: string; role: 'owner' | 'member' }>(),
    env.DB.prepare(
      "SELECT i.team_id, i.email, i.expires_at FROM team_invites i JOIN team_members m ON m.team_id = i.team_id AND m.user_id = ? AND m.role = 'owner' " +
      'WHERE i.expires_at > ? ORDER BY i.created_at, i.email'
    ).bind(userId, ctx.now).all<{ team_id: string; email: string; expires_at: number }>()
  ])
  return teams.results.map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    members: members.results.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
    ...(t.role === 'owner' ? { invites: invites.results.filter((i) => i.team_id === t.id).map((i) => ({ email: i.email, expiresAt: iso(i.expires_at) })) } : {})
  }))
}

async function loadMe(ctx: Ctx, s: Session): Promise<CloudMe> {
  const [teams, devices] = await Promise.all([
    loadTeams(ctx, s.userId),
    ctx.env.DB.prepare(
      'SELECT d.id, d.name, d.updated_at, (SELECT COUNT(*) FROM entries e WHERE e.user_id = d.user_id AND e.device_id = d.id) AS n ' +
      'FROM devices d WHERE d.user_id = ? ORDER BY d.updated_at DESC, d.id'
    ).bind(s.userId).all<{ id: string; name: string; updated_at: number; n: number }>()
  ])
  return {
    id: s.userId,
    email: s.email,
    name: s.name,
    teams,
    devices: devices.results.map((d) => ({ id: d.id, name: d.name, updatedAt: iso(d.updated_at), entries: Number(d.n) }))
  }
}

async function renameMe(ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const body = await readJson(ctx.request)
  const name = cleanLine(body.name, CLOUD_LIMITS.nameChars)
  if (!name) throw new Rejection('bad_request')
  await ctx.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, s.userId).run()
  return json({ ok: true, me: await loadMe(ctx, { ...s, name }) })
}

/* ── 指摘 ─────────────────────────────────── */

async function upload(ctx: Ctx): Promise<Response> {
  const { env, now } = ctx
  const s = await authenticate(ctx)
  await admit(ctx, [{ kind: 'cloud-upload-user', value: s.userId, windows: UPLOAD_PER_USER }])
  const data = sanitizeCloudUpload(await readJson(ctx.request, CLOUD_LIMITS.uploadBytes))
  if (!data) throw new Rejection('bad_request')
  const devices = await env.DB.prepare('SELECT id FROM devices WHERE user_id = ?').bind(s.userId).all<{ id: string }>()
  if (!devices.results.some((d) => d.id === data.deviceId) && devices.results.length >= CLOUD_LIMITS.devicesPerUser) throw new Rejection('limit')

  // 指摘は JSON の配列で渡し、json_each で1つの文にまとめて入れる（D1 の1つの文に入れられる値の数の上限を避ける）
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  const encoder = new TextEncoder()
  for (const e of data.entries) {
    const item = JSON.stringify({ key: e.key, project: e.project, source: e.source, title: e.title ?? null, at: e.at ?? null, text: e.text, images: e.images ?? null })
    const bytes = encoder.encode(item).byteLength + 1
    if (current.length > 0 && size + bytes > INSERT_CHUNK_BYTES) {
      chunks.push(`[${current.join(',')}]`)
      current = []
      size = 0
    }
    current.push(item)
    size += bytes
  }
  if (current.length > 0) chunks.push(`[${current.join(',')}]`)

  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO devices (user_id, id, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at')
      .bind(s.userId, data.deviceId, data.deviceName, now),
    env.DB.prepare('DELETE FROM entries WHERE user_id = ? AND device_id = ?').bind(s.userId, data.deviceId),
    env.DB.prepare('DELETE FROM entry_images WHERE user_id = ? AND device_id = ?').bind(s.userId, data.deviceId),
    ...chunks.flatMap((chunk) => [
      env.DB.prepare(
        'INSERT OR REPLACE INTO entries (user_id, device_id, key, project, source, title, at, text, images) ' +
        "SELECT ?, ?, json_extract(value, '$.key'), json_extract(value, '$.project'), json_extract(value, '$.source'), " +
        "json_extract(value, '$.title'), json_extract(value, '$.at'), json_extract(value, '$.text'), json_extract(value, '$.images') FROM json_each(?)"
      ).bind(s.userId, data.deviceId, chunk),
      // どの指摘がどの画像を指しているか（掃除が索引で引く）。同じ塊から1つの文で入れる
      env.DB.prepare(
        "INSERT OR IGNORE INTO entry_images (user_id, device_id, key, hash) SELECT ?, ?, json_extract(e.value, '$.key'), json_extract(i.value, '$.hash') " +
        "FROM json_each(?) e, json_each(e.value, '$.images') i WHERE json_type(e.value, '$.images') = 'array'"
      ).bind(s.userId, data.deviceId, chunk)
    ])
  ]
  await env.DB.batch(statements)
  return json({ ok: true, stored: data.entries.length })
}

async function deleteDevice(ctx: Ctx, deviceId: string): Promise<Response> {
  const s = await authenticate(ctx)
  if (!ID_PATTERN.test(deviceId)) throw new Rejection('not_found')
  const [, , removed] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM entries WHERE user_id = ? AND device_id = ?').bind(s.userId, deviceId),
    ctx.env.DB.prepare('DELETE FROM entry_images WHERE user_id = ? AND device_id = ?').bind(s.userId, deviceId),
    ctx.env.DB.prepare('DELETE FROM devices WHERE user_id = ? AND id = ?').bind(s.userId, deviceId)
  ])
  if ((removed?.meta?.changes ?? 0) === 0) throw new Rejection('not_found')
  return json({ ok: true })
}

type EntryRow = {
  key: string; project: string; source: FeedbackSource; title: string | null; at: string | null; text: string; images: string | null
  device_id: string; device_name: string; author_id: string; author_name: string; author_email: string
}

const ENTRY_SELECT =
  'SELECT e.key, e.project, e.source, e.title, e.at, e.text, e.images, e.device_id, d.name AS device_name, u.id AS author_id, u.name AS author_name, u.email AS author_email ' +
  'FROM entries e JOIN devices d ON d.user_id = e.user_id AND d.id = e.device_id JOIN users u ON u.id = e.user_id '
const ENTRY_ORDER = ' ORDER BY e.at IS NULL, e.at DESC, e.key LIMIT ?'

function parseImages(raw: string | null) {
  if (!raw) return []
  try {
    return sanitizeCloudImages(JSON.parse(raw))
  } catch {
    return []
  }
}

function toEntry(r: EntryRow): CloudEntryRead {
  const images = parseImages(r.images)
  return {
    key: r.key, project: r.project, source: r.source, ...(r.title ? { title: r.title } : {}), ...(r.at ? { at: r.at } : {}), text: r.text,
    ...(images.length ? { images } : {}),
    deviceId: r.device_id, deviceName: r.device_name, author: { id: r.author_id, name: r.author_name, email: r.author_email }
  }
}

async function readFeedback(ctx: Ctx): Promise<Response> {
  const { env } = ctx
  const s = await authenticate(ctx)
  const teams = await env.DB.prepare('SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.created_at, t.id')
    .bind(s.userId).all<{ id: string; name: string }>()
  const [mine, ...perTeam] = await Promise.all([
    env.DB.prepare(`${ENTRY_SELECT}WHERE e.user_id = ?${ENTRY_ORDER}`).bind(s.userId, READ_LIMIT).all<EntryRow>(),
    ...teams.results.map((t) => env.DB.prepare(
      `${ENTRY_SELECT}JOIN team_members m ON m.user_id = e.user_id AND m.team_id = ? WHERE e.user_id <> ?${ENTRY_ORDER}`
    ).bind(t.id, s.userId, READ_LIMIT).all<EntryRow>())
  ])
  const body: CloudFeedback = {
    me: { id: s.userId, email: s.email, name: s.name },
    mine: mine!.results.map(toEntry),
    teams: teams.results.map((t, i) => ({ id: t.id, name: t.name, entries: perTeam[i]!.results.map(toEntry) }))
  }
  return json({ ok: true, ...body })
}

/* ── 画像 ─────────────────────────────────── */

const imageKey = (hash: string) => `img/${hash}`

/** 先頭のバイトで形式を確かめる。SVG はスクリプトらしいものを含めば断る（<img> でだけ出すので、念のための守り） */
export function sniffImage(type: CloudImageType, bytes: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b)
  if (type === 'png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (type === 'jpeg') return starts([0xff, 0xd8, 0xff])
  if (type === 'webp') return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return false
  }
  // 先頭の BOM・XML 宣言・コメント・空白を飛ばして <svg で始まること（DOCTYPE は実体の定義を持ち込めるので受けない）
  let rest = text.replace(/^﻿/, '')
  for (;;) {
    const next = rest.replace(/^\s+/, '').replace(/^<\?xml[^>]*\?>/i, '').replace(/^<!--[\s\S]*?-->/, '')
    if (next === rest) break
    rest = next
  }
  if (!/^<svg[\s>/]/i.test(rest)) return false
  return !/<script|<foreignObject|javascript:|\bon\w+\s*=|<!ENTITY/i.test(text)
}

const typeOfContent = (raw: string | null): CloudImageType | null => {
  const mime = (raw ?? '').split(';')[0]!.trim().toLowerCase()
  const found = (Object.keys(CLOUD_IMAGE_TYPES) as CloudImageType[]).find((k) => CLOUD_IMAGE_TYPES[k] === mime)
  return found ?? null
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
}

async function missingImages(ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const body = await readJson(ctx.request, 32 * 1024)
  const hashes = body.hashes
  if (!Array.isArray(hashes) || hashes.length > CLOUD_LIMITS.imageCheckHashes) throw new Rejection('bad_request')
  if (!hashes.every((h) => typeof h === 'string' && IMAGE_HASH_PATTERN.test(h))) throw new Rejection('bad_request')
  await admit(ctx, [{ kind: 'cloud-image-check-user', value: s.userId, windows: IMAGE_CHECK_PER_USER }])
  const unique = [...new Set(hashes as string[])]
  if (!unique.length) return json({ ok: true, missing: [] })
  // hash は JSON の配列で1つの値として渡す（D1 の1つの文に入れられる値の数の上限を避ける）
  const owned = await ctx.env.DB.prepare(
    'SELECT o.hash FROM image_owners o WHERE o.user_id = ? AND o.hash IN (SELECT value FROM json_each(?))'
  ).bind(s.userId, JSON.stringify(unique)).all<{ hash: string }>()
  const have = new Set(owned.results.map((r) => r.hash))
  return json({ ok: true, missing: unique.filter((h) => !have.has(h)) })
}

async function putImage(ctx: Ctx, hash: string): Promise<Response> {
  const { env, now } = ctx
  const s = await authenticate(ctx)
  if (!IMAGE_HASH_PATTERN.test(hash)) throw new Rejection('not_found')
  const type = typeOfContent(ctx.request.headers.get('content-type'))
  if (!type) throw new Rejection('bad_request')
  const owned = await env.DB.prepare('SELECT 1 AS x FROM image_owners WHERE hash = ? AND user_id = ?').bind(hash, s.userId).first()
  if (owned) return json({ ok: true, stored: false })
  await admit(ctx, [{ kind: 'cloud-image-put-user', value: s.userId, windows: IMAGE_PUT_PER_USER }])
  const bytes = await readCapped(ctx.request, CLOUD_LIMITS.imageBytes)
  if (!bytes) throw new Rejection('too_large')
  if (!bytes.byteLength || (await sha256Bytes(bytes)) !== hash || !sniffImage(type, bytes)) throw new Rejection('bad_request')
  const used = await env.DB.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM image_owners WHERE user_id = ?').bind(s.userId).first<{ n: number }>()
  if (Number(used?.n ?? 0) + bytes.byteLength > CLOUD_LIMITS.imageQuotaBytes) throw new Rejection('limit')
  // 中身で鍵を決めているので、もうあれば置き直さない（持ち主の行だけ足す）
  if (!(await env.MEDIA.head(imageKey(hash)))) await env.MEDIA.put(imageKey(hash), bytes, { httpMetadata: { contentType: CLOUD_IMAGE_TYPES[type] } })
  await env.DB.prepare('INSERT INTO image_owners (hash, user_id, type, bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash, user_id) DO NOTHING')
    .bind(hash, s.userId, type, bytes.byteLength, now).run()
  return json({ ok: true, stored: true })
}

async function getImage(ctx: Ctx, hash: string): Promise<Response> {
  const { env } = ctx
  const s = await authenticate(ctx)
  if (!IMAGE_HASH_PATTERN.test(hash)) throw new Rejection('not_found')
  // 自分が上げたか、同じチームの人が上げた画像だけ。それ以外は無いのと同じに答える
  const row = await env.DB.prepare(
    'SELECT o.type FROM image_owners o WHERE o.hash = ?1 AND (o.user_id = ?2 OR o.user_id IN ' +
    '(SELECT b.user_id FROM team_members a JOIN team_members b ON b.team_id = a.team_id WHERE a.user_id = ?2)) LIMIT 1'
  ).bind(hash, s.userId).first<{ type: CloudImageType }>()
  if (!row || !Object.hasOwn(CLOUD_IMAGE_TYPES, row.type)) throw new Rejection('not_found')
  const object = await env.MEDIA.get(imageKey(hash))
  if (!object?.body) throw new Rejection('not_found')
  return new Response(object.body, {
    headers: {
      'content-type': CLOUD_IMAGE_TYPES[row.type],
      'content-length': String(object.size),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
      ...SECURITY_HEADERS
    }
  })
}

/**
 * 画像の掃除（毎日の cron）。どの指摘からも指されなくなって IMAGE_GRACE_MS より古い持ち主の行を消し、
 * 持ち主のいなくなった画像を R2 から消す。1回に CLEANUP_BATCH 行を CLEANUP_ROUNDS 回まで（残りは次の日）。
 * 消している間に同じ画像を上げ直した人がいれば、その持ち主の行も消す（missing で「無い」と出るので、アプリが上げ直す）。
 */
export async function cleanupImages(env: Env, now: number): Promise<{ owners: number; objects: number }> {
  let owners = 0
  let objects = 0
  for (let round = 0; round < CLEANUP_ROUNDS; round++) {
    const removed = await env.DB.prepare(
      'DELETE FROM image_owners WHERE rowid IN (SELECT o.rowid FROM image_owners o WHERE o.created_at < ? AND NOT EXISTS ' +
      '(SELECT 1 FROM entry_images r WHERE r.user_id = o.user_id AND r.hash = o.hash) LIMIT ?) RETURNING hash'
    ).bind(now - IMAGE_GRACE_MS, CLEANUP_BATCH).all<{ hash: string }>()
    owners += removed.results.length
    const hashes = [...new Set(removed.results.map((r) => r.hash))]
    if (hashes.length) {
      const orphan = await env.DB.prepare(
        'SELECT j.value AS hash FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM image_owners o WHERE o.hash = j.value)'
      ).bind(JSON.stringify(hashes)).all<{ hash: string }>()
      const gone = orphan.results.map((r) => r.hash)
      if (gone.length) {
        await env.MEDIA.delete(gone.map(imageKey))
        objects += gone.length
        await env.DB.prepare('DELETE FROM image_owners WHERE hash IN (SELECT value FROM json_each(?))').bind(JSON.stringify(gone)).run()
      }
    }
    if (removed.results.length < CLEANUP_BATCH) break
  }
  return { owners, objects }
}

/* ── チーム ───────────────────────────────── */

async function roleIn(ctx: Ctx, teamId: string, userId: string): Promise<'owner' | 'member' | null> {
  if (!ID_PATTERN.test(teamId)) return null
  const row = await ctx.env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).first<{ role: 'owner' | 'member' }>()
  return row?.role ?? null
}

/** 持ち主であること。メンバーでなければチームが無いのと同じに答える */
async function requireOwner(ctx: Ctx, teamId: string, userId: string): Promise<void> {
  const role = await roleIn(ctx, teamId, userId)
  if (!role) throw new Rejection('not_found')
  if (role !== 'owner') throw new Rejection('forbidden')
}

const teamName = (raw: unknown) => {
  const name = cleanLine(raw, CLOUD_LIMITS.teamNameChars)
  if (!name) throw new Rejection('bad_request')
  return name
}

async function countTeamsOf(ctx: Ctx, userId: string): Promise<number> {
  const row = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?').bind(userId).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

async function createTeam(ctx: Ctx): Promise<Response> {
  const s = await authenticate(ctx)
  const name = teamName((await readJson(ctx.request)).name)
  if ((await countTeamsOf(ctx, s.userId)) >= CLOUD_LIMITS.teamsPerUser) throw new Rejection('limit')
  const id = ctx.deps.random(16)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(id, name, s.userId, ctx.now),
    ctx.env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(id, s.userId, ctx.now)
  ])
  const team = (await loadTeams(ctx, s.userId)).find((t) => t.id === id)
  return json({ ok: true, team })
}

async function renameTeam(ctx: Ctx, teamId: string): Promise<Response> {
  const s = await authenticate(ctx)
  await requireOwner(ctx, teamId, s.userId)
  const name = teamName((await readJson(ctx.request)).name)
  await ctx.env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, teamId).run()
  return json({ ok: true })
}

async function deleteTeam(ctx: Ctx, teamId: string): Promise<Response> {
  const s = await authenticate(ctx)
  await requireOwner(ctx, teamId, s.userId)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM team_invites WHERE team_id = ?').bind(teamId),
    ctx.env.DB.prepare('DELETE FROM team_members WHERE team_id = ?').bind(teamId),
    ctx.env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(teamId)
  ])
  return json({ ok: true })
}

async function invite(ctx: Ctx, teamId: string): Promise<Response> {
  const { env, now } = ctx
  const s = await authenticate(ctx)
  await requireOwner(ctx, teamId, s.userId)
  const email = normalizeEmail((await readJson(ctx.request)).email)
  if (!email) throw new Rejection('bad_email')
  const member = await env.DB.prepare('SELECT 1 AS x FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?').bind(teamId, email).first()
  if (member) return json({ ok: true, member: true })
  const counts = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM team_members WHERE team_id = ?1) AS members, (SELECT COUNT(*) FROM team_invites WHERE team_id = ?1 AND expires_at > ?2 AND email <> ?3) AS invites'
  ).bind(teamId, now, email).first<{ members: number; invites: number }>()
  if (Number(counts?.members ?? 0) + Number(counts?.invites ?? 0) >= CLOUD_LIMITS.membersPerTeam) throw new Rejection('limit')
  await admit(ctx, [{ kind: 'cloud-invite-user', value: s.userId, windows: INVITE_PER_USER }])

  const team = await env.DB.prepare('SELECT name FROM teams WHERE id = ?').bind(teamId).first<{ name: string }>()
  if (!team) throw new Rejection('not_found')
  const token = ctx.deps.random(32)
  const tokenHash = await sha256Hex(token)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM team_invites WHERE team_id = ? AND (email = ? OR expires_at <= ?)').bind(teamId, email, now),
    env.DB.prepare('INSERT INTO team_invites (token_hash, team_id, email, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(tokenHash, teamId, email, s.userId, now + CLOUD_LIMITS.inviteTtlMs, now)
  ])
  const link = `${env.PUBLIC_BASE}/invite/${token}`
  const days = Math.round(CLOUD_LIMITS.inviteTtlMs / (24 * 60 * 60 * 1000))
  try {
    await sendMail(env, email, `${s.name} さんから Ferret のチーム「${team.name}」への招待`, [
      `${s.name} さん（${s.email}）が、Ferret のチーム「${team.name}」に招待しています。`,
      'チームに入ると、メンバーどうしで指摘を見られます。',
      '',
      `参加する（${days}日有効）:`,
      link,
      '',
      '心当たりがなければ、このメールは捨ててください。',
      '',
      `${s.name} invited you to the Ferret team "${team.name}". Join: ${link}`
    ].join('\n'))
  } catch (e) {
    await env.DB.prepare('DELETE FROM team_invites WHERE token_hash = ?').bind(tokenHash).run()
    throw e
  }
  return json({ ok: true })
}

async function cancelInvite(ctx: Ctx, teamId: string): Promise<Response> {
  const s = await authenticate(ctx)
  await requireOwner(ctx, teamId, s.userId)
  const email = normalizeEmail((await readJson(ctx.request)).email)
  if (!email) throw new Rejection('bad_email')
  await ctx.env.DB.prepare('DELETE FROM team_invites WHERE team_id = ? AND email = ?').bind(teamId, email).run()
  return json({ ok: true })
}

async function removeMember(ctx: Ctx, teamId: string, userId: string): Promise<Response> {
  const s = await authenticate(ctx)
  const role = await roleIn(ctx, teamId, s.userId)
  if (!role || !ID_PATTERN.test(userId)) throw new Rejection('not_found')
  if (userId === s.userId) {
    // 抜ける。最後の持ち主は抜けられない（チームを消す）
    if (role === 'owner') {
      const owners = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'").bind(teamId).first<{ n: number }>()
      if (Number(owners?.n ?? 0) <= 1) throw new Rejection('forbidden')
    }
  } else if (role !== 'owner') {
    throw new Rejection('forbidden')
  }
  const res = await ctx.env.DB.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).run()
  if ((res.meta?.changes ?? 0) === 0) throw new Rejection('not_found')
  return json({ ok: true })
}

type InviteRow = { team_id: string; email: string; team_name: string; inviter: string }

async function findInvite(ctx: Ctx, token: string): Promise<InviteRow & { token_hash: string }> {
  if (!TOKEN_PATTERN.test(token)) throw new Rejection('not_found')
  const tokenHash = await sha256Hex(token)
  const row = await ctx.env.DB.prepare(
    'SELECT i.team_id, i.email, t.name AS team_name, u.name AS inviter FROM team_invites i JOIN teams t ON t.id = i.team_id ' +
    'LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.expires_at > ?'
  ).bind(tokenHash, ctx.now).first<InviteRow>()
  if (!row) throw new Rejection('not_found')
  return { ...row, token_hash: tokenHash }
}

async function readInvite(ctx: Ctx, token: string): Promise<Response> {
  const row = await findInvite(ctx, token)
  return json({ ok: true, teamName: row.team_name, email: row.email, inviter: row.inviter ?? '' })
}

async function acceptInvite(ctx: Ctx, token: string): Promise<Response> {
  const { env } = ctx
  const s = await authenticate(ctx)
  const row = await findInvite(ctx, token)
  if (row.email !== s.email) throw new Rejection('forbidden')
  if (!(await roleIn(ctx, row.team_id, s.userId))) {
    if ((await countTeamsOf(ctx, s.userId)) >= CLOUD_LIMITS.teamsPerUser) throw new Rejection('limit')
    const members = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?').bind(row.team_id).first<{ n: number }>()
    if (Number(members?.n ?? 0) >= CLOUD_LIMITS.membersPerTeam) throw new Rejection('limit')
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?) ON CONFLICT(team_id, user_id) DO NOTHING").bind(row.team_id, s.userId, ctx.now),
    env.DB.prepare('DELETE FROM team_invites WHERE token_hash = ?').bind(row.token_hash)
  ])
  return json({ ok: true, teamId: row.team_id })
}
