import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudApiError, CloudClient, sanitizeEntryRead } from '../../src/main/feedbackCloud/client'
import { CloudStore } from '../../src/main/feedbackCloud/store'
import { CloudService, buildUpload, cloudExtra, toCloudEntries, uploadHash } from '../../src/main/feedbackCloud/service'
import { cloudErrorMessage, feedbackCloudHandlers } from '../../src/main/feedbackCloud/ipc'
import { CLOUD_BASE, CLOUD_LIMITS, cloudEntryKey, type CloudEntryRead, type CloudFeedback } from '../../src/shared/feedbackCloud'
import { renderFeedbackList, type FeedbackEntry } from '../../src/shared/feedbackSkill'
import { UserFacingError } from '../../src/shared/errors'
import { t } from '../../src/shared/i18n'
import type { KeyCipher } from '../../src/main/pipeline/stt/keys'

/**
 * Ferret アカウントのアプリ側（src/main/feedbackCloud）。Worker は偽の fetch、保存は一時フォルダで確かめる。外へは送らない。
 */

const BASE = 'https://cloud.test'
// 本物に見える値をリポジトリに置かないよう、実行時に組み立てる
const TOKEN = ['0123456789abcdef'].join('').repeat(4)
const DEVICE = 'd'.repeat(32)
const OTHER = 'e'.repeat(32)
const ME = { id: '1'.repeat(32), email: 'me@example.com', name: 'Me', teams: [], devices: [] }

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers; body: unknown }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    return respond(url, init)
  }
  return { fetch, calls }
}

const fakeCipher = (available = true): KeyCipher => ({
  available: () => available,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decrypt: (data) => Buffer.from(data.toString().slice(4), 'base64').toString()
})

const local = (over: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
  project: 'A', source: 'visual-review', text: '文字が多い', at: '2026-11-01T00:00:00.000Z', file: '/Users/someone/a/.ferret/visual-review/x.json', ...over
})

const read = (over: Partial<CloudEntryRead> = {}): CloudEntryRead => ({
  key: 'f'.repeat(64), project: 'A', source: 'visual-review', text: 'バナーはいらない', at: '2026-11-02T00:00:00.000Z',
  deviceId: OTHER, deviceName: 'Office-PC', author: { id: ME.id, name: 'Me', email: ME.email }, ...over
})

const feedback = (over: Partial<CloudFeedback> = {}): CloudFeedback => ({ me: { id: ME.id, email: ME.email, name: 'Me' }, mine: [], teams: [], ...over })

let dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferret-cloud-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

describe('Worker との話し方（client.ts）', () => {
  it('トークンは Authorization だけで送り、URL に載せず、Origin は付けない', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true, ...feedback() }))
    await new CloudClient({ fetch, base: BASE, userAgent: 'Ferret/1' }).download(TOKEN)
    expect(calls[0]!.url).toBe(`${BASE}/v1/feedback`)
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.headers.get('origin')).toBeNull()
    expect(calls[0]!.headers.get('user-agent')).toBe('Ferret/1')
  })

  it('既定の送り先は account.ferretade.dev。ログインは client: app で送る', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }))
    await new CloudClient({ fetch }).start('me@example.com')
    expect(calls[0]!.url).toBe(`${CLOUD_BASE}/v1/auth/start`)
    expect(calls[0]!.body).toEqual({ email: 'me@example.com', client: 'app' })
    expect(calls[0]!.headers.get('authorization')).toBeNull()
  })

  it('コードの確かめ: トークンと自分の情報を受け取る。形の違うトークン・6桁でないコードは断る', async () => {
    const ok = fakeFetch(() => Response.json({ ok: true, token: TOKEN, me: ME }))
    expect(await new CloudClient({ fetch: ok.fetch, base: BASE }).verify('me@example.com', '123456')).toEqual({ token: TOKEN, me: ME })
    expect(ok.calls[0]!.body).toEqual({ email: 'me@example.com', code: '123456', client: 'app' })
    const bad = fakeFetch(() => Response.json({ ok: true, token: 'short', me: ME }))
    await expect(new CloudClient({ fetch: bad.fetch, base: BASE }).verify('me@example.com', '123456')).rejects.toMatchObject({ code: 'bad_response' })
    const none = fakeFetch(() => Response.json({ ok: true }))
    await expect(new CloudClient({ fetch: none.fetch, base: BASE }).verify('me@example.com', '12345')).rejects.toMatchObject({ code: 'bad_code' })
    expect(none.calls).toHaveLength(0)
  })

  it('失敗は code だけにする（本文の code・状態の番号から）。知らない code は bad_response', async () => {
    const client = (res: () => Response) => new CloudClient({ fetch: fakeFetch(res).fetch, base: BASE })
    await expect(client(() => Response.json({ ok: false, code: 'rate_limited' }, { status: 429 })).start('a@b.co')).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    await expect(client(() => Response.json({ ok: false, code: 'bad_code' }, { status: 400 })).verify('a@b.co', '000000')).rejects.toMatchObject({ code: 'bad_code' })
    await expect(client(() => Response.json({ ok: false, code: 'code_expired' }, { status: 400 })).verify('a@b.co', '000000')).rejects.toMatchObject({ code: 'code_expired' })
    await expect(client(() => Response.json({ ok: false, code: 'weird' }, { status: 400 })).start('a@b.co')).rejects.toMatchObject({ code: 'bad_response' })
    await expect(client(() => new Response('oops', { status: 401 })).me(TOKEN)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(client(() => new Response('oops', { status: 502 })).me(TOKEN)).rejects.toMatchObject({ code: 'server' })
    await expect(client(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })).me(TOKEN)).rejects.toMatchObject({ code: 'bad_response' })
    await expect(client(() => new Response('[1]', { status: 200, headers: { 'content-type': 'application/json' } })).me(TOKEN)).rejects.toMatchObject({ code: 'bad_response' })
    await expect(client(() => new Response('{"ok":tr', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })).download(TOKEN)).rejects.toMatchObject({ code: 'bad_response' })
  })

  // FERRET-2K（0.8.29 の Windows）：GET /v1/feedback の本文の読み込みが途中で失敗したのを bad_response として送っていた
  it('本文の読み込みの途中の失敗・時間切れは network（知らせない）', async () => {
    const failing = (err: unknown) => () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"ok":true,"me":')); c.error(err) }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    for (const err of [new TypeError('terminated'), new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new DOMException('aborted', 'AbortError'), new Error('ECONNRESET')]) {
      const client = new CloudClient({ fetch: fakeFetch(failing(err)).fetch, base: BASE })
      await expect(client.download(TOKEN)).rejects.toMatchObject({ code: 'network' })
    }
    // 失敗の状態の番号のときは番号から（読めなくても）
    const broken502 = new CloudClient({ fetch: fakeFetch(() => new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated')) } }), { status: 502 })).fetch, base: BASE })
    await expect(broken502.me(TOKEN)).rejects.toMatchObject({ code: 'server', status: 502 })
  })

  it('200 でも JSON でない応答（途中のプロキシ・ログインの要る Wi-Fi の画面）は network', async () => {
    const client = (type: string) => new CloudClient({ fetch: fakeFetch(() => new Response('<html>login</html>', { status: 200, headers: { 'content-type': type } })).fetch, base: BASE })
    await expect(client('text/html; charset=utf-8').download(TOKEN)).rejects.toMatchObject({ code: 'network' })
    await expect(client('text/plain').me(TOKEN)).rejects.toMatchObject({ code: 'network' })
    // JSON の種類は読む
    const ok = new CloudClient({ fetch: fakeFetch(() => new Response(JSON.stringify(ME), { headers: { 'content-type': 'application/problem+json' } })).fetch, base: BASE })
    expect(await ok.me(TOKEN)).toEqual(ME)
  })

  it('エラーのメッセージにトークンを出さない', async () => {
    const err = await new CloudClient({ fetch: fakeFetch(() => Response.json({ ok: false, code: 'server' }, { status: 500 })).fetch, base: BASE }).download(TOKEN).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudApiError)
    expect(String((err as Error).message)).not.toContain(TOKEN)
  })

  it('通信の失敗と時間切れは network', async () => {
    const down = new CloudClient({ fetch: async () => { throw new TypeError('fetch failed') }, base: BASE })
    await expect(down.me(TOKEN)).rejects.toMatchObject({ code: 'network' })
    const hang = new CloudClient({
      base: BASE, timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    })
    await expect(hang.me(TOKEN)).rejects.toMatchObject({ code: 'network' })
  })

  it('形の違うトークンは送らずに unauthorized', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }))
    await expect(new CloudClient({ fetch, base: BASE }).me('nope')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(calls).toHaveLength(0)
  })

  it('自分の情報はそのまま・{ ok, me } のどちらでも読む', async () => {
    expect(await new CloudClient({ fetch: fakeFetch(() => Response.json(ME)).fetch, base: BASE }).me(TOKEN)).toEqual(ME)
    expect(await new CloudClient({ fetch: fakeFetch(() => Response.json({ ok: true, me: ME })).fetch, base: BASE }).me(TOKEN)).toEqual(ME)
  })

  it('読んだ指摘の形の合わないものは落とし、チームは名前のあるものだけ', async () => {
    const body = { ok: true, ...feedback({ mine: [read(), { ...read(), key: 'bad' }, { ...read(), author: null } as unknown as CloudEntryRead], teams: [{ id: 't', name: 'Dev', entries: [read()] }, { id: 'x' } as never] }) }
    const got = await new CloudClient({ fetch: fakeFetch(() => Response.json(body)).fetch, base: BASE }).download(TOKEN)
    expect(got.mine).toHaveLength(1)
    expect(got.teams).toEqual([{ id: 't', name: 'Dev', entries: [read()] }])
    expect(sanitizeEntryRead({ ...read(), source: 'evil' })).toBeNull()
    await expect(new CloudClient({ fetch: fakeFetch(() => Response.json({ ok: true, mine: 'x' })).fetch, base: BASE }).download(TOKEN)).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('送るときは PUT で本文に deviceId と指摘', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true, stored: 1 }))
    const upload = buildUpload(DEVICE, 'Mac', await toCloudEntries([local()]))!
    expect(await new CloudClient({ fetch, base: BASE }).upload(TOKEN, upload)).toBe(1)
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.body).toEqual(upload)
  })
})

describe('控え（store.ts）', () => {
  it('トークンは暗号化して残し、読み戻せる。平文で書かない', async () => {
    const dir = await tempDir()
    await new CloudStore(dir, fakeCipher()).save({ token: TOKEN, email: 'me@example.com' })
    const raw = await readFile(join(dir, 'account.bin'), 'utf8')
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain('me@example.com')
    expect(await new CloudStore(dir, fakeCipher()).load()).toEqual({ token: TOKEN, email: 'me@example.com' })
    if (process.platform !== 'win32') expect((await stat(join(dir, 'account.bin'))).mode & 0o077).toBe(0)
  })

  it('暗号化できないときは保存せず、その起動の間だけ持つ', async () => {
    const dir = await tempDir()
    const store = new CloudStore(dir, fakeCipher(false))
    await store.save({ token: TOKEN, email: 'me@example.com' })
    expect(await store.load()).toEqual({ token: TOKEN, email: 'me@example.com' })
    expect(existsSync(join(dir, 'account.bin'))).toBe(false)
    expect(store.persisted()).toBe(false)
    expect(await new CloudStore(dir, fakeCipher(false)).load()).toBeNull()
  })

  it('復号できない・形の違う控えはログインしていないことにする', async () => {
    const dir = await tempDir()
    await new CloudStore(dir, fakeCipher()).save({ token: 'short', email: 'me@example.com' })
    expect(await new CloudStore(dir, fakeCipher()).load()).toBeNull()
    const broken: KeyCipher = { ...fakeCipher(), decrypt: () => { throw new Error('bad key') } }
    expect(await new CloudStore(dir, broken).load()).toBeNull()
  })

  it('この PC の id は1度作ったら変わらず、ログアウトしても残る', async () => {
    const dir = await tempDir()
    const store = new CloudStore(dir, fakeCipher())
    const id = await store.device()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(await store.device()).toBe(id)
    await store.save({ token: TOKEN, email: 'me@example.com' })
    await store.clear()
    expect(await new CloudStore(dir, fakeCipher()).device()).toBe(id)
    // 暗号化できない環境でも同じ id
    expect(await new CloudStore(dir, fakeCipher(false)).device()).toBe(id)
  })

  it('ログアウトでトークンと控えの指摘を消す', async () => {
    const dir = await tempDir()
    const store = new CloudStore(dir, fakeCipher())
    await store.save({ token: TOKEN, email: 'me@example.com' })
    await store.writeCache({ feedback: feedback(), syncedAt: '2026-11-19T00:00:00.000Z', uploadHash: 'h' })
    expect(await new CloudStore(dir, fakeCipher()).readCache()).toMatchObject({ uploadHash: 'h' })
    await store.clear()
    expect(existsSync(join(dir, 'account.bin'))).toBe(false)
    expect(existsSync(join(dir, 'cache.json'))).toBe(false)
    expect(await store.load()).toBeNull()
    expect(await store.readCache()).toBeNull()
  })

  it('読み込む前は、鍵の仕組みに触れずに「分からない」を返す', async () => {
    const available = vi.fn(() => true)
    const store = new CloudStore(await tempDir(), { ...fakeCipher(), available })
    expect(store.loadedLoggedIn()).toBeNull()
    await store.load()
    // ファイルが無ければ鍵の仕組みに触れない
    expect(available).not.toHaveBeenCalled()
    expect(store.loadedLoggedIn()).toBe(false)
  })
})

describe('送る形（service.ts）', () => {
  it('ファイルのパスは送らない。key はプロジェクト・どこで・文から決まり、同じ指摘は1つ', async () => {
    const entries = await toCloudEntries([local(), local({ file: '/other/path.json' }), local({ text: '別の指摘', title: '設定画面' })])
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(entries)).not.toContain('/Users/')
    expect(JSON.stringify(entries)).not.toContain('.ferret')
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['key', 'project', 'source', 'text']))
    expect(entries.every((e) => !('file' in e))).toBe(true)
    expect(entries[0]!.key).toBe(await cloudEntryKey({ project: 'A', source: 'visual-review', text: '文字が多い' }))
    expect((await toCloudEntries([local()]))[0]!.key).toBe(entries[0]!.key)
    expect(entries[1]).toMatchObject({ title: '設定画面', text: '別の指摘' })
  })

  it('ほかの PC・チームから来た指摘（ファイルの無いもの）は送り返さない', async () => {
    expect(await toCloudEntries([local({ file: '' }), local({ origin: 'other PC: X' })])).toEqual([])
  })

  it('上限の数・大きさを超えれば新しいものから残す', async () => {
    const many = Array.from({ length: CLOUD_LIMITS.entriesPerDevice + 5 }, (_, i) => ({
      key: i.toString(16).padStart(64, '0'), project: 'A', source: 'recording' as const, text: 'x'.repeat(1900), at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
    }))
    const upload = buildUpload(DEVICE, 'Mac', many)!
    expect(upload.entries.length).toBeLessThanOrEqual(CLOUD_LIMITS.entriesPerDevice)
    expect(new TextEncoder().encode(JSON.stringify(upload)).byteLength).toBeLessThanOrEqual(CLOUD_LIMITS.uploadBytes)
    expect(upload.entries[0]!.at).toBe(many.at(-1)!.at)
    expect(buildUpload('bad', 'Mac', [])).toBeNull()
  })

  it('読んだ分から、この PC の分を除き、チームは書いた人の名前を付ける', () => {
    const extra = cloudExtra(feedback({
      mine: [read({ deviceId: DEVICE, text: 'この PC の分' }), read()],
      teams: [{ id: 't', name: 'Design', entries: [read({ author: { id: '2'.repeat(32), name: 'Hanako', email: 'h@example.com' }, text: '余白を揃えて' })] }]
    }), DEVICE)
    expect(extra.otherDevices.map((e) => e.text)).toEqual(['バナーはいらない'])
    expect(extra.otherDevices[0]!.deviceName).toBe('Office-PC')
    expect(extra.teams).toEqual([{ name: 'Design', entries: [expect.objectContaining({ author: 'Hanako', text: '余白を揃えて' })] }])
  })
})

function service(opt: { respond: (url: string, init: RequestInit) => Response; now?: () => number; cipher?: KeyCipher; dir: string }) {
  const { fetch, calls } = fakeFetch(opt.respond)
  const store = new CloudStore(opt.dir, opt.cipher ?? fakeCipher())
  const svc = new CloudService({ client: new CloudClient({ fetch, base: BASE }), store, deviceName: () => 'Mac', ...(opt.now ? { now: opt.now } : {}) })
  return { svc, calls, store }
}

function worker(state: { feedback: CloudFeedback; fail?: string }) {
  return (url: string, init: RequestInit): Response => {
    if (state.fail === 'network') throw new TypeError('offline')
    if (state.fail) return Response.json({ ok: false, code: state.fail }, { status: state.fail === 'unauthorized' ? 401 : 500 })
    if (url.endsWith('/v1/auth/start')) return Response.json({ ok: true })
    if (url.endsWith('/v1/auth/verify')) return Response.json({ ok: true, token: TOKEN, me: ME })
    if (url.endsWith('/v1/auth/logout')) return Response.json({ ok: true })
    if (url.endsWith('/v1/feedback') && init.method === 'PUT') return Response.json({ ok: true, stored: 1 })
    if (url.endsWith('/v1/feedback')) return Response.json({ ok: true, ...state.feedback })
    return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
}

describe('ログインと同期（service.ts）', () => {
  it('コードを送ったメールでログインし、メールを小文字にして覚える', async () => {
    const { svc, calls } = service({ dir: await tempDir(), respond: worker({ feedback: feedback() }) })
    await svc.start('  Me@Example.com ')
    expect(calls[0]!.body).toEqual({ email: 'me@example.com', client: 'app' })
    expect(await svc.verify('123 456')).toMatchObject({ loggedIn: true, email: 'me@example.com', persisted: true })
    expect(calls[1]!.body).toMatchObject({ email: 'me@example.com', code: '123456' })
  })

  it('形の違うメールは送らずに断り、コードを送る前の verify は期限切れにする', async () => {
    const { svc, calls } = service({ dir: await tempDir(), respond: worker({ feedback: feedback() }) })
    await expect(svc.start('not-an-email')).rejects.toMatchObject({ code: 'bad_email' })
    await expect(svc.verify('123456')).rejects.toMatchObject({ code: 'code_expired' })
    expect(calls).toHaveLength(0)
  })

  it('ログインしていなければ同期しない・feedback.md に足さない', async () => {
    const { svc, calls } = service({ dir: await tempDir(), respond: worker({ feedback: feedback() }) })
    expect(await svc.sync([local()])).toBeNull()
    expect(await svc.extraFor([local()])).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('送って読み、控える。同じ中身は送り直さない', async () => {
    const dir = await tempDir()
    let now = Date.UTC(2026, 10, 19)
    const state = { feedback: feedback({ mine: [read()] }) }
    const { svc, calls } = service({ dir, respond: worker(state), now: () => now })
    await svc.start('me@example.com')
    await svc.verify('123456')
    calls.length = 0
    await svc.sync([local()])
    expect(calls.map((c) => c.init.method)).toEqual(['PUT', 'GET'])
    calls.length = 0
    now += 120_000
    await svc.sync([local()])
    expect(calls.map((c) => c.init.method)).toEqual(['GET'])
    calls.length = 0
    await svc.sync([local(), local({ text: '新しい指摘' })])
    expect(calls.map((c) => c.init.method)).toEqual(['PUT', 'GET'])
    expect(await svc.status()).toMatchObject({ loggedIn: true, mine: 1, team: 0, lastSyncAt: new Date(now).toISOString() })
  })

  it('読んだ直後の書き直しは控えを使い、二度読まない', async () => {
    const dir = await tempDir()
    const now = Date.UTC(2026, 10, 19)
    const { svc, calls } = service({ dir, respond: worker({ feedback: feedback({ mine: [read()] }) }), now: () => now })
    await svc.start('me@example.com')
    await svc.verify('123456')
    await svc.sync([local()])
    calls.length = 0
    const extra = await svc.extraFor([local()])
    expect(calls).toHaveLength(0)
    expect(extra?.otherDevices).toHaveLength(1)
  })

  it('つながらなければ控えを使い、知らせない。思っていない失敗だけ知らせる', async () => {
    const dir = await tempDir()
    let now = Date.UTC(2026, 10, 19)
    const state: { feedback: CloudFeedback; fail?: string } = { feedback: feedback({ mine: [read()] }) }
    const { svc } = service({ dir, respond: worker(state), now: () => now })
    await svc.start('me@example.com')
    await svc.verify('123456')
    await svc.sync([local()])
    now += 10 * 60_000
    state.fail = 'network'
    const report = vi.fn()
    expect((await svc.extraFor([local()], report))?.otherDevices.map((e) => e.text)).toEqual(['バナーはいらない'])
    expect(report).not.toHaveBeenCalled()
    await expect(svc.sync([local()])).rejects.toMatchObject({ code: 'network' })
  })

  it('トークンが効かなくなったら（401）ログアウトしたことにし、控えも消す', async () => {
    const dir = await tempDir()
    const state: { feedback: CloudFeedback; fail?: string } = { feedback: feedback({ mine: [read()] }) }
    const { svc } = service({ dir, respond: worker(state) })
    await svc.start('me@example.com')
    await svc.verify('123456')
    await svc.sync([local()])
    state.fail = 'unauthorized'
    await expect(svc.sync([local({ text: '別' })])).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await svc.status()).toEqual({ loggedIn: false, persisted: true })
    expect(existsSync(join(dir, 'cache.json'))).toBe(false)
    expect(await svc.extraFor([local()])).toBeNull()
  })

  it('ログアウトは Worker に届かなくても手元のトークンと控えを消し、PC の id は残す', async () => {
    const dir = await tempDir()
    const state: { feedback: CloudFeedback; fail?: string } = { feedback: feedback() }
    const { svc, store } = service({ dir, respond: worker(state) })
    await svc.start('me@example.com')
    await svc.verify('123456')
    await svc.sync([local()])
    const id = await store.device()
    state.fail = 'network'
    await svc.logout()
    expect(await svc.status()).toEqual({ loggedIn: false, persisted: true })
    expect(existsSync(join(dir, 'account.bin'))).toBe(false)
    expect(existsSync(join(dir, 'cache.json'))).toBe(false)
    expect(await new CloudStore(dir, fakeCipher()).device()).toBe(id)
  })
})

describe('feedback.md のほかの PC とチームの指摘', () => {
  it('ほかの PC の指摘は一覧と型に混ざり、ファイルの代わりに PC の名前を出す', () => {
    const md = renderFeedbackList([local({ text: 'これ削除して' })], undefined, [], {
      otherDevices: [{ project: 'B', source: 'recording', text: '不要な欄を消して', at: '2026-11-03T00:00:00.000Z', deviceName: 'Office-PC' }],
      teams: []
    })
    expect(md).toContain('不要な欄を消して (other PC: Office-PC)')
    expect(md).toContain('これ削除して (`/Users/someone/a/.ferret/visual-review/x.json`)')
    // 2件で「要らないものを消す」の型になる（この PC とほかの PC を合わせて数える）
    expect(md).toMatch(/\*\*Remove what is not needed\*\* \(2 times, 2 projects\)/)
    expect(md).not.toContain("Your team's feedback")
  })

  it('この PC の指摘と同じものは重ねない', () => {
    const md = renderFeedbackList([local()], undefined, [], {
      otherDevices: [{ project: 'A', source: 'visual-review', text: '文字が多い', deviceName: 'Office-PC' }], teams: []
    })
    expect(md.match(/文字が多い/g)).toHaveLength(1)
    expect(md).not.toContain('(other PC: Office-PC)')
  })

  it('チームの節に、メンバーの繰り返し出る型と、チーム名・書いた人を出す', () => {
    const member = (text: string, author = 'Hanako') => ({ project: 'Shop', source: 'visual-review' as const, text, at: '2026-11-05T00:00:00.000Z', deviceName: 'X', author })
    const md = renderFeedbackList([local()], undefined, [], {
      otherDevices: [],
      teams: [{ name: 'Design', entries: [member('余白がズレてる'), member('ボタンが重なってる', 'Taro'), member('余白がズレてる'), member('えっと')] }]
    })
    expect(md).toContain("## Your team's feedback")
    expect(md).toMatch(/### Recurring in the team[\s\S]*\*\*Alignment and overlap\*\* \(2 times/)
    expect(md).toContain('余白がズレてる (Design · Hanako)')
    expect(md).toContain('ボタンが重なってる (Design · Taro)')
    // 同じ人の同じ文は1つ、相づちは落とす
    expect(md.match(/余白がズレてる \(Design/g)).toHaveLength(1)
    expect(md).not.toContain('えっと')
    // チームの指摘は自分の型の数に入れない
    expect(md.indexOf("## Your team's feedback")).toBeGreaterThan(md.indexOf('## All feedback'))
  })

  it('この PC に指摘が無くても、チームの指摘があれば載せる', () => {
    const md = renderFeedbackList([], undefined, [], { otherDevices: [], teams: [{ name: 'T', entries: [{ project: 'P', source: 'recording', text: '速くして', deviceName: 'X', author: 'A' }] }] })
    expect(md).toContain('速くして (T · A)')
  })

  it('足す分が無ければ今までと同じ', () => {
    expect(renderFeedbackList([local()])).toBe(renderFeedbackList([local()], undefined, [], { otherDevices: [], teams: [] }))
  })
})

describe('IPC（ipc.ts）', () => {
  async function handlers(respond: (url: string, init: RequestInit) => Response, syncNow = vi.fn(async () => undefined)) {
    const { svc, calls } = service({ dir: await tempDir(), respond })
    const openExternal = vi.fn(async () => undefined)
    return { h: feedbackCloudHandlers({ service: async () => svc, openExternal, syncNow }), calls, openExternal, syncNow }
  }

  it('形の違うメール・コードは Worker に送らず、画面向けの文で断る', async () => {
    const { h, calls } = await handlers(worker({ feedback: feedback() }))
    await expect(h['cloud:start'](42 as unknown as string)).rejects.toThrow(t('cloud.errors.badEmail'))
    await expect(h['cloud:start']('nope')).rejects.toThrow(t('cloud.errors.badEmail'))
    await expect(h['cloud:verify']('12ab56')).rejects.toThrow(t('cloud.errors.badCode'))
    await expect(h['cloud:verify'](null as unknown as string)).rejects.toBeInstanceOf(UserFacingError)
    expect(calls).toHaveLength(0)
  })

  it('ログインの流れ: コードを送る → ログイン → すぐ同期 → ログアウト', async () => {
    const { h, syncNow } = await handlers(worker({ feedback: feedback() }))
    expect(await h['cloud:status']()).toEqual({ loggedIn: false, persisted: true })
    await h['cloud:start']('me@example.com')
    expect(await h['cloud:verify']('123456')).toMatchObject({ loggedIn: true, email: 'me@example.com' })
    expect(syncNow).toHaveBeenCalledTimes(1)
    expect(await h['cloud:logout']()).toEqual({ loggedIn: false, persisted: true })
  })

  it('Worker の失敗を画面向けの文にする（違うコード・期限切れ・混雑・つながらない）', async () => {
    for (const [code, key] of [['bad_code', 'cloud.errors.badCode'], ['code_expired', 'cloud.errors.codeExpired'], ['rate_limited', 'cloud.errors.rateLimited']] as const) {
      const { h } = await handlers((url) => url.endsWith('/start') ? Response.json({ ok: true }) : Response.json({ ok: false, code }, { status: 400 }))
      await h['cloud:start']('me@example.com')
      const err = await Promise.resolve(h['cloud:verify']('123456')).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UserFacingError)
      expect((err as Error).message).toBe(t(key))
    }
    const { h } = await handlers(() => { throw new TypeError('offline') })
    await expect(h['cloud:start']('me@example.com')).rejects.toThrow(t('cloud.errors.network'))
    expect(cloudErrorMessage(new CloudApiError('server'))).toBe(t('cloud.errors.failed'))
  })

  it('ログインしていなければ今すぐ同期は断る。Web は account.ferretade.dev を開く', async () => {
    const { h, syncNow, openExternal } = await handlers(worker({ feedback: feedback() }))
    await expect(h['cloud:syncNow']()).rejects.toThrow(t('cloud.errors.signedOut'))
    expect(syncNow).not.toHaveBeenCalled()
    await h['cloud:openWeb']()
    expect(openExternal).toHaveBeenCalledWith(CLOUD_BASE)
  })

  it('今すぐ同期の通信の失敗は画面向けの文にする', async () => {
    const { h } = await handlers(worker({ feedback: feedback() }), vi.fn(async () => { throw new CloudApiError('network') }))
    await h['cloud:start']('me@example.com')
    await h['cloud:verify']('123456')
    await expect(h['cloud:syncNow']()).rejects.toThrow(t('cloud.errors.network'))
  })
})

describe('同じ中身の要約', () => {
  it('中身が同じなら同じ、違えば違う', async () => {
    const a = buildUpload(DEVICE, 'Mac', await toCloudEntries([local()]))!
    const b = buildUpload(DEVICE, 'Mac', await toCloudEntries([local()]))!
    const c = buildUpload(DEVICE, 'Mac', await toCloudEntries([local({ text: '別' })]))!
    expect(uploadHash(a)).toBe(uploadHash(b))
    expect(uploadHash(a)).not.toBe(uploadHash(c))
  })
})
