/**
 * Ferret アカウントで送る・読む指摘の画像（どの状態に何の指摘か）。Electron に依存させない（単体テストで偽の client と一時フォルダを使う）。
 *
 * - 上げる: 手元の画像の SHA-256 を出し（mtime と大きさが同じなら前の値）、Worker に無いものだけを PUT する。
 *   1回の同期で上げるのは MAX_UPLOAD_IMAGES 枚・MAX_UPLOAD_BYTES まで、同時に UPLOAD_CONCURRENCY 本。失敗した画像は指摘から外し、同期は失敗にしない
 * - 読む: ほかの PC・チームの指摘の画像を userData/feedback-cloud/images/<hash>.<拡張子> に控える（中身の hash を確かめる）。
 *   控えは MAX_CACHE_BYTES までで、超えたら古いものから消す
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLOUD_LIMITS, IMAGE_HASH_PATTERN, type CloudEntry, type CloudImage, type CloudImageType } from '@shared/feedbackCloud'
import { imageType } from '../feedbackImages'
import type { CloudClient } from './client'

export const MAX_UPLOAD_IMAGES = 200
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024
export const UPLOAD_CONCURRENCY = 3
export const MAX_DOWNLOAD_IMAGES = 200
export const MAX_CACHE_BYTES = 500 * 1024 * 1024

const EXT: Record<CloudImageType, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg' }

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>()

/** 手元の画像の hash と形式（mtime と大きさが同じなら前の値）。リンク・大きすぎる・形式が違うものは null */
export async function hashLocalImage(path: string): Promise<{ hash: string; type: CloudImageType; size: number } | null> {
  const type = imageType(path)
  if (!type) return null
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > CLOUD_LIMITS.imageBytes) return null
    const hit = hashCache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { hash: hit.hash, type, size: st.size }
    const hash = sha256(await readFile(path))
    hashCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, hash })
    return { hash, type, size: st.size }
  } catch {
    return null // 消えた・読めない（想定内）
  }
}

/** 同時に limit 本まで走らせる */
async function pool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!)
  }))
}

/**
 * 指摘の画像を Worker に上げる（無いものだけ）。上げられなかった画像の hash を返す（指摘から外す）。投げない
 * @param pathOf hash → 手元の画像のパス
 */
export async function uploadImages(client: CloudClient, token: string, entries: readonly CloudEntry[], pathOf: ReadonlyMap<string, string>): Promise<Set<string>> {
  const all = [...new Set(entries.flatMap((e) => (e.images ?? []).map((i) => i.hash)))]
  const types = new Map(entries.flatMap((e) => (e.images ?? []).map((i) => [i.hash, i.type] as const)))
  const failed = new Set<string>()
  if (!all.length) return failed
  const missing: string[] = []
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200)
    try {
      missing.push(...await client.missingImages(token, chunk))
    } catch {
      // 聞けなかった分は上がっているか分からないので外す（次の同期でまた試す）
      for (const h of chunk) failed.add(h)
    }
  }
  let count = 0
  let bytes = 0
  const todo: Array<{ hash: string; path: string; type: CloudImageType }> = []
  for (const hash of missing) {
    const path = pathOf.get(hash)
    const type = types.get(hash)
    const size = path ? hashCache.get(path)?.size ?? 0 : 0
    if (!path || !type || count >= MAX_UPLOAD_IMAGES || bytes + size > MAX_UPLOAD_BYTES) { failed.add(hash); continue }
    count++
    bytes += size
    todo.push({ hash, path, type })
  }
  await pool(todo, UPLOAD_CONCURRENCY, async ({ hash, path, type }) => {
    try {
      const data = await readFile(path)
      // 読んだあとに変わった画像は上げない（hash が合わない）
      if (data.byteLength > CLOUD_LIMITS.imageBytes || sha256(data) !== hash) throw new Error('changed')
      await client.putImage(token, hash, type, data)
    } catch {
      failed.add(hash) // 上げられなかった画像はこの同期では付けない（想定内）
    }
  })
  return failed
}

/** 上げられなかった画像を指摘から外す */
export function dropImages(entries: readonly CloudEntry[], failed: ReadonlySet<string>): CloudEntry[] {
  if (!failed.size) return [...entries]
  return entries.map((e) => {
    if (!e.images?.some((i) => failed.has(i.hash))) return e
    const images = e.images.filter((i) => !failed.has(i.hash))
    const { images: _drop, ...rest } = e
    return images.length ? { ...rest, images } : rest
  })
}

/** ほかの PC・チームの画像の控え（userData/feedback-cloud/images/） */
export class ImageCache {
  constructor(readonly dir: string, private readonly maxBytes = MAX_CACHE_BYTES) {}

  pathFor(img: Pick<CloudImage, 'hash' | 'type'>): string {
    return join(this.dir, `${img.hash}.${EXT[img.type]}`)
  }

  /** 控えてあればそのパス、無ければ null */
  cached(img: Pick<CloudImage, 'hash' | 'type'>): string | null {
    if (!IMAGE_HASH_PATTERN.test(img.hash)) return null
    const path = this.pathFor(img)
    return existsSync(path) ? path : null
  }

  private async ready(): Promise<boolean> {
    try {
      if ((await lstat(this.dir)).isSymbolicLink()) return false
    } catch {
      // まだ無い（想定内）
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    return !(await lstat(this.dir)).isSymbolicLink()
  }

  /**
   * 控えていない画像を Worker から読んで置く（中身の hash が合うものだけ）。最大 limit 枚。置いた数を返す。投げない
   */
  async fetchMissing(client: CloudClient, token: string, images: readonly CloudImage[], limit = MAX_DOWNLOAD_IMAGES): Promise<number> {
    const seen = new Set<string>()
    const todo: CloudImage[] = []
    const now = new Date()
    for (const img of images) {
      if (seen.has(img.hash) || !IMAGE_HASH_PATTERN.test(img.hash)) continue
      seen.add(img.hash)
      const hit = this.cached(img)
      if (hit) { await utimes(hit, now, now).catch(() => undefined); continue } // 使った控えは新しくする（古いものから消すため）
      if (todo.length < limit) todo.push(img)
    }
    if (!todo.length) return 0
    if (!(await this.ready().catch(() => false))) return 0
    let stored = 0
    await pool(todo, UPLOAD_CONCURRENCY, async (img) => {
      try {
        const { bytes } = await client.getImage(token, img.hash)
        if (sha256(bytes) !== img.hash) return // 中身が違う画像は置かない
        await writeFile(this.pathFor(img), bytes, { mode: 0o600 })
        stored++
      } catch {
        // 読めない画像（消された・チームを抜けた・つながらない）は付けない（想定内）
      }
    })
    await this.evict().catch(() => undefined)
    return stored
  }

  /** 控えが上限を超えていれば、古い（mtime の）ものから消す */
  async evict(): Promise<void> {
    const files = await Promise.all((await readdir(this.dir)).map(async (name) => {
      const path = join(this.dir, name)
      const st = await stat(path).catch(() => null)
      return st?.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs } : null
    }))
    const list = files.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = list.reduce((n, f) => n + f.size, 0)
    for (const f of list) {
      if (total <= this.maxBytes) break
      await rm(f.path, { force: true })
      total -= f.size
    }
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }
}
