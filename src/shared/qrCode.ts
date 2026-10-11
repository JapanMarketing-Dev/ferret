/**
 * 小さな QR コードの生成（スマホから操作の URL を設定の画面に出すため。src/main/mobileRemote.ts）。
 *
 * 依存を増やさないよう自前で持つ。使うのはバイトモード・誤り訂正 M・型番 1〜10 だけ
 * （URL は 100 文字ほどなので型番 5 前後で足りる。型番 10 の M で 213 バイトまで入る）。
 * 手順は ISO/IEC 18004 のとおり（データ → Reed-Solomon の誤り訂正 → ブロックの交互の並べ → 配置 → マスク 8 種から減点の少ないもの）。
 * 外部のコードは写していない。
 */

/** 誤り訂正 M の、型番ごとの1ブロックの誤り訂正の語数（添字 = 型番。0 は使わない） */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const
/** 誤り訂正 M の、型番ごとのブロック数 */
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const

export const QR_MAX_VERSION = 10

/** 型番の1辺のモジュール数 */
export function qrSize(version: number): number {
  return version * 4 + 17
}

/** 型番に入るデータと誤り訂正の語数の合計（関数パターン・形式情報・型番情報を除いた数 / 8） */
export function rawCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    bits -= (25 * align - 10) * align - 55
    if (version >= 7) bits -= 36
  }
  return Math.floor(bits / 8)
}

/** 型番に入るデータの語数（誤り訂正 M） */
export function dataCodewords(version: number): number {
  return rawCodewords(version) - ECC_PER_BLOCK_M[version]! * BLOCKS_M[version]!
}

/** バイト列が入る最小の型番。入らなければ null */
export function chooseVersion(byteLength: number): number | null {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16
    if (4 + countBits + byteLength * 8 <= dataCodewords(v) * 8) return v
  }
  return null
}

/** GF(2^8)（既約多項式 0x11D）の掛け算 */
function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 次数 degree の Reed-Solomon の生成多項式（最高次の係数 1 は省く） */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** data を生成多項式で割った余り（誤り訂正の語） */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => { result[i]! ^= gfMul(coef, factor) })
  }
  return result
}

/** バイトモードのデータの語（モード・文字数・本文・終端・埋め草） */
export function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const capacity = dataCodewords(version) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) out.push(pad)
  return out
}

/** データの語を各ブロックに分けて誤り訂正を足し、交互に並べ直す */
export function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = BLOCKS_M[version]!
  const eccLen = ECC_PER_BLOCK_M[version]!
  const raw = rawCodewords(version)
  const numShort = numBlocks - (raw % numBlocks)
  const shortLen = Math.floor(raw / numBlocks)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    // 短いブロックは長さをそろえるために 1 語の空きを入れておき、並べ直すときに飛ばす
    if (i < numShort) dat.push(0)
    blocks.push([...dat, ...ecc])
  }
  const out: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]!) })
  }
  return out
}

/** 位置合わせパターンの中心の座標（行・列とも同じ並び） */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = qrSize(version) - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0

/** マスクの条件（true のモジュールを反転する） */
function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** 形式情報の 15 ビット（誤り訂正 M = 0b00 とマスクの番号、BCH 符号、0x5412 との排他的論理和） */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 型番情報の 18 ビット（型番 7 以上） */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]
  constructor(readonly version: number) {
    this.size = qrSize(version)
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  /** x は列、y は行 */
  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }

  drawFunctionPatterns(): void {
    const size = this.size
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)
    const align = alignmentPositions(this.version)
    const last = align.length - 1
    align.forEach((ax, i) => align.forEach((ay, j) => {
      // 3 つの角（位置検出パターンと重なる所）には置かない
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      this.drawAlignment(ax, ay)
    }))
    // 形式情報の場所を先に関数パターンとして押さえる（値はマスクを決めてから書く）
    this.drawFormat(0)
    this.drawVersion()
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunction(x, y, dist !== 2 && dist !== 4)
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask)
    const size = this.size
    // 左上の写し
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i))
    this.setFunction(8, 7, bit(bits, 6))
    this.setFunction(8, 8, bit(bits, 7))
    this.setFunction(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i))
    // 右上と左下の写し
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(bits, i))
    // いつも黒のモジュール
    this.setFunction(8, size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return
    const bits = versionBits(this.version)
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, bit(bits, i))
      this.setFunction(b, a, bit(bits, i))
    }
  }

  /** 右下から 2 列ずつ、上下にジグザグに置く（6 列目は縦のタイミングパターンなので飛ばす） */
  drawCodewords(data: readonly number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (this.isFunction[y]![x] || i >= data.length * 8) continue
          this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7))
          i++
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && maskHit(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x]
      }
    }
  }
}

/** 読み取りにくさの減点（同じ色の連なり・2x2 の塊・位置検出に似た並び・白黒の偏り） */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let score = 0
  const at = (x: number, y: number, vertical: boolean) => (vertical ? modules[x]![y]! : modules[y]![x]!)
  for (const vertical of [false, true]) {
    for (let y = 0; y < size; y++) {
      let run = 1
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, vertical) === at(x - 1, y, vertical)) { run++; continue }
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
      // 1:1:3:1:1 の並びの前後に白が 4 つ
      for (let x = 0; x + 11 <= size; x++) {
        const s = Array.from({ length: 11 }, (_, k) => at(x + k, y, vertical))
        const core = s[0] && !s[1] && s[2] && s[3] && s[4] && !s[5] && s[6]
        const a = core && !s[7] && !s[8] && !s[9] && !s[10]
        const b = s[4] && !s[5] && s[6] && s[7] && s[8] && !s[9] && s[10] && !s[0] && !s[1] && !s[2] && !s[3]
        if (a || b) score += 40
      }
    }
  }
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]![x]) dark++
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y]![x]
        if (modules[y]![x + 1] === c && modules[y + 1]![x] === c && modules[y + 1]![x + 1] === c) score += 3
      }
    }
  }
  const total = size * size
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
  return score
}

export interface QrCode {
  version: number
  size: number
  mask: number
  /** modules[y][x]。true が黒 */
  modules: boolean[][]
}

/**
 * 文字列（UTF-8 のバイト）の QR コード。入らないほど長ければ例外。
 * mask を渡せばそのマスクで作る（単体テスト用）。省けば減点が最も少ないもの
 */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text)
  const version = chooseVersion(bytes.length)
  if (version === null) throw new RangeError(`QR: text too long (${bytes.length} bytes)`)
  if (opts.mask !== undefined && !(Number.isInteger(opts.mask) && opts.mask >= 0 && opts.mask <= 7)) throw new RangeError('QR: mask must be 0-7')
  const codewords = addEccAndInterleave(encodeData(bytes, version), version)
  const grid = new Grid(version)
  grid.drawFunctionPatterns()
  grid.drawCodewords(codewords)
  let mask = opts.mask ?? -1
  if (mask < 0) {
    let best = Infinity
    for (let m = 0; m < 8; m++) {
      grid.applyMask(m)
      grid.drawFormat(m)
      const score = penalty(grid.modules)
      if (score < best) { best = score; mask = m }
      grid.applyMask(m)
    }
  }
  grid.applyMask(mask)
  grid.drawFormat(mask)
  return { version, size: grid.size, mask, modules: grid.modules }
}

/** QR の黒いモジュールを SVG の path の d に（周りに quiet 個分の余白。viewBox は 0 0 size+2*quiet size+2*quiet） */
export function qrSvgPath(qr: Pick<QrCode, 'modules'>, quiet = 4): string {
  const parts: string[] = []
  qr.modules.forEach((row, y) => {
    // 横に続く黒は 1 本の長方形にまとめる（path を短くする）
    for (let x = 0; x < row.length;) {
      if (!row[x]) { x++; continue }
      let end = x
      while (end < row.length && row[end]) end++
      parts.push(`M${x + quiet} ${y + quiet}h${end - x}v1h-${end - x}z`)
      x = end
    }
  })
  return parts.join('')
}
