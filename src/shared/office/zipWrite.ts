/**
 * Office の文書の ZIP を書き直す（純粋な関数。依存を足さない）。
 *
 * 編集した部品（シートの XML・本文の XML など）だけを新しい中身に差し替え、ほかの部品は圧縮したままのバイトを
 * そのまま写す（展開・再圧縮しないので、画像・マクロ・埋め込みなどは1バイトも変えない）。
 * 圧縮は CompressionStream('deflate-raw')（Chromium・Node 22 にある）。
 * 並び・名前・日時は元のまま。データ記述子（フラグの bit 3）は使わず、大きさと CRC はヘッダーに書く。
 */
import { OfficeFormatError, rawEntryData, readZipDirectory, type ZipArchive } from './zip'

/** 部品の名前 → 新しい中身。null はその部品を消す */
export type ZipChanges = ReadonlyMap<string, Uint8Array | string | null>

let crcTable: Uint32Array | null = null

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

/** DOS の日時（いまの時刻） */
function dosNow(): { time: number; date: number } {
  const d = new Date()
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

interface OutEntry {
  rawName: Uint8Array
  flags: number
  method: number
  modTime: number
  modDate: number
  crc32: number
  compressedSize: number
  size: number
  data: Uint8Array
}

const UTF8_FLAG = 0x0800
/** 32bit に収まらない大きさ（ZIP64）は書かない */
const MAX_ZIP_BYTES = 0xfffffff0

/**
 * 元の ZIP（data）に changes を当てた新しい ZIP。changes に元に無い名前があれば末尾に足す。
 * 元の ZIP が読めない（壊れている・ZIP64・暗号化した部品を書き換えようとした）ときは OfficeFormatError
 */
export async function rewriteZip(data: Uint8Array, changes: ZipChanges): Promise<Uint8Array> {
  const entries = readZipDirectory(data)
  const out: OutEntry[] = []
  const seen = new Set<string>()
  const encoder = new TextEncoder()
  const now = dosNow()
  const fresh = async (rawName: Uint8Array, value: Uint8Array | string, base?: { modTime: number; modDate: number; flags: number }): Promise<OutEntry> => {
    const bytes = toBytes(value)
    const compressed = await deflateRaw(bytes)
    // 小さすぎて縮まないものは無圧縮で入れる
    const stored = compressed.length >= bytes.length
    return {
      rawName,
      // 暗号化・データ記述子の印は落とし、UTF-8 の名前の印は残す
      flags: (base?.flags ?? UTF8_FLAG) & UTF8_FLAG,
      method: stored ? 0 : 8,
      modTime: base?.modTime ?? now.time,
      modDate: base?.modDate ?? now.date,
      crc32: crc32(bytes),
      compressedSize: stored ? bytes.length : compressed.length,
      size: bytes.length,
      data: stored ? bytes : compressed
    }
  }
  for (const entry of entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    if (changes.has(entry.name)) {
      const value = changes.get(entry.name)
      if (value === null || value === undefined) continue
      out.push(await fresh(entry.rawName, value, entry))
      continue
    }
    out.push({
      rawName: entry.rawName,
      flags: entry.flags & ~0x0008,
      method: entry.method,
      modTime: entry.modTime,
      modDate: entry.modDate,
      crc32: entry.crc32,
      compressedSize: entry.compressedSize,
      size: entry.size,
      data: rawEntryData(data, entry)
    })
  }
  for (const [name, value] of changes) {
    if (seen.has(name) || value === null) continue
    out.push(await fresh(encoder.encode(name), value))
  }
  return assembleZip(out)
}

function assembleZip(entries: OutEntry[]): Uint8Array {
  let localTotal = 0
  let centralTotal = 0
  for (const e of entries) {
    localTotal += 30 + e.rawName.length + e.data.length
    centralTotal += 46 + e.rawName.length
  }
  const total = localTotal + centralTotal + 22
  if (total > MAX_ZIP_BYTES || entries.length >= 0xffff) throw new OfficeFormatError('zip too large to write')
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let at = 0
  const offsets: number[] = []
  for (const e of entries) {
    offsets.push(at)
    view.setUint32(at, 0x04034b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, e.flags, true)
    view.setUint16(at + 8, e.method, true)
    view.setUint16(at + 10, e.modTime, true)
    view.setUint16(at + 12, e.modDate, true)
    view.setUint32(at + 14, e.crc32, true)
    view.setUint32(at + 18, e.compressedSize, true)
    view.setUint32(at + 22, e.size, true)
    view.setUint16(at + 26, e.rawName.length, true)
    view.setUint16(at + 28, 0, true)
    out.set(e.rawName, at + 30)
    out.set(e.data, at + 30 + e.rawName.length)
    at += 30 + e.rawName.length + e.data.length
  }
  const cdStart = at
  entries.forEach((e, index) => {
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 20, true)
    view.setUint16(at + 8, e.flags, true)
    view.setUint16(at + 10, e.method, true)
    view.setUint16(at + 12, e.modTime, true)
    view.setUint16(at + 14, e.modDate, true)
    view.setUint32(at + 16, e.crc32, true)
    view.setUint32(at + 20, e.compressedSize, true)
    view.setUint32(at + 24, e.size, true)
    view.setUint16(at + 28, e.rawName.length, true)
    view.setUint32(at + 42, offsets[index]!, true)
    out.set(e.rawName, at + 46)
    at += 46 + e.rawName.length
  })
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, entries.length, true)
  view.setUint16(at + 10, entries.length, true)
  view.setUint32(at + 12, at - cdStart, true)
  view.setUint32(at + 16, cdStart, true)
  return out
}

/** 一部の部品を差し替えて見せる ZipArchive（保存の前のプレビュー用。ZIP は作り直さない） */
export function overlayZip(base: ZipArchive, overrides: ReadonlyMap<string, string>): ZipArchive {
  const bytes = async (name: string) => (overrides.has(name) ? new TextEncoder().encode(overrides.get(name)!) : base.bytes(name))
  return {
    names: () => base.names(),
    has: (name) => overrides.has(name) || base.has(name),
    bytes,
    text: async (name) => (overrides.has(name) ? overrides.get(name)! : base.text(name))
  }
}
