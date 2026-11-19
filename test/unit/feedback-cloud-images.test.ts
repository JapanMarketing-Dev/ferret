/**
 * Ferret アカウントで送る・読む指摘の画像と Agent への指示（src/main/feedbackCloud/images.ts・service.ts）。
 * Worker は偽の fetch、保存は一時フォルダで確かめる。外へは送らない
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudClient } from '../../src/main/feedbackCloud/client'
import { ImageCache, MAX_UPLOAD_IMAGES, dropImages, hashLocalImage, uploadImages } from '../../src/main/feedbackCloud/images'
import { CloudService, MAX_UPLOAD_PROMPTS, cloudExtra, imagesToFetch, toCloudEntries } from '../../src/main/feedbackCloud/service'
import { CloudStore } from '../../src/main/feedbackCloud/store'
import { CLOUD_LIMITS, type CloudEntry, type CloudEntryRead, type CloudFeedback } from '../../src/shared/feedbackCloud'
import type { FeedbackEntry } from '../../src/shared/feedbackSkill'
import type { KeyCipher } from '../../src/main/pipeline/stt/keys'

const BASE = 'https://cloud.test'
const TOKEN = ['0123456789abcdef'].join('').repeat(4)
const DEVICE = 'd'.repeat(32)
const OTHER = 'e'.repeat(32)
const ME = { id: '1'.repeat(32), email: 'me@example.com', name: 'Me' }

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const bytes = (s: string) => Buffer.from(`\x89PNG-${s}`)

const fakeCipher = (): KeyCipher => ({
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decrypt: (data) => Buffer.from(data.toString().slice(4), 'base64').toString()
})

let dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ferret-cloudimg-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

/** 画像の Worker の偽物（置いた画像を覚える） */
function imageWorker(opt: { stored?: Map<string, Uint8Array>; failPut?: Set<string>; failMissing?: boolean; serve?: Map<string, Uint8Array>; feedback?: CloudFeedback } = {}) {
  const stored = opt.stored ?? new Map<string, Uint8Array>()
  const calls: Array<{ method: string; path: string; body?: unknown; type?: string | null }> = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.slice(BASE.length)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    calls.push({ method, path, type: headers.get('content-type'), ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) })
    if (path === '/v1/images/missing') {
      if (opt.failMissing) return Response.json({ ok: false, code: 'server' }, { status: 500 })
      const hashes = (JSON.parse(init.body as string) as { hashes: string[] }).hashes
      return Response.json({ ok: true, missing: hashes.filter((h) => !stored.has(h)) })
    }
    const m = /^\/v1\/images\/([0-9a-f]{64})$/.exec(path)
    if (m && method === 'PUT') {
      if (opt.failPut?.has(m[1]!)) return Response.json({ ok: false, code: 'server' }, { status: 500 })
      stored.set(m[1]!, new Uint8Array(init.body as Uint8Array))
      return Response.json({ ok: true })
    }
    if (m && method === 'GET') {
      const data = opt.serve?.get(m[1]!) ?? stored.get(m[1]!)
      return data ? new Response(Buffer.from(data), { headers: { 'content-type': 'image/png' } }) : Response.json({ ok: false, code: 'not_found' }, { status: 404 })
    }
    if (path === '/v1/feedback' && method === 'PUT') return Response.json({ ok: true, stored: 1 })
    if (path === '/v1/feedback') return Response.json({ ok: true, ...(opt.feedback ?? { me: ME, mine: [], teams: [] }) })
    return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
  return { client: new CloudClient({ fetch, base: BASE }), calls, stored }
}

const entry = (hash: string, extra: Partial<CloudEntry> = {}): CloudEntry => ({ key: 'a'.repeat(64), project: 'A', source: 'recording', text: 't', images: [{ hash, type: 'png' }], ...extra })

describe('上げる', () => {
  it('Worker に無い画像だけ PUT する（content-type は形式どおり）', async () => {
    const dir = await tempDir()
    const [a, b] = [bytes('a'), bytes('b')]
    await writeFile(join(dir, 'a.png'), a)
    await writeFile(join(dir, 'b.png'), b)
    const ha = (await hashLocalImage(join(dir, 'a.png')))!.hash
    const hb = (await hashLocalImage(join(dir, 'b.png')))!.hash
    expect(ha).toBe(sha(a))
    const w = imageWorker({ stored: new Map([[ha, a]]) })
    const failed = await uploadImages(w.client, TOKEN, [entry(ha), entry(hb)], new Map([[ha, join(dir, 'a.png')], [hb, join(dir, 'b.png')]]))
    expect(failed.size).toBe(0)
    const puts = w.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => c.path)).toEqual([`/v1/images/${hb}`])
    expect(puts[0]!.type).toBe('image/png')
    expect(w.calls.find((c) => c.path === '/v1/images/missing')!.body).toEqual({ hashes: [ha, hb] })
  })

  it('PUT に失敗した・上げる前に中身が変わった・聞けなかった画像は失敗に入れ、指摘から外す（投げない）', async () => {
    const dir = await tempDir()
    for (const n of ['a', 'b', 'c']) await writeFile(join(dir, `${n}.png`), bytes(n))
    const h = await Promise.all(['a', 'b', 'c'].map(async (n) => (await hashLocalImage(join(dir, `${n}.png`)))!.hash))
    await writeFile(join(dir, 'c.png'), bytes('changed'))
    const paths = new Map(h.map((x, i) => [x, join(dir, `${'abc'[i]}.png`)]))
    const w = imageWorker({ failPut: new Set([h[1]!]) })
    const failed = await uploadImages(w.client, TOKEN, h.map((x) => entry(x)), paths)
    expect([...failed].sort()).toEqual([h[1]!, h[2]!].sort())
    expect(w.stored.has(h[0]!)).toBe(true)
    expect(dropImages([entry(h[0]!), entry(h[1]!)], failed)).toEqual([entry(h[0]!), { key: 'a'.repeat(64), project: 'A', source: 'recording', text: 't' }])

    const down = imageWorker({ failMissing: true })
    expect((await uploadImages(down.client, TOKEN, [entry(h[0]!)], paths)).has(h[0]!)).toBe(true)
    expect(down.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('1回の同期で上げる数に上限がある（超えた分は次の同期）', async () => {
    const dir = await tempDir()
    const paths = new Map<string, string>()
    const list: CloudEntry[] = []
    for (let i = 0; i < MAX_UPLOAD_IMAGES + 5; i++) {
      const p = join(dir, `${i}.png`)
      await writeFile(p, bytes(String(i)))
      const { hash } = (await hashLocalImage(p))!
      paths.set(hash, p)
      list.push(entry(hash))
    }
    const w = imageWorker()
    const failed = await uploadImages(w.client, TOKEN, list, paths)
    expect(failed.size).toBe(5)
    expect(w.calls.filter((c) => c.method === 'PUT')).toHaveLength(MAX_UPLOAD_IMAGES)
    expect(w.calls.filter((c) => c.path === '/v1/images/missing')).toHaveLength(2)
  })

  it('送る指摘に画像の hash・形式・囲みを付け、パスは送らない', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'a.png'), bytes('a'))
    const pathOf = new Map<string, string>()
    const out = await toCloudEntries([{ project: 'A', source: 'visual-review', text: '余白', file: join(dir, 'x.json'),
      images: [{ path: join(dir, 'a.png'), box: { x: 1, y: 2, w: 3, h: 4, width: 10, height: 10 } }, { path: join(dir, 'missing.png') }] }], hashLocalImage, pathOf)
    expect(out[0]!.images).toEqual([{ hash: sha(bytes('a')), type: 'png', box: { x: 1, y: 2, w: 3, h: 4, width: 10, height: 10 } }])
    expect(pathOf.get(sha(bytes('a')))).toBe(join(dir, 'a.png'))
    expect(JSON.stringify(out)).not.toContain(dir)
  })

  it('Agent への指示は指摘の枠を残して MAX_UPLOAD_PROMPTS まで（履歴のパスは送らない）', async () => {
    const prompts: FeedbackEntry[] = Array.from({ length: MAX_UPLOAD_PROMPTS + 10 }, (_, i) => ({ project: 'A', source: 'agent-prompt', title: 'Codex', text: `指示${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), file: '/Users/me/.codex/history.jsonl' }))
    const feedback: FeedbackEntry[] = Array.from({ length: CLOUD_LIMITS.entriesPerDevice - 100 }, (_, i) => ({ project: 'A', source: 'visual-review', text: `指摘${i}`, file: '/p/x.json' }))
    const few = await toCloudEntries(prompts)
    expect(few).toHaveLength(MAX_UPLOAD_PROMPTS)
    expect(few[0]!.text).toBe(`指示${MAX_UPLOAD_PROMPTS + 9}`)
    expect(JSON.stringify(few)).not.toContain('history.jsonl')
    const mixed = await toCloudEntries([...prompts, ...feedback])
    expect(mixed.filter((e) => e.source === 'agent-prompt')).toHaveLength(100)
    expect(mixed.filter((e) => e.source === 'visual-review')).toHaveLength(CLOUD_LIMITS.entriesPerDevice - 100)
  })
})

describe('読む（控え）', () => {
  it('控えていない画像だけ読み、中身の hash が合うものだけ置く。控えのパスを引ける', async () => {
    const dir = await tempDir()
    const good = bytes('good')
    const hg = sha(good)
    const hbad = sha('expected')
    const w = imageWorker({ serve: new Map([[hg, good], [hbad, bytes('tampered')]]) })
    const cache = new ImageCache(join(dir, 'images'))
    expect(await cache.fetchMissing(w.client, TOKEN, [{ hash: hg, type: 'png' }, { hash: hbad, type: 'jpeg' }, { hash: sha('gone'), type: 'png' }, { hash: hg, type: 'png' }])).toBe(1)
    expect(cache.cached({ hash: hg, type: 'png' })).toBe(join(dir, 'images', `${hg}.png`))
    expect(await readFile(join(dir, 'images', `${hg}.png`))).toEqual(good)
    expect(cache.cached({ hash: hbad, type: 'jpeg' })).toBeNull()
    const gets = w.calls.filter((c) => c.method === 'GET').length
    expect(await cache.fetchMissing(w.client, TOKEN, [{ hash: hg, type: 'png' }])).toBe(0)
    expect(w.calls.filter((c) => c.method === 'GET').length).toBe(gets)
  })

  it('控えが上限を超えたら古いものから消す', async () => {
    const dir = await tempDir()
    const cache = new ImageCache(dir, 25)
    for (const [i, name] of ['old', 'mid', 'new'].entries()) {
      await writeFile(join(dir, `${name}.png`), Buffer.alloc(10))
      const t = new Date(Date.UTC(2026, 0, 1 + i))
      await utimes(join(dir, `${name}.png`), t, t)
    }
    await cache.evict()
    expect((await readdir(dir)).sort()).toEqual(['mid.png', 'new.png'])
  })

  it('feedback.md に載るほかの PC・チームの指摘の画像だけを読み、控えた画像を付ける', () => {
    const img = (h: string) => ({ hash: h.repeat(64), type: 'png' as const })
    const read = (over: Partial<CloudEntryRead>): CloudEntryRead => ({ key: 'f'.repeat(64), project: 'A', source: 'recording', text: 't', deviceId: OTHER, deviceName: 'Office', author: { ...ME }, ...over })
    const fb: CloudFeedback = { me: ME, mine: [read({ images: [img('a')] }), read({ deviceId: DEVICE, images: [img('b')] })], teams: [{ id: 't', name: 'T', entries: [read({ images: [{ ...img('c'), box: { x: 1, y: 1, w: 2, h: 2, width: 9, height: 9 } }] })] }] }
    expect(imagesToFetch(fb, DEVICE).map((i) => i.hash[0])).toEqual(['a', 'c'])
    const extra = cloudExtra(fb, DEVICE, (i) => (i.hash.startsWith('a') || i.hash.startsWith('c') ? `/cache/${i.hash[0]}.png` : null))
    expect(extra.otherDevices[0]!.images).toEqual([{ path: '/cache/a.png' }])
    expect(extra.teams[0]!.entries[0]!.images).toEqual([{ path: '/cache/c.png', box: { x: 1, y: 1, w: 2, h: 2, width: 9, height: 9 } }])
    expect(cloudExtra(fb, DEVICE).otherDevices[0]!.images).toBeUndefined()
  })
})

describe('同期の流れ', () => {
  it('画像を上げてから指摘を送り、読んだ画像を控える。ログアウトで控えの画像も消す', async () => {
    const dir = await tempDir()
    const proj = join(dir, 'p')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, '01.png'), bytes('mine'))
    const theirs = bytes('theirs')
    const ht = sha(theirs)
    const fb: CloudFeedback = { me: ME, mine: [{ key: 'f'.repeat(64), project: 'A', source: 'recording', text: '他の PC', images: [{ hash: ht, type: 'png' }], deviceId: OTHER, deviceName: 'Office', author: { ...ME } }], teams: [] }
    const w = imageWorker({ serve: new Map([[ht, theirs]]), feedback: fb })
    const store = new CloudStore(join(dir, 'cloud'), fakeCipher())
    await store.save({ token: TOKEN, email: ME.email })
    const svc = new CloudService({ client: w.client, store, deviceName: () => 'Mac' })
    const local: FeedbackEntry = { project: 'A', source: 'recording', text: 'ボタン', file: join(proj, 'feedback.md'), images: [{ path: join(proj, '01.png') }] }
    await svc.sync([local])
    const order = w.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f]{64}/, '<h>')}`)
    expect(order.slice(0, 4)).toEqual(['POST /v1/images/missing', 'PUT /v1/images/<h>', 'PUT /v1/feedback', 'GET /v1/feedback'])
    const sent = w.calls.find((c) => c.method === 'PUT' && c.path === '/v1/feedback')!.body as { entries: CloudEntry[] }
    expect(sent.entries[0]!.images).toEqual([{ hash: sha(bytes('mine')), type: 'png' }])
    expect(existsSync(join(store.imagesDir(), `${ht}.png`))).toBe(true)

    const extra = await svc.extraFor([local])
    expect(extra!.otherDevices[0]!.images).toEqual([{ path: join(store.imagesDir(), `${ht}.png`) }])

    // 同じ中身なら画像も指摘も送り直さない
    const before = w.calls.length
    await svc.sync([local])
    expect(w.calls.slice(before).map((c) => c.method + ' ' + c.path)).toEqual(['GET /v1/feedback'])

    await svc.logout()
    expect(existsSync(store.imagesDir())).toBe(false)
  })

  it('画像を上げられなくても指摘は送る（画像を外して）。次の同期でまた試す', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, '01.png'), bytes('x'))
    const h = sha(bytes('x'))
    const failPut = new Set([h])
    const w = imageWorker({ failPut })
    const store = new CloudStore(join(dir, 'cloud'), fakeCipher())
    await store.save({ token: TOKEN, email: ME.email })
    const svc = new CloudService({ client: w.client, store, deviceName: () => 'Mac' })
    const local: FeedbackEntry = { project: 'A', source: 'recording', text: 'ボタン', file: join(dir, 'feedback.md'), images: [{ path: join(dir, '01.png') }] }
    await svc.sync([local])
    const first = w.calls.filter((c) => c.method === 'PUT' && c.path === '/v1/feedback').map((c) => c.body as { entries: CloudEntry[] })
    expect(first[0]!.entries[0]!.images).toBeUndefined()
    failPut.clear()
    await svc.sync([local])
    const second = w.calls.filter((c) => c.method === 'PUT' && c.path === '/v1/feedback').map((c) => c.body as { entries: CloudEntry[] })
    expect(second).toHaveLength(2)
    expect(second[1]!.entries[0]!.images).toEqual([{ hash: h, type: 'png' }])
  })
})
