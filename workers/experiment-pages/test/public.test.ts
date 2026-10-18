import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { TEST_ADMIN_TOKEN } from './constants'
import { browserHeaders, CHROME_UA, countRows, createPage, interestBody, postInterest, send } from './helpers'

describe('GET /p/:slug', () => {
  it('renders a published page', async () => {
    await createPage('pub-page')
    const res = await send('/p/pub-page', { headers: { 'User-Agent': CHROME_UA } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('請求書の突合を 1 日から 10 分に')
    expect(html).toContain('<title>突合サービス（先行利用）</title>')
  })
  it('trailing slash serves the same page', async () => {
    await createPage('slash-page')
    expect((await send('/p/slash-page/')).status).toBe(200)
  })
  it('CSP nonce matches the inline style/script nonce and changes per response', async () => {
    await createPage('nonce-page')
    const r1 = await send('/p/nonce-page')
    const r2 = await send('/p/nonce-page')
    const n1 = /'nonce-([^']+)'/.exec(r1.headers.get('Content-Security-Policy') ?? '')?.[1]
    const n2 = /'nonce-([^']+)'/.exec(r2.headers.get('Content-Security-Policy') ?? '')?.[1]
    expect(n1).toBeTruthy()
    expect(n1).not.toBe(n2)
    const html = await r1.text()
    expect(html).toContain(`<style nonce="${n1}">`)
    expect(html).toContain(`<script nonce="${n1}">`)
  })
  it('counts a view server-side, deduped per day', async () => {
    await createPage('view-count')
    const now = new Date('2026-10-17T01:00:00Z')
    const h = { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '198.51.100.7' }
    await send('/p/view-count', { headers: h }, { now })
    await send('/p/view-count', { headers: h }, { now })
    const row = await env.DB.prepare('SELECT * FROM daily_stats WHERE slug = ?').bind('view-count').first()
    expect(row).toMatchObject({ day: '2026-10-17', views: 2, unique_visitors: 1, cta_clicks: 0 })
    expect(await countRows('seen_hashes')).toBe(1)
  })
  it('stores only an HMAC hash, never the raw IP or UA', async () => {
    await createPage('hash-only')
    await send('/p/hash-only', { headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '198.51.100.77' } })
    const row = await env.DB.prepare('SELECT hash FROM seen_hashes').first<{ hash: string }>()
    expect(row?.hash).toMatch(/^[0-9a-f]{32}$/)
    const dump = JSON.stringify(await env.DB.prepare('SELECT * FROM seen_hashes').all())
    expect(dump).not.toContain('198.51.100.77')
    expect(dump).not.toContain('Chrome')
  })
  it('rotating the UA from the same IP still counts one visitor', async () => {
    await createPage('ua-split')
    await send('/p/ua-split', { headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': '198.51.100.8' } })
    await send('/p/ua-split', {
      headers: { 'User-Agent': `${CHROME_UA} Edg/141`, 'CF-Connecting-IP': '198.51.100.8' },
    })
    await send('/p/ua-split', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0',
        'CF-Connecting-IP': '198.51.100.8',
      },
    })
    const row = await env.DB.prepare('SELECT unique_visitors, views FROM daily_stats').first()
    expect(row).toEqual({ unique_visitors: 1, views: 3 })
    expect(await countRows('seen_hashes')).toBe(1)
  })
  it.each(['Googlebot/2.1', 'curl/8.4.0', ''])('does not count bot UA %j', async (ua) => {
    await createPage('bot-skip')
    const res = await send('/p/bot-skip', { headers: ua ? { 'User-Agent': ua } : {} })
    expect(res.status).toBe(200)
    expect(await countRows('daily_stats')).toBe(0)
  })
  it('still renders but does not count when HASH_SALT is missing or short', async () => {
    await createPage('no-salt')
    for (const salt of [undefined, 'short']) {
      const res = await send('/p/no-salt', { headers: { 'User-Agent': CHROME_UA } }, { env: { HASH_SALT: salt } })
      expect(res.status).toBe(200)
    }
    expect(await countRows('daily_stats')).toBe(0)
  })
  it('405 for non-GET', async () => {
    await createPage('post-page')
    const r = await send('/p/post-page', { method: 'POST' })
    expect(r.status).toBe(405)
    expect(r.headers.get('Allow')).toBe('GET')
  })
})

describe('404 indistinguishability', () => {
  async function snapshot(path: string) {
    const res = await send(path, { headers: { 'User-Agent': CHROME_UA } })
    const headers = [...res.headers.entries()]
      .filter(([k]) => k !== 'content-security-policy')
      .sort(([a], [b]) => a.localeCompare(b))
    const csp = (res.headers.get('Content-Security-Policy') ?? '').replace(/nonce-[^']+/g, 'nonce-X')
    const body = (await res.text()).replace(/nonce="[^"]+"/g, 'nonce="X"')
    return { status: res.status, headers, csp, body }
  }
  it('draft, unknown, unpublished and invalid slugs look identical', async () => {
    await createPage('draft-only', { status: 'draft' })
    await createPage('was-public')
    await send('/api/pages/was-public/unpublish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    })
    const draft = await snapshot('/p/draft-only')
    const unknown = await snapshot('/p/never-existed')
    const unpublished = await snapshot('/p/was-public')
    const invalid = await snapshot('/p/INVALID_slug!')
    expect(draft.status).toBe(404)
    expect(unknown).toEqual(draft)
    expect(unpublished).toEqual(draft)
    expect(invalid).toEqual(draft)
    expect(draft.body).not.toContain('下書き')
  })
  it('POST cta / interest on a draft look identical to unknown', async () => {
    await createPage('draft-post', { status: 'draft' })
    for (const action of ['cta', 'interest']) {
      const a = await send(`/p/draft-post/${action}`, { method: 'POST', headers: browserHeaders() })
      const b = await send(`/p/nobody-here/${action}`, { method: 'POST', headers: browserHeaders() })
      expect(a.status).toBe(404)
      expect(b.status).toBe(404)
      expect((await a.text()).replace(/nonce="[^"]+"/g, '')).toBe((await b.text()).replace(/nonce="[^"]+"/g, ''))
    }
    expect(await countRows('daily_stats')).toBe(0)
    expect(await countRows('interests')).toBe(0)
  })
  it('does not record views for drafts', async () => {
    await createPage('draft-noview', { status: 'draft' })
    await send('/p/draft-noview', { headers: { 'User-Agent': CHROME_UA } })
    expect(await countRows('daily_stats')).toBe(0)
  })
})

describe('POST /p/:slug/cta', () => {
  it('204 and counts once per visitor per day', async () => {
    await createPage('cta-page')
    for (let i = 0; i < 3; i++) {
      const r = await send('/p/cta-page/cta', { method: 'POST', headers: browserHeaders() })
      expect(r.status).toBe(204)
    }
    const row = await env.DB.prepare('SELECT cta_clicks, views FROM daily_stats').first()
    expect(row).toEqual({ cta_clicks: 1, views: 0 })
  })
  it('403 for cross-site', async () => {
    await createPage('cta-csrf')
    const r = await send('/p/cta-csrf/cta', {
      method: 'POST',
      headers: browserHeaders({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }),
    })
    expect(r.status).toBe(403)
    expect(await countRows('daily_stats')).toBe(0)
  })
  it('204 but not counted for bots', async () => {
    await createPage('cta-bot')
    const r = await send('/p/cta-bot/cta', { method: 'POST', headers: browserHeaders({ 'User-Agent': 'curl/8' }) })
    expect(r.status).toBe(204)
    expect(await countRows('daily_stats')).toBe(0)
  })
  it('405 for GET', async () => {
    const r = await send('/p/cta-page/cta')
    expect(r.status).toBe(405)
    expect(r.headers.get('Allow')).toBe('POST')
  })
})

describe('POST /p/:slug/interest', () => {
  it('stores a valid submission and shows thanks with escaped name', async () => {
    await createPage('form-page')
    const res = await postInterest('form-page', interestBody({ name: '<b>山田</b>' }))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('送信しました')
    expect(html).toContain('&lt;b&gt;山田&lt;/b&gt; 様')
    expect(html).not.toContain('taro@example.com')
    expect(html).not.toContain('詳しく知りたいです')
    const row = await env.DB.prepare('SELECT * FROM interests').first()
    expect(row).toMatchObject({
      slug: 'form-page',
      experiment_id: 'X01',
      name: '<b>山田</b>',
      company: '株式会社テスト',
      email: 'taro@example.com',
      message: '詳しく知りたいです',
    })
  })
  it('works with a classic form post (Origin matches, no Sec-Fetch-Site)', async () => {
    await createPage('form-old')
    const res = await send('/p/form-old/interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://pages.example.com',
        'User-Agent': CHROME_UA,
      },
      body: interestBody(),
    })
    expect(res.status).toBe(200)
    expect(await countRows('interests')).toBe(1)
  })
  it.each([
    ['cross-site', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }],
    ['same-site subdomain', { 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.pages.example.com' }],
    ['foreign origin only', { 'Sec-Fetch-Site': '', Origin: 'https://evil.example' }],
    ['no headers', { 'Sec-Fetch-Site': '', Origin: '' }],
  ])('403 CSRF: %s', async (_label, h) => {
    await createPage('csrf-page')
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CHROME_UA,
      'CF-Connecting-IP': '203.0.113.5',
    }
    for (const [k, v] of Object.entries(h)) if (v) headers[k] = v
    const res = await send('/p/csrf-page/interest', { method: 'POST', headers, body: interestBody() })
    expect(res.status).toBe(403)
    expect(await countRows('interests')).toBe(0)
    expect(await countRows('rate_counters')).toBe(0)
  })
  it('honeypot: shows thanks but discards', async () => {
    await createPage('hp-page')
    const res = await postInterest('hp-page', interestBody({ website: 'https://spam.example' }))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('送信しました')
    expect(html).not.toContain('様')
    expect(await countRows('interests')).toBe(0)
  })
  it.each([
    ['missing email', { email: '' }],
    ['bad email', { email: 'not-an-email' }],
    ['email too long', { email: `${'a'.repeat(60)}@${'b'.repeat(200)}.com` }],
    ['no consent', { consent: '' }],
    ['consent not yes', { consent: 'true' }],
    ['message too long', { message: 'x'.repeat(2001) }],
    ['name too long', { name: 'x'.repeat(101) }],
  ])('400 for %s and nothing stored', async (_label, fields) => {
    await createPage('val-page')
    const res = await postInterest('val-page', interestBody(fields))
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('入力内容を確認してください')
    expect(html).toContain('href="/p/val-page#interest"')
    expect(await countRows('interests')).toBe(0)
  })
  it('validation error page does not echo the input', async () => {
    await createPage('echo-page')
    const res = await postInterest('echo-page', interestBody({ email: '<script>alert(1)</script>' }))
    const html = await res.text()
    expect(html).not.toContain('alert(1)')
  })
  it('accepts message of exactly 2000 chars', async () => {
    await createPage('max-msg')
    const res = await postInterest('max-msg', interestBody({ message: 'あ'.repeat(2000) }))
    expect(res.status).toBe(200)
  })
  it('415 for non-form content type', async () => {
    await createPage('ct-form')
    const res = await postInterest('ct-form', JSON.stringify({ email: 'a@example.com' }), {
      'Content-Type': 'application/json',
    })
    expect(res.status).toBe(415)
    const res2 = await postInterest('ct-form', interestBody(), { 'Content-Type': 'multipart/form-data; boundary=x' })
    expect(res2.status).toBe(415)
  })
  it('413 for an oversized body', async () => {
    await createPage('big-form')
    const res = await postInterest('big-form', interestBody({ message: 'x'.repeat(40 * 1024) }))
    expect(res.status).toBe(413)
    expect(await countRows('interests')).toBe(0)
  })
  it('503 when HASH_SALT is not configured', async () => {
    await createPage('salt-form')
    const res = await postInterest('salt-form', interestBody(), {}, { env: { HASH_SALT: '' } })
    expect(res.status).toBe(503)
    expect(await countRows('interests')).toBe(0)
  })
  it('405 for GET', async () => {
    expect((await send('/p/form-page/interest')).status).toBe(405)
  })
  it('SQL-looking input is stored verbatim (parameterized)', async () => {
    await createPage('sql-page')
    const msg = "'); DROP TABLE interests; --"
    await postInterest('sql-page', interestBody({ message: msg }))
    const row = await env.DB.prepare('SELECT message FROM interests').first<{ message: string }>()
    expect(row?.message).toBe(msg)
  })
})

describe('misc routes', () => {
  it('robots.txt disallows the api', async () => {
    const r = await send('/robots.txt')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Disallow: /api/')
  })
  it('favicon is an empty 204', async () => {
    expect((await send('/favicon.ico')).status).toBe(204)
  })
  it.each(['/', '/p', '/p/', '/p/abc/cta/extra', '/index.html', '/.env', '/wp-login.php'])(
    '404 for %s',
    async (path) => {
      const r = await send(path)
      expect(r.status).toBe(404)
      expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    },
  )
})
