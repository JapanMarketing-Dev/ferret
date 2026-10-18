import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  CTA_IP_LIMIT_PER_HOUR,
  EVENT_SLUG_LIMIT_PER_DAY,
  IP_LIMIT_PER_HOUR,
  SEEN_CAP_PER_DAY,
  SLUG_LIMIT_PER_DAY,
  VIEW_IP_LIMIT_PER_HOUR,
} from '../src/public'
import { browserHeaders, CHROME_UA, countRows, createPage, interestBody, postInterest, send } from './helpers'

const at = (iso: string) => ({ now: new Date(iso) })

describe('rate limit per hashed IP (5/hour)', () => {
  it('5th ok, 6th blocked with 429 and Retry-After', async () => {
    expect(IP_LIMIT_PER_HOUR).toBe(5)
    await createPage('rl-ip')
    for (let i = 1; i <= 5; i++) {
      const r = await postInterest(
        'rl-ip',
        interestBody({ email: `u${i}@example.com` }),
        {},
        at('2026-10-17T10:10:00Z'),
      )
      expect(r.status, `attempt ${i}`).toBe(200)
    }
    const sixth = await postInterest('rl-ip', interestBody(), {}, at('2026-10-17T10:59:59Z'))
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('Retry-After')).toBe('3600')
    expect(await sixth.text()).toContain('送信回数の上限です')
    expect(await countRows('interests')).toBe(5)
  })
  it('resets in the next hour window', async () => {
    await createPage('rl-reset')
    for (let i = 0; i < 6; i++) await postInterest('rl-reset', interestBody(), {}, at('2026-10-17T10:30:00Z'))
    const next = await postInterest('rl-reset', interestBody(), {}, at('2026-10-17T11:00:00Z'))
    expect(next.status).toBe(200)
  })
  it('different IPs are independent', async () => {
    await createPage('rl-ips')
    for (let i = 0; i < 5; i++) await postInterest('rl-ips', interestBody(), {}, at('2026-10-17T10:00:00Z'))
    const other = await postInterest(
      'rl-ips',
      interestBody(),
      { 'CF-Connecting-IP': '203.0.113.200' },
      at('2026-10-17T10:00:00Z'),
    )
    expect(other.status).toBe(200)
  })
  it('the limit is shared across pages (per IP, not per page)', async () => {
    await createPage('rl-a')
    await createPage('rl-b', { experimentId: 'X02' })
    for (let i = 0; i < 5; i++)
      await postInterest(i % 2 ? 'rl-a' : 'rl-b', interestBody(), {}, at('2026-10-17T10:00:00Z'))
    expect((await postInterest('rl-a', interestBody(), {}, at('2026-10-17T10:00:00Z'))).status).toBe(429)
  })
  it('honeypot and invalid submissions also consume the budget', async () => {
    await createPage('rl-abuse')
    for (let i = 0; i < 3; i++)
      await postInterest('rl-abuse', interestBody({ website: 'x' }), {}, at('2026-10-17T10:00:00Z'))
    for (let i = 0; i < 2; i++)
      await postInterest('rl-abuse', interestBody({ email: 'bad' }), {}, at('2026-10-17T10:00:00Z'))
    expect((await postInterest('rl-abuse', interestBody(), {}, at('2026-10-17T10:00:00Z'))).status).toBe(429)
    expect(await countRows('interests')).toBe(0)
  })
  it('parallel submissions from one IP: exactly 5 accepted, the counter stays at 5', async () => {
    await createPage('rl-par')
    const rs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        postInterest('rl-par', interestBody({ email: `p${i}@example.com` }), {}, at('2026-10-17T10:10:00Z')),
      ),
    )
    expect(rs.filter((r) => r.status === 200)).toHaveLength(5)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(7)
    expect(await countRows('interests')).toBe(5)
    const row = await env.DB.prepare("SELECT count FROM rate_counters WHERE key LIKE 'ip:%'").first<{ count: number }>()
    expect(row?.count).toBe(IP_LIMIT_PER_HOUR)
  })
  it('stores only hashed IP keys', async () => {
    await createPage('rl-hash')
    await postInterest('rl-hash', interestBody(), { 'CF-Connecting-IP': '192.0.2.123' })
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM rate_counters').all()).results)
    expect(dump).not.toContain('192.0.2.123')
    expect(dump).toMatch(/ip:[0-9a-f]{32}/)
  })
})

describe('rate limit per slug (200/day JST)', () => {
  async function seed(slug: string, day: string, count: number) {
    await env.DB.prepare('INSERT INTO rate_counters (key, bucket, count, expires_at) VALUES (?, ?, ?, ?)')
      .bind(`slug:${slug}`, day, count, '2099-01-01T00:00:00.000Z')
      .run()
  }
  it('200th ok, 201st blocked', async () => {
    expect(SLUG_LIMIT_PER_DAY).toBe(200)
    await createPage('rl-slug')
    await seed('rl-slug', '2026-10-17', 199)
    const ok = await postInterest('rl-slug', interestBody(), {}, at('2026-10-17T05:00:00Z'))
    expect(ok.status).toBe(200)
    const blocked = await postInterest(
      'rl-slug',
      interestBody(),
      { 'CF-Connecting-IP': '203.0.113.201' },
      at('2026-10-17T05:00:00Z'),
    )
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('86400')
  })
  it('the day boundary is JST midnight (15:00 UTC)', async () => {
    await createPage('rl-day')
    await seed('rl-day', '2026-10-17', 200)
    expect((await postInterest('rl-day', interestBody(), {}, at('2026-10-17T14:59:00Z'))).status).toBe(429)
    expect(
      (await postInterest('rl-day', interestBody(), { 'CF-Connecting-IP': '203.0.113.9' }, at('2026-10-17T15:00:00Z')))
        .status,
    ).toBe(200)
  })
  it('other slugs are unaffected', async () => {
    await createPage('rl-full')
    await createPage('rl-free', { experimentId: 'X03' })
    await seed('rl-full', '2026-10-17', 200)
    expect((await postInterest('rl-free', interestBody(), {}, at('2026-10-17T05:00:00Z'))).status).toBe(200)
  })
})

describe('view / CTA limits (counted but never blocking the page)', () => {
  const view = (slug: string, ip: string, iso: string) =>
    send(`/p/${slug}`, { headers: { 'User-Agent': CHROME_UA, 'CF-Connecting-IP': ip } }, at(iso))
  const cta = (slug: string, ip: string, iso: string) =>
    send(`/p/${slug}/cta`, { method: 'POST', headers: browserHeaders({ 'CF-Connecting-IP': ip }) }, at(iso))
  const stats = (slug: string) =>
    env.DB.prepare('SELECT views, unique_visitors, cta_clicks FROM daily_stats WHERE slug = ?').bind(slug).first()
  async function seed(key: string, bucket: string, count: number) {
    await env.DB.prepare('INSERT INTO rate_counters (key, bucket, count, expires_at) VALUES (?, ?, ?, ?)')
      .bind(key, bucket, count, '2099-01-01T00:00:00.000Z')
      .run()
  }

  it('per IP: views over 60/hour still render 200 but stop counting', async () => {
    expect(VIEW_IP_LIMIT_PER_HOUR).toBe(60)
    await createPage('ev-ip')
    for (let i = 0; i < VIEW_IP_LIMIT_PER_HOUR + 5; i++) {
      const r = await view('ev-ip', '198.51.100.30', '2026-10-17T01:10:00Z')
      expect(r.status).toBe(200)
    }
    expect(await stats('ev-ip')).toEqual({ views: VIEW_IP_LIMIT_PER_HOUR, unique_visitors: 1, cta_clicks: 0 })
    // 上限を超えた要求はカウンタにも書かない（上限のまま）
    const ipRow = await env.DB.prepare("SELECT count FROM rate_counters WHERE key LIKE 'vip:%'").first<{
      count: number
    }>()
    expect(ipRow?.count).toBe(VIEW_IP_LIMIT_PER_HOUR)
    // 次の時間帯はまた数える
    await view('ev-ip', '198.51.100.30', '2026-10-17T02:00:00Z')
    expect(await stats('ev-ip')).toMatchObject({ views: VIEW_IP_LIMIT_PER_HOUR + 1 })
  })

  it('per IP: the slug counter is not incremented once the IP is over', async () => {
    await createPage('ev-ip2')
    const day = '2026-10-17'
    for (let i = 0; i < VIEW_IP_LIMIT_PER_HOUR + 10; i++) await view('ev-ip2', '198.51.100.31', `${day}T01:10:00Z`)
    const row = await env.DB.prepare('SELECT count FROM rate_counters WHERE key = ? AND bucket = ?')
      .bind('vslug:ev-ip2', day)
      .first<{ count: number }>()
    expect(row?.count).toBe(VIEW_IP_LIMIT_PER_HOUR)
  })

  it('per IP: CTA over 30/hour still returns 204 but stops writing', async () => {
    expect(CTA_IP_LIMIT_PER_HOUR).toBe(30)
    await createPage('ev-cta')
    // 30 回までは数える対象（同じ人なので重複除外で 1）
    for (let i = 0; i < CTA_IP_LIMIT_PER_HOUR; i++) await cta('ev-cta', '198.51.100.40', '2026-10-17T01:00:00Z')
    expect(await stats('ev-cta')).toEqual({ views: 0, unique_visitors: 0, cta_clicks: 1 })
    const ipKeys = await env.DB.prepare("SELECT count FROM rate_counters WHERE key LIKE 'cip:%'").first<{
      count: number
    }>()
    expect(ipKeys?.count).toBe(CTA_IP_LIMIT_PER_HOUR)
    const over = await cta('ev-cta', '198.51.100.40', '2026-10-17T01:30:00Z')
    expect(over.status).toBe(204)
    const seenBefore = await countRows('seen_hashes')
    // 別の slug でも同じ IP の CTA 枠を使う
    await createPage('ev-cta2', { experimentId: 'X02' })
    expect((await cta('ev-cta2', '198.51.100.40', '2026-10-17T01:30:00Z')).status).toBe(204)
    expect(await countRows('seen_hashes')).toBe(seenBefore)
    expect(await stats('ev-cta2')).toBeNull()
  })

  it('per slug: over 20000/day still serves but does not count', async () => {
    expect(EVENT_SLUG_LIMIT_PER_DAY).toBe(20_000)
    await createPage('ev-slug')
    await seed('vslug:ev-slug', '2026-10-17', EVENT_SLUG_LIMIT_PER_DAY)
    await seed('cslug:ev-slug', '2026-10-17', EVENT_SLUG_LIMIT_PER_DAY)
    expect((await view('ev-slug', '198.51.100.50', '2026-10-17T03:00:00Z')).status).toBe(200)
    expect((await cta('ev-slug', '198.51.100.50', '2026-10-17T03:00:00Z')).status).toBe(204)
    expect(await stats('ev-slug')).toBeNull()
    expect(await countRows('seen_hashes')).toBe(0)
    // 次の日（日本時間）はまた数える
    await view('ev-slug', '198.51.100.50', '2026-10-17T15:00:00Z')
    expect(await countRows('seen_hashes')).toBe(1)
  })

  async function seedSeen(slug: string, day: string, kind: 'view' | 'cta', n: number) {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO seen_hashes (slug, day, kind, hash) SELECT ?, ?, ?, 'seed' || i FROM n`,
    )
      .bind(n, slug, day, kind)
      .run()
  }
  const seenRows = async (slug: string) =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM seen_hashes WHERE slug = ?').bind(slug).first<{ n: number }>())?.n

  it('seen_hashes rows are capped per slug/day/kind; views still count but no new uniques', async () => {
    expect(SEEN_CAP_PER_DAY).toBe(5_000)
    await createPage('ev-seen')
    await seedSeen('ev-seen', '2026-10-17', 'view', SEEN_CAP_PER_DAY - 1)
    await view('ev-seen', '198.51.100.60', '2026-10-17T03:00:00Z')
    await view('ev-seen', '198.51.100.61', '2026-10-17T03:00:00Z')
    await view('ev-seen', '198.51.100.62', '2026-10-17T03:00:00Z')
    expect(await seenRows('ev-seen')).toBe(SEEN_CAP_PER_DAY)
    expect(await stats('ev-seen')).toEqual({ views: 3, unique_visitors: 1, cta_clicks: 0 })
    // CTA は別の枠
    await cta('ev-seen', '198.51.100.60', '2026-10-17T03:00:00Z')
    expect(await stats('ev-seen')).toMatchObject({ cta_clicks: 1 })
  })

  it('parallel views from distinct IPs at the seen cap never exceed it', async () => {
    await createPage('ev-seen-par')
    await seedSeen('ev-seen-par', '2026-10-17', 'view', SEEN_CAP_PER_DAY - 5)
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => view('ev-seen-par', `198.51.101.${i + 1}`, '2026-10-17T03:00:00Z')),
    )
    expect(rs.every((r) => r.status === 200)).toBe(true)
    expect(await seenRows('ev-seen-par')).toBe(SEEN_CAP_PER_DAY)
    expect(await stats('ev-seen-par')).toEqual({ views: 20, unique_visitors: 5, cta_clicks: 0 })
  })

  it('parallel views at the slug limit: exactly the remaining budget is counted, counter stays at the limit', async () => {
    await createPage('ev-slug-par')
    await seed('vslug:ev-slug-par', '2026-10-17', EVENT_SLUG_LIMIT_PER_DAY - 5)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => view('ev-slug-par', `198.51.102.${i + 1}`, '2026-10-17T03:00:00Z')),
    )
    expect(await stats('ev-slug-par')).toEqual({ views: 5, unique_visitors: 5, cta_clicks: 0 })
    const row = await env.DB.prepare('SELECT count FROM rate_counters WHERE key = ? AND bucket = ?')
      .bind('vslug:ev-slug-par', '2026-10-17')
      .first<{ count: number }>()
    expect(row?.count).toBe(EVENT_SLUG_LIMIT_PER_DAY)
  })

  it('parallel views from one IP at the IP limit stop at the limit and do not write the counter further', async () => {
    await createPage('ev-ip-par')
    await Promise.all(
      Array.from({ length: VIEW_IP_LIMIT_PER_HOUR + 20 }, () =>
        view('ev-ip-par', '198.51.100.90', '2026-10-17T01:10:00Z'),
      ),
    )
    expect(await stats('ev-ip-par')).toMatchObject({ views: VIEW_IP_LIMIT_PER_HOUR })
    const rows = await env.DB.prepare("SELECT key, count FROM rate_counters WHERE key LIKE 'vip:%'").all<{
      count: number
    }>()
    expect(rows.results.map((r) => r.count)).toEqual([VIEW_IP_LIMIT_PER_HOUR])
  })

  it('bots do not consume the counters', async () => {
    await createPage('ev-bot')
    await send('/p/ev-bot', { headers: { 'User-Agent': 'curl/8.4.0', 'CF-Connecting-IP': '198.51.100.70' } })
    expect(await countRows('rate_counters')).toBe(0)
  })
})
