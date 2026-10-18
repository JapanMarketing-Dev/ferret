/**
 * 取り込みの CSV（純粋。node・Electron に依存しない）。
 *
 * バイト列 → 文字列（BOM を見て UTF-8 / UTF-16LE / UTF-16BE。BOM が無ければ UTF-8、だめなら Shift_JIS（Excel で保存した日本語の CSV））、
 * 区切りの自動判定（, タブ ;）、RFC 4180 の引用符（"" のエスケープ・引用符の中の改行）、CRLF / LF / CR。
 * 行は元のファイルの1始まりの行番号（引用符の中の改行で2行にまたがる行は、始まりの行）を持つ。
 */

export type CsvDelimiter = ',' | '\t' | ';'

export const CSV_DELIMITERS: readonly CsvDelimiter[] = ['\t', ',', ';']

/** 1行（cells は引用符を外した値。空行は ['']） */
export interface CsvRow {
  /** 元のファイルの1始まりの行番号 */
  line: number
  cells: string[]
}

export interface CsvTable {
  delimiter: CsvDelimiter
  rows: CsvRow[]
}

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'shift_jis'

/** 復号できなければ null（取り込みの問題 encoding） */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: TextEncodingName } | null {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return decodeAs(b.subarray(3), 'utf-8')
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return decodeAs(b.subarray(2), 'utf-16le')
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return decodeAs(b.subarray(2), 'utf-16be')
  // BOM の無い UTF-16（ASCII の多い表なら、片側のバイトが 0 に偏る）
  const guess = guessUtf16(b)
  if (guess) {
    const r = decodeAs(b, guess)
    if (r) return r
  }
  return decodeAs(b, 'utf-8') ?? decodeAs(b, 'shift_jis')
}

function decodeAs(bytes: Uint8Array, encoding: TextEncodingName): { text: string; encoding: TextEncodingName } | null {
  if ((encoding === 'utf-16le' || encoding === 'utf-16be') && bytes.length % 2 !== 0) return null
  try {
    // ignoreBOM: BOM は上で外した。残っていれば文字として残し、見出しの正規化で外す
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes)
    return { text, encoding }
  } catch {
    return null
  }
}

function guessUtf16(b: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(b.length - (b.length % 2), 512)
  if (n < 4) return null
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) evenZero++
    if (b[i + 1] === 0) oddZero++
  }
  const pairs = n / 2
  if (oddZero > pairs * 0.4 && evenZero === 0) return 'utf-16le'
  if (evenZero > pairs * 0.4 && oddZero === 0) return 'utf-16be'
  return null
}

/**
 * 区切りの判定。先頭の 30 行（引用符の中は数えない）で、候補ごとに「同じ数（1以上）だけ現れる行」の数が一番多いもの。
 * 同じならその数が多いもの、それでも同じならタブ → カンマ → セミコロンの順。どれも無ければカンマ（1列の表）。
 * タブ区切りの中の "1,234" のように、カンマは行ごとに数が揺れるので選ばれにくい。
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number[]>(CSV_DELIMITERS.map((d) => [d, []]))
  let current = new Map<CsvDelimiter, number>(CSV_DELIMITERS.map((d) => [d, 0]))
  let inQuotes = false
  let lines = 0
  let lineHasContent = false
  const endLine = (): void => {
    if (lineHasContent) {
      for (const d of CSV_DELIMITERS) counts.get(d)!.push(current.get(d)!)
      lines++
    }
    current = new Map<CsvDelimiter, number>(CSV_DELIMITERS.map((d) => [d, 0]))
    lineHasContent = false
  }
  for (let i = 0; i < text.length && lines < 30; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      lineHasContent = true
      continue
    }
    if (inQuotes) continue
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endLine()
      continue
    }
    if (ch !== ' ') lineHasContent = true
    if (ch === ',' || ch === '\t' || ch === ';') current.set(ch, current.get(ch)! + 1)
  }
  if (lines < 30) endLine()
  let best: { d: CsvDelimiter; lines: number; count: number } | null = null
  for (const d of CSV_DELIMITERS) {
    const freq = new Map<number, number>()
    for (const c of counts.get(d)!) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1)
    for (const [count, n] of freq) {
      if (!best || n > best.lines || (n === best.lines && count > best.count)) best = { d, lines: n, count }
    }
  }
  return best?.d ?? ','
}

/**
 * RFC 4180 の読み取り（ゆるめ）。区切りを渡さなければ detectDelimiter で決める。
 * 引用符は値の先頭にあるときだけ特別（値の途中の " は文字のまま）。閉じた引用符のあとの文字は値に足す。閉じない引用符はファイルの終わりまで。
 * 末尾の改行のあとに空の行は作らない。先頭の U+FEFF は外す。
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): CsvTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const d = delimiter ?? detectDelimiter(src)
  const rows: CsvRow[] = []
  let cells: string[] = []
  let cell = ''
  let line = 1
  let rowLine = 1
  let inQuotes = false
  let atFieldStart = true
  const endCell = (): void => {
    cells.push(cell)
    cell = ''
    atFieldStart = true
  }
  const endRow = (): void => {
    endCell()
    rows.push({ line: rowLine, cells })
    cells = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') {
          cell += '\r\n'
          i++
        } else cell += ch
        line++
      } else cell += ch
      continue
    }
    if (ch === '"' && atFieldStart) {
      inQuotes = true
      atFieldStart = false
      continue
    }
    if (ch === d) {
      endCell()
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
      continue
    }
    cell += ch
    atFieldStart = false
  }
  // 末尾に改行が無い最後の行（改行で終わっていれば、ここには何も残っていない）
  if (cell !== '' || cells.length > 0 || inQuotes || !atFieldStart) endRow()
  return { delimiter: d, rows }
}

/** 空行（すべての値が空白だけ） */
export function isBlankRow(row: CsvRow): boolean {
  return row.cells.every((c) => c.trim() === '')
}
