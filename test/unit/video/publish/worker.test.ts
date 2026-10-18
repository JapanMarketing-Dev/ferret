import { describe, expect, it, vi } from 'vitest'
import worker, { MAX_BODY, TIKTOK_REVOKE, TIKTOK_TOKEN, clients, handle, type Env } from '../../../../workers/video-oauth/src/index'

const env: Env = { TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_SANDBOX_CLIENT_KEY: 'sk', TIKTOK_SANDBOX_CLIENT_SECRET: 'ss' }
const BASE = 'https://ferretade.dev/oauth/tiktok'
const VERIFIER = 'a'.repeat(64)
const REDIRECT = 'http://127.0.0.1:47823/tiktok/callback'

/** Object bodies get client_key 'ck' (production) unless they set one; string bodies are sent as is. */
const post = (path: string, body: Record<string, string> | string, type = 'application/x-www-form-urlencoded') =>
  new Request(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: typeof body === 'string' ? body : new URLSearchParams({ client_key: 'ck', ...body }).toString(),
  })

function mockFetch(status = 200, body: string = JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 })) {
  const calls: { url: string; body: URLSearchParams }[] = []
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('video-oauth（TikTok のトークンの交換の Worker）', () => {
  it('token: adds key/secret and passes TikTok’s answer through, no-store', async () => {
    const { f, calls } = mockFetch()
    const r = await handle(post('token', { code: 'C', code_verifier: VERIFIER, redirect_uri: REDIRECT }), env, f)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(TIKTOK_TOKEN)
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      client_key: 'ck', client_secret: 'cs', code: 'C', grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: VERIFIER,
    })
  })
  it('accepts the localhost redirect and JSON bodies; trailing slash in the path', async () => {
    const { f } = mockFetch()
    const r = await handle(
      new Request(`${BASE}/token/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_key: 'ck', code: 'C', code_verifier: VERIFIER, redirect_uri: 'http://localhost:47823/tiktok/callback', n: 1 }) }),
      env,
      f,
    )
    expect(r.status).toBe(200)
  })
  it('token: rejects missing fields, bad verifier, unregistered redirect, wrong client key', async () => {
    const { f, calls } = mockFetch()
    const cases: [Record<string, string>, string][] = [
      [{ code_verifier: VERIFIER, redirect_uri: REDIRECT }, 'invalid_request'],
      [{ code: 'C', redirect_uri: REDIRECT }, 'invalid_request'],
      [{ code: 'C', code_verifier: 'short', redirect_uri: REDIRECT }, 'invalid_request'],
      [{ code: 'C', code_verifier: `${'a'.repeat(50)} x`, redirect_uri: REDIRECT }, 'invalid_request'],
      [{ code: 'C', code_verifier: 'a'.repeat(129), redirect_uri: REDIRECT }, 'invalid_request'],
      [{ code: 'C', code_verifier: VERIFIER, redirect_uri: 'https://evil.example/cb' }, 'invalid_request'],
      [{ code: 'C', code_verifier: VERIFIER, redirect_uri: 'http://127.0.0.1:47824/tiktok/callback' }, 'invalid_request'],
      [{ code: 'C', code_verifier: VERIFIER, redirect_uri: REDIRECT, client_key: 'other' }, 'invalid_client'],
    ]
    for (const [body, error] of cases) {
      const r = await handle(post('token', body), env, f)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((await r.json()).error).toBe(error)
    }
    expect(calls).toHaveLength(0)
  })
  it('refresh and revoke', async () => {
    const a = mockFetch()
    expect((await handle(post('refresh', { refresh_token: 'R' }), env, a.f)).status).toBe(200)
    expect(Object.fromEntries(a.calls[0]!.body)).toEqual({ client_key: 'ck', client_secret: 'cs', grant_type: 'refresh_token', refresh_token: 'R' })
    expect((await handle(post('refresh', {}), env, a.f)).status).toBe(400)
    const b = mockFetch(200, '')
    const r = await handle(post('revoke', { token: 'T' }), env, b.f)
    expect(r.status).toBe(204)
    expect(b.calls[0]!.url).toBe(TIKTOK_REVOKE)
    expect(Object.fromEntries(b.calls[0]!.body)).toEqual({ client_key: 'ck', client_secret: 'cs', token: 'T' })
    expect((await handle(post('revoke', {}), env, b.f)).status).toBe(400)
  })
  it('TikTok errors keep their status and body', async () => {
    const { f } = mockFetch(400, JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }))
    const r = await handle(post('refresh', { refresh_token: 'R' }), env, f)
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_grant', error_description: 'expired' })
  })
  it('upstream down or not JSON → 502', async () => {
    const down = vi.fn(async () => Promise.reject(new Error('net'))) as unknown as typeof fetch
    expect((await handle(post('refresh', { refresh_token: 'R' }), env, down)).status).toBe(502)
    const html = mockFetch(200, '<html>')
    const r = await handle(post('refresh', { refresh_token: 'R' }), env, html.f)
    expect(r.status).toBe(502)
    expect((await r.json()).error).toBe('upstream_invalid')
  })
  it('routes, methods, config, size and malformed JSON', async () => {
    const { f, calls } = mockFetch()
    expect((await handle(new Request(`${BASE}/token`), env, f)).status).toBe(405)
    expect((await handle(post('nope', {}), env, f)).status).toBe(404)
    expect((await handle(new Request('https://ferretade.dev/oauth/google/token', { method: 'POST' }), env, f)).status).toBe(404)
    expect((await handle(post('token', { code: 'C', code_verifier: VERIFIER, redirect_uri: REDIRECT }), {}, f)).status).toBe(500)
    expect((await handle(post('token', { code: 'C', code_verifier: VERIFIER, redirect_uri: REDIRECT }), { TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: ' ', TIKTOK_SANDBOX_CLIENT_KEY: 'sk' }, f)).status).toBe(500)
    expect((await handle(post('refresh', `client_key=ck&refresh_token=${'x'.repeat(MAX_BODY)}`), env, f)).status).toBe(413)
    expect((await handle(post('refresh', '{', 'application/json'), env, f)).status).toBe(400)
    expect((await handle(post('refresh', '[1]', 'application/json'), env, f)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
  it('never logs (no console use on any path)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    const { f } = mockFetch()
    await handle(post('token', { code: 'C', code_verifier: VERIFIER, redirect_uri: REDIRECT }), env, f)
    await handle(post('token', {}), env, f)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    for (const s of spies) s.mockRestore()
  })
  it('client_key picks production or sandbox; unknown or missing key is refused', async () => {
    const { f, calls } = mockFetch()
    await handle(post('refresh', { client_key: 'sk', refresh_token: 'R' }), env, f)
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({ client_key: 'sk', client_secret: 'ss' })
    await handle(post('refresh', { refresh_token: 'R' }), env, f)
    expect(Object.fromEntries(calls[1]!.body)).toMatchObject({ client_key: 'ck', client_secret: 'cs' })
    const unknown = await handle(post('refresh', { client_key: 'zz', refresh_token: 'R' }), env, f)
    expect([unknown.status, (await unknown.json()).error]).toEqual([400, 'invalid_client'])
    const missing = await handle(post('refresh', 'refresh_token=R'), env, f)
    expect([missing.status, (await missing.json()).error]).toEqual([400, 'invalid_request'])
    // only the sandbox configured: production key refused, sandbox works
    const sandboxOnly = { TIKTOK_SANDBOX_CLIENT_KEY: 'sk', TIKTOK_SANDBOX_CLIENT_SECRET: 'ss' }
    expect((await handle(post('refresh', { refresh_token: 'R' }), sandboxOnly, f)).status).toBe(400)
    expect((await handle(post('refresh', { client_key: 'sk', refresh_token: 'R' }), sandboxOnly, f)).status).toBe(200)
    expect(calls).toHaveLength(3)
  })
  it('clients(): only complete pairs, production first', () => {
    expect(clients(env)).toEqual([{ key: 'ck', secret: 'cs' }, { key: 'sk', secret: 'ss' }])
    expect(clients({ TIKTOK_CLIENT_KEY: 'ck', TIKTOK_SANDBOX_CLIENT_SECRET: 'ss' })).toEqual([])
    expect(clients({})).toEqual([])
  })
  it('default export answers 500 instead of throwing', async () => {
    const r = await worker.fetch(new Request(`${BASE}/token`, { method: 'POST' }), {})
    expect(r.status).toBe(500)
  })
  it('code_verifier の長さの境界: 43 と 128 は通し、42 と 129 は断る', async () => {
    const { f, calls } = mockFetch()
    for (const [v, ok] of [['a'.repeat(43), true], ['a'.repeat(128), true], ['a'.repeat(42), false], ['a'.repeat(129), false], ['a-b.c_d~'.repeat(6), true]] as const) {
      const r = await handle(post('token', { code: 'C', code_verifier: v, redirect_uri: REDIRECT }), env, f)
      expect(r.status, v).toBe(ok ? 200 : 400)
    }
    expect(calls).toHaveLength(3)
  })
  it('TikTok の空の答えは状態を保つ（200 は 204、ほかはそのまま）', async () => {
    const a = mockFetch(200, '')
    expect((await handle(post('revoke', { token: 'T' }), env, a.f)).status).toBe(204)
    const b = mockFetch(401, '')
    expect((await handle(post('revoke', { token: 'T' }), env, b.f)).status).toBe(401)
  })
  it('CORS のヘッダーは出さない', async () => {
    const { f } = mockFetch()
    const r = await handle(post('refresh', { refresh_token: 'R' }), env, f)
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})
