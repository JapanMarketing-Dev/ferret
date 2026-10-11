import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFile, publishHandlers, readDraftPatch, readGenerateRequest, type PublishIpcDeps } from '../../src/main/publish/ipc'
import { PublishStore } from '../../src/main/publish/store'
import { PublishConnections } from '../../src/main/publish/connections'
import type { PublishBackground } from '../../src/main/publish/background'
import type { CallbackOptions, CallbackWaiter } from '../../src/main/publish/xAuthServer'
import { NO_CIPHER } from '../../src/main/pipeline/stt/keys'
import type { PublishConnectionsInfo } from '../../src/shared/publish'

/** 発信の IPC（src/main/publish/ipc.ts）。下書きは一時フォルダ、X・ブログ・AI は偽物。外へは送らない */

let dir = ''
let project = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferret-publish-ipc-'))
  project = join(dir, 'project')
  await mkdir(join(project, 'shots'), { recursive: true })
  await writeFile(join(project, 'shots', 'a.png'), 'png')
  await writeFile(join(project, 'notes.txt'), 'x')
  await writeFile(join(dir, 'outside.png'), 'png')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const CLIENT_ID = 'Q2xpZW50SWRGb3JUZXN0OjE6Y2k'
const ACCESS = 'access-token-SECRET'
const REFRESH = 'refresh-token-SECRET'

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
type Route = (call: Call) => Response | undefined

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** 偽の X とブログ。routes の先頭から合うものを使い、無ければ 404 */
function fakeNet(extra: Route[] = []) {
  const calls: Call[] = []
  let tweetCount = 0
  const routes: Route[] = [
    ...extra,
    (c) => c.url === 'https://api.x.com/2/oauth2/token' ? json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 7200, token_type: 'bearer' }) : undefined,
    (c) => c.url === 'https://api.x.com/2/oauth2/revoke' ? json({ revoked: true }) : undefined,
    (c) => c.url === 'https://api.x.com/2/users/me' ? json({ data: { id: '42', username: 'ferret_dev', name: 'Ferret' } }) : undefined,
    (c) => c.url === 'https://api.x.com/2/media/upload/initialize' ? json({ data: { id: '777', media_key: '3_777', expires_after_secs: 86400 } }) : undefined,
    (c) => c.url === 'https://api.x.com/2/media/upload/777/append' ? new Response(null, { status: 204 }) : undefined,
    (c) => c.url === 'https://api.x.com/2/media/upload/777/finalize' ? json({ data: { id: '777', size: 3 } }) : undefined,
    (c) => c.url === 'https://api.x.com/2/tweets' ? json({ data: { id: String(1000 + ++tweetCount), text: 'x' } }, 201) : undefined,
    (c) => c.url === 'https://blog.example.com/wp-json/wp/v2/users/me?context=edit' ? json({ id: 1, name: 'me' }) : undefined,
    (c) => c.url === 'https://blog.example.com/wp-json/wp/v2/media' ? json({ id: 55, source_url: 'https://blog.example.com/wp-content/uploads/a.png' }, 201) : undefined,
    (c) => c.url === 'https://blog.example.com/wp-json/wp/v2/posts' ? json({ id: 9, link: 'https://blog.example.com/?p=9', status: 'publish' }, 201) : undefined
  ]
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const body = init?.body === undefined || init.body === null ? '' : typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array).toString('latin1')
    const call = { url, method: init?.method ?? 'GET', headers, body }
    calls.push(call)
    for (const route of routes) {
      const res = route(call)
      if (res) return res
    }
    return json({ title: 'Not Found' }, 404)
  })
  return { fetcher, calls }
}

/** 偽のコールバック待ち。code を返すか、失敗させる */
function fakeCallback(result: { code?: string; error?: Error } = { code: 'CODE' }) {
  const seen: CallbackOptions[] = []
  const cancel = vi.fn()
  const waitForCallback = (options: CallbackOptions): CallbackWaiter => {
    seen.push(options)
    const code = result.error ? Promise.reject(result.error) : Promise.resolve(result.code ?? '')
    code.catch(() => undefined)
    return { ready: Promise.resolve(), code, cancel }
  }
  return { waitForCallback, seen, cancel }
}

function setup(over: Partial<PublishIpcDeps> = {}, net = fakeNet(), callback = fakeCallback()) {
  const store = new PublishStore(join(dir, 'userData'))
  const connections = new PublishConnections(join(dir, 'userData', 'publish-connections.bin'), NO_CIPHER)
  const background = { isRunning: () => false, runNow: vi.fn(async () => 2) } as unknown as PublishBackground
  const notifyChanged = vi.fn()
  const opened: string[] = []
  const deps: PublishIpcDeps = {
    projectId: () => 'p1',
    projectDir: () => project,
    store,
    background,
    thumbnail: async () => undefined,
    connections,
    fetcher: net.fetcher,
    openExternal: async (url) => { opened.push(url) },
    waitForCallback: callback.waitForCallback,
    pickFiles: async () => [],
    notifyChanged,
    ...over
  }
  return { handlers: publishHandlers(deps), store, connections, background, notifyChanged, net, opened, callback }
}

async function connected(over: Partial<PublishIpcDeps> = {}, net = fakeNet()) {
  const s = setup(over, net)
  await s.handlers['publish:setXClientId'](CLIENT_ID)
  await s.handlers['publish:connectX']()
  net.calls.length = 0
  return s
}

describe('画面から来た値を確かめる', () => {
  it('生成の指示：空白だけは落とし、文章の無い出どころは付けない。主題は上限で切る', () => {
    expect(readGenerateRequest(undefined)).toEqual({})
    expect(readGenerateRequest({ text: '  ', textLabel: 'a.md', intent: ' ' })).toEqual({})
    expect(readGenerateRequest({ text: ' 本文 ', textLabel: 'a.md', intent: '告知で' })).toEqual({ text: '本文', textLabel: 'a.md', intent: '告知で' })
    expect(readGenerateRequest({ text: 1, intent: ['x'] })).toEqual({})
    expect(readGenerateRequest({ intent: 'h'.repeat(9999) }).intent).toHaveLength(2000)
  })

  it('下書きの変更：知らない状態・型の違う値は落とし、記事の題・本文は通す', () => {
    expect(readDraftPatch({ title: 't', text: 'b', status: 'posted', mediaOrder: ['a', 1, 'b'], articleTitle: 'A', articleBody: 'B' }))
      .toEqual({ title: 't', text: 'b', status: 'posted', mediaOrder: ['a', 'b'], articleTitle: 'A', articleBody: 'B' })
    expect(readDraftPatch({ status: 'deleted', text: 3, articleBody: {} })).toEqual({})
    expect(readDraftPatch(null)).toEqual({})
  })
})

describe('プロジェクトの中のファイル（projectFile）', () => {
  it('中の普通のファイルは実パス・大きさ・相対パス', async () => {
    const file = await projectFile(project, 'shots/a.png')
    expect(file?.bytes).toBe(3)
    expect(file?.ref).toBe('shots/a.png')
    expect(file?.path.endsWith(join('shots', 'a.png'))).toBe(true)
  })

  it('外へ出るパス・絶対パス・フォルダ・無いファイル・外へ向くリンクは null', async () => {
    await symlink(join(dir, 'outside.png'), join(project, 'link.png'))
    for (const rel of ['../outside.png', join(dir, 'outside.png'), 'shots', 'none.png', 'link.png', '', 'shots/../../outside.png']) {
      expect(await projectFile(project, rel)).toBeNull()
    }
  })
})

describe('下書きのハンドラ', () => {
  it('プロジェクトを開いていなければ断る', async () => {
    const { handlers } = setup({ projectId: () => null })
    await expect(handlers['publish:list']()).rejects.toThrow()
    await expect(handlers['publish:create']('a')).rejects.toThrow()
    await expect(handlers['publish:postX']('x')).rejects.toThrow()
  })

  it('手書きの下書きを作ると一覧に出て、変わったことを知らせる', async () => {
    const { handlers, notifyChanged } = setup()
    const id = await handlers['publish:create']('こんにちは') as string
    const list = await handlers['publish:list']() as { drafts: Array<{ id: string; text: string; source: string; article: unknown }> }
    expect(list.drafts).toEqual([expect.objectContaining({ id, text: 'こんにちは', source: 'manual', article: { title: '', body: '' } })])
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('生成は background.runNow を通す（同時に1つだけ）', async () => {
    const { handlers, background } = setup()
    expect(await handlers['publish:generate']({ text: '本文', intent: '告知' })).toBe(2)
    expect(background.runNow).toHaveBeenCalledWith('p1', { text: '本文', intent: '告知' })
  })

  it('プロジェクトのメディア：中のファイルは付き、外は断る。画面へ実パスを返さない', async () => {
    const { handlers } = setup()
    const id = await handlers['publish:create']('a') as string
    expect(await handlers['publish:addProjectMedia'](id, ['shots/a.png'])).toBe(1)
    await expect(handlers['publish:addProjectMedia'](id, ['../outside.png'])).rejects.toThrow()
    const list = await handlers['publish:list']() as { drafts: Array<{ media: Array<Record<string, unknown>> }> }
    expect(list.drafts[0]!.media).toEqual([expect.objectContaining({ name: 'a.png', ref: 'shots/a.png' })])
    expect(JSON.stringify(list)).not.toContain(project)
  })

  it('選んだファイル：画像・動画でなければ断り、選ばなければ0。プロジェクトの中なら相対パスを付ける', async () => {
    const id = await setup().handlers['publish:create']('a') as string
    expect(await setup({ pickFiles: async () => [] }).handlers['publish:pickMedia'](id)).toBe(0)
    await expect(setup({ pickFiles: async () => [join(project, 'notes.txt')] }).handlers['publish:pickMedia'](id)).rejects.toThrow()
    expect(await setup({ pickFiles: async () => [join(dir, 'outside.png')] }).handlers['publish:pickMedia'](id)).toBe(1)
    const s = setup({ pickFiles: async () => [join(project, 'shots', 'a.png')] })
    expect(await s.handlers['publish:pickMedia'](id)).toBe(1)
    const draft = (await s.store.get('p1', id))!
    expect(draft.media.map((m) => m.ref)).toEqual([undefined, 'shots/a.png'])
  })

  it('バックグラウンドの切り替えは下書きの控えに残る', async () => {
    const { handlers, store } = setup()
    await handlers['publish:setBackground'](false)
    expect((await store.background('p1')).enabled).toBe(false)
    await handlers['publish:setBackground'](true)
    expect((await store.background('p1')).enabled).toBe(true)
  })
})

describe('X の接続', () => {
  it('Client ID の形を確かめ、空なら消す', async () => {
    const { handlers } = setup()
    await expect(handlers['publish:setXClientId']('bad id!')).rejects.toMatchObject({ userFacing: true })
    expect((await handlers['publish:setXClientId'](`  ${CLIENT_ID} `) as PublishConnectionsInfo).x.clientId).toBe(CLIENT_ID)
    expect((await handlers['publish:setXClientId']('') as PublishConnectionsInfo).x.clientId).toBeNull()
  })

  it('Client ID が無ければ認証を始めない（ブラウザもポートも開かない）', async () => {
    const s = setup()
    await expect(s.handlers['publish:connectX']()).rejects.toMatchObject({ userFacing: true })
    expect(s.opened).toEqual([])
    expect(s.callback.seen).toEqual([])
  })

  it('PKCE（S256）で認証画面を開き、code を交換して @ユーザー名を残す。トークンは画面へ返さない', async () => {
    const s = setup()
    await s.handlers['publish:setXClientId'](CLIENT_ID)
    const info = await s.handlers['publish:connectX']() as PublishConnectionsInfo
    expect(info.x).toEqual({ clientId: CLIENT_ID, connected: true, username: 'ferret_dev', callbackUrl: 'http://127.0.0.1:47815/x/callback' })
    expect(JSON.stringify(info)).not.toContain('SECRET')

    const url = new URL(s.opened[0]!)
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47815/x/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'])
    // コールバックは同じ state で待つ
    expect(s.callback.seen[0]).toMatchObject({ host: '127.0.0.1', port: 47815, path: '/x/callback', state: url.searchParams.get('state') })

    const token = s.net.calls.find((c) => c.url.endsWith('/oauth2/token'))!
    const form = new URLSearchParams(token.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('CODE')
    expect(form.get('client_id')).toBe(CLIENT_ID)
    // verifier から challenge が作られている
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
    expect(s.net.calls.find((c) => c.url.endsWith('/users/me'))!.headers.Authorization).toBe(`Bearer ${ACCESS}`)
  })

  it('拒否・時間切れは断り、トークンを残さない。待ち受けは閉じる', async () => {
    const callback = fakeCallback({ error: Object.assign(new Error('denied'), { userFacing: true }) })
    const s = setup({}, fakeNet(), callback)
    await s.handlers['publish:setXClientId'](CLIENT_ID)
    await expect(s.handlers['publish:connectX']()).rejects.toThrow('denied')
    expect((await s.connections.info()).x.connected).toBe(false)
    expect(callback.cancel).toHaveBeenCalled()
  })

  it('code の交換を X が断ったら、理由を伝えてトークンを残さない', async () => {
    const net = fakeNet([(c) => c.url.endsWith('/oauth2/token') ? json({ error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' }, 400) : undefined])
    const s = setup({}, net)
    await s.handlers['publish:setXClientId'](CLIENT_ID)
    await expect(s.handlers['publish:connectX']()).rejects.toThrow(/authorization code was invalid/)
    expect((await s.connections.info()).x.connected).toBe(false)
  })

  it('認証のあいだに Client ID が変わったら、得たトークンは捨てる', async () => {
    const s = setup()
    await s.handlers['publish:setXClientId'](CLIENT_ID)
    const net = fakeNet([(c) => {
      if (c.url.endsWith('/users/me')) void s.connections.setXClientId('AnotherClientId123')
      return undefined
    }])
    const s2 = { ...s, handlers: publishHandlers({ ...setupDeps(s, net) }) }
    await expect(s2.handlers['publish:connectX']()).rejects.toMatchObject({ userFacing: true })
    expect((await s.connections.info()).x).toMatchObject({ clientId: 'AnotherClientId123', connected: false })
  })

  it('Client ID を変えると前のトークンは捨てる', async () => {
    const s = await connected()
    await s.handlers['publish:setXClientId']('AnotherClientId123')
    expect((await s.connections.info()).x).toMatchObject({ connected: false })
  })

  it('接続を切ると X でトークンを取り消し、手元からも消す', async () => {
    const s = await connected()
    const info = await s.handlers['publish:disconnectX']() as PublishConnectionsInfo
    expect(info.x).toMatchObject({ clientId: CLIENT_ID, connected: false })
    const revoke = s.net.calls.find((c) => c.url.endsWith('/oauth2/revoke'))!
    expect(new URLSearchParams(revoke.body).get('token')).toBe(REFRESH)
  })

  it('取り消しに失敗しても手元からは消す', async () => {
    const net = fakeNet()
    const s = await connected({}, net)
    net.fetcher.mockImplementationOnce(async () => { throw new Error('offline') })
    await expect(s.handlers['publish:disconnectX']()).resolves.toMatchObject({ x: { connected: false } })
  })
})

/** setup の deps を、別の偽のネットで作り直す */
function setupDeps(s: ReturnType<typeof setup>, net: ReturnType<typeof fakeNet>): PublishIpcDeps {
  return {
    projectId: () => 'p1', projectDir: () => project, store: s.store, background: s.background, thumbnail: async () => undefined,
    connections: s.connections, fetcher: net.fetcher, openExternal: async () => undefined, waitForCallback: fakeCallback().waitForCallback,
    pickFiles: async () => [], notifyChanged: () => undefined
  }
}

describe('X へ投稿', () => {
  it('接続していなければ断る（X へは送らない）', async () => {
    const s = setup()
    const id = await s.handlers['publish:create']('本文') as string
    await expect(s.handlers['publish:postX'](id)).rejects.toMatchObject({ userFacing: true })
    expect(s.net.calls).toEqual([])
  })

  it('本文が空なら断る', async () => {
    const s = await connected()
    const id = await s.handlers['publish:create']('  ') as string
    await expect(s.handlers['publish:postX'](id)).rejects.toMatchObject({ userFacing: true })
    expect(s.net.calls).toEqual([])
  })

  it('メディアを上げてから1件目に付け、長い本文は返信でつなぐ。記録を残して投稿済みにする', async () => {
    const s = await connected()
    const long = ['一'.repeat(130), '二'.repeat(130)].join('\n\n')
    const id = await s.handlers['publish:create'](long) as string
    await s.handlers['publish:addProjectMedia'](id, ['shots/a.png'])
    const result = await s.handlers['publish:postX'](id)
    expect(result).toEqual({ url: 'https://x.com/ferret_dev/status/1001', posted: 2, parts: 2 })

    const urls = s.net.calls.map((c) => c.url)
    expect(urls).toEqual([
      'https://api.x.com/2/media/upload/initialize',
      'https://api.x.com/2/media/upload/777/append',
      'https://api.x.com/2/media/upload/777/finalize',
      'https://api.x.com/2/tweets',
      'https://api.x.com/2/tweets'
    ])
    expect(JSON.parse(s.net.calls[0]!.body)).toEqual({ media_type: 'image/png', total_bytes: 3, media_category: 'tweet_image' })
    expect(s.net.calls[1]!.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(s.net.calls[1]!.body).toContain('name="segment_index"\r\n\r\n0')
    expect(s.net.calls[1]!.body).toContain('png')
    expect(JSON.parse(s.net.calls[3]!.body)).toEqual({ text: '一'.repeat(130), media: { media_ids: ['777'] } })
    expect(JSON.parse(s.net.calls[4]!.body)).toEqual({ text: '二'.repeat(130), reply: { in_reply_to_tweet_id: '1001' } })
    expect(s.net.calls.every((c) => c.headers.Authorization === `Bearer ${ACCESS}`)).toBe(true)

    const draft = (await s.store.get('p1', id))!
    expect(draft.status).toBe('posted')
    expect(draft.results).toEqual([expect.objectContaining({ kind: 'x', targetName: '@ferret_dev', url: 'https://x.com/ferret_dev/status/1001' })])
  })

  it('スレッドの途中で失敗したら、そこまでの結果と理由を返す（記録は残す）', async () => {
    let n = 0
    const net = fakeNet([(c) => c.url.endsWith('/2/tweets') && ++n === 2 ? json({ title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' }, 403) : undefined])
    const s = await connected({}, net)
    const id = await s.handlers['publish:create'](['あ'.repeat(130), 'い'.repeat(130), 'う'.repeat(130)].join('\n\n')) as string
    const result = await s.handlers['publish:postX'](id) as { posted: number; parts: number; error?: string }
    expect(result.posted).toBe(1)
    expect(result.parts).toBe(3)
    expect(result.error).toContain('duplicate content')
    expect((await s.store.get('p1', id))!.results).toHaveLength(1)
  })

  it('1件目が失敗したら例外で、投稿済みにしない', async () => {
    const net = fakeNet([(c) => c.url.endsWith('/2/tweets') ? json({ title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits.' }, 402) : undefined])
    const s = await connected({}, net)
    const id = await s.handlers['publish:create']('本文') as string
    await expect(s.handlers['publish:postX'](id)).rejects.toThrow(/credits/)
    expect((await s.store.get('p1', id))!.status).toBe('new')
  })

  it('X が 401 を返したらトークンを捨てる（もう一度認証してもらう）', async () => {
    const net = fakeNet([(c) => c.url.endsWith('/2/tweets') ? json({ title: 'Unauthorized' }, 401) : undefined])
    const s = await connected({}, net)
    const id = await s.handlers['publish:create']('本文') as string
    await expect(s.handlers['publish:postX'](id)).rejects.toMatchObject({ userFacing: true })
    expect((await s.connections.info()).x.connected).toBe(false)
  })

  it('切れかけのトークンは更新して保存してから投稿する', async () => {
    const net = fakeNet()
    const s = await connected({}, net)
    const x = await s.connections.x()
    await s.connections.setXTokens(CLIENT_ID, { ...x.tokens!, expiresAt: Date.now() - 1000 }, x.user)
    net.calls.length = 0
    const id = await s.handlers['publish:create']('本文') as string
    await s.handlers['publish:postX'](id)
    expect(net.calls.map((c) => c.url)).toEqual(['https://api.x.com/2/oauth2/token', 'https://api.x.com/2/tweets'])
    expect(new URLSearchParams(net.calls[0]!.body).get('grant_type')).toBe('refresh_token')
    expect((await s.connections.x()).tokens!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('更新のトークンが使えなければトークンを捨てて断る', async () => {
    const net = fakeNet()
    const s = await connected({}, net)
    const x = await s.connections.x()
    await s.connections.setXTokens(CLIENT_ID, { ...x.tokens!, expiresAt: 0 }, x.user)
    net.fetcher.mockImplementationOnce(async () => json({ error: 'invalid_grant' }, 400))
    const id = await s.handlers['publish:create']('本文') as string
    await expect(s.handlers['publish:postX'](id)).rejects.toMatchObject({ userFacing: true })
    expect((await s.connections.info()).x.connected).toBe(false)
  })
})

describe('ブログの接続と投稿', () => {
  const wordpress = { kind: 'wordpress', name: '会社のブログ', baseUrl: 'https://blog.example.com/', username: 'editor', secret: 'abcd efgh ijkl mnop' }

  it('形の違う接続先は、確かめに行く前に断る', async () => {
    const s = setup()
    for (const bad of [
      { ...wordpress, kind: 'ghost' },
      { ...wordpress, name: ' ' },
      { ...wordpress, baseUrl: 'http://blog.example.com' },
      { ...wordpress, baseUrl: 'https://user:pw@blog.example.com' },
      { ...wordpress, baseUrl: 'https://blog.example.com/?a=1' },
      { ...wordpress, secret: '' },
      { ...wordpress, secret: '秘密' },
      { ...wordpress, username: '' },
      { ...wordpress, username: 'a:b' },
      { kind: 'emdash', name: 'e', baseUrl: 'https://cms.example.com', secret: 't', collection: 'Posts!' }
    ]) await expect(s.handlers['publish:addBlog'](bad as never)).rejects.toMatchObject({ userFacing: true })
    expect(s.net.calls).toEqual([])
  })

  it('WordPress：アプリケーションパスワードで確かめてから足す。画面へ秘密を返さない', async () => {
    const s = setup()
    const info = await s.handlers['publish:addBlog'](wordpress as never) as PublishConnectionsInfo
    expect(info.blogs).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/), kind: 'wordpress', name: '会社のブログ', baseUrl: 'https://blog.example.com', username: 'editor' }])
    expect(JSON.stringify(info)).not.toContain('abcd')
    expect(s.net.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('editor:abcd efgh ijkl mnop').toString('base64')}`)
  })

  it('確かめで断られたら足さない', async () => {
    const net = fakeNet([(c) => c.url.includes('/users/me') ? json({ code: 'rest_not_logged_in', message: 'You are not currently logged in.' }, 401) : undefined])
    const s = setup({}, net)
    await expect(s.handlers['publish:addBlog'](wordpress as never)).rejects.toMatchObject({ userFacing: true })
    expect((await s.connections.info()).blogs).toEqual([])
  })

  it('記事をアップロードした画像付きで投稿し、記録を残す', async () => {
    const s = setup()
    const info = await s.handlers['publish:addBlog'](wordpress as never) as PublishConnectionsInfo
    const id = await s.handlers['publish:create']('Xの本文') as string
    await s.handlers['publish:update'](id, { articleTitle: '新機能', articleBody: '## はじめに\n\n本文です。' })
    await s.handlers['publish:addProjectMedia'](id, ['shots/a.png'])
    s.net.calls.length = 0
    expect(await s.handlers['publish:postBlog'](id, info.blogs[0]!.id, false)).toEqual({ draft: false, url: 'https://blog.example.com/?p=9' })
    expect(s.net.calls.map((c) => c.url)).toEqual(['https://blog.example.com/wp-json/wp/v2/media', 'https://blog.example.com/wp-json/wp/v2/posts'])
    const post = JSON.parse(s.net.calls[1]!.body)
    expect(post).toMatchObject({ title: '新機能', status: 'publish', featured_media: 55 })
    expect(post.content).toContain('<h2>はじめに</h2>')
    const draft = (await s.store.get('p1', id))!
    expect(draft.results).toEqual([expect.objectContaining({ kind: 'wordpress', targetName: '会社のブログ', url: 'https://blog.example.com/?p=9' })])
  })

  it('記事が空なら X の本文と題で投稿する。下書きなら管理画面の URL を返す', async () => {
    const s = setup()
    const info = await s.handlers['publish:addBlog'](wordpress as never) as PublishConnectionsInfo
    const id = await s.handlers['publish:create']('Xの本文だけ') as string
    s.net.calls.length = 0
    expect(await s.handlers['publish:postBlog'](id, info.blogs[0]!.id, true)).toEqual({ draft: true, url: 'https://blog.example.com/wp-admin/post.php?post=9&action=edit' })
    expect(JSON.parse(s.net.calls[0]!.body)).toMatchObject({ title: 'Xの本文だけ', status: 'draft', content: '<p>Xの本文だけ</p>' })
  })

  it('登録の無いブログ・外したブログには投稿できない', async () => {
    const s = setup()
    const info = await s.handlers['publish:addBlog'](wordpress as never) as PublishConnectionsInfo
    const id = await s.handlers['publish:create']('本文') as string
    await expect(s.handlers['publish:postBlog'](id, 'f'.repeat(16), false)).rejects.toMatchObject({ userFacing: true })
    await s.handlers['publish:removeBlog'](info.blogs[0]!.id)
    await expect(s.handlers['publish:postBlog'](id, info.blogs[0]!.id, false)).rejects.toMatchObject({ userFacing: true })
  })
})
