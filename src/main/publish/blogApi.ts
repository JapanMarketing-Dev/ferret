/**
 * ブログへ記事を投稿する。接続先は WordPress（REST API・アプリケーションパスワード）と EmDash（REST API・API トークン）。
 *
 * - 記事の本文は Markdown（markdown.ts）。WordPress へは HTML、EmDash へは Portable Text にして送る
 * - 付けた画像・動画は先にメディアとして上げ、本文の ![説明](相対パスかファイル名) の位置に置く。本文で指していないものは末尾に足す。
 *   最初の画像はアイキャッチ（WordPress の featured_media・EmDash の image のフィールド）にもする（それを本文で指していなければ末尾には足さない）
 * - EmDash のフィールドの名前はサイトごとに違うので、コレクションの定義を読んで、題（string）・本文（portableText）・画像（image）・
 *   抜粋（text）のフィールドを探す
 * - 秘密（パスワード・トークン）はその接続先の URL にだけ送る（connections.ts が URL と一緒に持つ）。値はエラーに出さない
 *
 * Electron に依存させない（fetch とファイルの読み方を渡す）。
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { UserFacingError } from '@shared/errors'
import type { PostBlogResult, PostMediaKind } from '@shared/publish'
import { parseMarkdown, plainExcerpt, toHtml, toPortableText, type Block, type HtmlMedia, type PortableMedia } from './markdown'
import type { StoredBlog } from './connections'
import { multipartBody, mimeOf, type Fetcher } from './xApi'
import { publishText } from './store'

export interface BlogMedia {
  path: string
  kind: PostMediaKind
  name: string
  bytes: number
  ref?: string
}

export interface BlogPostInput {
  title: string
  markdown: string
  media: readonly BlogMedia[]
  draft: boolean
}

export interface BlogDeps {
  fetcher: Fetcher
  readFile?: (path: string) => Promise<Buffer>
}

/** ブログへ上げる1ファイルの上限（ファイルを丸ごと読むので抑える） */
export const BLOG_MEDIA_BYTES = 200 * 1024 * 1024
const DETAIL_CHARS = 200

/** HTML のタグを外す（外した後に新しくできるタグも残さないよう、変わらなくなるまで） */
function stripTags(text: string): string {
  let previous: string
  do {
    previous = text
    text = text.replace(/<[^<>]*>/g, ' ')
  } while (text !== previous)
  return text
}

async function detailOf(res: Response): Promise<string> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    // 本文が読めない（想定内）
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const error = json.error as Record<string, unknown> | undefined
    const message = [json.message, error?.message, json.code, error?.code].find((v): v is string => typeof v === 'string' && v.length > 0)
    if (message) return stripTags(message).replace(/\s+/g, ' ').trim().slice(0, DETAIL_CHARS)
  } catch {
    // JSON でない（想定内）
  }
  return stripTags(text).replace(/\s+/g, ' ').trim().slice(0, DETAIL_CHARS)
}

export async function blogFailure(res: Response, name: string): Promise<UserFacingError> {
  const detail = await detailOf(res)
  if (res.status === 401 || res.status === 403) return new UserFacingError(publishText('publish.errors.blogUnauthorized', { name }))
  if (res.status === 404) return new UserFacingError(publishText('publish.errors.blogApiMissing', { name, detail: detail || '404' }))
  if (res.status === 413) return new UserFacingError(publishText('publish.errors.blogTooLarge', { name }))
  return new UserFacingError(publishText('publish.errors.blogFailed', { name, detail: detail || `HTTP ${res.status}` }))
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const value = await res.json() as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 本文の画像の場所が、付けたメディアのどれを指すか */
export function matchMedia(src: string, media: readonly BlogMedia[]): BlogMedia | null {
  const s = src.trim().replace(/^\.\//, '')
  let decoded = s
  try {
    decoded = decodeURIComponent(s)
  } catch {
    // そのまま使う（想定内）
  }
  return media.find((m) => m.ref === s || m.ref === decoded) ?? media.find((m) => m.name === s || m.name === decoded) ?? null
}

/**
 * 記事の組み立て: 本文で指していないメディアを末尾に足し、使うメディアとアイキャッチを決める。
 * アイキャッチの置き場が無い（featuredSlot が false）ときは、最初の画像も本文に入れる
 */
export function planArticle(markdown: string, media: readonly BlogMedia[], featuredSlot = true): { blocks: Block[]; used: BlogMedia[]; featured: BlogMedia | null } {
  const blocks = parseMarkdown(markdown)
  const referenced = new Set<BlogMedia>()
  for (const b of blocks) {
    if (b.t !== 'image') continue
    const m = matchMedia(b.src, media)
    if (m) referenced.add(m)
  }
  const featured = featuredSlot ? media.find((m) => m.kind === 'image') ?? null : null
  for (const m of media) {
    if (referenced.has(m) || m === featured) continue
    blocks.push({ t: 'image', alt: '', src: m.ref ?? m.name })
    referenced.add(m)
  }
  const used = media.filter((m) => referenced.has(m) || m === featured)
  return { blocks, used, featured }
}

function checkSize(m: BlogMedia): void {
  if (m.bytes > BLOG_MEDIA_BYTES) throw new UserFacingError(publishText('publish.errors.blogMediaTooLarge', { name: m.name, max: Math.round(BLOG_MEDIA_BYTES / 1024 / 1024) }))
}

// ---- WordPress ----

function wpAuth(blog: StoredBlog): string {
  return `Basic ${Buffer.from(`${blog.username ?? ''}:${blog.secret.replace(/\s+/g, ' ')}`).toString('base64')}`
}

function wpApi(blog: StoredBlog, path: string): string {
  return `${blog.baseUrl}/wp-json/wp/v2${path}`
}

async function wpTest(deps: BlogDeps, blog: StoredBlog): Promise<void> {
  const res = await deps.fetcher(wpApi(blog, '/users/me?context=edit'), { headers: { Authorization: wpAuth(blog) } })
  if (!res.ok) throw await blogFailure(res, blog.name)
}

async function wpUpload(deps: BlogDeps, blog: StoredBlog, m: BlogMedia): Promise<HtmlMedia & { id: number }> {
  checkSize(m)
  const data = await (deps.readFile ?? fsReadFile)(m.path)
  const ascii = m.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const res = await deps.fetcher(wpApi(blog, '/media'), {
    method: 'POST',
    headers: {
      Authorization: wpAuth(blog),
      'Content-Type': mimeOf(m.path),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(m.name)}`
    },
    body: new Uint8Array(data)
  })
  if (!res.ok) throw await blogFailure(res, blog.name)
  const body = await json(res)
  const id = typeof body.id === 'number' ? body.id : NaN
  const url = typeof body.source_url === 'string' ? body.source_url : ''
  if (!Number.isInteger(id) || !url) throw new UserFacingError(publishText('publish.errors.blogFailed', { name: blog.name, detail: 'media' }))
  return { id, url, kind: m.kind }
}

async function wpPost(deps: BlogDeps, blog: StoredBlog, input: BlogPostInput): Promise<PostBlogResult> {
  const { blocks, used, featured } = planArticle(input.markdown, input.media)
  const uploaded = new Map<BlogMedia, HtmlMedia & { id: number }>()
  for (const m of used) uploaded.set(m, await wpUpload(deps, blog, m))
  const html = toHtml(blocks, (src) => {
    const m = matchMedia(src, used)
    return m ? uploaded.get(m) ?? null : null
  })
  const featuredId = featured ? uploaded.get(featured)?.id : undefined
  const res = await deps.fetcher(wpApi(blog, '/posts'), {
    method: 'POST',
    headers: { Authorization: wpAuth(blog), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: input.title, content: html, status: input.draft ? 'draft' : 'publish', ...(featuredId !== undefined ? { featured_media: featuredId } : {}) })
  })
  if (!res.ok) throw await blogFailure(res, blog.name)
  const body = await json(res)
  const link = typeof body.link === 'string' && /^https?:\/\//.test(body.link) ? body.link : undefined
  const id = typeof body.id === 'number' ? body.id : undefined
  // 下書きは公開の URL では開けないので、管理画面の編集の URL にする
  const url = input.draft && id !== undefined ? `${blog.baseUrl}/wp-admin/post.php?post=${id}&action=edit` : link
  return { draft: input.draft, ...(url ? { url } : {}) }
}

// ---- EmDash ----

export interface EmDashFields {
  title: string
  body: string
  image?: string
  excerpt?: string
}

function emApi(blog: StoredBlog, path: string): string {
  return `${blog.baseUrl}/_emdash/api${path}`
}

function emAuth(blog: StoredBlog, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${blog.secret}`, ...extra }
}

/** コレクションの定義（GET /schema/collections/{slug}?includeFields=true）から、使うフィールドを選ぶ。合うものが無ければ null */
export function pickEmDashFields(response: Record<string, unknown>): EmDashFields | null {
  const data = (response.data ?? response) as Record<string, unknown>
  const holder = [data.item, data.collection, data].find((v) => v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).fields)) as Record<string, unknown> | undefined
  const fields = (holder?.fields as unknown[] | undefined ?? []).flatMap((f) => {
    const r = (f ?? {}) as Record<string, unknown>
    return typeof r.slug === 'string' && typeof r.type === 'string' ? [{ slug: r.slug, type: r.type }] : []
  })
  const find = (types: string[], preferred: string[]) =>
    preferred.map((p) => fields.find((f) => f.slug === p && types.includes(f.type))).find(Boolean) ?? fields.find((f) => types.includes(f.type))
  const title = find(['string'], ['title', 'name'])
  const body = find(['portableText'], ['content', 'body'])
  if (!title || !body) return null
  const image = find(['image'], ['featured_image', 'featuredImage', 'cover', 'image'])
  const excerpt = fields.find((f) => (f.slug === 'excerpt' || f.slug === 'summary' || f.slug === 'description') && (f.type === 'text' || f.type === 'string'))
  return { title: title.slug, body: body.slug, ...(image ? { image: image.slug } : {}), ...(excerpt ? { excerpt: excerpt.slug } : {}) }
}

async function emFields(deps: BlogDeps, blog: StoredBlog): Promise<EmDashFields> {
  const collection = blog.collection ?? 'posts'
  const res = await deps.fetcher(emApi(blog, `/schema/collections/${encodeURIComponent(collection)}?includeFields=true`), { headers: emAuth(blog) })
  if (res.status === 404) throw new UserFacingError(publishText('publish.errors.emdashCollection', { name: blog.name, collection }))
  if (!res.ok) throw await blogFailure(res, blog.name)
  const fields = pickEmDashFields(await json(res))
  if (!fields) throw new UserFacingError(publishText('publish.errors.emdashFields', { name: blog.name, collection }))
  return fields
}

interface EmDashMediaItem {
  id: string
  url: string
  provider: string
  width?: number
  height?: number
  mimeType?: string
  filename?: string
  storageKey?: string
  meta?: Record<string, unknown>
}

async function emUpload(deps: BlogDeps, blog: StoredBlog, m: BlogMedia): Promise<EmDashMediaItem> {
  checkSize(m)
  const data = await (deps.readFile ?? fsReadFile)(m.path)
  const boundary = `----ferret${randomBytes(12).toString('hex')}`
  const body = multipartBody({}, { name: 'file', filename: m.name, type: mimeOf(m.path), data }, boundary)
  const res = await deps.fetcher(emApi(blog, '/media'), {
    method: 'POST',
    headers: emAuth(blog, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
    body: new Uint8Array(body)
  })
  if (!res.ok) throw await blogFailure(res, blog.name)
  const item = ((await json(res)).data as Record<string, unknown> | undefined)?.item as Record<string, unknown> | undefined
  const id = typeof item?.id === 'string' ? item.id : ''
  const url = typeof item?.url === 'string' ? item.url : ''
  if (!item || !id || !url) throw new UserFacingError(publishText('publish.errors.blogFailed', { name: blog.name, detail: 'media' }))
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    id, url, provider: str(item.provider) ?? 'local',
    ...(num(item.width) ? { width: num(item.width) } : {}), ...(num(item.height) ? { height: num(item.height) } : {}),
    ...(str(item.mimeType) ? { mimeType: str(item.mimeType) } : {}), ...(str(item.filename) ? { filename: str(item.filename) } : {}),
    ...(str(item.storageKey) ? { storageKey: str(item.storageKey) } : {}),
    ...(item.meta && typeof item.meta === 'object' ? { meta: item.meta as Record<string, unknown> } : {})
  }
}

/** image のフィールドに入れる値（EmDash の管理画面が選んだときと同じ形） */
export function emImageValue(item: EmDashMediaItem, alt: string): Record<string, unknown> {
  const local = item.provider === 'local'
  return {
    id: item.id, provider: item.provider, alt,
    ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}),
    ...(item.filename ? { filename: item.filename } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(local ? { meta: { ...(item.meta ?? {}), ...(item.storageKey ? { storageKey: item.storageKey } : {}) } } : item.provider === 'external' ? { src: item.url } : { previewUrl: item.url })
  }
}

async function emPost(deps: BlogDeps, blog: StoredBlog, input: BlogPostInput): Promise<PostBlogResult> {
  const collection = blog.collection ?? 'posts'
  const fields = await emFields(deps, blog)
  const { blocks, used, featured } = planArticle(input.markdown, input.media, Boolean(fields.image))
  const uploaded = new Map<BlogMedia, EmDashMediaItem>()
  for (const m of used) uploaded.set(m, await emUpload(deps, blog, m))
  const absolute = (url: string) => new URL(url, `${blog.baseUrl}/`).toString()
  const content = toPortableText(blocks, (src) => {
    const m = matchMedia(src, used)
    const item = m ? uploaded.get(m) : undefined
    if (!m || !item) return null
    const media: PortableMedia = { kind: m.kind, id: item.id, url: m.kind === 'video' ? absolute(item.url) : item.url, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) }
    return media
  })
  const featuredItem = featured ? uploaded.get(featured) : undefined
  const excerpt = plainExcerpt(blocks)
  const data: Record<string, unknown> = {
    [fields.title]: input.title,
    [fields.body]: content,
    ...(fields.excerpt && excerpt ? { [fields.excerpt]: excerpt } : {}),
    ...(fields.image && featuredItem ? { [fields.image]: emImageValue(featuredItem, '') } : {})
  }
  const res = await deps.fetcher(emApi(blog, `/content/${encodeURIComponent(collection)}`), {
    method: 'POST',
    headers: emAuth(blog, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data })
  })
  if (!res.ok) throw await blogFailure(res, blog.name)
  const created = (await json(res)).data as Record<string, unknown> | undefined
  const item = (created?.item ?? created) as Record<string, unknown> | undefined
  const id = typeof item?.id === 'string' ? item.id : ''
  if (!id) throw new UserFacingError(publishText('publish.errors.blogFailed', { name: blog.name, detail: 'content' }))
  const url = `${blog.baseUrl}/_emdash/admin/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`
  if (!input.draft) {
    const published = await deps.fetcher(emApi(blog, `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`), { method: 'POST', headers: emAuth(blog) })
    // 記事は下書きとして残っているので、公開だけ失敗したと伝える
    if (!published.ok) throw new UserFacingError(publishText('publish.errors.emdashPublish', { name: blog.name, detail: await detailOf(published) || String(published.status) }))
  }
  return { draft: input.draft, url }
}

/** 接続を確かめる（登録の前に呼ぶ） */
export async function testBlog(deps: BlogDeps, blog: StoredBlog): Promise<void> {
  try {
    if (blog.kind === 'wordpress') await wpTest(deps, blog)
    else await emFields(deps, blog)
  } catch (err) {
    if (err instanceof UserFacingError) throw err
    throw new UserFacingError(publishText('publish.errors.blogUnreachable', { name: blog.name }), { cause: err })
  }
}

export async function postToBlog(deps: BlogDeps, blog: StoredBlog, input: BlogPostInput): Promise<PostBlogResult> {
  if (!input.title.trim() || !input.markdown.trim()) throw new UserFacingError(publishText('publish.errors.articleEmpty'))
  try {
    return blog.kind === 'wordpress' ? await wpPost(deps, blog, input) : await emPost(deps, blog, input)
  } catch (err) {
    if (err instanceof UserFacingError) throw err
    throw new UserFacingError(publishText('publish.errors.blogUnreachable', { name: blog.name }), { cause: err })
  }
}
