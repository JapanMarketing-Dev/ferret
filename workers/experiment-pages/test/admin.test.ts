import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import type { ErrorResponse, PageListResponse, PageResponse, StatsResponse } from '../src/contract'
import { TEST_ADMIN_TOKEN } from './constants'
import { admin, createPage, interestBody, postInterest, samplePage, send } from './helpers'

async function errorOf(res: Response): Promise<ErrorResponse['error']> {
  const body = (await res.json()) as ErrorResponse
  return body.error
}

describe('admin auth', () => {
  it('401 without Authorization', async () => {
    const res = await send('/api/pages')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    const e = await errorOf(res)
    expect(e.code).toBe('unauthorized')
    expect(e.message).toBe('認証が必要です')
  })
  it.each([
    ['wrong token', `Bearer ${TEST_ADMIN_TOKEN}x`],
    ['prefix of token', `Bearer ${TEST_ADMIN_TOKEN.slice(0, -1)}`],
    ['lowercase scheme', `bearer ${TEST_ADMIN_TOKEN}`],
    ['basic scheme', `Basic ${btoa(`a:${TEST_ADMIN_TOKEN}`)}`],
    ['token only', TEST_ADMIN_TOKEN],
    ['double space', `Bearer  ${TEST_ADMIN_TOKEN}`],
    ['trailing garbage', `Bearer ${TEST_ADMIN_TOKEN} x`],
    ['empty bearer', 'Bearer '],
  ])('401 with %s', async (_label, auth) => {
    const res = await send('/api/pages', { headers: { Authorization: auth } })
    expect(res.status).toBe(401)
  })
  it('401 for every route and method without auth (no route probing)', async () => {
    for (const [method, path] of [
      ['GET', '/api/pages/abc'],
      ['PUT', '/api/pages/abc'],
      ['POST', '/api/pages/abc/unpublish'],
      ['GET', '/api/pages/abc/stats'],
      ['GET', '/api/pages/abc/interests'],
      ['DELETE', '/api/interests/00000000-0000-0000-0000-000000000000'],
      ['GET', '/api/does-not-exist'],
      ['GET', '/api'],
    ] as const) {
      const res = await send(path, { method })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
  it('rejects all requests when ADMIN_TOKEN is unset', async () => {
    const res = await send(
      '/api/pages',
      { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
      { env: { ADMIN_TOKEN: undefined } },
    )
    expect(res.status).toBe(401)
  })
  it('rejects when ADMIN_TOKEN is shorter than 32 chars, even if it matches', async () => {
    const short = 'a'.repeat(31)
    const res = await send(
      '/api/pages',
      { headers: { Authorization: `Bearer ${short}` } },
      { env: { ADMIN_TOKEN: short } },
    )
    expect(res.status).toBe(401)
  })
  it('accepts exactly 32 chars', async () => {
    const t = 'b'.repeat(32)
    const res = await send('/api/pages', { headers: { Authorization: `Bearer ${t}` } }, { env: { ADMIN_TOKEN: t } })
    expect(res.status).toBe(200)
  })
  it('compares tokens with crypto.subtle.timingSafeEqual, even when unset or missing', async () => {
    const spy = vi.spyOn(crypto.subtle, 'timingSafeEqual')
    try {
      await send('/api/pages')
      await send('/api/pages', { headers: { Authorization: 'Bearer x' } }, { env: { ADMIN_TOKEN: undefined } })
      await send('/api/pages', { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } })
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      spy.mockRestore()
    }
  })
  it('error body has no stack / detail on auth failure', async () => {
    const res = await send('/api/pages', { headers: { Authorization: 'Bearer nope' } })
    const text = await res.text()
    expect(text).toBe(JSON.stringify({ error: { code: 'unauthorized', message: '認証が必要です' } }))
  })
})

describe('PUT /api/pages/:slug', () => {
  it('creates (201) then updates (200)', async () => {
    const r1 = await admin('/api/pages/new-page', { method: 'PUT', body: samplePage({ status: 'draft' }) })
    expect(r1.status).toBe(201)
    const p1 = (await r1.json()) as PageResponse
    expect(p1).toMatchObject({
      slug: 'new-page',
      experimentId: 'X01',
      status: 'draft',
      publishedAt: null,
      path: '/p/new-page',
    })
    const r2 = await admin('/api/pages/new-page', { method: 'PUT', body: samplePage({ title: '新タイトル' }) })
    expect(r2.status).toBe(200)
    const p2 = (await r2.json()) as PageResponse
    expect(p2.title).toBe('新タイトル')
    expect(p2.status).toBe('published')
    expect(p2.publishedAt).not.toBeNull()
    expect(p2.createdAt).toBe(p1.createdAt)
  })
  it('keeps publishedAt when re-saving a published page', async () => {
    await admin('/api/pages/keep-pub', { method: 'PUT', body: samplePage() }, { now: new Date('2026-10-01T00:00:00Z') })
    const r = await admin(
      '/api/pages/keep-pub',
      { method: 'PUT', body: samplePage({ title: 'x' }) },
      { now: new Date('2026-10-05T00:00:00Z') },
    )
    const p = (await r.json()) as PageResponse
    expect(p.publishedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(p.updatedAt).toBe('2026-10-05T00:00:00.000Z')
  })
  it('409 when experimentId changes for an existing slug', async () => {
    await createPage('taken-slug')
    const r = await admin('/api/pages/taken-slug', { method: 'PUT', body: samplePage({ experimentId: 'X02' }) })
    expect(r.status).toBe(409)
    expect((await errorOf(r)).code).toBe('conflict')
  })
  it.each(['ab', 'A-B-C', 'with_underscore', 'a'.repeat(49), 'abc.def', 'abc%20d'])(
    '400 for bad slug %j',
    async (slug) => {
      const r = await admin(`/api/pages/${slug}`, { method: 'PUT', body: samplePage() })
      expect(r.status).toBe(400)
      expect((await errorOf(r)).code).toBe('invalid_request')
    },
  )
  it('dot-segments in the path are normalized and never reach a page', async () => {
    const r = await admin('/api/pages/%2e%2e', { method: 'PUT', body: samplePage() })
    expect(r.status).toBe(404)
    expect(await (await admin('/api/pages')).json()).toEqual({ pages: [] })
  })
  it('400 with details for unknown keys', async () => {
    const r = await admin('/api/pages/unk-keys', { method: 'PUT', body: { ...samplePage(), extra: true } })
    expect(r.status).toBe(400)
    const e = await errorOf(r)
    expect(e.details?.some((d) => d.path === 'extra')).toBe(true)
  })
  it('400 for unknown content keys (e.g. raw html)', async () => {
    const body = samplePage()
    const r = await admin('/api/pages/unk-content', {
      method: 'PUT',
      body: { ...body, content: { ...body.content, html: '<script>alert(1)</script>' } },
    })
    expect(r.status).toBe(400)
  })
  it('400 for malformed JSON', async () => {
    const r = await admin('/api/pages/bad-json', { method: 'PUT', body: '{"a":' })
    expect(r.status).toBe(400)
    expect((await errorOf(r)).message).toBe('JSON として読み取れません')
  })
  it.each(['null', '[]', '"x"', '1'])('400 for non-object JSON %s', async (raw) => {
    const r = await admin('/api/pages/non-obj', { method: 'PUT', body: raw })
    expect(r.status).toBe(400)
  })
  it('415 for non-JSON content type', async () => {
    const r = await admin('/api/pages/ct-page', {
      method: 'PUT',
      body: JSON.stringify(samplePage()),
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(r.status).toBe(415)
    expect((await errorOf(r)).code).toBe('unsupported_media_type')
  })
  it('accepts application/json with charset', async () => {
    const r = await admin('/api/pages/charset-ok', {
      method: 'PUT',
      body: JSON.stringify(samplePage()),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    expect(r.status).toBe(201)
  })
  it('413 for body over 32KB (Content-Length)', async () => {
    const body = JSON.stringify({ ...samplePage(), title: 'x'.repeat(33 * 1024) })
    const r = await admin('/api/pages/too-big', { method: 'PUT', body })
    expect(r.status).toBe(413)
    expect((await errorOf(r)).code).toBe('payload_too_large')
  })
  it('accepts body of exactly 32KB boundary and rejects 32KB+1', async () => {
    const base = JSON.stringify(samplePage())
    const baseBytes = new TextEncoder().encode(base).byteLength
    const pad = (n: number) => `{${' '.repeat(n - baseBytes)}${base.slice(1)}`
    const exact = pad(32 * 1024)
    expect(new TextEncoder().encode(exact).byteLength).toBe(32 * 1024)
    expect((await admin('/api/pages/exact-size', { method: 'PUT', body: exact })).status).toBe(201)
    const over = pad(32 * 1024 + 1)
    expect((await admin('/api/pages/over-size', { method: 'PUT', body: over })).status).toBe(413)
  })
  it('413 for streamed body without Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(8 * 1024))
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(chunk)
        c.close()
      },
    })
    const r = await send('/api/pages/streamed', {
      method: 'PUT',
      body: stream,
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      // @ts-expect-error duplex is required for streaming bodies
      duplex: 'half',
    })
    expect(r.status).toBe(413)
  })
  it('400 for invalid UTF-8', async () => {
    const r = await send('/api/pages/bad-utf8', {
      method: 'PUT',
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    })
    expect(r.status).toBe(400)
  })
  it('405 for unsupported method with Allow header', async () => {
    const r = await admin('/api/pages/abc', { method: 'DELETE' })
    expect(r.status).toBe(405)
    expect(r.headers.get('Allow')).toBe('GET, PUT')
    expect((await errorOf(r)).code).toBe('method_not_allowed')
  })
  it('stores content exactly (no HTML transformation)', async () => {
    await createPage('exact-store', { content: { ...samplePage().content, headline: '<b>"x"&</b>' } })
    const p = (await (await admin('/api/pages/exact-store')).json()) as PageResponse
    expect(p.content.headline).toBe('<b>"x"&</b>')
  })
})

describe('GET /api/pages and /api/pages/:slug', () => {
  it('lists pages', async () => {
    await createPage('list-a')
    await createPage('list-b', { status: 'draft', experimentId: 'X02' })
    const r = await admin('/api/pages')
    expect(r.status).toBe(200)
    const body = (await r.json()) as PageListResponse
    expect(body.pages.map((p) => p.slug).sort()).toEqual(['list-a', 'list-b'])
    expect(body.pages.find((p) => p.slug === 'list-b')).toMatchObject({ status: 'draft', experimentId: 'X02' })
  })
  it('empty list', async () => {
    expect(await (await admin('/api/pages')).json()).toEqual({ pages: [] })
  })
  it('gets a draft page (admin can see drafts)', async () => {
    await createPage('draft-get', { status: 'draft' })
    const r = await admin('/api/pages/draft-get')
    expect(r.status).toBe(200)
    expect(((await r.json()) as PageResponse).status).toBe('draft')
  })
  it('404 json for missing page', async () => {
    const r = await admin('/api/pages/missing-page')
    expect(r.status).toBe(404)
    expect(r.headers.get('Content-Type')).toContain('application/json')
    expect((await errorOf(r)).code).toBe('not_found')
  })
  it('400 for unknown query params', async () => {
    expect((await admin('/api/pages?x=1')).status).toBe(400)
  })
  it('404 for unknown api routes', async () => {
    expect((await admin('/api/unknown')).status).toBe(404)
    expect((await admin('/api/pages/abc/unknown')).status).toBe(404)
    expect((await admin('/api/pages/abc/stats/extra/more')).status).toBe(404)
  })
})

describe('POST /api/pages/:slug/unpublish', () => {
  it('unpublishes and public page becomes 404', async () => {
    await createPage('to-unpub')
    expect((await send('/p/to-unpub')).status).toBe(200)
    const r = await admin('/api/pages/to-unpub/unpublish', { method: 'POST' })
    expect(r.status).toBe(200)
    const p = (await r.json()) as PageResponse
    expect(p.status).toBe('draft')
    expect(p.publishedAt).toBeNull()
    expect((await send('/p/to-unpub')).status).toBe(404)
  })
  it('404 for missing page', async () => {
    expect((await admin('/api/pages/nope-page/unpublish', { method: 'POST' })).status).toBe(404)
  })
  it('405 for GET', async () => {
    expect((await admin('/api/pages/abc/unpublish')).status).toBe(405)
  })
})

describe('GET /api/pages/:slug/stats', () => {
  const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141 Safari/537.36'
  const view = (slug: string, ip: string, now: Date, userAgent = ua) =>
    send(`/p/${slug}`, { headers: { 'User-Agent': userAgent, 'CF-Connecting-IP': ip } }, { now })
  const cta = (slug: string, ip: string, now: Date) =>
    send(
      `/p/${slug}/cta`,
      { method: 'POST', headers: { 'User-Agent': ua, 'CF-Connecting-IP': ip, 'Sec-Fetch-Site': 'same-origin' } },
      { now },
    )

  it('counts views, unique visitors, cta clicks and interests per JST day', async () => {
    await createPage('stats-page')
    const d1 = new Date('2026-10-10T03:00:00Z') // JST 10-10
    const d2 = new Date('2026-10-11T03:00:00Z') // JST 10-11
    await view('stats-page', '198.51.100.1', d1)
    await view('stats-page', '198.51.100.1', d1) // reload same day: view++, unique same
    await view('stats-page', '198.51.100.2', d1)
    await view('stats-page', '198.51.100.1', d2) // new day: counted unique again
    await view('stats-page', '198.51.100.3', d1, 'Googlebot/2.1') // bot: ignored
    await cta('stats-page', '198.51.100.1', d1)
    await cta('stats-page', '198.51.100.1', d1) // dedupe
    await cta('stats-page', '198.51.100.2', d2)
    await postInterest('stats-page', interestBody(), {}, { now: d1 })

    const all = await admin('/api/pages/stats-page/stats?from=2026-10-10&to=2026-10-11')
    expect(all.status).toBe(200)
    expect((await all.json()) as StatsResponse).toEqual({
      slug: 'stats-page',
      experimentId: 'X01',
      from: '2026-10-10',
      to: '2026-10-11',
      views: 4,
      uniqueVisitors: 3,
      ctaClicks: 2,
      interests: 1,
    })
    const onlyD2 = (await (
      await admin('/api/pages/stats-page/stats?from=2026-10-11&to=2026-10-11')
    ).json()) as StatsResponse
    expect(onlyD2).toMatchObject({ views: 1, uniqueVisitors: 1, ctaClicks: 1, interests: 0 })
  })
  it('zero stats for an empty range', async () => {
    await createPage('stats-empty')
    const r = (await (
      await admin('/api/pages/stats-empty/stats?from=2026-01-01&to=2026-01-31')
    ).json()) as StatsResponse
    expect(r).toMatchObject({ views: 0, uniqueVisitors: 0, ctaClicks: 0, interests: 0 })
  })
  it('stats work for drafts too (admin)', async () => {
    await createPage('stats-draft', { status: 'draft' })
    expect((await admin('/api/pages/stats-draft/stats?from=2026-01-01&to=2026-01-31')).status).toBe(200)
  })
  it.each([
    ['', 'missing both'],
    ['?from=2026-10-01', 'missing to'],
    ['?to=2026-10-01', 'missing from'],
    ['?from=2026-10-02&to=2026-10-01', 'reversed'],
    ['?from=2026-02-30&to=2026-03-01', 'impossible date'],
    ['?from=2026-1-1&to=2026-01-02', 'bad format'],
    ['?from=2026-01-01&to=2027-01-02', '367 days'],
    ['?from=2026-01-01&to=2026-01-02&x=1', 'unknown param'],
    ['?from=2026-01-01&from=2026-01-02&to=2026-01-03', 'duplicate param'],
    ["?from=2026-01-01'--&to=2026-01-02", 'sql-ish'],
  ])('400 for %s (%s)', async (q) => {
    await createPage('stats-bad')
    const r = await admin(`/api/pages/stats-bad/stats${q}`)
    expect(r.status).toBe(400)
    expect((await errorOf(r)).code).toBe('invalid_request')
  })
  it('accepts exactly 366 days', async () => {
    await createPage('stats-366')
    expect((await admin('/api/pages/stats-366/stats?from=2024-01-01&to=2024-12-31')).status).toBe(200) // leap year 366
  })
  it('404 for missing page', async () => {
    expect((await admin('/api/pages/no-stats/stats?from=2026-01-01&to=2026-01-02')).status).toBe(404)
  })
})

describe('interests admin', () => {
  it('lists interests with PII only via admin, newest first, and deletes', async () => {
    await createPage('int-page')
    await postInterest(
      'int-page',
      interestBody({ email: 'first@example.com' }),
      {},
      { now: new Date('2026-10-01T00:00:00Z') },
    )
    await postInterest(
      'int-page',
      interestBody({ email: 'second@example.com' }),
      { 'CF-Connecting-IP': '203.0.113.99' },
      { now: new Date('2026-10-02T00:00:00Z') },
    )
    const r = await admin('/api/pages/int-page/interests')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { interests: { id: string; email: string; experimentId: string }[] }
    expect(body.interests.map((i) => i.email)).toEqual(['second@example.com', 'first@example.com'])
    expect(body.interests[0]?.experimentId).toBe('X01')

    const id = body.interests[0]?.id ?? ''
    const del = await admin(`/api/interests/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')
    expect((await admin(`/api/interests/${id}`, { method: 'DELETE' })).status).toBe(404)
    const after = (await (await admin('/api/pages/int-page/interests')).json()) as { interests: unknown[] }
    expect(after.interests).toHaveLength(1)
  })
  it('limit param', async () => {
    await createPage('int-limit')
    for (let i = 0; i < 3; i++) {
      await postInterest('int-limit', interestBody({ email: `u${i}@example.com` }), {
        'CF-Connecting-IP': `198.51.100.${i}`,
      })
    }
    const r = (await (await admin('/api/pages/int-limit/interests?limit=2')).json()) as { interests: unknown[] }
    expect(r.interests).toHaveLength(2)
  })
  it.each(['0', '1001', '-1', 'abc', '1.5', ''])('400 for limit=%j', async (limit) => {
    await createPage('int-badlimit')
    expect((await admin(`/api/pages/int-badlimit/interests?limit=${limit}`)).status).toBe(400)
  })
  it('404 for interests of missing page', async () => {
    expect((await admin('/api/pages/no-page-x/interests')).status).toBe(404)
  })
  it.each(['123', 'not-a-uuid', '00000000-0000-0000-0000-00000000000Z', "' OR 1=1 --"])(
    '400 for bad id %j',
    async (id) => {
      const r = await admin(`/api/interests/${encodeURIComponent(id)}`, { method: 'DELETE' })
      expect(r.status).toBe(400)
    },
  )
  it('405 for GET on interest id', async () => {
    expect((await admin('/api/interests/00000000-0000-0000-0000-000000000000')).status).toBe(405)
  })
  it('public page never exposes interests', async () => {
    await createPage('int-public')
    await postInterest('int-public', interestBody({ email: 'secret@example.com' }))
    const html = await (await send('/p/int-public')).text()
    expect(html).not.toContain('secret@example.com')
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM interests').first<{ n: number }>()
    expect(rows?.n).toBe(1)
  })
})
