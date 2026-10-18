import { describe, expect, it } from 'vitest'
import { constantTimeEqual, hmacHex, randomNonce } from '../src/crypto'
import { buildCsp } from '../src/http'
import { isValidEmail, parseInterestForm } from '../src/interest'
import { resolvePosthog } from '../src/posthog'
import { redact, scrubEvent, sentryOptions } from '../src/sentry'
import { addDays, jstDay, utcHour } from '../src/time'
import { isBot, isSameOriginRequest } from '../src/visitor'
import { CHROME_UA } from './helpers'

describe('time', () => {
  it('jstDay switches at 15:00 UTC', () => {
    expect(jstDay(new Date('2026-10-17T14:59:59.999Z'))).toBe('2026-10-17')
    expect(jstDay(new Date('2026-10-17T15:00:00.000Z'))).toBe('2026-10-18')
  })
  it('addDays crosses month/year', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('utcHour', () => {
    expect(utcHour(new Date('2026-10-17T09:59:59Z'))).toBe('2026-10-17T09')
  })
})

describe('crypto', () => {
  it('hmacHex is deterministic and salt dependent', async () => {
    const a = await hmacHex('salt-a', 'msg')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await hmacHex('salt-a', 'msg')).toBe(a)
    expect(await hmacHex('salt-b', 'msg')).not.toBe(a)
  })
  it('constantTimeEqual', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true)
    expect(await constantTimeEqual('abc', 'abd')).toBe(false)
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(await constantTimeEqual('', '')).toBe(true)
  })
  it('nonce is random base64 of 16 bytes', () => {
    const a = randomNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(randomNonce()).not.toBe(a)
  })
})

describe('isBot', () => {
  it.each([
    null,
    '',
    'short',
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'curl/8.4.0',
    'Wget/1.21',
    'python-requests/2.31',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36',
    'facebookexternalhit/1.1',
    'Slackbot-LinkExpanding 1.0',
    'Mozilla/5.0 Chrome-Lighthouse',
    'node-fetch/1.0',
    'axios/1.6.0',
  ])('treats %j as bot', (ua) => expect(isBot(ua)).toBe(true))
  it.each([
    CHROME_UA,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  ])('treats %j as human', (ua) => expect(isBot(ua)).toBe(false))
})

describe('isSameOriginRequest', () => {
  const req = (h: Record<string, string>) => new Request('https://pages.example.com/p/abc/interest', { headers: h })
  it('accepts Sec-Fetch-Site same-origin', () => {
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  })
  it('accepts same-origin with Origin null (no-referrer form post)', () => {
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-origin', Origin: 'null' }))).toBe(true)
  })
  it('accepts matching Origin without Sec-Fetch-Site (older browsers)', () => {
    expect(isSameOriginRequest(req({ Origin: 'https://pages.example.com' }))).toBe(true)
  })
  it.each(['cross-site', 'same-site', 'none'])('rejects Sec-Fetch-Site %s', (site) => {
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': site }))).toBe(false)
  })
  it('rejects foreign Origin even if Sec-Fetch-Site claims same-origin', () => {
    expect(isSameOriginRequest(req({ 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' }))).toBe(false)
  })
  it('rejects scheme / port mismatch', () => {
    expect(isSameOriginRequest(req({ Origin: 'http://pages.example.com' }))).toBe(false)
    expect(isSameOriginRequest(req({ Origin: 'https://pages.example.com:8443' }))).toBe(false)
    expect(isSameOriginRequest(req({ Origin: 'https://pages.example.com.evil.example' }))).toBe(false)
  })
  it('rejects when no signal at all', () => {
    expect(isSameOriginRequest(req({}))).toBe(false)
    expect(isSameOriginRequest(req({ Origin: 'null' }))).toBe(false)
  })
})

describe('isValidEmail', () => {
  it.each(['a@example.com', 'taro.yamada+lp@example.co.jp', "o'neil@example.org", 'x@sub-domain.example.com'])(
    'accepts %s',
    (e) => expect(isValidEmail(e)).toBe(true),
  )
  it.each([
    'plain',
    '@example.com',
    'a@',
    'a@example',
    'a@@example.com',
    'a b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a..b@example.com',
    'a@-example.com',
    'a@example-.com',
    '<a>@example.com',
    'a@example.com\n',
    'あ@example.com',
    `${'a'.repeat(65)}@example.com`,
  ])('rejects %j', (e) => expect(isValidEmail(e)).toBe(false))
  it('254 chars boundary', () => {
    const domain = `${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(63)}.com` // 195
    const ok = `${'a'.repeat(254 - domain.length - 1)}@${domain}`
    expect(ok.length).toBe(254)
    expect(ok.split('@')[0]?.length).toBeLessThanOrEqual(64)
    expect(isValidEmail(ok)).toBe(true)
    const domain2 = domain
    const ng = `${'a'.repeat(255 - domain2.length - 1)}@${domain2}`
    expect(ng.length).toBe(255)
    expect(isValidEmail(ng)).toBe(false)
  })
})

describe('parseInterestForm', () => {
  const base = { email: 'a@example.com', consent: 'yes' }
  const p = (o: Record<string, string>) => parseInterestForm(new URLSearchParams(o))
  it('accepts minimal', () => {
    const r = p(base)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.value).toEqual({ name: '', company: '', email: 'a@example.com', message: '' })
  })
  it('trims and normalizes CRLF', () => {
    const r = p({ ...base, name: '  太郎 ', message: 'a\r\nb\rc' })
    if (r.kind !== 'ok') throw new Error('expected ok')
    expect(r.value.name).toBe('太郎')
    expect(r.value.message).toBe('a\nb\nc')
  })
  it('honeypot wins over validation', () => {
    expect(p({ website: 'http://spam', email: 'bad' }).kind).toBe('honeypot')
  })
  it.each(['no', 'on', 'YES', ''])('rejects consent %j', (consent) => {
    expect(p({ ...base, consent }).kind).toBe('invalid')
  })
  it('rejects missing consent', () => {
    expect(p({ email: 'a@example.com' }).kind).toBe('invalid')
  })
  it('requires email', () => {
    expect(p({ consent: 'yes' }).kind).toBe('invalid')
  })
  it('message boundary 2000/2001', () => {
    expect(p({ ...base, message: 'あ'.repeat(2000) }).kind).toBe('ok')
    expect(p({ ...base, message: 'あ'.repeat(2001) }).kind).toBe('invalid')
  })
  it('name/company boundaries', () => {
    expect(p({ ...base, name: 'n'.repeat(100) }).kind).toBe('ok')
    expect(p({ ...base, name: 'n'.repeat(101) }).kind).toBe('invalid')
    expect(p({ ...base, company: 'c'.repeat(200) }).kind).toBe('ok')
    expect(p({ ...base, company: 'c'.repeat(201) }).kind).toBe('invalid')
  })
  it('rejects control chars and newlines in single-line fields', () => {
    expect(p({ ...base, name: 'a\nb' }).kind).toBe('invalid')
    expect(p({ ...base, company: 'a\u0000b' }).kind).toBe('invalid')
    expect(p({ ...base, message: 'a\u0007b' }).kind).toBe('invalid')
    expect(p({ ...base, message: 'a\u202eb' }).kind).toBe('invalid')
  })
  it('rejects duplicated fields', () => {
    const params = new URLSearchParams('email=a@example.com&email=b@example.com&consent=yes')
    expect(parseInterestForm(params).kind).toBe('invalid')
  })
  it('does not echo input in messages', () => {
    const r = p({ ...base, email: '<script>x</script>' })
    if (r.kind !== 'invalid') throw new Error('expected invalid')
    expect(r.messages.join('')).not.toContain('script')
  })
  it('ignores unknown fields', () => {
    expect(p({ ...base, utm_source: 'x' }).kind).toBe('ok')
  })
})

describe('resolvePosthog', () => {
  it('disabled when unset or partial', () => {
    expect(resolvePosthog({})).toBeNull()
    expect(resolvePosthog({ POSTHOG_KEY: 'phc_abcdefgh', POSTHOG_HOST: '' })).toBeNull()
    expect(resolvePosthog({ POSTHOG_KEY: '', POSTHOG_HOST: 'https://us.i.posthog.com' })).toBeNull()
  })
  it.each([
    'http://us.i.posthog.com',
    'https://us.i.posthog.com/path',
    'https://user:pw@us.i.posthog.com',
    'https://us.i.posthog.com?x=1',
    'javascript:alert(1)',
    'not a url',
    "https://x.example'; script-src *",
  ])('rejects host %j', (host) => {
    expect(resolvePosthog({ POSTHOG_KEY: 'phc_abcdefgh', POSTHOG_HOST: host })).toBeNull()
  })
  it.each(['short', 'phc key with space', 'phc_"quote"', `phc_${'a'.repeat(200)}`])('rejects key %j', (key) => {
    expect(resolvePosthog({ POSTHOG_KEY: key, POSTHOG_HOST: 'https://us.i.posthog.com' })).toBeNull()
  })
  it('eu cloud host', () => {
    expect(resolvePosthog({ POSTHOG_KEY: 'phc_abcdefgh', POSTHOG_HOST: 'https://eu.i.posthog.com/' })?.origins).toEqual(
      ['https://eu.i.posthog.com', 'https://eu-assets.i.posthog.com'],
    )
  })
  it('self-hosted / proxy host allows only itself', () => {
    expect(resolvePosthog({ POSTHOG_KEY: 'phc_abcdefgh', POSTHOG_HOST: 'https://ph.example.com' })?.origins).toEqual([
      'https://ph.example.com',
    ])
  })
})

describe('buildCsp', () => {
  it('base policy', () => {
    const csp = buildCsp()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).not.toContain('script-src')
  })
  it('nonce for style, script only when asked', () => {
    expect(buildCsp({ nonce: 'N' })).toContain("style-src 'nonce-N'")
    expect(buildCsp({ nonce: 'N' })).not.toContain('script-src')
    expect(buildCsp({ nonce: 'N', script: true })).toContain("script-src 'nonce-N'")
    expect(buildCsp({ nonce: 'N', script: true })).toContain("connect-src 'self'")
  })
  it('never allows unsafe-inline / unsafe-eval / wildcard', () => {
    const csp = buildCsp({ nonce: 'N', script: true, extraOrigins: ['https://us.i.posthog.com'] })
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/)
  })
})

describe('sentry scrubbing', () => {
  it('redact removes emails, IPs, bearer tokens', () => {
    const r = redact('user taro@example.com from 203.0.113.9 / 2001:db8::1 with Bearer abc.def')
    expect(r).not.toContain('taro@example.com')
    expect(r).not.toContain('203.0.113.9')
    expect(r).not.toContain('2001:db8')
    expect(r).not.toContain('abc.def')
  })
  it('scrubEvent drops request body, headers, cookies, query, user', () => {
    const ev = scrubEvent({
      message: 'failed for a@example.com',
      request: {
        url: 'https://x.example/p/abc/interest?email=a@example.com',
        method: 'POST',
        data: 'email=a%40example.com',
        headers: { Authorization: 'Bearer secret', 'CF-Connecting-IP': '203.0.113.1' },
        cookies: { a: 'b' },
        query_string: 'email=a@example.com',
      },
      user: { ip_address: '203.0.113.1', email: 'a@example.com' },
      exception: { values: [{ type: 'Error', value: 'bad email a@example.com' }] },
      breadcrumbs: [{ message: 'fetch 203.0.113.1', data: { body: 'secret' } }],
      extra: { body: 'x' },
      tags: { who: 'a@example.com' },
    })
    const json = JSON.stringify(ev)
    expect(json).not.toContain('a@example.com')
    expect(json).not.toContain('a%40example.com')
    expect(json).not.toContain('203.0.113.1')
    expect(json).not.toContain('secret')
    expect(ev.request).toEqual({ method: 'POST', url: 'https://x.example/p/abc/interest' })
    expect(ev.user).toBeUndefined()
  })
  it('options are disabled without DSN and never collect PII', () => {
    const o = sentryOptions({ SENTRY_DSN: '' } as never)
    expect(o.enabled).toBe(false)
    expect(o.dsn).toBeUndefined()
    expect(o.dataCollection?.httpHeaders).toBe(false)
    expect(o.dataCollection?.httpBodies).toEqual([])
    expect(o.dataCollection?.userInfo).toBe(false)
    const on = sentryOptions({ SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' } as never)
    expect(on.enabled).toBe(true)
  })
})
