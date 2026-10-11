import { describe, expect, it, vi } from 'vitest'
import {
  BLOG_MEDIA_BYTES, emImageValue, matchMedia, pickEmDashFields, planArticle, postToBlog, testBlog, type BlogMedia
} from '../../src/main/publish/blogApi'
import type { StoredBlog } from '../../src/main/publish/connections'

/** ブログへの投稿（src/main/publish/blogApi.ts）。サイトは偽物（呼ばれた URL・本文を残す） */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function site(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? '' : typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array).toString('latin1')
    const call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body }
    calls.push(call)
    const key = Object.keys(routes).find((k) => url === k || (k.endsWith('*') && url.startsWith(k.slice(0, -1))))
    return key ? routes[key]!(call) : json({ message: 'nope' }, 404)
  })
  return { fetcher, calls }
}

const media = (name: string, extra: Partial<BlogMedia> = {}): BlogMedia => ({ path: `/abs/${name}`, kind: 'image', name, bytes: 3, ...extra })
const readFile = async (path: string) => Buffer.from(`bytes-of-${path}`)

const emdash: StoredBlog = { id: 'e'.repeat(16), kind: 'emdash', name: 'CMS', baseUrl: 'https://cms.example', secret: 'EMDASH-TOKEN', collection: 'posts' }
const wordpress: StoredBlog = { id: 'a'.repeat(16), kind: 'wordpress', name: 'WP', baseUrl: 'https://wp.example/blog', username: 'me', secret: 'pass word' }

const SCHEMA = { success: true, data: { item: { slug: 'posts', fields: [
  { slug: 'title', type: 'string' }, { slug: 'featured_image', type: 'image' }, { slug: 'content', type: 'portableText' }, { slug: 'excerpt', type: 'text' }
] } } }

describe('matchMedia と planArticle', () => {
  const list = [media('a.png', { ref: 'shots/a.png' }), media('b c.png', { ref: 'shots/b c.png' }), media('v.mp4', { kind: 'video' })]

  it('相対パス → ファイル名の順に探す（./ と URL エンコードも読む）', () => {
    expect(matchMedia('shots/a.png', list)?.name).toBe('a.png')
    expect(matchMedia('./shots/a.png', list)?.name).toBe('a.png')
    expect(matchMedia('shots/b%20c.png', list)?.name).toBe('b c.png')
    expect(matchMedia('v.mp4', list)?.name).toBe('v.mp4')
    expect(matchMedia('other.png', list)).toBeNull()
    expect(matchMedia('%E0%A4%A', list)).toBeNull()
  })

  it('本文で指したものはそこに、指していないものは末尾に。最初の画像はアイキャッチ（末尾には足さない）', () => {
    const plan = planArticle('前\n\n![b](shots/b c.png)\n\n後', list)
    expect(plan.featured?.name).toBe('a.png')
    expect(plan.blocks.map((b) => b.t === 'image' ? b.src : b.t)).toEqual(['paragraph', 'shots/b c.png', 'paragraph', 'v.mp4'])
    expect(plan.used.map((m) => m.name)).toEqual(['a.png', 'b c.png', 'v.mp4'])
  })

  it('アイキャッチの置き場が無ければ最初の画像も本文に入れる', () => {
    const plan = planArticle('本文', list, false)
    expect(plan.featured).toBeNull()
    expect(plan.blocks.filter((b) => b.t === 'image')).toHaveLength(3)
  })

  it('メディアが無ければそのまま', () => {
    expect(planArticle('本文', [])).toEqual({ blocks: [{ t: 'paragraph', inlines: [{ t: 'text', text: '本文' }] }], used: [], featured: null })
  })
})

describe('pickEmDashFields', () => {
  it('題・本文・画像・抜粋のフィールドを選ぶ（名前の合うものを先に）', () => {
    expect(pickEmDashFields(SCHEMA)).toEqual({ title: 'title', body: 'content', image: 'featured_image', excerpt: 'excerpt' })
  })

  it('名前が違っても型で選ぶ。答えの形が違っても fields を探す', () => {
    const fields = [{ slug: 'headline', type: 'string' }, { slug: 'article', type: 'portableText' }, { slug: 'summary', type: 'string' }]
    expect(pickEmDashFields({ data: { collection: { fields } } })).toEqual({ title: 'headline', body: 'article', excerpt: 'summary' })
    expect(pickEmDashFields({ data: { fields } })).toMatchObject({ title: 'headline' })
    expect(pickEmDashFields({ fields })).toMatchObject({ body: 'article' })
  })

  it('題か本文が無ければ null', () => {
    expect(pickEmDashFields({ data: { item: { fields: [{ slug: 'title', type: 'string' }] } } })).toBeNull()
    expect(pickEmDashFields({ data: { item: { fields: 'x' } } })).toBeNull()
    expect(pickEmDashFields({})).toBeNull()
  })
})

describe('emImageValue', () => {
  it('local は storageKey を meta に、external は src、ほかは previewUrl', () => {
    expect(emImageValue({ id: 'M', url: '/f/k.png', provider: 'local', storageKey: 'k.png', width: 1, height: 2, meta: { blurhash: 'x' } }, ''))
      .toEqual({ id: 'M', provider: 'local', alt: '', width: 1, height: 2, meta: { blurhash: 'x', storageKey: 'k.png' } })
    expect(emImageValue({ id: 'M', url: 'https://e/x.png', provider: 'external' }, 'a')).toEqual({ id: 'M', provider: 'external', alt: 'a', src: 'https://e/x.png' })
    expect(emImageValue({ id: 'M', url: 'https://cf/x', provider: 'cloudflare-images' }, '')).toEqual({ id: 'M', provider: 'cloudflare-images', alt: '', previewUrl: 'https://cf/x' })
  })
})

describe('EmDash へ投稿', () => {
  function emdashSite(over: Record<string, (call: Call) => Response> = {}) {
    let n = 0
    return site({
      'https://cms.example/_emdash/api/schema/collections/posts?includeFields=true': () => json(SCHEMA),
      'https://cms.example/_emdash/api/media': () => json({ success: true, data: { item: { id: `M${++n}`, url: `/_emdash/api/media/file/k${n}.png`, storageKey: `k${n}.png`, provider: 'local', width: 640, height: 480, mimeType: 'image/png', filename: 'a.png' } } }, 201),
      'https://cms.example/_emdash/api/content/posts': () => json({ success: true, data: { item: { id: 'C1', slug: 'x' }, _rev: 'r' } }, 201),
      'https://cms.example/_emdash/api/content/posts/C1/publish': () => json({ success: true, data: {} }),
      ...over
    })
  }

  it('コレクションを読み、メディアを上げ、Portable Text の記事を作って公開する', async () => {
    const s = emdashSite()
    const result = await postToBlog({ fetcher: s.fetcher, readFile }, emdash, {
      title: '新機能', markdown: '最初の段落です。\n\n![図](shots/b.png)\n\n## 次', media: [media('a.png'), media('b.png', { ref: 'shots/b.png' })], draft: false
    })
    expect(result).toEqual({ draft: false, url: 'https://cms.example/_emdash/admin/content/posts/C1' })
    expect(s.calls.map((c) => `${c.method} ${c.url.replace('https://cms.example/_emdash/api', '')}`)).toEqual([
      'GET /schema/collections/posts?includeFields=true', 'POST /media', 'POST /media', 'POST /content/posts', 'POST /content/posts/C1/publish'
    ])
    expect(s.calls.every((c) => c.headers.Authorization === 'Bearer EMDASH-TOKEN')).toBe(true)
    expect(s.calls[1]!.body).toContain('filename="a.png"')
    expect(s.calls[1]!.body).toContain('bytes-of-/abs/a.png')

    const { data } = JSON.parse(s.calls[3]!.body)
    expect(data.title).toBe('新機能')
    expect(data.excerpt).toBe('最初の段落です。')
    expect(data.featured_image).toMatchObject({ id: 'M1', provider: 'local', meta: { storageKey: 'k1.png' } })
    expect(data.content.map((b: { _type: string; style?: string }) => b.style ?? b._type)).toEqual(['normal', 'image', 'h2'])
    expect(data.content[1]).toMatchObject({ _type: 'image', asset: { _ref: 'M2', url: '/_emdash/api/media/file/k2.png' }, alt: '図', width: 640 })
  })

  it('下書きなら公開しない', async () => {
    const s = emdashSite()
    expect(await postToBlog({ fetcher: s.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [], draft: true })).toMatchObject({ draft: true })
    expect(s.calls.some((c) => c.url.endsWith('/publish'))).toBe(false)
  })

  it('image のフィールドが無ければ、最初の画像も本文に入れる', async () => {
    const s = emdashSite({ 'https://cms.example/_emdash/api/schema/collections/posts?includeFields=true': () => json({ data: { item: { fields: [{ slug: 'title', type: 'string' }, { slug: 'content', type: 'portableText' }] } } }) })
    await postToBlog({ fetcher: s.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [media('a.png')], draft: true })
    const { data } = JSON.parse(s.calls.find((c) => c.url.endsWith('/content/posts'))!.body)
    expect(data.featured_image).toBeUndefined()
    expect(data.content.at(-1)).toMatchObject({ _type: 'image', asset: { _ref: 'M1' } })
  })

  it('動画は絶対 URL のリンクにする', async () => {
    const s = emdashSite()
    await postToBlog({ fetcher: s.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [media('v.mp4', { kind: 'video' })], draft: true })
    const { data } = JSON.parse(s.calls.find((c) => c.url.endsWith('/content/posts'))!.body)
    expect(data.content[1].markDefs[0].href).toBe('https://cms.example/_emdash/api/media/file/k1.png')
  })

  it('コレクションが無い・フィールドが合わない・公開だけ失敗、をそれぞれ伝える', async () => {
    const missing = emdashSite({ 'https://cms.example/_emdash/api/schema/collections/posts?includeFields=true': () => json({}, 404) })
    await expect(postToBlog({ fetcher: missing.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [], draft: false })).rejects.toThrow(/posts/)
    const fields = emdashSite({ 'https://cms.example/_emdash/api/schema/collections/posts?includeFields=true': () => json({ data: { item: { fields: [] } } }) })
    await expect(postToBlog({ fetcher: fields.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [], draft: false })).rejects.toMatchObject({ userFacing: true })
    const publish = emdashSite({ 'https://cms.example/_emdash/api/content/posts/C1/publish': () => json({ success: false, error: { code: 'FORBIDDEN', message: 'Missing scope' } }, 403) })
    await expect(postToBlog({ fetcher: publish.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [], draft: false })).rejects.toThrow(/Missing scope/)
  })

  it('作った記事の id が無ければ断る（公開しない）', async () => {
    const s = emdashSite({ 'https://cms.example/_emdash/api/content/posts': () => json({ success: true, data: {} }, 201) })
    await expect(postToBlog({ fetcher: s.fetcher, readFile }, emdash, { title: 't', markdown: 'b', media: [], draft: false })).rejects.toMatchObject({ userFacing: true })
    expect(s.calls.some((c) => c.url.endsWith('/publish'))).toBe(false)
  })

  it('接続の確かめはコレクションの読み取りだけ', async () => {
    const s = emdashSite()
    await testBlog({ fetcher: s.fetcher }, emdash)
    expect(s.calls).toHaveLength(1)
  })
})

describe('WordPress へ投稿', () => {
  it('サイトの下の wp-json に送り、メディアはファイル名を UTF-8 でも伝える', async () => {
    const s = site({
      'https://wp.example/blog/wp-json/wp/v2/media': () => json({ id: 3, source_url: 'https://wp.example/u/画像.png' }, 201),
      'https://wp.example/blog/wp-json/wp/v2/posts': () => json({ id: 4, link: 'https://wp.example/blog/p4' }, 201)
    })
    await postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: 't', markdown: 'b', media: [media('画像 "1".png')], draft: false })
    const upload = s.calls[0]!
    expect(upload.headers['Content-Type']).toBe('image/png')
    expect(upload.headers['Content-Disposition']).toBe(`attachment; filename="__ _1_.png"; filename*=UTF-8''${encodeURIComponent('画像 "1".png')}`)
    expect(upload.headers.Authorization).toBe(`Basic ${Buffer.from('me:pass word').toString('base64')}`)
    expect(JSON.parse(s.calls[1]!.body)).toMatchObject({ featured_media: 3, status: 'publish' })
  })

  it('記事のリンクが http(s) でなければ URL を返さない', async () => {
    const s = site({ 'https://wp.example/blog/wp-json/wp/v2/posts': () => json({ id: 4, link: 'javascript:alert(1)' }, 201) })
    expect(await postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: 't', markdown: 'b', media: [], draft: false })).toEqual({ draft: false })
  })

  it('失敗の理由を伝える（認証・API が無い・大きすぎる・その他・届かない）。秘密は文に出さない', async () => {
    const post = (status: number, body: unknown = { message: '<b>reason</b>' }) => postToBlog({
      fetcher: site({ 'https://wp.example/blog/wp-json/wp/v2/posts': () => json(body, status) }).fetcher, readFile
    }, wordpress, { title: 't', markdown: 'b', media: [], draft: false }).catch((e: Error) => e)
    const messages = await Promise.all([post(401), post(404), post(413), post(500)]).then((errs) => errs.map((e) => (e as Error).message))
    expect(new Set(messages).size).toBe(4)
    expect(messages[3]).toContain('reason')
    expect(messages[3]).not.toContain('<b>')
    for (const m of messages) expect(m).not.toContain('pass word')
    const offline = await postToBlog({ fetcher: async () => { throw new TypeError('fetch failed') }, readFile }, wordpress, { title: 't', markdown: 'b', media: [], draft: false }).catch((e: Error) => e)
    expect(offline).toMatchObject({ userFacing: true })
    await expect(testBlog({ fetcher: async () => { throw new TypeError('fetch failed') } }, wordpress)).rejects.toMatchObject({ userFacing: true })
  })

  it('大きすぎるメディアは送る前に断る（境界: ちょうど上限は通す）', async () => {
    const s = site({ 'https://wp.example/blog/wp-json/wp/v2/media': () => json({ id: 1, source_url: 'https://wp.example/x.mp4' }, 201), 'https://wp.example/blog/wp-json/wp/v2/posts': () => json({ id: 1, link: 'https://wp.example/p' }, 201) })
    await expect(postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: 't', markdown: 'b', media: [media('v.mp4', { kind: 'video', bytes: BLOG_MEDIA_BYTES + 1 })], draft: false })).rejects.toMatchObject({ userFacing: true })
    expect(s.calls).toHaveLength(0)
    await expect(postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: 't', markdown: 'b', media: [media('v.mp4', { kind: 'video', bytes: BLOG_MEDIA_BYTES })], draft: false })).resolves.toBeTruthy()
  })

  it('題か本文が空なら送らない', async () => {
    const s = site({})
    await expect(postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: ' ', markdown: 'b', media: [], draft: false })).rejects.toMatchObject({ userFacing: true })
    await expect(postToBlog({ fetcher: s.fetcher, readFile }, wordpress, { title: 't', markdown: '\n', media: [], draft: false })).rejects.toMatchObject({ userFacing: true })
    expect(s.calls).toHaveLength(0)
  })
})
