import { describe, expect, it } from 'vitest'
import { TEST_ADMIN_TOKEN } from './constants'
import { browserHeaders, CHROME_UA, createPage, interestBody, postInterest, send } from './helpers'

const REQUIRED = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-frame-options': 'DENY',
}

function expectSecurityHeaders(res: Response, label: string) {
  for (const [k, v] of Object.entries(REQUIRED)) expect(res.headers.get(k), `${label}: ${k}`).toBe(v)
  const pp = res.headers.get('permissions-policy') ?? ''
  expect(pp, label).toContain('camera=()')
  expect(pp, label).toContain('geolocation=()')
  const csp = res.headers.get('content-security-policy') ?? ''
  for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) {
    expect(csp, `${label}: ${d}`).toContain(d)
  }
  expect(csp, label).not.toMatch(/unsafe-inline|unsafe-eval/)
}

describe('security headers on every response', () => {
  it('covers all routes and status codes', async () => {
    await createPage('sec-page')
    await createPage('sec-draft', { status: 'draft' })
    const auth = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
    const cases: [string, () => Promise<Response>, number][] = [
      ['page 200', () => send('/p/sec-page', { headers: { 'User-Agent': CHROME_UA } }), 200],
      ['page 404 draft', () => send('/p/sec-draft'), 404],
      ['page 404 unknown', () => send('/p/unknown-x'), 404],
      ['root 404', () => send('/'), 404],
      ['page 405', () => send('/p/sec-page', { method: 'PUT' }), 405],
      ['cta 204', () => send('/p/sec-page/cta', { method: 'POST', headers: browserHeaders() }), 204],
      ['cta 403', () => send('/p/sec-page/cta', { method: 'POST' }), 403],
      ['interest 200', () => postInterest('sec-page'), 200],
      [
        'interest 400',
        () => postInterest('sec-page', interestBody({ consent: 'no' }), { 'CF-Connecting-IP': '1.1.1.1' }),
        400,
      ],
      ['interest 415', () => postInterest('sec-page', '{}', { 'Content-Type': 'application/json' }), 415],
      ['interest 503', () => postInterest('sec-page', interestBody(), {}, { env: { HASH_SALT: '' } }), 503],
      ['robots', () => send('/robots.txt'), 200],
      ['favicon', () => send('/favicon.ico'), 204],
      ['api 401', () => send('/api/pages'), 401],
      ['api 200', () => send('/api/pages', { headers: auth }), 200],
      ['api 404', () => send('/api/pages/nope-nope', { headers: auth }), 404],
      ['api 405', () => send('/api/pages', { method: 'POST', headers: auth }), 405],
      ['api 400', () => send('/api/pages/x', { headers: auth }), 400],
    ]
    for (const [label, fn, status] of cases) {
      const res = await fn()
      expect(res.status, label).toBe(status)
      expectSecurityHeaders(res, label)
    }
  })
  it('rate-limited (429) responses carry headers too', async () => {
    await createPage('sec-rl')
    let res: Response | undefined
    for (let i = 0; i < 6; i++) res = await postInterest('sec-rl')
    expect(res?.status).toBe(429)
    if (res) expectSecurityHeaders(res, '429')
  })
  it('500 responses carry headers and leak no detail', async () => {
    const broken = {
      prepare() {
        throw new Error('D1 exploded for taro@example.com at /src/db.ts:10')
      },
    } as unknown as D1Database
    const pub = await send('/p/some-page', {}, { env: { DB: broken } })
    expect(pub.status).toBe(500)
    expectSecurityHeaders(pub, '500 public')
    const pubText = await pub.text()
    expect(pubText).not.toContain('exploded')
    expect(pubText).not.toContain('taro@example.com')

    const api = await send(
      '/api/pages',
      { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } },
      { env: { DB: broken } },
    )
    expect(api.status).toBe(500)
    expectSecurityHeaders(api, '500 api')
    expect(await api.json()).toEqual({ error: { code: 'internal_error', message: 'サーバー内部でエラーが起きました' } })
  })
  it('public page CSP has script nonce and only self for connect', async () => {
    await createPage('csp-page')
    const csp = (await send('/p/csp-page')).headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'(;|$)/)
    expect(csp).toMatch(/connect-src 'self'(;|$)/)
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'(;|$)/)
    expect(csp).not.toContain('https:')
  })
  it('non-page HTML (404/thanks) has no script-src at all', async () => {
    const csp = (await send('/p/none-here')).headers.get('content-security-policy') ?? ''
    expect(csp).not.toContain('script-src')
  })
  it('admin JSON responses are not cacheable and not CORS-enabled', async () => {
    const r = await send('/api/pages', {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, Origin: 'https://evil.example' },
    })
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('PostHog on/off', () => {
  const PH = { POSTHOG_KEY: 'phc_abcdefghijklmnop', POSTHOG_HOST: 'https://us.i.posthog.com' }
  it('off by default: no third-party script, no third-party CSP origin', async () => {
    await createPage('ph-off')
    const res = await send('/p/ph-off')
    const html = await res.text()
    expect(html).not.toContain('posthog')
    expect(html).not.toMatch(/https?:\/\//)
    expect(res.headers.get('content-security-policy')).not.toContain('posthog')
  })
  it('on: script present and CSP allows exactly the PostHog hosts', async () => {
    await createPage('ph-on')
    const res = await send('/p/ph-on', {}, { env: PH })
    const html = await res.text()
    expect(html).toContain('"person_profiles":"identified_only"')
    expect(html).toContain('"maskAllInputs":true')
    expect(html).toContain('phc_abcdefghijklmnop')
    const csp = res.headers.get('content-security-policy') ?? ''
    const script = csp.split('; ').find((d) => d.startsWith('script-src')) ?? ''
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src')) ?? ''
    expect(script.split(' ').slice(2)).toEqual(['https://us.i.posthog.com', 'https://us-assets.i.posthog.com'])
    expect(connect).toBe("connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com")
  })
  it('self-hosted host only allows that host', async () => {
    await createPage('ph-self')
    const res = await send(
      '/p/ph-self',
      {},
      { env: { POSTHOG_KEY: 'phc_abcdefghijklmnop', POSTHOG_HOST: 'https://e.example.com' } },
    )
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("connect-src 'self' https://e.example.com")
    expect(csp).not.toContain('posthog.com')
  })
  it('invalid config falls back to off (no injection into CSP)', async () => {
    await createPage('ph-bad')
    const res = await send(
      '/p/ph-bad',
      {},
      { env: { POSTHOG_KEY: 'phc_abcdefghijklmnop', POSTHOG_HOST: 'https://x.example; script-src *' } },
    )
    expect(res.headers.get('content-security-policy')).not.toContain('x.example')
    expect(await res.text()).not.toContain('posthog')
  })
  it('PostHog is never added to 404 / thanks pages', async () => {
    await createPage('ph-thanks')
    const nf = await send('/p/ph-missing', {}, { env: PH })
    expect(await nf.text()).not.toContain('posthog')
    const th = await postInterest('ph-thanks', interestBody(), {}, { env: PH })
    expect(await th.text()).not.toContain('posthog')
    expect(th.headers.get('content-security-policy')).not.toContain('posthog')
  })
})
