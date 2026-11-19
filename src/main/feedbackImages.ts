import { lstat, open, realpath } from 'node:fs/promises'
import { extname, sep } from 'node:path'
import { CLOUD_LIMITS, type CloudImageType } from '@shared/feedbackCloud'
import { MAX_FEEDBACK_IMAGES, type FeedbackEntry, type FeedbackImage, type FeedbackImageBox } from '@shared/feedbackSkill'

/**
 * 指摘に付ける画像（どの状態に何の指摘か）を確かめる。Electron に依存させない（単体テストで一時フォルダを使う）。
 * - 読むのは決めたフォルダ（プロジェクトの .ferret/、録画のレビューのフォルダ）の中の普通のファイルだけ。リンク・外へ出るパスは捨てる
 * - 大きさは CLOUD_LIMITS.imageBytes まで。形式は png・jpg・jpeg・webp・svg
 * - 割合の囲み（ビジュアルレビュー・価値ユースケース）は、画像の頭を読んで大きさを出し、ピクセルの囲みに直す
 */

const EXT_TYPE: Record<string, CloudImageType> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.svg': 'svg' }
/** 大きさを読むために頭から読む量 */
const HEADER_BYTES = 64 * 1024
/** 大きさが読めない画像の囲みに使う仮の大きさ */
const FALLBACK_SIZE = 1000

export function imageType(path: string): CloudImageType | null {
  return EXT_TYPE[extname(path).toLowerCase()] ?? null
}

/** root の中か（root そのものは含めない） */
function inside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep
  return path.startsWith(base)
}

/**
 * root の中の普通の画像ファイルなら、たどった実際のパスと大きさを返す。そうでなければ null。
 * root はたどって比べる（macOS の /var → /private/var など）
 */
export async function checkLocalImage(path: string, root: string): Promise<{ real: string; size: number; type: CloudImageType } | null> {
  const type = imageType(path)
  if (!type) return null
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile() || st.size === 0 || st.size > CLOUD_LIMITS.imageBytes) return null
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
    if (!inside(realRoot, real)) return null
    return { real, size: st.size, type }
  } catch {
    return null // 無い・読めない画像は付けない（想定内）
  }
}

/** 画像の幅と高さ（PNG・JPEG・WebP・SVG の頭から）。読めなければ null */
export function imageSize(bytes: Uint8Array, type: CloudImageType): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 100_000 && h <= 100_000 ? { width: w, height: h } : null)
  if (type === 'png') {
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null
    return ok(b.readUInt32BE(16), b.readUInt32BE(20))
  }
  if (type === 'jpeg') {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = b.readUInt16BE(i + 2)
      // SOF0〜SOF15（DHT・JPG・DAC を除く）に大きさがある
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5))
      i += 2 + len
    }
    return null
  }
  if (type === 'webp') {
    if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null
    const chunk = b.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const v = b.readUInt32LE(21)
      return ok((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
    return null
  }
  // SVG: <svg> の width・height（px か単位なし）、無ければ viewBox
  const text = b.toString('utf8')
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (!tag) return null
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(tag)?.[1]
  const w = Number(attr('width'))
  const h = Number(attr('height'))
  if (w > 0 && h > 0) return ok(Math.round(w), Math.round(h))
  const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag)
  return vb ? ok(Math.round(Number(vb[1])), Math.round(Number(vb[2]))) : null
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 割合の囲みを、画像の大きさのピクセルの囲みにする */
export function toPixelBox(frac: { x: number; y: number; w: number; h: number }, size: { width: number; height: number }): FeedbackImageBox {
  const w = Math.max(1, Math.round(frac.w * size.width))
  const h = Math.max(1, Math.round(frac.h * size.height))
  return { x: Math.round(frac.x * size.width), y: Math.round(frac.y * size.height), w, h, width: size.width, height: size.height }
}

/**
 * 指摘の画像を確かめ直す（root の中の普通の画像だけ残す）。割合の囲みはピクセルの囲みにする。
 * root はプロジェクトの .ferret/、録画のレビューはそのレビューのフォルダ
 */
export async function resolveEntryImages(images: readonly FeedbackImage[] | undefined, root: string): Promise<FeedbackImage[]> {
  const out: FeedbackImage[] = []
  for (const img of images ?? []) {
    if (out.length >= MAX_FEEDBACK_IMAGES) break
    const checked = await checkLocalImage(img.path, root)
    if (!checked) continue
    if (!img.frac) { out.push({ path: img.path }); continue }
    let size: { width: number; height: number } | null = null
    try { size = imageSize(await readHeader(checked.real), checked.type) } catch { size = null } // 読めなければ仮の大きさ（想定内）
    out.push({ path: img.path, box: toPixelBox(img.frac, size ?? { width: FALLBACK_SIZE, height: FALLBACK_SIZE }) })
  }
  return out
}

/** 指摘の一覧の画像を確かめる（rootOf が返すフォルダの中だけ）。画像が残らなければ images を消す */
export async function resolveImages(entries: FeedbackEntry[], rootOf: (entry: FeedbackEntry) => string | null): Promise<FeedbackEntry[]> {
  for (const e of entries) {
    if (!e.images?.length) continue
    const root = rootOf(e)
    const images = root ? await resolveEntryImages(e.images, root) : []
    if (images.length) e.images = images
    else delete e.images
  }
  return entries
}
