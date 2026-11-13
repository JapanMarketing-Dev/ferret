import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }))

import { ShareApiError, ShareClient } from '../../src/main/feedbackShare/client'
import { shareRecordingMaterial } from '../../src/main/feedbackShare/importRecording'
import { feedbackShareHandlers, readSettingsInput } from '../../src/main/feedbackShare/ipc'
import { MAX_SHARES_PER_PROJECT, ShareStore, sanitizeStoredShares, summarize, type StoredShare } from '../../src/main/feedbackShare/store'
import { openMemo, passwordProof, sha256Hex } from '../../src/shared/shareCrypto'
import type { ShareEventsFile, ShareRecording } from '../../src/shared/feedbackShare'

/**
 * 共有リンクのアプリ側（src/main/feedbackShare）。Worker は偽の fetch、保存は一時フォルダで確かめる。外へは送らない。
 */

const BASE = 'https://share.ferretade.dev'
const ID = 'a'.repeat(32)
const REC = '1'.repeat(16)
// 本物に見える値をリポジトリに置かないよう、実行時に組み立てる
const TOKEN = ['0123456789abcdef'].join('').repeat(4)
const PAGE = { url: 'https://acme.example/', title: 'Home' }

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; auth: string | null; body: unknown }> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, auth: new Headers(init.headers).get('authorization'), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    return respond(url, init)
  }
  return { fetch, calls }
}

const recording = (over: Partial<ShareRecording> = {}): ShareRecording => ({
  id: REC, createdAt: '2026-10-07T00:00:00.000Z', name: 'Hanako', mode: 'live', mime: 'video/webm', bytes: 4, durationMs: 10_000,
  hasVideo: true, hasThumbnail: true, startUrl: PAGE.url, notes: [], status: 'new', ...over
})

describe('Worker との話し方（client.ts）', () => {
  it('トークンは Authorization だけで送り、URL に載せない', async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true, share: { id: ID, urls: [PAGE], recordings: [] } }))
    const client = new ShareClient({ fetch, base: BASE })
    await client.snapshot(ID, TOKEN)
    expect(calls[0]!.url).toBe(`${BASE}/v1/shares/${ID}`)
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('作った共有の応答の形を確かめ、ほかの場所のリンクは受けない', async () => {
    const good = { ok: true, id: ID, ownerToken: TOKEN, url: `${BASE}/s/${ID}`, expiresAt: '2026-10-14T00:00:00.000Z' }
    expect(await new ShareClient({ fetch: fakeFetch(() => Response.json(good, { status: 201 })).fetch, base: BASE }).create({ title: 't', urls: [PAGE] }))
      .toEqual({ id: ID, ownerToken: TOKEN, url: good.url, expiresAt: good.expiresAt })
    const evil = new ShareClient({ fetch: fakeFetch(() => Response.json({ ...good, url: 'https://evil.example/s/x' }, { status: 201 })).fetch, base: BASE })
    await expect(evil.create({ title: 't', urls: [PAGE] })).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('失敗は code だけにし、通信の失敗は network にする。形の違う ID・トークンは送らない', async () => {
    const limited = new ShareClient({ fetch: fakeFetch(() => Response.json({ ok: false, code: 'rate_limited' }, { status: 429 })).fetch, base: BASE })
    await expect(limited.snapshot(ID, TOKEN)).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    const offline = new ShareClient({ fetch: async () => { throw new TypeError('fetch failed') }, base: BASE })
    await expect(offline.snapshot(ID, TOKEN)).rejects.toBeInstanceOf(ShareApiError)
    await expect(offline.snapshot(ID, TOKEN)).rejects.toMatchObject({ code: 'network' })
    const { fetch, calls } = fakeFetch(() => Response.json({ ok: true }))
    await expect(new ShareClient({ fetch, base: BASE }).snapshot('../x', TOKEN)).rejects.toMatchObject({ code: 'not_found' })
    await expect(new ShareClient({ fetch, base: BASE }).snapshot(ID, 'nope')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(new ShareClient({ fetch, base: BASE }).setStatus(ID, TOKEN, '../x', 'rejected')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toEqual([])
  })

  it('サムネイルは JPEG の応答だけ、上限まで受け取る', async () => {
    const ok = new ShareClient({ fetch: fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })).fetch, base: BASE })
    expect(await ok.thumbnail(ID, TOKEN, recording())).toEqual(new Uint8Array([1, 2, 3]))
    const html = new ShareClient({ fetch: fakeFetch(() => new Response('<html>', { headers: { 'content-type': 'text/html' } })).fetch, base: BASE })
    expect(await html.thumbnail(ID, TOKEN, recording())).toBeNull()
    const huge = new ShareClient({ fetch: fakeFetch(() => new Response(new Uint8Array(400 * 1024), { headers: { 'content-type': 'image/jpeg' } })).fetch, base: BASE })
    expect(await huge.thumbnail(ID, TOKEN, recording())).toBeNull()
    const { fetch, calls } = fakeFetch(() => new Response(''))
    expect(await new ShareClient({ fetch, base: BASE }).thumbnail(ID, TOKEN, recording({ hasThumbnail: false }))).toBeNull()
    expect(calls).toEqual([])
  })

  it('録画は届いた大きさが録画の大きさを超えたら止める', async () => {
    const client = new ShareClient({ fetch: fakeFetch(() => new Response(new Uint8Array(10))).fetch, base: BASE })
    const chunks: number[] = []
    await expect(client.media(ID, TOKEN, recording({ bytes: 4 }), async (c) => { chunks.push(c.byteLength) })).rejects.toMatchObject({ code: 'too_large' })
    const fine = new ShareClient({ fetch: fakeFetch(() => new Response(new Uint8Array(4))).fetch, base: BASE })
    let got = 0
    await fine.media(ID, TOKEN, recording({ bytes: 4 }), async (c) => { got += c.byteLength })
    expect(got).toBe(4)
  })

  it('書き込みの記録は形を確かめ、無ければ null', async () => {
    const events: ShareEventsFile = { v: 1, view: { width: 1000, height: 800 }, events: [{ t: 100, type: 'note', id: 'n1', bbox: [100, 100, 200, 100], text: 'Header' }] }
    const client = new ShareClient({ fetch: fakeFetch(() => Response.json(events)).fetch, base: BASE })
    const got = await client.events(ID, TOKEN, recording())
    expect(got?.events).toHaveLength(1)
    const missing = new ShareClient({ fetch: fakeFetch(() => Response.json({ ok: false, code: 'not_found' }, { status: 404 })).fetch, base: BASE })
    expect(await missing.events(ID, TOKEN, recording())).toBeNull()
  })
})

describe('共有の控え（store.ts）', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  const cipher = { available: () => true, encrypt: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`), decrypt: (data: Buffer) => Buffer.from(data.toString().slice(4), 'base64').toString() }
  const share = (n: number, projectId = 'p1', over: Partial<StoredShare> = {}): StoredShare => ({
    id: n.toString(16).padStart(32, '0'), projectId, title: `s${n}`, url: `${BASE}/s/${n}`, createdAt: new Date(Date.UTC(2026, 9, 7, 0, n)).toISOString(),
    expiresAt: '2099-01-01T00:00:00.000Z', ownerToken: TOKEN, urls: [PAGE], memo: '', ...over
  })

  it('トークン・パスワード・メモは暗号化して置き、画面へ返す一覧には入れない。プロジェクトごとに分ける', async () => {
    dir = await mkdtemp(join(tmpdir(), 'share-store-'))
    const path = join(dir, 'shares.bin')
    const store = new ShareStore(path, cipher)
    const secret = ['pass', 'word', '-1'].join('')
    await store.add(share(1, 'p1', { password: secret, memo: 'login: test@acme.example' }))
    await store.add(share(2, 'p2'))
    expect(await readFile(path, 'utf8')).not.toContain(TOKEN)
    const list = await store.list('p1')
    expect(list).toEqual([{ ...summarize(share(1, 'p1', { password: secret, memo: 'login: test@acme.example' })) }])
    expect(list[0]).toMatchObject({ protected: true, hasPassword: true, hasMemo: true })
    expect(JSON.stringify(list)).not.toContain(TOKEN)
    expect(JSON.stringify(list)).not.toContain(secret)
    expect(JSON.stringify(list)).not.toContain('test@acme')
    expect(await store.get('p2', share(1).id)).toBeNull()
    expect((await new ShareStore(path, cipher).get('p1', share(1).id))?.password).toBe(secret)
  })

  it('暗号化できない環境ではファイルに書かない。期限切れ・ページの無い古い形は忘れ、数に上限がある', async () => {
    dir = await mkdtemp(join(tmpdir(), 'share-store-'))
    const path = join(dir, 'shares.bin')
    const plain = new ShareStore(path, { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
    await plain.add(share(1))
    expect(await plain.list('p1')).toHaveLength(1)
    await expect(readFile(path)).rejects.toThrow()

    const store = new ShareStore(join(dir, 'b.bin'), cipher, () => Date.parse('2026-10-07T00:00:00Z'))
    for (let i = 1; i <= MAX_SHARES_PER_PROJECT + 3; i++) await store.add(share(i))
    const list = await store.list('p1')
    expect(list).toHaveLength(MAX_SHARES_PER_PROJECT)
    expect(list.at(-1)!.title).toBe('s4')
    const { urls: _urls, ...v1 } = share(3)
    expect(sanitizeStoredShares({ shares: [{ ...share(1), ownerToken: 'short' }, { ...share(2), id: '../x' }, v1, { ...share(4), urls: [{ url: 'javascript:alert(1)', title: '' }] }] })).toEqual([])
  })
})

describe('共有の設定（ipc.ts）', () => {
  it('画面からの値を確かめる。http(s) のページだけ、パスワードの長さ', () => {
    expect(readSettingsInput({ title: ' t ', urls: [PAGE], memo: 'm' })).toEqual({ title: 't', urls: [PAGE], memo: 'm' })
    expect(readSettingsInput({ title: '', urls: [PAGE], memo: '', password: null })).toMatchObject({ password: null })
    expect(() => readSettingsInput({ title: '', urls: [], memo: '' })).toThrow()
    expect(() => readSettingsInput({ title: '', urls: [{ url: 'file:///etc/passwd', title: '' }], memo: '' })).toThrow()
    expect(() => readSettingsInput({ title: '', urls: [PAGE], memo: '', password: '123' })).toThrow()
  })

  const setup = () => {
    let dir = ''
    const created = { ok: true, id: ID, ownerToken: TOKEN, url: `${BASE}/s/${ID}`, expiresAt: '2099-01-01T00:00:00.000Z' }
    const { fetch, calls } = fakeFetch((url, init) => {
      if (init.method === 'POST' && url.endsWith('/v1/shares')) return Response.json(created, { status: 201 })
      return Response.json({ ok: true })
    })
    const clipboard: string[] = []
    const handlers = feedbackShareHandlers({
      projectId: () => 'p1', projectDir: () => '/tmp/x', fetch, base: BASE, userAgent: 'Ferret/test', installId: () => null,
      userDataDir: () => dir, isPackaged: false, importRecording: vi.fn(), writeClipboard: (text) => clipboard.push(text)
    })
    return { handlers, calls, clipboard, init: async () => { dir = await mkdtemp(join(tmpdir(), 'share-ipc-')); return dir } }
  }

  it('同じページの共有は押すたびに作らず、使い回す', async () => {
    const { handlers, calls, init } = setup()
    const dir = await init()
    try {
      const first = await handlers['share:forPage'](PAGE) as { share: { id: string }; created: boolean }
      const second = await handlers['share:forPage'](PAGE) as { share: { id: string }; created: boolean }
      expect(first.created).toBe(true)
      expect(second).toMatchObject({ created: false, share: { id: first.share.id } })
      expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(1)
      await expect(handlers['share:forPage']({ url: 'file:///x', title: '' })).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('パスワードがあればメモは暗号文だけを送り、パスワードはサーバーへ送らない。コピーは main がクリップボードへ', async () => {
    const { handlers, calls, clipboard, init } = setup()
    const dir = await init()
    const secret = ['open', '-', 'sesame'].join('')
    try {
      const share = await handlers['share:create']({ title: 'Login check', urls: [PAGE], memo: 'user: qa@acme.example', password: secret }) as { id: string; protected: boolean }
      expect(share.protected).toBe(true)
      const sent = calls[0]!.body as { memo: { kind: string; sealed: Parameters<typeof openMemo>[1] }; auth: { salt: string; iterations: number; verifier: string } }
      expect(JSON.stringify(sent)).not.toContain(secret)
      expect(JSON.stringify(sent)).not.toContain('qa@acme')
      expect(sent.memo.kind).toBe('sealed')
      expect(await openMemo(secret, sent.memo.sealed)).toBe('user: qa@acme.example')
      expect(sent.auth.verifier).toBe(await sha256Hex(await passwordProof(secret, sent.auth.salt, sent.auth.iterations)))

      // パスワードを変えずに設定を変えると、確認の値は送り直さない
      await handlers['share:update'](share.id, { title: 'Login check 2', urls: [PAGE], memo: 'user: qa@acme.example' })
      const patch = calls.at(-1)!.body as Record<string, unknown>
      expect(calls.at(-1)!.init.method).toBe('PATCH')
      expect(patch).not.toHaveProperty('auth')
      expect((patch.memo as { kind: string }).kind).toBe('sealed')

      // パスワードを外すと、メモは平文、確認の値は null
      await handlers['share:update'](share.id, { title: 'Open', urls: [PAGE], memo: 'see header', password: null })
      expect(calls.at(-1)!.body).toMatchObject({ memo: { kind: 'plain', text: 'see header' }, auth: null })

      await handlers['share:update'](share.id, { title: 'Again', urls: [PAGE], memo: '', password: secret })
      expect(await handlers['share:copyPassword'](share.id)).toBeUndefined()
      expect(clipboard).toEqual([secret])
      expect(JSON.stringify(await handlers['share:settings'](share.id))).not.toContain(secret)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('届いた録画をレビューの素材にする（importRecording.ts）', () => {
  it('名前を話者にし、文字で指摘は枠と発言に、始めたページは 0 秒の遷移にする', () => {
    const rec = recording({ notes: [{ t: 2000, text: 'Header overlaps' }] })
    const events: ShareEventsFile = { v: 1, view: { width: 1000, height: 800 }, events: [
      { t: 1900, type: 'note', id: 'n1', bbox: [100, 80, 300, 120], text: 'Header overlaps' },
      { t: 3000, type: 'pen', id: 'p1', t_end: 3500, bbox: [500, 400, 100, 60], shape: 'rect' }
    ] }
    const m = shareRecordingMaterial(rec, events, [{ t0: 4000, t1: 5000, speaker: 'self', text: 'And the footer' }])
    expect(m.transcript.map((s) => [s.text, s.speakerName, s.speaker])).toEqual([['Header overlaps', 'Hanako', 'other'], ['And the footer', 'Hanako', 'other']])
    expect(m.events[0]).toEqual({ t: 0, type: 'nav', url: PAGE.url, title: '' })
    expect(m.events.filter((e) => e.type === 'pen').map((e) => (e as { id: string }).id)).toEqual(['note-n1', 'p1'])
    expect(m.penFrames.map((p) => p.annotationId)).toEqual(['note-n1', 'p1'])
  })

  it('名前の無い録画は話者の名前を付けない', () => {
    const m = shareRecordingMaterial(recording({ name: undefined, notes: [{ t: 0, text: 'x' }] }), null, [])
    expect(m.transcript[0]).not.toHaveProperty('speakerName')
  })
})
