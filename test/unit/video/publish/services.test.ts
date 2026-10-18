import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KeyCipher } from '../../../../src/main/pipeline/stt/keys'
import { VideoPublishStore, sanitizeStored } from '../../../../src/video/app/main/publish/store'
import { MAX_RETRIES, YouTubeAuthError, YouTubeService, backoffMs, resumableUpload, type Fetcher } from '../../../../src/video/app/main/publish/youtube'
import { TikTokAuthError, TikTokService } from '../../../../src/video/app/main/publish/tiktok'
import { challengeS256 } from '../../../../src/video/app/main/publish/oauth'
import type { LoopbackOptions, LoopbackWaiter } from '../../../../src/video/app/main/publish/loopback'
import type { UploadContext } from '../../../../src/video/app/main/publish/handoff'
import { parsePublishJson, YT_THUMBNAIL_MAX_BYTES } from '../../../../src/video/app/shared/publish'
import type { TikTokTokens } from '../../../../src/video/app/main/publish/tiktokApi'

const NOW = Date.parse('2026-10-11T00:00:00Z')
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ferret-video-svc-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** 暗号化の代わり（中身が平文で残らないことだけ確かめられる形） */
function fakeCipher(available = true): KeyCipher {
  return {
    available: () => available,
    encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
  }
}

type Call = { url: string; init: RequestInit | undefined }
/** 決めた順に答える偽の fetch。答えは関数でも Response でもよい */
function scriptedFetch(handler: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length - 1)
  }
  return { f, calls }
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const status = (s: number, headers: Record<string, string> = {}) => new Response(null, { status: s, headers })

/** ブラウザを開かず、すぐ code を返すループバック */
function fakeLoopback(result: { code?: string; error?: Error } = { code: 'CODE' }, redirect = 'http://127.0.0.1:5555') {
  const opts: LoopbackOptions[] = []
  let cancelled = 0
  const fn = (o: LoopbackOptions): LoopbackWaiter => {
    opts.push(o)
    const code = result.error ? Promise.reject(result.error) : Promise.resolve(result.code!)
    code.catch(() => undefined)
    return { ready: Promise.resolve(redirect), code, cancel: () => void cancelled++ }
  }
  return { fn, opts, cancelled: () => cancelled }
}

const store = (cipher = fakeCipher()) => new VideoPublishStore(join(tmp, 'video-publish-connections.bin'), cipher)
const ttTokens = (o: Partial<TikTokTokens> = {}): TikTokTokens => ({ accessToken: 'at', expiresAt: NOW + 3600_000, refreshToken: 'rt', refreshExpiresAt: NOW + 86_400_000, openId: 'o', scope: ['user.info.basic', 'video.upload'], ...o })

describe('接続の置き場（暗号化して別ファイル）', () => {
  it('書いた接続を読み戻す。ファイルにトークンの平文は残らない', async () => {
    const s = store()
    await s.setYouTube({ clientId: 'cid', refreshToken: 'secret-refresh', name: 'My Channel' })
    await s.setTikTok({ clientKey: 'ck', tokens: ttTokens({ accessToken: 'secret-access' }), name: 'me' })
    const text = readFileSync(join(tmp, 'video-publish-connections.bin'), 'utf8')
    expect(text).not.toContain('secret-refresh')
    expect(text).not.toContain('secret-access')
    const again = store()
    expect(await again.youtube('cid')).toEqual({ clientId: 'cid', refreshToken: 'secret-refresh', name: 'My Channel' })
    expect((await again.tiktok('ck'))?.tokens.accessToken).toBe('secret-access')
  })
  it('クライアントが違えば（サンドボックス → 本番など）前の接続は使わない', async () => {
    const s = store()
    await s.setYouTube({ clientId: 'old', refreshToken: 'r' })
    await s.setTikTok({ clientKey: 'sandbox', tokens: ttTokens() })
    expect(await s.youtube('new')).toBeNull()
    expect(await s.youtube(null)).toBeNull()
    expect(await s.tiktok('production')).toBeNull()
  })
  it('暗号化できない環境では起動中だけ覚え、ファイルを作らない', async () => {
    const s = store(fakeCipher(false))
    await s.setYouTube({ clientId: 'cid', refreshToken: 'r' })
    expect(await s.youtube('cid')).not.toBeNull()
    expect(s.persisted()).toBe(false)
    expect(existsSync(join(tmp, 'video-publish-connections.bin'))).toBe(false)
    expect(await store(fakeCipher(false)).youtube('cid')).toBeNull()
  })
  it('全部解除したらファイルを消す。壊れたファイルは空として扱う', async () => {
    const s = store()
    await s.setYouTube({ clientId: 'cid', refreshToken: 'r' })
    await s.setYouTube(null)
    expect(existsSync(join(tmp, 'video-publish-connections.bin'))).toBe(false)
    writeFileSync(join(tmp, 'video-publish-connections.bin'), 'garbage')
    expect(await store().youtube('cid')).toBeNull()
  })
  it('形の合わないものは捨てる。名前は短くする', () => {
    expect(sanitizeStored({ youtube: { clientId: 'c' }, tiktok: { clientKey: 'k', tokens: { accessToken: 1 } } })).toEqual({})
    expect(sanitizeStored(null)).toEqual({})
    expect(sanitizeStored({ youtube: { clientId: 'c', refreshToken: 'r', name: `  a\n${'b'.repeat(300)}` } }).youtube?.name).toHaveLength(200)
  })
  it('リフレッシュの結果は、その間に解除・別の接続があれば入れない', async () => {
    const s = store()
    await s.setTikTok({ clientKey: 'ck', tokens: ttTokens({ refreshToken: 'r1' }) })
    expect(await s.updateTikTokTokens('ck', 'r1', ttTokens({ refreshToken: 'r2' }))).toBe(true)
    expect(await s.updateTikTokTokens('ck', 'r1', ttTokens({ refreshToken: 'r3' }))).toBe(false)
    await s.setTikTok(null)
    expect(await s.updateTikTokTokens('ck', 'r2', ttTokens())).toBe(false)
  })
})

describe('YouTube: 再開可能アップロード（偽の fetch）', () => {
  const body = new Uint8Array(20)
  const base = (f: Fetcher, sleeps: number[], extra: Partial<Parameters<typeof resumableUpload>[0]> = {}) => ({
    fetch: f,
    session: 'https://upload.example/session',
    size: 20,
    read: async (o: number, l: number) => body.subarray(o, o + l),
    token: async () => 'tok',
    sleep: async (ms: number) => void sleeps.push(ms),
    onProgress: () => undefined,
    chunk: 8,
    ...extra
  })
  const range = (h: Headers | Record<string, string> | undefined) => (h as Record<string, string>)['Content-Range']

  it('8 バイトずつ送り、308 の Range の次から続ける', async () => {
    const { f, calls } = scriptedFetch((_u, _i, n) => (n === 0 ? status(308, { range: 'bytes=0-7' }) : n === 1 ? status(308, { range: 'bytes=0-15' }) : json(200, { id: 'VID' })))
    const sleeps: number[] = []
    expect(await resumableUpload(base(f, sleeps))).toBe('VID')
    expect(calls.map((c) => range(c.init?.headers as Record<string, string>))).toEqual(['bytes 0-7/20', 'bytes 8-15/20', 'bytes 16-19/20'])
    expect(sleeps).toEqual([])
  })
  it('一部だけ届いた 308（Range が途中）はその次から送る', async () => {
    const { f, calls } = scriptedFetch((_u, _i, n) => (n === 0 ? status(308, { range: 'bytes=0-4' }) : n === 1 ? status(308, { range: 'bytes=0-12' }) : json(200, { id: 'VID' })))
    await resumableUpload(base(f, []))
    expect(calls.map((c) => range(c.init?.headers as Record<string, string>))).toEqual(['bytes 0-7/20', 'bytes 5-12/20', 'bytes 13-19/20'])
  })
  it('308 に Range が無ければ最初から', async () => {
    const { f, calls } = scriptedFetch((_u, _i, n) => (n === 0 ? status(308) : json(200, { id: 'VID' })))
    await resumableUpload(base(f, []))
    expect(calls.map((c) => range(c.init?.headers as Record<string, string>))).toEqual(['bytes 0-7/20', 'bytes 0-7/20'])
  })
  it('503 / 429 は待ってから、どこまで届いたかを聞いて続ける', async () => {
    const answers = [status(503), status(308, { range: 'bytes=0-7' }), status(429), status(308, { range: 'bytes=0-15' }), json(200, { id: 'VID' })]
    const { f, calls } = scriptedFetch((_u, _i, n) => answers[n]!)
    const sleeps: number[] = []
    expect(await resumableUpload(base(f, sleeps))).toBe('VID')
    expect(sleeps).toEqual([1000, 1000]) // 308 で続けられたら数え直す
    expect(calls.map((c) => range(c.init?.headers as Record<string, string>))).toEqual(['bytes 0-7/20', 'bytes */20', 'bytes 8-15/20', 'bytes */20', 'bytes 16-19/20'])
  })
  it('続けて失敗すると 1・2・4・8・16 秒と待ち、5 回を超えたら止める', async () => {
    const { f } = scriptedFetch((_u, init) => ((init?.headers as Record<string, string>)['Content-Range']?.startsWith('bytes */') ? status(500) : json(500, { error: { message: 'backend', errors: [{ reason: 'backendError' }] } })))
    const sleeps: number[] = []
    await expect(resumableUpload(base(f, sleeps))).rejects.toThrow('YouTube 500 backendError: backend')
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(sleeps).toHaveLength(MAX_RETRIES)
  })
  it('待ち時間は 32 秒で頭打ち', () => {
    expect([1, 2, 3, 6, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 32000, 32000, 32000])
  })
  it('400・403 は待たずに止める', async () => {
    const { f } = scriptedFetch(() => json(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }))
    const sleeps: number[] = []
    await expect(resumableUpload(base(f, sleeps))).rejects.toThrow('YouTube 403 quotaExceeded: quota')
    expect(sleeps).toEqual([])
  })
  it('通信の失敗は 599 として待って続ける', async () => {
    let n = 0
    const f: Fetcher = async () => {
      n++
      if (n === 1) throw new Error('ECONNRESET')
      if (n === 2) return status(308, { range: 'bytes=0-7' })
      return json(200, { id: 'VID' })
    }
    const sleeps: number[] = []
    expect(await resumableUpload(base(f, sleeps))).toBe('VID')
    expect(sleeps).toEqual([1000])
  })
  it('401 はトークンを取り直してから続ける', async () => {
    const answers = [status(401), status(308, { range: 'bytes=0-7' }), json(200, { id: 'VID' })]
    const { f } = scriptedFetch((_u, _i, n) => answers[n] ?? json(200, { id: 'VID' }))
    let invalidated = 0
    expect(await resumableUpload(base(f, [], { invalidateToken: () => void invalidated++, chunk: 16 }))).toBe('VID')
    expect(invalidated).toBe(1)
  })
  it('状態の問い合わせで終わっていたら、その id を使う', async () => {
    const answers = [status(502), json(201, { id: 'DONE' })]
    const { f } = scriptedFetch((_u, _i, n) => answers[n]!)
    expect(await resumableUpload(base(f, []))).toBe('DONE')
  })
  it('id の無い完了は失敗', async () => {
    const { f } = scriptedFetch(() => json(200, {}))
    await expect(resumableUpload(base(f, [], { chunk: 32 }))).rejects.toThrow(/without a video id/)
  })
  it('全部届いたと言われたら状態を聞いて id を受け取る', async () => {
    const answers = [status(308, { range: 'bytes=0-19' }), json(200, { id: 'END' })]
    const { f, calls } = scriptedFetch((_u, _i, n) => answers[n]!)
    expect(await resumableUpload(base(f, [], { chunk: 32 }))).toBe('END')
    expect(range(calls[1]!.init?.headers as Record<string, string>)).toBe('bytes */20')
  })
})

describe('YouTube の接続・リフレッシュ・失効', () => {
  const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'gsecret' }
  const service = (f: Fetcher, s = store(), loop = fakeLoopback(), c: typeof client | null = client, opened: string[] = []) =>
    new YouTubeService({ fetch: f, openExternal: (u) => void opened.push(u), store: s, client: () => c, waitForLoopback: loop.fn, now: () => NOW, sleep: async () => undefined })

  it('クライアントの無い版は「設定が入っていない」', async () => {
    const yt = service(scriptedFetch(() => json(200, {})).f, store(), fakeLoopback(), null)
    expect(await yt.status()).toEqual({ configured: false, connected: false })
    await expect(yt.connect()).rejects.toThrow(/no YouTube connection configured/)
  })

  it('接続: 空いているポートで待ち、S256 の PKCE で同意画面を開き、code をトークンに替え、チャンネル名を読む', async () => {
    const { f, calls } = scriptedFetch((url) => (url.includes('/token') ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) : json(200, { items: [{ snippet: { title: 'My Channel' } }] })))
    const s = store()
    const loop = fakeLoopback()
    const opened: string[] = []
    const yt = service(f, s, loop, client, opened)
    await yt.connect()
    expect(loop.opts[0]).toMatchObject({ port: 0, path: '/', label: 'YouTube' })
    const auth = new URL(opened[0]!)
    expect(auth.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('state')).toBe(loop.opts[0]!.state)
    const tokenBody = new URLSearchParams(String(calls[0]!.init?.body))
    expect(tokenBody.get('code')).toBe('CODE')
    expect(tokenBody.get('client_secret')).toBe('gsecret')
    expect(challengeS256(tokenBody.get('code_verifier')!)).toBe(auth.searchParams.get('code_challenge'))
    expect(calls[1]!.url).toContain('channels?part=snippet&mine=true')
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer AT')
    expect(await yt.status()).toEqual({ configured: true, connected: true, name: 'My Channel' })
    expect(await s.youtube(client.clientId)).toMatchObject({ refreshToken: 'RT' })
    expect(loop.cancelled()).toBe(1) // 終わったら待ち受けを閉じる
  })

  it('リフレッシュトークンが返らなければ接続しない', async () => {
    const { f } = scriptedFetch(() => json(200, { access_token: 'AT', expires_in: 3600 }))
    const s = store()
    await expect(service(f, s).connect()).rejects.toThrow(/did not return a login that lasts/)
    expect(await s.youtube(client.clientId)).toBeNull()
  })

  it('同意画面で拒否されたら何も保存しない', async () => {
    const { f, calls } = scriptedFetch(() => json(200, {}))
    const s = store()
    await expect(service(f, s, fakeLoopback({ error: new Error('denied') })).connect()).rejects.toThrow('denied')
    expect(calls).toHaveLength(0)
    expect(await s.youtube(client.clientId)).toBeNull()
  })

  it('アクセストークンは切れるまで使い回し、切れかけたらリフレッシュする', async () => {
    const s = store()
    await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT' })
    let clock = NOW
    const { f, calls } = scriptedFetch(() => json(200, { access_token: `AT${calls.length}`, expires_in: 3600 }))
    const yt = new YouTubeService({ fetch: f, openExternal: () => undefined, store: s, client: () => client, now: () => clock })
    expect(await yt.token()).toBe('AT1')
    expect(await yt.token()).toBe('AT1')
    clock += 3600_000 - 59_000 // 1 分前を切った
    expect(await yt.token()).toBe('AT2')
    expect(calls).toHaveLength(2)
    expect(new URLSearchParams(String(calls[0]!.init?.body)).get('grant_type')).toBe('refresh_token')
  })

  it('リフレッシュトークンの失効（invalid_grant: テストユーザーの7日など）は捨てて、接続し直しを頼む', async () => {
    const s = store()
    await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT' })
    const { f } = scriptedFetch(() => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
    const yt = service(f, s)
    await expect(yt.token()).rejects.toBeInstanceOf(YouTubeAuthError)
    expect(await s.youtube(client.clientId)).toBeNull()
    expect((await yt.status()).connected).toBe(false)
  })

  it('一時的なトークンの失敗（500）では接続を捨てない', async () => {
    const s = store()
    await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT' })
    const { f } = scriptedFetch(() => json(500, { error: 'internal_failure' }))
    await expect(service(f, s).token()).rejects.toThrow(/YouTube token: internal_failure/)
    expect(await s.youtube(client.clientId)).not.toBeNull()
  })

  it('つながらないときは分かる文で断る', async () => {
    const s = store()
    await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT' })
    const f: Fetcher = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    await expect(service(f, s).token()).rejects.toThrow(/Could not reach YouTube/)
  })

  it('接続していなければアップロードの前に断る', async () => {
    await expect(service(scriptedFetch(() => json(200, {})).f).token()).rejects.toThrow(/YouTube is not connected/)
  })

  it('解除: Google 側でも取り消し、取り消しの失敗は気にしない', async () => {
    const s = store()
    await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT/+' })
    const { f, calls } = scriptedFetch(() => { throw new Error('offline') })
    await service(f, s).disconnect()
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke?token=RT%2F%2B')
    expect(await s.youtube(client.clientId)).toBeNull()
  })

  describe('アップロード（publish.json → 動画 → サムネイル）', () => {
    const ctx = (over: Partial<UploadContext> = {}, specOver: Record<string, unknown> = {}): UploadContext => {
      const videoPath = join(tmp, 'final.mp4')
      writeFileSync(videoPath, Buffer.alloc(32, 7))
      return { dir: tmp, videoPath, spec: parsePublishJson({ title: 'T', youtube: { privacy: 'unlisted' }, ...specOver }).spec!, onProgress: () => undefined, ...over }
    }
    const happy = (thumb: (init?: RequestInit) => Response = () => json(200, {})) => scriptedFetch((url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'AT', expires_in: 3600 })
      if (url.includes('uploadType=resumable')) return status(200, { location: 'https://upload.example/s' })
      if (url === 'https://upload.example/s') return json(200, { id: 'VID' })
      if (url.includes('thumbnails/set')) return thumb(init)
      return status(404)
    })
    const connected = async () => {
      const s = store()
      await s.setYouTube({ clientId: client.clientId, refreshToken: 'RT' })
      return s
    }

    it('videos.insert の本文を送り、URL を返す。予約は scheduled', async () => {
      const { f, calls } = happy()
      const yt = service(f, await connected())
      expect(await yt.upload(ctx())).toEqual({ url: 'https://youtu.be/VID', status: 'published', warnings: [] })
      const init = calls.find((c) => c.url.includes('uploadType=resumable'))!
      expect(JSON.parse(String(init.init?.body))).toMatchObject({ snippet: { title: 'T' }, status: { privacyStatus: 'unlisted' } })
      expect((init.init?.headers as Record<string, string>)['X-Upload-Content-Length']).toBe('32')
      const sched = await yt.upload(ctx({}, { youtube: { publishAt: '2099-01-01T00:00:00Z' } }))
      expect(sched.status).toBe('scheduled')
    })
    it('サムネイルを付ける（PNG / JPEG の種類）', async () => {
      const { f, calls } = happy()
      const png = join(tmp, 't.png')
      writeFileSync(png, Buffer.alloc(10))
      await service(f, await connected()).upload(ctx({ thumbnailPath: png }))
      const set = calls.find((c) => c.url.includes('thumbnails/set'))!
      expect(set.url).toContain('videoId=VID')
      expect((set.init?.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    })
    it('2 MB を超えるサムネイルは送らずお知らせ（ちょうど 2 MB は送る）', async () => {
      const big = join(tmp, 'big.jpg')
      writeFileSync(big, Buffer.alloc(YT_THUMBNAIL_MAX_BYTES + 1))
      const a = happy()
      const out = await service(a.f, await connected()).upload(ctx({ thumbnailPath: big }))
      expect(out.warnings).toEqual([expect.stringContaining('over 2 MB')])
      expect(a.calls.some((c) => c.url.includes('thumbnails/set'))).toBe(false)
      writeFileSync(big, Buffer.alloc(YT_THUMBNAIL_MAX_BYTES))
      const b = happy()
      expect((await service(b.f, await connected()).upload(ctx({ thumbnailPath: big }))).warnings).toEqual([])
    })
    it('サムネイルの失敗はお知らせにして、動画は上がったまま', async () => {
      const png = join(tmp, 't.png')
      writeFileSync(png, Buffer.alloc(10))
      const { f } = happy(() => json(403, { error: { message: 'verify your account', errors: [{ reason: 'forbidden' }] } }))
      const out = await service(f, await connected()).upload(ctx({ thumbnailPath: png }))
      expect(out.url).toBe('https://youtu.be/VID')
      expect(out.warnings).toEqual([expect.stringContaining('YouTube 403 forbidden')])
    })
    it('始めの要求の失敗はそのまま止める（429 のクォータなど）', async () => {
      const { f } = scriptedFetch((url) => (url.includes('/token') ? json(200, { access_token: 'AT', expires_in: 3600 }) : json(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } })))
      await expect(service(f, await connected()).upload(ctx())).rejects.toThrow('YouTube 403 quotaExceeded')
    })
    it('アップロード先が https でなければ送らない', async () => {
      const { f } = scriptedFetch((url) => (url.includes('/token') ? json(200, { access_token: 'AT', expires_in: 3600 }) : status(200, { location: 'http://evil.example/' })))
      await expect(service(f, await connected()).upload(ctx())).rejects.toThrow(/no upload session/)
    })
  })
})

describe('TikTok の接続・トークン・アップロード（偽の fetch）', () => {
  const client = { clientKey: 'sandbox-key', tokenUrl: 'https://ferretade.dev/oauth/tiktok', directPost: false }
  const service = (f: Fetcher, s = store(), loop = fakeLoopback({ code: 'CODE' }, 'http://127.0.0.1:47823/tiktok/callback'), c: typeof client | null = client, opened: string[] = [], clock = () => NOW) =>
    new TikTokService({ fetch: f, openExternal: (u) => void opened.push(u), store: s, client: () => c, waitForLoopback: loop.fn, now: clock, sleep: async () => undefined })

  it('クライアントの無い版は「まだ使えない」（手で上げる案内）', async () => {
    const tt = service(scriptedFetch(() => json(200, {})).f, store(), undefined, null)
    expect(await tt.status()).toEqual({ configured: false, connected: false })
    await expect(tt.connect()).rejects.toThrow(/Open TikTok and upload/)
  })

  it('接続: 47823 の固定のパスで待ち、16 進の SHA-256 の PKCE で開き、Worker で交換（シークレットは送らない）', async () => {
    const { f, calls } = scriptedFetch((url) =>
      url.endsWith('/token')
        ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'user.info.basic,video.upload' })
        : json(200, { data: { user: { display_name: 'Taro' } }, error: { code: 'ok' } }))
    const s = store()
    const loop = fakeLoopback({ code: 'CODE' }, 'http://127.0.0.1:47823/tiktok/callback')
    const opened: string[] = []
    const tt = service(f, s, loop, client, opened)
    await tt.connect()
    expect(loop.opts[0]).toMatchObject({ port: 47823, path: '/tiktok/callback', label: 'TikTok' })
    const auth = new URL(opened[0]!)
    expect(auth.origin + auth.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
    expect(auth.searchParams.get('scope')).toBe('user.info.basic,video.upload')
    expect(calls[0]!.url).toBe('https://ferretade.dev/oauth/tiktok/token')
    const body = new URLSearchParams(String(calls[0]!.init?.body))
    expect([...body.keys()].sort()).toEqual(['client_key', 'code', 'code_verifier', 'redirect_uri'])
    const verifier = body.get('code_verifier')!
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(auth.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('hex'))
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[0-9a-f]{64}$/)
    expect(await tt.status()).toEqual({ configured: true, connected: true, name: 'Taro', directPost: false })
  })

  it('Direct Post の版はスコープに video.publish を足す', async () => {
    const { f } = scriptedFetch(() => json(200, { access_token: 'AT', refresh_token: 'RT' }))
    const opened: string[] = []
    await service(f, store(), undefined, { ...client, directPost: true }, opened).connect()
    expect(new URL(opened[0]!).searchParams.get('scope')).toBe('user.info.basic,video.upload,video.publish')
  })

  it('Worker につながらなければ分かる文で断る', async () => {
    const f: Fetcher = async () => { throw new Error('offline') }
    await expect(service(f).connect()).rejects.toThrow(/TikTok sign-in server/)
  })

  it('切れかけたトークンはリフレッシュして入れ替える', async () => {
    const s = store()
    await s.setTikTok({ clientKey: client.clientKey, tokens: ttTokens({ expiresAt: NOW + 30_000, refreshToken: 'R1' }) })
    const { f, calls } = scriptedFetch(() => json(200, { access_token: 'AT2', refresh_token: 'R2', expires_in: 86400 }))
    const fresh = await service(f, s).tokens()
    expect(fresh.accessToken).toBe('AT2')
    expect(calls[0]!.url).toBe('https://ferretade.dev/oauth/tiktok/refresh')
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init?.body)))).toEqual({ client_key: 'sandbox-key', refresh_token: 'R1' })
    expect((await s.tiktok(client.clientKey))?.tokens.refreshToken).toBe('R2')
  })

  it('リフレッシュトークンも切れていれば（365 日）捨てて接続し直しを頼む', async () => {
    const s = store()
    await s.setTikTok({ clientKey: client.clientKey, tokens: ttTokens({ expiresAt: NOW - 1, refreshExpiresAt: NOW }) })
    const { f, calls } = scriptedFetch(() => json(200, {}))
    await expect(service(f, s).tokens()).rejects.toBeInstanceOf(TikTokAuthError)
    expect(calls).toHaveLength(0)
    expect(await s.tiktok(client.clientKey)).toBeNull()
  })

  it('Worker が invalid_grant を返したら捨てる。ほかの失敗では捨てない', async () => {
    const s = store()
    await s.setTikTok({ clientKey: client.clientKey, tokens: ttTokens({ expiresAt: NOW - 1 }) })
    const bad = scriptedFetch(() => json(400, { error: 'server_error', error_description: 'try later' }))
    await expect(service(bad.f, s).tokens()).rejects.toThrow('TikTok token: server_error try later')
    expect(await s.tiktok(client.clientKey)).not.toBeNull()
    const revoked = scriptedFetch(() => json(400, { error: 'invalid_grant' }))
    await expect(service(revoked.f, s).tokens()).rejects.toBeInstanceOf(TikTokAuthError)
    expect(await s.tiktok(client.clientKey)).toBeNull()
  })

  it('解除: Worker で取り消し（失敗は気にしない）、手元を消す', async () => {
    const s = store()
    await s.setTikTok({ clientKey: client.clientKey, tokens: ttTokens() })
    const { f, calls } = scriptedFetch(() => { throw new Error('offline') })
    await service(f, s).disconnect()
    expect(calls[0]!.url).toBe('https://ferretade.dev/oauth/tiktok/revoke')
    expect(await s.tiktok(client.clientKey)).toBeNull()
  })

  describe('アップロード', () => {
    const ctx = (size: number, specOver: Record<string, unknown> = {}): UploadContext => {
      const videoPath = join(tmp, 'final.mp4')
      writeFileSync(videoPath, Buffer.alloc(size, 1))
      return { dir: tmp, videoPath, spec: parsePublishJson({ title: 'T', tiktok: { enabled: true, caption: 'cap', ...specOver } }).spec!, onProgress: () => undefined }
    }
    const connected = async (scope = ['user.info.basic', 'video.upload']) => {
      const s = store()
      await s.setTikTok({ clientKey: client.clientKey, tokens: ttTokens({ scope }) })
      return s
    }
    const api = (statuses: string[], extra: (url: string, init?: RequestInit) => Response | null = () => null) => {
      let polls = 0
      return scriptedFetch((url, init) => {
        const x = extra(url, init)
        if (x) return x
        if (url.endsWith('/inbox/video/init/') || url.endsWith('/publish/video/init/')) return json(200, { data: { publish_id: 'P1', upload_url: 'https://upload.tiktok.example/u' }, error: { code: 'ok' } })
        if (url === 'https://upload.tiktok.example/u') return status(201)
        if (url.endsWith('/status/fetch/')) return json(200, { data: { status: statuses[Math.min(polls++, statuses.length - 1)], publicaly_available_post_id: [7123], fail_reason: 'file_format_check_failed' }, error: { code: 'ok' } })
        return status(404)
      })
    }

    it('受信トレイ送り: 小さな動画は1回で送り、SEND_TO_USER_INBOX で終わる', async () => {
      const { f, calls } = api(['PROCESSING_UPLOAD', 'SEND_TO_USER_INBOX'])
      const out = await service(f, await connected()).upload(ctx(1000))
      expect(out).toEqual({ status: 'inbox', warnings: [expect.stringContaining('TikTok inbox')] })
      const init = calls.find((c) => c.url.endsWith('/inbox/video/init/'))!
      expect(JSON.parse(String(init.init?.body))).toEqual({ source_info: { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } })
      const puts = calls.filter((c) => c.url === 'https://upload.tiktok.example/u')
      expect(puts.map((c) => (c.init?.headers as Record<string, string>)['Content-Range'])).toEqual(['bytes 0-999/1000'])
      expect((puts[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('video/mp4')
      expect(calls.filter((c) => c.url.endsWith('/status/fetch/'))).toHaveLength(2)
    })

    it('分割: 10 MiB ずつ、最後に余りを足す', async () => {
      const MB = 1024 * 1024
      const { f, calls } = api(['SEND_TO_USER_INBOX'])
      await service(f, await connected()).upload(ctx(25 * MB + 3))
      const puts = calls.filter((c) => c.url === 'https://upload.tiktok.example/u').map((c) => (c.init?.headers as Record<string, string>)['Content-Range'])
      expect(puts).toEqual([`bytes 0-${10 * MB - 1}/${25 * MB + 3}`, `bytes ${10 * MB}-${25 * MB + 2}/${25 * MB + 3}`])
    })

    it('Direct Post: 選べない公開範囲は SELF_ONLY に下げてお知らせ、URL を返す', async () => {
      const { f, calls } = api(['PUBLISH_COMPLETE'], (url) => (url.endsWith('/creator_info/query/') ? json(200, { data: { privacy_level_options: ['SELF_ONLY'], creator_username: 'me.name' }, error: { code: 'ok' } }) : null))
      const out = await service(f, await connected(['video.upload', 'video.publish']), undefined, { ...client, directPost: true }).upload(ctx(1000, { privacy: 'PUBLIC_TO_EVERYONE' }))
      expect(out).toEqual({ url: 'https://www.tiktok.com/@me.name/video/7123', status: 'published', warnings: [expect.stringContaining('PUBLIC_TO_EVERYONE')] })
      const init = calls.find((c) => c.url.endsWith('/publish/video/init/'))!
      expect(JSON.parse(String(init.init?.body)).post_info).toMatchObject({ privacy_level: 'SELF_ONLY', title: 'cap', disable_comment: true })
    })

    it('Direct Post の版でも、スコープが無ければ受信トレイ送り', async () => {
      const { f, calls } = api(['SEND_TO_USER_INBOX'])
      const out = await service(f, await connected(), undefined, { ...client, directPost: true }).upload(ctx(1000))
      expect(out.status).toBe('inbox')
      expect(calls.some((c) => c.url.endsWith('/inbox/video/init/'))).toBe(true)
    })

    it('FAILED は理由つきで止める', async () => {
      const { f } = api(['FAILED'])
      await expect(service(f, await connected()).upload(ctx(1000))).rejects.toThrow('TikTok: file_format_check_failed')
    })

    it('処理が終わらなければ 3 分ほどで切り上げてお知らせ', async () => {
      const { f, calls } = api(['PROCESSING_UPLOAD'])
      const out = await service(f, await connected()).upload(ctx(1000))
      expect(out.warnings).toContain('TikTok is still processing the video')
      expect(calls.filter((c) => c.url.endsWith('/status/fetch/'))).toHaveLength(36)
    })

    it('TikTok の API のエラー（投稿しすぎなど）はそのまま止める', async () => {
      const { f } = api([], (url) => (url.endsWith('/inbox/video/init/') ? json(200, { error: { code: 'spam_risk_too_many_posts', message: 'slow down' } }) : null))
      await expect(service(f, await connected()).upload(ctx(1000))).rejects.toThrow('TikTok upload init: spam_risk_too_many_posts slow down')
    })

    it('401・access_token_invalid は接続を捨てる', async () => {
      const s = await connected()
      const { f } = api([], (url) => (url.endsWith('/inbox/video/init/') ? json(401, { error: { code: 'access_token_invalid' } }) : null))
      await expect(service(f, s).upload(ctx(1000))).rejects.toBeInstanceOf(TikTokAuthError)
      expect(await s.tiktok(client.clientKey)).toBeNull()
    })

    it('アップロード先が https でなければ送らない', async () => {
      const { f } = api([], (url) => (url.endsWith('/inbox/video/init/') ? json(200, { data: { publish_id: 'P', upload_url: 'http://evil.example/' }, error: { code: 'ok' } }) : null))
      await expect(service(f, await connected()).upload(ctx(1000))).rejects.toThrow(/no upload URL/)
    })

    it('分割のアップロードの失敗は止める', async () => {
      const { f } = api([], (url) => (url === 'https://upload.tiktok.example/u' ? new Response(null, { status: 500, statusText: 'Internal' }) : null))
      await expect(service(f, await connected()).upload(ctx(1000))).rejects.toThrow('TikTok upload 500')
    })

    it('空の動画は送らない', async () => {
      const { f, calls } = api([])
      await expect(service(f, await connected()).upload(ctx(0))).rejects.toThrow('empty video')
      expect(calls).toHaveLength(0)
    })
  })
})

describe('トークンの値はログに出さない', () => {
  it('接続・アップロードの間、console を使わない', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    const { f } = scriptedFetch((url) => (url.includes('/token') ? json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) : json(200, { items: [] })))
    await new YouTubeService({ fetch: f, openExternal: () => undefined, store: store(), client: () => ({ clientId: 'c' }), waitForLoopback: fakeLoopback().fn }).connect()
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    for (const s of spies) s.mockRestore()
  })
})
