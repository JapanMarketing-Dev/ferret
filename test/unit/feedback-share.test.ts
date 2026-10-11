import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Env, MultipartUpload, RoomStorage, ShareBucket } from '../../workers/feedback-share/src/env'
import { handle, type Deps } from '../../workers/feedback-share/src/index'
import { UNLOCK_PER_IP_SHARE } from '../../workers/feedback-share/src/limits'
import { SHARE_HTML } from '../../workers/feedback-share/src/page'
import { SHARE_JS } from '../../workers/feedback-share/src/generated'
import { ShareRoom, sameHash } from '../../workers/feedback-share/src/room'
import { FeedbackLimiter } from '../../workers/feedback-relay/src/limiter'
import type { LimiterStorage } from '../../workers/feedback-relay/src/env'
import {
  SHARE_LIMITS, mediaMatches, parseShareLink, sanitizeEventsFile, sanitizeMemo, sanitizeRecordingStart, shareUrl, sniffMedia
} from '../../src/shared/feedbackShare'
import { generateSharePassword, makeAuthVerifier, openMemo, passwordProof, sealMemo } from '../../src/shared/shareCrypto'

/**
 * ログイン無しの共有リンク（workers/feedback-share）。偽の env（R2・Durable Object）で動かし、本物の Cloudflare には送らない。
 */

const BASE = 'https://share.ferretade.dev'
const IP = '203.0.113.9'
const PART = SHARE_LIMITS.partBytes

class MemoryStorage implements RoomStorage, LimiterStorage {
  data = new Map<string, unknown>()
  alarm: number | null = null
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)) }
  async delete(key: string) { return this.data.delete(key) }
  async list<T>(options: { prefix: string }) {
    return new Map([...this.data].filter(([k]) => k.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b)) as Array<[string, T]>)
  }
  async deleteAll() { this.data.clear(); this.alarm = null }
  async setAlarm(time: number) { this.alarm = time }
}

/** R2 の偽物（multipart・範囲の読み出し・一覧） */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>()
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; aborted: boolean }>()
  let n = 0
  const upload = (key: string, uploadId: string): MultipartUpload => ({
    key, uploadId,
    async uploadPart(partNumber, value) {
      const u = uploads.get(uploadId)
      if (!u || u.aborted) throw new Error('no upload')
      u.parts.set(partNumber, new Uint8Array(value as Uint8Array))
      return { partNumber, etag: `e${partNumber}` }
    },
    async complete(parts) {
      const u = uploads.get(uploadId)!
      const chunks = parts.map((p) => u.parts.get(p.partNumber)!)
      const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
      let at = 0
      for (const c of chunks) { out.set(c, at); at += c.length }
      objects.set(key, out)
      uploads.delete(uploadId)
    },
    async abort() { const u = uploads.get(uploadId); if (u) u.aborted = true }
  })
  const bucket: ShareBucket = {
    async put(key, value) { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as Uint8Array)) },
    async get(key, options) {
      const v = objects.get(key)
      if (!v) return null
      const r = options?.range as { offset: number; length?: number } | undefined
      const slice = r ? v.subarray(r.offset, r.length !== undefined ? r.offset + r.length : undefined) : v
      return { body: new Blob([slice as BlobPart]).stream(), size: v.length }
    },
    async head(key) { const v = objects.get(key); return v ? { size: v.length } : null },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k) },
    async list({ prefix }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false } },
    async createMultipartUpload(key) { const id = `u${++n}`; uploads.set(id, { key, parts: new Map(), aborted: false }); return upload(key, id) },
    resumeMultipartUpload(key, uploadId) { return upload(key, uploadId) }
  }
  return { bucket, objects, uploads }
}

function fakeEnv() {
  const { bucket, objects, uploads } = fakeBucket()
  const rooms = new Map<string, { storage: MemoryStorage; obj: ShareRoom }>()
  const limiters = new Map<string, { storage: MemoryStorage; obj: FeedbackLimiter }>()
  const env: Env = {
    RATE_LIMIT_SALT: 'test-salt',
    PUBLIC_BASE: BASE,
    MEDIA: bucket,
    ROOMS: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!rooms.has(name)) { const storage = new MemoryStorage(); rooms.set(name, { storage, obj: new ShareRoom({ storage }, { MEDIA: bucket }) }) }
        const entry = rooms.get(name)!
        return { fetch: (r: Request) => entry.obj.fetch(r) }
      }
    },
    LIMITER: {
      idFromName: (name) => name,
      get(id) {
        const name = id as string
        if (!limiters.has(name)) { const storage = new MemoryStorage(); limiters.set(name, { storage, obj: new FeedbackLimiter({ storage }) }) }
        const entry = limiters.get(name)!
        return { fetch: (r: Request) => entry.obj.fetch(r) }
      }
    }
  }
  return { env, objects, uploads, rooms, limiters }
}

let counter = 0
function deps(now = Date.parse('2026-10-07T00:00:00Z')): Deps & { set(t: number): void } {
  let t = now
  return { now: () => t, set(next: number) { t = next }, random: (bytes) => (++counter).toString(16).padStart(bytes * 2, 'a').slice(-bytes * 2) }
}

const req = (path: string, init: RequestInit & { ip?: string; cookie?: string } = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cf-connecting-ip', init.ip ?? IP)
  if (init.cookie) headers.set('cookie', init.cookie)
  return new Request(`${BASE}${path}`, { ...init, headers })
}
const jsonReq = (path: string, method: string, body: unknown, extra: { origin?: string | null; cookie?: string; ip?: string; auth?: string } = {}) =>
  req(path, { method, ip: extra.ip, cookie: extra.cookie, headers: { 'content-type': 'application/json', ...(extra.origin === null ? {} : { origin: extra.origin ?? BASE }), ...(extra.auth ? { authorization: `Bearer ${extra.auth}` } : {}) }, body: JSON.stringify(body) })
const ownerReq = (path: string, method: string, token: string, body?: unknown) =>
  req(path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

const URLS = [{ url: 'https://acme.example/', title: 'Acme shop' }]

async function create(env: Env, d: Deps, body: Record<string, unknown> = { urls: URLS }) {
  const res = await handle(req('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, d)
  return { res, body: await res.json() as { ok: boolean; id: string; ownerToken: string; url: string; expiresAt: string; code?: string } }
}

/** webm の先頭（EBML）＋中身 */
function webm(size: number): Uint8Array {
  const out = new Uint8Array(size)
  out.set([0x1a, 0x45, 0xdf, 0xa3])
  for (let i = 4; i < size; i++) out[i] = i % 251
  return out
}

async function upload(env: Env, d: Deps, id: string, media: Uint8Array, extra: { cookie?: string; events?: unknown; notes?: unknown; name?: string } = {}) {
  const start = await handle(jsonReq(`/v1/public/${id}/recordings`, 'POST', { mode: 'live', mime: 'video/webm', bytes: media.length, durationMs: 12_000, hasVideo: true, startUrl: URLS[0]!.url, ...(extra.name ? { name: extra.name } : {}) }, { cookie: extra.cookie }), env, d)
  const started = await start.json() as { ok: boolean; id: string; parts: number; code?: string }
  if (!started.ok) return { status: start.status, started }
  for (let n = 1; n <= started.parts; n++) {
    const chunk = media.subarray((n - 1) * PART, n * PART)
    const res = await handle(req(`/v1/public/${id}/recordings/${started.id}/parts/${n}`, { method: 'PUT', cookie: extra.cookie, headers: { origin: BASE, 'content-type': 'application/octet-stream', 'content-length': String(chunk.length) }, body: new Uint8Array(chunk) }), env, d)
    if (res.status !== 200) return { status: res.status, started }
  }
  const done = await handle(jsonReq(`/v1/public/${id}/recordings/${started.id}/complete`, 'POST', {
    notes: extra.notes ?? [{ t: 2000, text: 'Header is too small' }],
    events: extra.events ?? { v: 1, view: { width: 1280, height: 800 }, events: [{ t: 1000, type: 'pen', id: 's1', t_end: 1500, bbox: [10, 20, 100, 50], shape: 'rect' }] }
  }, { cookie: extra.cookie }), env, d)
  return { status: done.status, started }
}

describe('共有を作る（持ち主）', () => {
  it('推測できない ID とトークンを返し、7日で切れる。部屋にはトークンのハッシュだけを置く', async () => {
    const { env, rooms } = fakeEnv()
    const d = deps()
    const { res, body } = await create(env, d, { urls: URLS, memo: { kind: 'plain', text: 'ID: demo\nPassword: hunter22' } })
    expect(res.status).toBe(201)
    expect(body.id).toMatch(/^[0-9a-f]{32}$/)
    expect(body.ownerToken).toMatch(/^[0-9a-f]{64}$/)
    expect(body.url).toBe(shareUrl(body.id, BASE))
    expect(Date.parse(body.expiresAt) - d.now()).toBe(7 * 86_400_000)
    expect(JSON.stringify([...rooms.get(body.id)!.storage.data.values()])).not.toContain(body.ownerToken)
    const view = await (await handle(req(`/v1/public/${body.id}`), env, d)).json() as { share: { memo: { text: string }; urls: unknown[] } }
    expect(view.share.memo.text).toContain('hunter22')
    expect(view.share.urls).toEqual(URLS)
  })

  it('ブラウザ（Origin の付いた要求）からは作れない。ページの無い共有・パスワードの無い暗号化したメモは作れない', async () => {
    const { env } = fakeEnv()
    const d = deps()
    expect((await handle(req('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' }), env, d)).status).toBe(403)
    expect((await create(env, d, { urls: [] })).res.status).toBe(400)
    expect((await create(env, d, { urls: [{ url: 'javascript:alert(1)', title: 'x' }] })).res.status).toBe(400)
    const sealed = await sealMemo('pw-123456', 'secret')
    expect((await create(env, d, { urls: URLS, memo: { kind: 'sealed', sealed } })).res.status).toBe(400)
  })
})

describe('パスワード（サーバーで確かめる）とメモ（ブラウザで暗号化）', () => {
  async function protectedShare() {
    const f = fakeEnv()
    const d = deps()
    const password = generateSharePassword()
    const auth = await makeAuthVerifier(password)
    const sealed = await sealMemo(password, 'ID: demo@acme.example\nPassword: s3cret')
    const { body } = await create(f.env, d, { urls: URLS, auth, memo: { kind: 'sealed', sealed } })
    return { ...f, d, share: body, password, auth }
  }
  const unlock = (env: Env, d: Deps, id: string, proof: string, ip?: string) => handle(jsonReq(`/v1/public/${id}/unlock`, 'POST', { proof }, { ip }), env, d)

  it('パスワードを確かめるまで、題名・メモ・ページ・届いた指摘を何も返さず、録画も受けない', async () => {
    const { env, d, share } = await protectedShare()
    const view = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: Record<string, unknown> }
    expect(view.share).toEqual({ locked: true, salt: expect.any(String), iterations: 100_000 })
    expect(JSON.stringify(view)).not.toMatch(/Acme|acme\.example|sealed/)
    expect((await upload(env, d, share.id, webm(1000))).status).toBe(401)
  })

  it('合えば cookie を出し、それで開ける。メモは暗号文だけで、正しいパスワードでだけ復号できる', async () => {
    const { env, d, share, password, rooms } = await protectedShare()
    expect(JSON.stringify([...rooms.get(share.id)!.storage.data.values()])).not.toContain('s3cret')
    const locked = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { salt: string } }
    const res = await unlock(env, d, share.id, await passwordProof(password, locked.share.salt))
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/^__Host-fs-[0-9a-f]{32}=\d+\.[0-9a-f]{64}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/)
    const pair = cookie.split(';')[0]!
    const view = await (await handle(req(`/v1/public/${share.id}`, { cookie: pair }), env, d)).json() as { share: { locked: boolean; memo: { kind: string; sealed: Parameters<typeof openMemo>[1] } } }
    expect(view.share.locked).toBe(false)
    expect(view.share.memo.kind).toBe('sealed')
    expect(await openMemo(password, view.share.memo.sealed)).toContain('s3cret')
    expect(await openMemo('wrong-password', view.share.memo.sealed)).toBeNull()
    // 別の共有の cookie・壊した cookie では開けない
    expect((await (await handle(req(`/v1/public/${share.id}`, { cookie: pair.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }), env, d)).json() as { share: { locked: boolean } }).share.locked).toBe(true)
  })

  it('違うパスワードは 403、試みは IP と共有の組ごとに数えて止める', async () => {
    const { env, d, share } = await protectedShare()
    const locked = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { salt: string } }
    const max = UNLOCK_PER_IP_SHARE[0]!.max
    for (let i = 0; i < max; i++) expect((await unlock(env, d, share.id, await passwordProof(`guess-${i}`, locked.share.salt))).status).toBe(403)
    expect((await unlock(env, d, share.id, await passwordProof('another', locked.share.salt))).status).toBe(429)
    // 別の IP からは試せる（共有ごとの枠はまだ残る）
    expect((await unlock(env, d, share.id, await passwordProof('another', locked.share.salt), '198.51.100.7')).status).toBe(403)
    // 形の違う証明・Origin の無い要求は断る
    expect((await handle(jsonReq(`/v1/public/${share.id}/unlock`, 'POST', { proof: 'x' }, { ip: '198.51.100.8' }), env, d)).status).toBe(400)
    expect((await handle(jsonReq(`/v1/public/${share.id}/unlock`, 'POST', { proof: '0'.repeat(64) }, { origin: null, ip: '198.51.100.9' }), env, d)).status).toBe(403)
  })

  it('パスワードを変えると古い cookie は効かない。外すと暗号化したメモも消える', async () => {
    const { env, d, share, password } = await protectedShare()
    const locked = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { salt: string } }
    const pair = (await unlock(env, d, share.id, await passwordProof(password, locked.share.salt))).headers.get('set-cookie')!.split(';')[0]!
    const next = await makeAuthVerifier('new-password-1')
    expect((await handle(ownerReq(`/v1/shares/${share.id}`, 'PATCH', share.ownerToken, { auth: next, memo: { kind: 'sealed', sealed: await sealMemo('new-password-1', 'x') } }), env, d)).status).toBe(200)
    expect((await (await handle(req(`/v1/public/${share.id}`, { cookie: pair }), env, d)).json() as { share: { locked: boolean } }).share.locked).toBe(true)
    expect((await handle(ownerReq(`/v1/shares/${share.id}`, 'PATCH', share.ownerToken, { auth: null }), env, d)).status).toBe(200)
    const open = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { locked: boolean; memo?: unknown } }
    expect(open.share.locked).toBe(false)
    expect(open.share.memo).toBeUndefined()
  })
})

describe('録画を送る（分けて送る・形式・上限）', () => {
  async function ready() {
    const f = fakeEnv()
    const d = deps()
    const { body } = await create(f.env, d)
    return { ...f, d, share: body }
  }

  it('分けて順に受け、まとめてから一覧に出す。誰でも見られ、範囲を指定して再生できる', async () => {
    const { env, d, share, objects } = await ready()
    const media = webm(PART * 2 + 1234)
    const sent = await upload(env, d, share.id, media, { name: 'Hanako' })
    expect(sent.status).toBe(200)
    const view = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { recordings: Array<{ id: string; name: string; notes: unknown[]; bytes: number }> } }
    expect(view.share.recordings).toEqual([expect.objectContaining({ name: 'Hanako', bytes: media.length, notes: [{ t: 2000, text: 'Header is too small' }] })])
    const id = view.share.recordings[0]!.id
    const stored = objects.get(`s/${share.id}/${id}/media`)!
    expect(stored.length).toBe(media.length)
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(media).digest('hex'))
    const ranged = await handle(req(`/v1/public/${share.id}/recordings/${id}/media`, { headers: { range: 'bytes=10-19' } }), env, d)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 10-19/${media.length}`)
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(media.subarray(10, 20))
    expect(ranged.headers.get('content-security-policy')).toContain('sandbox')
    // 持ち主は記録（events.json）も取れる。相手の口からは取れない
    expect((await handle(ownerReq(`/v1/shares/${share.id}/recordings/${id}/events.json`, 'GET', share.ownerToken), env, d)).status).toBe(200)
    expect((await handle(req(`/v1/public/${share.id}/recordings/${id}/events.json`), env, d)).status).toBe(404)
  })

  it('順番の違う回・大きさの違う回・宣言と違う形式は受けない（形式が違えば取りやめる）', async () => {
    const { env, d, share, uploads } = await ready()
    const started = await (await handle(jsonReq(`/v1/public/${share.id}/recordings`, 'POST', { mode: 'live', mime: 'video/webm', bytes: PART + 10, durationMs: 1000, hasVideo: true }), env, d)).json() as { id: string }
    const put = (n: number, bytes: Uint8Array) => handle(req(`/v1/public/${share.id}/recordings/${started.id}/parts/${n}`, { method: 'PUT', headers: { origin: BASE, 'content-length': String(bytes.length) }, body: new Uint8Array(bytes) }), env, d)
    expect((await put(2, webm(10))).status).toBe(409)
    expect((await put(1, webm(100))).status).toBe(400)
    const gif = new Uint8Array(PART)
    gif.set([0x47, 0x49, 0x46, 0x38])
    expect((await put(1, gif)).status).toBe(415)
    expect([...uploads.values()].every((u) => u.aborted)).toBe(true)
    // 全部の回が届く前には送り終えられない
    const second = await (await handle(jsonReq(`/v1/public/${share.id}/recordings`, 'POST', { mode: 'live', mime: 'video/webm', bytes: 50, durationMs: 1000, hasVideo: true }), env, d)).json() as { id: string }
    expect((await handle(jsonReq(`/v1/public/${share.id}/recordings/${second.id}/complete`, 'POST', { notes: [] }), env, d)).status).toBe(409)
  })

  it('大きさ・長さ・項目の上限、Origin、honeypot、文字だけの指摘', async () => {
    const { env, d, share } = await ready()
    const start = (body: Record<string, unknown>, origin?: string | null) => handle(jsonReq(`/v1/public/${share.id}/recordings`, 'POST', body, { origin }), env, d)
    expect((await start({ mode: 'live', mime: 'video/webm', bytes: SHARE_LIMITS.recordingBytes + 1, durationMs: 1000, hasVideo: true })).status).toBe(413)
    expect((await start({ mode: 'live', mime: 'video/webm', bytes: 10, durationMs: SHARE_LIMITS.recordingMs + 60_000, hasVideo: true })).status).toBe(413)
    expect((await start({ mode: 'live', mime: 'image/png', bytes: 10, durationMs: 1000, hasVideo: true })).status).toBe(400)
    expect((await start({ mode: 'live', mime: 'video/webm', bytes: 10, durationMs: 1000, hasVideo: true, extra: 1 })).status).toBe(400)
    expect((await start({ mode: 'live', mime: 'video/webm', bytes: 10, durationMs: 1000, hasVideo: true }, null)).status).toBe(403)
    expect((await start({ mode: 'live', mime: 'video/webm', bytes: 10, durationMs: 1000, hasVideo: true }, 'https://evil.example')).status).toBe(403)
    const decoy = await (await start({ mode: 'notes', bytes: 0, durationMs: 0, hasVideo: false, website: 'http://spam.example' })).json() as { decoy?: boolean }
    expect(decoy.decoy).toBe(true)
    const notes = await (await start({ mode: 'notes', bytes: 0, durationMs: 5000, hasVideo: false, name: 'Taro' })).json() as { id: string; parts: number }
    expect(notes.parts).toBe(0)
    expect((await handle(jsonReq(`/v1/public/${share.id}/recordings/${notes.id}/complete`, 'POST', { notes: [{ t: 100, text: '<script>alert(1)</script>' }] }), env, d)).status).toBe(200)
    const view = await (await handle(req(`/v1/public/${share.id}`), env, d)).json() as { share: { recordings: Array<{ notes: Array<{ text: string }>; mode: string }> } }
    expect(view.share.recordings).toHaveLength(1)
    expect(view.share.recordings[0]!.notes[0]!.text).toBe('<script>alert(1)</script>')
  })

  it('断った録画は相手には見えず、持ち主は取れる。消すと R2 からも消える', async () => {
    const { env, d, share, objects } = await ready()
    await upload(env, d, share.id, webm(500))
    const snap = await (await handle(ownerReq(`/v1/shares/${share.id}`, 'GET', share.ownerToken), env, d)).json() as { share: { recordings: Array<{ id: string; status: string }> } }
    const id = snap.share.recordings[0]!.id
    expect((await handle(ownerReq(`/v1/shares/${share.id}/recordings/${id}`, 'POST', share.ownerToken, { status: 'rejected' }), env, d)).status).toBe(200)
    expect(((await (await handle(req(`/v1/public/${share.id}`), env, d)).json()) as { share: { recordings: unknown[] } }).share.recordings).toEqual([])
    expect((await handle(req(`/v1/public/${share.id}/recordings/${id}/media`), env, d)).status).toBe(404)
    expect((await handle(ownerReq(`/v1/shares/${share.id}/recordings/${id}/media`, 'GET', share.ownerToken), env, d)).status).toBe(200)
    expect((await handle(ownerReq(`/v1/shares/${share.id}/recordings/${id}`, 'DELETE', share.ownerToken), env, d)).status).toBe(200)
    expect([...objects.keys()].filter((k) => k.includes(id))).toEqual([])
  })
})

describe('期限と画面', () => {
  it('7日を過ぎたら 410。alarm で録画と記録を消す（送りかけの multipart も取りやめる）', async () => {
    const { env, objects, rooms, uploads } = fakeEnv()
    const d = deps()
    const { body: share } = await create(env, d)
    await upload(env, d, share.id, webm(300))
    await handle(jsonReq(`/v1/public/${share.id}/recordings`, 'POST', { mode: 'live', mime: 'video/webm', bytes: 99, durationMs: 1000, hasVideo: true }), env, d)
    expect(objects.size).toBeGreaterThan(0)
    d.set(Date.parse(share.expiresAt) + 1)
    expect((await handle(req(`/v1/public/${share.id}`), env, d)).status).toBe(410)
    const realNow = Date.now
    Date.now = () => Date.parse(share.expiresAt) + 1
    try {
      await rooms.get(share.id)!.obj.alarm()
    } finally {
      Date.now = realNow
    }
    expect(objects.size).toBe(0)
    expect([...uploads.values()].every((u) => u.aborted)).toBe(true)
    expect(rooms.get(share.id)!.storage.data.size).toBe(0)
  })

  it('画面は厳しい CSP・noindex・Referrer なし・画面とマイクだけ許す。中のスクリプトは自分のものだけ', async () => {
    const { env } = fakeEnv()
    const d = deps()
    const { body: share } = await create(env, d)
    const res = await handle(req(`/s/${share.id}`), env, d)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/)
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('permissions-policy')).toContain('display-capture=(self)')
    expect(await res.text()).toBe(SHARE_HTML)
    // 文字列を HTML として入れる書き方をしない（React の dangerouslySetInnerHTML も使わない）
    expect(SHARE_JS).not.toMatch(/dangerouslySetInnerHTML:\s*\{/)
    const js = await handle(req('/assets/share.js'), env, d)
    expect(js.headers.get('content-type')).toContain('javascript')
  })

  it('トークンの比較は長さが違えば false', () => {
    expect(sameHash('ab', 'ab')).toBe(true)
    expect(sameHash('ab', 'ac')).toBe(false)
    expect(sameHash('ab', 'abc')).toBe(false)
  })
})

describe('共有の形と暗号（src/shared）', () => {
  it('暗号化したメモは往復でき、パスワードが違えば開けない', async () => {
    const sealed = await sealMemo('correct horse', 'ID: a\nPW: b')
    expect(await openMemo('correct horse', sealed)).toBe('ID: a\nPW: b')
    expect(await openMemo('Correct horse', sealed)).toBeNull()
    // 平文もその base64 も入っていない（暗号文は乱数の base64 なので、'PW' の2文字だけなら偶然含まれうる。Windows の関門で一度落ちた）
    expect(sealed.data).not.toContain('PW: b')
    expect(sealed.data).not.toContain(Buffer.from('ID: a\nPW: b').toString('base64').slice(0, 12))
    expect(Buffer.from(sealed.data, 'base64').toString('latin1')).not.toContain('PW: b')
    // 同じ文でも毎回違う暗号文
    expect((await sealMemo('correct horse', 'ID: a\nPW: b')).data).not.toBe(sealed.data)
  })

  it('証明はソルトとパスワードで決まり、verifier はその SHA-256', async () => {
    const auth = await makeAuthVerifier('pw-123456')
    const proof = await passwordProof('pw-123456', auth.salt)
    expect(proof).toMatch(/^[0-9a-f]{64}$/)
    expect(await passwordProof('pw-123457', auth.salt)).not.toBe(proof)
    expect(auth.verifier).not.toBe(proof)
    expect(generateSharePassword()).toMatch(/^[A-Za-z2-9]{16}$/)
  })

  it('メモの形を確かめる', () => {
    expect(sanitizeMemo({ kind: 'plain', text: '  ID: x  ' })).toEqual({ kind: 'plain', text: 'ID: x' })
    expect(sanitizeMemo({ kind: 'plain', text: '' })).toBeNull()
    expect(sanitizeMemo({ kind: 'plain', text: 'x'.repeat(SHARE_LIMITS.memoChars + 1) })).toBeUndefined()
    expect(sanitizeMemo({ kind: 'sealed', sealed: { v: 1, iterations: 5, salt: 'AA==', iv: 'AA==', data: 'AA==' } })).toBeUndefined()
    expect(sanitizeMemo(null)).toBeNull()
  })

  it('記録の JSON は知らない種類・形の違う項目を捨て、時刻を録画の長さに収める', () => {
    const file = sanitizeEventsFile({ v: 1, view: { width: 800, height: 600 }, events: [
      { t: 100, type: 'pen', id: 's1', t_end: 200, bbox: [1, 2, 3, 4], shape: 'rect' },
      { t: 9999999, type: 'note', id: 'n1', bbox: [1, 1, 10, 10], text: 'Fix' },
      { t: 5, type: 'pen', id: '../x', bbox: [1, 2, 3, 4] },
      { t: 5, type: 'script', id: 's2' },
      { t: 5, type: 'erase', ids: ['s1'] }
    ] }, 5000)
    expect(file!.events).toEqual([
      { t: 100, type: 'pen', id: 's1', t_end: 200, bbox: [1, 2, 3, 4], shape: 'rect' },
      { t: 5000, type: 'note', id: 'n1', bbox: [1, 1, 10, 10], text: 'Fix' },
      { t: 5, type: 'erase', ids: ['s1'] }
    ])
    expect(sanitizeEventsFile({ v: 2, view: { width: 1, height: 1 }, events: [] }, 1)).toBeNull()
  })

  it('媒体の形式は中身の先頭で見分ける', () => {
    expect(sniffMedia(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm')
    expect(sniffMedia(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('iso')
    expect(mediaMatches('video/mp4', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe(false)
    expect(sanitizeRecordingStart({ mode: 'notes', bytes: 5, durationMs: 0, hasVideo: false })).toEqual({ error: 'invalid' })
  })

  it('リンクから ID を取り出す', () => {
    const id = 'a'.repeat(32)
    expect(parseShareLink(`${BASE}/s/${id}`)).toBe(id)
    expect(parseShareLink(`https://evil.example/s/${id}`)).toBeNull()
  })
})
