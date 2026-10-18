import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redirectUriFor, waitForLoopback } from '../../../../src/video/app/main/publish/loopback'
import { DEFAULT_TIKTOK_TOKEN_URL, oauthValues, tiktokClientFrom, youtubeClientFrom } from '../../../../src/video/app/main/publish/config'
import {
  OAUTH_DEFINE,
  dotenvValue,
  googleClientFromJson,
  oauthFilePaths,
  oauthValuesFromEnv,
  resolveOAuthValues,
  tiktokEnvFileName,
  videoOAuthDefines
} from '../../../../src/video/build/oauthEnv'
import { MAX_RETRIES, resumableUpload } from '../../../../src/video/app/main/publish/youtube'
import {
  TIKTOK_REDIRECT_URI,
  TT_MAX_CHUNK,
  TT_MAX_CHUNKS,
  TT_MIN_CHUNK,
  contentTypeFor,
  directInitBody,
  directPrivacy,
  exchangeUrl,
  inboxInitBody,
  interpretStatus,
  parseTikTokToken,
  sanitizeTikTokTokens,
  tiktokAuthUrl,
  tiktokChallenge,
  tiktokChunkPlan,
  tiktokData,
  tiktokScopes,
  tiktokTokenBody,
  tiktokVerifier,
  tiktokVideoUrl
} from '../../../../src/video/app/main/publish/tiktokApi'
import { parsePublishJson } from '../../../../src/video/app/shared/publish'

const MB = 1024 * 1024

describe('ループバックの受け口', () => {
  const hit = (url: string, method = 'GET') =>
    new Promise<number>((resolve, reject) => {
      const req = request(url, { method }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
  const freePort = () => new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })

  it('リダイレクト URI: Google の / は付けない、ほかはパスまで', () => {
    expect(redirectUriFor(5555, '/')).toBe('http://127.0.0.1:5555')
    expect(redirectUriFor(47823, '/tiktok/callback')).toBe(TIKTOK_REDIRECT_URI)
  })

  it('空いているポート（Google）: 決めたパス・GET 以外は 404 で待ち続ける', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: 'YouTube' })
    const redirect = await w.ready
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await hit(`${redirect}/favicon.ico`)).toBe(404)
    expect(await hit(`${redirect}/?code=c&state=S`, 'POST')).toBe(404)
    expect(await hit(`${redirect}/?code=c&state=S`)).toBe(200)
    await expect(w.code).resolves.toBe('c')
  })

  it('固定のポートとパス（TikTok）: パスが違えば 404', async () => {
    const port = await freePort()
    const w = waitForLoopback({ port, path: '/tiktok/callback', state: 'S', timeoutMs: 5000, label: 'TikTok' })
    expect(await w.ready).toBe(`http://127.0.0.1:${port}/tiktok/callback`)
    expect(await hit(`http://127.0.0.1:${port}/?code=X&state=S`)).toBe(404)
    expect(await hit(`http://127.0.0.1:${port}/tiktok/callback?code=CODE&state=S`)).toBe(200)
    await expect(w.code).resolves.toBe('CODE')
  })

  it('state が違うものは 400 で断り、そのまま待ち続ける（別のページに止めさせない）', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: 'YouTube' })
    const r = await w.ready
    expect(await hit(`${r}/?code=evil&state=X`)).toBe(400)
    expect(await hit(`${r}/?code=evil`)).toBe(400)
    expect(await hit(`${r}/?code=good&state=S`)).toBe(200)
    await expect(w.code).resolves.toBe('good')
  })

  it('拒否（error=access_denied）・code 無しは断って閉じる', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: 'YouTube' })
    const r = await w.ready
    expect(await hit(`${r}/?error=access_denied&state=S`)).toBe(200)
    await expect(w.code).rejects.toThrow('The YouTube connection was not allowed.')
    const w2 = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: 'YouTube' })
    const r2 = await w2.ready
    await hit(`${r2}/?state=S`)
    await expect(w2.code).rejects.toThrow(/not allowed/)
  })

  it('ポート 47823 が使用中なら分かる文で断る', async () => {
    const blocker: Server = createServer()
    const listened = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false))
      blocker.listen(47823, '127.0.0.1', () => resolve(true))
    })
    try {
      const w = waitForLoopback({ port: 47823, path: '/tiktok/callback', state: 'S', timeoutMs: 5000, label: 'TikTok' })
      await expect(w.ready).rejects.toThrow('Port 47823 is used by another app')
      await expect(w.code).rejects.toThrow('Port 47823')
    } finally {
      if (listened) await new Promise((r) => blocker.close(r))
    }
  })

  it('時間切れ・取り消しは閉じる（ポートを開いたままにしない）', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 30, label: 'YouTube' })
    await w.ready
    await expect(w.code).rejects.toThrow('timed out')
    const port = await freePort()
    const c = waitForLoopback({ port, path: '/cb', state: 'S', timeoutMs: 5000, label: 'TikTok' })
    await c.ready
    c.cancel()
    await expect(c.code).rejects.toThrow('cancelled')
    await vi.waitFor(async () => {
      // もう一度同じポートで待てる（閉じた）
      const again = waitForLoopback({ port, path: '/cb', state: 'S', timeoutMs: 5000, label: 'TikTok' })
      await again.ready
      again.cancel()
    })
  })

  it('待ち受けが始まる前に取り消しても開いたままにしない', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: 'YouTube' })
    w.cancel()
    await expect(w.code).rejects.toThrow('cancelled')
    await expect(w.ready).rejects.toThrow('cancelled')
  })

  it('受けたページは文を HTML として逃がす', async () => {
    const w = waitForLoopback({ port: 0, path: '/', state: 'S', timeoutMs: 5000, label: '<script>' })
    const r = await w.ready
    const html = await new Promise<string>((resolve) => {
      request(`${r}/?code=c&state=S`, (res) => {
        let s = ''
        res.on('data', (d) => (s += d))
        res.on('end', () => resolve(s))
      }).end()
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    await w.code
  })
})

describe('組み込むクライアントの値（実行時）', () => {
  it('開発版は実行時の環境変数が先、なければ埋め込んだ値', () => {
    expect(oauthValues({ youtubeClientId: 'built', youtubeClientSecret: 'bs' }, { FERRET_VIDEO_YOUTUBE_CLIENT_ID: 'dev' })).toEqual({ youtubeClientId: 'dev' })
    expect(oauthValues({ youtubeClientId: 'built', youtubeClientSecret: 'bs' }, {})).toEqual({ youtubeClientId: 'built', youtubeClientSecret: 'bs' })
    expect(oauthValues({ tiktokClientKey: 'k' }, { SOLOCUT_TIKTOK_TOKEN_URL: 'http://127.0.0.1:8787/oauth/tiktok' })).toEqual({ tiktokClientKey: 'k', tiktokTokenUrl: 'http://127.0.0.1:8787/oauth/tiktok' })
  })
  it('配布版（runtimeEnv が null）は環境変数を読まない', () => {
    expect(oauthValues({}, null)).toEqual({})
    expect(oauthValues({ youtubeClientId: 'b' }, null)).toEqual({ youtubeClientId: 'b' })
  })
  it('シークレットだけの値は使わない', () => {
    expect(oauthValues({ youtubeClientSecret: 's' }, null)).toEqual({})
  })
  it('YouTube: ID があれば使う。無ければ null', () => {
    expect(youtubeClientFrom({ youtubeClientId: ' id ', youtubeClientSecret: 's' })).toEqual({ clientId: 'id', clientSecret: 's' })
    expect(youtubeClientFrom({ youtubeClientId: 'id' })).toEqual({ clientId: 'id' })
    expect(youtubeClientFrom({ youtubeClientId: '  ' })).toBeNull()
    expect(youtubeClientFrom({})).toBeNull()
  })
  it('TikTok: キーだけで足りる。交換先は https（手元の wrangler dev は http の 127.0.0.1 / localhost）', () => {
    expect(tiktokClientFrom({})).toBeNull()
    expect(tiktokClientFrom({ tiktokClientKey: 'k' })).toEqual({ clientKey: 'k', tokenUrl: DEFAULT_TIKTOK_TOKEN_URL, directPost: false })
    expect(DEFAULT_TIKTOK_TOKEN_URL).toBe('https://ferretade.dev/oauth/tiktok')
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'https://x.example/t', tiktokDirectPost: 'true' })).toEqual({ clientKey: 'k', tokenUrl: 'https://x.example/t', directPost: true })
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokDirectPost: '1' })?.directPost).toBe(true)
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokDirectPost: 'no' })?.directPost).toBe(false)
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'http://127.0.0.1:8787/oauth/tiktok' })?.tokenUrl).toBe('http://127.0.0.1:8787/oauth/tiktok')
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'http://localhost/oauth/tiktok' })?.tokenUrl).toBe('http://localhost/oauth/tiktok')
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'http://evil.example/t' })).toBeNull()
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'http://127.0.0.1.evil.example/t' })).toBeNull()
    expect(tiktokClientFrom({ tiktokClientKey: 'k', tiktokTokenUrl: 'javascript:alert(1)' })).toBeNull()
  })
})

describe('ビルドのときに埋め込む値（偽のファイルで）', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferret-video-home-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const release = (name: string, text: string) => {
    mkdirSync(join(home, '.solocut-release'), { recursive: true })
    writeFileSync(join(home, '.solocut-release', name), text)
  }
  const defines = (env: Record<string, string | undefined> = {}) => JSON.parse(videoOAuthDefines(env, home)[OAUTH_DEFINE]!) as Record<string, string>
  const googleJson = JSON.stringify({ installed: { client_id: 'json-id.apps.googleusercontent.com', client_secret: 'json-secret' } })

  it('ファイルも環境変数も無ければ空（定数は必ず定義する）', () => {
    expect(videoOAuthDefines({}, home)).toEqual({ [OAUTH_DEFINE]: '{}' })
  })
  it('~/.solocut-release の Google の JSON と tiktok-sandbox.env の TIKTOK_CLIENT_KEY だけを読む（シークレットは読まない）', () => {
    release('google-oauth-client.json', googleJson)
    release('tiktok-sandbox.env', 'TIKTOK_CLIENT_KEY=sandbox-key\nTIKTOK_CLIENT_SECRET=sandbox-secret\n')
    expect(defines()).toEqual({ youtubeClientId: 'json-id.apps.googleusercontent.com', youtubeClientSecret: 'json-secret', tiktokClientKey: 'sandbox-key' })
    expect(JSON.stringify(videoOAuthDefines({}, home))).not.toContain('sandbox-secret')
  })
  it('壊れた JSON・形の違う JSON は無いものとして扱う', () => {
    release('google-oauth-client.json', '{broken')
    expect(defines()).toEqual({})
    release('google-oauth-client.json', JSON.stringify({ installed: { client_id: 5 } }))
    expect(defines()).toEqual({})
    release('google-oauth-client.json', 'null')
    expect(defines()).toEqual({})
  })
  it('FERRET_VIDEO_TIKTOK_ENV=production で tiktok-production.env。知らない値はビルドを止める', () => {
    release('tiktok-sandbox.env', 'TIKTOK_CLIENT_KEY=sb')
    release('tiktok-production.env', 'TIKTOK_CLIENT_KEY=prod')
    expect(defines().tiktokClientKey).toBe('sb')
    expect(defines({ FERRET_VIDEO_TIKTOK_ENV: 'production' }).tiktokClientKey).toBe('prod')
    expect(defines({ SOLOCUT_TIKTOK_ENV: 'Production' }).tiktokClientKey).toBe('prod')
    expect(() => defines({ FERRET_VIDEO_TIKTOK_ENV: 'prod' })).toThrow(/sandbox or production/)
    expect(() => tiktokEnvFileName({ SOLOCUT_TIKTOK_ENV: '../x' })).toThrow()
    expect(tiktokEnvFileName({ FERRET_VIDEO_TIKTOK_ENV: ' ' })).toBe('tiktok-sandbox.env')
  })
  it('ファイルの場所は環境変数で変えられる（新しい名前が先）', () => {
    const other = join(home, 'g.json')
    writeFileSync(other, JSON.stringify({ web: { client_id: 'web-id' } }))
    expect(defines({ FERRET_VIDEO_GOOGLE_OAUTH_JSON: other }).youtubeClientId).toBe('web-id')
    expect(defines({ SOLOCUT_GOOGLE_OAUTH_JSON: other }).youtubeClientId).toBe('web-id')
    const tenv = join(home, 't.env')
    writeFileSync(tenv, 'export TIKTOK_CLIENT_KEY="quoted"')
    expect(defines({ FERRET_VIDEO_TIKTOK_ENV_FILE: tenv }).tiktokClientKey).toBe('quoted')
    expect(oauthFilePaths({ FERRET_VIDEO_GOOGLE_OAUTH_JSON: 'a', SOLOCUT_GOOGLE_OAUTH_JSON: 'b' }, home).googleJson).toBe('a')
    expect(oauthFilePaths({}, home)).toEqual({ googleJson: join(home, '.solocut-release', 'google-oauth-client.json'), tiktokEnv: join(home, '.solocut-release', 'tiktok-sandbox.env') })
  })
  it('無いファイルを指しても止めない', () => {
    expect(defines({ FERRET_VIDEO_GOOGLE_OAUTH_JSON: join(home, 'none.json'), FERRET_VIDEO_TIKTOK_ENV_FILE: join(home, 'none.env') })).toEqual({})
  })
  it('環境変数はファイルより先。FERRET_VIDEO_* → SOLOCUT_* → MAIN_VITE_SOLOCUT_* の順', () => {
    release('google-oauth-client.json', googleJson)
    expect(defines({ SOLOCUT_YOUTUBE_CLIENT_ID: 'env-id' })).toEqual({ youtubeClientId: 'env-id' }) // JSON のシークレットは混ぜない
    expect(defines({ FERRET_VIDEO_YOUTUBE_CLIENT_ID: 'new', SOLOCUT_YOUTUBE_CLIENT_ID: 'old', SOLOCUT_YOUTUBE_CLIENT_SECRET: 'old-s' })).toEqual({ youtubeClientId: 'new' })
    expect(defines({ SOLOCUT_YOUTUBE_CLIENT_ID: 'old', SOLOCUT_YOUTUBE_CLIENT_SECRET: 'old-s' })).toEqual({ youtubeClientId: 'old', youtubeClientSecret: 'old-s' })
    expect(oauthValuesFromEnv({ MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY: ' k ', SOLOCUT_TIKTOK_DIRECT_POST: '1' })).toEqual({ tiktokClientKey: 'k', tiktokDirectPost: '1' })
    expect(oauthValuesFromEnv({ FERRET_VIDEO_TIKTOK_TOKEN_URL: 'https://a/', SOLOCUT_TIKTOK_TOKEN_URL: 'https://b/' })).toEqual({ tiktokTokenUrl: 'https://a/' })
    expect(oauthValuesFromEnv({ SOLOCUT_YOUTUBE_CLIENT_ID: '  ' })).toEqual({})
  })
  it('TikTok のシークレットは環境変数にあっても埋め込まない', () => {
    const d = videoOAuthDefines({ FERRET_VIDEO_TIKTOK_CLIENT_SECRET: 'x', SOLOCUT_TIKTOK_CLIENT_SECRET: 'y', MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_SECRET: 'z', SOLOCUT_TIKTOK_CLIENT_KEY: 'k' }, home)
    expect(JSON.parse(d[OAUTH_DEFINE]!)).toEqual({ tiktokClientKey: 'k' })
  })
  it('環境変数で足りる値のファイルは読まない', () => {
    release('google-oauth-client.json', '{broken')
    expect(resolveOAuthValues({ FERRET_VIDEO_YOUTUBE_CLIENT_ID: 'e' }, googleJson, null)).toEqual({ youtubeClientId: 'e' })
  })
  it('値をログに出さない', () => {
    release('google-oauth-client.json', googleJson)
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    defines()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    for (const s of spies) s.mockRestore()
  })
  it('googleClientFromJson と dotenvValue', () => {
    expect(googleClientFromJson(googleJson)).toEqual({ id: 'json-id.apps.googleusercontent.com', secret: 'json-secret' })
    expect(googleClientFromJson('﻿' + googleJson).id).toBe('json-id.apps.googleusercontent.com')
    expect(googleClientFromJson(JSON.stringify({ web: { client_id: 'w' } }))).toEqual({ id: 'w' })
    expect(googleClientFromJson('{')).toEqual({})
    expect(googleClientFromJson(null)).toEqual({})
    expect(googleClientFromJson('[]')).toEqual({})
    const text = '# comment\nexport TIKTOK_CLIENT_KEY="key-1"\nTIKTOK_CLIENT_SECRET=never\n'
    expect(dotenvValue(text, 'TIKTOK_CLIENT_KEY')).toBe('key-1')
    expect(dotenvValue("TIKTOK_CLIENT_KEY='k2'", 'TIKTOK_CLIENT_KEY')).toBe('k2')
    expect(dotenvValue('TIKTOK_CLIENT_KEY=k3 # note', 'TIKTOK_CLIENT_KEY')).toBe('k3')
    expect(dotenvValue('TIKTOK_CLIENT_KEY=k4\r\n', 'TIKTOK_CLIENT_KEY')).toBe('k4')
    expect(dotenvValue('TIKTOK_CLIENT_KEY=', 'TIKTOK_CLIENT_KEY')).toBeUndefined()
    expect(dotenvValue(null, 'TIKTOK_CLIENT_KEY')).toBeUndefined()
    expect(dotenvValue('OTHER=1\nTIKTOK_CLIENT_KEY_X=2', 'TIKTOK_CLIENT_KEY')).toBeUndefined()
  })
})

describe('TikTok の純粋な部品', () => {
  it('verifier は 43〜128 の非予約文字。challenge は SHA-256 の 16 進（base64url ではない）', () => {
    for (let i = 0; i < 20; i++) expect(tiktokVerifier()).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(tiktokChallenge('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(tiktokChallenge(tiktokVerifier())).toMatch(/^[0-9a-f]{64}$/)
    expect(tiktokVerifier(200).length).toBe(128)
  })
  it('認可 URL', () => {
    const u = new URL(tiktokAuthUrl({ clientKey: 'ck', redirectUri: TIKTOK_REDIRECT_URI, challenge: 'ch', state: 'st', scopes: tiktokScopes(false) }))
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_key: 'ck', scope: 'user.info.basic,video.upload', redirect_uri: 'http://127.0.0.1:47823/tiktok/callback', state: 'st', response_type: 'code', code_challenge: 'ch', code_challenge_method: 'S256'
    })
    expect(tiktokScopes(true)).toContain('video.publish')
  })
  it('交換の Worker への本文はシークレットを持たない', () => {
    expect(Object.fromEntries(tiktokTokenBody('ck', { code: 'c', verifier: 'v', redirectUri: TIKTOK_REDIRECT_URI }))).toEqual({ client_key: 'ck', code: 'c', code_verifier: 'v', redirect_uri: TIKTOK_REDIRECT_URI })
    expect(Object.fromEntries(tiktokTokenBody('ck', { refreshToken: 'r' }))).toEqual({ client_key: 'ck', refresh_token: 'r' })
    expect(exchangeUrl('https://ferretade.dev/oauth/tiktok', 'token')).toBe('https://ferretade.dev/oauth/tiktok/token')
    expect(exchangeUrl('https://ferretade.dev/oauth/tiktok//', 'revoke')).toBe('https://ferretade.dev/oauth/tiktok/revoke')
  })
  it('トークンの答えを読む', () => {
    const t = parseTikTokToken({ access_token: 'a', expires_in: 86400, refresh_token: 'r', refresh_expires_in: 100, open_id: 'o', scope: 'user.info.basic, video.upload' }, 1000)
    expect(t).toEqual({ accessToken: 'a', expiresAt: 1000 + 86_400_000, refreshToken: 'r', refreshExpiresAt: 1000 + 100_000, openId: 'o', scope: ['user.info.basic', 'video.upload'] })
    expect(parseTikTokToken({ access_token: 'a', refresh_token: 'r', expires_in: -5 }, 0).expiresAt).toBe(86_400_000)
    expect(parseTikTokToken({ access_token: 'a', refresh_token: 'r' }, 0).refreshExpiresAt).toBe(365 * 86_400_000)
    expect(() => parseTikTokToken({ error: 'invalid_grant', error_description: 'expired' }, 0)).toThrow('TikTok token: invalid_grant expired')
    expect(() => parseTikTokToken({ error: { code: 'access_token_invalid', message: 'x' } }, 0)).toThrow('access_token_invalid')
    expect(() => parseTikTokToken({ access_token: 'a', refresh_token: '' }, 0)).toThrow('no access token')
    expect(() => parseTikTokToken(null, 0)).toThrow('no access token')
  })
  it('保存したトークンを確かめる', () => {
    const t = parseTikTokToken({ access_token: 'a', refresh_token: 'r' }, 5)
    expect(sanitizeTikTokTokens(JSON.parse(JSON.stringify(t)))).toEqual(t)
    expect(sanitizeTikTokTokens(null)).toBeNull()
    expect(sanitizeTikTokTokens({ accessToken: 1 })).toBeNull()
    expect(sanitizeTikTokTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Number.NaN })).toBeNull()
    expect(sanitizeTikTokTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 9, scope: ['x', 1] })).toMatchObject({ refreshExpiresAt: 9, scope: ['x'] })
  })

  describe('分割の計算（5MB 以上 64MB 以下・floor・余りは最後・1000 個まで）', () => {
    const check = (size: number) => {
      const p = tiktokChunkPlan(size)
      expect(p.count).toBe(p.ranges.length)
      expect(p.ranges[0]![0]).toBe(0)
      expect(p.ranges.at(-1)![1]).toBe(size - 1)
      for (let i = 1; i < p.ranges.length; i++) expect(p.ranges[i]![0]).toBe(p.ranges[i - 1]![1] + 1)
      if (size >= TT_MIN_CHUNK) for (const [a, b] of p.ranges.slice(0, -1)) expect(b - a + 1).toBe(p.chunkSize)
      if (size >= TT_MIN_CHUNK) expect(p.chunkSize).toBeGreaterThanOrEqual(TT_MIN_CHUNK)
      expect(p.chunkSize).toBeLessThanOrEqual(TT_MAX_CHUNK)
      expect(p.count).toBe(size < TT_MIN_CHUNK ? 1 : Math.floor(size / p.chunkSize))
      expect(p.count).toBeLessThanOrEqual(TT_MAX_CHUNKS)
      return p
    }
    it('5MB 未満は1回（大きさそのまま）', () => {
      expect(check(1)).toEqual({ chunkSize: 1, count: 1, ranges: [[0, 0]] })
      expect(check(5 * MB - 1)).toEqual({ chunkSize: 5 * MB - 1, count: 1, ranges: [[0, 5 * MB - 2]] })
    })
    it('5MB ちょうどは1つ（5MB）', () => {
      expect(check(5 * MB)).toEqual({ chunkSize: 5 * MB, count: 1, ranges: [[0, 5 * MB - 1]] })
    })
    it('10MB まではまとめて1つ', () => {
      expect(check(7 * MB).count).toBe(1)
      expect(check(10 * MB).count).toBe(1)
      expect(check(10 * MB + 1)).toMatchObject({ chunkSize: 10 * MB, count: 1 }) // 余り1バイトは最後に足す
    })
    it('64MB ちょうど・64MB を超える', () => {
      expect(check(64 * MB)).toMatchObject({ chunkSize: 10 * MB, count: 6 })
      expect(check(64 * MB).ranges.at(-1)).toEqual([50 * MB, 64 * MB - 1]) // 最後は 14MB（余りを足した）
      expect(check(64 * MB + 1).count).toBe(6)
    })
    it('最後の余り', () => {
      const p = check(50_000_123)
      expect(p.count).toBe(4)
      expect(p.ranges.at(-1)![1] - p.ranges.at(-1)![0] + 1).toBe(50_000_123 - 3 * 10 * MB)
    })
    it('1000 個を超えるなら1つを大きくする。それでも超えるなら断る', () => {
      expect(check(10 * MB * 1000).count).toBe(1000) // ちょうど 1000 個
      const over = check(10 * MB * 1000 + 10 * MB) // 1001 個 → 20MB にする
      expect(over.chunkSize).toBe(20 * MB)
      expect(check(4 * 1024 * MB).count).toBeLessThanOrEqual(1000)
      expect(check(64 * MB * 1000).count).toBe(1000)
      expect(() => tiktokChunkPlan(64 * MB * 1001)).toThrow(/over 1000 chunks/)
      expect(() => tiktokChunkPlan(70 * 1024 * MB)).toThrow(/too large/)
    })
    it('空・数でないものは断る', () => {
      expect(() => tiktokChunkPlan(0)).toThrow('empty video')
      expect(() => tiktokChunkPlan(-1)).toThrow('empty video')
      expect(() => tiktokChunkPlan(Number.NaN)).toThrow('empty video')
      expect(() => tiktokChunkPlan(Number.POSITIVE_INFINITY)).toThrow('empty video')
    })
  })

  it('始めの本文と公開範囲の下げ方', () => {
    const plan = tiktokChunkPlan(1000)
    expect(inboxInitBody(plan, 1000)).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } })
    const s = parsePublishJson({ title: 't', tiktok: { enabled: true, caption: 'cap', privacy: 'PUBLIC_TO_EVERYONE', allowComment: true, isAigc: true } }).spec!
    const d = directInitBody(s, plan, 1000, ['SELF_ONLY', 'PUBLIC_TO_EVERYONE']) as { post_info: Record<string, unknown> }
    expect(d.post_info).toEqual({
      title: 'cap', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, is_aigc: true, brand_content_toggle: false, brand_organic_toggle: false
    })
    expect(directPrivacy('PUBLIC_TO_EVERYONE', ['SELF_ONLY'])).toBe('SELF_ONLY')
    expect(directPrivacy('PUBLIC_TO_EVERYONE', ['FOLLOWER_OF_CREATOR'])).toBe('FOLLOWER_OF_CREATOR')
    expect(directPrivacy('PUBLIC_TO_EVERYONE', [])).toBe('SELF_ONLY')
    expect(directPrivacy('SELF_ONLY', ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'])).toBe('SELF_ONLY')
  })
  it('API の包みと状態', () => {
    expect(tiktokData({ data: { a: 1 }, error: { code: 'ok' } }, 'x')).toEqual({ a: 1 })
    expect(() => tiktokData({ error: { code: 'spam_risk_too_many_posts', message: 'slow down' } }, 'init')).toThrow('TikTok init: spam_risk_too_many_posts slow down')
    expect(() => tiktokData({}, 'x')).toThrow('no data')
    expect(interpretStatus({ status: 'PROCESSING_UPLOAD' }, 'inbox')).toEqual({ done: false, ok: true, status: 'PROCESSING_UPLOAD' })
    expect(interpretStatus({ status: 'SEND_TO_USER_INBOX' }, 'inbox')).toEqual({ done: true, ok: true, status: 'SEND_TO_USER_INBOX' })
    expect(interpretStatus({ status: 'SEND_TO_USER_INBOX' }, 'direct').done).toBe(false)
    expect(interpretStatus({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, 'direct')).toEqual({ done: true, ok: true, status: 'PUBLISH_COMPLETE', postId: '7123' })
    expect(interpretStatus({ status: 'FAILED', fail_reason: 'file_format_check_failed' }, 'direct')).toEqual({ done: true, ok: false, status: 'FAILED', reason: 'file_format_check_failed' })
    expect(interpretStatus({}, 'inbox')).toEqual({ done: false, ok: true, status: '' })
    expect(tiktokVideoUrl('me.name', '7123')).toBe('https://www.tiktok.com/@me.name/video/7123')
    expect(tiktokVideoUrl(undefined, '7')).toBeUndefined()
    expect(tiktokVideoUrl('a/b', '7')).toBeUndefined()
    expect(tiktokVideoUrl('a', '7x')).toBeUndefined()
    expect(contentTypeFor('a.MOV')).toBe('video/quicktime')
    expect(contentTypeFor('a.webm')).toBe('video/webm')
    expect(contentTypeFor('a.mp4')).toBe('video/mp4')
  })
})

describe('再開可能アップロード: 進まないまま失敗が続いても止まる', () => {
  it('5xx のあと 308 が同じ位置を返し続けると、5 回を超えたところで止める', async () => {
    const sleeps: number[] = []
    let n = 0
    await expect(resumableUpload({
      fetch: async (_u, init) => {
        n++
        const range = (init?.headers as Record<string, string>)['Content-Range']
        return range?.startsWith('bytes */') ? new Response(null, { status: 308, headers: { range: 'bytes=0-7' } }) : new Response(null, { status: n === 1 ? 308 : 503, headers: n === 1 ? { range: 'bytes=0-7' } : {} })
      },
      session: 'https://u.example/s',
      size: 20,
      read: async (_o, l) => new Uint8Array(l),
      token: async () => 't',
      sleep: async (ms) => void sleeps.push(ms),
      onProgress: () => undefined,
      chunk: 8
    })).rejects.toThrow('YouTube 503')
    expect(sleeps).toHaveLength(MAX_RETRIES)
  })
})
