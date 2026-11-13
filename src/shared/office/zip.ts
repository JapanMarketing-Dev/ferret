/**
 * Office の文書（.docx・.xlsx・.pptx）の中身の ZIP を読む（純粋な関数。依存を足さない）。
 *
 * 中央ディレクトリから名前と位置を読み、使う部品だけをその都度展開する。
 * 展開は DecompressionStream('deflate-raw')（Chromium・Node 22 にある）。
 * 壊れた ZIP・暗号化・ZIP64 は OfficeFormatError にする（画面は「表示できない」と出して、外のアプリで開かせる）。
 */

export class OfficeFormatError extends Error {}

/** 1つの部品を展開した大きさの上限（巨大な XML で renderer を固めない） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 部品の数の上限 */
const MAX_ENTRIES = 20_000

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
  encrypted: boolean
  /** 書き直し（zipWrite.ts）でそのまま写す値 */
  flags: number
  crc32: number
  modTime: number
  modDate: number
  /** 中央ディレクトリに書いてあるままの名前のバイト（先頭の / も含む） */
  rawName: Uint8Array
}

export interface ZipArchive {
  /** 部品の名前（`/` 区切り、先頭の `/` なし） */
  names(): string[]
  has(name: string): boolean
  bytes(name: string): Promise<Uint8Array | null>
  text(name: string): Promise<string | null>
}

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}
function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

function findEndOfCentralDirectory(b: Uint8Array): number {
  // 末尾の注釈は最長 65535 バイト
  const stop = Math.max(0, b.length - 22 - 0xffff)
  for (let i = b.length - 22; i >= stop; i -= 1) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i
  }
  throw new OfficeFormatError('not a zip archive')
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel()
      throw new OfficeFormatError('zip entry too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(expected === total ? expected : total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** 中央ディレクトリを並びのまま読む（読み取りと書き直しで共有する） */
export function readZipDirectory(data: Uint8Array): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data)
  const count = u16(data, eocd + 10)
  const cdOffset = u32(data, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new OfficeFormatError('zip64 is not supported')
  if (count > MAX_ENTRIES) throw new OfficeFormatError('too many zip entries')
  const list: ZipEntry[] = []
  const decoder = new TextDecoder()
  let at = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > data.length || u32(data, at) !== 0x02014b50) throw new OfficeFormatError('broken central directory')
    const flags = u16(data, at + 8)
    const method = u16(data, at + 10)
    const compressedSize = u32(data, at + 20)
    const size = u32(data, at + 24)
    const nameLength = u16(data, at + 28)
    const extraLength = u16(data, at + 30)
    const commentLength = u16(data, at + 32)
    const localOffset = u32(data, at + 42)
    const rawName = data.subarray(at + 46, at + 46 + nameLength)
    const name = decoder.decode(rawName).replace(/^\/+/, '')
    list.push({
      name, method, compressedSize, size, localOffset, encrypted: (flags & 1) === 1,
      flags, crc32: u32(data, at + 16), modTime: u16(data, at + 12), modDate: u16(data, at + 14), rawName
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return list
}

/** 部品の中身の圧縮したままのバイト（ローカルヘッダーの後ろ） */
export function rawEntryData(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const local = entry.localOffset
  if (local + 30 > data.length || u32(data, local) !== 0x04034b50) throw new OfficeFormatError('broken local header')
  const start = local + 30 + u16(data, local + 26) + u16(data, local + 28)
  const end = start + entry.compressedSize
  if (end > data.length) throw new OfficeFormatError('truncated zip entry')
  return data.subarray(start, end)
}

export function openZip(data: Uint8Array): ZipArchive {
  const entries = new Map<string, ZipEntry>()
  for (const entry of readZipDirectory(data)) entries.set(entry.name, entry)

  const bytes = async (name: string): Promise<Uint8Array | null> => {
    const entry = entries.get(name)
    if (!entry) return null
    if (entry.encrypted) throw new OfficeFormatError('encrypted zip entry')
    if (entry.size > MAX_ENTRY_BYTES) throw new OfficeFormatError('zip entry too large')
    const raw = rawEntryData(data, entry)
    if (entry.method === 0) return raw
    if (entry.method === 8) return inflateRaw(raw, entry.size)
    throw new OfficeFormatError(`unsupported zip method ${entry.method}`)
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    bytes,
    text: async (name) => {
      const b = await bytes(name)
      return b ? new TextDecoder().decode(b) : null
    }
  }
}

/** rels の Target（相対）を、部品の名前に直す。base は rels を持つ部品（例: word/document.xml） */
export function resolvePartPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/** 部品の rels（_rels/<名前>.rels）の名前 */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}
