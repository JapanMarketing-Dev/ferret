import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublishConnections, readBlogInput, sanitizeConnections } from '../../src/main/publish/connections'
import { NO_CIPHER, type KeyCipher } from '../../src/main/pipeline/stt/keys'
import { PUBLISH_LIMITS, normalizeBlogUrl, validCollection, validXClientId } from '../../src/shared/publish'

/** 発信の接続先の置き場（src/main/publish/connections.ts）。暗号化は中身の見えない偽物（XOR）で確かめる */

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-publish-conn-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const xorCipher: KeyCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text).map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString()
}
const CID = 'Q2xpZW50SWRGb3JUZXN0OjE6Y2k'
const wp = { kind: 'wordpress', name: 'ブログ', baseUrl: 'https://blog.example.com/', username: 'me', secret: 'APP-PASSWORD-SECRET' }

describe('形の確かめ（shared）', () => {
  it('ブログの URL は https（手元だけ http 可）。認証情報・? #・壊れたものは断り、末尾の / を外す', () => {
    expect(normalizeBlogUrl(' https://a.example/blog/ ')).toBe('https://a.example/blog')
    expect(normalizeBlogUrl('https://a.example')).toBe('https://a.example')
    expect(normalizeBlogUrl('http://localhost:4321/')).toBe('http://localhost:4321')
    expect(normalizeBlogUrl('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321')
    for (const bad of ['http://a.example', 'ftp://a.example', 'https://u:p@a.example', 'https://a.example/?x=1', 'https://a.example/#x', 'nope', '', 'javascript:alert(1)']) {
      expect(normalizeBlogUrl(bad)).toBeNull()
    }
  })

  it('Client ID は英数字と - _ だけで8〜200文字', () => {
    expect(validXClientId('a'.repeat(8))).toBe(true)
    expect(validXClientId('a'.repeat(7))).toBe(false)
    expect(validXClientId('a'.repeat(200))).toBe(true)
    expect(validXClientId('a'.repeat(201))).toBe(false)
    expect(validXClientId('abc def gh')).toBe(false)
  })

  it('コレクション名', () => {
    expect(validCollection('posts')).toBe(true)
    expect(validCollection('blog_posts-2')).toBe(true)
    expect(validCollection('Posts')).toBe(false)
    expect(validCollection('1posts')).toBe(false)
    expect(validCollection('a'.repeat(65))).toBe(false)
  })
})

describe('readBlogInput', () => {
  it('WordPress はユーザー名が要る。EmDash はコレクションの既定が posts', () => {
    expect(readBlogInput(wp)).toEqual({ kind: 'wordpress', name: 'ブログ', baseUrl: 'https://blog.example.com', username: 'me', secret: 'APP-PASSWORD-SECRET' })
    expect(readBlogInput({ kind: 'emdash', name: ' E  社 ', baseUrl: 'https://cms.example', secret: 'tok', collection: ' ' }))
      .toEqual({ kind: 'emdash', name: 'E 社', baseUrl: 'https://cms.example', secret: 'tok', collection: 'posts' })
  })

  it('名前・秘密の長さの境界', () => {
    expect(() => readBlogInput({ ...wp, name: 'あ'.repeat(PUBLISH_LIMITS.blogNameChars) })).not.toThrow()
    expect(() => readBlogInput({ ...wp, name: 'あ'.repeat(PUBLISH_LIMITS.blogNameChars + 1) })).toThrow()
    expect(() => readBlogInput({ ...wp, secret: 'a'.repeat(PUBLISH_LIMITS.blogSecretChars) })).not.toThrow()
    expect(() => readBlogInput({ ...wp, secret: 'a'.repeat(PUBLISH_LIMITS.blogSecretChars + 1) })).toThrow()
    expect(() => readBlogInput({ ...wp, secret: 'a\nb' })).toThrow()
    expect(() => readBlogInput(null)).toThrow()
  })
})

describe('sanitizeConnections', () => {
  it('Client ID の無いトークン・トークンの無いユーザー・形の違うブログは捨てる', () => {
    const tokens = { accessToken: 'A', expiresAt: 1 }
    expect(sanitizeConnections({ x: { tokens, user: { id: '1', username: 'u' } } }).x).toEqual({})
    expect(sanitizeConnections({ x: { clientId: CID, user: { id: '1', username: 'u' } } }).x).toEqual({ clientId: CID })
    expect(sanitizeConnections({ x: { clientId: CID, tokens: { accessToken: '', expiresAt: 1 } } }).x).toEqual({ clientId: CID })
    expect(sanitizeConnections({ x: { clientId: CID, tokens, user: { id: '1', username: 'bad name' } } }).x).toEqual({ clientId: CID, tokens })
    const blogs = sanitizeConnections({ blogs: [
      { id: 'a'.repeat(16), ...wp }, { id: 'a'.repeat(16), ...wp }, { id: 'zz', ...wp }, { id: 'b'.repeat(16), ...wp, baseUrl: 'http://x.example' }
    ] }).blogs
    expect(blogs.map((b) => b.id)).toEqual(['a'.repeat(16)])
    expect(sanitizeConnections('junk')).toEqual({ x: {}, blogs: [] })
  })
})

describe('PublishConnections', () => {
  const file = () => join(dir, 'publish-connections.bin')

  it('暗号化して保存し、次に読める。ファイルに秘密が平文で入らない', async () => {
    const a = new PublishConnections(file(), xorCipher)
    await a.setXClientId(CID)
    await a.setXTokens(CID, { accessToken: 'ACCESS-SECRET', refreshToken: 'REFRESH-SECRET', expiresAt: 5 }, { id: '1', username: 'me' })
    await a.addBlog(wp)
    const raw = (await readFile(file())).toString('latin1')
    for (const secret of ['ACCESS-SECRET', 'REFRESH-SECRET', 'APP-PASSWORD-SECRET']) expect(raw).not.toContain(secret)
    const b = new PublishConnections(file(), xorCipher)
    expect((await b.x()).tokens?.accessToken).toBe('ACCESS-SECRET')
    const info = await b.info()
    expect(info).toMatchObject({ x: { clientId: CID, connected: true, username: 'me' }, persisted: true })
    expect(JSON.stringify(info)).not.toMatch(/SECRET/)
  })

  it('暗号化できなければファイルに書かず、起動中だけ覚える', async () => {
    const c = new PublishConnections(file(), NO_CIPHER)
    await c.setXClientId(CID)
    await c.addBlog(wp)
    expect(existsSync(file())).toBe(false)
    expect((await c.info()).blogs).toHaveLength(1)
    expect((await c.info()).persisted).toBe(false)
  })

  it('全部消したらファイルも消す。壊れたファイルは空として読む', async () => {
    const c = new PublishConnections(file(), xorCipher)
    await c.setXClientId(CID)
    expect(existsSync(file())).toBe(true)
    await c.setXClientId(null)
    expect(existsSync(file())).toBe(false)
    await writeFile(file(), 'not encrypted json')
    expect((await new PublishConnections(file(), xorCipher).info()).x.clientId).toBeNull()
  })

  it('Client ID を変えるとトークンを捨て、違う Client ID のトークンは置かない', async () => {
    const c = new PublishConnections(file(), NO_CIPHER)
    await c.setXClientId(CID)
    expect(await c.setXTokens(CID, { accessToken: 'A', expiresAt: 1 }, { id: '1', username: 'me' })).toBe(true)
    await c.setXClientId(CID)
    expect((await c.x()).tokens).toBeTruthy()
    await c.setXClientId('AnotherClientId')
    expect((await c.x()).tokens).toBeUndefined()
    expect(await c.setXTokens(CID, { accessToken: 'B', expiresAt: 1 })).toBe(false)
    await expect(c.setXClientId('bad id')).rejects.toMatchObject({ userFacing: true })
  })

  it('トークンを更新しても前の @ユーザー名を残す。切断で Client ID は残る', async () => {
    const c = new PublishConnections(file(), NO_CIPHER)
    await c.setXClientId(CID)
    await c.setXTokens(CID, { accessToken: 'A', expiresAt: 1 }, { id: '1', username: 'me' })
    await c.setXTokens(CID, { accessToken: 'B', expiresAt: 2 })
    expect((await c.x()).user?.username).toBe('me')
    await c.clearXTokens()
    expect(await c.x()).toEqual({ clientId: CID })
  })

  it('ブログは上限まで。外すと投稿に使えない', async () => {
    const c = new PublishConnections(file(), NO_CIPHER)
    const ids: string[] = []
    for (let i = 0; i < PUBLISH_LIMITS.blogTargets; i++) ids.push((await c.addBlog({ ...wp, name: `b${i}` })).id)
    await expect(c.addBlog(wp)).rejects.toMatchObject({ userFacing: true })
    expect(new Set(ids).size).toBe(ids.length)
    expect((await c.blog(ids[0]!)).secret).toBe('APP-PASSWORD-SECRET')
    await c.removeBlog(ids[0]!)
    await expect(c.blog(ids[0]!)).rejects.toMatchObject({ userFacing: true })
    await c.removeBlog('nope')
  })

  it('同時の変更は1つずつ（取りこぼさない）', async () => {
    const c = new PublishConnections(file(), xorCipher)
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.addBlog({ ...wp, name: `b${i}` })))
    expect((await new PublishConnections(file(), xorCipher).info()).blogs).toHaveLength(8)
  })
})
