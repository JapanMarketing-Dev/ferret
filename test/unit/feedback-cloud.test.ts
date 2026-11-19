import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Env, MediaBucket } from '../../workers/feedback-cloud/src/env'
import { cleanupImages, handle, sameText, sniffImage, type Deps } from '../../workers/feedback-cloud/src/index'
import { APP_HTML, APP_JS } from '../../workers/feedback-cloud/src/page'
import { FeedbackLimiter } from '../../workers/feedback-relay/src/limiter'
import type { LimiterStorage } from '../../workers/feedback-relay/src/env'
import { CLOUD_LIMITS, type CloudFeedback, type CloudMe } from '../../src/shared/feedbackCloud'
import { fakeD1 } from './helpers/fakeD1'

/**
 * メールでログインする指摘の置き場（workers/feedback-cloud）。D1 は node:sqlite で本物の migration の SQL を流し、
 * メールと Durable Object は偽物。本物の Cloudflare には送らない。
 */

const BASE = 'https://account.ferretade.dev'
const IP = '203.0.113.9'
const MIGRATIONS = ['0001_init.sql', '0002_images.sql'].map((f) => join(__dirname, '../../workers/feedback-cloud/migrations', f))
const T0 = Date.parse('2026-11-19T00:00:00Z')

class MemoryStorage implements LimiterStorage {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)) }
  async deleteAll() { this.data.clear() }
  async setAlarm() {}
}

type Mail = { to: string; subject: string; text: string }

/** R2 の偽物（feedback-share のテストと同じ考え方。使う分だけ） */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>()
  const bucket: MediaBucket = {
    async put(key, value, options) { objects.set(key, { bytes: new Uint8Array(value as Uint8Array), type: options?.httpMetadata?.contentType }) },
    async get(key) { const v = objects.get(key); return v ? { body: new Blob([v.bytes as BlobPart]).stream(), size: v.bytes.length } : null },
    async head(key) { const v = objects.get(key); return v ? { size: v.bytes.length } : null },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      if (list.length > 1000) throw new Error('too many keys')
      for (const k of list) objects.delete(k)
    }
  }
  return { bucket, objects }
}

let counter = 0
function setup() {
  const mails: Mail[] = []
  const limiters = new Map<string, FeedbackLimiter>()
  let mailError: Error | null = null
  const db = fakeD1(MIGRATIONS)
  const media = fakeBucket()
  const env: Env = {
    AUTH_SECRET: 'test-auth-secret',
    RATE_LIMIT_SALT: 'test-salt',
    PUBLIC_BASE: BASE,
    MAIL_FROM: 'noreply@ferretade.dev',
    DB: db,
    EMAIL: {
      async send(m) {
        if (mailError) throw mailError
        mails.push({ to: m.to, subject: m.subject, text: m.text })
      }
    },
    MEDIA: media.bucket,
    LIMITER: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!limiters.has(name)) limiters.set(name, new FeedbackLimiter({ storage: new MemoryStorage() }))
        const obj = limiters.get(name)!
        return { fetch: (r: Request) => obj.fetch(r) }
      }
    }
  }
  let t = T0
  const deps: Deps = { now: () => t, random: (bytes) => (++counter).toString(16).padStart(bytes * 2, 'a').slice(-bytes * 2) }
  return {
    env, db, mails, deps, objects: media.objects, now: () => t,
    advance(ms: number) { t += ms },
    failMail(e: Error | null) { mailError = e }
  }
}
type Ctx = ReturnType<typeof setup>

type CallInit = { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string | null; ip?: string; raw?: string }

async function call(ctx: Ctx, path: string, init: CallInit = {}) {
  const headers = new Headers({ 'cf-connecting-ip': init.ip ?? IP })
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.origin) headers.set('origin', init.origin)
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await handle(new Request(`${BASE}${path}`, { method: init.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body }), ctx.env, ctx.deps)
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(text) } catch { /* 画面 */ }
  return { status: res.status, data, text, headers: res.headers }
}

const lastCode = (ctx: Ctx) => /(\d{6})$/.exec(ctx.mails.at(-1)!.subject)![1]!

async function start(ctx: Ctx, email: string, client: 'app' | 'web' = 'app') {
  return call(ctx, '/v1/auth/start', { body: { email, client }, origin: client === 'web' ? BASE : null })
}

async function verify(ctx: Ctx, email: string, code: string, client: 'app' | 'web' = 'app') {
  return call(ctx, '/v1/auth/verify', { body: { email, code, client }, origin: client === 'web' ? BASE : null })
}

async function loginApp(ctx: Ctx, email: string): Promise<{ token: string; me: CloudMe }> {
  expect((await start(ctx, email)).status).toBe(200)
  const res = await verify(ctx, email, lastCode(ctx))
  expect(res.status).toBe(200)
  return { token: res.data.token as string, me: res.data.me as CloudMe }
}

async function loginWeb(ctx: Ctx, email: string): Promise<string> {
  await start(ctx, email, 'web')
  const res = await verify(ctx, email, lastCode(ctx), 'web')
  expect(res.status).toBe(200)
  return /^(__Host-ferret_session=[0-9a-f]{64});/.exec(res.headers.get('set-cookie')!)![1]!
}

let keyN = 0
const key = () => (++keyN).toString(16).padStart(64, '0')
const deviceId = (n: number) => n.toString(16).padStart(32, '0')
const entry = (text: string, extra: Record<string, unknown> = {}) => ({ key: key(), project: 'ferret', source: 'visual-review', text, at: '2026-11-18T10:00:00Z', ...extra })

async function put(ctx: Ctx, token: string, device: number, entries: unknown[], deviceName = `PC${device}`) {
  return call(ctx, '/v1/feedback', { method: 'PUT', token, body: { deviceId: deviceId(device), deviceName, entries } })
}

const feedback = async (ctx: Ctx, token: string) => (await call(ctx, '/v1/feedback', { token })).data as unknown as CloudFeedback & { ok: boolean }
const me = async (ctx: Ctx, token: string) => (await call(ctx, '/v1/me', { token })).data.me as CloudMe

describe('feedback-cloud: ログイン', () => {
  it('アプリ: コードをメールで送り、合えばトークンと me を返す。置くのはハッシュだけ', async () => {
    const ctx = setup()
    const res = await start(ctx, '  Alice@Example.com ')
    expect(res.data).toEqual({ ok: true })
    expect(ctx.mails).toHaveLength(1)
    expect(ctx.mails[0]!.to).toBe('alice@example.com')
    expect(ctx.mails[0]!.subject).toMatch(/^Ferret のログインコード: \d{6}$/)
    const code = lastCode(ctx)
    expect(ctx.mails[0]!.text).toContain(code)
    const stored = ctx.db.db.prepare('SELECT code_hash FROM login_codes').all() as Array<{ code_hash: string }>
    expect(stored[0]!.code_hash).not.toContain(code)

    const ok = await verify(ctx, 'alice@example.com', code)
    expect(ok.status).toBe(200)
    expect(ok.data.token).toMatch(/^[0-9a-f]{64}$/)
    expect(ok.headers.get('set-cookie')).toBeNull()
    const m = ok.data.me as CloudMe
    expect(m).toMatchObject({ email: 'alice@example.com', name: 'alice', teams: [], devices: [] })
    expect(m.id).toMatch(/^[0-9a-f]{32}$/)
    const sessions = ctx.db.db.prepare('SELECT token_hash, kind FROM sessions').all() as Array<{ token_hash: string; kind: string }>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.token_hash).not.toBe(ok.data.token)
    expect(sessions[0]!.kind).toBe('app')
    expect((await me(ctx, ok.data.token as string)).email).toBe('alice@example.com')
  })

  it('2回目のログインは同じユーザー。同じコードは二度使えない', async () => {
    const ctx = setup()
    const a = await loginApp(ctx, 'a@example.com')
    await start(ctx, 'a@example.com')
    const code = lastCode(ctx)
    const first = await verify(ctx, 'a@example.com', code)
    expect((first.data.me as CloudMe).id).toBe(a.me.id)
    expect((await verify(ctx, 'a@example.com', code)).data.code).toBe('code_expired')
  })

  it('Web: 自分の Origin からだけ。HttpOnly・Secure・SameSite=Lax の cookie で読める', async () => {
    const ctx = setup()
    expect((await call(ctx, '/v1/auth/start', { body: { email: 'w@example.com', client: 'web' } })).data.code).toBe('forbidden')
    expect((await call(ctx, '/v1/auth/start', { body: { email: 'w@example.com', client: 'app' }, origin: BASE })).data.code).toBe('forbidden')
    expect((await call(ctx, '/v1/auth/start', { body: { email: 'w@example.com', client: 'web' }, origin: 'https://evil.example' })).data.code).toBe('forbidden')
    await start(ctx, 'w@example.com', 'web')
    const code = lastCode(ctx)
    expect((await verify(ctx, 'w@example.com', code, 'app')).status).toBe(200) // コードは client を問わない
    await start(ctx, 'w@example.com', 'web')
    const res = await verify(ctx, 'w@example.com', lastCode(ctx), 'web')
    expect(res.data.token).toBeUndefined()
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-ferret_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/)
    const c = cookie.split(';')[0]!
    expect((await call(ctx, '/v1/me', { cookie: c })).data.me).toMatchObject({ email: 'w@example.com' })
    // cookie のトークンを Bearer で使っても通らない（種類が違う）
    expect((await call(ctx, '/v1/me', { token: c.split('=')[1] })).status).toBe(401)
  })

  it('ユーザーがいなくても同じ答え。メールアドレスの形とコードの形を確かめる', async () => {
    const ctx = setup()
    expect((await start(ctx, 'nobody@example.com')).data).toEqual({ ok: true })
    expect((await start(ctx, 'not-an-email')).data.code).toBe('bad_email')
    expect((await verify(ctx, 'nobody@example.com', '12345')).data.code).toBe('bad_code')
    expect((await call(ctx, '/v1/auth/start', { body: { email: 'x@example.com' } })).data.code).toBe('bad_request')
    expect((await call(ctx, '/v1/auth/start', { raw: '{bad', })).data.code).toBe('bad_request')
    expect((await verify(ctx, 'unknown@example.com', '123456')).data.code).toBe('code_expired')
  })

  it('外れが5回でコードは消え、合っていても通らない', async () => {
    const ctx = setup()
    await start(ctx, 'b@example.com')
    const code = lastCode(ctx)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < CLOUD_LIMITS.codeAttempts; i++) {
      const r = await verify(ctx, 'b@example.com', wrong)
      expect(r.status).toBe(400)
      expect(r.data.code).toBe('bad_code')
    }
    expect((await verify(ctx, 'b@example.com', code)).data.code).toBe('code_expired')
    expect(ctx.db.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get()).toEqual({ n: 0 })
  })

  it('4回外れても5回目に合えば通る', async () => {
    const ctx = setup()
    await start(ctx, 'b@example.com')
    const code = lastCode(ctx)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < CLOUD_LIMITS.codeAttempts - 1; i++) await verify(ctx, 'b@example.com', wrong)
    expect((await verify(ctx, 'b@example.com', code)).status).toBe(200)
  })

  it('15分を過ぎたコードは通らない。送り直すと前のコードは効かない', async () => {
    const ctx = setup()
    await start(ctx, 'c@example.com')
    const old = lastCode(ctx)
    ctx.advance(CLOUD_LIMITS.codeTtlMs + 1)
    expect((await verify(ctx, 'c@example.com', old)).data.code).toBe('code_expired')
    await start(ctx, 'c@example.com')
    await start(ctx, 'c@example.com')
    const fresh = lastCode(ctx)
    if (old !== fresh) expect((await verify(ctx, 'c@example.com', old)).data.code).toBe('bad_code')
    expect((await verify(ctx, 'c@example.com', fresh)).status).toBe(200)
  })

  it('コードを送る数はメールアドレスごと・IP ごとに上限がある', async () => {
    const ctx = setup()
    for (let i = 0; i < 3; i++) expect((await start(ctx, 'd@example.com')).status).toBe(200)
    const limited = await start(ctx, 'd@example.com')
    expect(limited.status).toBe(429)
    expect(limited.data.code).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(ctx.mails).toHaveLength(3)
    // 別のアドレスは通る。IP は1時間に20まで（メールアドレスの枠で断られた1回は IP の枠を減らさない）
    for (let i = 0; i < 17; i++) expect((await start(ctx, `u${i}@example.com`)).status).toBe(200)
    expect((await start(ctx, 'other@example.com')).data.code).toBe('rate_limited')
    expect((await call(ctx, '/v1/auth/start', { body: { email: 'other@example.com', client: 'app' }, ip: '198.51.100.1' })).status).toBe(200)
  })

  it('メールを送れなければ mail_failed（code はログに出さない）', async () => {
    const ctx = setup()
    ctx.failMail(Object.assign(new Error('x'), { code: 'E_SENDER' }))
    const original = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => { logs.push(args) }
    try {
      const res = await start(ctx, 'e@example.com')
      expect(res.status).toBe(502)
      expect(res.data.code).toBe('mail_failed')
    } finally {
      console.error = original
    }
    expect(JSON.stringify(logs)).not.toContain('e@example.com')
  })

  it('ログアウトでトークンも cookie も効かなくなる', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'f@example.com')
    expect((await call(ctx, '/v1/auth/logout', { method: 'POST', token })).data).toEqual({ ok: true })
    expect((await call(ctx, '/v1/me', { token })).status).toBe(401)
    const cookie = await loginWeb(ctx, 'f@example.com')
    expect((await call(ctx, '/v1/auth/logout', { method: 'POST', cookie })).data.code).toBe('forbidden')
    const out = await call(ctx, '/v1/auth/logout', { method: 'POST', cookie, origin: BASE })
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await call(ctx, '/v1/me', { cookie })).status).toBe(401)
  })

  it('セッションの期限が切れたら通らない', async () => {
    const ctx = setup()
    const cookie = await loginWeb(ctx, 'g@example.com')
    ctx.advance(CLOUD_LIMITS.webSessionMs + 1)
    expect((await call(ctx, '/v1/me', { cookie })).status).toBe(401)
  })
})

describe('feedback-cloud: Origin と CSRF', () => {
  it('cookie で状態を変える要求は自分の Origin が要る。Bearer に Origin があれば断る。ほかの Origin は全部断る', async () => {
    const ctx = setup()
    const cookie = await loginWeb(ctx, 'h@example.com')
    expect((await call(ctx, '/v1/me', { method: 'PATCH', cookie, body: { name: 'H' } })).data.code).toBe('forbidden')
    expect((await call(ctx, '/v1/me', { method: 'PATCH', cookie, body: { name: 'H' }, origin: 'https://evil.example' })).data.code).toBe('forbidden')
    const ok = await call(ctx, '/v1/me', { method: 'PATCH', cookie, body: { name: ' H\u0000 さん ' }, origin: BASE })
    expect((ok.data.me as CloudMe).name).toBe('H  さん')
    expect((await call(ctx, '/v1/me', { cookie, origin: 'https://evil.example' })).status).toBe(403)

    const { token } = await loginApp(ctx, 'i@example.com')
    expect((await call(ctx, '/v1/me', { token, origin: BASE })).data.code).toBe('forbidden')
    expect((await call(ctx, '/v1/feedback', { method: 'PUT', token, origin: BASE, body: {} })).data.code).toBe('forbidden')
    expect((await call(ctx, '/v1/me', { token: 'f'.repeat(64) })).status).toBe(401)
    expect((await call(ctx, '/v1/me')).status).toBe(401)
  })
})

describe('feedback-cloud: 指摘', () => {
  it('PC ごとに置き換え。ほかの PC の分は残り、読むと自分の全部の PC の分が新しい順に返る', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'j@example.com')
    const a = entry('古い', { at: '2026-11-01T00:00:00Z' })
    const b = entry('真ん中', { at: '2026-11-10T00:00:00Z', title: '題' })
    const c = entry('消える')
    expect((await put(ctx, token, 1, [a, b, c])).data).toEqual({ ok: true, stored: 3 })
    expect((await put(ctx, token, 2, [entry('別の PC', { at: '2026-11-15T00:00:00Z' })], 'MacBook')).data.stored).toBe(1)
    expect((await put(ctx, token, 1, [a, b])).data.stored).toBe(2)
    const fb = await feedback(ctx, token)
    expect(fb.mine.map((e) => e.text)).toEqual(['別の PC', '真ん中', '古い'])
    expect(fb.mine[0]).toMatchObject({ deviceId: deviceId(2), deviceName: 'MacBook', author: { email: 'j@example.com' } })
    expect(fb.mine[1]!.title).toBe('題')
    expect(fb.teams).toEqual([])
    const m = await me(ctx, token)
    expect(m.devices.map((d) => [d.name, d.entries]).sort()).toEqual([['MacBook', 1], ['PC1', 2]])
  })

  it('許可した項目だけを置く（手元のファイルのパスなど余分な項目は捨てる）。形の合わない指摘は落とす', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'k@example.com')
    const res = await put(ctx, token, 1, [
      entry('良い', { file: '/Users/someone/secret/feedback.md', path: 'C:\\Users\\x' }),
      { ...entry('鍵が悪い'), key: 'nothex' },
      { ...entry('出どころが悪い'), source: 'other' },
      entry('   '),
      entry('日付が悪い', { at: 'yesterday' })
    ])
    expect(res.data.stored).toBe(1)
    const fb = await call(ctx, '/v1/feedback', { token })
    expect(fb.text).not.toContain('/Users/')
    expect(fb.text).not.toContain('secret')
    expect((await put(ctx, token, 1, 'nope' as unknown as unknown[])).data.code).toBe('bad_request')
    expect((await call(ctx, '/v1/feedback', { method: 'PUT', token, body: { deviceId: 'xyz', deviceName: 'a', entries: [] } })).data.code).toBe('bad_request')
    // 空にすれば消える
    expect((await put(ctx, token, 1, [])).data.stored).toBe(0)
    expect((await feedback(ctx, token)).mine).toEqual([])
  })

  it('大きすぎる本文は too_large', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'l@example.com')
    const res = await call(ctx, '/v1/feedback', { method: 'PUT', token, raw: JSON.stringify({ pad: 'x'.repeat(CLOUD_LIMITS.uploadBytes) }) })
    expect(res.status).toBe(413)
  })

  it('たくさんの指摘も分けて入れられる（json_each の塊が複数になる）', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'many@example.com')
    const entries = Array.from({ length: 600 }, (_, i) => entry(`${i} ${'あ'.repeat(1900)}`))
    expect((await put(ctx, token, 1, entries)).data.stored).toBe(600)
    expect((await me(ctx, token)).devices[0]!.entries).toBe(600)
  })

  it('PC は1人20台まで。今ある PC は送り直せ、消すと指摘も消える', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'm@example.com')
    for (let i = 1; i <= CLOUD_LIMITS.devicesPerUser; i++) expect((await put(ctx, token, i, [entry(`pc${i}`)])).status).toBe(200)
    const over = await put(ctx, token, 99, [entry('over')])
    expect(over.status).toBe(409)
    expect(over.data.code).toBe('limit')
    expect((await put(ctx, token, 1, [entry('again')])).status).toBe(200)
    expect((await call(ctx, `/v1/devices/${deviceId(1)}`, { method: 'DELETE', token })).data).toEqual({ ok: true })
    expect((await call(ctx, `/v1/devices/${deviceId(1)}`, { method: 'DELETE', token })).data.code).toBe('not_found')
    expect((await feedback(ctx, token)).mine.some((e) => e.text === 'again')).toBe(false)
    expect((await put(ctx, token, 99, [entry('now fits')])).status).toBe(200)
  })
})

describe('feedback-cloud: チーム', () => {
  async function team(ctx: Ctx) {
    const a = await loginApp(ctx, 'owner@example.com')
    const b = await loginApp(ctx, 'member@example.com')
    const c = await loginApp(ctx, 'outsider@example.com')
    const created = await call(ctx, '/v1/teams', { token: a.token, body: { name: '開発' } })
    const teamId = (created.data.team as { id: string }).id
    expect(created.data.team).toMatchObject({ name: '開発', role: 'owner', members: [{ email: 'owner@example.com', role: 'owner' }], invites: [] })
    return { a, b, c, teamId }
  }

  async function inviteAndAccept(ctx: Ctx, ownerToken: string, teamId: string, email: string, token: string) {
    expect((await call(ctx, `/v1/teams/${teamId}/invites`, { token: ownerToken, body: { email } })).data).toEqual({ ok: true })
    const link = /https:\/\/account\.ferretade\.dev\/invite\/([0-9a-f]{64})/.exec(ctx.mails.at(-1)!.text)![1]!
    const accepted = await call(ctx, `/v1/invites/${link}/accept`, { method: 'POST', token })
    expect(accepted.data).toEqual({ ok: true, teamId })
  }

  it('招待 → 同じアドレスの人が受ける → メンバーの指摘が見え、外の人には見えない', async () => {
    const ctx = setup()
    const { a, b, c, teamId } = await team(ctx)
    await put(ctx, a.token, 1, [entry('A の指摘')])
    await put(ctx, b.token, 2, [entry('B の指摘')])
    await put(ctx, c.token, 3, [entry('C の指摘')])

    expect((await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'Member@Example.com' } })).data).toEqual({ ok: true })
    const mail = ctx.mails.at(-1)!
    expect(mail.to).toBe('member@example.com')
    expect(mail.subject).toContain('開発')
    const token = /\/invite\/([0-9a-f]{64})/.exec(mail.text)![1]!
    expect((await me(ctx, a.token)).teams[0]!.invites).toEqual([{ email: 'member@example.com', expiresAt: new Date(T0 + CLOUD_LIMITS.inviteTtlMs).toISOString() }])

    // ログイン無しで招待の中身を読める（画面が使う）
    const info = await call(ctx, `/v1/invites/${token}`)
    expect(info.data).toEqual({ ok: true, teamName: '開発', email: 'member@example.com', inviter: 'owner' })
    // 違うアドレスの人は受けられない
    expect((await call(ctx, `/v1/invites/${token}/accept`, { method: 'POST', token: c.token })).data.code).toBe('forbidden')
    expect((await call(ctx, `/v1/invites/${token}/accept`, { method: 'POST', token: b.token })).data).toEqual({ ok: true, teamId })
    // 使った招待はもう無い
    expect((await call(ctx, `/v1/invites/${token}`)).status).toBe(404)

    const fa = await feedback(ctx, a.token)
    expect(fa.teams).toHaveLength(1)
    expect(fa.teams[0]!.entries.map((e) => [e.text, e.author.email])).toEqual([['B の指摘', 'member@example.com']])
    const fb = await feedback(ctx, b.token)
    expect(fb.teams[0]!.entries.map((e) => e.text)).toEqual(['A の指摘'])
    expect(fb.mine.map((e) => e.text)).toEqual(['B の指摘'])
    const fc = await feedback(ctx, c.token)
    expect(fc.teams).toEqual([])
    expect(JSON.stringify(fc)).not.toContain('A の指摘')
    const mb = await me(ctx, b.token)
    expect(mb.teams[0]).toMatchObject({ id: teamId, role: 'member' })
    expect(mb.teams[0]!.invites).toBeUndefined()
    expect(mb.teams[0]!.members.map((m) => m.email)).toEqual(['owner@example.com', 'member@example.com'])
  })

  it('招待は7日で切れる。取り消せる。持ち主でなければ招待できない', async () => {
    const ctx = setup()
    const { a, b, c, teamId } = await team(ctx)
    await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'member@example.com' } })
    const token = /\/invite\/([0-9a-f]{64})/.exec(ctx.mails.at(-1)!.text)![1]!
    ctx.advance(CLOUD_LIMITS.inviteTtlMs + 1)
    expect((await call(ctx, `/v1/invites/${token}`)).status).toBe(404)
    expect((await call(ctx, `/v1/invites/${token}/accept`, { method: 'POST', token: b.token })).data.code).toBe('not_found')

    await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'member@example.com' } })
    const again = /\/invite\/([0-9a-f]{64})/.exec(ctx.mails.at(-1)!.text)![1]!
    expect((await call(ctx, `/v1/teams/${teamId}/invites`, { method: 'DELETE', token: a.token, body: { email: 'member@example.com' } })).data).toEqual({ ok: true })
    expect((await call(ctx, `/v1/invites/${again}/accept`, { method: 'POST', token: b.token })).data.code).toBe('not_found')

    // 外の人にはチームが無いのと同じ
    expect((await call(ctx, `/v1/teams/${teamId}/invites`, { token: c.token, body: { email: 'x@example.com' } })).data.code).toBe('not_found')
    expect((await call(ctx, '/v1/invites/nothex')).status).toBe(404)
  })

  it('招待のメールを送れなければ招待は残らない', async () => {
    const ctx = setup()
    const { a, teamId } = await team(ctx)
    ctx.failMail(new Error('down'))
    const original = console.error
    console.error = () => {}
    try {
      expect((await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'z@example.com' } })).data.code).toBe('mail_failed')
    } finally {
      console.error = original
    }
    expect((await me(ctx, a.token)).teams[0]!.invites).toEqual([])
  })

  it('抜ける・外す・消すの決まり。外れた人の指摘は見えなくなる', async () => {
    const ctx = setup()
    const { a, b, c, teamId } = await team(ctx)
    await inviteAndAccept(ctx, a.token, teamId, 'member@example.com', b.token)
    await put(ctx, b.token, 2, [entry('B の指摘')])
    const bId = b.me.id
    const aId = a.me.id

    // 最後の持ち主は抜けられない
    expect((await call(ctx, `/v1/teams/${teamId}/members/${aId}`, { method: 'DELETE', token: a.token })).data.code).toBe('forbidden')
    // メンバーは持ち主を外せない・名前を変えられない・消せない
    expect((await call(ctx, `/v1/teams/${teamId}/members/${aId}`, { method: 'DELETE', token: b.token })).data.code).toBe('forbidden')
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'PATCH', token: b.token, body: { name: 'x' } })).data.code).toBe('forbidden')
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'DELETE', token: b.token })).data.code).toBe('forbidden')
    // 外の人には無いのと同じ
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'DELETE', token: c.token })).data.code).toBe('not_found')

    // メンバーは自分で抜けられる
    expect((await call(ctx, `/v1/teams/${teamId}/members/${bId}`, { method: 'DELETE', token: b.token })).data).toEqual({ ok: true })
    expect((await feedback(ctx, a.token)).teams[0]!.entries).toEqual([])
    expect((await feedback(ctx, b.token)).teams).toEqual([])

    // 持ち主が外す
    await inviteAndAccept(ctx, a.token, teamId, 'member@example.com', b.token)
    expect((await feedback(ctx, a.token)).teams[0]!.entries).toHaveLength(1)
    expect((await call(ctx, `/v1/teams/${teamId}/members/${bId}`, { method: 'DELETE', token: a.token })).data).toEqual({ ok: true })
    expect((await call(ctx, `/v1/teams/${teamId}/members/${bId}`, { method: 'DELETE', token: a.token })).data.code).toBe('not_found')
    expect((await feedback(ctx, a.token)).teams[0]!.entries).toEqual([])

    // 名前を変えて、消す
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'PATCH', token: a.token, body: { name: '新しい名前' } })).data).toEqual({ ok: true })
    expect((await me(ctx, a.token)).teams[0]!.name).toBe('新しい名前')
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'PATCH', token: a.token, body: { name: '  ' } })).data.code).toBe('bad_request')
    expect((await call(ctx, `/v1/teams/${teamId}`, { method: 'DELETE', token: a.token })).data).toEqual({ ok: true })
    expect((await me(ctx, a.token)).teams).toEqual([])
  })

  it('入れるチームは1人20まで', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'n@example.com')
    for (let i = 0; i < CLOUD_LIMITS.teamsPerUser; i++) expect((await call(ctx, '/v1/teams', { token, body: { name: `t${i}` } })).status).toBe(200)
    expect((await call(ctx, '/v1/teams', { token, body: { name: 'over' } })).data.code).toBe('limit')
  })

  it('もうメンバーの人を招待してもメールは送らない', async () => {
    const ctx = setup()
    const { a, teamId } = await team(ctx)
    const sent = ctx.mails.length
    expect((await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'owner@example.com' } })).data).toEqual({ ok: true, member: true })
    expect(ctx.mails).toHaveLength(sent)
  })
})

describe('feedback-cloud: 画面', () => {
  it('/ と /invite/<token> は厳しい CSP の HTML。JS は読めて innerHTML を使わない', async () => {
    const ctx = setup()
    for (const path of ['/', `/invite/${'a'.repeat(64)}`]) {
      const res = await call(ctx, path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/^text\/html/)
      const csp = res.headers.get('content-security-policy')!
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-robots-tag')).toContain('noindex')
    }
    expect(APP_HTML).toContain('/assets/app.js')
    expect((await call(ctx, '/assets/app.js')).text).toBe(APP_JS)
    expect((await call(ctx, '/assets/app.css')).headers.get('content-type')).toMatch(/^text\/css/)
    expect((await call(ctx, '/assets/other.js')).status).toBe(404)
    expect(() => new Function(APP_JS)).not.toThrow()
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/)
    expect((await call(ctx, '/nope')).status).toBe(404)
  })

  it('定数時間の比較', () => {
    expect(sameText('abc', 'abc')).toBe(true)
    expect(sameText('abc', 'abd')).toBe(false)
    expect(sameText('abc', 'ab')).toBe(false)
  })
})

/* ── 画像 ─────────────────────────────────── */

const PNG = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(seed)])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')])
const svg = (text: string) => new TextEncoder().encode(text)
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function putImage(ctx: Ctx, token: string | null, bytes: Uint8Array, init: { hash?: string; type?: string; cookie?: string; origin?: string } = {}) {
  const headers = new Headers({ 'content-type': init.type ?? 'image/png', 'cf-connecting-ip': IP })
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.origin) headers.set('origin', init.origin)
  const res = await handle(new Request(`${BASE}/v1/images/${init.hash ?? hashOf(bytes)}`, { method: 'PUT', headers, body: bytes as BodyInit }), ctx.env, ctx.deps)
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}

async function getImage(ctx: Ctx, hash: string, auth: { token?: string; cookie?: string }) {
  const headers = new Headers()
  if (auth.token) headers.set('authorization', `Bearer ${auth.token}`)
  if (auth.cookie) headers.set('cookie', auth.cookie)
  const res = await handle(new Request(`${BASE}/v1/images/${hash}`, { headers }), ctx.env, ctx.deps)
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) }
}

const missing = async (ctx: Ctx, token: string, hashes: unknown) => call(ctx, '/v1/images/missing', { token, body: { hashes } })

describe('feedback-cloud: 画像', () => {
  it('上げると R2 の img/<hash> に置かれ、持ち主は読める。同じ画像の2回目は置き直さない', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'alice@example.com')
    const bytes = PNG('one')
    const h = hashOf(bytes)
    expect((await missing(ctx, token, [h, h])).data).toEqual({ ok: true, missing: [h] })
    expect((await putImage(ctx, token, bytes)).data).toEqual({ ok: true, stored: true })
    expect(ctx.objects.get(`img/${h}`)).toMatchObject({ type: 'image/png' })
    expect((await missing(ctx, token, [h])).data).toEqual({ ok: true, missing: [] })
    expect((await putImage(ctx, token, bytes)).data).toEqual({ ok: true, stored: false })

    const got = await getImage(ctx, h, { token })
    expect(got.status).toBe(200)
    expect([...got.bytes]).toEqual([...bytes])
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox")
    expect(got.headers.get('content-disposition')).toBe('inline')
  })

  it('jpeg・webp・安全な svg は通る。形式・中身の hash・先頭のバイトが合わなければ断る', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'alice@example.com')
    expect((await putImage(ctx, token, JPEG, { type: 'image/jpeg' })).status).toBe(200)
    expect((await putImage(ctx, token, WEBP, { type: 'image/webp' })).status).toBe(200)
    const ok = svg('﻿<?xml version="1.0"?>\n<!-- 枠 -->\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" fill="red"/></svg>')
    expect((await putImage(ctx, token, ok, { type: 'image/svg+xml; charset=utf-8' })).status).toBe(200)

    // hash が合わない
    expect((await putImage(ctx, token, PNG('x'), { hash: hashOf(PNG('y')) })).data.code).toBe('bad_request')
    // 形式と中身が違う・知らない形式・空・hash の形が違う
    expect((await putImage(ctx, token, new Uint8Array([0xff, 0xd8, 0xff, 9]), { type: 'image/png' })).data.code).toBe('bad_request')
    expect((await putImage(ctx, token, PNG('g'), { type: 'image/gif' })).data.code).toBe('bad_request')
    expect((await putImage(ctx, token, new Uint8Array())).data.code).toBe('bad_request')
    expect((await putImage(ctx, token, PNG('z'), { hash: 'A'.repeat(64) })).status).toBe(404)
    // 大きすぎる
    const big = new Uint8Array(CLOUD_LIMITS.imageBytes + 1)
    big.set(PNG(''))
    expect((await putImage(ctx, token, big)).data.code).toBe('too_large')
    // ログインが要る
    expect((await putImage(ctx, null, PNG('n'), { origin: BASE })).status).toBe(401)
    expect(ctx.objects.size).toBe(3)
  })

  it('svg はスクリプト・on 属性・javascript:・foreignObject・DOCTYPE を断り、<svg で始まらなければ断る', () => {
    const head = '<svg xmlns="http://www.w3.org/2000/svg">'
    for (const bad of [
      `${head}<script>alert(1)</script></svg>`,
      `${head}<rect onload="alert(1)"/></svg>`,
      `<svg onload = "x()"></svg>`,
      `${head}<a href="javascript:alert(1)"><rect/></a></svg>`,
      `${head}<foreignObject><div/></foreignObject></svg>`,
      `<!DOCTYPE svg [<!ENTITY x "y">]>${head}</svg>`,
      '<html><svg></svg></html>',
      'hello'
    ]) expect(sniffImage('svg', svg(bad)), bad).toBe(false)
    expect(sniffImage('svg', new Uint8Array([0xff, 0xfe, 0x00]))).toBe(false)
    expect(sniffImage('svg', svg(`  \n<!-- a --><!-- b -->${head}<path d="M0 0"/></svg>`))).toBe(true)
    expect(sniffImage('webp', svg('RIFF0000WAVE'))).toBe(false)
    expect(sniffImage('png', new Uint8Array([0x89, 0x50]))).toBe(false)
  })

  it('1人の合計が上限を超える画像は limit', async () => {
    const ctx = setup()
    const { token, me: m } = await loginApp(ctx, 'alice@example.com')
    ctx.db.db.prepare('INSERT INTO image_owners (hash, user_id, type, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('f'.repeat(64), m.id, 'png', CLOUD_LIMITS.imageQuotaBytes - 10, T0)
    expect((await putImage(ctx, token, PNG('ab'))).status).toBe(200) // 10 バイトでちょうど上限
    const res = await putImage(ctx, token, PNG('abc'))
    expect(res.status).toBe(409)
    expect(res.data.code).toBe('limit')
  })

  it('missing は hash の形と数を確かめる', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'alice@example.com')
    expect((await missing(ctx, token, [])).data).toEqual({ ok: true, missing: [] })
    expect((await missing(ctx, token, ['nope'])).data.code).toBe('bad_request')
    expect((await missing(ctx, token, 'x')).data.code).toBe('bad_request')
    const many = Array.from({ length: CLOUD_LIMITS.imageCheckHashes }, (_, i) => i.toString(16).padStart(64, '0'))
    expect(((await missing(ctx, token, many)).data.missing as string[]).length).toBe(CLOUD_LIMITS.imageCheckHashes)
    expect((await missing(ctx, token, [...many, 'f'.repeat(64)])).data.code).toBe('bad_request')
  })

  it('読めるのは持ち主と同じチームの人だけ。ほかの人には無いのと同じ。hash を知っていても上げなければ持ち主にならない', async () => {
    const ctx = setup()
    const a = await loginApp(ctx, 'owner@example.com')
    const b = await loginApp(ctx, 'member@example.com')
    const c = await loginApp(ctx, 'outsider@example.com')
    const teamId = ((await call(ctx, '/v1/teams', { token: a.token, body: { name: '開発' } })).data.team as { id: string }).id
    await call(ctx, `/v1/teams/${teamId}/invites`, { token: a.token, body: { email: 'member@example.com' } })
    const link = /\/invite\/([0-9a-f]{64})/.exec(ctx.mails.at(-1)!.text)![1]!
    await call(ctx, `/v1/invites/${link}/accept`, { method: 'POST', token: b.token })

    const bytes = PNG('team')
    const h = hashOf(bytes)
    await putImage(ctx, a.token, bytes)
    expect((await getImage(ctx, h, { token: a.token })).status).toBe(200)
    expect((await getImage(ctx, h, { token: b.token })).status).toBe(200)
    expect((await getImage(ctx, h, { token: c.token })).status).toBe(404)
    expect((await missing(ctx, c.token, [h])).data.missing).toEqual([h])
    expect((await getImage(ctx, 'e'.repeat(64), { token: a.token })).status).toBe(404)
    expect((await getImage(ctx, h, {})).status).toBe(401)
    // Web の <img> は cookie で読める（GET は Origin が無くてよい）
    const cookie = await loginWeb(ctx, 'member@example.com')
    expect((await getImage(ctx, h, { cookie })).status).toBe(200)
    // cookie で上げるには自分の Origin が要る
    expect((await putImage(ctx, null, PNG('web'), { cookie })).status).toBe(403)
    expect((await putImage(ctx, null, PNG('web'), { cookie, origin: BASE })).status).toBe(200)
    // チームから外れたら読めない
    await call(ctx, `/v1/teams/${teamId}/members/${b.me.id}`, { method: 'DELETE', token: a.token })
    expect((await getImage(ctx, h, { token: b.token })).status).toBe(404)
  })

  it('指摘に付けた画像（囲んだ場所つき）を置き、読むと返る。形の合わない画像は落とす。AIへの指示も置ける', async () => {
    const ctx = setup()
    const { token } = await loginApp(ctx, 'alice@example.com')
    const h1 = 'a'.repeat(64)
    const h2 = 'b'.repeat(64)
    const box = { x: 10, y: 20, w: 30, h: 40, width: 800, height: 600 }
    await put(ctx, token, 1, [
      entry('ボタンが小さい', { images: [{ hash: h1, type: 'png', box }, { hash: h2, type: 'jpeg' }, { hash: 'bad', type: 'png' }, { hash: h1, type: 'png' }, { hash: 'c'.repeat(64), type: 'gif' }] }),
      entry('ログイン画面を直して', { source: 'agent-prompt', title: 'Claude Code', at: '2026-11-18T11:00:00Z' }),
      entry('画像なし', { at: '2026-11-18T09:00:00Z' })
    ])
    const fb = await feedback(ctx, token)
    expect(fb.mine.map((e) => e.text)).toEqual(['ログイン画面を直して', 'ボタンが小さい', '画像なし'])
    expect(fb.mine[0]).toMatchObject({ source: 'agent-prompt', title: 'Claude Code' })
    expect(fb.mine[0]!.images).toBeUndefined()
    expect(fb.mine[1]!.images).toEqual([{ hash: h1, type: 'png', box }, { hash: h2, type: 'jpeg' }])
    expect(fb.mine[2]!.images).toBeUndefined()
    expect(ctx.db.db.prepare('SELECT hash FROM entry_images ORDER BY hash').all().map((r) => (r as { hash: string }).hash)).toEqual([h1, h2])
    // 置き換えると、指していた画像の行も置き換わる。PC を消すと消える
    await put(ctx, token, 1, [entry('別の指摘', { images: [{ hash: h2, type: 'jpeg' }] })])
    expect(ctx.db.db.prepare('SELECT hash FROM entry_images').all()).toEqual([{ hash: h2 }])
    await call(ctx, `/v1/devices/${deviceId(1)}`, { method: 'DELETE', token })
    expect(ctx.db.db.prepare('SELECT COUNT(*) AS n FROM entry_images').get()).toEqual({ n: 0 })
  })

  it('掃除: 指されていない古い持ち主の行を消し、持ち主のいなくなった画像を R2 から消す', async () => {
    const ctx = setup()
    const a = await loginApp(ctx, 'alice@example.com')
    const b = await loginApp(ctx, 'bob@example.com')
    const used = PNG('used')
    const lone = PNG('lone')
    const shared = PNG('shared')
    for (const bytes of [used, lone, shared]) await putImage(ctx, a.token, bytes)
    await putImage(ctx, b.token, shared)
    await put(ctx, a.token, 1, [entry('使っている', { images: [{ hash: hashOf(used), type: 'png' }] })])
    await put(ctx, b.token, 2, [entry('b も使っている', { images: [{ hash: hashOf(shared), type: 'png' }] })])

    // 上げたばかりの画像は、まだ指されていなくても消さない（指摘を送るまでの猶予）
    expect(await cleanupImages(ctx.env, ctx.now())).toEqual({ owners: 0, objects: 0 })
    ctx.advance(24 * 60 * 60 * 1000 + 1)
    expect(await cleanupImages(ctx.env, ctx.now())).toEqual({ owners: 2, objects: 1 })
    expect([...ctx.objects.keys()].sort()).toEqual([`img/${hashOf(used)}`, `img/${hashOf(shared)}`].sort())
    // a は shared の持ち主ではなくなったが、b が上げたので R2 には残り、b は読める
    expect((await missing(ctx, a.token, [hashOf(shared), hashOf(used)])).data.missing).toEqual([hashOf(shared)])
    expect((await getImage(ctx, hashOf(shared), { token: b.token })).status).toBe(200)
    expect((await getImage(ctx, hashOf(lone), { token: a.token })).status).toBe(404)
    // もう一度流しても何も消えない
    expect(await cleanupImages(ctx.env, ctx.now())).toEqual({ owners: 0, objects: 0 })
  })

  it('掃除は1回に上限の行数ずつ、決まった回数まで（残りは次の回）', async () => {
    const ctx = setup()
    const { me: m } = await loginApp(ctx, 'alice@example.com')
    const insert = ctx.db.db.prepare('INSERT INTO image_owners (hash, user_id, type, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
    const total = 500 * 10 + 7
    for (let i = 0; i < total; i++) insert.run(i.toString(16).padStart(64, '0'), m.id, 'png', 1, T0)
    ctx.advance(2 * 24 * 60 * 60 * 1000)
    expect(await cleanupImages(ctx.env, ctx.now())).toEqual({ owners: 5000, objects: 5000 })
    expect(await cleanupImages(ctx.env, ctx.now())).toEqual({ owners: 7, objects: 7 })
  })
})

describe('feedback-cloud: 画面の画像と種類', () => {
  it('画像は /v1/images/<hash> を <img> で出し、囲んだ場所は CSSOM で重ねる。AIへの指示の種類で絞れる', () => {
    expect(APP_JS).toContain("'/v1/images/' + image.hash")
    expect(APP_JS).toContain('mark.style.left')
    expect(APP_JS).toContain("'agent-prompt': 'AIへの指示'")
    expect(APP_JS).not.toMatch(/setAttribute\('style'|style: '/)
  })
})
