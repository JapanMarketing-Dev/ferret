import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  X_CHUNK_BYTES, XAuthError, XClient, authorizeUrl, exchangeCode, fetchMe, freshTokens, makePkce, mediaCategory, mimeOf, multipartBody,
  postThread, postUrl, refreshTokens, xFailure, type Fetcher
} from '../../src/main/publish/xApi'

/** X API（src/main/publish/xApi.ts）。fetch とファイルの読み方は偽物 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function recorder(reply: (url: string, init: RequestInit | undefined, n: number) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: Fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) })
    return reply(url, init, calls.length)
  })
  return { fetcher, calls }
}

describe('PKCE と認証画面の URL', () => {
  it('challenge は verifier の SHA-256（base64url・= 無し）。state は別の乱数', () => {
    let n = 0
    const pkce = makePkce((size) => Buffer.alloc(size, ++n))
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
    expect(pkce.state).not.toBe(pkce.verifier)
    expect(`${pkce.verifier}${pkce.challenge}${pkce.state}`).not.toMatch(/[+/=]/)
  })

  it('本物の乱数では毎回違う', () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier)
  })

  it('認証画面の URL に必要な値を入れ、エンコードする', () => {
    const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:47815/x/callback', state: 's&t', challenge: 'ch' }))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('s&t')
    expect(url.searchParams.get('code_challenge')).toBe('ch')
    expect(url.searchParams.get('scope')).toContain('media.write')
  })
})

describe('トークン', () => {
  it('code を交換し、期限を今から数える。期限が無い・おかしいときは2時間', async () => {
    const { fetcher, calls } = recorder(() => json({ access_token: 'A', refresh_token: 'R', expires_in: 60 }))
    expect(await exchangeCode(fetcher, { clientId: 'c', code: 'k', verifier: 'v', redirectUri: 'r' }, 1000)).toEqual({ accessToken: 'A', refreshToken: 'R', expiresAt: 61_000 })
    expect(calls[0]!.init!.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    for (const expires of [undefined, -5, 'x', 0]) {
      const r = recorder(() => json({ access_token: 'A', expires_in: expires }))
      expect((await exchangeCode(r.fetcher, { clientId: 'c', code: 'k', verifier: 'v', redirectUri: 'r' }, 0)).expiresAt).toBe(7_200_000)
    }
  })

  it('access_token の無い答えは断る', async () => {
    const { fetcher } = recorder(() => json({ token_type: 'bearer' }))
    await expect(exchangeCode(fetcher, { clientId: 'c', code: 'k', verifier: 'v', redirectUri: 'r' })).rejects.toMatchObject({ userFacing: true })
  })

  it('更新で新しい refresh_token が来なければ前のものを使い続ける', async () => {
    const { fetcher, calls } = recorder(() => json({ access_token: 'A2', expires_in: 100 }))
    expect(await refreshTokens(fetcher, { clientId: 'c', refreshToken: 'R1' }, 0)).toEqual({ accessToken: 'A2', refreshToken: 'R1', expiresAt: 100_000 })
    const form = new URLSearchParams(String(calls[0]!.init!.body))
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'c' })
  })

  it('更新が 400・401 なら XAuthError、それ以外は普通の失敗', async () => {
    await expect(refreshTokens(recorder(() => json({ error: 'invalid_grant' }, 400)).fetcher, { clientId: 'c', refreshToken: 'R' })).rejects.toBeInstanceOf(XAuthError)
    await expect(refreshTokens(recorder(() => json({}, 401)).fetcher, { clientId: 'c', refreshToken: 'R' })).rejects.toBeInstanceOf(XAuthError)
    const other = await refreshTokens(recorder(() => json({}, 503)).fetcher, { clientId: 'c', refreshToken: 'R' }).catch((e: unknown) => e)
    expect(other).not.toBeInstanceOf(XAuthError)
    expect(other).toMatchObject({ userFacing: true })
  })

  it('期限の2分前までは更新しない（境界: ちょうど2分前で更新する）', async () => {
    const { fetcher, calls } = recorder(() => json({ access_token: 'new', expires_in: 7200 }))
    const tokens = { accessToken: 'old', refreshToken: 'R', expiresAt: 1_000_000 }
    expect(await freshTokens(fetcher, 'c', tokens, 1_000_000 - 120_001)).toEqual({ tokens, refreshed: false })
    expect(calls).toHaveLength(0)
    expect((await freshTokens(fetcher, 'c', tokens, 1_000_000 - 120_000)).refreshed).toBe(true)
    await expect(freshTokens(fetcher, 'c', { accessToken: 'old', expiresAt: 0 }, 1)).rejects.toBeInstanceOf(XAuthError)
  })

  it('users/me のユーザー名の形を確かめる', async () => {
    expect(await fetchMe(recorder(() => json({ data: { id: '1', username: 'a_b9' } })).fetcher, 'T')).toEqual({ id: '1', username: 'a_b9' })
    await expect(fetchMe(recorder(() => json({ data: { id: '1', username: 'evil/../x' } })).fetcher, 'T')).rejects.toMatchObject({ userFacing: true })
    await expect(fetchMe(recorder(() => json({ data: {} })).fetcher, 'T')).rejects.toMatchObject({ userFacing: true })
    await expect(fetchMe(recorder(() => json({}, 401)).fetcher, 'T')).rejects.toBeInstanceOf(XAuthError)
  })
})

describe('xFailure（X のエラーを利用者向けに）', () => {
  it('401 は認証のやり直し、402・クレジットの 403 は支払い、429 は回数', async () => {
    expect(await xFailure(json({}, 401))).toBeInstanceOf(XAuthError)
    expect((await xFailure(json({ title: 'CreditsDepleted' }, 402))).message).toContain('CreditsDepleted')
    const credit = await xFailure(json({ detail: 'Your enrolled account does not have any credits' }, 403))
    expect(credit.message).toContain('credits')
    // 同じ理由でも、ふつうの失敗（400）とは違う文（支払いを確かめる案内）になる
    expect(credit.message).not.toBe((await xFailure(json({ detail: 'Your enrolled account does not have any credits' }, 400))).message)
    expect((await xFailure(json({}, 429))).message).toBeTruthy()
  })

  it('理由は JSON の detail・title・errors から取り、無ければ本文・HTTP の番号。200文字まで', async () => {
    expect((await xFailure(json({ errors: [{ message: 'bad media' }] }, 400))).message).toContain('bad media')
    expect((await xFailure(new Response('<html>oops</html>', { status: 500 }))).message).toContain('<html>oops</html>')
    expect((await xFailure(new Response('', { status: 502 }))).message).toContain('HTTP 502')
    const long = await xFailure(json({ detail: 'x'.repeat(500) }, 400))
    expect(long.message.match(/x+/)![0]).toHaveLength(200)
  })
})

describe('メディアの形', () => {
  it('拡張子から MIME と種類を決める', () => {
    expect(mimeOf('/a/B.JPG')).toBe('image/jpeg')
    expect(mimeOf('/a/b.mov')).toBe('video/quicktime')
    expect(mimeOf('/a/b.unknown')).toBe('application/octet-stream')
    expect(mediaCategory('/a/b.gif', 'image')).toBe('tweet_gif')
    expect(mediaCategory('/a/b.png', 'image')).toBe('tweet_image')
    expect(mediaCategory('/a/b.mp4', 'video')).toBe('tweet_video')
  })

  it('multipart の本文を組み、ファイル名の引用符・改行は崩す', () => {
    const body = multipartBody({ segment_index: '3' }, { name: 'media', filename: 'a"b\r\n.png', type: 'image/png', data: Buffer.from('DATA') }, 'BOUND').toString()
    expect(body).toBe('--BOUND\r\nContent-Disposition: form-data; name="segment_index"\r\n\r\n3\r\n'
      + '--BOUND\r\nContent-Disposition: form-data; name="media"; filename="a_b__.png"\r\nContent-Type: image/png\r\n\r\nDATA\r\n--BOUND--\r\n')
  })
})

describe('XClient.uploadMedia', () => {
  function client(reply: (url: string, init: RequestInit | undefined, n: number) => Response, extra: { now?: () => number } = {}) {
    const r = recorder(reply)
    const reads: Array<[number, number]> = []
    const sleeps: number[] = []
    const c = new XClient({
      fetcher: r.fetcher, accessToken: 'TOKEN',
      readChunk: async (_path, offset, length) => { reads.push([offset, length]); return Buffer.alloc(length, 1) },
      sleep: async (ms) => { sleeps.push(ms) },
      ...extra
    })
    return { c, calls: r.calls, reads, sleeps }
  }

  it('大きいファイルは4MBずつ分けて送る（境界: ちょうど2倍＋1バイトで3回）', async () => {
    const { c, calls, reads } = client((url) => url.endsWith('/initialize') ? json({ data: { id: '9' } }) : url.endsWith('/finalize') ? json({ data: { id: '9' } }) : new Response(null, { status: 204 }))
    const bytes = X_CHUNK_BYTES * 2 + 1
    expect(await c.uploadMedia({ path: '/v.mp4', kind: 'video', bytes, name: 'v.mp4' })).toBe('9')
    expect(reads).toEqual([[0, X_CHUNK_BYTES], [X_CHUNK_BYTES, X_CHUNK_BYTES], [X_CHUNK_BYTES * 2, 1]])
    expect(calls.filter((x) => x.url.endsWith('/append'))).toHaveLength(3)
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ media_type: 'video/mp4', total_bytes: bytes, media_category: 'tweet_video' })
    expect(calls.every((x) => (x.init!.headers as Record<string, string>).Authorization === 'Bearer TOKEN')).toBe(true)
  })

  it('ちょうど4MBなら1回。0バイトでも1回送る', async () => {
    const reply = (url: string) => url.endsWith('/initialize') || url.endsWith('/finalize') ? json({ data: { id: '9' } }) : new Response(null, { status: 204 })
    const a = client(reply)
    await a.c.uploadMedia({ path: '/a.png', kind: 'image', bytes: X_CHUNK_BYTES, name: 'a.png' })
    expect(a.reads).toEqual([[0, X_CHUNK_BYTES]])
    const b = client(reply)
    await b.c.uploadMedia({ path: '/a.png', kind: 'image', bytes: 0, name: 'a.png' })
    expect(b.reads).toEqual([[0, 0]])
  })

  it('動画の処理を check_after_secs（1〜30秒に収める）ごとに見て、済むまで待つ', async () => {
    const states = [{ state: 'in_progress', check_after_secs: 100 }, { state: 'succeeded' }]
    const { c, calls, sleeps } = client((url) => {
      if (url.endsWith('/initialize')) return json({ data: { id: '9' } })
      if (url.endsWith('/finalize')) return json({ data: { id: '9', processing_info: { state: 'pending', check_after_secs: 0 } } })
      if (url.includes('command=STATUS')) return json({ data: { processing_info: states.shift() } })
      return new Response(null, { status: 204 })
    })
    expect(await c.uploadMedia({ path: '/v.mp4', kind: 'video', bytes: 10, name: 'v.mp4' })).toBe('9')
    expect(sleeps).toEqual([1000, 30_000])
    expect(calls.filter((x) => x.url.includes('command=STATUS&media_id=9'))).toHaveLength(2)
  })

  it('処理が失敗・時間切れなら断る', async () => {
    const failed = client((url) => url.endsWith('/finalize') ? json({ data: { processing_info: { state: 'failed', error: { message: 'InvalidMedia' } } } }) : url.endsWith('/initialize') ? json({ data: { id: '9' } }) : new Response(null, { status: 204 }))
    await expect(failed.c.uploadMedia({ path: '/v.mp4', kind: 'video', bytes: 1, name: 'v.mp4' })).rejects.toThrow(/InvalidMedia/)
    let t = 0
    const slow = client((url) => url.endsWith('/initialize') ? json({ data: { id: '9' } }) : url.endsWith('/append') ? new Response(null, { status: 204 })
      : json({ data: { processing_info: { state: 'in_progress', check_after_secs: 5 } } }), { now: () => (t += 4 * 60 * 1000) })
    await expect(slow.c.uploadMedia({ path: '/v.mp4', kind: 'video', bytes: 1, name: 'v.mp4' })).rejects.toThrow(/timeout/)
  })

  it('initialize が id を返さない・数字でないなら断る（送り先の URL に入れない）', async () => {
    for (const data of [{}, { id: '../../x' }, { id: 9 }]) {
      const { c, calls } = client(() => json({ data }))
      await expect(c.uploadMedia({ path: '/a.png', kind: 'image', bytes: 1, name: 'a.png' })).rejects.toMatchObject({ userFacing: true })
      expect(calls).toHaveLength(1)
    }
  })

  it('append が失敗したら理由を伝えて止める', async () => {
    const { c, calls } = client((url) => url.endsWith('/initialize') ? json({ data: { id: '9' } }) : json({ detail: 'segment too big' }, 400))
    await expect(c.uploadMedia({ path: '/a.png', kind: 'image', bytes: X_CHUNK_BYTES + 1, name: 'a.png' })).rejects.toThrow(/segment too big/)
    expect(calls).toHaveLength(2)
  })
})

describe('createPost と postThread', () => {
  it('createPost は id の形を確かめる', async () => {
    const ok = new XClient({ fetcher: recorder(() => json({ data: { id: '123' } }, 201)).fetcher, accessToken: 'T' })
    expect(await ok.createPost('a')).toBe('123')
    const bad = new XClient({ fetcher: recorder(() => json({ data: { id: 'x' } }, 201)).fetcher, accessToken: 'T' })
    await expect(bad.createPost('a')).rejects.toMatchObject({ userFacing: true })
  })

  it('本文が無ければ断る。1件目が失敗したら例外', async () => {
    const c = { uploadMedia: vi.fn(), createPost: vi.fn(async () => { throw new XAuthError() }) }
    await expect(postThread(c, [], [])).rejects.toMatchObject({ userFacing: true })
    await expect(postThread(c, ['a', 'b'], [])).rejects.toBeInstanceOf(XAuthError)
    expect(c.createPost).toHaveBeenCalledTimes(1)
  })

  it('メディアのアップロードが失敗したら投稿しない', async () => {
    const c = { uploadMedia: vi.fn(async () => { throw new Error('upload') }), createPost: vi.fn() }
    await expect(postThread(c, ['a'], [{ path: '/a.png', kind: 'image', bytes: 1, name: 'a.png' }])).rejects.toThrow('upload')
    expect(c.createPost).not.toHaveBeenCalled()
  })

  it('途中で失敗したら、そこまでの id と理由（利用者向けでなければ決まった文）', async () => {
    let n = 0
    const c = { uploadMedia: vi.fn(), createPost: vi.fn(async () => { if (++n === 3) throw new Error('/secret/path'); return String(n) }) }
    const result = await postThread(c, ['a', 'b', 'c', 'd'], [])
    expect(result.ids).toEqual(['1', '2'])
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain('/secret/path')
    expect(c.createPost).toHaveBeenNthCalledWith(2, 'b', { replyTo: '1' })
  })

  it('投稿の URL', () => {
    expect(postUrl('a_b', '123')).toBe('https://x.com/a_b/status/123')
  })
})
